// A2A (Agent2Agent) protocol surface: an AgentCard and a JSON-RPC 2.0
// `message/send` endpoint exposing five of the MCP tools as "skills", reusing
// the exact same implementation functions from tools.ts.

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { ApiError } from "./account-client.js";
import { parseTextCommand, SKILLS_HELP_TEXT } from "./a2a-commands.js";
import type { GatewayContext } from "./tools.js";
import { createInstance, instanceHealth, instanceTerm, listPlatforms, paymentOptions } from "./tools.js";

export const SKILL_IDS = [
  "create-instance",
  "instance-health",
  "instance-term",
  "list-platforms",
  "payment-options",
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

const SKILL_IMPLS: Record<SkillId, (ctx: GatewayContext, params: unknown) => Promise<unknown>> = {
  "create-instance": createInstance,
  "instance-health": instanceHealth,
  "instance-term": instanceTerm,
  "list-platforms": listPlatforms,
  "payment-options": paymentOptions,
};

function isSkillId(value: string): value is SkillId {
  return (SKILL_IDS as readonly string[]).includes(value);
}

/** Builds the AgentCard for the gateway itself (not for a customer's own agent). */
export function buildAgentCard(baseUrl: string) {
  const url = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    name: "AgentsPodium Hosting",
    description:
      "Create, monitor and manage AgentsPodium-hosted AI agent instances. Backed by the same account API as the AgentsPodium dashboard; every call needs the caller's own AgentsPodium API key.",
    url,
    version: "0.1.0",
    provider: { organization: "AgentsPodium", url },
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    security: [{ bearerAuth: [] }],
    skills: [
      {
        id: "create-instance",
        name: "Create instance",
        description:
          "Deploy a new AgentsPodium instance (engine + plan tier). Returns the instance id, endpoint URL, and (when enableA2A) its own a2aUrl/a2aToken.",
        tags: ["hosting", "deploy", "instance"],
        examples: ['{"skill":"create-instance","params":{"engine":"hermes","tier":"small","name":"My Agent"}}', "create hermes small My Agent"],
        inputModes: ["application/json"],
      },
      {
        id: "instance-health",
        name: "Instance health",
        description: "Check whether an instance is reachable and serving, plus its status and quota state.",
        tags: ["hosting", "status", "health"],
        examples: ['{"skill":"instance-health","params":{"id":"agt_123"}}', "health agt_123"],
        inputModes: ["application/json"],
      },
      {
        id: "instance-term",
        name: "Instance term",
        description: "Get an instance's billing term: trial, paid, or grace period, and renewal/expiry dates.",
        tags: ["hosting", "billing"],
        examples: ['{"skill":"instance-term","params":{"id":"agt_123"}}', "term agt_123"],
        inputModes: ["application/json"],
      },
      {
        id: "list-platforms",
        name: "List platforms",
        description: "List available engines (platforms) and hosting plans (tiers), with prices and capabilities.",
        tags: ["hosting", "catalog"],
        examples: ['{"skill":"list-platforms","params":{}}', "platforms"],
        inputModes: ["application/json"],
      },
      {
        id: "payment-options",
        name: "Payment options",
        description:
          "Get ways to pay for an instance's plan: card/subscription buy links, crypto info, and Telegram Stars info (crypto and Stars are in beta testing).",
        tags: ["hosting", "billing", "payment"],
        examples: ['{"skill":"payment-options","params":{"id":"agt_123"}}', "payment agt_123"],
        inputModes: ["application/json"],
      },
    ],
  };
}

interface DataPart {
  kind: "data";
  data: { skill?: string; params?: unknown };
}
interface TextPart {
  kind: "text";
  text: string;
}
type Part = DataPart | TextPart;

function buildTask(parts: Array<{ kind: "data"; data: unknown } | { kind: "text"; text: string }>) {
  return {
    id: `task-${randomUUID()}`,
    status: { state: "completed" as const },
    artifacts: [{ artifactId: randomUUID(), parts }],
  };
}

function summarize(skill: SkillId, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (skill) {
    case "create-instance":
      return `Created instance ${r.id} (status: ${r.status}).`;
    case "instance-health":
      return `Instance ${r.id}: status=${r.status}, reachable=${r.reachable}, serving=${r.serving}.`;
    case "instance-term":
      return `Term: ${JSON.stringify(r.term ?? r)}`;
    case "list-platforms": {
      const engines = Array.isArray(r.engines) ? r.engines.length : 0;
      const tiers = Array.isArray(r.tiers) ? r.tiers.length : 0;
      return `${engines} engine(s), ${tiers} tier(s) available.`;
    }
    case "payment-options":
      return "Payment options retrieved.";
    default:
      return "Done.";
  }
}

/** A minimal JSON-RPC 2.0 response for a request that never resolved to a valid method call. */
function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Handles one JSON-RPC 2.0 request body for `message/send`. Reuses the exact
 * same implementation functions as the MCP tools, so the two transports can
 * never disagree about what a skill does.
 */
export async function handleJsonRpc(ctx: GatewayContext, body: unknown): Promise<object> {
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: { message?: { parts?: Part[] } } };

  if (req?.jsonrpc !== "2.0" || typeof req?.method !== "string") {
    return rpcError(req?.id, -32600, "Invalid JSON-RPC request");
  }
  if (req.method !== "message/send") {
    return rpcError(req.id, -32601, `Unknown method: ${req.method}`);
  }

  const parts = req.params?.message?.parts ?? [];
  const first = parts[0];

  let skillId: string | undefined;
  let params: unknown = {};

  if (first && first.kind === "data") {
    skillId = first.data?.skill;
    params = first.data?.params ?? {};
  } else if (first && first.kind === "text") {
    const parsed = parseTextCommand(first.text);
    if (parsed) {
      skillId = parsed.skill;
      params = parsed.params;
    }
  }

  if (!skillId || !isSkillId(skillId)) {
    return { jsonrpc: "2.0", id: req.id, result: buildTask([{ kind: "text", text: SKILLS_HELP_TEXT }]) };
  }

  try {
    const result = await SKILL_IMPLS[skillId](ctx, params);
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: buildTask([
        { kind: "data", data: result },
        { kind: "text", text: summarize(skillId, result) },
      ]),
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return rpcError(req.id, -32000, err.message, { status: err.status, code: err.code });
    }
    if (err instanceof ZodError) {
      return rpcError(req.id, -32602, `Invalid params: ${err.issues.map((i) => i.message).join(", ")}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return rpcError(req.id, -32603, message);
  }
}
