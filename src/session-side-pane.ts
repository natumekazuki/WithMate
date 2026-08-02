export const SESSION_SIDE_PANES = ["files", "context", "none"] as const;

export type SessionSidePane = (typeof SESSION_SIDE_PANES)[number];

export function isSessionSidePane(value: unknown): value is SessionSidePane {
  return typeof value === "string" && SESSION_SIDE_PANES.includes(value as SessionSidePane);
}

export function normalizeSessionSidePane(value: unknown): SessionSidePane {
  return isSessionSidePane(value) ? value : "none";
}
