import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";
import { createFakeAccountApi, type FakeApiCall } from "./fixtures/fake-account-api.js";

const config: GatewayConfig = {
  accountApiUrl: "http://fake",
  port: 0,
  a2aHost: "a2a.agentspodium.com",
  a2aBaseUrl: "https://a2a.agentspodium.com/hosting/",
};

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  authorization: "Bearer ak_live_test",
};

function rpc(method: string, params: unknown = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

describe("MCP endpoint", () => {
  let app: FastifyInstance;
  let calls: FakeApiCall[];

  beforeEach(() => {
    const fake = createFakeAccountApi();
    calls = fake.calls;
    app = buildApp({ config, fetchImpl: fake.fetchImpl });
  });

  afterEach(async () => {
    await app.close();
  });

  it("takes the key from x-api-key or ?apiKey= as well as the bearer", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const viaHeader = await app.inject({
      method: "POST", url: "/mcp", headers: { ...headers, "x-api-key": "ak_live_test" },
      payload: rpc("tools/call", { name: "list_platforms", arguments: {} }),
    });
    expect(viaHeader.statusCode).toBe(200);
    const viaQuery = await app.inject({
      method: "POST", url: "/mcp?apiKey=ak_live_test", headers,
      payload: rpc("tools/call", { name: "list_platforms", arguments: {} }),
    });
    expect(viaQuery.statusCode).toBe(200);
    const schema = await app.inject({ method: "GET", url: "/.well-known/mcp-config" });
    expect(schema.json().required).toEqual(["apiKey"]);
  });

  it("answers tools/list without a key (directories probe by URL) but refuses tools/call", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const list = await app.inject({ method: "POST", url: "/mcp", headers, payload: rpc("tools/list") });
    expect(list.statusCode).toBe(200);
    expect(list.json().result.tools.length).toBeGreaterThan(5);

    const call = await app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: rpc("tools/call", { name: "list_instances", arguments: {} }),
    });
    expect(call.statusCode).toBe(401);
    const body = call.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toContain("agentspodium.com/account");
  });

  it("tools/list shows every tool", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: MCP_HEADERS, payload: rpc("tools/list") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_platforms",
        "list_instances",
        "create_instance",
        "instance_health",
        "instance_term",
        "set_llm_key",
        "pause_instance",
        "resume_instance",
        "rebuild_instance",
        "delete_instance",
        "payment_options",
        "set_peers",
      ]),
    );
    expect(names).toHaveLength(12);
  });

  it("create_instance posts the right body (enableA2A adds the a2a toolset) and returns a2aUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: MCP_HEADERS,
      payload: rpc("tools/call", {
        name: "create_instance",
        arguments: { tier: "small", name: "My Agent", enableA2A: true },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.a2aUrl).toBe("https://agt-1.a2a.agentspodium.com/");
    expect(payload.a2aToken).toBe("a2a_secret_token");

    const createCall = calls.find((c) => c.method === "POST" && c.path === "/agents");
    expect(createCall).toBeTruthy();
    const sentBody = createCall!.body as { tools?: { enabled: string[] } };
    expect(sentBody.tools?.enabled).toEqual(expect.arrayContaining(["web", "browser", "a2a"]));
    expect(sentBody.tools?.enabled).not.toContain("video"); // not defaultEnabled
  });

  it("list_instances never returns a2aToken", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: MCP_HEADERS,
      payload: rpc("tools/call", { name: "list_instances", arguments: {} }),
    });
    const body = res.json();
    expect(body.result.content[0].text).not.toContain("a2a_secret_token");
  });

  it("an account API 404 becomes an isError tool result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: MCP_HEADERS,
      payload: rpc("tools/call", { name: "instance_term", arguments: { id: "missing" } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.isError).toBe(true);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.error).toBe("NOT_FOUND");
  });
});
