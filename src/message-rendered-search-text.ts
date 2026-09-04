import { gfmFromMarkdown } from "mdast-util-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";

import { projectMarkdownFrontmatterText } from "./markdown-frontmatter.js";

type MarkdownSearchNode = {
  type: string;
  value?: string;
  lang?: string | null;
  identifier?: string;
  children?: MarkdownSearchNode[];
};

const MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR = [
  ".message-image-shell",
  ".message-mermaid",
  ".katex",
  "[data-footnote-ref]",
  "[data-footnote-backref]",
  "[id$='footnote-label']",
  "script",
  "style",
].join(",");

export function isMessageRenderedSearchTextNode(node: Text): boolean {
  const text = node.textContent ?? "";
  const parent = node.parentElement;
  if (!text || !parent || parent.closest(MESSAGE_RENDERED_SEARCH_EXCLUDED_SELECTOR)) {
    return false;
  }
  if (text.trim()) {
    return true;
  }

  if (/\r|\n/.test(text) || !node.previousSibling || !node.nextSibling) {
    return false;
  }

  const nextElement = node.nextSibling?.nodeType === 1 ? node.nextSibling as Element : null;
  if (nextElement?.matches("[data-footnote-backref]")) {
    return false;
  }

  return parent.matches("p, li, td, th, h1, h2, h3, h4, h5, h6, strong, em, a, del");
}

function projectNodeText(node: MarkdownSearchNode): string {
  if (
    node.type === "text"
    || node.type === "inlineCode"
    || node.type === "code"
    || node.type === "yaml"
  ) {
    if (node.type === "code" && node.lang?.toLocaleLowerCase() === "mermaid") {
      return "";
    }
    const value = node.type === "yaml"
      ? projectMarkdownFrontmatterText(node.value ?? "")
      : node.value ?? "";
    return node.type === "text" || value.trim() ? value : "";
  }
  if (node.type === "break") {
    return "";
  }
  if (node.type === "html") {
    return node.value ?? "";
  }
  if (
    node.type === "image"
    || node.type === "imageReference"
    || node.type === "definition"
    || node.type === "inlineMath"
    || node.type === "math"
    || node.type === "footnoteDefinition"
    || node.type === "footnoteReference"
  ) {
    return "";
  }
  return node.children?.map(projectNodeText).join("") ?? "";
}

function normalizeFootnoteIdentifier(identifier: string): string {
  return identifier.toUpperCase();
}

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
  node.children?.forEach((child) => collectFootnoteDefinitions(child, definitions));
}

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
  node.children?.forEach((child) => collectFootnoteReferences(child, references, skipDefinitions));
}

function hasSearchableFootnoteBackreferenceGap(definition: MarkdownSearchNode): boolean {
  const tail = definition.children?.at(-1);
  return tail?.type === "paragraph" && tail.children?.at(-1)?.type === "text";
}

export function projectMessageRenderedSearchText(markdown: string): string {
  const tree = fromMarkdown(markdown, {
    extensions: [frontmatter(), gfm(), math()],
    mdastExtensions: [frontmatterFromMarkdown(), gfmFromMarkdown(), mathFromMarkdown()],
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
  const bodyText = projectNodeText(root);
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
    const text = definition?.children?.map(projectNodeText).join("") ?? "";
    if (text) {
      footnoteParts.push(`${text}${hasSearchableFootnoteBackreferenceGap(definition) ? " " : ""}`);
    }
  }
  return `${bodyText}${footnoteParts.join("")}`;
}
