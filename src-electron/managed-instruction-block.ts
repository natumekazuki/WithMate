export type ManagedInstructionBlock = {
  blockId: string;
  title: string;
  content: string;
};

export type ManagedInstructionBlockMarkerAttributes = Readonly<Record<string, string>>;

const BLOCK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const MARKER_PREFIX = "<!-- WITHMATE:";
const MARKER_SUFFIX = " -->";

type ManagedInstructionBlockWithMarkerAttributes = ManagedInstructionBlock & {
  markerAttributes?: ManagedInstructionBlockMarkerAttributes;
};

export function buildManagedBlock({
  blockId,
  title,
  content,
  markerAttributes,
}: ManagedInstructionBlockWithMarkerAttributes): string {
  validateBlockId(blockId);

  const beginMarker = buildBlockMarker("BEGIN", blockId, markerAttributes);
  const endMarker = buildBlockMarker("END", blockId, markerAttributes);
  const body = `${buildTitleLine(title)}${normalizeTrailingNewlines(content)}`;

  return `${beginMarker}\n${body}\n${endMarker}`;
}

export function upsertManagedBlock(
  existingText: string,
  { blockId, title, content }: ManagedInstructionBlock,
): string {
  return upsertManagedBlockWithMarkerAttributes(existingText, {
    blockId,
    title,
    content,
  });
}

export function upsertManagedBlockWithMarkerAttributes(
  existingText: string,
  block: ManagedInstructionBlockWithMarkerAttributes,
): string {
  const { blockId, title, content, markerAttributes } = block;
  validateBlockId(blockId);
  const newBlock = buildManagedBlock({
    blockId,
    title,
    content,
    markerAttributes,
  });
  const range = findManagedBlockRangeWithMarkerAttributes(existingText, blockId, markerAttributes);

  if (!range) {
    const separator = existingText === "" || existingText.endsWith("\n") ? "" : "\n";
    return normalizeTrailingNewline(`${existingText}${separator}${newBlock}`);
  }

  return normalizeTrailingNewline(`${existingText.slice(0, range.start)}${newBlock}${existingText.slice(range.end)}`);
}

export function removeManagedBlock(existingText: string, blockId: string): string {
  return removeManagedBlockWithMarkerAttributes(existingText, { blockId });
}

export function removeManagedBlockWithMarkerAttributes(
  existingText: string,
  { blockId, markerAttributes }: {
    blockId: string;
    markerAttributes?: ManagedInstructionBlockMarkerAttributes;
  },
): string {
  validateBlockId(blockId);
  const range = findManagedBlockRangeWithMarkerAttributes(existingText, blockId, markerAttributes);

  if (!range) {
    return existingText;
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

function findManagedBlockRangeWithMarkerAttributes(
  existingText: string,
  blockId: string,
  markerAttributes?: ManagedInstructionBlockMarkerAttributes,
): { start: number; end: number } | null {
  if (markerAttributes === undefined) {
    const beginMarker = buildBlockMarker("BEGIN", blockId);
    const endMarker = buildBlockMarker("END", blockId);
    return findManagedBlockRange(existingText, beginMarker, endMarker);
  }

  const targetBeginMarker = buildBlockMarker("BEGIN", blockId, markerAttributes);
  const targetEndMarker = buildBlockMarker("END", blockId, markerAttributes);
  const range = findManagedBlockRange(existingText, targetBeginMarker, targetEndMarker);
  if (range) {
    return range;
  }

  const legacyBeginMarker = buildBlockMarker("BEGIN", blockId);
  const legacyEndMarker = buildBlockMarker("END", blockId);
  return findManagedBlockRange(existingText, legacyBeginMarker, legacyEndMarker);
}

function buildBlockMarker(
  kind: "BEGIN" | "END",
  blockId: string,
  markerAttributes?: ManagedInstructionBlockMarkerAttributes,
): string {
  if (!markerAttributes) {
    return `${MARKER_PREFIX}${kind} ${blockId}${MARKER_SUFFIX}`;
  }

  const attributes = buildBlockMarkerAttributes(markerAttributes);
  return `${MARKER_PREFIX}${kind} ${attributes} block=${blockId}${MARKER_SUFFIX}`;
}

function buildBlockMarkerAttributes(attributes: ManagedInstructionBlockMarkerAttributes): string {
  const keys = Object.keys(attributes);
  if (keys.length === 0) {
    return "";
  }

  const normalizedEntries = keys.map((key) => `${key}=${attributes[key]}`).join(" ");
  return normalizedEntries;
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
