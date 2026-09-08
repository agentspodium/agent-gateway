// Thin fetch-based client for the AgentsPodium account API. The gateway holds
// no session and no secrets of its own: every call carries the caller's own
// bearer token (their API key or session token), forwarded verbatim.
//
// Injectable `fetchImpl` so tests can point the client at an in-process fake
// server or a stub, without touching the network.

export type FetchLike = typeof fetch;

/** Error shape mirroring the account API's own `{ error, message }` body. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class AccountClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request(
    method: Method,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    // list_platforms is the one tool allowed to run without a caller token
    // (public catalogue data); don't send a meaningless "Bearer " header for it.
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "INVALID_RESPONSE", message: text };
      }
    }

    if (!res.ok) {
      const err = (parsed ?? {}) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        err.error ?? "UPSTREAM_ERROR",
        err.message ?? res.statusText ?? "Account API request failed",
      );
    }
    return parsed ?? {};
  }

  get(path: string, token: string): Promise<unknown> {
    return this.request("GET", path, token);
  }

  post(path: string, token: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, token, body ?? {});
  }

  patch(path: string, token: string, body?: unknown): Promise<unknown> {
    return this.request("PATCH", path, token, body ?? {});
  }

  put(path: string, token: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", path, token, body ?? {});
  }

  delete(path: string, token: string): Promise<unknown> {
    return this.request("DELETE", path, token);
  }

  /** For the handful of endpoints that are public (no bearer required), e.g. the a2a catalog. */
  async getPublic(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: "GET" });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "INVALID_RESPONSE", message: text };
      }
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { error?: string; message?: string };
      throw new ApiError(res.status, err.error ?? "UPSTREAM_ERROR", err.message ?? res.statusText ?? "Account API request failed");
    }
    return parsed ?? {};
  }
}
