import type { CSSProperties, ReactNode } from "react";

import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { SessionDiffModal } from "./runtime/session-diff.js";

/** 選択中の差分、プレビュー用の配色、閉じる・別ウィンドウで開く操作を受け取る。 */
export type ChatSessionModalsProps = {
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  children?: ReactNode;
};

/** 差分プレビューと、呼び出し側が供給するモーダルを同じシェルに配置する。 */
export function ChatSessionModals({
  selectedDiff,
  selectedDiffThemeStyle,
  onCloseDiff,
  onOpenDiffWindow,
  children,
}: ChatSessionModalsProps) {
  return (
    <>
      <SessionDiffModal
        selectedDiff={selectedDiff}
        themeStyle={selectedDiffThemeStyle}
        onClose={onCloseDiff}
        onOpenDiffWindow={onOpenDiffWindow}
      />

      {children}
    </>
  );
}
