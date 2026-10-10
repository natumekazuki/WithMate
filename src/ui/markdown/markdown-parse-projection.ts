import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";

function hasDocumentReferences(node: Node): boolean {
  if (node.type === "definition" || node.type.endsWith("Reference") || node.type.startsWith("footnote")) {
    return true;
  }
  // Unresolved reference labels are ordinary text until a later definition arrives.
  if (node.type === "text" && "value" in node && typeof node.value === "string" && node.value.includes("[")) {
    return true;
  }
  return "children" in node && Array.isArray(node.children)
    ? (node as Parent).children.some(hasDocumentReferences)
    : false;
}

function movePositions(node: Node, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of (node as Parent).children) movePositions(child, offset, lines);
  }
}

export function createMarkdownParseProjection() {
  let previous: { text: string; tree: Root; references: boolean } | undefined;
  return (text: string, parse: (source: string) => Root): Root => {
    if (previous?.text === text) return structuredClone(previous.tree);

    let tree: Root;
    const anchorIndex = Math.max(0, (previous?.tree.children.length ?? 0) - 2);
    const anchor = previous?.tree.children[anchorIndex]?.position?.start;
    if (previous && !previous.references && text.startsWith(previous.text) && anchor?.offset && anchorIndex > 0) {
      // Keep the last two top-level blocks mutable (lists, fences, setext and tables).
      // Start at the original line boundary, preserving any indentation.
      const start = anchor.offset - anchor.column + 1;
      // A leading blank prevents fragment-start YAML from becoming document frontmatter.
      const tail = parse(`\n${text.slice(start)}`);
      movePositions(tail, start - 1, anchor.line - 2);
      tree = {
        type: "root",
        children: [...previous.tree.children.slice(0, anchorIndex), ...tail.children],
        position: { start: previous.tree.position!.start, end: tail.position!.end },
      };
    } else {
      tree = parse(text);
    }
    previous = { text, tree, references: hasDocumentReferences(tree) };
    // Downstream remark transforms may mutate their input; never expose the retained AST.
    return structuredClone(tree);
  };
}

export function createMarkdownParseProjectionPlugin(): Plugin<[], Root> {
  const project = createMarkdownParseProjection();
  return function () {
    const parse = this.parser;
    if (!parse) throw new Error("Markdown parser is unavailable.");
    this.parser = (text, file) => project(text, (source) => parse(source, file) as Root);
  };
}
