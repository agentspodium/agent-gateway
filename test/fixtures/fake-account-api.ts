// A fetch stub standing in for the real account API in tests: enough routes
// to exercise every gateway tool/skill, plus one deliberate 404 case.

import type { FetchLike } from "../../src/account-client.js";

export interface FakeAgent {
  id: string;
  name: string;
  engine: string;
  tier: string;
  status: string;
  endpointUrl: string | null;
  a2aUrl: string | null;
  a2aToken: string | null;
  domain: string | null;
  createdAt: string;
  quotaStatus: string;
}

const AGENT: FakeAgent = {
  id: "agt_1",
  name: "Test Agent",
  engine: "hermes",
  tier: "small",
  status: "running",
  endpointUrl: "https://agt-1.agentspodium.com",
  a2aUrl: "https://agt-1.a2a.agentspodium.com/",
  a2aToken: "a2a_secret_token",
  domain: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  quotaStatus: "ok",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Records every call made to the fake API, so tests can assert on request bodies. */
export interface FakeApiCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export function createFakeAccountApi(): { fetchImpl: FetchLike; calls: FakeApiCall[] } {
  const calls: FakeApiCall[] = [];

  const fetchImpl: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, authorization, body });

    if (path === "/engines" && method === "GET") {
      return json(200, {
        engines: [
          { id: "hermes", label: "Hermes", minTier: "tiny", status: "stable", capabilities: { skills: true } },
        ],
      });
    }
    if (path === "/tiers" && method === "GET") {
      return json(200, { tiers: [{ id: "small", name: "Small", monthlyUsd: 4.99, annualUsd: 49.9 }] });
    }
    if (path === "/tools" && method === "GET") {
      return json(200, {
        toolsets: [
          { id: "web", defaultEnabled: true },
          { id: "browser", defaultEnabled: true },
          { id: "video", defaultEnabled: false },
        ],
      });
    }
    if (path === "/agents" && method === "GET") {
      return json(200, { agents: [AGENT] });
    }
    if (path === "/agents" && method === "POST") {
      return json(201, { agent: AGENT });
    }
    if (path === "/agents/agt_1" && method === "GET") {
      return json(200, { agent: AGENT });
    }
    if (path === "/agents/agt_1/liveness" && method === "GET") {
      return json(200, { reachable: true, serving: true });
    }
    if (path === "/agents/agt_1/term" && method === "GET") {
      return json(200, { term: { status: "trial", daysLeft: 5, renewUrl: "https://agentspodium.com/agents/agt_1?tab=billing" } });
    }
    if (path === "/agents/missing/term" && method === "GET") {
      return json(404, { error: "NOT_FOUND", message: "Not found" });
    }
    if (path === "/agents/agt_1/llm-key" && method === "PATCH") {
      return json(200, { agent: AGENT });
    }
    if (path === "/agents/agt_1/pause" && method === "POST") {
      return json(200, { agent: { ...AGENT, status: "stopped" } });
    }
    if (path === "/agents/agt_1/resume" && method === "POST") {
      return json(200, { agent: AGENT });
    }
    if (path === "/agents/agt_1/rebuild" && method === "POST") {
      return json(200, { agent: AGENT });
    }
    if (path === "/agents/agt_1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (path === "/agents/agt_1/peers" && method === "PUT") {
      return json(200, { agent: AGENT });
    }
    if (path === "/subscriptions/providers" && method === "GET") {
      return json(200, { providers: [{ id: "stripe", buyUrl: "https://example.com/buy" }] });
    }
    if (path === "/crypto/info" && method === "GET") {
      return json(200, { networks: ["eth"] });
    }
    if (path === "/stars/info" && method === "GET") {
      return json(200, { enabled: true });
    }
    if (path === "/a2a-catalog" && method === "GET") {
      return json(200, { agents: [{ slug: "demo", name: "Demo", url: "https://demo.agentspodium.com/" }] });
    }

    return json(404, { error: "NOT_FOUND", message: `no fixture for ${method} ${path}` });
  }) as FetchLike;

  return { fetchImpl, calls };
}
