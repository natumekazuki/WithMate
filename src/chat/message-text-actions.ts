export function normalizeMessageTextForCopy(text: string): string {
  return text.trim();
}

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

export function formatMarkdownQuote(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return `${normalized.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
}

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

export function insertComposerTextAtCaret(
  draft: string,
  text: string,
  caret: number,
): { draft: string; caret: number } {
  return insertComposerTextAtSelection(draft, text, caret, caret);
}

export function insertComposerTextAtSelection(
  draft: string,
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { draft: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, draft.length));
  const end = Math.max(start, Math.min(Math.max(selectionStart, selectionEnd), draft.length));
  const needsLeadingBreak = start > 0 && !draft.slice(0, start).endsWith("\n");
  const needsTrailingBreak = draft.length > end && !draft.slice(end).startsWith("\n");
  const insertion = `${needsLeadingBreak ? "\n\n" : ""}${text}${needsTrailingBreak ? "\n" : ""}`;
  return {
    draft: `${draft.slice(0, start)}${insertion}${draft.slice(end)}`,
    caret: start + insertion.length,
  };
}
