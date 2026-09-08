// Shared business logic behind every MCP tool and A2A skill. Kept independent
// of both transports so `tools/call` and `message/send` hit exactly the same
// code path and can never drift apart.

import { z } from "zod";
import type { AccountClient } from "./account-client.js";

/** Per-call context: the caller's own bearer token, forwarded to the account API. */
export interface GatewayContext {
  client: AccountClient;
  token: string;
}

const channelEnum = z.enum(["web", "telegram", "discord", "whatsapp", "email"]);

export const emptyInputSchema = z.object({});

export const idInputSchema = z.object({
  id: z.string().min(1).describe("Instance (agent) id, as returned by create_instance or list_instances."),
});

export const createInstanceInputSchema = z.object({
  personaId: z
    .string()
    .min(1)
    .optional()
    .default("personal-assistant")
    .describe("Persona/template id from list_platforms; defaults to the general-purpose persona."),
  engine: z
    .string()
    .min(1)
    .optional()
    .default("hermes")
    .describe("Runtime engine id (e.g. hermes, openclaw, n8n). See list_platforms for what's available."),
  tier: z
    .enum(["tiny", "small", "medium", "large"])
    .describe("Hosting plan controlling RAM/CPU/disk. See list_platforms for prices."),
  name: z.string().min(1).max(60).optional().describe("Display name for the instance."),
  channels: z.array(channelEnum).min(1).optional().describe("Channels to enable (web, telegram, ...)."),
  model: z.string().max(200).optional().describe("Default LLM model id for the engine."),
  enableA2A: z
    .boolean()
    .optional()
    .default(true)
    .describe("Turn on the A2A toolset and issue an a2aUrl/a2aToken for this instance."),
  domain: z.string().max(253).optional().describe("Customer-owned domain to serve the instance from."),
  extraSoul: z.string().max(4000).optional().describe("Extra system-prompt instructions appended to the persona."),
});

export const setLlmKeyInputSchema = z.object({
  id: z.string().min(1).describe("Instance (agent) id, as returned by create_instance or list_instances."),
  provider: z.string().min(1).describe("LLM provider id, e.g. openai, anthropic, deepseek."),
  key: z.string().min(1).describe("The provider API key. Stored encrypted, never echoed back."),
  model: z
    .string()
    .max(200)
    .optional()
    .describe("Model id to use with this provider (e.g. gpt-4o-mini). Optional; the engine defaults if omitted."),
});

export const peerInputSchema = z.object({
  name: z.string().min(1).max(64).describe("Name other agents use to address this peer over A2A."),
  url: z.string().url().describe("A2A JSON-RPC endpoint URL of the peer agent."),
  token: z.string().min(1).max(500).optional().describe("Bearer token to send when calling this peer, if it requires one."),
});

export const setPeersInputSchema = z.object({
  id: z.string().min(1).describe("Instance (agent) id whose peer list is being set."),
  peers: z.array(peerInputSchema).max(20).describe("Full replacement list of peer agents this instance may call (up to 20)."),
});

/** Raw agent record as the account API returns it (only the fields we use). */
interface AccountAgent {
  id: string;
  name: string;
  engine: string;
  tier: string;
  status: string;
  endpointUrl: string | null;
  a2aUrl: string | null;
  a2aToken?: string | null;
  domain: string | null;
  createdAt: string;
  quotaStatus?: string;
}

function summarizeAgent(agent: AccountAgent) {
  return {
    id: agent.id,
    name: agent.name,
    engine: agent.engine,
    tier: agent.tier,
    status: agent.status,
    endpointUrl: agent.endpointUrl,
    a2aUrl: agent.a2aUrl,
    domain: agent.domain,
    createdAt: agent.createdAt,
  };
}

/** Shape of `summarizeAgent`'s output — the fields every mutation tool below
    (set_llm_key, pause/resume/rebuild_instance, set_peers) actually returns. */
export const agentSummarySchema = z.object({
  id: z.string().describe("Instance (agent) id."),
  name: z.string().describe("Display name."),
  engine: z.string().describe("Runtime engine id (e.g. hermes)."),
  tier: z.string().describe("Hosting plan id."),
  status: z.string().describe("Lifecycle status (e.g. running, stopped)."),
  endpointUrl: z.string().nullable().describe("Public HTTPS endpoint for the instance, or null if not yet assigned."),
  a2aUrl: z.string().nullable().describe("A2A JSON-RPC endpoint for the instance, or null if A2A is not enabled."),
  domain: z.string().nullable().describe("Customer-owned domain serving the instance, or null."),
  createdAt: z.string().describe("ISO timestamp when the instance was created."),
});

export const listPlatformsOutputSchema = z.object({
  engines: z
    .array(
      z.object({
        id: z.string().describe("Engine id (e.g. hermes)."),
        label: z.string().describe("Human-readable engine name."),
        minTier: z.string().describe("Cheapest tier this engine can run on."),
        status: z.string().describe("Engine availability status (e.g. stable, beta)."),
        capabilities: z.unknown().describe("Engine-specific capability flags, as published by the account API."),
      }),
    )
    .describe("Available runtime engines."),
  tiers: z.array(z.unknown()).describe("Available hosting plans (tiers) with prices, as published by the account API."),
});

export const listInstancesOutputSchema = z.object({
  instances: z.array(agentSummarySchema).describe("The caller's instances."),
});

export const createInstanceOutputSchema = z.object({
  id: z.string().describe("Newly created instance id."),
  status: z.string().describe("Initial lifecycle status."),
  endpointUrl: z.string().nullable().describe("Public HTTPS endpoint, or null until assigned."),
  a2aUrl: z.string().nullable().describe("A2A endpoint, or null if A2A was not enabled."),
  a2aToken: z.string().nullable().describe("A2A bearer token to keep, or null if A2A was not enabled."),
  next: z.string().describe("Suggested next step for the caller."),
});

export const instanceHealthOutputSchema = z.object({
  id: z.string().describe("Instance id checked."),
  status: z.string().describe("Lifecycle status reported by the account API."),
  quotaStatus: z.string().nullable().describe("Usage quota status, or null if not tracked."),
  reachable: z.boolean().nullable().describe("Whether the instance's endpoint responded, or null if unknown."),
  serving: z.boolean().nullable().describe("Whether the instance is currently answering requests, or null if unknown."),
});

export const instanceTermOutputSchema = z.object({
  term: z
    .record(z.unknown())
    .describe("Billing term details (status, renewal/expiry dates, etc.), as returned by the account API."),
});

export const deleteInstanceOutputSchema = z.object({
  ok: z.literal(true).describe("Always true on success."),
  id: z.string().describe("Id of the deleted instance."),
});

export const paymentOptionsOutputSchema = z.object({
  providers: z.unknown().describe("Card/subscription payment providers and buy links, as returned by the account API."),
  crypto: z
    .record(z.unknown())
    .describe("Crypto payment info (beta testing), as returned by the account API, plus an added 'note' field."),
  stars: z
    .record(z.unknown())
    .describe("Telegram Stars payment info (beta testing), as returned by the account API, plus an added 'note' field."),
  term: z.unknown().describe("The instance's current billing term."),
});

export async function listPlatforms(ctx: GatewayContext) {
  const [enginesRes, tiersRes] = await Promise.all([
    ctx.client.get("/engines", ctx.token) as Promise<{
      engines: Array<{ id: string; label: string; minTier: string; status: string; capabilities: unknown }>;
    }>,
    ctx.client.get("/tiers", ctx.token) as Promise<{ tiers: unknown[] }>,
  ]);
  return {
    engines: enginesRes.engines.map((e) => ({
      id: e.id,
      label: e.label,
      minTier: e.minTier,
      status: e.status,
      capabilities: e.capabilities,
    })),
    tiers: tiersRes.tiers,
  };
}

export async function listInstances(ctx: GatewayContext) {
  const res = (await ctx.client.get("/agents", ctx.token)) as { agents: AccountAgent[] };
  return { instances: res.agents.map(summarizeAgent) };
}

export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>;

export async function createInstance(ctx: GatewayContext, rawInput: unknown) {
  const input = createInstanceInputSchema.parse(rawInput);

  let tools: { enabled: string[]; mcpServers: never[] } | undefined;
  if (input.enableA2A) {
    const toolsCatalog = (await ctx.client.get("/tools", ctx.token)) as {
      toolsets: Array<{ id: string; defaultEnabled: boolean }>;
    };
    const defaultIds = toolsCatalog.toolsets.filter((t) => t.defaultEnabled).map((t) => t.id);
    tools = { enabled: [...defaultIds, "a2a"], mcpServers: [] };
  }

  const body = {
    personaId: input.personaId,
    engine: input.engine,
    tier: input.tier,
    name: input.name,
    channels: input.channels,
    model: input.model,
    domain: input.domain,
    extraSoul: input.extraSoul,
    tools,
  };

  const res = (await ctx.client.post("/agents", ctx.token, body)) as { agent: AccountAgent };
  const agent = res.agent;
  return {
    id: agent.id,
    status: agent.status,
    endpointUrl: agent.endpointUrl,
    a2aUrl: agent.a2aUrl,
    a2aToken: agent.a2aToken ?? null,
    next: "poll get_instance_health until serving, then set_llm_key",
  };
}

export async function instanceHealth(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  const [liveness, agentRes] = await Promise.all([
    ctx.client.get(`/agents/${id}/liveness`, ctx.token) as Promise<{
      reachable: boolean | null;
      serving: boolean | null;
    }>,
    ctx.client.get(`/agents/${id}`, ctx.token) as Promise<{ agent: AccountAgent }>,
  ]);
  const agent = agentRes.agent;
  return {
    id,
    status: agent.status,
    quotaStatus: agent.quotaStatus ?? null,
    reachable: liveness.reachable,
    serving: liveness.serving,
  };
}

export async function instanceTerm(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  return ctx.client.get(`/agents/${id}/term`, ctx.token);
}

export async function setLlmKey(ctx: GatewayContext, rawInput: unknown) {
  const { id, provider, key, model } = setLlmKeyInputSchema.parse(rawInput);
  const res = (await ctx.client.patch(`/agents/${id}/llm-key`, ctx.token, {
    provider,
    key,
    model,
  })) as { agent: AccountAgent };
  return summarizeAgent(res.agent);
}

export async function pauseInstance(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  const res = (await ctx.client.post(`/agents/${id}/pause`, ctx.token)) as { agent: AccountAgent };
  return summarizeAgent(res.agent);
}

export async function resumeInstance(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  const res = (await ctx.client.post(`/agents/${id}/resume`, ctx.token)) as { agent: AccountAgent };
  return summarizeAgent(res.agent);
}

export async function rebuildInstance(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  const res = (await ctx.client.post(`/agents/${id}/rebuild`, ctx.token)) as { agent: AccountAgent };
  return summarizeAgent(res.agent);
}

export async function deleteInstance(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  await ctx.client.delete(`/agents/${id}`, ctx.token);
  return { ok: true, id };
}

export async function paymentOptions(ctx: GatewayContext, rawInput: unknown) {
  const { id } = idInputSchema.parse(rawInput);
  const [providersRes, cryptoInfo, starsInfo, termRes] = await Promise.all([
    ctx.client.get("/subscriptions/providers", ctx.token),
    ctx.client.get("/crypto/info", ctx.token),
    ctx.client.get("/stars/info", ctx.token),
    ctx.client.get(`/agents/${id}/term`, ctx.token),
  ]);
  return {
    providers: providersRes,
    crypto: { ...(cryptoInfo as object), note: "beta testing" },
    stars: { ...(starsInfo as object), note: "beta testing" },
    term: (termRes as { term: unknown }).term,
  };
}

export async function setPeers(ctx: GatewayContext, rawInput: unknown) {
  const { id, peers } = setPeersInputSchema.parse(rawInput);
  const res = (await ctx.client.put(`/agents/${id}/peers`, ctx.token, { peers })) as {
    agent: AccountAgent;
  };
  return summarizeAgent(res.agent);
}
