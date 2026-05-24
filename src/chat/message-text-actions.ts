export function formatMarkdownQuote(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return `${normalized.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
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
