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
    return hasMarkerAttributes(markerAttributes) ? existingText : normalizeTrailingNewline(existingText);
  }

  return normalizeTrailingNewline(existingText.slice(0, range.start) + existingText.slice(range.end));
}

export function hasManagedBlockWithMarkerAttributes(
  existingText: string,
  { blockId, markerAttributes }: {
    blockId: string;
    markerAttributes: ManagedInstructionBlockMarkerAttributes;
  },
): boolean {
  validateBlockId(blockId);
  return findManagedBlockRangeByParsedMarkers(existingText, blockId, markerAttributes) !== null;
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
  if (!hasMarkerAttributes(markerAttributes)) {
    const beginMarker = buildBlockMarker("BEGIN", blockId);
    const endMarker = buildBlockMarker("END", blockId);
    return findManagedBlockRange(existingText, beginMarker, endMarker);
  }

  const range = findManagedBlockRangeByParsedMarkers(existingText, blockId, markerAttributes);
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
  if (!hasMarkerAttributes(markerAttributes)) {
    return `${MARKER_PREFIX}${kind} ${blockId}${MARKER_SUFFIX}`;
  }

  const attributes = buildBlockMarkerAttributes(markerAttributes);
  if (!attributes) {
    return `${MARKER_PREFIX}${kind} ${blockId}${MARKER_SUFFIX}`;
  }
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

function hasMarkerAttributes(
  markerAttributes: ManagedInstructionBlockMarkerAttributes | undefined,
): markerAttributes is ManagedInstructionBlockMarkerAttributes {
  return markerAttributes !== undefined && Object.keys(markerAttributes).length > 0;
}

function findManagedBlockRangeByParsedMarkers(
  existingText: string,
  blockId: string,
  markerAttributes: ManagedInstructionBlockMarkerAttributes,
): { start: number; end: number } | null {
  const markers = parseManagedBlockMarkers(existingText);
  const matchedBlockIdMarkers = markers.filter((markerMatch) => markerMatch.marker.blockId === blockId);

  const hasLegacyMarker = matchedBlockIdMarkers.some((markerMatch) => Object.keys(markerMatch.marker.attributes).length === 0);
  const hasAttributeMarker = matchedBlockIdMarkers.some((markerMatch) => Object.keys(markerMatch.marker.attributes).length > 0);
  if (hasLegacyMarker && hasAttributeMarker) {
    throw new Error(`marker mismatch: blockId=${blockId} の legacy marker と属性付き marker が混在しています。対象 managed block を特定できません`);
  }

  const expectedProvider = markerAttributes.provider;
  const expectedTarget = markerAttributes.target;
  const expectedMode = markerAttributes.mode;
  const hasProviderTargetMode = expectedProvider !== undefined && expectedTarget !== undefined && expectedMode !== undefined;
  const mismatchedModeMarker = hasProviderTargetMode
    ? matchedBlockIdMarkers.find((markerMatch) =>
      markerMatch.marker.attributes.provider === expectedProvider
      && markerMatch.marker.attributes.target === expectedTarget
      && markerMatch.marker.attributes.mode !== undefined
      && markerMatch.marker.attributes.mode !== expectedMode
    )
    : undefined;
  if (mismatchedModeMarker) {
    throw new Error(
      `marker mismatch: blockId=${blockId} の managed block が provider=${expectedProvider} target=${expectedTarget} `
      + `で既存 mode=${mismatchedModeMarker.marker.attributes.mode} と期待 mode=${expectedMode} が一致しません`,
    );
  }

  const matchingRanges: { start: number; end: number }[] = [];
  let activeStart = -1;

  for (const markerMatch of matchedBlockIdMarkers) {
    if (!isManagedBlockMarkerMatch(markerMatch.marker, blockId, markerAttributes)) {
      continue;
    }

    if (markerMatch.kind === "BEGIN") {
      if (activeStart >= 0) {
        throw new Error(`malformed marker: blockId=${blockId} の BEGIN が重複しています`);
      }
      activeStart = markerMatch.index;
      continue;
    }

    if (activeStart < 0) {
      throw new Error(`malformed marker: blockId=${blockId} の END だけの marker が見つかりました`);
    }

    matchingRanges.push({ start: activeStart, end: markerMatch.index + markerMatch.length });
    activeStart = -1;

    if (matchingRanges.length > 1) {
      throw new Error(`duplicate managed block: blockId=${blockId} が複数存在します`);
    }
  }

  if (activeStart >= 0) {
    throw new Error(`malformed marker: blockId=${blockId} の BEGIN に対応する END が見つかりません`);
  }

  return matchingRanges[0] ?? null;
}

type ParsedManagedBlockMarker = {
  kind: "BEGIN" | "END";
  marker: {
    blockId: string;
    attributes: Record<string, string>;
  };
  index: number;
  length: number;
};

function parseManagedBlockMarkers(existingText: string): ParsedManagedBlockMarker[] {
  const markerPattern = /<!-- WITHMATE:(BEGIN|END) ([^>]*?) -->/g;
  const markerMatches: ParsedManagedBlockMarker[] = [];
  let markerMatch: RegExpExecArray | null;

  while ((markerMatch = markerPattern.exec(existingText)) !== null) {
    const parsedMarker = parseManagedBlockMarkerBody(markerMatch[2] ?? "");
    if (!parsedMarker) {
      continue;
    }

    const markerKind = markerMatch[1] === "BEGIN" ? "BEGIN" : "END";
    markerMatches.push({
      kind: markerKind,
      marker: parsedMarker,
      index: markerMatch.index,
      length: markerMatch[0].length,
    });
  }

  return markerMatches;
}

function parseManagedBlockMarkerBody(body: string): { blockId: string; attributes: Record<string, string> } | null {
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && !tokens[0].includes("=")) {
    return { blockId: tokens[0], attributes: {} };
  }

  const attributes: Record<string, string> = {};
  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
      return null;
    }
    attributes[token.slice(0, separatorIndex)] = token.slice(separatorIndex + 1);
  }

  const parsedBlockId = attributes.block;
  if (!parsedBlockId) {
    return null;
  }
  delete attributes.block;
  return { blockId: parsedBlockId, attributes };
}

function isManagedBlockMarkerMatch(
  marker: { blockId: string; attributes: Record<string, string> },
  blockId: string,
  expectedAttributes: ManagedInstructionBlockMarkerAttributes,
): boolean {
  if (marker.blockId !== blockId) {
    return false;
  }

  return Object.entries(expectedAttributes).every(([key, value]) => marker.attributes[key] === value);
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
