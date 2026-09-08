// A2A (Agent2Agent) protocol surface: an AgentCard and a JSON-RPC 2.0
// `message/send` endpoint exposing five of the MCP tools as "skills", reusing
// the exact same implementation functions from tools.ts.

import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { ApiError } from "./account-client.js";
import { MISSING_AUTH_BODY } from "./auth.js";
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
  /* The fields directories validate against the A2A spec (protocolVersion,
     the three capability flags, per-skill output modes) are all here, so a
     schema-checking registry marks the card conformant rather than "close". */
  return {
    protocolVersion: "0.3.0",
    name: "AgentsPodium Hosting",
    description:
      "Create, monitor and manage AgentsPodium-hosted AI agent instances: pick a platform (Hermes, OpenClaw, n8n, Claude Code, OpenCode, Pi) and a plan, get a running pod with its own URL. Backed by the same account API as the AgentsPodium dashboard. Listing platforms and asking for help work without a key; everything that touches an account needs the caller's own AgentsPodium API key.",
    url,
    preferredTransport: "JSONRPC",
    version: "0.2.0",
    provider: { organization: "AgentsPodium", url: "https://hosting.defispace.com/" },
    documentationUrl: "https://hosting.defispace.com/docs/a2a.html",
    iconUrl: "https://hosting.defispace.com/icon-512.png",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "An AgentsPodium API key (ak_live_…) from https://agentspodium.com/account, \"API keys for agents\".",
      },
    },
    security: [{ bearerAuth: [] }],
    skills: [
      {
        id: "create-instance",
        name: "Create instance",
        description:
          "Deploy a new AgentsPodium instance (engine + plan tier). Returns the instance id, endpoint URL, and (when enableA2A) its own a2aUrl/a2aToken.",
        tags: ["hosting", "deploy", "instance"],
        examples: ['{"skill":"create-instance","params":{"engine":"hermes","tier":"small","name":"My Agent"}}', "create hermes small My Agent"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "instance-health",
        name: "Instance health",
        description: "Check whether an instance is reachable and serving, plus its status and quota state.",
        tags: ["hosting", "status", "health"],
        examples: ['{"skill":"instance-health","params":{"id":"agt_123"}}', "health agt_123"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "instance-term",
        name: "Instance term",
        description: "Get an instance's billing term: trial, paid, or grace period, and renewal/expiry dates.",
        tags: ["hosting", "billing"],
        examples: ['{"skill":"instance-term","params":{"id":"agt_123"}}', "term agt_123"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "list-platforms",
        name: "List platforms",
        description: "List available engines (platforms) and hosting plans (tiers), with prices and capabilities.",
        tags: ["hosting", "catalog"],
        examples: ['{"skill":"list-platforms","params":{}}', "platforms"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
      },
      {
        id: "payment-options",
        name: "Payment options",
        description:
          "Get ways to pay for an instance's plan: card/subscription buy links, crypto info, and Telegram Stars info (crypto and Stars are in beta testing).",
        tags: ["hosting", "billing", "payment"],
        examples: ['{"skill":"payment-options","params":{"id":"agt_123"}}', "payment agt_123"],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json", "text/plain"],
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

/* The exact Task shape of A2A 0.3: `kind` is the discriminator SDK clients
   parse on, `contextId` is required, and a status carries its timestamp.
   The A2A Registry's probe rejected the previous shape as unparseable. */
function buildTask(parts: Array<{ kind: "data"; data: unknown } | { kind: "text"; text: string }>) {
  return {
    id: `task-${randomUUID()}`,
    contextId: `ctx-${randomUUID()}`,
    kind: "task" as const,
    status: { state: "completed" as const, timestamp: new Date().toISOString() },
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

  /* A registry's smoke probe, or an agent still deciding whether to sign up,
     arrives with no key. The public catalogue and the help text answer them;
     anything about an account is refused as a JSON-RPC error (the transport
     itself stays 200, as the A2A spec wants for protocol-level errors). */
  if (!ctx.token && skillId !== "list-platforms") {
    return rpcError(req.id, -32001, MISSING_AUTH_BODY.message, { status: 401, code: MISSING_AUTH_BODY.error });
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
