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
  const currentCaret = Math.max(0, Math.min(caret, draft.length));
  const needsLeadingBreak = currentCaret > 0 && !draft.slice(0, currentCaret).endsWith("\n");
  const needsTrailingBreak = draft.length > currentCaret && !draft.slice(currentCaret).startsWith("\n");
  const insertion = `${needsLeadingBreak ? "\n\n" : ""}${text}${needsTrailingBreak ? "\n" : ""}`;
  return {
    draft: `${draft.slice(0, currentCaret)}${insertion}${draft.slice(currentCaret)}`,
    caret: currentCaret + insertion.length,
  };
}
