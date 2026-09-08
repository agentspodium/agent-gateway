// Builds a fresh MCP server (stateless: one per HTTP request) wired to the
// account API through the caller's own bearer token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "./account-client.js";
import { fetchDocsText } from "./docs-cache.js";
import type { GatewayContext } from "./tools.js";
import {
  createInstanceInputSchema,
  emptyInputSchema,
  idInputSchema,
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
    account-API errors into `isError` results instead of thrown exceptions. */
function toolHandler(
  fn: (ctx: GatewayContext, input: unknown) => Promise<unknown>,
  ctx: GatewayContext,
): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown): Promise<CallToolResult> => {
    try {
      const result = await fn(ctx, input);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
  const server = new McpServer({ name: "agentspodium-hosting", version: "0.1.0" });

  server.registerTool(
    "list_platforms",
    {
      description:
        "List available AgentsPodium engines (platforms) and hosting plans (tiers), with prices and capabilities.",
      inputSchema: emptyInputSchema,
    },
    toolHandler(listPlatforms, ctx),
  );

  server.registerTool(
    "list_instances",
    {
      description:
        "List the caller's AgentsPodium instances (agents): id, name, engine, tier, status, endpoint and A2A URL, domain, creation date. Never returns secrets.",
      inputSchema: emptyInputSchema,
    },
    toolHandler(listInstances, ctx),
  );

  server.registerTool(
    "create_instance",
    {
      description:
        "Create (deploy) a new AgentsPodium instance. Returns the instance id and, when enableA2A is true, the a2aUrl and a2aToken the caller should keep. " +
        "After creating, poll instance_health until it is serving, then call set_llm_key to give it a working LLM key.",
      inputSchema: createInstanceInputSchema,
    },
    toolHandler(createInstance, ctx),
  );

  server.registerTool(
    "instance_health",
    {
      description: "Check whether an instance is reachable and serving, plus its status and quota state.",
      inputSchema: idInputSchema,
    },
    toolHandler(instanceHealth, ctx),
  );

  server.registerTool(
    "instance_term",
    {
      description: "Get the billing term (trial/paid/grace) for an instance, including when it renews or expires.",
      inputSchema: idInputSchema,
    },
    toolHandler(instanceTerm, ctx),
  );

  server.registerTool(
    "set_llm_key",
    {
      description:
        "Set (or clear, with key=null) the LLM provider API key an instance uses to answer. Required before a freshly created instance can actually respond.",
      inputSchema: setLlmKeyInputSchema,
    },
    toolHandler(setLlmKey, ctx),
  );

  server.registerTool(
    "pause_instance",
    { description: "Pause an instance: stops it and its billing lease. Data is archived, not deleted.", inputSchema: idInputSchema },
    toolHandler(pauseInstance, ctx),
  );

  server.registerTool(
    "resume_instance",
    { description: "Resume a previously paused instance, rebuilding it from its archive.", inputSchema: idInputSchema },
    toolHandler(resumeInstance, ctx),
  );

  server.registerTool(
    "rebuild_instance",
    { description: "Rebuild an instance's pod (e.g. after a config change that needs a restart).", inputSchema: idInputSchema },
    toolHandler(rebuildInstance, ctx),
  );

  server.registerTool(
    "delete_instance",
    { description: "Permanently delete an instance. This cannot be undone.", inputSchema: idInputSchema },
    toolHandler(deleteInstance, ctx),
  );

  server.registerTool(
    "payment_options",
    {
      description:
        "Get ways to pay for an instance's plan: card/subscription buy links, crypto payment info, and Telegram Stars info (crypto and Stars are in beta testing), plus the instance's current term.",
      inputSchema: idInputSchema,
    },
    toolHandler(paymentOptions, ctx),
  );

  server.registerTool(
    "set_peers",
    {
      description: "Set the list of other A2A agents this instance is allowed to call by name.",
      inputSchema: setPeersInputSchema,
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
