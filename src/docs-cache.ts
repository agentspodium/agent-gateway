// Caches the hosting docs' llms.txt for 10 minutes so the MCP resource and the
// landing pages don't refetch it on every single request.

const DOCS_URL = "https://hosting.defispace.com/llms.txt";
const CACHE_MS = 10 * 60 * 1000;

let cached: { text: string; fetchedAt: number } | null = null;

export async function fetchDocsText(fetchImpl: typeof fetch = fetch): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS) {
    return cached.text;
  }
  try {
    const res = await fetchImpl(DOCS_URL);
    if (!res.ok) throw new Error(`docs fetch failed: ${res.status}`);
    const text = await res.text();
    cached = { text, fetchedAt: now };
    return text;
  } catch (err) {
    // Serve stale content rather than nothing if a refetch fails.
    if (cached) return cached.text;
    return `Docs are temporarily unavailable (${String(err)}). See https://hosting.defispace.com/docs/auth`;
  }
}

/** Test-only: clears the module-level cache between test cases. */
export function resetDocsCache(): void {
  cached = null;
}
