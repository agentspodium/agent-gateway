// Builds a fresh MCP server (stateless: one per HTTP request) wired to the
// account API through the caller's own bearer token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "./account-client.js";
import { fetchDocsText } from "./docs-cache.js";
import type { GatewayContext } from "./tools.js";
import {
  agentSummarySchema,
  createInstanceInputSchema,
  createInstanceOutputSchema,
  deleteInstanceOutputSchema,
  emptyInputSchema,
  idInputSchema,
  instanceHealthOutputSchema,
  instanceTermOutputSchema,
  listInstancesOutputSchema,
  listPlatformsOutputSchema,
  paymentOptionsOutputSchema,
  setLlmKeyInputSchema,
  setPeersInputSchema,
  createInstance,
  deleteInstance,
  instanceHealth,
  instanceTerm,
  listInstances,
  listPlatforms,
  pauseInstance,
  paymentOptions,
  rebuildInstance,
  resumeInstance,
  setLlmKey,
  setPeers,
} from "./tools.js";

/** Wraps a shared implementation function into an MCP tool callback, turning
    account-API errors into `isError` results instead of thrown exceptions.
    On success, `structuredContent` mirrors the tool's declared `outputSchema`
    (the SDK validates it against that schema) alongside the human-readable text. */
function toolHandler(
  fn: (ctx: GatewayContext, input: unknown) => Promise<unknown>,
  ctx: GatewayContext,
): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const result = await fn(ctx, input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: err.code, message: err.message }, null, 2),
            },
          ],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "GATEWAY_ERROR", message }, null, 2) }],
      };
    }
  };
}

export function buildMcpServer(ctx: GatewayContext): McpServer {
  const server = new McpServer(
    {
      name: "agentspodium-hosting",
      version: "1.0.2",
      title: "AgentsPodium Hosting",
      websiteUrl: "https://hosting.defispace.com/docs/mcp.html",
      icons: [{ src: "https://hosting.defispace.com/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
    },
    {
      instructions: [
        "AgentsPodium Hosting turns an AgentsPodium account into deployable AI agent pods (instances): pick an engine and hosting tier, deploy one, wire in the customer's own LLM key, and manage its lifecycle and billing.",
        "Every tool that touches an account requires an AgentsPodium API key (ak_live_...), created at https://agentspodium.com/account, except list_platforms which reads the public engine/tier catalogue.",
        "Recommended order: list_platforms to choose an engine and tier, then create_instance, then poll instance_health until serving is true, then set_llm_key so the pod can actually answer, then instance_term to check the billing clock.",
        "Full docs, including every tool's request/response shape: https://hosting.defispace.com/llms.txt.",
      ].join(" "),
    },
  );

  /* One prompt, so clients that list prompts get an answer instead of
     "method not found", and so a person can start from a checklist. */
  server.registerPrompt(
    "deploy-checklist",
    {
      description: "Step-by-step checklist to deploy an AI agent pod on AgentsPodium and make it answer.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Deploy a pod on AgentsPodium with the tools of this server, in this order:",
              "1. list_platforms — pick an engine and a plan (check minTier).",
              "2. create_instance — tier is required; keep the returned a2aToken if enableA2A.",
              "3. instance_health — poll every 5 s until serving is true (boot takes ~10 s after running).",
              "4. set_llm_key — install the customer's own model key (provider + key + model id the provider publishes); the pod answers nothing without it.",
              "5. instance_term — note stopsAt/deletesAt; the first 7 days are free, then pay via payment_options.",
              "Docs: https://hosting.defispace.com/llms.txt",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "list_platforms",
    {
      title: "List platforms and plans",
      description:
        "List available AgentsPodium engines (platforms) and hosting plans (tiers), with prices and capabilities.",
      inputSchema: emptyInputSchema,
      outputSchema: listPlatformsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    toolHandler(listPlatforms, ctx),
  );

  server.registerTool(
    "list_instances",
    {
      title: "List instances",
      description:
        "List the caller's AgentsPodium instances (agents): id, name, engine, tier, status, endpoint and A2A URL, domain, creation date. Never returns secrets.",
      inputSchema: emptyInputSchema,
      outputSchema: listInstancesOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    toolHandler(listInstances, ctx),
  );

  server.registerTool(
    "create_instance",
    {
      title: "Create instance",
      description:
        "Create (deploy) a new AgentsPodium instance. Returns the instance id and, when enableA2A is true, the a2aUrl and a2aToken the caller should keep. " +
        "After creating, poll instance_health until it is serving, then call set_llm_key to give it a working LLM key.",
      inputSchema: createInstanceInputSchema,
      outputSchema: createInstanceOutputSchema,
      annotations: { openWorldHint: true },
    },
    toolHandler(createInstance, ctx),
  );

  server.registerTool(
    "instance_health",
    {
      title: "Check instance health",
      description: "Check whether an instance is reachable and serving, plus its status and quota state.",
      inputSchema: idInputSchema,
      outputSchema: instanceHealthOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    toolHandler(instanceHealth, ctx),
  );

  server.registerTool(
    "instance_term",
    {
      title: "Get billing term",
      description: "Get the billing term (trial/paid/grace) for an instance, including when it renews or expires.",
      inputSchema: idInputSchema,
      outputSchema: instanceTermOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    toolHandler(instanceTerm, ctx),
  );

  server.registerTool(
    "set_llm_key",
    {
      title: "Set LLM key",
      description:
        "Set (or clear, with key=null) the LLM provider API key an instance uses to answer. Required before a freshly created instance can actually respond.",
      inputSchema: setLlmKeyInputSchema,
      outputSchema: agentSummarySchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    toolHandler(setLlmKey, ctx),
  );

  server.registerTool(
    "pause_instance",
    {
      title: "Pause instance",
      description: "Pause an instance: stops it and its billing lease. Data is archived, not deleted.",
      inputSchema: idInputSchema,
      outputSchema: agentSummarySchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    toolHandler(pauseInstance, ctx),
  );

  server.registerTool(
    "resume_instance",
    {
      title: "Resume instance",
      description: "Resume a previously paused instance, rebuilding it from its archive.",
      inputSchema: idInputSchema,
      outputSchema: agentSummarySchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    toolHandler(resumeInstance, ctx),
  );

  server.registerTool(
    "rebuild_instance",
    {
      title: "Rebuild instance",
      description: "Rebuild an instance's pod (e.g. after a config change that needs a restart).",
      inputSchema: idInputSchema,
      outputSchema: agentSummarySchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    toolHandler(rebuildInstance, ctx),
  );

  server.registerTool(
    "delete_instance",
    {
      title: "Delete instance",
      description: "Permanently delete an instance. This cannot be undone.",
      inputSchema: idInputSchema,
      outputSchema: deleteInstanceOutputSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    toolHandler(deleteInstance, ctx),
  );

  server.registerTool(
    "payment_options",
    {
      title: "Get payment options",
      description:
        "Get ways to pay for an instance's plan: card/subscription buy links, crypto payment info, and Telegram Stars info (crypto and Stars are in beta testing), plus the instance's current term.",
      inputSchema: idInputSchema,
      outputSchema: paymentOptionsOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    toolHandler(paymentOptions, ctx),
  );

  server.registerTool(
    "set_peers",
    {
      title: "Set A2A peers",
      description: "Set the list of other A2A agents this instance is allowed to call by name.",
      inputSchema: setPeersInputSchema,
      outputSchema: agentSummarySchema,
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    toolHandler(setPeers, ctx),
  );

  server.registerResource(
    "agentspodium-docs",
    "agentspodium://docs",
    { description: "AgentsPodium hosting docs (llms.txt), cached for 10 minutes.", mimeType: "text/plain" },
    async (): Promise<ReadResourceResult> => {
      const text = await fetchDocsText();
      return { contents: [{ uri: "agentspodium://docs", mimeType: "text/plain", text }] };
    },
  );

  return server;
}
