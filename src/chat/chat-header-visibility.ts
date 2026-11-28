import type { SessionHeaderProps } from "./shell/session-header.js";

/** Auxiliary の表示かどうかと、現在の Session に削除操作を出せるかを入力する。 */
export type ChatHeaderVisibilityOptions = {
  isAuxiliaryMode?: boolean;
  canDeleteSession?: boolean;
};

/** 現在のコンテキストにおける Session 名変更と削除ボタンの表示条件。 */
export type ChatHeaderVisibility = Pick<
  SessionHeaderProps,
  "showRenameButton" | "showDeleteButton"
>;

/** Auxiliary では両方を隠す。Main では名前変更を出し、削除は許可されている場合にだけ出す。 */
export function resolveChatHeaderVisibility({
  isAuxiliaryMode = false,
  canDeleteSession = true,
}: ChatHeaderVisibilityOptions): ChatHeaderVisibility {
  return {
    showRenameButton: !isAuxiliaryMode,
    showDeleteButton: canDeleteSession && !isAuxiliaryMode,
  };
}
