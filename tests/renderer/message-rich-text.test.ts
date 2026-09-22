import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MessageRichText,
  resolveMessageMarkdownRenderMode,
} from "../../src/ui/markdown/MessageRichText.js";
import {
  handleMarkdownLinkClick,
  handleMarkdownLinkContextMenu,
} from "../../src/ui/markdown/markdown-links.js";
import { resolveCodeBlockText } from "../../src/ui/markdown/markdown-code.js";
import {
  ImageViewport,
  ImageZoomControls,
  useImageViewport,
} from "../../src/ui/image-viewport.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

async function openMarkdownLinkContextMenu(target: string) {
  const requests: unknown[] = [];
  let defaultPrevented = false;

  const result = await handleMarkdownLinkContextMenu(
    {
      clientX: 120,
      clientY: 240,
      currentTarget: {
        getBoundingClientRect: () => ({ left: 10, bottom: 20 }),
      },
      preventDefault: () => {
        defaultPrevented = true;
      },
    },
    target,
    async (request) => {
      requests.push(request);
      return { status: "link-copied" };
    },
  );

  return { defaultPrevented, requests, result };
}

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });

  return () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: previousNavigator,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previousRequestAnimationFrame,
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: previousCancelAnimationFrame,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: previousHTMLElement,
    });
  };
}

function waitForAnimationFrame(window: {
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
}): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

type ControlledTimer = {
  callback: () => void;
  delay: number;
};

function installControlledTimers(window: {
  setTimeout: (handler: TimerHandler, timeout?: number) => number;
  clearTimeout: (id: number) => void;
}): {
  pending: Map<number, ControlledTimer>;
  restore: () => void;
} {
  const previousSetTimeout = window.setTimeout;
  const previousClearTimeout = window.clearTimeout;
  const pending = new Map<number, ControlledTimer>();
  let nextTimerId = 1;

  Object.defineProperty(window, "setTimeout", {
    configurable: true,
    value: (callback: TimerHandler, delay?: number) => {
      const timerId = nextTimerId++;
      pending.set(timerId, {
        callback:
          typeof callback === "function"
            ? (callback as () => void)
            : () => undefined,
        delay: delay ?? 0,
      });
      return timerId;
    },
  });
  Object.defineProperty(window, "clearTimeout", {
    configurable: true,
    value: (timerId: number) => {
      pending.delete(timerId);
    },
  });

  return {
    pending,
    restore: () => {
      Object.defineProperty(window, "setTimeout", {
        configurable: true,
        value: previousSetTimeout,
      });
      Object.defineProperty(window, "clearTimeout", {
        configurable: true,
        value: previousClearTimeout,
      });
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は **bold** を strong として render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "bold記法がstrong要素へ投影されず、本文の強調表示が失われる"
// observable = "strong.message-inline-strongのHTML要素とtextContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのinline strong rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は **bold** を strong として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "plain **message** tail",
    }),
  );

  assert.match(html, /<strong class="message-inline-strong">message<\/strong>/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は属性なしの正しい HTML br 記法を改行として render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "属性なしのbrおよび大文字・self-closing形式が改行へ変換されず、本文の行境界が失われる"
// observable = "br要素数とmessage-paragraphのtextContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのHTML line break rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は属性なしの正しい HTML br 記法を改行として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "first<br>second<br/>third<br />fourth<BR>fifth",
    }),
  );
  const dom = new JSDOM(html);

  assert.equal(dom.window.document.querySelectorAll("br").length, 4);
  assert.equal(
    dom.window.document.querySelector(".message-paragraph")?.textContent,
    "first\nsecond\nthird\nfourth\nfifth",
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は対象外の raw HTML を element として render しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "raw HTMLがReact elementとして通りscriptやevent属性がDOMへ残る"
// observable = "body textにrawタグ文字列が残り、script/img/br elementが生成されないこと"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのraw HTML filtering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は対象外の raw HTML を element として render しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "<script>alert('x')</script>",
        "<img src=x onerror=alert(1)>",
        "<br onclick=alert(1)>",
      ].join("\n"),
    }),
  );
  const dom = new JSDOM(html);

  assert.equal(dom.window.document.querySelector("script, img, br"), null);
  assert.match(
    dom.window.document.body.textContent,
    /<script>alert\('x'\)<\/script>/,
  );
  assert.match(
    dom.window.document.body.textContent,
    /<img src=x onerror=alert\(1\)>/,
  );
  assert.match(dom.window.document.body.textContent, /<br onclick=alert\(1\)>/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は plain text と code literal 内の HTML br 文字列を改変しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "plain textやcode literal内の</br>を改行として変換する"
// observable = "preview body、inline code、fenced code、source preの各textContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのHTML文字列保持とline-break plugin"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は plain text と code literal 内の HTML br 文字列を改変しない", () => {
  const markdown = [
    "invalid </br> closing",
    "",
    "plain &lt;/br&gt; text",
    "",
    "`inline </br> code`",
    "",
    "```txt",
    "fenced </br> code",
    "```",
  ].join("\n");
  const previewHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: markdown }),
  );
  const previewDom = new JSDOM(previewHtml);
  const sourceHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "source </br> text",
      displayMode: "source",
    }),
  );
  const sourceDom = new JSDOM(sourceHtml);

  assert.equal(previewDom.window.document.querySelector("br"), null);
  assert.match(
    previewDom.window.document.body.textContent,
    /invalid <\/br> closing/,
  );
  assert.match(
    previewDom.window.document.body.textContent,
    /plain <\/br> text/,
  );
  assert.match(
    previewDom.window.document.querySelector("code")?.textContent ?? "",
    /inline <\/br> code/,
  );
  assert.match(
    previewDom.window.document.querySelector("pre")?.textContent ?? "",
    /fenced <\/br> code/,
  );
  assert.equal(sourceDom.window.document.querySelector("br"), null);
  assert.equal(
    sourceDom.window.document.querySelector("pre")?.textContent,
    "source </br> text",
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText の Source は元 Markdown を変換せず plain text で描画する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Source表示がMarkdownをHTMLへ解釈してlinkやcode等の要素を生成する"
// observable = "source preのtextContentとa、code、blockquote、ul子要素が存在しないこと"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのSource display mode"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText の Source は元 Markdown を変換せず plain text で描画する", () => {
  const source = [
    "[link label](https://example.test/path)",
    "`inline code`",
    "> quoted line",
    "- list item",
    "",
    "second paragraph",
  ].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: source,
      displayMode: "source",
    }),
  );
  const dom = new JSDOM(html);
  const sourceElement = dom.window.document.body.firstElementChild;

  assert.equal(sourceElement?.textContent, source);
  assert.equal(sourceElement?.querySelector("a, code, blockquote, ul"), null);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は先頭 YAML frontmatter の scalar mapping を key/value table として render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "scalar frontmatterをtableへ変換せずcode blockまたは通常本文として扱う"
// observable = "frontmatter tableの存在、row key/value、th scope、Body見出し、fallback preの不在"
// observation_boundary = "component-behavior"
// scope = "renderMarkdownFrontmatterのscalar mapping projection"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は先頭 YAML frontmatter の scalar mapping を key/value table として render する", () => {
  const frontmatter = [
    "---",
    "name: withmate-memory",
    "description: Use injected context",
    "---",
  ].join("\n");
  const markdown = `${frontmatter}\n\n# Body`;
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: markdown }),
  );
  const dom = new JSDOM(html);
  const frontmatterTable = dom.window.document.querySelector(
    "table.message-frontmatter-table",
  );

  assert.ok(frontmatterTable);
  assert.equal(frontmatterTable.getAttribute("aria-label"), "YAML frontmatter");
  assert.deepEqual(
    Array.from(frontmatterTable.querySelectorAll("tr")).map((row) => [
      row.querySelector("th")?.textContent,
      row.querySelector("td")?.textContent,
    ]),
    [
      ["name", "withmate-memory"],
      ["description", "Use injected context"],
    ],
  );
  assert.equal(
    frontmatterTable.querySelector("th")?.getAttribute("scope"),
    "row",
  );
  assert.equal(
    dom.window.document.querySelector("pre.message-frontmatter-block"),
    null,
  );
  assert.equal(
    dom.window.document.querySelector("h1.message-heading")?.textContent,
    "Body",
  );
  assert.equal(dom.window.document.querySelector("h2.message-heading"), null);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText の Source は YAML frontmatter を含む元 Markdown をそのまま描画する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Source modeがfrontmatter delimitersや本文を変換し元Markdownの改行を失う"
// observable = "source preのtextContentが入力sourceと一致しMarkdown要素がないこと"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのSource frontmatter preservation"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText の Source は YAML frontmatter を含む元 Markdown をそのまま描画する", () => {
  const source = [
    "---",
    "name: raw",
    "description: keep line breaks",
    "---",
    "",
    "# Body",
  ].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: source,
      displayMode: "source",
    }),
  );
  const dom = new JSDOM(html);
  const sourceElement = dom.window.document.querySelector(
    "pre.message-source-text",
  );

  assert.equal(sourceElement?.textContent, source);
  assert.equal(sourceElement?.querySelector("code, h1, hr"), null);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は空・複雑な frontmatter を code blockへ戻し、未閉鎖や本文中の thematic break は変えない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "空・複雑・未閉鎖frontmatterを同じtableへ誤分類し本文のthematic breakをfrontmatter扱いする"
// observable = "frontmatter blockのpre内容、table不在、未閉鎖本文のh1、本文中hr"
// observation_boundary = "component-behavior"
// scope = "renderMarkdownFrontmatterのfallback分類"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は空・複雑な frontmatter を code blockへ戻し、未閉鎖や本文中の thematic break は変えない", () => {
  const emptyFrontmatterHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["---", "---", "", "# Body"].join("\n"),
    }),
  );
  const emptyFrontmatterDom = new JSDOM(emptyFrontmatterHtml);
  assert.equal(
    emptyFrontmatterDom.window.document.querySelector(
      "pre.message-frontmatter-block code",
    )?.textContent,
    "---\n---",
  );

  const nestedFrontmatter = [
    "---",
    "name: withmate-memory",
    "tags:",
    "  - memory",
    "  - context",
    "---",
  ].join("\n");
  const nestedHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: `${nestedFrontmatter}\n\n# Body`,
    }),
  );
  const nestedDom = new JSDOM(nestedHtml);
  assert.equal(
    nestedDom.window.document.querySelector("table.message-frontmatter-table"),
    null,
  );
  assert.equal(
    nestedDom.window.document.querySelector(
      "pre.message-frontmatter-block code",
    )?.textContent,
    nestedFrontmatter,
  );

  const multilineFrontmatter = [
    "---",
    "description: |",
    "  first line",
    "  second line",
    "---",
  ].join("\n");
  const multilineHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: `${multilineFrontmatter}\n\n# Body`,
    }),
  );
  const multilineDom = new JSDOM(multilineHtml);
  assert.equal(
    multilineDom.window.document.querySelector(
      "table.message-frontmatter-table",
    ),
    null,
  );
  assert.equal(
    multilineDom.window.document.querySelector(
      "pre.message-frontmatter-block code",
    )?.textContent,
    multilineFrontmatter,
  );

  const invalidFrontmatter = ["---", "name: [unclosed", "---"].join("\n");
  const invalidHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: `${invalidFrontmatter}\n\n# Body`,
    }),
  );
  const invalidDom = new JSDOM(invalidHtml);
  assert.equal(
    invalidDom.window.document.querySelector("table.message-frontmatter-table"),
    null,
  );
  assert.equal(
    invalidDom.window.document.querySelector(
      "pre.message-frontmatter-block code",
    )?.textContent,
    invalidFrontmatter,
  );

  const unclosedHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["---", "name: stays ordinary Markdown", "", "# Body"].join("\n"),
    }),
  );
  const unclosedDom = new JSDOM(unclosedHtml);
  assert.equal(
    unclosedDom.window.document.querySelector("pre.message-frontmatter-block"),
    null,
  );
  assert.ok(unclosedDom.window.document.querySelector("hr.message-divider"));

  const bodyBreakHtml = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["# Body", "", "---", "", "tail"].join("\n"),
    }),
  );
  const bodyBreakDom = new JSDOM(bodyBreakHtml);
  assert.equal(
    bodyBreakDom.window.document.querySelector("pre.message-frontmatter-block"),
    null,
  );
  assert.ok(bodyBreakDom.window.document.querySelector("hr.message-divider"));
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText の YAML frontmatter Preview は表とfallbackの値を折り返す CSS 契約を持つ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "frontmatter tableとfallback blockの長い値がwrapされずpreview幅を超える"
// observable = "stylesheetのfrontmatter table cellとblockにoverflow-wrapまたはword-break指定があること"
// observation_boundary = "declaration"
// scope = "MessageRichText frontmatter preview CSS"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText の YAML frontmatter Preview は表とfallbackの値を折り返す CSS 契約を持つ", async () => {
  const styles = await readStylesheet();

  assert.match(
    styles,
    /\.message-code-block\.message-frontmatter-block\s*{[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(
    styles,
    /\.message-frontmatter-block\s*>\s*\.message-frontmatter-code\s*{[\s\S]*?display:\s*block;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
  assert.match(
    styles,
    /\.message-frontmatter-table\s+\.message-table-heading\s*{[\s\S]*?width:\s*1%;[\s\S]*?white-space:\s*nowrap;/,
  );
  assert.match(
    styles,
    /\.message-frontmatter-table\s+\.message-table-cell\s*{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は inline code と link を優先しつつ bold を併用できる"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "inline codeやlinkをstrongより先に壊し、同じtextのboldとinline構文を同時にrenderできない"
// observable = "strong、inline code、aの各classとhref/textContent"
// observation_boundary = "component-behavior"
// scope = "markdownComponentsのinline mark/link composition"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は inline code と link を優先しつつ bold を併用できる", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "`**literal**` and **bold [file](src/App.tsx)**",
    }),
  );

  assert.match(
    html,
    /<code class="message-inline-code">\*\*literal\*\*<\/code>/,
  );
  assert.match(html, /<strong class="message-inline-strong">/);
  assert.match(html, /<a href="src\/App\.tsx">file<\/a>/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は fenced code blockだけにaccessibleなcopy操作を表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "fenced code以外にもcopy buttonを表示する、またはcode blockからcopy buttonを落とす"
// observable = "render HTML内のcode-copy-button数とplain paragraphのbutton不在"
// observation_boundary = "component-behavior"
// scope = "markdown code block copy affordance"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は fenced code blockだけにaccessibleなcopy操作を表示する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "plain `inline` text",
        "",
        "````markdown",
        "outer",
        "```ts",
        "const nested = true;",
        "```",
        "",
        "````",
        "",
        "    indented code",
      ].join("\n"),
    }),
  );
  const dom = new JSDOM(html);
  const copyButtons = dom.window.document.querySelectorAll<HTMLButtonElement>(
    ".message-code-copy-button",
  );
  const shell = dom.window.document.querySelector(".message-code-block-shell");
  const actions = shell?.querySelector(".message-code-block-actions");
  const codeBlock = shell?.querySelector("pre.message-code-block");

  assert.equal(copyButtons.length, 1);
  assert.ok(shell);
  assert.ok(actions);
  assert.equal(actions?.parentElement, shell);
  assert.equal(actions?.nextElementSibling, codeBlock);
  assert.equal(
    actions?.querySelector(".message-code-copy-button"),
    copyButtons[0],
  );
  assert.equal(codeBlock?.querySelector(".message-code-copy-button"), null);
  assert.equal(copyButtons[0]?.getAttribute("aria-label"), "Copy code");
  assert.equal(copyButtons[0]?.getAttribute("title"), "Copy code");
  assert.match(
    dom.window.document.querySelector(".message-code-block")?.textContent ?? "",
    /outer\n```ts\nconst nested = true;\n```\n/,
  );
  assert.equal(
    dom.window.document.querySelector(".message-inline-code")?.textContent,
    "inline",
  );
});

// @test-value v2
// kind = "contract"
// claim = "resolveCodeBlockText は改行をLFへ揃えparser由来の末尾改行だけを除く"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "CRLFやparser末尾改行を過剰に残し、または本文の改行まで削る"
// observable = "resolveCodeBlockTextのLF正規化結果と末尾改行除去結果"
// observation_boundary = "component-behavior"
// scope = "resolveCodeBlockText"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("resolveCodeBlockText は改行をLFへ揃えparser由来の末尾改行だけを除く", () => {
  assert.equal(
    resolveCodeBlockText("first\r\nsecond\rthird\n\n"),
    "first\nsecond\nthird\n",
  );
  assert.equal(
    resolveCodeBlockText("without trailing newline"),
    "without trailing newline",
  );
});

// @test-value v2
// kind = "contract"
// claim = "code block copy操作はhover・focus・disabledの視認状態を持つ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "copy buttonのhover/focus/disabled CSS stateが欠ける"
// observable = "stylesheetのbutton ruleにhover、focus-visible、disabledの各指定があること"
// observation_boundary = "declaration"
// scope = "code block copy button state CSS"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("code block copy操作はhover・focus・disabledの視認状態を持つ", async () => {
  const styles = await readStylesheet();
  const buttonRule =
    styles.match(/\.message-code-copy-button\s*{(?<body>[^}]*)}/)?.groups
      ?.body ?? "";
  const hoverRule =
    styles.match(
      /\.message-code-copy-button:hover:not\(:disabled\)\s*{(?<body>[^}]*)}/,
    )?.groups?.body ?? "";
  const focusRule =
    styles.match(/\.message-code-copy-button:focus-visible\s*{(?<body>[^}]*)}/)
      ?.groups?.body ?? "";
  const disabledRule =
    styles.match(/\.message-code-copy-button:disabled\s*{(?<body>[^}]*)}/)
      ?.groups?.body ?? "";

  assert.match(buttonRule, /color:\s*rgba\(255, 255, 255, 0\.94\);/);
  assert.match(buttonRule, /border-radius:\s*999px;/);
  assert.match(hoverRule, /border-color:/);
  assert.match(hoverRule, /background:/);
  assert.match(hoverRule, /transform:\s*translateY\(-1px\);/);
  assert.match(focusRule, /outline:\s*2px solid var\(--teal\);/);
  assert.match(disabledRule, /opacity:\s*0\.64;/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText のcode block copyは本文だけをclipboardへ渡してfeedbackを表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "copy callbackがcode fence markerまでclipboardへ渡す、または成功後toastを表示しない"
// observable = "clipboard writeTextの引数、success feedback text/tone"
// observation_boundary = "component-behavior"
// scope = "MessageRichText code block copy interaction"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText のcode block copyは本文だけをclipboardへ渡してfeedbackを表示する", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const restore = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  const root: Root | null = container ? createRoot(container) : null;
  const copied: string[] = [];
  let resolveWrite: (() => void) | undefined;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
        await new Promise<void>((resolve) => {
          resolveWrite = resolve;
        });
      },
    },
  });

  try {
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: ["```ts", "const first = 1;", "", "```"].join("\n"),
        }),
      );
    });
    const button = container?.querySelector<HTMLButtonElement>(
      ".message-code-copy-button",
    );
    assert.ok(button);

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    assert.deepEqual(copied, ["const first = 1;\n"]);
    assert.equal(button.disabled, true);

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    assert.equal(button.disabled, false);
    assert.equal(
      container?.querySelector(".message-copy-toast")?.textContent,
      "Code copied.",
    );
    assert.equal(
      container?.querySelector(".message-copy-toast")?.getAttribute("role"),
      "status",
    );
  } finally {
    await act(async () => {
      root?.unmount();
    });
    restore();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText のcode block copy失敗はerror feedbackを表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "clipboard write失敗を成功toastとして扱う、またはerror feedbackを表示しない"
// observable = "rejected writeText後のerror feedback role/statusとmessage"
// observation_boundary = "component-behavior"
// scope = "MessageRichText code block copy failure handling"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText のcode block copy失敗はerror feedbackを表示する", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const restore = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  const root: Root | null = container ? createRoot(container) : null;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("clipboard denied");
      },
    },
  });

  try {
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: ["```", "copy me", "```"].join("\n"),
        }),
      );
    });
    const button = container?.querySelector<HTMLButtonElement>(
      ".message-code-copy-button",
    );
    assert.ok(button);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const feedback = container?.querySelector(".message-copy-toast");
    assert.equal(feedback?.textContent, "Could not copy code.");
    assert.ok(feedback?.classList.contains("error"));
  } finally {
    await act(async () => {
      root?.unmount();
    });
    restore();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は Markdown link を既定ナビゲーションではなく openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Markdown link clickがpreventDefaultせず既定navigationだけを実行する"
// observable = "defaultPreventedとonOpenPathへ渡る元target"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は Markdown link を既定ナビゲーションではなく openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "https://example.test/docs#intro",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["https://example.test/docs#intro"]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は encoded HTTP URL を decode せず openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "encoded HTTP targetをdecodeしてcallbackへ渡しhref/callbackのtargetを変える"
// observable = "onOpenPath callback引数がencoded HTTP URLと一致すること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick encoded HTTP target"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は encoded HTTP URL を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "https://example.test/docs/my%20file.md",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["https://example.test/docs/my%20file.md"]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は encoded local link を decode せず openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "encoded local pathをdecodeしてcallbackへ渡しpercent encodingを失う"
// observable = "onOpenPath callback引数がencoded local linkと一致すること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick encoded local target"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は encoded local link を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "docs/my%20file-%E4%BB%95%E6%A7%98.md",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["docs/my%20file-%E4%BB%95%E6%A7%98.md"]);
});

// @test-value v2
// kind = "contract"
// claim = "Markdown link context menuは各種targetを変換せず元targetと座標をmenu requestへ渡す"
// oracle = { type = "contract", ref = "Markdown link context menu target forwarding contract" }
// fault = "URL、mailto、local pathをdecodeまたは別形式へ変換し、copy結果やdefault preventionを壊す"
// observable = "defaultPrevented、menu request target/point、copy result"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkContextMenu target forwarding"
// lifecycle = "permanent"
// @end-test-value
test("handleMarkdownLinkContextMenu は openPath と同じ各種targetを変換せずmenuへ渡す", async () => {
  const targets = [
    "https://example.test/docs/my%20file.md?raw=%2F#intro",
    "mailto:alice+docs@example.test",
    "docs/review-brief%20final.md",
    "file:///C:/tmp/candidate-source%20final.json",
    "C:%5Cworkspace%5Creview-brief.md",
  ];

  for (const target of targets) {
    const { defaultPrevented, requests, result } =
      await openMarkdownLinkContextMenu(target);
    assert.equal(defaultPrevented, true);
    assert.deepEqual(requests, [{ target, point: { x: 120, y: 240 } }]);
    assert.deepEqual(result, { status: "link-copied" });
  }
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkContextMenu は unsafe link と同一ページanchorをcopy対象にしない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "unsafe schemeまたは同一page anchorをcontext menuへ送る"
// observable = "showContextMenuが呼ばれずdefaultPrevented=false、requestsが空であること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkContextMenu filtering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkContextMenu は unsafe link と同一ページanchorをcopy対象にしない", async () => {
  for (const target of [
    "javascript:alert(1)",
    "#message-footnote-example-fn-1",
    "",
  ]) {
    const { defaultPrevented, requests, result } =
      await openMarkdownLinkContextMenu(target);
    assert.equal(defaultPrevented, false);
    assert.deepEqual(requests, []);
    assert.equal(result, null);
  }
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkContextMenu はkeyboard起点のmenu位置をanchorから解決する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "keyboard起点でもmouse座標を使いanchor rectからmenu pointを解決しない"
// observable = "showContextMenu requestのpointがanchor rectのleft/bottomを丸めた値になること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkContextMenu keyboard positioning"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkContextMenu はkeyboard起点のmenu位置をanchorから解決する", async () => {
  let request: { target: string; point: { x: number; y: number } } | null =
    null;
  await handleMarkdownLinkContextMenu(
    {
      clientX: 0,
      clientY: 0,
      currentTarget: {
        getBoundingClientRect: () => ({ left: 32.4, bottom: 48.6 }),
      },
      preventDefault: () => undefined,
    },
    "docs/review-brief.md",
    async (input) => {
      request = input;
      return { status: "dismissed" };
    },
  );

  assert.deepEqual(request, {
    target: "docs/review-brief.md",
    point: { x: 32, y: 49 },
  });
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText はrender済みlinkの右clickでtargetをcopy menuへ渡しfeedbackを表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "render済みlinkのcontext menuがtargetやcopy resultをfeedbackへ伝えない"
// observable = "show menu requestのtarget/point、preventDefault、copy feedback status/text"
// observation_boundary = "component-behavior"
// scope = "MarkdownLink context menu integration"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText はrender済みlinkの右clickでtargetをcopy menuへ渡しfeedbackを表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const requests: Array<{ target: string; point: { x: number; y: number } }> =
    [];
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: {
      async showMarkdownLinkContextMenu(request: {
        target: string;
        point: { x: number; y: number };
      }) {
        requests.push(request);
        return { status: "link-copied" } as const;
      },
    },
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          text: "[candidate](docs/candidate-source%20final.json)",
          forceFullRender: true,
          markdownLinkFileContext: { sessionId: "session-1" },
        }),
      );
    });
    const anchor = container.querySelector("a");
    assert.ok(anchor);
    const contextMenuEvent = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 160,
    });

    await act(async () => {
      anchor.dispatchEvent(contextMenuEvent);
      await Promise.resolve();
    });

    assert.deepEqual(requests, [
      {
        target: "docs/candidate-source%20final.json",
        point: { x: 80, y: 160 },
        fileContext: { sessionId: "session-1" },
      },
    ]);
    assert.equal(contextMenuEvent.defaultPrevented, true);
    assert.equal(
      container.querySelector(".message-link-copy-toast")?.textContent,
      "Link copied.",
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は local/file href の encode を保持して render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "local、file、Windows pathのpercent encodingがdecodeされ、href targetが変化する"
// observable = "render済みa要素のhref属性"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのMarkdown link URL preservation"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
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

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は backslash 形式の Windows absolute path を既定ナビゲーションせず開く"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Windows backslash pathをdefault navigationへ任せonOpenPathへ元pathを渡さない"
// observable = "clickのdefaultPreventedとopened callback引数"
// observation_boundary = "public-boundary"
// scope = "MarkdownLink Windows absolute path click"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は backslash 形式の Windows absolute path を既定ナビゲーションせず開く", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  const opened: string[] = [];
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          text: String.raw`[file](C:\workspace\session-files\report.txt)`,
          forceFullRender: true,
          onOpenPath: (target) => opened.push(target),
        }),
      );
    });

    const anchor = container.querySelector("a");
    assert.ok(anchor);
    assert.equal(
      anchor.getAttribute("href"),
      "C:%5Cworkspace%5Csession-files%5Creport.txt",
    );

    const clickEvent = new dom.window.MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
    });
    const dispatchResult = anchor.dispatchEvent(clickEvent);

    assert.equal(dispatchResult, false);
    assert.equal(clickEvent.defaultPrevented, true);
    assert.deepEqual(opened, ["C:%5Cworkspace%5Csession-files%5Creport.txt"]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は unsafe href を render しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "javascript、vbscript、data:text、または未知custom schemeのhrefが出力され、利用者が意図しないスキームへ遷移できる"
// observable = "render HTMLに4種類のunsafe scheme hrefが存在しないこと"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのunsafe link filtering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は unsafe href を render しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "[javascript](javascript:alert(1))",
        "[vbscript](vbscript:msgbox(1))",
        "[data](data:text/html,<script>alert(1)</script>)",
        "[custom](custom:payload)",
      ].join("\n"),
    }),
  );

  assert.doesNotMatch(
    html,
    /href="(?:javascript|vbscript|data:text|custom):/i,
  );
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は footnote などの同一ページアンカーを既定動作に任せる"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "footnote anchorをopenPathへ送りbrowserのsame-page navigationを妨げる"
// observable = "defaultPrevented=falseとopened配列が空であること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick same-page anchor"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は footnote などの同一ページアンカーを既定動作に任せる", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "#message-footnote-example-fn-1",
  );

  assert.equal(defaultPrevented, false);
  assert.deepEqual(opened, []);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は mailto を openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "mailto targetをdecodeまたは捨てopenPath callbackへ渡さない"
// observable = "opened callback引数がmailto targetと一致すること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick mailto target"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は mailto を openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "mailto:alice@example.test",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["mailto:alice@example.test"]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は encoded mailto を decode せず openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "encoded mailto targetをdecodeしてcallbackへ渡し入力のencodingを失う"
// observable = "opened callback引数がencoded mailto targetと一致すること"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick encoded mailto target"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は encoded mailto を decode せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "mailto:alice@example.test?subject=hello%20world%0D%0A",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, [
    "mailto:alice@example.test?subject=hello%20world%0D%0A",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は protocol-relative URL を元のtargetのまま openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "protocol-relative targetがdefault navigationへ流れる、またはopenPath callbackへ元targetが届かない"
// observable = "defaultPreventedとopened target"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick protocol-relative target"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は protocol-relative URL を openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink("//example.test/docs");

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["//example.test/docs"]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は forward-slash UNC path を local path として openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "forward-slash UNC pathをURL schemeとして扱いopenPath callbackへ渡さない"
// observable = "defaultPreventedとopened callback引数"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick UNC path"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は forward-slash UNC path を local path として openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "//server/share/my%20file.txt",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["//server/share/my%20file.txt"]);
});

// @test-value v2
// kind = "contract"
// claim = "handleMarkdownLinkClick は Windows absolute path を scheme と誤判定せず openPath 経路へ流す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Windows drive pathをscheme付きURLと誤判定しopenPath callbackへ渡さない"
// observable = "defaultPreventedとopened callback引数"
// observation_boundary = "public-boundary"
// scope = "handleMarkdownLinkClick Windows drive path"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("handleMarkdownLinkClick は Windows absolute path を scheme と誤判定せず openPath 経路へ流す", () => {
  const { defaultPrevented, opened } = clickMarkdownLink(
    "C:/workspace/project/src/App.tsx",
  );

  assert.equal(defaultPrevented, true);
  assert.deepEqual(opened, ["C:/workspace/project/src/App.tsx"]);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は GFM table を table 要素として render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "GFM tableをparagraphやlistとして出力しtable header/cell structureを失う"
// observable = "table.message-tableとth/tdのclassおよびtextContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText GFM table rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は GFM table を table 要素として render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "| 置き場 | 持つもの |",
        "| --- | --- |",
        "| `history` | 状態が変わった時だけのイベント |",
      ].join("\n"),
    }),
  );

  assert.match(html, /<table class="message-table">/);
  assert.match(html, /<th class="message-table-heading">置き場<\/th>/);
  assert.match(
    html,
    /<td class="message-table-cell"><code class="message-inline-code">history<\/code><\/td>/,
  );
  assert.doesNotMatch(html, /\| --- \| --- \|/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は2桁番号とnested listをsemanticなordered listとしてrenderする"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "2桁ordered markerとnested listを同一ordered listとして構造化できない"
// observable = "ordered list class、li階層、各li textContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText ordered nested list rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は2桁番号とnested listをsemanticなordered listとしてrenderする", () => {
  const markdown = [
    ...Array.from(
      { length: 11 },
      (_, index) => `${index + 1}. item ${index + 1}`,
    ),
    "12. viewportで折り返す長い本文でもmarkerと本文を別の領域に保つ項目",
    "",
    "    10. nested item 10",
    "    11. nested item 11",
  ].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: markdown }),
  );
  const dom = new JSDOM(html);
  const rootList = dom.window.document.querySelector("ol.message-list.ordered");
  const rootItems = rootList
    ? Array.from(rootList.children).filter(
        (element) => element.tagName === "LI",
      )
    : [];
  const nestedList = rootItems
    .at(-1)
    ?.querySelector(":scope > ol.message-list.ordered");

  assert.ok(rootList);
  assert.equal(rootItems.length, 12);
  assert.equal(
    rootItems[9]?.querySelector(":scope > .message-paragraph")?.textContent,
    "item 10",
  );
  assert.equal(
    rootItems[11]?.querySelector(":scope > .message-paragraph")?.textContent,
    "viewportで折り返す長い本文でもmarkerと本文を別の領域に保つ項目",
  );
  assert.equal(nestedList?.getAttribute("start"), "10");
  assert.deepEqual(
    Array.from(nestedList?.children ?? []).map((item) => item.textContent),
    ["nested item 10", "nested item 11"],
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は2文字ずつのindentをnested unordered listとしてrenderする"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "2-space indentのnested unordered listを親li配下へ構造化できない"
// observable = "ulの入れ子構造と各li textContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText unordered nested list rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は2文字ずつのindentをnested unordered listとしてrenderする", () => {
  const markdown = [
    "- aaa",
    "  - bbbb with **inline** text and viewportで折り返す長い本文",
    "    - cccc",
    "",
    "  child paragraph",
  ].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: markdown }),
  );
  const dom = new JSDOM(html);
  const rootList = dom.window.document.querySelector("ul.message-list");
  const rootItem = rootList?.querySelector(":scope > li");
  const nestedList = rootItem?.querySelector(":scope > ul.message-list");
  const nestedItem = nestedList?.querySelector(":scope > li");
  const deepestList = nestedItem?.querySelector(":scope > ul.message-list");

  assert.ok(rootList);
  assert.equal(
    rootItem?.querySelector(":scope > .message-paragraph")?.textContent,
    "aaa",
  );
  assert.match(
    nestedItem?.textContent ?? "",
    /bbbb with inline text and viewportで折り返す長い本文/,
  );
  assert.equal(
    nestedItem?.querySelector("strong.message-inline-strong")?.textContent,
    "inline",
  );
  assert.equal(deepestList?.querySelector(":scope > li")?.textContent, "cccc");
  assert.equal(
    rootItem?.querySelectorAll(":scope > .message-paragraph").length,
    2,
  );
  assert.equal(
    rootItem?.querySelectorAll(":scope > .message-paragraph")[1]?.textContent,
    "child paragraph",
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は単独のMarkdown list itemを本文wrapperなしのliとしてrenderする"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "単独list itemが余分なwrapperや誤った子要素を持ち、後続paragraphとの構造を壊す"
// observable = "ul直下liの子要素・textContentと後続要素tagName"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのstandalone list rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は単独のMarkdown list itemを本文wrapperなしのliとしてrenderする", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "- Review target:\n\n![alt text](image.png)",
    }),
  );
  const dom = new JSDOM(html);
  const list = dom.window.document.querySelector("ul.message-list");
  const item = list?.querySelector(":scope > li");

  assert.ok(list);
  assert.ok(item);
  assert.equal(item.children.length, 0);
  assert.equal(item.textContent, "Review target:");
  assert.equal(list?.nextElementSibling?.tagName, "P");
});

// @test-value v2
// kind = "contract"
// claim = "Markdown ordered list は2桁marker用の論理方向余白を持ち、独立scroll領域にしない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "ordered list CSSが2桁markerの余白を確保せずlistを独立scroll領域にする"
// observable = "stylesheetのordered list ruleにlogical paddingとoverflow-y指定があること"
// observation_boundary = "declaration"
// scope = "Markdown ordered list CSS declaration"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("Markdown ordered list は2桁marker用の論理方向余白を持ち、独立scroll領域にしない", async () => {
  const styles = await readStylesheet();
  const orderedListRule =
    styles.match(/\.message-list\.ordered\s*{(?<body>[^}]*)}/)?.groups?.body ??
    "";
  const sharedScrollableLists =
    styles.match(
      /\.session-list,[\s\S]*?\.summary-list\s*{(?<body>[^}]*)}/,
    )?.[0] ?? "";

  assert.match(orderedListRule, /padding-inline-start:\s*2\.25em;/);
  assert.match(styles, /\.session-list,[\s\S]*?\.summary-list\s*{(?<body>[^}]*)}/);
  assert.doesNotMatch(orderedListRule, /padding-left:/);
  assert.doesNotMatch(sharedScrollableLists, /\.message-list,/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は browser 初回 render を light markdown にして後から full markdown に差し替える"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "browser初回表示をfullへ同期実行しlight modeを経由しない、または後続fullへ切替できない"
// observable = "data-markdown-render-modeのlightからfullへの遷移"
// observation_boundary = "component-behavior"
// scope = "MessageRichText deferred render mode"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は browser 初回 render を light markdown にして後から full markdown に差し替える", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
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
      root?.render(
        React.createElement(MessageRichText, {
          text: ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
        }),
      );
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "light",
    );
    assert.equal(container.querySelector("table"), null);

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "full",
    );
    assert.notEqual(container.querySelector("table.message-table"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は browser の light render でも先頭 YAML frontmatter を表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "light rendererでfrontmatterを無視しfull切替後にtable/fallback表示が変わる"
// observable = "light/full各modeのdata属性、frontmatter table aria-label、fallback pre不在"
// observation_boundary = "component-behavior"
// scope = "MessageRichText light frontmatter rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は browser の light render でも先頭 YAML frontmatter を表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const markdown = [
    "---",
    "name: withmate-memory",
    "description: light render",
    "---",
    "",
    "# Body",
  ].join("\n");

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(MessageRichText, { text: markdown }));
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "light",
    );
    assert.deepEqual(
      Array.from(
        container.querySelectorAll("table.message-frontmatter-table tr"),
      ).map((row) => [
        row.querySelector("th")?.textContent,
        row.querySelector("td")?.textContent,
      ]),
      [
        ["name", "withmate-memory"],
        ["description", "light render"],
      ],
    );
    assert.equal(
      container.querySelector("pre.message-frontmatter-block"),
      null,
    );
    assert.equal(
      container.querySelector("h1.message-heading")?.textContent,
      "Body",
    );

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "full",
    );
    assert.equal(
      container
        .querySelector("table.message-frontmatter-table")
        ?.getAttribute("aria-label"),
      "YAML frontmatter",
    );
    assert.equal(
      container.querySelector("pre.message-frontmatter-block"),
      null,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は light から full へ切り替わっても HTML br の改行を維持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "lightからfullへ切替時にbr pluginを失いbr要素数や改行textが変わる"
// observable = "light/full各modeとbr要素数"
// observation_boundary = "component-behavior"
// scope = "MessageRichText render mode transition"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は light から full へ切り替わっても HTML br の改行を維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
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
      root?.render(
        React.createElement(MessageRichText, { text: "first<br />second" }),
      );
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "light",
    );
    assert.equal(container.querySelectorAll("br").length, 1);

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "full",
    );
    assert.equal(container.querySelectorAll("br").length, 1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "forceFullRender=trueを指定したMessageRichTextはfull rendererへ切り替える"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "forceFullRender=trueを渡してもlight modeのまま、またはfull rendererのGFM tableを生成しない"
// observable = "forceFullRender=true後のdata-markdown-render-mode属性とtable.message-table要素"
// observation_boundary = "component-behavior"
// scope = "MessageRichText forceFullRender prop"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は既存表示で検索を始めた瞬間に full rendererへ切り替える", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const markdown = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(MessageRichText, { text: markdown }));
    });
    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "light",
    );

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          text: markdown,
          forceFullRender: true,
        }),
      );
    });

    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "full",
    );
    assert.notEqual(container.querySelector("table.message-table"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "resolveMessageMarkdownRenderMode はeffect前のlight stateより検索中のfull指定を優先する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "renderStateのlight stateをforceFullRender=trueが上書きせずfull modeを返さない"
// observable = "resolveMessageMarkdownRenderModeの戻り値"
// observation_boundary = "component-behavior"
// scope = "resolveMessageMarkdownRenderMode"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("resolveMessageMarkdownRenderMode はeffect前のlight stateより検索中のfull指定を優先する", () => {
  assert.equal(
    resolveMessageMarkdownRenderMode(
      true,
      "same text",
      { text: "same text", mode: "light" },
      false,
    ),
    "full",
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は GFM 拡張記法を render する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "GFM拡張のtask/list/tableなどを通常paragraphとしてrenderしsemantic DOMを失う"
// observable = "GFM由来のtable/list要素とclass/textContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText GFM component mapping"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は GFM 拡張記法を render する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "~~old~~",
        "",
        "- [x] done",
        "",
        "https://example.test",
        "",
        "note[^1]",
        "",
        "[^1]: footnote",
      ].join("\n"),
    }),
  );

  assert.match(html, /<del>old<\/del>/);
  assert.match(
    html,
    /<li class="task-list-item"><input type="checkbox" disabled="" checked=""/,
  );
  assert.match(
    html,
    /<a href="https:\/\/example\.test">https:\/\/example\.test<\/a>/,
  );
  assert.match(html, /data-footnote-ref="true"/);
  assert.match(html, /id="message-footnote-[^"]+-fn-1"/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は footnote の DOM ID と aria 参照を message ごとに分離する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "複数messageのfootnoteが同じDOM idを使いaria-describedby参照が衝突する"
// observable = "二つのrender結果のfootnote idとaria-describedbyが異なること"
// observation_boundary = "component-behavior"
// scope = "MessageRichText footnote id namespace"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
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

  const footnoteIds = [
    ...html.matchAll(/id="(message-footnote-[^"]+-fn-1)"/g),
  ].map((match) => match[1]);
  const footnoteLabelIds = [
    ...html.matchAll(/id="(message-footnote-[^"]+-footnote-label)"/g),
  ].map((match) => match[1]);
  const ariaLabelIds = [
    ...html.matchAll(
      /aria-describedby="(message-footnote-[^"]+-footnote-label)"/g,
    ),
  ].map((match) => match[1]);

  assert.equal(new Set(footnoteIds).size, 2);
  assert.equal(new Set(footnoteLabelIds).size, 2);
  assert.deepEqual(ariaLabelIds, footnoteLabelIds);
  assert.doesNotMatch(html, /id="footnote-label"/);
  assert.doesNotMatch(html, /aria-describedby="footnote-label"/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は GFM table alignment を th と td に引き継ぐ"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "GFM table alignmentをthだけまたはtdだけへ適用し指定方向のstyleを失う"
// observable = "th/tdのstyle text-alignとclass"
// observation_boundary = "component-behavior"
// scope = "MessageRichText GFM table alignment"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は GFM table alignment を th と td に引き継ぐ", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "| left | center | right |",
        "| :--- | :---: | ---: |",
        "| a | b | c |",
      ].join("\n"),
    }),
  );

  assert.match(
    html,
    /<th style="text-align:left" class="message-table-heading">left<\/th>/,
  );
  assert.match(
    html,
    /<th style="text-align:center" class="message-table-heading">center<\/th>/,
  );
  assert.match(
    html,
    /<th style="text-align:right" class="message-table-heading">right<\/th>/,
  );
  assert.match(
    html,
    /<td style="text-align:left" class="message-table-cell">a<\/td>/,
  );
  assert.match(
    html,
    /<td style="text-align:center" class="message-table-cell">b<\/td>/,
  );
  assert.match(
    html,
    /<td style="text-align:right" class="message-table-cell">c<\/td>/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は double-dollar math を render し、金額表現の single dollar は維持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "double-dollar mathを通常textにし金額のsingle dollarまで数式として解釈する"
// observable = "katex/katex-display classと$5/$10 text"
// observation_boundary = "component-behavior"
// scope = "MessageRichText math rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は double-dollar math を render し、金額表現の single dollar は維持する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "Inline $$a^2 + b^2$$ math",
        "",
        "$$",
        "a^2 + b^2 = c^2",
        "$$",
        "",
        "$5 and $10",
      ].join("\n"),
    }),
  );

  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /\$5 and \$10/);
});

// @test-value v2
// kind = "contract"
// claim = "SSRのMessageRichTextはMermaid code blockをfallback containerとしてrenderしcopy操作を表示しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "SSRでMermaid code blockのfallback containerまたはlanguage-mermaid codeを出さずcopy buttonを表示する"
// observable = "renderToStaticMarkupのmessage-mermaid fallback div、language-mermaid code text、copy button不在"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのSSR Mermaid fallback"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は Mermaid code block をdiagram用containerとしてrenderし、copy操作を表示しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
    }),
  );
  const dom = new JSDOM(html);

  assert.match(html, /<div class="message-mermaid fallback">/);
  assert.match(
    html,
    /<code class="message-inline-code language-mermaid">flowchart TD\n  A --&gt; B\n<\/code>/,
  );
  assert.equal(
    dom.window.document.querySelector(".message-code-copy-button"),
    null,
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は code literal 内の local path link 風テキストを改変しない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "code literal内のlocal path風文字列をMarkdown linkとして変換する"
// observable = "code要素内のlocal path風textContentとa要素不在"
// observation_boundary = "component-behavior"
// scope = "MessageRichText code literal preservation"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
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

  assert.match(
    html,
    /<code class="message-inline-code">\[log\]\(C:\/tmp\/log file\.txt\)<\/code>/,
  );
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code language-txt">\[sample\]\(meeting notes\.md\)<\/code><\/pre>/,
  );
  assert.match(html, /\[indented\]\(meeting notes\.md\)/);
  assert.match(html, /\[tabbed\]\(meeting notes\.md\)/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は local / data / external Markdown image を既定表示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "許可されたlocal、data、external、protocol-relative imageのいずれかがimgとして表示されない、またはURL正規化が失われる"
// observable = "img要素数と各imgのsrc属性"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのMarkdown image URL rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は local / data / external Markdown image を既定表示する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![local](file:///C:/tmp/secret.png)",
        "![embedded](data:image/png;base64,AAAA)",
        "![remote](https://example.test/image.png)",
        "![protocol-relative](//cdn.example.test/image.png)",
      ].join("\n"),
    }),
  );

  assert.equal((html.match(/<img\b/g) ?? []).length, 4);
  assert.match(html, /src="file:\/\/\/C:\/tmp\/secret\.png"/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.match(html, /src="https:\/\/example\.test\/image\.png"/);
  assert.match(html, /src="https:\/\/cdn\.example\.test\/image\.png"/);
});

// @test-value v2
// kind = "invariant"
// claim = "MessageRichText は local image を優先読込し external image は遅延読込する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "local/data imageがlazyになり、またはexternal imageがeagerになって通信優先度契約を破る"
// observable = "各imgのloadingとfetchpriority属性"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのimage loading priority boundary"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は local image を優先読込し external image は遅延読込する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![local](file:///C:/tmp/local.png)",
        "![embedded](data:image/png;base64,AAAA)",
        "![remote](https://example.test/image.png)",
      ].join("\n"),
    }),
  );
  const dom = new JSDOM(html);
  const images = Array.from(dom.window.document.querySelectorAll("img"));

  assert.equal(images[0]?.getAttribute("loading"), "eager");
  assert.equal(images[0]?.getAttribute("fetchpriority"), "high");
  assert.equal(images[1]?.getAttribute("loading"), "eager");
  assert.equal(images[1]?.getAttribute("fetchpriority"), "high");
  assert.equal(images[2]?.getAttribute("loading"), "lazy");
  assert.equal(images[2]?.getAttribute("fetchpriority"), "auto");
});

// @test-value v2
// kind = "invariant"
// claim = "高速に完了するMarkdown画像はloading補助UIを表示せず、load完了後も通常表示を維持する"
// oracle = { type = "contract", ref = "Issue #714: 画像loading表示は遅延し、完了時に除去する" }
// fault = "画像が閾値未満で完了してもloading表示が一瞬出る、または完了後にloading状態が残る"
// observable = "画像DOM、message-image-loading要素、setTimeoutの保留状態"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextの直接Markdown画像loading境界"
// lifecycle = "permanent"
// impact = "短時間の画像表示で会話本文へ不要な文字・高さ変化を持ち込む"
// distinction = "画像のsrcやload eventだけでなく、閾値前のloading UI不在と完了時のtimer破棄を観測する"
// @end-test-value
test("MessageRichText は直接 image を表示しながら load 完了後に loading 表示を消す", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![cached](data:image/png;base64,AAAA)",
        }),
      );
    });

    const image = container.querySelector("img");
    assert.ok(image);
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.deepEqual(
      Array.from(timers.pending.values()).map((timer) => timer.delay),
      [1_000],
    );

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });

    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "未完了の直接Markdown画像だけが閾値後に画像領域内のspinnerを表示し、完了時に除去する"
// oracle = { type = "contract", ref = "Issue #714: 高速loadでは非表示、遅いloadでは遅延spinner" }
// fault = "遅い画像の待機中にspinnerが出ない、spinnerが本文の高さを占有する、またはload後も残る"
// observable = "message-image-shellの状態、画像DOM、message-image-loadingのrole・aria-label"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextの直接Markdown画像遅延表示境界"
// lifecycle = "permanent"
// impact = "入力中の会話表示へ不要なloading文字やレイアウト変化を持ち込まず、遅いresourceだけを識別可能にする"
// distinction = "高速loadのtimer破棄とは別に、保留timer発火後のspinner表示とload eventによる除去を観測する"
// @end-test-value
test("MessageRichText は遅い直接 image だけに領域内 spinner を表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![slow](data:image/png;base64,AAAA)",
        }),
      );
    });

    const image = container.querySelector<HTMLImageElement>(".message-image");
    const timerEntry = Array.from(timers.pending.entries())[0];
    const shell = container.querySelector<HTMLElement>(".message-image-shell");
    assert.ok(image);
    assert.ok(timerEntry);
    assert.ok(shell);
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timerEntry[1].delay, 1_000);

    timers.pending.delete(timerEntry[0]);
    await act(async () => {
      timerEntry[1].callback();
    });

    const loading = container.querySelector<HTMLElement>(
      ".message-image-loading",
    );
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      image,
    );
    assert.ok(loading);
    assert.equal(loading.getAttribute("role"), "status");
    assert.equal(loading.getAttribute("aria-label"), "Loading image");
    assert.equal(loading.textContent, "");
    assert.equal(loading.parentElement, shell);
    assert.doesNotMatch(container.textContent ?? "", /Image loading/);

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });

    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "resolverのresolvingからloadingへの同一resource遷移では画像loadingの待機タイマーを継続する"
// oracle = { type = "contract", ref = "Issue #714: resolving→loadingは連続した待ちとして扱う" }
// fault = "resolver完了時にtimerを再開始して遅い画像のspinner表示が遅れ続ける、または完了後に表示が残る"
// observable = "resolver完了前後のmessage-image-loading、resolved image DOM、保留timer"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのresolver付きMarkdown画像lifecycle"
// lifecycle = "permanent"
// impact = "local image previewが遅延しているときも待機状態を正しく示し、resource完了後に操作可能な画像へ戻す"
// distinction = "直接画像のload eventとは別に、制御可能なresolver Promiseと同一timerを跨ぐ状態遷移を観測する"
// @end-test-value
test("MessageRichText は resolver の resolving から loading へ spinner 待機を継続する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  let resolveImage: ((source: string | null) => void) | undefined;
  const resolver = () =>
    new Promise<string | null>((resolve) => {
      resolveImage = resolve;
    });

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![slow local](images/sample.png)",
          resolveImageSource: resolver,
        }),
      );
    });

    const timerEntry = Array.from(timers.pending.entries())[0];
    assert.ok(timerEntry);
    assert.equal(container.querySelector(".message-image"), null);
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      resolveImage?.("data:image/png;base64,AAAA");
      await Promise.resolve();
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(image);
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 1);
    assert.ok(timers.pending.has(timerEntry[0]));

    timers.pending.delete(timerEntry[0]);
    await act(async () => {
      timerEntry[1].callback();
    });
    assert.ok(container.querySelector(".message-image-loading"));

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "resolver完了後も遅延spinnerは画像のload完了まで表示を維持し、load時に除去する"
// oracle = { type = "contract", ref = "Issue #714: resolver完了後も遅い画像のloading表示を維持する" }
// fault = "resolver完了時に表示中のspinnerが消え、画像load完了前に待機状態が見えなくなる"
// observable = "resolver完了前後のmessage-image-loading、resolved image DOM、load後のloading表示"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのresolver付きMarkdown画像遅延表示境界"
// lifecycle = "permanent"
// impact = "resolver処理と画像network loadの待機を分離し、画像が実際に操作可能になるまでloading状態を示す"
// distinction = "resolver完了前にtimerを跨ぐ継続確認とは別に、spinner表示後のresolver完了からimg loadまでの状態遷移を観測する"
// @end-test-value
test("MessageRichText はresolver完了後も表示済みspinnerを画像loadまで維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  let resolveImage: ((source: string | null) => void) | undefined;
  const resolver = () =>
    new Promise<string | null>((resolve) => {
      resolveImage = resolve;
    });

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![slow local](images/sample.png)",
          resolveImageSource: resolver,
        }),
      );
    });

    const timerEntry = Array.from(timers.pending.entries())[0];
    assert.ok(timerEntry);
    timers.pending.delete(timerEntry[0]);
    await act(async () => {
      timerEntry[1].callback();
    });
    assert.ok(container.querySelector(".message-image-loading"));
    assert.equal(container.querySelector(".message-image"), null);

    await act(async () => {
      resolveImage?.("data:image/png;base64,AAAA");
      await Promise.resolve();
      await Promise.resolve();
    });
    const image = container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(image);
    assert.ok(container.querySelector(".message-image-loading"));

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(container.querySelector(".message-image-loading"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Markdown画像resolverはsource変更とresolver世代変更で現行resourceだけを表示し、stale blobと待機timerを解放する"
// oracle = { type = "contract", ref = "Issue #714: source／resource generation変更は現行resourceへ再解決する" }
// fault = "旧sourceまたは旧resolver世代の完了が新しい画像を上書きする、同じsourceのreloadを取りこぼす、または旧blob・timerが残る"
// observable = "resolver呼出し引数、画像src、画像DOM、URL.revokeObjectURL呼出し、保留timer"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのresolver付きMarkdown画像resource lifecycle"
// lifecycle = "permanent"
// impact = "file previewの再読込や世代更新後に古い画像が表示へ戻らず、読み込み待機状態とowned blob URLがリークしない"
// distinction = "resolver正常系の一回限りの表示確認とは別に、source変更・stale completion・pending中のresolver世代変更・同一sourceの再解決・unmountを一連の状態遷移として観測する"
// @end-test-value
test("MessageRichText はsource変更とresolver世代変更でstale resourceを表示せず解放する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revokedObjectUrls: string[] = [];
  URL.revokeObjectURL = (value) => {
    revokedObjectUrls.push(value);
  };
  let root: Root | null = null;
  const oldSource = createDeferred<string | null>();
  const currentSource = createDeferred<string | null>();
  const staleGenerationSource = createDeferred<string | null>();
  const reloadedSource = createDeferred<string | null>();
  const resolverCalls: string[] = [];
  const firstResolver = (source: string) => {
    resolverCalls.push(`first:${source}`);
    if (source.includes("old")) return oldSource.promise;
    return currentSource.promise;
  };
  const intermediateResolver = (source: string) => {
    resolverCalls.push(`intermediate:${source}`);
    return staleGenerationSource.promise;
  };
  const reloadResolver = (source: string) => {
    resolverCalls.push(`reload:${source}`);
    return reloadedSource.promise;
  };

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![old](images/old.png)",
          resolveImageSource: firstResolver,
        }),
      );
    });
    assert.deepEqual(resolverCalls, ["first:images/old.png"]);
    assert.equal(timers.pending.size, 1);
    const initialTimerId = Array.from(timers.pending.keys())[0];
    assert.ok(initialTimerId);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![old](images/old.png)",
          onOpenPath: () => undefined,
          resolveImageSource: firstResolver,
        }),
      );
    });
    assert.deepEqual(resolverCalls, ["first:images/old.png"]);
    assert.equal(timers.pending.size, 1);
    assert.ok(timers.pending.has(initialTimerId));

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![current](images/current.png)",
          resolveImageSource: firstResolver,
        }),
      );
    });
    assert.deepEqual(resolverCalls, [
      "first:images/old.png",
      "first:images/current.png",
    ]);
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      currentSource.resolve("blob:current-source");
      await Promise.resolve();
      await Promise.resolve();
    });
    const currentImage =
      container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(currentImage);
    assert.equal(currentImage.src, "blob:current-source");
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      oldSource.resolve("blob:stale-source");
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(revokedObjectUrls.includes("blob:stale-source"));
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      currentImage,
    );
    assert.equal(currentImage.src, "blob:current-source");
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      currentImage.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(timers.pending.size, 0);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![current](images/current.png)",
          resolveImageSource: intermediateResolver,
        }),
      );
    });
    assert.deepEqual(resolverCalls, [
      "first:images/old.png",
      "first:images/current.png",
      "intermediate:images/current.png",
    ]);
    assert.ok(revokedObjectUrls.includes("blob:current-source"));
    assert.equal(container.querySelector(".message-image"), null);
    assert.equal(timers.pending.size, 1);
    const intermediateTimerId = Array.from(timers.pending.keys())[0];
    assert.ok(intermediateTimerId);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![current](images/current.png)",
          resolveImageSource: reloadResolver,
        }),
      );
    });
    assert.deepEqual(resolverCalls, [
      "first:images/old.png",
      "first:images/current.png",
      "intermediate:images/current.png",
      "reload:images/current.png",
    ]);
    assert.equal(container.querySelector(".message-image"), null);
    assert.equal(timers.pending.size, 1);
    const reloadTimerId = Array.from(timers.pending.keys())[0];
    assert.ok(reloadTimerId);
    assert.notEqual(reloadTimerId, intermediateTimerId);
    assert.ok(!timers.pending.has(intermediateTimerId));

    await act(async () => {
      staleGenerationSource.resolve("blob:stale-generation");
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(revokedObjectUrls.includes("blob:stale-generation"));
    assert.equal(container.querySelector(".message-image"), null);
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      reloadedSource.resolve("blob:reloaded-source");
      await Promise.resolve();
      await Promise.resolve();
    });
    const reloadedImage =
      container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(reloadedImage);
    assert.equal(reloadedImage.src, "blob:reloaded-source");

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    assert.ok(revokedObjectUrls.includes("blob:reloaded-source"));
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.revokeObjectURL = originalRevokeObjectURL;
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "resolverがnullまたはrejectしたMarkdown画像は失敗表示へ収束し、遅延spinnerと待機timerを残さない"
// oracle = { type = "contract", ref = "Issue #714: 画像resolverの失敗時はerror表示へ遷移し無限spinnerを持たない" }
// fault = "resolver失敗後もloading spinnerが残る、失敗を通常本文へ表示する、またはtimerが孤児化する"
// observable = "message-image-error、message-image-loading、resolver失敗後の保留timer"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのresolver失敗境界"
// lifecycle = "permanent"
// impact = "認証失敗や読み込み失敗時に会話が無限loadingへ見え続けず、失敗後に待機timerが残らない"
// distinction = "resolver成功時の画像src確認とは別に、遅延indicator timerが保留中のnull戻りとrejectをerrorへ収束させる"
// @end-test-value
test("MessageRichText はresolverのnullとrejectをspinnerなしのerrorへ収束する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const nullFailure = createDeferred<string | null>();
  const rejectedFailure = createDeferred<string | null>();
  const resolver = (source: string) =>
    source.includes("reject.png")
      ? rejectedFailure.promise
      : nullFailure.promise;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: [
            "![null failure](images/null.png)",
            "![rejected failure](images/reject.png)",
          ].join("\n"),
          resolveImageSource: resolver,
        }),
      );
    });

    assert.equal(timers.pending.size, 2);
    await act(async () => {
      nullFailure.resolve(null);
      rejectedFailure.reject(new Error("preview failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(container.querySelectorAll(".message-image-error").length, 2);
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "source変更後に旧resolverがrejectしても、現行resourceの画像をerrorへ戻さず表示を保持する"
// oracle = { type = "contract", ref = "Issue #714: staleな画像resourceの完了は現行表示を上書きしない" }
// fault = "旧sourceのrejectが現行画像のstateをerrorへ遷移させ、表示済み画像を失わせる"
// observable = "現行画像のDOM identity・src、message-image-error、stale resolverのreject後の状態"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのsource変更後stale reject境界"
// lifecycle = "permanent"
// impact = "会話更新中に後着した旧resourceの失敗が現行画像の操作可能状態を壊さない"
// distinction = "stale成功blobの解放確認とは別に、現行画像表示後の旧resolver rejectがstateを汚染しないことを観測する"
// @end-test-value
test("MessageRichText は現行画像表示後のstale resolver rejectを無視する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const staleSource = createDeferred<string | null>();
  const currentSource = createDeferred<string | null>();

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![stale](images/stale.png)",
          resolveImageSource: () => staleSource.promise,
        }),
      );
    });
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![current](images/current.png)",
          resolveImageSource: () => currentSource.promise,
        }),
      );
    });
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      currentSource.resolve("blob:current-after-stale");
      await Promise.resolve();
      await Promise.resolve();
    });
    const currentImage =
      container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(currentImage);
    assert.equal(currentImage.src, "blob:current-after-stale");

    await act(async () => {
      staleSource.reject(new Error("stale source failed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      currentImage,
    );
    assert.equal(currentImage.src, "blob:current-after-stale");
    assert.equal(container.querySelector(".message-image-error"), null);
    assert.equal(container.querySelector(".message-image-loading"), null);

    await act(async () => {
      currentImage.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "直接Markdown画像のload失敗は遅延spinnerとtimerを除去してerror表示へ遷移する"
// oracle = { type = "contract", ref = "Issue #714: 画像load失敗時は無限spinnerを表示しない" }
// fault = "直接画像のnetwork errorでspinnerが残り続ける、またはerror表示へ遷移しない"
// observable = "message-image-loading、message-image-error、保留timer"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextの直接Markdown画像failure lifecycle"
// lifecycle = "permanent"
// impact = "壊れた画像resourceが会話本文のloading状態を永続化しない"
// distinction = "resolver失敗のreject/nullとは別に、遅延indicator timerが保留中のブラウザimg element error eventを直接観測する"
// @end-test-value
test("MessageRichText は直接画像のload errorをspinnerなしのerrorへ収束する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![broken](data:image/png;base64,AAAA)",
        }),
      );
    });
    const image = container.querySelector<HTMLImageElement>(".message-image");
    assert.ok(image);
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("error"));
    });
    const error = container.querySelector<HTMLElement>(".message-image-error");
    assert.equal(error?.getAttribute("role"), "alert");
    assert.equal(error?.textContent, "Image could not be loaded.");
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(timers.pending.size, 0);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "resolver未完了のMarkdown画像はunmount時に待機timerを破棄し、遅れて届くowned blobを表示せず解放する"
// oracle = { type = "contract", ref = "Issue #714: unmount時は画像resourceと遅延表示を停止する" }
// fault = "unmount後も画像loading timerが残る、遅延resolver完了がDOMを書き換える、またはblob URLが解放されない"
// observable = "unmount前後の保留timer、画像DOM、URL.revokeObjectURL呼出し"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのresolver unmount cleanup境界"
// lifecycle = "permanent"
// impact = "会話切替や画面破棄後に旧画像の非同期処理が表示とresourceを保持し続けない"
// distinction = "source／resolver世代切替中のstale completionとは別に、resolver未完了のままcomponentを破棄する経路を観測する"
// @end-test-value
test("MessageRichText はresolver未完了のunmountでtimerと遅延blobを解放する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const timers = installControlledTimers(dom.window);
  const container = dom.window.document.getElementById("root");
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revokedObjectUrls: string[] = [];
  URL.revokeObjectURL = (value) => {
    revokedObjectUrls.push(value);
  };
  let root: Root | null = null;
  const pendingSource = createDeferred<string | null>();

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![pending](images/pending.png)",
          resolveImageSource: () => pendingSource.promise,
        }),
      );
    });
    assert.equal(timers.pending.size, 1);

    await act(async () => {
      root?.unmount();
    });
    assert.equal(timers.pending.size, 0);

    await act(async () => {
      pendingSource.resolve("blob:after-unmount");
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(revokedObjectUrls.includes("blob:after-unmount"));
    assert.equal(container.querySelector(".message-image"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    URL.revokeObjectURL = originalRevokeObjectURL;
    timers.restore();
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Markdownの同じ位置にある画像はcallback更新、本文末尾追記、light/full切替で同じDOMとready状態を保持し、link操作は最新callbackを使う"
// oracle = { type = "contract", ref = "Issue #714: Markdown component identityとcallback contextの安定化" }
// fault = "renderごとにimg component typeが変わって画像が再mountされる、ready stateが初期化される、またはlinkが古いclosureを呼ぶ"
// observable = "画像HTMLElementのidentity、loading表示、link callbackの受信値、Markdown render mode"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextのMarkdown component identity境界"
// lifecycle = "permanent"
// impact = "入力に伴う親更新で既存会話画像が点滅・再取得されず、操作対象だけは最新session contextを維持する"
// distinction = "親callbackだけを安定化するcolumn testとは別に、Markdown renderer自身のcomponent identityとlight/full更新を直接観測する"
// @end-test-value
test("MessageRichText は画像DOMを保持し、更新後のlink callbackを使う", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const opened: string[] = [];
  const initialText =
    "[open](C:/workspace/old.txt)\n\n![cached](data:image/png;base64,AAAA)";
  const appendedText = `${initialText}\n\nappended text`;

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: initialText,
          onOpenPath: (target: string) => opened.push(`old:${target}`),
        }),
      );
    });

    const image = container.querySelector<HTMLImageElement>(".message-image");
    const link = container.querySelector<HTMLAnchorElement>("a");
    const trigger = image?.closest<HTMLButtonElement>(".message-image-trigger");
    assert.ok(image);
    assert.ok(link);
    assert.ok(trigger);
    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(trigger.disabled, false);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: initialText,
          onOpenPath: (target: string) => opened.push(`new:${target}`),
        }),
      );
    });
    link.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    assert.deepEqual(opened, ["new:C:/workspace/old.txt"]);
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      image,
    );
    assert.equal(container.querySelector(".message-image-loading"), null);
    assert.equal(trigger.disabled, false);

    await act(async () => {
      root?.render(
        React.createElement(MessageRichText, {
          text: appendedText,
          onOpenPath: (target: string) => opened.push(`latest:${target}`),
        }),
      );
    });
    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "light",
    );
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      image,
    );
    assert.equal(container.querySelector(".message-image-loading"), null);
    link.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    assert.deepEqual(opened, [
      "new:C:/workspace/old.txt",
      "latest:C:/workspace/old.txt",
    ]);
    assert.equal(trigger.disabled, false);

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });
    assert.equal(
      container
        .querySelector("[data-markdown-render-mode]")
        ?.getAttribute("data-markdown-render-mode"),
      "full",
    );
    assert.equal(
      container.querySelector<HTMLImageElement>(".message-image"),
      image,
    );
    assert.equal(container.querySelector(".message-image-loading"), null);
    link.dispatchEvent(
      new dom.window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    assert.deepEqual(opened, [
      "new:C:/workspace/old.txt",
      "latest:C:/workspace/old.txt",
      "latest:C:/workspace/old.txt",
    ]);
    assert.equal(
      container.querySelector<HTMLButtonElement>(".message-image-trigger"),
      trigger,
    );
    assert.equal(trigger.disabled, false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Markdown画像の遅延spinnerはCSS上で画像領域へ重なり、通常animationと後続のreduced-motion無効化を持つ"
// oracle = { type = "contract", ref = "Issue #714: spinnerは周辺高さを変えず、prefers-reduced-motionに配慮する" }
// fault = "spinnerが本文へ一行を追加して画像周囲を押し下げる、またはreduced-motionでも回転し続ける"
// observable = "message-image-loadingとmessage-image-shellのCSS declarationと適用順"
// observation_boundary = "declaration"
// scope = "MessageRichText画像loading UIのstylesheet declaration"
// lifecycle = "permanent"
// impact = "遅延表示の出入りで会話スクロールを揺らさず、動きを抑えたい利用者の設定を尊重する"
// distinction = "DOMでは算出できないoverlay配置、pointer event、spinner animation、通常ruleより後ろにあるreduced-motion overrideの適用順をstylesheet declarationから観測する"
// @end-test-value
test("MessageRichText の画像 spinner は領域内 overlay と reduced-motion を持つ", async () => {
  const styles = await readStylesheet();
  const loadingRule =
    styles.match(/\.message-image-loading\s*{(?<body>[^}]*)}/)?.groups?.body ??
    "";
  const shellRule =
    styles.match(/\.message-image-shell\s*{(?<body>[^}]*)}/)?.groups?.body ??
    "";
  const spinnerRuleMatch =
    /\.message-image-loading::before\s*{(?=[^}]*animation:\s*message-image-loading-spin)[^}]*}/.exec(
      styles,
    );
  const spinnerRule = spinnerRuleMatch?.[0] ?? "";
  const reducedMotionRuleMatch =
    /\.message-image-loading::before\s*{(?=[^}]*animation:\s*none;)[^}]*}/.exec(
      styles,
    );

  assert.match(loadingRule, /position:\s*absolute;/);
  assert.match(loadingRule, /inset:\s*[^;]+;/);
  assert.match(loadingRule, /pointer-events:\s*none;/);
  assert.match(shellRule, /position:\s*relative;/);
  assert.match(spinnerRule, /animation:\s*message-image-loading-spin/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.message-image-loading::before\s*{[\s\S]*?animation:\s*none;/,
  );
  assert.ok(spinnerRuleMatch);
  assert.ok(reducedMotionRuleMatch);
  assert.ok(reducedMotionRuleMatch.index > spinnerRuleMatch.index);
});

// @test-value v2
// kind = "regression"
// claim = "ImageViewportはFitの実効倍率を画像描画へ適用し、その倍率をZoom Inの基準にする"
// oracle = { type = "contract", ref = "ユーザー要求: feat-message-image-lightbox引継ぎの確定した仕様" }
// fault = "Fit倍率の表示だけが更新されて画像へ適用されず、画像がviewportから見切れたままになる"
// observable = "画像のstyle.zoomとReset image zoomおよびZoom In後の倍率表示"
// observation_boundary = "component-behavior"
// scope = "共有ImageViewportの画像描画境界"
// lifecycle = "permanent"
// distinction = "Fit倍率の計算unit testとは異なり、計算結果が画像styleと後続Zoom Inへ投影されることを観測する"
// @end-test-value
test("ImageViewport はFit実効倍率を画像描画とZoom Inへ反映する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;

  function ImageViewportHarness() {
    const controller = useImageViewport("image-source");
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(ImageZoomControls, { controller }),
      React.createElement(ImageViewport, {
        controller,
        src: "data:image/png;base64,AAAA",
        alt: "fit target",
      }),
    );
  }

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(ImageViewportHarness));
    });
    const viewport = container.querySelector<HTMLElement>(".image-viewport");
    const image = container.querySelector<HTMLImageElement>(
      ".image-viewport-image",
    );
    assert.ok(viewport);
    assert.ok(image);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 450 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1600 },
      naturalHeight: { configurable: true, value: 900 },
    });

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Reset image zoom to 100%']",
      )?.textContent,
      "50%",
    );
    assert.equal(image.style.zoom, "0.5");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")
        ?.click();
    });
    assert.equal(
      container.querySelector<HTMLButtonElement>(
        "button[aria-label='Reset image zoom to 100%']",
      )?.textContent,
      "60%",
    );
    assert.equal(image.style.zoom, "0.6");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "読込済みのメッセージ画像はdialogへfocusしてEscapeまたは背景clickで閉じ、元の画像へfocusを戻せる"
// oracle = { type = "contract", ref = "src/ui/markdown/markdown-images.tsx#MessageImageLightbox" }
// fault = "dialogのfocus、Escapeまたは背景click、focus復帰が欠け、mouseまたはkeyboard利用者が画像表示から安全に戻れない"
// observable = "dialogのfocus、倍率表示、Escape・背景click後のlightboxと元triggerのfocus"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextの画像lightbox interaction境界"
// lifecycle = "permanent"
// distinction = "既存の画像load確認とは異なり、portal dialogのfocus、倍率遷移、Escapeと背景click、focus復帰を観測する"
// @end-test-value
test("MessageRichText の画像はlightboxで拡大操作でき、Escapeと背景clickで元の画像へ戻る", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
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
      root?.render(
        React.createElement(MessageRichText, {
          forceFullRender: true,
          text: "![cached](data:image/png;base64,AAAA)",
        }),
      );
    });

    const image = container.querySelector<HTMLImageElement>(".message-image");
    const trigger = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Open image preview: cached']",
    );
    assert.ok(image);
    assert.ok(trigger);
    assert.equal(trigger.disabled, true);

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });
    assert.equal(trigger.disabled, false);

    trigger.focus();
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });

    let dialog = dom.window.document.querySelector<HTMLElement>(
      "[role='dialog'][aria-label='Image preview: cached']",
    );
    assert.ok(dialog);
    assert.equal(dom.window.document.activeElement, dialog);
    assert.equal(
      dialog
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Reset image zoom to 100%']",
        )
        ?.textContent?.trim(),
      "100%",
    );

    await act(async () => {
      dialog
        ?.querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")
        ?.click();
    });
    assert.equal(
      dialog
        .querySelector<HTMLButtonElement>(
          "button[aria-label='Reset image zoom to 100%']",
        )
        ?.textContent?.trim(),
      "110%",
    );

    await act(async () => {
      dialog?.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
        }),
      );
    });
    assert.equal(
      dom.window.document.querySelector(".message-image-lightbox"),
      null,
    );
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => {
      trigger.click();
    });
    dialog = dom.window.document.querySelector<HTMLElement>(
      "[role='dialog'][aria-label='Image preview: cached']",
    );
    assert.ok(dialog);
    const backdrop = dom.window.document.querySelector<HTMLElement>(
      ".message-image-lightbox",
    );
    assert.ok(backdrop);
    await act(async () => {
      backdrop.click();
    });
    assert.equal(
      dom.window.document.querySelector(".message-image-lightbox"),
      null,
    );
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は chat context の相対 Markdown image を環境依存URLとして読み込まない"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "chat contextの相対imageを環境依存URLへ変換してimgを作る"
// observable = "render HTMLのimg不在とImage could not be loaded text"
// observation_boundary = "component-behavior"
// scope = "MessageRichText chat-context relative image safety"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は chat context の相対 Markdown image を環境依存URLとして読み込まない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "![relative](images/sample.png)",
    }),
  );

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /Image could not be loaded\./);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は protocol-relative link を HTTPS に正規化する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "protocol-relative linkをHTTPSへ正規化せず元の// URLをhrefへ残す"
// observable = "render HTMLのa hrefがhttps://example.test/docsであること"
// observation_boundary = "component-behavior"
// scope = "markdownUrlTransform link protocol normalization"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は protocol-relative link を HTTPS に正規化する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: "[site](//example.test/docs)",
    }),
  );
  assert.match(html, /href="https:\/\/example\.test\/docs"/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は slash / backslash 形式の Windows absolute image path を file URL に変換する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "Windows absolute image pathをfile URLへ変換せずimg srcへ不正なpathを残す"
// observable = "render HTMLの2つのimg srcがfile:///... URLになること"
// observation_boundary = "component-behavior"
// scope = "MessageRichText Windows absolute image URL rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は slash / backslash 形式の Windows absolute image path を file URL に変換する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![slash](C:/workspace/image%20folder/sample.png)",
        String.raw`![backslash](C:\workspace\image-folder\sample.png)`,
      ].join("\n"),
    }),
  );

  assert.match(
    html,
    /src="file:\/\/\/C:\/workspace\/image%20folder\/sample\.png"/,
  );
  assert.match(
    html,
    /src="file:\/\/\/C:\/workspace\/image-folder\/sample\.png"/,
  );
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は heading 階層と thematic break の semantic HTML を保持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "heading階層またはthematic breakをparagraphへ平坦化しsemantic elementを失う"
// observable = "h1-h6とhrのclassおよびtextContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText heading and thematic break rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は heading 階層と thematic break の semantic HTML を保持する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "# ATX H1",
        "## ATX H2",
        "### ATX H3",
        "#### ATX H4",
        "##### ATX H5",
        "###### ATX H6",
        "",
        "---",
        "",
        "Setext H1",
        "=========",
        "",
        "Setext H2",
        "---------",
      ].join("\n"),
    }),
  );

  assert.match(html, /<h1 class="message-heading level-1">ATX H1<\/h1>/);
  assert.match(html, /<h2 class="message-heading level-2">ATX H2<\/h2>/);
  assert.match(html, /<h3 class="message-heading level-3">ATX H3<\/h3>/);
  assert.match(html, /<h4 class="message-heading level-4">ATX H4<\/h4>/);
  assert.match(html, /<h5 class="message-heading level-5">ATX H5<\/h5>/);
  assert.match(html, /<h6 class="message-heading level-6">ATX H6<\/h6>/);
  assert.match(html, /<hr class="message-divider"\/>/);
  assert.match(html, /<h1 class="message-heading level-1">Setext H1<\/h1>/);
  assert.match(html, /<h2 class="message-heading level-2">Setext H2<\/h2>/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "先頭空白を含むMarkdown行が例外または誤ったblock種別になり、後続の見出し・list・code blockを描画できない"
// observable = "renderToStaticMarkupのHTMLに含まれる見出し、list、code block"
// observation_boundary = "component-behavior"
// scope = "MessageRichTextの先頭空白Markdown rendering"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できないMarkdown parserの実行時block分類とHTML出力を直接観測する"
// @end-test-value
test(
  "MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる",
  { timeout: 2_000 },
  () => {
    const input = [
      "  # title",
      "",
      "  - item",
      "  1. first",
      "",
      "  ```ts",
      "const answer = 42;",
      "  ```",
    ].join("\n");
    const html = renderToStaticMarkup(
      React.createElement(MessageRichText, {
        text: input,
      }),
    );

    assert.match(html, /<h1 class="message-heading level-1">title<\/h1>/);
    assert.match(html, /<ul class="message-list">\s*<li>item<\/li>\s*<\/ul>/);
    assert.match(
      html,
      /<ol class="message-list ordered">\s*<li>first<\/li>\s*<\/ol>/,
    );
    assert.match(
      html,
      /<pre class="message-code-block"><code class="message-inline-code language-ts">const answer = 42;<\/code><\/pre>/,
    );
  },
);

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は先頭空白付き Markdown を既存 block と inline のまま扱う"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "先頭空白の見出し/list/fenceを誤って除去または例外化し期待する要素をrenderできない"
// observable = "render HTMLのheading、unordered/ordered list、code block"
// observation_boundary = "component-behavior"
// scope = "MessageRichText indented Markdown parsing"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は先頭空白付き Markdown を既存 block と inline のまま扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "  # **title**",
        "",
        "  - [file](src/App.tsx)",
        "  - `literal`",
        "",
        "  1. **step**",
        "",
        "tail paragraph",
      ].join("\n"),
    }),
  );

  assert.match(
    html,
    /<h1 class="message-heading level-1"><strong class="message-inline-strong">title<\/strong><\/h1>/,
  );
  assert.match(
    html,
    /<ul class="message-list">\s*<li><a href="src\/App\.tsx">file<\/a><\/li>\s*<li><code class="message-inline-code">literal<\/code><\/li>\s*<\/ul>/,
  );
  assert.match(
    html,
    /<ol class="message-list ordered">\s*<li><strong class="message-inline-strong">step<\/strong><\/li>\s*<\/ol>/,
  );
  assert.match(html, /<p class="message-paragraph">tail paragraph<\/p>/);
});

// @test-value v2
// kind = "contract"
// claim = "MessageRichText は 4 文字以上インデントされた block marker を CommonMark の code block として扱う"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md" }
// fault = "4-space indented markerをheading/listとして解釈しCommonMark code blockのpre内容を失う"
// observable = "heading/list要素の不在とcode block pre textContent"
// observation_boundary = "component-behavior"
// scope = "MessageRichText indented code block parsing"
// lifecycle = "permanent"
// distinction = "型検査やbuildでは確認できない実行時のMarkdown表示または操作結果を直接観測する"
// @end-test-value
test("MessageRichText は 4 文字以上インデントされた block marker を CommonMark の code block として扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "    # not heading",
        "    - not list",
        "    1. not ordered",
        "    ```ts",
      ].join("\n"),
    }),
  );

  assert.doesNotMatch(html, /message-heading/);
  assert.doesNotMatch(html, /<ul class="message-list">/);
  assert.doesNotMatch(html, /<ol class="message-list ordered">/);
  assert.match(
    html,
    /<pre class="message-code-block"><code class="message-inline-code"># not heading\n- not list\n1\. not ordered\n```ts<\/code><\/pre>/,
  );
});
