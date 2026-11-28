/** コピー対象の前後だけ空白を除き、本文内の改行や空白は保つ。 */
export function normalizeMessageTextForCopy(text: string): string {
  return text.trim();
}

/** 空白だけの本文は書き込まず false を返す。書き込み失敗は呼び出し側へ伝える。 */
export async function copyMessageTextToClipboard(
  text: string,
  writeText: (text: string) => Promise<void>,
): Promise<boolean> {
  const normalized = normalizeMessageTextForCopy(text);
  if (!normalized) {
    return false;
  }

  await writeText(normalized);
  return true;
}

/** 書き込みで例外が発生したら通知用コールバックに渡し、コピー未完了を返す。 */
export async function copyMessageTextToClipboardWithFailureHandler(input: {
  onFailure: (error: unknown) => void;
  text: string;
  writeText: (text: string) => Promise<void>;
}): Promise<boolean> {
  try {
    return await copyMessageTextToClipboard(input.text, input.writeText);
  } catch (error) {
    input.onFailure(error);
    return false;
  }
}

/** UI の操作からコピーを非同期で開始し、失敗時の通知を登録した処理に委ねる。 */
export function createCopyMessageTextHandler(input: {
  onFailure: (error: unknown) => void;
  writeText: (text: string) => Promise<void>;
}): (text: string) => void {
  return (text) => {
    void copyMessageTextToClipboardWithFailureHandler({
      text,
      writeText: input.writeText,
      onFailure: input.onFailure,
    });
  };
}

/** 改行を LF に統一して各行を Markdown の引用にし、後続の段落用に空行を空ける。 */
export function formatMarkdownQuote(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return `${normalized
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
}

/** 空でない引用を下書きのキャレット位置に追加し、新しいキャレット位置を返す。 */
export function createQuotedMessageInsertion(
  messageText: string,
  draft: string,
  caret: number,
): { draft: string; caret: number } | null {
  const quote = formatMarkdownQuote(messageText);
  if (!quote) {
    return null;
  }

  return insertComposerTextAtCaret(draft, quote, caret);
}

/** Composer の選択開始位置を挿入先とし、テキスト欄がなければ保存した位置を使う。 */
export function createQuotedMessageInsertionFromComposer(input: {
  draft: string;
  fallbackCaret: number;
  messageText: string;
  textarea: Pick<HTMLTextAreaElement, "selectionStart"> | null;
}): { draft: string; caret: number } | null {
  return createQuotedMessageInsertion(
    input.messageText,
    input.draft,
    input.textarea?.selectionStart ?? input.fallbackCaret,
  );
}

/** 選択範囲を置換せず、指定したキャレット位置へテキストを追加する。 */
export function insertComposerTextAtCaret(
  draft: string,
  text: string,
  caret: number,
): { draft: string; caret: number } {
  return insertComposerTextAtSelection(draft, text, caret, caret);
}

/** 下書き内に補正した選択範囲を置換し、周囲との境界に必要な改行と挿入後の位置を返す。 */
export function insertComposerTextAtSelection(
  draft: string,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { draft: string; caret: number } {
  const start = Math.max(
    0,
    Math.min(selectionStart, selectionEnd, draft.length),
  );
  const end = Math.max(
    start,
    Math.min(Math.max(selectionStart, selectionEnd), draft.length),
  );
  const needsLeadingBreak = start > 0 && !draft.slice(0, start).endsWith("\n");
  const needsTrailingBreak =
    draft.length > end && !draft.slice(end).startsWith("\n");
  const insertion = `${needsLeadingBreak ? "\n\n" : ""}${text}${needsTrailingBreak ? "\n" : ""}`;
  return {
    draft: `${draft.slice(0, start)}${insertion}${draft.slice(end)}`,
    caret: start + insertion.length,
  };
}
