import type { Root as MdastRoot, RootContent as MdastContent } from "mdast";
import type { Element, Properties, Root as HastRoot } from "hast";
import type { Node } from "unist";
import type { Plugin } from "unified";

export type MarkdownSourceAttributes = {
  "data-md-source-start"?: number;
  "data-md-source-end"?: number;
  "data-md-definition-start"?: number;
  "data-md-definition-end"?: number;
};

export function markdownSourceAttributes(node?: Node): MarkdownSourceAttributes {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  return start !== undefined && end !== undefined
    ? { "data-md-source-start": start, "data-md-source-end": end } : {};
}

export function pickMarkdownSourceAttributes(properties?: Record<string, unknown>): MarkdownSourceAttributes {
  return {
    "data-md-source-start": properties?.["data-md-source-start"] as number | undefined,
    "data-md-source-end": properties?.["data-md-source-end"] as number | undefined,
    "data-md-definition-start": properties?.["data-md-definition-start"] as number | undefined,
    "data-md-definition-end": properties?.["data-md-definition-end"] as number | undefined,
  };
}

export const remarkReferenceSourceRanges: Plugin<[], MdastRoot> = () => (tree) => {
  const definitions = new Map<string, MdastContent>();
  const footnotes = new Map<string, MdastContent>();
  function visit(node: MdastRoot | MdastContent, collect: boolean) {
    if (collect && (node.type === "definition" || node.type === "footnoteDefinition")) {
      const entries = node.type === "definition" ? definitions : footnotes;
      const key = node.identifier.toUpperCase();
      if (!entries.has(key)) entries.set(key, node);
    }
    if (!collect && (node.type === "linkReference" || node.type === "imageReference" || node.type === "footnoteReference")) {
      const definition = (node.type === "footnoteReference" ? footnotes : definitions).get(node.identifier.toUpperCase());
      const start = definition?.position?.start.offset;
      const end = definition?.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        node.data ??= {};
        node.data.hProperties = { ...node.data.hProperties, "data-md-definition-start": start, "data-md-definition-end": end };
      }
    }
    if ("children" in node) for (const child of node.children) visit(child, collect);
  }
  visit(tree, true);
  visit(tree, false);
};

export const rehypeSourceRanges: Plugin<[], HastRoot> = () => (tree) => {
  function visit(parent: HastRoot | Element) {
    parent.children = parent.children.map((node) => {
      if (node.type !== "element") return node;
      node.properties = { ...node.properties, ...markdownSourceAttributes(node) };
      const classes = node.properties.className;
      const math = Array.isArray(classes) && classes.some((value) => ["math-inline", "math-display"].includes(String(value)));
      const mathFence = node.tagName === "pre" && node.children.some((child) => child.type === "element"
        && Array.isArray(child.properties.className) && child.properties.className.includes("language-math"));
      if (!math && !mathFence) visit(node);
      // KaTeX replaces its input nodes. Retain the original expression range outside that generated subtree.
      return math || mathFence ? {
        type: "element", tagName: "span", properties: markdownSourceAttributes(node) as Properties, children: [node],
      } : node;
    });
  }
  visit(tree);
};
