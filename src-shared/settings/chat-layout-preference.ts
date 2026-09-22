import { isSessionSidePane, normalizeSessionSidePane, type SessionSidePane } from "./session-side-pane.js";

export const CHAT_HEADER_VISIBILITIES = ["hidden", "visible"] as const;
export const CHAT_ACTION_DOCK_MODES = ["compact", "expanded"] as const;

export type ChatHeaderVisibility = (typeof CHAT_HEADER_VISIBILITIES)[number];
export type ChatActionDockMode = (typeof CHAT_ACTION_DOCK_MODES)[number];

export type ChatLayoutPreference = {
  header: ChatHeaderVisibility;
  actionDock: ChatActionDockMode;
  sidePane: SessionSidePane;
};

export type ChatLayoutPreferenceUpdate =
  | { target: "header"; value: ChatHeaderVisibility }
  | { target: "actionDock"; value: ChatActionDockMode }
  | { target: "sidePane"; value: SessionSidePane };

export const DEFAULT_CHAT_LAYOUT_PREFERENCE: Readonly<ChatLayoutPreference> = {
  header: "hidden",
  actionDock: "compact",
  sidePane: "none",
};

export function isChatHeaderVisibility(value: unknown): value is ChatHeaderVisibility {
  return typeof value === "string" && CHAT_HEADER_VISIBILITIES.includes(value as ChatHeaderVisibility);
}

export function isChatActionDockMode(value: unknown): value is ChatActionDockMode {
  return typeof value === "string" && CHAT_ACTION_DOCK_MODES.includes(value as ChatActionDockMode);
}

export function normalizeChatLayoutPreference(value: unknown): ChatLayoutPreference {
  const candidate = value && typeof value === "object"
    ? value as Partial<ChatLayoutPreference>
    : {};
  return {
    header: isChatHeaderVisibility(candidate.header) ? candidate.header : DEFAULT_CHAT_LAYOUT_PREFERENCE.header,
    actionDock: isChatActionDockMode(candidate.actionDock)
      ? candidate.actionDock
      : DEFAULT_CHAT_LAYOUT_PREFERENCE.actionDock,
    sidePane: normalizeSessionSidePane(candidate.sidePane),
  };
}

export function isChatLayoutPreferenceUpdate(value: unknown): value is ChatLayoutPreferenceUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== 2 || !Object.hasOwn(candidate, "target") || !Object.hasOwn(candidate, "value")) {
    return false;
  }

  if (candidate.target === "header") {
    return isChatHeaderVisibility(candidate.value);
  }
  if (candidate.target === "actionDock") {
    return isChatActionDockMode(candidate.value);
  }
  if (candidate.target === "sidePane") {
    return isSessionSidePane(candidate.value);
  }
  return false;
}
