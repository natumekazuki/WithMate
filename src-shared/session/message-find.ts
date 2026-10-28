import { fromMarkdown } from "mdast-util-from-markdown";
import { isMap, isScalar, parseDocument } from "yaml";
import { iterateTextMatches, type TextSearchMatch } from "../text/find-text-matches.js";
import { projectMessageRenderedSearchText, type MessageRenderedSearchPart } from "./message-search.js";

type SourceRun = { renderedStart: number; renderedEnd: number; sourceStart: number; sourceEnd: number };
export type MessageSearchProjection = { sourceText: string; renderedText: string; sourceRuns: SourceRun[] };
export type MessageSearchMatch = TextSearchMatch & { kind: "rendered" | "source"; renderedOccurrenceIndex?: number };

function decodedMarkdownToken(token: string): string {
  const tree = fromMarkdown(token);
  const paragraph = tree.children[0];
  return paragraph?.type === "paragraph" ? paragraph.children.map((node) => "value" in node ? node.value : "").join("") : token;
}

/** Record only characters actually supplied by a source token, never its hidden syntax. */
function mapTokens(raw: string, value: string, start: number, renderedStart: number, runs: SourceRun[], kind: "text" | "literal" | "yaml" | "yaml-single" | "json" | "citation" | "citation-windows" = "literal"): boolean {
  const tokenPattern = kind === "text"
    ? /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]+);|\r\n?/gu
    : kind === "yaml" || kind === "json" ? /\\(?:U[\da-fA-F]{8}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)|\r\n?/gu
    : kind === "yaml-single" ? /''|\r\n?/gu
    : kind === "citation-windows" ? /\\[\\"]/gu
    : kind === "citation" ? /\\"/gu : /\r\n?/gu;
  let rawOffset = 0;
  let valueOffset = 0;
  let valid = true;
  const mapped: SourceRun[] = [];
  const append = (text: string, sourceOffset: number, sourceLength: number) => {
    if (!text) return;
    if (value.slice(valueOffset, valueOffset + text.length) !== text) valid = false;
    mapped.push({ renderedStart: renderedStart + valueOffset, renderedEnd: renderedStart + valueOffset + text.length,
      sourceStart: start + sourceOffset, sourceEnd: start + sourceOffset + sourceLength });
    valueOffset += text.length;
  };
  for (const match of raw.matchAll(tokenPattern)) {
    append(raw.slice(rawOffset, match.index), rawOffset, match.index - rawOffset);
    const token = match[0];
    const decoded = /^\r/u.test(token) ? "\n" : kind === "text" ? decodedMarkdownToken(token)
      : kind === "yaml-single" ? "'"
      : kind === "yaml" ? String(parseDocument(`"${token}"`).toJSON() ?? token)
      : kind === "json" ? JSON.parse(`"${token}"`) as string
      : kind === "citation" || kind === "citation-windows" ? token.slice(1) : token;
    append(decoded, match.index, token.length);
    rawOffset = match.index + token.length;
  }
  append(raw.slice(rawOffset), rawOffset, raw.length - rawOffset);
  if (valid && valueOffset === value.length) {
    for (const run of mapped) runs.push(run);
    return true;
  }
  return false;
}

function mapText(raw: string, value: string, start: number, renderedStart: number, runs: SourceRun[], kind: "text" | "literal" = "text"): void {
  const rawLines = raw.split(/\r\n|\r|\n/u);
  const valueLines = value.split(/\r\n|\r|\n/u);
  if (rawLines.length !== valueLines.length) return;
  let sourceOffset = start;
  let valueOffset = renderedStart;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const text = valueLines[index];
    const prefixLength = index === 0 ? 0 : /^[\t >]*/u.exec(line)![0].length;
    for (let prefix = 0; prefix <= prefixLength; prefix += 1) {
      const content = line.slice(prefix);
      if (mapTokens(content, text, sourceOffset + prefix, valueOffset, runs, kind)) break;
      const trimmed = index < rawLines.length - 1 && kind === "text" ? content.replace(/[ \t]+$/u, "") : content;
      if (trimmed !== content && mapTokens(trimmed, text, sourceOffset + prefix, valueOffset, runs, kind)) break;
    }
    const newlineLength = raw[sourceOffset - start + line.length] === "\r" && raw[sourceOffset - start + line.length + 1] === "\n" ? 2 : 1;
    const valueNewlineLength = value[valueOffset - renderedStart + text.length] === "\r" && value[valueOffset - renderedStart + text.length + 1] === "\n" ? 2 : 1;
    if (index < rawLines.length - 1) runs.push({ renderedStart: valueOffset + text.length, renderedEnd: valueOffset + text.length + valueNewlineLength,
      sourceStart: sourceOffset + line.length, sourceEnd: sourceOffset + line.length + newlineLength });
    sourceOffset += line.length + newlineLength;
    valueOffset += text.length + valueNewlineLength;
  }
}

function mapPart(part: MessageRenderedSearchPart, source: string, renderedStart: number, runs: SourceRun[]): void {
  if (part.sourceStart < 0) return;
  const raw = source.slice(part.sourceStart, part.sourceEnd);
  if (part.type === "reference") {
    const pathTokens = raw.startsWith("visualize")
      ? [...raw.matchAll(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*")/gu)].filter((match) => JSON.parse(match[1]) === "path")
      : [...raw.matchAll(/\bpath=("(?:\\.|[^"\\])*")/gu)];
    const match = pathTokens.at(-1);
    const token = match?.[2] ?? match?.[1];
    if (!match || !token) return;
    const tokenStart = raw.indexOf(token, match.index) + 1;
    const content = token.slice(1, -1);
    const visualize = raw.startsWith("visualize");
    const path = visualize ? JSON.parse(token) as string : part.text;
    const mapped: SourceRun[] = [];
    const citationKind = /^[a-z]:\\\\/iu.test(content) || /^\\\\\\\\/u.test(content) ? "citation-windows" : "citation";
    mapTokens(content, path, part.sourceStart + tokenStart, 0, mapped, visualize ? "json" : citationKind);
    const labelOffset = path.lastIndexOf(part.text);
    const labelRuns: SourceRun[] = [];
    if (labelOffset >= 0) labelRuns.push({ renderedStart: 0, renderedEnd: part.text.length, sourceStart: labelOffset, sourceEnd: labelOffset + part.text.length });
    else if (/^file:/iu.test(path)) {
      const pathname = new URL(path).pathname;
      const encoded = pathname.slice(pathname.lastIndexOf("/") + 1);
      const encodedStart = path.indexOf(pathname) + pathname.length - encoded.length;
      let offset = 0;
      let label = "";
      for (const token of encoded.matchAll(/(?:%[\da-fA-F]{2})+|[^%]+|%/gu)) {
        const decoded = decodeURIComponent(token[0]);
        labelRuns.push({ renderedStart: offset, renderedEnd: offset + decoded.length,
          sourceStart: encodedStart + token.index, sourceEnd: encodedStart + token.index + token[0].length });
        offset += decoded.length;
        label += decoded;
      }
      if (label !== part.text) return;
    }
    for (const labelRun of labelRuns) {
      for (const run of mapped) {
        const begin = Math.max(labelRun.sourceStart, run.renderedStart);
        const end = Math.min(labelRun.sourceEnd, run.renderedEnd);
        if (begin >= end) continue;
        const literal = run.renderedEnd - run.renderedStart === run.sourceEnd - run.sourceStart;
        const labelLiteral = labelRun.renderedEnd - labelRun.renderedStart === labelRun.sourceEnd - labelRun.sourceStart;
        runs.push({ renderedStart: renderedStart + labelRun.renderedStart + (labelLiteral ? begin - labelRun.sourceStart : 0),
          renderedEnd: renderedStart + labelRun.renderedEnd - (labelLiteral ? labelRun.sourceEnd - end : 0),
          sourceStart: literal ? run.sourceStart + begin - run.renderedStart : run.sourceStart,
          sourceEnd: literal ? run.sourceEnd - (run.renderedEnd - end) : run.sourceEnd });
      }
    }
    return;
  }
  if (part.type === "yaml") {
    const initialLength = runs.length;
    const contentStart = raw.indexOf("\n") + 1;
    const content = raw.slice(contentStart).replace(/(?:\r?\n)?(?:---|\.\.\.)\s*$/u, "");
    const document = parseDocument(content);
    if (isMap(document.contents) && document.errors.length === 0 && document.warnings.length === 0) {
      let offset = 0;
      for (const pair of document.contents.items) {
        for (const scalar of [pair.key, pair.value]) {
          if (!isScalar(scalar) || !scalar.range) continue;
          const text = scalar.toString();
          let scalarRaw = content.slice(scalar.range[0], scalar.range[1]);
          let scalarStart = part.sourceStart + contentStart + scalar.range[0];
          const scalarKind = scalarRaw.startsWith("'") ? "yaml-single" : scalarRaw.startsWith('"') ? "yaml" : "literal";
          if (/^["']/u.test(scalarRaw)) { scalarRaw = scalarRaw.slice(1, -1); scalarStart += 1; }
          mapTokens(scalarRaw, text, scalarStart, renderedStart + offset, runs, scalarKind);
          offset += text.length;
        }
      }
      if (offset === part.text.length) return;
      runs.length = initialLength;
    }
  }
  if (part.type === "text" && raw === part.text) {
    runs.push({ renderedStart, renderedEnd: renderedStart + raw.length, sourceStart: part.sourceStart, sourceEnd: part.sourceEnd });
  } else if (part.type === "text") {
    mapText(raw, part.text, part.sourceStart, renderedStart, runs);
  } else if (part.type === "inlineCode") {
    const delimiter = /^`+/u.exec(raw)?.[0].length ?? 0;
    let content = raw.slice(delimiter, -delimiter);
    let start = part.sourceStart + delimiter;
    if (content.startsWith(" ") && content.endsWith(" ") && /[^ ]/u.test(content)) { content = content.slice(1, -1); start += 1; }
    mapText(content, part.text, start, renderedStart, runs, "literal");
  } else if (part.type === "code") {
    const lines = raw.split(/\r\n|\r|\n/u);
    let sourceOffset = part.sourceStart;
    let valueOffset = 0;
    if (/^\s*(?:`{3,}|~{3,})/u.test(lines[0])) {
      const opening = lines.shift()!;
      sourceOffset += opening.length + (source[sourceOffset + opening.length] === "\r" && source[sourceOffset + opening.length + 1] === "\n" ? 2 : 1);
    }
    const values = part.text.split("\n");
    for (let index = 0; index < values.length; index += 1) {
      const line = lines[index] ?? "";
      const text = values[index];
      const indentation = line.length - text.length;
      if (indentation >= 0 && line.endsWith(text)) mapTokens(text, text, sourceOffset + indentation, renderedStart + valueOffset, runs);
      const newlineLength = source[sourceOffset + line.length] === "\r" && source[sourceOffset + line.length + 1] === "\n" ? 2 : 1;
      if (index < values.length - 1) runs.push({ renderedStart: renderedStart + valueOffset + text.length, renderedEnd: renderedStart + valueOffset + text.length + 1,
        sourceStart: sourceOffset + line.length, sourceEnd: sourceOffset + line.length + newlineLength });
      sourceOffset += line.length + newlineLength;
      valueOffset += text.length + 1;
    }
  } else {
    const offset = raw.indexOf(part.text);
    if (offset >= 0) mapTokens(part.text, part.text, part.sourceStart + offset, renderedStart, runs);
    else mapTokens(raw, part.text, part.sourceStart, renderedStart, runs);
  }
}

export function createMessageSearchProjection(sourceText: string, responseProvider?: string, mode: "preview" | "source" = "preview"): MessageSearchProjection {
  if (mode === "source") return { sourceText, renderedText: "", sourceRuns: [] };
  const parts: MessageRenderedSearchPart[] = [];
  const renderedText = projectMessageRenderedSearchText(sourceText, responseProvider, parts);
  const sourceRuns: SourceRun[] = [];
  let renderedStart = 0;
  for (const part of parts) { mapPart(part, sourceText, renderedStart, sourceRuns); renderedStart += part.text.length; }
  return { sourceText, renderedText, sourceRuns };
}

export function* iterateMessageSearchMatches(projection: MessageSearchProjection, query: string, mode: "preview" | "source"): Generator<MessageSearchMatch> {
  if (mode === "source") {
    for (const match of iterateTextMatches(projection.sourceText, query)) yield { ...match, kind: "source" };
    return;
  }
  // One bit per source code unit keeps exclusion storage bounded even for millions of matches.
  const covered = new Uint8Array(Math.ceil(projection.sourceText.length / 8));
  let runIndex = 0;
  let renderedOccurrenceIndex = 0;
  for (const match of iterateTextMatches(projection.renderedText, query)) {
    while (runIndex < projection.sourceRuns.length && projection.sourceRuns[runIndex].renderedEnd <= match.startOffset) runIndex += 1;
    for (let index = runIndex; index < projection.sourceRuns.length; index += 1) {
      const run = projection.sourceRuns[index];
      if (run.renderedStart >= match.endOffset) break;
      const literal = run.renderedEnd - run.renderedStart === run.sourceEnd - run.sourceStart;
      const start = literal ? run.sourceStart + Math.max(0, match.startOffset - run.renderedStart) : run.sourceStart;
      const end = literal ? run.sourceEnd - Math.max(0, run.renderedEnd - match.endOffset) : run.sourceEnd;
      for (let offset = start; offset < end; offset += 1) covered[offset >>> 3] |= 1 << (offset & 7);
    }
    yield { ...match, kind: "rendered", renderedOccurrenceIndex: renderedOccurrenceIndex++ };
  }
  for (const match of iterateTextMatches(projection.sourceText, query)) {
    let duplicate = true;
    for (let offset = match.startOffset; offset < match.endOffset; offset += 1) {
      if (!(covered[offset >>> 3] & (1 << (offset & 7)))) { duplicate = false; break; }
    }
    if (!duplicate) yield { ...match, kind: "source" };
  }
}
