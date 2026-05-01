export type SessionWindowModeKind = "agent" | "companion";

export type SessionWindowMode =
  | { kind: "agent"; sessionId: string | null }
  | { kind: "companion"; companionSessionId: string };

export function resolveSessionWindowModeFromSearch(search: string): SessionWindowMode {
  const query = new URLSearchParams(search);
  const companionSessionId = query.get("companionSessionId");
  if (companionSessionId) {
    return { kind: "companion", companionSessionId };
  }

  return { kind: "agent", sessionId: query.get("sessionId") };
}
