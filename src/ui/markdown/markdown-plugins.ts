import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";

const htmlLineBreakPattern = /^<br[ \t]*\/?>(?=$)/i;
/** 単独の HTML 改行タグを Markdown の改行ノードに変換し、他の HTML はこの規則では扱わない。 */
export const remarkHtmlLineBreaks: Plugin<[], Root> = () => (tree) => {
  /** 子孫を巡回し、対象のタグを元の位置付きの改行に差し替える。 */
  function visit(node: Node) {
    if (!("children" in node) || !Array.isArray(node.children)) return;
    const parent = node as Parent;
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index];
      if (
        child.type === "html" &&
        "value" in child &&
        typeof child.value === "string" &&
        htmlLineBreakPattern.test(child.value)
      ) {
        parent.children[index] = { type: "break", position: child.position };
        continue;
      }
      visit(child);
    }
  }
  visit(tree);
};

/** 脚注ラベルを指す値だけを置き換え、ほかの参照 ID を保持する。 */
function replaceFootnoteLabelReference(
  value: unknown,
  footnoteLabelId: string,
) {
  if (value === "footnote-label") return footnoteLabelId;
  if (Array.isArray(value))
    return value.map((entry) =>
      entry === "footnote-label" ? footnoteLabelId : entry,
    );
  return value;
}
/** 脚注の見出し ID とそれへの読み上げ参照を、この描画の専用 ID にそろえる。 */
export function createFootnoteLabelIdPlugin(footnoteLabelId: string) {
  /** 変換に必要な要素の種別・属性と子ノードだけを表す。 */
  type HastNode = {
    type?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
  };
  return () => (tree: HastNode) => {
    /** 見出しの ID と両形式の aria-describedby を置き換え、すべての子孫へ処理を続ける。 */
    function visit(node: HastNode) {
      if (node.type === "element" && node.properties) {
        if (node.properties.id === "footnote-label")
          node.properties.id = footnoteLabelId;
        node.properties.ariaDescribedBy = replaceFootnoteLabelReference(
          node.properties.ariaDescribedBy,
          footnoteLabelId,
        );
        node.properties["aria-describedby"] = replaceFootnoteLabelReference(
          node.properties["aria-describedby"],
          footnoteLabelId,
        );
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
