import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";

/** 参照定義・脚注、または追記で参照になり得るテキストを検出し、部分再解析を避ける判断に使う。 */
function hasDocumentReferences(node: Node): boolean {
  if (
    node.type === "definition" ||
    node.type.endsWith("Reference") ||
    node.type.startsWith("footnote")
  ) {
    return true;
  }
  // 未解決の参照ラベルは、後続の定義が届くまでは普通のテキストとして扱う。
  if (
    node.type === "text" &&
    "value" in node &&
    typeof node.value === "string" &&
    node.value.includes("[")
  ) {
    return true;
  }
  return "children" in node && Array.isArray(node.children)
    ? (node as Parent).children.some(hasDocumentReferences)
    : false;
}

/** 断片として解析したノードの行番号とオフセットを、元の文書の位置へ移す。 */
function movePositions(node: Node, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node && Array.isArray(node.children)) {
    for (const child of (node as Parent).children)
      movePositions(child, offset, lines);
  }
}

/** 同じ本文は保持済みの構文木を使い、安全に分割できる追記は見出し以降だけを再解析する。 */
export function createMarkdownParseProjection() {
  let previous: { text: string; tree: Root; references: boolean } | undefined;
  return (text: string, parse: (source: string) => Root): Root => {
    if (previous?.text === text) return structuredClone(previous.tree);

    let tree: Root;
    const previousText = previous?.text ?? "";
    // ATX 見出しは、それまでの文脈に依存せず直前のブロックを打ち切る。
    // 文書先頭の YAML ブロックが閉じていなければ、後続の見出しをすべて取り込む可能性がある。
    const openFrontmatter =
      previous &&
      /^---(?:\r?\n|$)/.test(previousText) &&
      previous.tree.children[0]?.type !== "yaml";
    const anchorIndex =
      previous && !openFrontmatter
        ? previous.tree.children.findLastIndex((node) => {
            const point = node.position?.start;
            return (
              node.type === "heading" &&
              point?.offset !== undefined &&
              /^ {0,3}#{1,6}(?:[\t ]|\r?\n|$)/.test(
                previousText.slice(point.offset - point.column + 1),
              )
            );
          })
        : -1;
    const anchor = previous?.tree.children[anchorIndex]?.position?.start;
    if (
      previous &&
      !previous.references &&
      text.startsWith(previous.text) &&
      anchor?.offset &&
      anchorIndex > 0
    ) {
      // 安定した見出しから再解析し、それに続くブロック全体の文脈を保つ。
      const start = anchor.offset - anchor.column + 1;
      // 先頭に空行を置き、断片の冒頭にある YAML が文書のフロントマターとして扱われないようにする。
      const tail = parse(`\n${text.slice(start)}`);
      movePositions(tail, start - 1, anchor.line - 2);
      tree = {
        type: "root",
        children: [
          ...previous.tree.children.slice(0, anchorIndex),
          ...tail.children,
        ],
        position: {
          start: previous.tree.position!.start,
          end: tail.position!.end,
        },
      };
    } else {
      tree = parse(text);
    }
    previous = { text, tree, references: hasDocumentReferences(tree) };
    // 後段の remark 変換が入力を書き換えることがあるため、保持中の AST をそのまま渡さない。
    return structuredClone(tree);
  };
}

/** 既存パーサーに投影の再利用を組み込み、後段の処理から保持中の構文木を隔離する。 */
export function createMarkdownParseProjectionPlugin(): Plugin<[], Root> {
  const project = createMarkdownParseProjection();
  return function () {
    const parse = this.parser;
    if (!parse) throw new Error("Markdown parser is unavailable.");
    this.parser = (text, file) =>
      project(text, (source) => parse(source, file) as Root);
  };
}
