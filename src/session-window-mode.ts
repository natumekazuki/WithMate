export type SessionWindowModeKind = "agent" | "companion" | "mate-talk";

export type SessionWindowMode =
  | { kind: "agent"; sessionId: string | null }
  | { kind: "companion"; companionSessionId: string }
  | { kind: "mate-talk" };

export function resolveSessionWindowModeFromSearch(search: string): SessionWindowMode {
  const query = new URLSearchParams(search);
  if (query.get("mode") === "mate-talk") {
    return { kind: "mate-talk" };
  }
  const companionSessionId = query.get("companionSessionId");
  if (companionSessionId) {
    return { kind: "companion", companionSessionId };
  }

  return { kind: "agent", sessionId: query.get("sessionId") };
}
