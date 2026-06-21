export type FrameScheduler = (callback: () => void) => void;

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
