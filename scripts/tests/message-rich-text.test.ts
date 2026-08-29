import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  handleMarkdownLinkClick,
  handleMarkdownLinkContextMenu,
  MessageRichText,
  resolveCodeBlockText,
  resolveMessageMarkdownRenderMode,
} from "../../src/MessageRichText.js";
import { ImageViewport, ImageZoomControls, useImageViewport } from "../../src/image-viewport.js";

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
      return { status: "copied" };
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
  assert.match(dom.window.document.body.textContent, /<script>alert\('x'\)<\/script>/);
  assert.match(dom.window.document.body.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(dom.window.document.body.textContent, /<br onclick=alert\(1\)>/);
});

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
  const previewHtml = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const previewDom = new JSDOM(previewHtml);
  const sourceHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: "source </br> text",
    displayMode: "source",
  }));
  const sourceDom = new JSDOM(sourceHtml);

  assert.equal(previewDom.window.document.querySelector("br"), null);
  assert.match(previewDom.window.document.body.textContent, /invalid <\/br> closing/);
  assert.match(previewDom.window.document.body.textContent, /plain <\/br> text/);
  assert.match(previewDom.window.document.querySelector("code")?.textContent ?? "", /inline <\/br> code/);
  assert.match(previewDom.window.document.querySelector("pre")?.textContent ?? "", /fenced <\/br> code/);
  assert.equal(sourceDom.window.document.querySelector("br"), null);
  assert.equal(sourceDom.window.document.querySelector("pre")?.textContent, "source </br> text");
});

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

test("MessageRichText は先頭 YAML frontmatter の scalar mapping を key/value table として render する", () => {
  const frontmatter = [
    "---",
    "name: withmate-memory",
    "description: Use injected context",
    "---",
  ].join("\n");
  const markdown = `${frontmatter}\n\n# Body`;
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(html);
  const frontmatterTable = dom.window.document.querySelector("table.message-frontmatter-table");

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
  assert.equal(frontmatterTable.querySelector("th")?.getAttribute("scope"), "row");
  assert.equal(dom.window.document.querySelector("pre.message-frontmatter-block"), null);
  assert.equal(dom.window.document.querySelector("h1.message-heading")?.textContent, "Body");
  assert.equal(dom.window.document.querySelector("h2.message-heading"), null);
});

test("MessageRichText の Source は YAML frontmatter を含む元 Markdown をそのまま描画する", () => {
  const source = ["---", "name: raw", "description: keep line breaks", "---", "", "# Body"].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: source,
    displayMode: "source",
  }));
  const dom = new JSDOM(html);
  const sourceElement = dom.window.document.querySelector("pre.message-source-text");

  assert.equal(sourceElement?.textContent, source);
  assert.equal(sourceElement?.querySelector("code, h1, hr"), null);
});

test("MessageRichText は空・複雑な frontmatter を code blockへ戻し、未閉鎖や本文中の thematic break は変えない", () => {
  const emptyFrontmatterHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: ["---", "---", "", "# Body"].join("\n"),
  }));
  const emptyFrontmatterDom = new JSDOM(emptyFrontmatterHtml);
  assert.equal(
    emptyFrontmatterDom.window.document.querySelector("pre.message-frontmatter-block code")?.textContent,
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
  const nestedHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: `${nestedFrontmatter}\n\n# Body`,
  }));
  const nestedDom = new JSDOM(nestedHtml);
  assert.equal(nestedDom.window.document.querySelector("table.message-frontmatter-table"), null);
  assert.equal(
    nestedDom.window.document.querySelector("pre.message-frontmatter-block code")?.textContent,
    nestedFrontmatter,
  );

  const multilineFrontmatter = [
    "---",
    "description: |",
    "  first line",
    "  second line",
    "---",
  ].join("\n");
  const multilineHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: `${multilineFrontmatter}\n\n# Body`,
  }));
  const multilineDom = new JSDOM(multilineHtml);
  assert.equal(multilineDom.window.document.querySelector("table.message-frontmatter-table"), null);
  assert.equal(
    multilineDom.window.document.querySelector("pre.message-frontmatter-block code")?.textContent,
    multilineFrontmatter,
  );

  const invalidFrontmatter = [
    "---",
    "name: [unclosed",
    "---",
  ].join("\n");
  const invalidHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: `${invalidFrontmatter}\n\n# Body`,
  }));
  const invalidDom = new JSDOM(invalidHtml);
  assert.equal(invalidDom.window.document.querySelector("table.message-frontmatter-table"), null);
  assert.equal(
    invalidDom.window.document.querySelector("pre.message-frontmatter-block code")?.textContent,
    invalidFrontmatter,
  );

  const unclosedHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: ["---", "name: stays ordinary Markdown", "", "# Body"].join("\n"),
  }));
  const unclosedDom = new JSDOM(unclosedHtml);
  assert.equal(unclosedDom.window.document.querySelector("pre.message-frontmatter-block"), null);
  assert.ok(unclosedDom.window.document.querySelector("hr.message-divider"));

  const bodyBreakHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: ["# Body", "", "---", "", "tail"].join("\n"),
  }));
  const bodyBreakDom = new JSDOM(bodyBreakHtml);
  assert.equal(bodyBreakDom.window.document.querySelector("pre.message-frontmatter-block"), null);
  assert.ok(bodyBreakDom.window.document.querySelector("hr.message-divider"));
});

test("MessageRichText の YAML frontmatter Preview は表とfallbackの値を折り返す CSS 契約を持つ", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");

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
  const copyButtons = dom.window.document.querySelectorAll<HTMLButtonElement>(".message-code-copy-button");
  const shell = dom.window.document.querySelector(".message-code-block-shell");
  const actions = shell?.querySelector(".message-code-block-actions");
  const codeBlock = shell?.querySelector("pre.message-code-block");

  assert.equal(copyButtons.length, 1);
  assert.ok(shell);
  assert.ok(actions);
  assert.equal(actions?.parentElement, shell);
  assert.equal(actions?.nextElementSibling, codeBlock);
  assert.equal(actions?.querySelector(".message-code-copy-button"), copyButtons[0]);
  assert.equal(codeBlock?.querySelector(".message-code-copy-button"), null);
  assert.equal(copyButtons[0]?.getAttribute("aria-label"), "コードをコピー");
  assert.equal(copyButtons[0]?.getAttribute("title"), "コードをコピー");
  assert.match(
    dom.window.document.querySelector(".message-code-block")?.textContent ?? "",
    /outer\n```ts\nconst nested = true;\n```\n/,
  );
  assert.equal(dom.window.document.querySelector(".message-inline-code")?.textContent, "inline");
});

test("resolveCodeBlockText は改行をLFへ揃えparser由来の末尾改行だけを除く", () => {
  assert.equal(resolveCodeBlockText("first\r\nsecond\rthird\n\n"), "first\nsecond\nthird\n");
  assert.equal(resolveCodeBlockText("without trailing newline"), "without trailing newline");
});

test("code block copy操作はhover・focus・disabledの視認状態を持つ", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const buttonRule = styles.match(/\.message-code-copy-button\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const hoverRule = styles.match(/\.message-code-copy-button:hover:not\(:disabled\)\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const focusRule = styles.match(/\.message-code-copy-button:focus-visible\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const disabledRule = styles.match(/\.message-code-copy-button:disabled\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";

  assert.match(buttonRule, /color:\s*rgba\(255, 255, 255, 0\.94\);/);
  assert.match(buttonRule, /border-radius:\s*999px;/);
  assert.match(hoverRule, /border-color:/);
  assert.match(hoverRule, /background:/);
  assert.match(hoverRule, /transform:\s*translateY\(-1px\);/);
  assert.match(focusRule, /outline:\s*2px solid var\(--teal\);/);
  assert.match(disabledRule, /opacity:\s*0\.64;/);
});

test("MessageRichText のcode block copyは本文だけをclipboardへ渡してfeedbackを表示する", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
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
      root?.render(React.createElement(MessageRichText, {
        forceFullRender: true,
        text: ["```ts", "const first = 1;", "", "```"].join("\n"),
      }));
    });
    const button = container?.querySelector<HTMLButtonElement>(".message-code-copy-button");
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
    assert.equal(container?.querySelector(".message-copy-toast")?.textContent, "コードをコピーしました。");
    assert.equal(container?.querySelector(".message-copy-toast")?.getAttribute("role"), "status");
  } finally {
    await act(async () => {
      root?.unmount();
    });
    restore();
    dom.window.close();
  }
});

test("MessageRichText のcode block copy失敗はerror feedbackを表示する", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", {
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
      root?.render(React.createElement(MessageRichText, {
        forceFullRender: true,
        text: ["```", "copy me", "```"].join("\n"),
      }));
    });
    const button = container?.querySelector<HTMLButtonElement>(".message-code-copy-button");
    assert.ok(button);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    const feedback = container?.querySelector(".message-copy-toast");
    assert.equal(feedback?.textContent, "コードのコピーに失敗しました。");
    assert.ok(feedback?.classList.contains("error"));
  } finally {
    await act(async () => {
      root?.unmount();
    });
    restore();
    dom.window.close();
  }
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

test("handleMarkdownLinkContextMenu は openPath と同じ各種targetを変換せずmenuへ渡す", async () => {
  const targets = [
    "https://example.test/docs/my%20file.md?raw=%2F#intro",
    "mailto:alice+docs@example.test",
    "docs/review-brief%20final.md",
    "file:///C:/tmp/candidate-source%20final.json",
    "C:%5Cworkspace%5Creview-brief.md",
  ];

  for (const target of targets) {
    const { defaultPrevented, requests, result } = await openMarkdownLinkContextMenu(target);
    assert.equal(defaultPrevented, true);
    assert.deepEqual(requests, [{ target, point: { x: 120, y: 240 } }]);
    assert.deepEqual(result, { status: "copied" });
  }
});

test("handleMarkdownLinkContextMenu は unsafe link と同一ページanchorをcopy対象にしない", async () => {
  for (const target of ["javascript:alert(1)", "#message-footnote-example-fn-1", ""]) {
    const { defaultPrevented, requests, result } = await openMarkdownLinkContextMenu(target);
    assert.equal(defaultPrevented, false);
    assert.deepEqual(requests, []);
    assert.equal(result, null);
  }
});

test("handleMarkdownLinkContextMenu はkeyboard起点のmenu位置をanchorから解決する", async () => {
  let request: { target: string; point: { x: number; y: number } } | null = null;
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

test("MessageRichText はrender済みlinkの右clickでtargetをcopy menuへ渡しfeedbackを表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const requests: Array<{ target: string; point: { x: number; y: number } }> = [];
  Object.defineProperty(dom.window, "withmate", {
    configurable: true,
    value: {
      async showMarkdownLinkContextMenu(request: { target: string; point: { x: number; y: number } }) {
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
      root?.render(React.createElement(MessageRichText, {
        text: "[candidate](docs/candidate-source%20final.json)",
        forceFullRender: true,
        markdownLinkFileContext: { sessionId: "session-1" },
      }));
    });
    const anchor = container.querySelector("a");
    assert.ok(anchor);

    await act(async () => {
      anchor.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 80,
        clientY: 160,
      }));
      await Promise.resolve();
    });

    assert.deepEqual(requests, [{
      target: "docs/candidate-source%20final.json",
      point: { x: 80, y: 160 },
      fileContext: { sessionId: "session-1" },
    }]);
    assert.equal(container.querySelector(".message-link-copy-toast")?.textContent, "リンクをコピーしました。");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
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

test("MessageRichText は backslash 形式の Windows absolute path を既定ナビゲーションせず開く", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
      root?.render(React.createElement(MessageRichText, {
        text: String.raw`[file](C:\workspace\session-files\report.txt)`,
        forceFullRender: true,
        onOpenPath: (target) => opened.push(target),
      }));
    });

    const anchor = container.querySelector("a");
    assert.ok(anchor);
    assert.equal(anchor.getAttribute("href"), "C:%5Cworkspace%5Csession-files%5Creport.txt");

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

test("MessageRichText は2桁番号とnested listをsemanticなordered listとしてrenderする", () => {
  const markdown = [
    ...Array.from({ length: 11 }, (_, index) => `${index + 1}. item ${index + 1}`),
    "12. viewportで折り返す長い本文でもmarkerと本文を別の領域に保つ項目",
    "",
    "    10. nested item 10",
    "    11. nested item 11",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(html);
  const rootList = dom.window.document.querySelector("ol.message-list.ordered");
  const rootItems = rootList
    ? Array.from(rootList.children).filter((element) => element.tagName === "LI")
    : [];
  const nestedList = rootItems.at(-1)?.querySelector(":scope > ol.message-list.ordered");

  assert.ok(rootList);
  assert.equal(rootItems.length, 12);
  assert.equal(rootItems[9]?.querySelector(":scope > .message-paragraph")?.textContent, "item 10");
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

test("MessageRichText は2文字ずつのindentをnested unordered listとしてrenderする", () => {
  const markdown = [
    "- aaa",
    "  - bbbb with **inline** text and viewportで折り返す長い本文",
    "    - cccc",
    "",
    "  child paragraph",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown }));
  const dom = new JSDOM(html);
  const rootList = dom.window.document.querySelector("ul.message-list");
  const rootItem = rootList?.querySelector(":scope > li");
  const nestedList = rootItem?.querySelector(":scope > ul.message-list");
  const nestedItem = nestedList?.querySelector(":scope > li");
  const deepestList = nestedItem?.querySelector(":scope > ul.message-list");

  assert.ok(rootList);
  assert.equal(rootItem?.querySelector(":scope > .message-paragraph")?.textContent, "aaa");
  assert.match(nestedItem?.textContent ?? "", /bbbb with inline text and viewportで折り返す長い本文/);
  assert.equal(nestedItem?.querySelector("strong.message-inline-strong")?.textContent, "inline");
  assert.equal(deepestList?.querySelector(":scope > li")?.textContent, "cccc");
  assert.equal(rootItem?.querySelectorAll(":scope > .message-paragraph").length, 2);
  assert.equal(rootItem?.querySelectorAll(":scope > .message-paragraph")[1]?.textContent, "child paragraph");
});

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

test("Markdown ordered list は2桁marker用の論理方向余白を持ち、独立scroll領域にしない", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const orderedListRule = styles.match(/\.message-list\.ordered\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const sharedScrollableLists = styles.match(/\.session-list,[\s\S]*?\.summary-list\s*{(?<body>[^}]*)}/)?.[0] ?? "";

  assert.match(orderedListRule, /padding-inline-start:\s*2\.25em;/);
  assert.doesNotMatch(orderedListRule, /padding-left:/);
  assert.doesNotMatch(sharedScrollableLists, /\.message-list,/);
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

test("MessageRichText は browser の light render でも先頭 YAML frontmatter を表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const restoreGlobals = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const markdown = ["---", "name: withmate-memory", "description: light render", "---", "", "# Body"].join("\n");

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(MessageRichText, { text: markdown }));
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "light");
    assert.deepEqual(
      Array.from(container.querySelectorAll("table.message-frontmatter-table tr")).map((row) => [
        row.querySelector("th")?.textContent,
        row.querySelector("td")?.textContent,
      ]),
      [
        ["name", "withmate-memory"],
        ["description", "light render"],
      ],
    );
    assert.equal(container.querySelector("pre.message-frontmatter-block"), null);
    assert.equal(container.querySelector("h1.message-heading")?.textContent, "Body");

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "full");
    assert.equal(container.querySelector("table.message-frontmatter-table")?.getAttribute("aria-label"), "YAML frontmatter");
    assert.equal(container.querySelector("pre.message-frontmatter-block"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("MessageRichText は light から full へ切り替わっても HTML br の改行を維持する", async () => {
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
      root?.render(React.createElement(MessageRichText, { text: "first<br />second" }));
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "light");
    assert.equal(container.querySelectorAll("br").length, 1);

    await act(async () => {
      await waitForAnimationFrame(dom.window);
      await waitForAnimationFrame(dom.window);
    });

    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "full");
    assert.equal(container.querySelectorAll("br").length, 1);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("MessageRichText は既存表示で検索を始めた瞬間に full rendererへ切り替える", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    assert.equal(container.querySelector("[data-markdown-render-mode]")?.getAttribute("data-markdown-render-mode"), "light");

    await act(async () => {
      root?.render(React.createElement(MessageRichText, { text: markdown, forceFullRender: true }));
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

test("resolveMessageMarkdownRenderMode はeffect前のlight stateより検索中のfull指定を優先する", () => {
  assert.equal(resolveMessageMarkdownRenderMode(
    true,
    "same text",
    { text: "same text", mode: "light" },
    false,
  ), "full");
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

test("MessageRichText は Mermaid code block をdiagram用containerとしてrenderし、copy操作を表示しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
    }),
  );
  const dom = new JSDOM(html);

  assert.match(html, /<div class="message-mermaid fallback">/);
  assert.match(html, /<code class="message-inline-code language-mermaid">flowchart TD\n  A --&gt; B\n<\/code>/);
  assert.equal(dom.window.document.querySelector(".message-code-copy-button"), null);
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
    /<pre class="message-code-block"><code class="message-inline-code language-txt">\[sample\]\(meeting notes\.md\)<\/code><\/pre>/,
  );
  assert.match(html, /\[indented\]\(meeting notes\.md\)/);
  assert.match(html, /\[tabbed\]\(meeting notes\.md\)/);
});

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

test("MessageRichText は直接 image を表示しながら load 完了後に loading 表示を消す", async () => {
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
        forceFullRender: true,
        text: "![cached](data:image/png;base64,AAAA)",
      }));
    });

    const image = container.querySelector("img");
    assert.ok(image);
    assert.equal(image.hidden, false);
    assert.notEqual(container.querySelector(".message-image-loading"), null);

    await act(async () => {
      image.dispatchEvent(new dom.window.Event("load"));
    });

    assert.equal(container.querySelector(".message-image-loading"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

// @test-value v1
// kind = "regression"
// claim = "ImageViewportはFitの実効倍率を画像描画へ適用し、その倍率をZoom Inの基準にする"
// oracle = { type = "contract", ref = "ユーザー要求: feat-message-image-lightbox引継ぎの確定した仕様" }
// failure_mode = "Fit倍率の表示だけが更新されて画像へ適用されず、画像がviewportから見切れたままになる"
// scope = "共有ImageViewportの画像描画境界"
// lifecycle = "permanent"
// distinction = "Fit倍率の計算unit testとは異なり、計算結果が画像styleと後続Zoom Inへ投影されることを観測する"
// @end-test-value
test("ImageViewport はFit実効倍率を画像描画とZoom Inへ反映する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
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
    const image = container.querySelector<HTMLImageElement>(".image-viewport-image");
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
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent,
      "50%",
    );
    assert.equal(image.style.zoom, "0.5");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")?.click();
    });
    assert.equal(
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent,
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

// @test-value v1
// kind = "contract"
// claim = "読込済みのメッセージ画像はcloseボタンを常設せず、dialogへfocusしてEscapeまたは背景clickで閉じ、元の画像へfocusを戻せる"
// oracle = { type = "contract", ref = "ユーザー要求: lightboxの×ボタンを削除し、背景clickとEscapeを閉じる経路にする" }
// failure_mode = "冗長なcloseボタンが残るか、dialogのfocus、Escapeまたは背景click、focus復帰が欠け、mouseまたはkeyboard利用者が画像表示から安全に戻れない"
// scope = "MessageRichTextの画像lightbox interaction境界"
// lifecycle = "permanent"
// distinction = "既存の画像load確認とは異なり、closeボタンの不在、portal dialogのfocus、倍率遷移、Escapeと背景click、focus復帰を観測する"
// @end-test-value
test("MessageRichText の画像はlightboxで拡大操作でき、Escapeと背景clickで元の画像へ戻る", async () => {
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
        forceFullRender: true,
        text: "![cached](data:image/png;base64,AAAA)",
      }));
    });

    const image = container.querySelector<HTMLImageElement>(".message-image");
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-label='Open image preview: cached']");
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

    let dialog = dom.window.document.querySelector<HTMLElement>("[role='dialog'][aria-label='Image preview: cached']");
    assert.ok(dialog);
    assert.equal(dom.window.document.activeElement, dialog);
    assert.equal(dialog.querySelector("button[aria-label='Close image preview']"), null);
    assert.equal(
      dialog.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent?.trim(),
      "100%",
    );

    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>("button[aria-label='Zoom image in']")?.click();
    });
    assert.equal(
      dialog.querySelector<HTMLButtonElement>("button[aria-label='Reset image zoom to 100%']")?.textContent?.trim(),
      "110%",
    );

    await act(async () => {
      dialog?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    assert.equal(dom.window.document.querySelector(".message-image-lightbox"), null);
    assert.equal(dom.window.document.activeElement, trigger);

    await act(async () => {
      trigger.click();
    });
    dialog = dom.window.document.querySelector<HTMLElement>("[role='dialog'][aria-label='Image preview: cached']");
    assert.ok(dialog);
    const backdrop = dom.window.document.querySelector<HTMLElement>(".message-image-lightbox");
    assert.ok(backdrop);
    await act(async () => {
      backdrop.click();
    });
    assert.equal(dom.window.document.querySelector(".message-image-lightbox"), null);
    assert.equal(dom.window.document.activeElement, trigger);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restoreGlobals();
    dom.window.close();
  }
});

test("MessageRichText は chat context の相対 Markdown image を環境依存URLとして読み込まない", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: "![relative](images/sample.png)" }),
  );

  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /Image could not be loaded\./);
});

test("MessageRichText は protocol-relative link を HTTPS に正規化する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, { text: "[site](//example.test/docs)" }),
  );
  assert.match(html, /href="https:\/\/example\.test\/docs"/);
});

test("MessageRichText は slash / backslash 形式の Windows absolute image path を file URL に変換する", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: [
        "![slash](C:/workspace/image%20folder/sample.png)",
        String.raw`![backslash](C:\workspace\image-folder\sample.png)`,
      ].join("\n"),
    }),
  );

  assert.match(html, /src="file:\/\/\/C:\/workspace\/image%20folder\/sample\.png"/);
  assert.match(html, /src="file:\/\/\/C:\/workspace\/image-folder\/sample\.png"/);
});

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

test("MessageRichText は先頭空白付き Markdown 行でも停止せずに render できる", { timeout: 2_000 }, () => {
  const input = ["  # title", "", "  - item", "  1. first", "", "  ```ts", "const answer = 42;", "  ```"].join("\n");
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: input,
    }),
  );

  assert.match(html, /<h1 class="message-heading level-1">title<\/h1>/);
  assert.match(html, /<ul class="message-list">\s*<li>item<\/li>\s*<\/ul>/);
  assert.match(html, /<ol class="message-list ordered">\s*<li>first<\/li>\s*<\/ol>/);
  assert.match(html, /<pre class="message-code-block"><code class="message-inline-code language-ts">const answer = 42;<\/code><\/pre>/);
});

test("MessageRichText は先頭空白付き Markdown を既存 block と inline のまま扱う", () => {
  const html = renderToStaticMarkup(
    React.createElement(MessageRichText, {
      text: ["  # **title**", "", "  - [file](src/App.tsx)", "  - `literal`", "", "  1. **step**", "", "tail paragraph"].join(
        "\n",
      ),
    }),
  );

  assert.match(html, /<h1 class="message-heading level-1"><strong class="message-inline-strong">title<\/strong><\/h1>/);
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
    /<pre class="message-code-block"><code class="message-inline-code"># not heading\n- not list\n1\. not ordered\n```ts<\/code><\/pre>/,
  );
});
