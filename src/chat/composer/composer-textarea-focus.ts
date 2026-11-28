/** 入力欄のフォーカス復元を次の描画フレームへ遅らせるための予約口。 */
export type FrameScheduler = (callback: () => void) => void;

/** 次の描画で指定された入力欄へフォーカスを戻し、挿入後のキャレット位置を設定する。 */
export function restoreComposerTextareaFocusAndCaret(
  textarea: HTMLTextAreaElement | null,
  nextCaret: number,
  scheduleFrame: FrameScheduler = window.requestAnimationFrame,
): void {
  scheduleFrame(() => {
    if (!textarea) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(nextCaret, nextCaret);
  });
}

/** 次の描画時点で現行の入力欄を取得し、問い合わせた時点の本文の末尾にキャレットを置く。 */
export function restoreCurrentComposerTextareaFocusToEnd(
  getTextarea: () => HTMLTextAreaElement | null,
  scheduleFrame: FrameScheduler = window.requestAnimationFrame,
): void {
  scheduleFrame(() => {
    const textarea = getTextarea();
    if (!textarea) {
      return;
    }

    textarea.focus();
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
  });
}
