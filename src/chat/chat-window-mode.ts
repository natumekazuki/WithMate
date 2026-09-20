export type ChatWindowModeKind = "agent";

export type ChatWindowMode =
  | { kind: "agent"; sessionId: string | null };

export type ChatWindowModeTargets<T> = Record<ChatWindowModeKind, T>;

export function resolveChatWindowModeFromSearch(search: string): ChatWindowMode {
  const query = new URLSearchParams(search);
  return { kind: "agent", sessionId: query.get("sessionId") };
}

export function resolveChatWindowModeTarget<T>(
  mode: ChatWindowMode,
  targets: ChatWindowModeTargets<T>,
): T {
  return targets[mode.kind];
}
