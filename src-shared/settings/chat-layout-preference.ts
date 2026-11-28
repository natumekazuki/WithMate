import {
  isSessionSidePane,
  normalizeSessionSidePane,
  type SessionSidePane,
} from "./session-side-pane.js";

/** チャットヘッダーの表示設定として保存できる値。 */
export const CHAT_HEADER_VISIBILITIES = ["hidden", "visible"] as const;
/** チャットの操作ドックに保存できる展開状態。 */
export const CHAT_ACTION_DOCK_MODES = ["compact", "expanded"] as const;

/** チャットヘッダーを表示するか隠すかを指定する値。 */
export type ChatHeaderVisibility = (typeof CHAT_HEADER_VISIBILITIES)[number];
/** 操作ドックのコンパクト表示と展開表示を切り替える値。 */
export type ChatActionDockMode = (typeof CHAT_ACTION_DOCK_MODES)[number];

/** チャット画面で復元するヘッダー、操作ドック、サイドパネルの設定。 */
export type ChatLayoutPreference = {
  header: ChatHeaderVisibility;
  actionDock: ChatActionDockMode;
  sidePane: SessionSidePane;
};

/** 一度に更新する表示領域と、その領域で受け入れられる値の組。 */
export type ChatLayoutPreferenceUpdate =
  | { target: "header"; value: ChatHeaderVisibility }
  | { target: "actionDock"; value: ChatActionDockMode }
  | { target: "sidePane"; value: SessionSidePane };

/** 保存値がないときのチャット配置。ヘッダーとサイドパネルを隠し、操作ドックを縮める。 */
export const DEFAULT_CHAT_LAYOUT_PREFERENCE: Readonly<ChatLayoutPreference> = {
  header: "hidden",
  actionDock: "compact",
  sidePane: "none",
};

/** 境界から受け取った値が保存可能なヘッダー表示設定か判定する。 */
export function isChatHeaderVisibility(
  value: unknown,
): value is ChatHeaderVisibility {
  return (
    typeof value === "string" &&
    CHAT_HEADER_VISIBILITIES.includes(value as ChatHeaderVisibility)
  );
}

/** 境界から受け取った値が保存可能な操作ドックの設定か判定する。 */
export function isChatActionDockMode(
  value: unknown,
): value is ChatActionDockMode {
  return (
    typeof value === "string" &&
    CHAT_ACTION_DOCK_MODES.includes(value as ChatActionDockMode)
  );
}

/** 保存済みの配置を復元し、欠落や無効な項目だけを既定値で埋める。 */
export function normalizeChatLayoutPreference(
  value: unknown,
): ChatLayoutPreference {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<ChatLayoutPreference>)
      : {};
  return {
    header: isChatHeaderVisibility(candidate.header)
      ? candidate.header
      : DEFAULT_CHAT_LAYOUT_PREFERENCE.header,
    actionDock: isChatActionDockMode(candidate.actionDock)
      ? candidate.actionDock
      : DEFAULT_CHAT_LAYOUT_PREFERENCE.actionDock,
    sidePane: normalizeSessionSidePane(candidate.sidePane),
  };
}

/** 余計なプロパティを許さず、更新対象と値の組み合わせを検証する。 */
export function isChatLayoutPreferenceUpdate(
  value: unknown,
): value is ChatLayoutPreferenceUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, "target") ||
    !Object.hasOwn(candidate, "value")
  ) {
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
