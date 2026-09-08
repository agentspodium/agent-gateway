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
  id: z.string().min(1),
  provider: z.string().min(1).describe("LLM provider id, e.g. openai, anthropic, deepseek."),
  key: z.string().min(1).describe("The provider API key. Stored encrypted, never echoed back."),
  model: z.string().max(200).optional(),
});

export const peerInputSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url(),
  token: z.string().min(1).max(500).optional(),
});

export const setPeersInputSchema = z.object({
  id: z.string().min(1),
  peers: z.array(peerInputSchema).max(20),
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
    next: "poll instance_health until serving, then set_llm_key",
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
