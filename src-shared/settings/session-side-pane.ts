/** 現行のSession設定に保存するサイドペインの選択値。 */
export const SESSION_SIDE_PANES = ["files", "context", "none"] as const;

/** ファイル、コンテキスト、非表示のいずれかを表す。 */
export type SessionSidePane = (typeof SESSION_SIDE_PANES)[number];

/** 旧設定を含めず、現行の値だけを文字列から絞り込む。 */
export function isSessionSidePane(value: unknown): value is SessionSidePane {
  return (
    typeof value === "string" &&
    SESSION_SIDE_PANES.includes(value as SessionSidePane)
  );
}

/** 旧設定のbothはコンテキストに移し、認識できない入力は非表示にする。 */
export function normalizeSessionSidePane(value: unknown): SessionSidePane {
  return value === "both"
    ? "context"
    : isSessionSidePane(value)
      ? value
      : "none";
}
