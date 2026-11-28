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
      // 位置とプロパティをキーに含める。コンパイル済みブロックには現在のソースオフセットが残る。
      const key = JSON.stringify(node);
      let compiled = retained.get(key) ?? current.get(key);
      if (!compiled) {
        const block: Root = { type: "root", children: [node as Element] };
        render(block, file);
        compiled = structuredClone(block.children);
      }
      current.set(key, compiled);
      // 注釈と URL の変換は、キャッシュではなく自身の変更可能な投影を使う。
      return structuredClone(compiled);
    });
    retained = current;
  };
}
