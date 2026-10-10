import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import katex from "katex";
import type { Root as HastRoot } from "hast";
import { createMarkdownParseProjection } from "../../src/ui/markdown/markdown-parse-projection.js";
import { createKatexProjectionPlugin } from "../../src/ui/markdown/markdown-katex-projection.js";
import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";
import ReactMarkdown from "react-markdown";
import { markdownComponents, renderMarkdownFrontmatter } from "../../src/ui/markdown/markdown-components.js";
import { MarkdownRenderContext } from "../../src/ui/markdown/markdown-context.js";
import { markdownUrlTransform } from "../../src/ui/markdown/markdown-links.js";
import { remarkHtmlLineBreaks } from "../../src/ui/markdown/markdown-plugins.js";

function parser(full: boolean) {
  return unified().use(remarkParse).use(remarkFrontmatter)
    .use(full ? [remarkGfm] : []).use(remarkMath, { singleDollarTextMath: false });
}

// @test-value v2
// kind = "invariant"
// claim = "追記と置換の各prefixでMarkdown projectionのASTと絶対位置は通常の全文parserに一致する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Streaming projection" }
// fault = "未閉鎖blockを確定する、fragmentのYAMLをfrontmatterにする、後続referenceを反映しない、またはoffsetをずらす"
// observable = "全prefixのAST・positionと置換後のAST"
// observation_boundary = "consumer"
// scope = "light/full Markdown parse projection"
// lifecycle = "permanent"
// impact = "構文・code copy・reference・footnote・選択の表示がstreaming中も全文parserと一致する"
// distinction = "単発renderer testや型検査では観測できない追記境界と絶対offsetを独立した全文parserで照合する"
// @end-test-value
test("Markdown projectionは各文字の追記と置換を全文parseと一致させる", () => {
  const fixtures = [
    "---\ntitle: sample\n---\n\n# Heading\n\nintro\n\nbody<br>line\n\n---\nnot: frontmatter\n---\n",
    "# A\n\nB\n\nC\n\nD\n---\n\n| x | y |\n| :--- | ---: |\n| a | b |\n\nnext\n",
    "# A\n\nB\n\n- one\n  - nested\n\n    continuation\n\n- two\n\n> quote\n>\n> - list\ncontinued\n\nend\n",
    "# A\n\nB\n\n  ```ts\nconst emoji = '😀';\n\n### literal\n  ````\n\n    code\n\n    more\n\nnext\n",
    "# A\r\n\r\nB\r\n\r\nC\r\n\r\n~~strike~~ and $$x^2$$\r\n\r\n$$\r\nx+y\r\n$$\r\n\r\n尾\r\n",
    "# A\n\nB\n\n[forward][ref] ![image][img] and [^note]\n\n[ref]: https://example.com\n[img]: image.png\n\n[^note]: footnote\n\n    continuation [^nested]\n\n[^nested]: nested\n",
    "# A\n\nB\n\n[inline](https://example.com) ![icon](image.png)\n\nC\n\n[late]\n\n[late]: target.md\n",
    "# A\n\nB\n\n<div>\nparagraph\n\n</div>\n\n---\n\n~~~mermaid\nflowchart LR\n A[one] --> B[two]\n~~~\n\nend\n",
  ];
  for (const full of [false, true]) {
    const normal = parser(full);
    const project = createMarkdownParseProjection();
    for (const fixture of fixtures) {
      for (let length = 0; length <= fixture.length; length++) {
        const text = fixture.slice(0, length);
        assert.deepEqual(project(text, (source) => normal.parse(source)), normal.parse(text), `full=${full}, length=${length}, text=${JSON.stringify(text)}`);
      }
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "確定blockのある長文追記は全文再parseより少ない文字数を処理し同じASTを返す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Streaming projection" }
// fault = "projectionを迂回して累積全文を毎回parseする、同じ本文を操作更新で再parseする、または下流mutationを保持ASTへ漏らす"
// observable = "実parserに渡された文字数・呼出回数、各更新のAST、mutation後の再取得AST"
// observation_boundary = "consumer"
// scope = "message-local parse reuse"
// lifecycle = "permanent"
// impact = "長文streamingのCPU削減と現在の本文だけを保持するprojectionの正確性を維持する"
// distinction = "時間の閾値を使わず実parser入力を数え、performance要求とmutable transform境界を少数の更新で検出する"
// @end-test-value
test("Markdown projectionは確定blockを再parseせず下流のmutationから保持ASTを守る", () => {
  const normal = parser(true);
  const project = createMarkdownParseProjection();
  let parsedUnits = 0;
  let calls = 0;
  const parse = (text: string) => { parsedUnits += text.length; calls++; return normal.parse(text); };
  let text = "";
  let fullUnits = 0;
  for (let index = 0; index < 40; index++) {
    text += `## ${index}\n\n${"確定した本文を保持する。".repeat(15)}\n\n`;
    fullUnits += text.length;
    assert.deepEqual(project(text, parse), normal.parse(text));
  }
  assert.ok(parsedUnits < fullUnits / 5, `${parsedUnits} / ${fullUnits}`);
  const before = calls;
  const changed = project(text, parse);
  changed.children.length = 0;
  assert.deepEqual(project(text, parse), normal.parse(text));
  assert.equal(calls, before);
});

// @test-value v2
// kind = "invariant"
// claim = "同じ数式blockはKaTeX結果を再利用し本文・数式の変更では現行の全文変換と一致する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Streaming projection" }
// fault = "本文追記で同じ数式を毎回compileする、変更した数式に旧結果を使う、または下流の変更をcacheへ漏らす"
// observable = "実KaTeX renderToString回数と通常rehypeKatexによるHASTとの一致"
// observation_boundary = "consumer"
// scope = "message-local KaTeX projection"
// lifecycle = "permanent"
// impact = "数式表示の正確性と高度描画の再実行削減を同時に維持する"
// distinction = "単発数式testでは測れない再利用と更新を実KaTeX経路の呼出回数と独立oracleで検出する"
// @end-test-value
test("KaTeX projectionは同じ数式を再利用し変更・削除を通常変換と一致させる", () => {
  const hast = parser(true).use(remarkRehype);
  const cached = unified().use(createKatexProjectionPlugin());
  const normal = unified().use(rehypeKatex);
  const originalRender = katex.renderToString;
  let calls = 0;
  katex.renderToString = (...args) => { calls++; return originalRender(...args); };
  try {
    for (const [text, expectedCalls] of [
      ["$$x^2$$\n\nfirst", 1],
      ["$$x^2$$\n\nfirst\n\nsecond", 0],
      ["$$y^2$$\n\nfirst", 1],
      ["no math", 0],
      ["$$x^2$$\n\nfirst", 1],
      ["```math\nx+y\n```\n\n$$z$$", 2],
    ] as const) {
      const tree = hast.runSync(hast.parse(text)) as HastRoot;
      calls = 0;
      const actual = cached.runSync(structuredClone(tree));
      assert.equal(calls, expectedCalls);
      assert.deepEqual(actual, normal.runSync(structuredClone(tree)));
      actual.children.length = 0;
    }
  } finally { katex.renderToString = originalRender; }
});

// @test-value v2
// kind = "contract"
// claim = "mount済みrendererの追記後final DOMは通常全文描画に一致しcode copy・link・選択対象を保つ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Streaming projection / Link Handling" }
// fault = "parser projectionがcomponentへ接続されない、後続定義がDOMへ反映されない、code offsetがずれる、または再利用で古いlinkを開く"
// observable = "更新後innerHTML、選択文字列、clipboard受信本文、openPath受信target"
// observation_boundary = "component-behavior"
// scope = "MessageRichText streaming consumer"
// lifecycle = "permanent"
// impact = "最終Markdownと検索/選択/copy/openの利用者操作を保持する"
// distinction = "projection単体のAST確認とは別に実componentをmountして複数更新と利用者操作を通す"
// @end-test-value
test("MessageRichTextのstreaming finalは全文DOMに一致しcopy・link・選択を維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const clipboard: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { clipboard.push(text); } } });
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const opened: string[] = [];
  let text = "";
  try {
    for (const chunk of ["# Heading\n\n", "intro\n\n", "body\n\n", "```ts\nconst value = 1;\n", "```\n\n", "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n", "[later][ref] $$x^2$$\n\n", "[ref]: target.md\n"]) {
      text += chunk;
      await act(async () => root.render(<MessageRichText text={text} forceFullRender onOpenPath={(target) => opened.push(target)} />));
      const expected = renderToStaticMarkup(
        <div className="message-body rich-text" data-markdown-render-mode="full">
          <MarkdownRenderContext.Provider value={{ markdown: text, enableMermaid: true, onCodeBlockCopyResult: () => undefined }}>
            <ReactMarkdown components={markdownComponents} urlTransform={markdownUrlTransform}
              remarkPlugins={[remarkFrontmatter, remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkHtmlLineBreaks]}
              rehypePlugins={[rehypeKatex]} remarkRehypeOptions={{ handlers: { yaml: renderMarkdownFrontmatter } }}>
              {text}
            </ReactMarkdown>
          </MarkdownRenderContext.Provider>
        </div>,
      );
      const oracle = dom.window.document.createElement("div");
      oracle.innerHTML = expected;
      for (const element of oracle.querySelectorAll<HTMLElement>("[style]")) element.setAttribute("style", element.style.cssText);
      assert.equal(container.innerHTML, oracle.innerHTML);
    }
    const range = dom.window.document.createRange();
    range.selectNodeContents(container.querySelector(".message-paragraph")!);
    dom.window.getSelection()!.addRange(range);
    assert.equal(dom.window.getSelection()!.toString(), "intro");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click());
    assert.deepEqual(clipboard, ["const value = 1;"]);
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="target.md"]')!.click());
    assert.deepEqual(opened, ["target.md"]);
  } finally {
    await act(async () => root.unmount());
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
    dom.window.close();
  }
});
