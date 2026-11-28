import { gfmFromMarkdown } from "mdast-util-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";

import { projectMarkdownFrontmatterText } from "../text/markdown-frontmatter.js";
import { providerResponseMarkdownExtensions } from "../text/provider-response-markdown.js";

/** 描画用の検索文字列を再現する際に参照する構文ノードの項目。 */
type MarkdownSearchNode = {
  type: string;
  value?: string;
  lang?: string | null;
  identifier?: string;
  children?: MarkdownSearchNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** 描画文字列の断片と、その元になった原文位置および表現の種別。 */
export type MessageRenderedSearchPart = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  type: string;
};

/** テキストとして描画する構文だけを取り出し、要求があれば原文の位置も断片ごとに記録する。 */
function projectNodeText(
  node: MarkdownSearchNode,
  parts?: MessageRenderedSearchPart[],
  parent?: MarkdownSearchNode,
): string {
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "code" ||
    node.type === "yaml"
  ) {
    if (
      node.type === "code" &&
      (node.lang?.toLocaleLowerCase() === "mermaid" || node.lang === "math")
    ) {
      return "";
    }
    const value =
      node.type === "yaml"
        ? projectMarkdownFrontmatterText(node.value ?? "")
        : (node.value ?? "");
    const text = node.type === "text" || value.trim() ? value : "";
    if (text && parts) {
      const position = node.position ?? parent?.position;
      parts.push({
        text,
        sourceStart: position?.start.offset ?? -1,
        sourceEnd: position?.end.offset ?? -1,
        type: node.type === "text" && !node.position ? "reference" : node.type,
      });
    }
    return text;
  }
  if (node.type === "break") {
    return "";
  }
  if (node.type === "html") {
    const text = node.value ?? "";
    if (/^<br[ \t]*\/?>(?=$)/iu.test(text)) return "";
    if (text && parts)
      parts.push({
        text,
        sourceStart: node.position?.start.offset ?? -1,
        sourceEnd: node.position?.end.offset ?? -1,
        type: node.type,
      });
    return text;
  }
  if (
    node.type === "image" ||
    node.type === "imageReference" ||
    node.type === "definition" ||
    node.type === "inlineMath" ||
    node.type === "math" ||
    node.type === "footnoteDefinition" ||
    node.type === "footnoteReference"
  ) {
    return "";
  }
  return (
    node.children
      ?.map((child) => projectNodeText(child, parts, node))
      .join("") ?? ""
  );
}

/** 脚注の定義と参照を文字の大小に依存せず照合するためにIDを大文字にする。 */
function normalizeFootnoteIdentifier(identifier: string): string {
  return identifier.toUpperCase();
}

/** 脚注の定義をツリーから再帰的に集め、同じIDは最初の定義を保持する。 */
function collectFootnoteDefinitions(
  node: MarkdownSearchNode,
  definitions: Map<string, MarkdownSearchNode>,
): void {
  if (node.type === "footnoteDefinition" && node.identifier) {
    const identifier = normalizeFootnoteIdentifier(node.identifier);
    if (!definitions.has(identifier)) {
      definitions.set(identifier, node);
    }
  }
  node.children?.forEach((child) =>
    collectFootnoteDefinitions(child, definitions),
  );
}

/** 脚注への参照を出現順に集め、本文だけを見る場合は定義内を走査しない。 */
function collectFootnoteReferences(
  node: MarkdownSearchNode,
  references: string[],
  skipDefinitions: boolean,
): void {
  if (skipDefinitions && node.type === "footnoteDefinition") {
    return;
  }
  if (node.type === "footnoteReference" && node.identifier) {
    references.push(normalizeFootnoteIdentifier(node.identifier));
    return;
  }
  node.children?.forEach((child) =>
    collectFootnoteReferences(child, references, skipDefinitions),
  );
}

/** 定義末尾が段落のテキストなら、戻りリンク前に生じる空白も検索用に再現する。 */
function hasSearchableFootnoteBackreferenceGap(
  definition: MarkdownSearchNode,
): boolean {
  const tail = definition.children?.at(-1);
  return tail?.type === "paragraph" && tail.children?.at(-1)?.type === "text";
}

/** ProviderごとのMarkdown表現を解析し、本文と、参照された脚注を参照順に検索用へ連結する。 */
export function projectMessageRenderedSearchText(
  markdown: string,
  responseProvider?: string,
  parts?: MessageRenderedSearchPart[],
): string {
  const providerExtensions =
    providerResponseMarkdownExtensions(responseProvider);
  const tree = fromMarkdown(markdown, {
    extensions: [
      frontmatter(),
      gfm(),
      math({ singleDollarTextMath: false }),
      ...providerExtensions.extensions,
    ],
    mdastExtensions: [
      frontmatterFromMarkdown(),
      gfmFromMarkdown(),
      mathFromMarkdown(),
      ...providerExtensions.mdastExtensions,
    ],
  });
  const root = tree as MarkdownSearchNode;
  const definitions = new Map<string, MarkdownSearchNode>();
  const referenceOrder: string[] = [];
  const queuedReferences = new Set<string>();
  collectFootnoteDefinitions(root, definitions);
  const bodyReferences: string[] = [];
  collectFootnoteReferences(root, bodyReferences, true);
  for (const identifier of bodyReferences) {
    if (!queuedReferences.has(identifier)) {
      queuedReferences.add(identifier);
      referenceOrder.push(identifier);
    }
  }
  const bodyText = projectNodeText(root, parts);
  const footnoteParts: string[] = [];
  for (let index = 0; index < referenceOrder.length; index += 1) {
    const identifier = referenceOrder[index];
    const definition = definitions.get(identifier);
    if (!definition) {
      continue;
    }
    const nestedReferences: string[] = [];
    collectFootnoteReferences(definition, nestedReferences, false);
    for (const nestedIdentifier of nestedReferences) {
      if (!queuedReferences.has(nestedIdentifier)) {
        queuedReferences.add(nestedIdentifier);
        referenceOrder.push(nestedIdentifier);
      }
    }
    const text =
      definition?.children
        ?.map((child) => projectNodeText(child, parts, definition))
        .join("") ?? "";
    if (text) {
      const gap = hasSearchableFootnoteBackreferenceGap(definition) ? " " : "";
      if (gap && parts)
        parts.push({
          text: gap,
          sourceStart: -1,
          sourceEnd: -1,
          type: "generated",
        });
      footnoteParts.push(`${text}${gap}`);
    }
  }
  return `${bodyText}${footnoteParts.join("")}`;
}

/** 折りたたんだ会話本文に表示するプレビューのコードポイント数上限。 */
export const MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH = 160;

/** タグ風の部分を除いて空白を圧縮し、上限超過時は省略記号を含めて切り詰める。 */
function normalizeMessagePlainText(text: string): string {
  const normalized = text
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length <= MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH) {
    return normalized;
  }

  return `${codePoints.slice(0, MESSAGE_COLLAPSE_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}

/** 描画後のテキストを上限付きのプレビューとして返す。テキストがない場合は空文字列を返す。 */
export function projectMessagePlainText(
  markdown: string,
  responseProvider?: string,
): string {
  return normalizeMessagePlainText(
    projectMessageRenderedSearchText(
      markdown.replace(/\r\n?|\n/gu, " "),
      responseProvider,
    ),
  );
}
