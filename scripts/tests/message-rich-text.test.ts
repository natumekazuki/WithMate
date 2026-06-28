import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { handleMarkdownLinkClick, MessageRichText } from "../../src/MessageRichText.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function clickMarkdownLink(target: string) {
  const opened: string[] = [];
  let defaultPrevented = false;

  handleMarkdownLinkClick(
    {
      button: 0,
      defaultPrevented: false,
      preventDefault: () => {
        defaultPrevented = true;
      },
    },
    target,
    (openedTarget) => {
      opened.push(openedTarget);
    },
  );

  return { defaultPrevented, opened };
}

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

function waitForAnimationFrame(window: Window): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

test("MessageRichText は **bold** を strong として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "plain **message** tail",
    }),
  );

  assert.match(html, /<strong class="message-inline-strong">message<\/strong>/);
});

test("MessageRichText は inline code と link を優先しつつ bold を併用できる", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "`**literal**` and **bold [file](src/App.tsx)**",
    }),
  );

  assert.match(html, /<code class="message-inline-code">\*\*literal\*\*<\/code>/);
  assert.match(html, /<strong class="message-inline-strong">/);
  assert.match(html, /<a href="src\/App\.tsx">file<\/a>/);
});

test("handleMarkdownLinkClick は Markdown link を既定ナビゲーションではなく openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("https://example.test/docs#intro");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["https://example.test/docs#intro"]);
});

test("handleMarkdownLinkClick は encoded HTTP URL を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("https://example.test/docs/my%20file.md");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["https://example.test/docs/my%20file.md"]);
});

test("handleMarkdownLinkClick は encoded local link を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("docs/my%20file-%E4%BB%95%E6%A7%98.md");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["docs/my%20file-%E4%BB%95%E6%A7%98.md"]);
});

test("MessageRichText は local/file href の encode を保持して render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "[relative](docs/my%20file.md)",
        "[unicode](docs/%E4%BB%95%E6%A7%98.md)",
        "[file](file:///C:/tmp/a%20b.txt)",
        "[windows](C:/tmp/a%20b.txt)",
      ].join("\n"),
    }),
  );

  assert.match(html, /<a href="docs\/my%20file\.md">relative<\/a>/);
  assert.match(html, /<a href="docs\/%E4%BB%95%E6%A7%98\.md">unicode<\/a>/);
  assert.match(html, /<a href="file:\/\/\/C:\/tmp\/a%20b\.txt">file<\/a>/);
  assert.match(html, /<a href="C:\/tmp\/a%20b\.txt">windows<\/a>/);
});

test("MessageRichText は unsafe href を render しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "[x](javascript:alert(1))",
    }),
  );

  assert.doesNotMatch(html, /href="javascript:/i);
});

test("handleMarkdownLinkClick は footnote などの同一ページアンカーを既定動作に任せる", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("#message-footnote-example-fn-1");

  assert.equal(defaultPrevented, false);
  assert.deepEqual(opened, []);
});

test("handleMarkdownLinkClick は mailto を openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("mailto:alice@example.test");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["mailto:alice@example.test"]);
});

test("handleMarkdownLinkClick は encoded mailto を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("mailto:alice@example.test?subject=hello%20world%0D%0A");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["mailto:alice@example.test?subject=hello%20world%0D%0A"]);
});

test("handleMarkdownLinkClick は protocol-relative URL を openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("//example.test/docs");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["//example.test/docs"]);
});

test("handleMarkdownLinkClick は forward-slash UNC path を local path として openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("//server/share/my%20file.txt");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["//server/share/my%20file.txt"]);
});

test("handleMarkdownLinkClick は Windows absolute path を scheme と誤判定せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("C:/workspace/project/src/App.tsx");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["C:/workspace/project/src/App.tsx"]);
});

test("MessageRichText は GFM table を table 要素として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["| 置き場 | 持つもの |", "| --- | --- |", "| `history` | 状態が変わった時だけのイベント |"].join("\n"),
    }),
  );

  assert.match(html, /<table class="message-table">/);
  assert.match(html, /<th class="message-table-heading">置き場<\/th>/);
  assert.match(html, /<td class="message-table-cell"><code class="message-inline-code">history<\/code><\/td>/);
  assert.doesNotMatch(html, /\| --- \| --- \|/);
});

test("MessageRichText は browser 初回 render を light markdown にして後から full markdown に差し替える", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(MessageRichText, {
        text: ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
      }));
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "light");
    assert.equal(container.querySelector("table"), null);

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "full");
    assert.notEqual(container.querySelector("table.message-table"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("MessageRichText は GFM 拡張記法を render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["~~old~~", "", "- [x] done", "", "https://example.test", "", "note[^1]", "", "[^1]: footnote"].join("\n"),
    }),
  );

  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<li class="task-list-item"><input type="checkbox" disabled="" checked=""/);
  assert.match(html, /<a href="https:\/\/example\.test">https:\/\/example\.test<\/a>/);
  assert.match(html, /data-footnote-ref="true"/);
  assert.match(html, /id="message-footnote-[^"]+-fn-1"/);
});

test("MessageRichText は footnote の DOM ID と aria 参照を message ごとに分離する", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(MessageRichText, {
        text: ["note[^1]", "", "[^1]: first"].join("\n"),
      }),
      React.createElement(MessageRichText, {
        text: ["note[^1]", "", "[^1]: second"].join("\n"),
      }),
    ),
  );

  const footnoteIds = [...html.matchAll(/id="(message-footnote-[^"]+-fn-1)"/g)].map((match) => match[1]);
  const footnoteLabelIds = [...html.matchAll(/id="(message-footnote-[^"]+-footnote-label)"/g)].map((match) => match[1]);
  const ariaLabelIds = [...html.matchAll(/aria-describedby="(message-footnote-[^"]+-footnote-label)"/g)].map(
    (match) => match[1],
  );

  assert.equal(new Set(footnoteIds).size, 2);
  assert.equal(new Set(footnoteLabelIds).size, 2);
  assert.deepEqual(ariaLabelIds, footnoteLabelIds);
  assert.doesNotMatch(html, /id="footnote-label"/);
  assert.doesNotMatch(html, /aria-describedby="footnote-label"/);
});

test("MessageRichText は GFM table alignment を th と td に引き継ぐ", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["| left | center | right |", "| :--- | :---: | ---: |", "| a | b | c |"].join("\n"),
    }),
  );

  assert.match(html, /<th style="text-align:left" class="message-table-heading">left<\/th>/);
  assert.match(html, /<th style="text-align:center" class="message-table-heading">center<\/th>/);
  assert.match(html, /<th style="text-align:right" class="message-table-heading">right<\/th>/);
  assert.match(html, /<td style="text-align:left" class="message-table-cell">a<\/td>/);
  assert.match(html, /<td style="text-align:center" class="message-table-cell">b<\/td>/);
  assert.match(html, /<td style="text-align:right" class="message-table-cell">c<\/td>/);
});

test("MessageRichText は double-dollar math を render し、金額表現の single dollar は維持する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["Inline $$a^2 + b^2$$ math", "", "$$", "a^2 + b^2 = c^2", "$$", "", "$5 and $10"].join("\n"),
    }),
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /\$5 and \$10/);
});

test("MessageRichText は Mermaid code block を diagram 用 container として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
    }),
  );

  assert.match(html, /<div class="message-mermaid fallback">/);
  assert.match(html, /<code class="message-inline-code language-mermaid">flowchart TD\n  A --&gt; B\n<\/code>/);
});

test("MessageRichText は code literal 内の local path link 風テキストを改変しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "`[log](C:/tmp/log file.txt)`",
        "",
        "```txt",
        "[sample](meeting notes.md)",
        "```",
        "",
        "    [indented](meeting notes.md)",
        "\t[tabbed](meeting notes.md)",
      ].join("\n"),
    }),
  );

  assert.match(html, /<code class="message-inline-code">\[log\]\(C:\/tmp\/log file\.txt\)<\/code>/);
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code language-txt">\[sample\]\(meeting notes\.md\)\n<\/code><\/pre>/,
  );
  assert.match(html, /\[indented\]\(meeting notes\.md\)/);
  assert.match(html, /\[tabbed\]\(meeting notes\.md\)/);
});

test("MessageRichText は Markdown image を実画像として描画しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![local](file:///C:/tmp/secret.png)",
        "![embedded](data:image/png;base64,AAAA)",
        "![remote](https://example.test/image.png)",
      ].join("\n"),
    }),
  );

  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /src=/);
  assert.doesNotMatch(html, /file:\/\/\/C:\/tmp\/secret\.png/);
  assert.doesNotMatch(html, /data:image\/png/);
  assert.doesNotMatch(html, /https:\/\/example\.test\/image\.png/);
});

test("MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる", { timeout: 2_000 }, () => {
  const input = ["  # title", "", "  - item", "  1. first", "", "  ```ts", "const answer = 42;", "  ```"].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: input,
    }),
  );

  assert.match(html, /<h3 class="message-heading level-1">title<\/h3>/);
  assert.match(html, /<ul class="message-list">\s*<li>item<\/li>\s*<\/ul>/);
  assert.match(html, /<ol class="message-list ordered">\s*<li>first<\/li>\s*<\/ol>/);
  assert.match(html, /<pre class="message-code-block"><code class="message-inline-code language-ts">const answer = 42;\n<\/code><\/pre>/);
});

test("MessageRichText は先頭空白付き Markdown を既存 block と inline のまま扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["  # **title**", "", "  - [file](src/App.tsx)", "  - `literal`", "", "  1. **step**", "", "tail paragraph"].join(
        "\n",
      ),
    }),
  );

  assert.match(html, /<h3 class="message-heading level-1"><strong class="message-inline-strong">title<\/strong><\/h3>/);
  assert.match(
    html,
    /<ul class="message-list">\s*<li><a href="src\/App\.tsx">file<\/a><\/li>\s*<li><code class="message-inline-code">literal<\/code><\/li>\s*<\/ul>/,
  );
  assert.match(html, /<ol class="message-list ordered">\s*<li><strong class="message-inline-strong">step<\/strong><\/li>\s*<\/ol>/);
  assert.match(html, /<p class="message-paragraph">tail paragraph<\/p>/);
});

test("MessageRichText は 4 文字以上インデントされた block marker を CommonMark の code block として扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["    # not heading", "    - not list", "    1. not ordered", "    ```ts"].join("\n"),
    }),
  );

  assert.doesNotMatch(html, /message-heading/);
  assert.doesNotMatch(html, /<ul class="message-list">/);
  assert.doesNotMatch(html, /<ol class="message-list ordered">/);
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code"># not heading\n- not list\n1\. not ordered\n```ts\n<\/code><\/pre>/,
  );
});
