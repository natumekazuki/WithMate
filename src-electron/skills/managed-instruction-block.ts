/** 指示文書で WithMate が管理する部分を識別し、見出しと本文を指定する。 */
export type ManagedInstructionBlock = {
  blockId: string;
  title: string;
  content: string;
};

/** マーカーで管理対象を照合する属性名と文字列値の組み合わせ。 */
export type ManagedInstructionBlockMarkerAttributes = Readonly<
  Record<string, string>
>;

const BLOCK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const MARKER_PREFIX = "<!-- WITHMATE:";
const MARKER_SUFFIX = " -->";

/** 本文の定義に、開始・終了マーカーへ付ける任意の照合属性を加えた形式。 */
type ManagedInstructionBlockWithMarkerAttributes = ManagedInstructionBlock & {
  markerAttributes?: ManagedInstructionBlockMarkerAttributes;
};

/** 管理ブロックを、指定の属性を持つ開始・終了マーカーと見出し付き本文に整形する。 */
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

/** 属性なしのマーカーで識別される管理ブロックを置換し、見つからなければ文書の末尾に追加する。 */
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

/** 同じ属性の管理ブロックまたは属性なしの旧形式を置換し、該当箇所がなければ末尾に追加する。 */
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
  const range = findManagedBlockRangeWithMarkerAttributes(
    existingText,
    blockId,
    markerAttributes,
  );

  if (!range) {
    const separator =
      existingText === "" || existingText.endsWith("\n") ? "" : "\n";
    return normalizeTrailingNewline(`${existingText}${separator}${newBlock}`);
  }

  return normalizeTrailingNewline(
    `${existingText.slice(0, range.start)}${newBlock}${existingText.slice(range.end)}`,
  );
}

/** 属性なしのマーカーで囲まれた管理ブロックを削除する。 */
export function removeManagedBlock(
  existingText: string,
  blockId: string,
): string {
  return removeManagedBlockWithMarkerAttributes(existingText, { blockId });
}

/** 照合した管理ブロックだけを削除する。属性付きの対象が見つからなければ書式も変えずに返す。 */
export function removeManagedBlockWithMarkerAttributes(
  existingText: string,
  {
    blockId,
    markerAttributes,
  }: {
    blockId: string;
    markerAttributes?: ManagedInstructionBlockMarkerAttributes;
  },
): string {
  validateBlockId(blockId);
  const range = findManagedBlockRangeWithMarkerAttributes(
    existingText,
    blockId,
    markerAttributes,
  );

  if (!range) {
    return hasMarkerAttributes(markerAttributes)
      ? existingText
      : normalizeTrailingNewline(existingText);
  }

  return normalizeTrailingNewline(
    existingText.slice(0, range.start) + existingText.slice(range.end),
  );
}

/** 指定IDと属性に一致する開始・終了マーカーの対があるか調べる。属性なしの旧形式にはフォールバックしない。 */
export function hasManagedBlockWithMarkerAttributes(
  existingText: string,
  {
    blockId,
    markerAttributes,
  }: {
    blockId: string;
    markerAttributes: ManagedInstructionBlockMarkerAttributes;
  },
): boolean {
  validateBlockId(blockId);
  return (
    findManagedBlockRangeByParsedMarkers(
      existingText,
      blockId,
      markerAttributes,
    ) !== null
  );
}

/** ブロックIDが小文字英数字で始まる64文字以内の小文字英数字・ハイフンでなければ例外を送出する。 */
function validateBlockId(blockId: string): void {
  if (!BLOCK_ID_PATTERN.test(blockId)) {
    throw new Error(`Invalid blockId: ${blockId}`);
  }
}

/** 開始マーカーと、それより後の終了マーカーを含む文字範囲を返す。どちらかがなければ null を返す。 */
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

/** 属性のある呼び出しでは解析済みマーカーを照合し、一致がなければ属性なしの旧形式を探す。 */
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

  const range = findManagedBlockRangeByParsedMarkers(
    existingText,
    blockId,
    markerAttributes,
  );
  if (range) {
    return range;
  }

  const legacyBeginMarker = buildBlockMarker("BEGIN", blockId);
  const legacyEndMarker = buildBlockMarker("END", blockId);
  return findManagedBlockRange(
    existingText,
    legacyBeginMarker,
    legacyEndMarker,
  );
}

/** 属性付きマーカーを組み立てる。属性がなければブロックIDのみを記した旧形式を使う。 */
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

/** マーカー属性を空白区切りのキーと値の組に整形する。 */
function buildBlockMarkerAttributes(
  attributes: ManagedInstructionBlockMarkerAttributes,
): string {
  const keys = Object.keys(attributes);
  if (keys.length === 0) {
    return "";
  }

  const normalizedEntries = keys
    .map((key) => `${key}=${attributes[key]}`)
    .join(" ");
  return normalizedEntries;
}

/** 属性が指定され、列挙可能なキーを1件以上持つかを判定する。 */
function hasMarkerAttributes(
  markerAttributes: ManagedInstructionBlockMarkerAttributes | undefined,
): markerAttributes is ManagedInstructionBlockMarkerAttributes {
  return (
    markerAttributes !== undefined && Object.keys(markerAttributes).length > 0
  );
}

/** 指定属性に一致するマーカーの範囲を返し、旧形式と属性付きの混在や同じ対象の複数範囲など、置換範囲を安全に選べない状態を拒否する。 */
function findManagedBlockRangeByParsedMarkers(
  existingText: string,
  blockId: string,
  markerAttributes: ManagedInstructionBlockMarkerAttributes,
): { start: number; end: number } | null {
  const markers = parseManagedBlockMarkers(existingText);
  const matchedBlockIdMarkers = markers.filter(
    (markerMatch) => markerMatch.marker.blockId === blockId,
  );

  const hasLegacyMarker = matchedBlockIdMarkers.some(
    (markerMatch) => Object.keys(markerMatch.marker.attributes).length === 0,
  );
  const hasAttributeMarker = matchedBlockIdMarkers.some(
    (markerMatch) => Object.keys(markerMatch.marker.attributes).length > 0,
  );
  if (hasLegacyMarker && hasAttributeMarker) {
    throw new Error(
      `marker mismatch: blockId=${blockId} の legacy marker と属性付き marker が混在しています。対象 managed block を特定できません`,
    );
  }

  const expectedProvider = markerAttributes.provider;
  const expectedTarget = markerAttributes.target;
  const expectedMode = markerAttributes.mode;
  const hasProviderTargetMode =
    expectedProvider !== undefined &&
    expectedTarget !== undefined &&
    expectedMode !== undefined;
  const mismatchedModeMarker = hasProviderTargetMode
    ? matchedBlockIdMarkers.find(
        (markerMatch) =>
          markerMatch.marker.attributes.provider === expectedProvider &&
          markerMatch.marker.attributes.target === expectedTarget &&
          markerMatch.marker.attributes.mode !== undefined &&
          markerMatch.marker.attributes.mode !== expectedMode,
      )
    : undefined;
  if (mismatchedModeMarker) {
    throw new Error(
      `marker mismatch: blockId=${blockId} の managed block が provider=${expectedProvider} target=${expectedTarget} ` +
        `で既存 mode=${mismatchedModeMarker.marker.attributes.mode} と期待 mode=${expectedMode} が一致しません`,
    );
  }

  const matchingRanges: { start: number; end: number }[] = [];
  let activeStart = -1;

  for (const markerMatch of matchedBlockIdMarkers) {
    if (
      !isManagedBlockMarkerMatch(markerMatch.marker, blockId, markerAttributes)
    ) {
      continue;
    }

    if (markerMatch.kind === "BEGIN") {
      if (activeStart >= 0) {
        throw new Error(
          `malformed marker: blockId=${blockId} の BEGIN が重複しています`,
        );
      }
      activeStart = markerMatch.index;
      continue;
    }

    if (activeStart < 0) {
      throw new Error(
        `malformed marker: blockId=${blockId} の END だけの marker が見つかりました`,
      );
    }

    matchingRanges.push({
      start: activeStart,
      end: markerMatch.index + markerMatch.length,
    });
    activeStart = -1;

    if (matchingRanges.length > 1) {
      throw new Error(
        `duplicate managed block: blockId=${blockId} が複数存在します`,
      );
    }
  }

  if (activeStart >= 0) {
    throw new Error(
      `malformed marker: blockId=${blockId} の BEGIN に対応する END が見つかりません`,
    );
  }

  return matchingRanges[0] ?? null;
}

/** 認識した開始・終了マーカーと、範囲の特定に使う文字位置・長さ。 */
type ParsedManagedBlockMarker = {
  kind: "BEGIN" | "END";
  marker: {
    blockId: string;
    attributes: Record<string, string>;
  };
  index: number;
  length: number;
};

/** 文書内で構文を解析できたマーカーを出現順に列挙し、元の文書での位置を保持する。 */
function parseManagedBlockMarkers(
  existingText: string,
): ParsedManagedBlockMarker[] {
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

/** 属性なしのIDまたは block 属性付きのキー・値を解釈し、不正なトークンやIDの欠落を null で返す。 */
function parseManagedBlockMarkerBody(
  body: string,
): { blockId: string; attributes: Record<string, string> } | null {
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
    attributes[token.slice(0, separatorIndex)] = token.slice(
      separatorIndex + 1,
    );
  }

  const parsedBlockId = attributes.block;
  if (!parsedBlockId) {
    return null;
  }
  delete attributes.block;
  return { blockId: parsedBlockId, attributes };
}

/** ブロックIDと期待する属性がすべて一致するかを判定する。追加の属性は一致判定を妨げない。 */
function isManagedBlockMarkerMatch(
  marker: { blockId: string; attributes: Record<string, string> },
  blockId: string,
  expectedAttributes: ManagedInstructionBlockMarkerAttributes,
): boolean {
  if (marker.blockId !== blockId) {
    return false;
  }

  return Object.entries(expectedAttributes).every(
    ([key, value]) => marker.attributes[key] === value,
  );
}

/** 空の文書を除き、末尾の改行を LF 1個に統一する。 */
function normalizeTrailingNewline(text: string): string {
  if (text.length === 0) return "";

  const withoutEndNewlines = text.replace(/(\r?\n)+$/g, "");
  return `${withoutEndNewlines}\n`;
}

/** 終了マーカーまでの区切りを付け直せるよう、本文末尾に連続する改行を取り除く。 */
function normalizeTrailingNewlines(content: string): string {
  const withoutEndNewlines = content.replace(/(\r?\n)+$/g, "");
  return withoutEndNewlines;
}

/** 見出しが空でなければ、レベル2の見出し行として本文の前に挿入する文字列を返す。 */
function buildTitleLine(title: string): string {
  return title === "" ? "" : `## ${title}\n`;
}
