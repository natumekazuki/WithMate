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
  setComposerCaret(selectionStart);
  syncMainComposerCaret?.(selectionStart);
};

export const buildOnDraftCompositionHandlers = (args: ComposerDraftCompositionEndHandlerArgs) => ({
  onDraftCompositionStart: buildOnDraftCompositionStartHandler({
    setIsComposerImeComposing: args.setIsComposerImeComposing,
  }),
  onDraftCompositionEnd: buildOnDraftCompositionEndHandler(args),
});
