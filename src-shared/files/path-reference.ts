import { extractLocalMarkdownImagePaths } from "./composer-image-reference.js";
import type { ComposerAttachmentInput } from "../session/runtime-state.js";

/** 行頭、空白または開き括弧に続く@から、引用符付きまたは単一語のパス候補を拾う。 */
export const TEXT_PATH_REFERENCE_PATTERN =
  /(^|[\s(])@(?:"([^"\r\n]+)"|([^\s@]+))/gm;
/** 表示用の状態比較で、候補パスを出現順につなぐ区切り文字。 */
export const TEXT_PATH_REFERENCE_SIGNATURE_SEPARATOR = "\u001f";

/** 本文の@パス候補と、候補の有無・順序を表示側で比較するための状態。 */
export type TextReferenceCandidateState = {
  candidates: string[];
  hasCandidates: boolean;
  signature: string;
};

/** 本文から@パス候補を出現順に読み、外側の引用符と前後の空白を除く。 */
export function extractTextReferenceCandidates(text: string): string[] {
  const candidates: string[] = [];
  const expression = new RegExp(TEXT_PATH_REFERENCE_PATTERN);

  for (const match of text.matchAll(expression)) {
    const quotedPath = match[2];
    const plainPath = match[3];
    const candidatePath = quotedPath ?? plainPath ?? "";
    if (candidatePath.trim()) {
      candidates.push(candidatePath.trim());
    }
  }

  return candidates;
}

/** 本文の@パスとローカル画像を添付候補にし、入力元の違いを保持する。 */
export function extractComposerAttachmentReferenceCandidates(
  text: string,
): ComposerAttachmentInput[] {
  return [
    ...extractTextReferenceCandidates(text).map(
      (path): ComposerAttachmentInput => ({
        path,
        source: "text",
      }),
    ),
    ...extractLocalMarkdownImagePaths(text).map(
      (path): ComposerAttachmentInput => ({
        kind: "image",
        path,
        source: "markdown-image",
      }),
    ),
  ];
}

/** 候補列と有無を求め、同じ順序での比較に使う文字列表現を添える。 */
export function buildTextReferenceCandidateState(
  text: string,
): TextReferenceCandidateState {
  const candidates = extractTextReferenceCandidates(text);
  return {
    candidates,
    hasCandidates: candidates.length > 0,
    signature: candidates.join(TEXT_PATH_REFERENCE_SIGNATURE_SEPARATOR),
  };
}
