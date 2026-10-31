import type { Element, Root, RootContent } from "hast";
import rehypeKatex from "rehype-katex";
import type { Plugin } from "unified";

function containsMath(node: RootContent): boolean {
  if (node.type !== "element") return false;
  const classes = node.properties.className;
  return (Array.isArray(classes) && classes.some((value) => ["language-math", "math-inline", "math-display"].includes(String(value))))
    || node.children.some(containsMath);
}

export function createKatexProjectionPlugin(): Plugin<[], Root> {
  const render = rehypeKatex();
  let retained = new Map<string, RootContent[]>();
  return () => (tree, file) => {
    const current = new Map<string, RootContent[]>();
    tree.children = tree.children.flatMap((node) => {
      if (!containsMath(node)) return [node];
      // Include positions and properties: compiled blocks keep the current source offsets.
      const key = JSON.stringify(node);
      let compiled = retained.get(key) ?? current.get(key);
      if (!compiled) {
        const block: Root = { type: "root", children: [node as Element] };
        render(block, file);
        compiled = structuredClone(block.children);
      }
      current.set(key, compiled);
      // Annotation and URL transforms own their mutable projection, not the cached one.
      return structuredClone(compiled);
    });
    retained = current;
  };
}
