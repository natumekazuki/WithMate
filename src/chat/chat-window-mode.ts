export type ChatWindowModeKind = "agent" | "companion" | "mate-talk";

export type ChatWindowMode =
  | { kind: "agent"; sessionId: string | null }
  | { kind: "companion"; companionSessionId: string }
  | { kind: "mate-talk" };

export type ChatWindowModeTargets<T> = Record<ChatWindowModeKind, T>;

export function resolveChatWindowModeFromSearch(search: string): ChatWindowMode {
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

export function resolveChatWindowModeTarget<T>(
  mode: ChatWindowMode,
  targets: ChatWindowModeTargets<T>,
): T {
  return targets[mode.kind];
}
