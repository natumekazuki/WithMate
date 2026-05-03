export type ManagedInstructionBlock = {
  blockId: string;
  title: string;
  content: string;
};

const BLOCK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const MARKER_PREFIX = "<!-- WITHMATE:";
const MARKER_SUFFIX = " -->";

export function buildManagedBlock({ blockId, title, content }: ManagedInstructionBlock): string {
  validateBlockId(blockId);

  const beginMarker = `${MARKER_PREFIX}BEGIN ${blockId}${MARKER_SUFFIX}`;
  const endMarker = `${MARKER_PREFIX}END ${blockId}${MARKER_SUFFIX}`;
  const body = `${buildTitleLine(title)}${normalizeTrailingNewlines(content)}`;

  return `${beginMarker}\n${body}\n${endMarker}`;
}

export function upsertManagedBlock(
  existingText: string,
  { blockId, title, content }: ManagedInstructionBlock,
): string {
  validateBlockId(blockId);
  const beginMarker = `${MARKER_PREFIX}BEGIN ${blockId}${MARKER_SUFFIX}`;
  const endMarker = `${MARKER_PREFIX}END ${blockId}${MARKER_SUFFIX}`;
  const newBlock = buildManagedBlock({ blockId, title, content });
  const range = findManagedBlockRange(existingText, beginMarker, endMarker);

  if (!range) {
    const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
    return normalizeTrailingNewline(`${existingText}${separator}${newBlock}`);
  }

  return normalizeTrailingNewline(`${existingText.slice(0, range.start)}${newBlock}${existingText.slice(range.end)}`);
}

export function removeManagedBlock(existingText: string, blockId: string): string {
  validateBlockId(blockId);
  const beginMarker = `${MARKER_PREFIX}BEGIN ${blockId}${MARKER_SUFFIX}`;
  const endMarker = `${MARKER_PREFIX}END ${blockId}${MARKER_SUFFIX}`;
  const range = findManagedBlockRange(existingText, beginMarker, endMarker);

  if (!range) {
    return normalizeTrailingNewline(existingText);
  }

  return normalizeTrailingNewline(existingText.slice(0, range.start) + existingText.slice(range.end));
}

function validateBlockId(blockId: string): void {
  if (!BLOCK_ID_PATTERN.test(blockId)) {
    throw new Error(`Invalid blockId: ${blockId}`);
  }
}

function findManagedBlockRange(
  existingText: string,
  beginMarker: string,
  endMarker: string,
): { start: number; end: number } | null {
  const start = existingText.indexOf(beginMarker);
  if (start < 0) return null;

  const end = existingText.indexOf(endMarker, start + beginMarker.length);
  if (end < 0) return null;

  return { start, end: end + endMarker.length };
}

function normalizeTrailingNewline(text: string): string {
  if (text.length === 0) return "";

  const withoutEndNewlines = text.replace(/(\r?\n)+$/g, "");
  return `${withoutEndNewlines}\n`;
}

function normalizeTrailingNewlines(content: string): string {
  const withoutEndNewlines = content.replace(/(\r?\n)+$/g, "");
  return withoutEndNewlines;
}

function buildTitleLine(title: string): string {
  return title === "" ? "" : `## ${title}\n`;
}
