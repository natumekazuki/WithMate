/** 入力欄の選択開始位置を読み、取得できない場合は空値を返す。 */
export type ComposerDraftSelectionStartProvider = () =>
  number | null | undefined;
/** 入力欄のキャレットとして選択開始位置を記録する。 */
export type ComposerDraftCaretUpdater = (selectionStart: number) => void;

/** 選択操作を入力欄に反映し、必要ならメイン入力欄にも同期するための更新先。 */
type ComposerDraftSelectHandlerArgs = {
  setComposerCaret: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
};

/** IME変換の開始を入力欄の状態へ通知するための更新先。 */
type ComposerDraftCompositionStartHandlerArgs = {
  setIsComposerImeComposing: (isComposing: boolean) => void;
};

/** IME変換終了時にキャレットを実測位置または代替位置へ戻すための入出力。 */
type ComposerDraftCompositionEndHandlerArgs = ComposerDraftSelectHandlerArgs & {
  setIsComposerImeComposing: (isComposing: boolean) => void;
  getSelectionStart: ComposerDraftSelectionStartProvider;
  getFallbackSelectionStart: () => number;
};

/** 下書きの差し替えに伴い、キャレット同期と通知の消去を任意で行うための引数。 */
type ComposerDraftChangeCommandArgs = {
  value: string;
  selectionStart?: number;
  setDraft: (value: string) => void;
  setComposerCaret?: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
  clearFeedback?: () => void;
};

/** 下書きの消去先と、消去後も位置を指定する場合のキャレット更新先。 */
type ComposerDraftClearCommandArgs = {
  setDraft: (value: string) => void;
  setComposerCaret?: ComposerDraftCaretUpdater;
  syncMainComposerCaret?: ComposerDraftCaretUpdater;
  nextCaret?: number;
};

/** 通知を消して下書きを差し替え、位置未指定なら新しい本文の末尾へキャレットを移す。 */
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

/** 下書きを空にし、次の位置が指定された場合にだけキャレットも更新する。 */
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

/** 選択開始位置を記録し、同期先があればメイン入力欄にも同じ位置を渡す。 */
export const buildOnDraftSelectHandler =
  ({
    setComposerCaret,
    syncMainComposerCaret,
  }: ComposerDraftSelectHandlerArgs) =>
  (selectionStart: number) => {
    setComposerCaret(selectionStart);
    syncMainComposerCaret?.(selectionStart);
  };

/** IME変換開始時に変換中フラグを立てるハンドラーを作る。 */
export const buildOnDraftCompositionStartHandler =
  ({ setIsComposerImeComposing }: ComposerDraftCompositionStartHandlerArgs) =>
  () => {
    setIsComposerImeComposing(true);
  };

/** IME変換終了時に変換中フラグを解除し、選択位置を取得できなければ代替位置を反映する。 */
export const buildOnDraftCompositionEndHandler =
  ({
    setComposerCaret,
    setIsComposerImeComposing,
    getSelectionStart,
    getFallbackSelectionStart,
    syncMainComposerCaret,
  }: ComposerDraftCompositionEndHandlerArgs) =>
  () => {
    setIsComposerImeComposing(false);
    const selectionStart = getSelectionStart() ?? getFallbackSelectionStart();
    buildOnDraftSelectHandler({
      setComposerCaret,
      syncMainComposerCaret,
    })(selectionStart);
  };

/** 同じ変換中フラグの更新先を使う、IMEイベント用の開始・終了ハンドラーを組み立てる。 */
export const buildOnDraftCompositionHandlers = (
  args: ComposerDraftCompositionEndHandlerArgs,
) => ({
  onDraftCompositionStart: buildOnDraftCompositionStartHandler({
    setIsComposerImeComposing: args.setIsComposerImeComposing,
  }),
  onDraftCompositionEnd: buildOnDraftCompositionEndHandler(args),
});
