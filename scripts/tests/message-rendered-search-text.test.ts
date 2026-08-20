import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageRichText } from "../../src/MessageRichText.js";
import { createRenderedTextSearchIndex } from "../../src/file-explorer/rendered-text-search.js";
import {
  isMessageRenderedSearchTextNode,
  projectMessageRenderedSearchText,
} from "../../src/message-rendered-search-text.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });

  return () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: previousCancelAnimationFrame });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
  };
}

test("message search projection は Markdown source ではなく表示文字列だけを返す", () => {
  const markdown = "[needle](https://needle.example/path) **bold** and `code`";
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);
    assert.equal(projectMessageRenderedSearchText(markdown).toLocaleLowerCase(), indexed.normalizedText);
    assert.equal(projectMessageRenderedSearchText(markdown), "needle bold and code");
  } finally {
    dom.window.close();
  }
});

test("message search projection は YAML frontmatter の表示 block と DOM index を一致させる", () => {
  const markdown = [
    "---",
    "name: withmate-memory",
    "description: Use injected context",
    "---",
    "",
    "# Body",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(projected, "---\nname: withmate-memory\ndescription: Use injected context\n---Body");
    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
  } finally {
    dom.window.close();
  }
});

test("message search projection は renderer 生成ラベルをDOM検索と同じく対象外にする", () => {
  const markdown = [
    "alpha note[^1]",
    "",
    "$$x$$",
    "",
    "![alt](https://example.invalid/image.png)",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "",
    "[^1]: foot body",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
    assert.match(projected, /alpha note/);
    assert.match(projected, /foot body/);
    assert.doesNotMatch(projected, /Image loading|Footnotes|graph TD|\bx\b/i);
  } finally {
    dom.window.close();
  }
});

test("message search projection は参照順でfootnote本文を末尾へ置き未参照定義を除外する", () => {
  const markdown = [
    "[^b]: beta needle",
    "[^orphan]: orphan needle",
    "",
    "start[^a] middle[^b]",
    "",
    "[^a]: alpha needle",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
    assert.equal(projected, "start middlealpha needle beta needle ");
    assert.doesNotMatch(projected, /orphan/);
  } finally {
    dom.window.close();
  }
});

test("message search projection は本文から到達できる入れ子footnoteだけをDOM順で含める", () => {
  const markdown = [
    "main[^used]",
    "",
    "[^used]: used body[^nested]",
    "",
    "[^nested]: nested needle",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(projected, "mainused bodynested needle ");
    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
  } finally {
    dom.window.close();
  }
});

test("message search projection は入れ子footnote後のplain textとbackref境界をDOMに揃える", () => {
  const markdown = [
    "main[^used]",
    "",
    "[^used]: before[^nested] after",
    "",
    "[^nested]: nested needle",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(projected, "mainbefore after nested needle ");
    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
  } finally {
    dom.window.close();
  }
});

test("message search projection はfootnoteの重複定義でrendererと同じ最初の定義を使う", () => {
  const markdown = [
    "main[^same]",
    "",
    "[^same]: first body",
    "",
    "[^same]: second body",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(projected, "mainfirst body ");
    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
    assert.doesNotMatch(projected, /second/);
  } finally {
    dom.window.close();
  }
});

test("message search projection はfootnote内のlist tailをDOM境界どおりに投影する", () => {
  const cases = [
    [
      "list tail",
      [
        "main[^used]",
        "",
        "[^used]:",
        "    - item[^nested]",
        "",
        "[^nested]: nested",
      ].join("\n"),
    ],
  ] as const;

  for (const [label, markdown] of cases) {
    const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
    const dom = new JSDOM(`<!doctype html>${html}`);
    try {
      const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
      assert.ok(richText, label);
      const projected = projectMessageRenderedSearchText(markdown);
      const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);
      assert.equal(indexed.normalizedText, projected.toLocaleLowerCase(), label);
    } finally {
      dom.window.close();
    }
  }
});

test("message search projection はmount済みDOMのinline空白とhard break境界に一致する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const cases = [
    [
      "inline whitespace",
      [
        "main[^used]",
        "",
        "[^used]: before[^nested] **after**",
        "",
        "[^nested]: nested",
      ].join("\n"),
    ],
    [
      "inline element whitespace",
      [
        "main[^used]",
        "",
        "[^used]: before[^nested] **bold** [link](https://example.test) `code` ~~delete~~",
        "",
        "[^nested]: nested",
      ].join("\n"),
    ],
    [
      "nested inline whitespace",
      [
        "main[^used]",
        "",
        "[^used]: **[strong link before](https://example.test) [strong link after](https://example.test)** [*link emphasis before* *link emphasis after*](https://example.test) ~~*delete emphasis before* *delete emphasis after*~~",
      ].join("\n"),
    ],
    [
      "escaped inline html",
      "before <kbd>needle</kbd> after",
    ],
    [
      "escaped block html",
      [
        "before",
        "",
        "<section>",
        "needle",
        "</section>",
        "",
        "after",
      ].join("\n"),
    ],
    [
      "fenced code block boundary",
      [
        "~~~txt",
        "needle",
        "~~~",
        "",
        "next",
      ].join("\n"),
    ],
    [
      "indented code block boundary",
      [
        "    needle",
        "",
        "next",
      ].join("\n"),
    ],
    [
      "hard break",
      [
        "main[^used]",
        "",
        "[^used]: before[^nested]  ",
        "    after",
        "",
        "[^nested]: nested",
      ].join("\n"),
    ],
  ] as const;

  try {
    assert.ok(container);
    root = createRoot(container);
    for (const [label, markdown] of cases) {
      await act(async () => {
        root?.render(React.createElement(MessageRichText, { text: markdown, forceFullRender: true }));
      });
      const richText = container.querySelector<HTMLElement>(".rich-text");
      assert.ok(richText, label);
      const projected = projectMessageRenderedSearchText(markdown);
      const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);
      assert.equal(indexed.normalizedText, projected.toLocaleLowerCase(), label);
    }
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("message search projection は未参照footnote内だけの参照を検索対象にしない", () => {
  const markdown = [
    "main",
    "",
    "[^orphan]: orphan body[^nested]",
    "",
    "[^nested]: nested needle",
  ].join("\n");

  assert.equal(projectMessageRenderedSearchText(markdown), "main");
});

test("message search projection は循環footnote参照を一度ずつ投影して停止する", () => {
  const markdown = [
    "main[^a]",
    "",
    "[^a]: A[^b]",
    "",
    "[^b]: B[^a]",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(`<!doctype html>${html}`);
  try {
    const richText = dom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(richText);
    const projected = projectMessageRenderedSearchText(markdown);
    const indexed = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);

    assert.equal(projected, "mainAB");
    assert.equal(indexed.normalizedText, projected.toLocaleLowerCase());
  } finally {
    dom.window.close();
  }
});

test("MessageRichText は検索中にbrowserでも初回からfull rendererを使える", () => {
  const dom = new JSDOM("<!doctype html>");
  const globalWithWindow = globalThis as typeof globalThis & { window?: Window };
  const previousWindow = globalWithWindow.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  try {
    const lightHtml = renderToStaticMarkup(React.createElement(MessageRichText, { text: "$$x$$" }));
    const fullHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
      text: "$$x$$",
      forceFullRender: true,
    }));
    assert.match(lightHtml, /data-markdown-render-mode="light"/);
    assert.match(fullHtml, /data-markdown-render-mode="full"/);
    assert.match(fullHtml, /class="katex"/);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
    dom.window.close();
  }
});
