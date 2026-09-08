// Every call into this gateway must carry the customer's own credential
// (their AgentsPodium API key or a session token) so it can be forwarded to
// the account API verbatim. The gateway never stores or issues one itself.

export const MISSING_AUTH_BODY = {
  error: "UNAUTHORIZED",
  message:
    "Missing API key. Create one at https://agentspodium.com/account " +
    '("API keys for agents") and send it as "Authorization: Bearer ak_live_...", ' +
    'as an "x-api-key" header, or as the "apiKey" query parameter. ' +
    "See https://hosting.defispace.com/docs/auth for details.",
};

/** Pulls the bearer token out of a raw Authorization header value, if present. */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * The key, wherever the client put it. Directories that proxy remote servers
 * (Smithery among them) forward a configured parameter as a query string or a
 * plain header rather than a bearer; all three spellings mean the same thing.
 */
export function extractApiKey(request: {
  headers: Record<string, string | string[] | undefined>;
  query?: unknown;
}): string | null {
  const bearer = extractBearerToken(request.headers.authorization);
  if (bearer) return bearer;
  const header = request.headers["x-api-key"];
  const fromHeader = (Array.isArray(header) ? header[0] : header)?.trim();
  if (fromHeader) return fromHeader;
  const q = (request.query ?? {}) as Record<string, unknown>;
  const fromQuery = [q.apiKey, q.api_key, q.token].find((v) => typeof v === "string" && v.trim().length > 0);
  return typeof fromQuery === "string" ? fromQuery.trim() : null;
}
