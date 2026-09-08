// A small command grammar for the plain-text half of A2A message/send, so an
// agent that only speaks text (no structured data parts) can still drive the
// same five skills.

export interface ParsedCommand {
  skill: string;
  params: Record<string, unknown>;
}

/**
 * Parses one of:
 *   create <engine> <tier> [name ...]
 *   health <id>
 *   term <id>
 *   platforms
 *   payment <id>
 * Returns null for anything else, so the caller can fall back to the help text.
 */
export function parseTextCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  const [verb, ...rest] = tokens;

  switch (verb?.toLowerCase()) {
    case "create": {
      const [engine, tier, ...nameParts] = rest;
      if (!engine || !tier) return null;
      const params: Record<string, unknown> = { engine, tier };
      if (nameParts.length > 0) params.name = nameParts.join(" ");
      return { skill: "create-instance", params };
    }
    case "health": {
      const [id] = rest;
      if (!id) return null;
      return { skill: "instance-health", params: { id } };
    }
    case "term": {
      const [id] = rest;
      if (!id) return null;
      return { skill: "instance-term", params: { id } };
    }
    case "platforms":
      return { skill: "list-platforms", params: {} };
    case "payment": {
      const [id] = rest;
      if (!id) return null;
      return { skill: "payment-options", params: { id } };
    }
    default:
      return null;
  }
}

export const SKILLS_HELP_TEXT = `AgentsPodium A2A skills:

- create-instance  { engine: string, tier: "tiny"|"small"|"medium"|"large", personaId?, name?, channels?, model?, enableA2A?, domain?, extraSoul? }
  text: create <engine> <tier> [name ...]
- instance-health  { id: string }
  text: health <id>
- instance-term    { id: string }
  text: term <id>
- list-platforms   {}
  text: platforms
- payment-options  { id: string }
  text: payment <id>

Send a data part: { kind: "data", data: { skill: "<skill-id>", params: {...} } }
or a text part using the grammar above.`;
