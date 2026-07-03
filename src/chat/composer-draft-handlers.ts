import type { KeyboardEvent } from "react";

export type ComposerDraftSelectionStartProvider = () => number | null | undefined;
export type ComposerDraftCaretUpdater = (selectionStart: number) => void;

type ComposerDraftSelectHandlerArgs = {
  setComposerCaret: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
};

type ComposerDraftCompositionStartHandlerArgs = {
  setIsComposerImeComposing: (isComposing: boolean) => void;
};

type ComposerDraftCompositionEndHandlerArgs = ComposerDraftSelectHandlerArgs & {
  setIsComposerImeComposing: (isComposing: boolean) => void;
  getSelectionStart: ComposerDraftSelectionStartProvider;
  getFallbackSelectionStart: () => number;
};

type ComposerDraftKeyDownHandlerArgs = {
  submit: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

type ComposerDraftChangeCommandArgs = {
  value: string;
  selectionStart?: number;
  setDraft: (value: string) => void;
  setComposerCaret?: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
  clearFeedback?: () => void;
};

type ComposerDraftClearCommandArgs = {
  setDraft: (value: string) => void;
  setComposerCaret?: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
  nextCaret?: number;
};

export const applyComposerDraftChangeCommand = ({
  value,
  selectionStart = value.length,
  setDraft,
  setComposerCaret,
  syncMainComposerCaret,
  clearFeedback,
}: ComposerDraftChangeCommandArgs) => {
  clearFeedback?.();
  setDraft(value);
  setComposerCaret?.(selectionStart);
  syncMainComposerCaret?.(selectionStart);
};

export const applyComposerDraftClearCommand = ({
  setDraft,
  setComposerCaret,
  syncMainComposerCaret,
  nextCaret,
}: ComposerDraftClearCommandArgs) => {
  setDraft("");
  if (nextCaret === undefined) {
    return;
  }
  setComposerCaret?.(nextCaret);
  syncMainComposerCaret?.(nextCaret);
};

export const buildOnDraftSelectHandler = ({
  setComposerCaret,
  syncMainComposerCaret,
}: ComposerDraftSelectHandlerArgs) => (selectionStart: number) => {
  setComposerCaret(selectionStart);
  syncMainComposerCaret?.(selectionStart);
};

export const buildOnDraftCompositionStartHandler = ({
  setIsComposerImeComposing,
}: ComposerDraftCompositionStartHandlerArgs) => () => {
  setIsComposerImeComposing(true);
};

export const buildOnDraftCompositionEndHandler = ({
  setComposerCaret,
  setIsComposerImeComposing,
  getSelectionStart,
  getFallbackSelectionStart,
  syncMainComposerCaret,
}: ComposerDraftCompositionEndHandlerArgs) => () => {
  setIsComposerImeComposing(false);
  const selectionStart = getSelectionStart() ?? getFallbackSelectionStart();
  buildOnDraftSelectHandler({
    setComposerCaret,
    syncMainComposerCaret,
  })(selectionStart);
};

export const buildOnDraftCompositionHandlers = (args: ComposerDraftCompositionEndHandlerArgs) => ({
  onDraftCompositionStart: buildOnDraftCompositionStartHandler({
    setIsComposerImeComposing: args.setIsComposerImeComposing,
  }),
  onDraftCompositionEnd: buildOnDraftCompositionEndHandler(args),
});

export const buildComposerDraftKeyDownHandler = (args: ComposerDraftKeyDownHandlerArgs) => (
  event: KeyboardEvent<HTMLTextAreaElement>,
) => {
  args.submit(event);
};
