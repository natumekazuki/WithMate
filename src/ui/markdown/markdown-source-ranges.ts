import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import type { Element, Properties, Root as HastRoot } from "hast";
import type { Node } from "unist";
import type { Plugin } from "unified";

/** 描画要素に残す Markdown の本文範囲と、参照先定義の範囲を示す属性。 */
export type MarkdownSourceAttributes = {
  "data-md-source-start"?: number;
  "data-md-source-end"?: number;
  "data-md-definition-start"?: number;
  "data-md-definition-end"?: number;
};

/** ノードの開始と終了が両方取得できた場合にだけ、本文の範囲を属性にする。 */
export function markdownSourceAttributes(
  node?: Node,
): MarkdownSourceAttributes {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start !== undefined && end !== undefined
    ? { "data-md-source-start": start, "data-md-source-end": end }
    : {};
}

/** 描画要素のプロパティから、本文範囲と定義範囲の属性だけを抜き出す。 */
export function pickMarkdownSourceAttributes(
  properties?: Record<string, unknown>,
): MarkdownSourceAttributes {
  return {
    "data-md-source-start": properties?.["data-md-source-start"] as
      number | undefined,
    "data-md-source-end": properties?.["data-md-source-end"] as
      number | undefined,
    "data-md-definition-start": properties?.["data-md-definition-start"] as
      number | undefined,
    "data-md-definition-end": properties?.["data-md-definition-end"] as
      number | undefined,
  };
}

/** リンク・画像・脚注の参照ノードに、対応する定義のソース範囲を付ける。 */
export const remarkReferenceSourceRanges: Plugin<[], MdastRoot> =
  () => (tree) => {
    const definitions = new Map<string, MdastContent>();
    const footnotes = new Map<string, MdastContent>();
    /** 一周目で各識別子の最初の定義を集め、二周目で参照に定義範囲を付ける。 */
    function visit(node: MdastRoot | MdastContent, collect: boolean) {
      if (
        collect &&
        (node.type === "definition" || node.type === "footnoteDefinition")
      ) {
        const entries = node.type === "definition" ? definitions : footnotes;
        const key = node.identifier.toUpperCase();
        if (!entries.has(key)) entries.set(key, node);
      }
      if (
        !collect &&
        (node.type === "linkReference" ||
          node.type === "imageReference" ||
          node.type === "footnoteReference")
      ) {
        const definition = (
          node.type === "footnoteReference" ? footnotes : definitions
        ).get(node.identifier.toUpperCase());
        const start = definition?.position?.start.offset;
        const end = definition?.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          node.data ??= {};
          node.data.hProperties = {
            ...node.data.hProperties,
            "data-md-definition-start": start,
            "data-md-definition-end": end,
          };
        }
      }
      if ("children" in node)
        for (const child of node.children) visit(child, collect);
    }
    visit(tree, true);
    visit(tree, false);
  };

/** 描画要素へ Markdown オフセットを伝え、数式の範囲は変換後も残る要素に保持する。 */
export const rehypeSourceRanges: Plugin<[], HastRoot> = () => (tree) => {
  /** 通常要素は子孫にも範囲を付け、数式要素は式全体の範囲を持つ親で包む。 */
  function visit(parent: HastRoot | Element) {
    parent.children = parent.children.map((node) => {
      if (node.type !== "element") return node;
      node.properties = {
        ...node.properties,
        ...markdownSourceAttributes(node),
      };
      const classes = node.properties.className;
      const math =
        Array.isArray(classes) &&
        classes.some((value) =>
          ["math-inline", "math-display"].includes(String(value)),
        );
      const mathFence =
        node.tagName === "pre" &&
        node.children.some(
          (child) =>
            child.type === "element" &&
            Array.isArray(child.properties.className) &&
            child.properties.className.includes("language-math"),
        );
      if (!math && !mathFence) visit(node);
      // KaTeX は入力ノードを置き換える。元の数式の範囲は、生成した部分木の外側に保持する。
      return math || mathFence
        ? {
            type: "element",
            tagName: "span",
            properties: markdownSourceAttributes(node) as Properties,
            children: [node],
          }
        : node;
    });
  }
  visit(tree);
};
