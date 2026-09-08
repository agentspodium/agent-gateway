// Assembles the Fastify app: one process serving both mcp.agentspodium.com
// (Streamable HTTP MCP) and a2a.agentspodium.com (A2A JSON-RPC), selected by
// the Host header wherever a path is shared between the two (just `GET /`).
// The gateway holds no state of its own: every request's Authorization header
// is forwarded as-is to the account API.

import Fastify, { type FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AccountClient, type FetchLike } from "./account-client.js";
import { extractApiKey, MISSING_AUTH_BODY } from "./auth.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildAgentCard, handleJsonRpc } from "./a2a.js";
import type { GatewayConfig } from "./config.js";

const MCP_TOOL_NAMES = [
  "list_platforms",
  "list_instances",
  "create_instance",
  "get_instance_health",
  "get_instance_term",
  "set_llm_key",
  "pause_instance",
  "resume_instance",
  "rebuild_instance",
  "delete_instance",
  "get_payment_options",
  "set_peers",
];

function mcpLandingText(config: GatewayConfig): string {
  return `# AgentsPodium MCP Gateway

Machine Control Protocol (Streamable HTTP) endpoint for driving AgentsPodium
hosting programmatically. Backed by the same account API as the dashboard.

Endpoint: POST https://mcp.agentspodium.com/mcp

## Auth

Every call must carry your AgentsPodium API key:

  Authorization: Bearer ak_live_...

Create one at https://agentspodium.com/account ("API keys for agents").
Docs: https://hosting.defispace.com/docs/auth

## Tools

${MCP_TOOL_NAMES.map((n) => `- ${n}`).join("\n")}

Also exposed: resource \`agentspodium://docs\` (the hosting docs, as text).

## Links

- Account: https://agentspodium.com/account
- Docs: https://hosting.defispace.com/llms.txt
- A2A gateway: https://a2a.agentspodium.com/
`;
}

function a2aLandingText(config: GatewayConfig): string {
  return `# AgentsPodium A2A Gateway

Agent2Agent (JSON-RPC 2.0) endpoint for driving AgentsPodium hosting
programmatically. Backed by the same account API as the dashboard.

Agent Card: ${config.a2aBaseUrl}.well-known/agent-card.json
Endpoint:   POST ${config.a2aBaseUrl}

## Auth

Every call about an account must carry your AgentsPodium API key:

  Authorization: Bearer ak_live_...

Create one at https://agentspodium.com/account ("API keys for agents").
Docs: https://hosting.defispace.com/docs/auth
Without a key: "platforms" (the public catalogue) and any other text (the help).

## Example

  curl -X POST ${config.a2aBaseUrl} \\
    -H "Authorization: Bearer ak_live_..." \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"parts":[{"kind":"text","text":"platforms"}]}}}'

## Catalog

Public directory of listed AgentsPodium agents: ${config.a2aBaseUrl}catalog.json (the platform's own directory: https://${config.a2aHost}/catalog.json)

## Links

- Account: https://agentspodium.com/account
- Docs: https://hosting.defispace.com/llms.txt
- MCP gateway: https://mcp.agentspodium.com/
`;
}

/** JSON-RPC-shaped 405, matching the MCP Streamable HTTP transport's own
    behaviour for stateless GET/DELETE (no session to stream from or close). */
function methodNotAllowed(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  return reply.code(405).send({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Method not allowed in stateless mode." },
  });
}

export interface BuildAppOptions {
  config: GatewayConfig;
  fetchImpl?: FetchLike;
}

export function buildApp({ config, fetchImpl }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const client = new AccountClient(config.accountApiUrl, fetchImpl);
  const a2aHost = config.a2aHost.toLowerCase();

  app.get("/healthz", async () => ({ ok: true }));

  /* What a client has to configure to use this server: one secret. Published
     as JSON Schema so directories that ask for "parameters" can read it. */
  app.get("/.well-known/mcp-config", async () => ({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://mcp.agentspodium.com/.well-known/mcp-config",
    title: "AgentsPodium Hosting MCP configuration",
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        title: "AgentsPodium API key",
        description:
          "Create at https://agentspodium.com/account (API keys for agents). Sent as Authorization: Bearer, x-api-key header, or apiKey query parameter. " +
          "Needed for every tool except list_platforms, which returns public catalogue data.",
        "x-secret": true,
      },
    },
    required: [],
  }));

  app.get("/", async (request, reply) => {
    const host = String(request.headers.host ?? "").toLowerCase();
    reply.type("text/markdown; charset=utf-8");
    return host.includes(a2aHost) ? a2aLandingText(config) : mcpLandingText(config);
  });

  // ---- MCP (Streamable HTTP), stateless ----------------------------------

  /* Directories add a server by URL and probe it with initialize and
     tools/list before anyone has a key — those calls reveal nothing about a
     customer, so they work without one. Anything that touches an account
     (tools/call) still needs the bearer, except list_platforms, which is
     just the public engine/tier catalogue. */
  const DISCOVERY = new Set([
    "initialize", "notifications/initialized", "ping", "tools/list",
    "resources/list", "resources/templates/list", "resources/read", "prompts/list",
  ]);
  app.post("/mcp", async (request, reply) => {
    const token = extractApiKey(request);
    const body = request.body as
      | { method?: string; params?: { name?: string } }
      | { method?: string; params?: { name?: string } }[]
      | undefined;
    const messages = Array.isArray(body) ? body : [body];
    const needsToken = messages.some((m) => {
      const method = String(m?.method ?? "");
      if (DISCOVERY.has(method)) return false;
      if (method === "tools/call" && m?.params?.name === "list_platforms") return false;
      return true;
    });
    if (!token && needsToken) {
      reply.code(401);
      return MISSING_AUTH_BODY;
    }

    const server = buildMcpServer({ client, token: token ?? "" });
    try {
      // enableJsonResponse: a single JSON body back instead of an SSE stream —
      // simpler for the one-shot, stateless calls this gateway serves.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      reply.raw.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      request.log?.error?.(err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } }),
        );
      }
    }
  });

  app.get("/mcp", async (_request, reply) => methodNotAllowed(reply));
  app.delete("/mcp", async (_request, reply) => methodNotAllowed(reply));

  // ---- A2A (JSON-RPC over HTTP) -------------------------------------------

  app.get("/.well-known/agent-card.json", async () => buildAgentCard(config.a2aBaseUrl));

  app.get("/catalog.json", async (_request, reply) => {
    try {
      return await client.getPublic("/a2a-catalog");
    } catch (err) {
      reply.code(502);
      return { error: "UPSTREAM_ERROR", message: err instanceof Error ? err.message : String(err) };
    }
  });

  /* No key is not a transport error here: message/send without one still
     gets the platform list or the help text, and a JSON-RPC error for the
     rest — see handleJsonRpc. */
  app.post("/", async (request) => {
    const token = extractApiKey(request);
    return handleJsonRpc({ client, token: token ?? "" }, request.body);
  });

  return app;
}
