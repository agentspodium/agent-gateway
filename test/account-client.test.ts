import { describe, expect, it } from "vitest";
import { AccountClient, ApiError } from "../src/account-client.js";
import { createFakeAccountApi } from "./fixtures/fake-account-api.js";

describe("AccountClient", () => {
  it("forwards the bearer token and parses a JSON response", async () => {
    const { fetchImpl, calls } = createFakeAccountApi();
    const client = new AccountClient("http://fake", fetchImpl);

    const res = (await client.get("/agents", "ak_live_abc")) as { agents: unknown[] };

    expect(res.agents).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/agents", authorization: "Bearer ak_live_abc" });
  });

  it("throws ApiError with the upstream error/message on a non-2xx response", async () => {
    const { fetchImpl } = createFakeAccountApi();
    const client = new AccountClient("http://fake", fetchImpl);

    await expect(client.get("/agents/missing/term", "ak_live_abc")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Not found",
    });
    await expect(client.get("/agents/missing/term", "ak_live_abc")).rejects.toBeInstanceOf(ApiError);
  });

  it("handles a 204 No Content response (delete)", async () => {
    const { fetchImpl } = createFakeAccountApi();
    const client = new AccountClient("http://fake", fetchImpl);

    const res = await client.delete("/agents/agt_1", "ak_live_abc");
    expect(res).toEqual({});
  });

  it("getPublic sends no Authorization header", async () => {
    const { fetchImpl, calls } = createFakeAccountApi();
    const client = new AccountClient("http://fake", fetchImpl);

    await client.getPublic("/a2a-catalog");
    expect(calls[0]?.authorization).toBeNull();
  });
});
