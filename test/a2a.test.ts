import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { createFakeAccountApi } from "./fixtures/fake-account-api.js";

const config: GatewayConfig = {
  accountApiUrl: "http://fake",
  port: 0,
  a2aHost: "a2a.agentspodium.com",
  a2aBaseUrl: "https://a2a.agentspodium.com/hosting/",
};

const AUTH = { authorization: "Bearer ak_live_test" };

describe("A2A endpoint", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    const fake = createFakeAccountApi();
    app = buildApp({ config, fetchImpl: fake.fetchImpl });
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves a valid AgentCard", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.name).toBe("AgentsPodium Hosting");
    expect(card.url).toBe("https://a2a.agentspodium.com/hosting/");
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false });
    for (const s of card.skills) expect(s.outputModes).toContain("application/json");
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toEqual(expect.arrayContaining(["application/json", "text/plain"]));
    expect(card.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const skillIds = card.skills.map((s: { id: string }) => s.id);
    expect(skillIds).toEqual(
      expect.arrayContaining(["create-instance", "instance-health", "instance-term", "list-platforms", "payment-options"]),
    );
    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tags)).toBe(true);
      expect(Array.isArray(skill.examples)).toBe(true);
      expect(skill.inputModes).toEqual(["application/json", "text/plain"]);
    }
  });

  it("catalog.json proxies the public account API catalog with no auth required", async () => {
    const res = await app.inject({ method: "GET", url: "/catalog.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].slug).toBe("demo");
  });

  it("without a key: help and the catalogue answer, an account question is a JSON-RPC error", async () => {
    /* A registry's probe sends plain text with no credential; it must get a
       completed task back, not a transport-level 401. */
    const hello = await app.inject({
      method: "POST",
      url: "/",
      payload: { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "hello" }] } } },
    });
    expect(hello.statusCode).toBe(200);
    expect(hello.json().result.status.state).toBe("completed");
    expect(hello.json().result.artifacts[0].parts[0].text).toContain("create-instance");

    const platforms = await app.inject({
      method: "POST",
      url: "/",
      payload: { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { parts: [{ kind: "text", text: "platforms" }] } } },
    });
    expect(platforms.statusCode).toBe(200);
    expect(platforms.json().result).toBeDefined();

    const term = await app.inject({
      method: "POST",
      url: "/",
      payload: { jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { parts: [{ kind: "text", text: "term agt_1" }] } } },
    });
    expect(term.statusCode).toBe(200);
    expect(term.json().error.code).toBe(-32001);
    expect(term.json().error.data.code).toBe("UNAUTHORIZED");
    expect(term.json().error.message).toContain("agentspodium.com/account");
  });

  it("message/send with a data part for instance-term returns a completed task with the term", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: AUTH,
      payload: {
        jsonrpc: "2.0",
        id: 42,
        method: "message/send",
        params: {
          message: { parts: [{ kind: "data", data: { skill: "instance-term", params: { id: "agt_1" } } }] },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(42);
    expect(body.result.status).toEqual({ state: "completed" });
    const dataPart = body.result.artifacts[0].parts.find((p: { kind: string }) => p.kind === "data");
    expect(dataPart.data.term.status).toBe("trial");
    const textPart = body.result.artifacts[0].parts.find((p: { kind: string }) => p.kind === "text");
    expect(typeof textPart.text).toBe("string");
  });

  it("a text part 'platforms' returns the platform list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: AUTH,
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "platforms" }] } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const dataPart = body.result.artifacts[0].parts.find((p: { kind: string }) => p.kind === "data");
    expect(dataPart.data.engines[0].id).toBe("hermes");
    expect(dataPart.data.tiers[0].id).toBe("small");
  });

  it("an account API 404 becomes a JSON-RPC error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: AUTH,
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        params: {
          message: { parts: [{ kind: "data", data: { skill: "instance-term", params: { id: "missing" } } }] },
        },
      },
    });
    expect(res.statusCode).toBe(200); // JSON-RPC errors are still HTTP 200
    const body = res.json();
    expect(body.error).toBeTruthy();
    expect(body.error.message).toContain("Not found");
  });

  it("an unrecognized command returns the skills help text", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/",
      headers: AUTH,
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "what can you do" }] } },
      },
    });
    const body = res.json();
    const textPart = body.result.artifacts[0].parts.find((p: { kind: string }) => p.kind === "text");
    expect(textPart.text).toContain("create-instance");
  });
});
