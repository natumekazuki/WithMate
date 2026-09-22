import type { Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";

const htmlLineBreakPattern = /^<br[ \t]*\/?>(?=$)/i;
export const remarkHtmlLineBreaks: Plugin<[], Root> = () => (tree) => {
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
export function createFootnoteLabelIdPlugin(footnoteLabelId: string) {
  type HastNode = {
    type?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
  };
  return () => (tree: HastNode) => {
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
