import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageRichText } from "../../src/MessageRichText.js";
import { createRenderedTextSearchIndex } from "../../src/file-explorer/rendered-text-search.js";
import { createGlossaryAnnotationMatcher } from "../../src/glossary/glossary-annotation-projection.js";
import { isMessageRenderedSearchTextNode } from "../../src/message-rendered-search-text.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installDomGlobals(dom: JSDOM): () => void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;

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
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

  return () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: previousCancelAnimationFrame });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
  };
}

const matcher = createGlossaryAnnotationMatcher([{
  term: "Session Runtime",
  aliases: ["Runtime"],
  definition: "<strong>plain definition</strong>",
}], "revision-1");

test("MessageRichTextはMarkdown parse後の通常textだけを注釈し本文とfind文字列を維持する", () => {
  const markdown = [
    "# Session Runtime",
    "",
    "Runtime [Runtime](https://example.test/Runtime) `Runtime` https://example.test/Runtime",
    "",
    "> Runtime",
    "",
    "- Runtime",
    "",
    "```text",
    "Runtime",
    "```",
  ].join("\n");
  const plainHtml = renderToStaticMarkup(React.createElement(MessageRichText, { text: markdown, forceFullRender: true }));
  const annotatedHtml = renderToStaticMarkup(React.createElement(MessageRichText, {
    text: markdown,
    forceFullRender: true,
    glossaryAnnotationMatcher: matcher,
    glossaryAnnotationScopeKey: "message-1",
    onActivateGlossaryEntry: () => undefined,
  }));
  const plainDom = new JSDOM(`<!doctype html>${plainHtml}`);
  const annotatedDom = new JSDOM(`<!doctype html>${annotatedHtml}`);
  try {
    const plain = plainDom.window.document.querySelector<HTMLElement>(".rich-text");
    const annotated = annotatedDom.window.document.querySelector<HTMLElement>(".rich-text");
    assert.ok(plain);
    assert.ok(annotated);
    assert.deepEqual(
      Array.from(annotated.querySelectorAll<HTMLElement>(".glossary-annotation"), (element) => element.textContent),
      ["Session Runtime", "Runtime", "Runtime", "Runtime"],
    );
    assert.equal(annotated.querySelector("a .glossary-annotation"), null);
    assert.equal(annotated.querySelector("code .glossary-annotation"), null);
    assert.equal(annotated.textContent, plain.textContent);
    assert.equal(
      createRenderedTextSearchIndex(annotated, isMessageRenderedSearchTextNode).normalizedText,
      createRenderedTextSearchIndex(plain, isMessageRenderedSearchTextNode).normalizedText,
    );
  } finally {
    plainDom.window.close();
    annotatedDom.window.close();
  }
});

test("MessageRichTextはmessage単位のroving focus、tooltip、canonical activationを提供する", async () => {
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", {
    pretendToBeVisual: true,
    url: "https://example.test/",
  });
  const restore = installDomGlobals(dom);
  const container = dom.window.document.getElementById("root");
  let root: Root | null = null;
  const activated: string[] = [];

  try {
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(MessageRichText, {
        text: "Runtime、Runtime、Runtime",
        forceFullRender: true,
        glossaryAnnotationMatcher: matcher,
        glossaryAnnotationScopeKey: "message-1",
        onActivateGlossaryEntry: (term) => activated.push(term),
      }));
    });
    const annotations = Array.from(container.querySelectorAll<HTMLElement>(".glossary-annotation"));
    assert.deepEqual(annotations.map((element) => element.tabIndex), [0, -1, -1]);

    await act(async () => annotations[0]?.focus());
    const tooltip = dom.window.document.body.querySelector<HTMLElement>("[role='tooltip']");
    assert.ok(tooltip);
    assert.equal(tooltip.textContent, "Session Runtime<strong>plain definition</strong>");
    assert.equal(tooltip.querySelector("strong"), null);
    assert.equal(container.contains(tooltip), false);

    await act(async () => {
      annotations[0]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dom.window.document.activeElement === annotations[1], true);
    assert.deepEqual(annotations.map((element) => element.tabIndex), [-1, 0, -1]);

    await act(async () => {
      annotations[1]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(activated, ["Session Runtime"]);

    const tabEvent = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    assert.equal(annotations[1]?.dispatchEvent(tabEvent), true);
    assert.equal(tabEvent.defaultPrevented, false);

    await act(async () => {
      annotations[1]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(dom.window.document.body.querySelector("[role='tooltip']"), null);
    assert.equal(dom.window.document.activeElement === annotations[1], true);

    await act(async () => {
      annotations[2]?.dispatchEvent(new dom.window.MouseEvent("mouseenter", { bubbles: true }));
    });
    assert.deepEqual(activated, ["Session Runtime"]);
    await act(async () => annotations[2]?.click());
    assert.deepEqual(activated, ["Session Runtime", "Session Runtime"]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
    dom.window.close();
  }
});

test("glossary tooltipは非interactiveかつ360x240以内でscroll ownerを持たない", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const tooltipRule = styles.match(/\.glossary-annotation-tooltip\s*{(?<body>[^}]*)}/)?.groups?.body ?? "";
  const definitionRules = Array.from(
    styles.matchAll(/\.glossary-annotation-tooltip-definition\s*{(?<body>[^}]*)}/g),
    (match) => match.groups?.body ?? "",
  );
  const definitionRule = definitionRules.at(-1) ?? "";

  assert.match(tooltipRule, /position:\s*fixed;/);
  assert.match(tooltipRule, /max-width:\s*min\(360px,/);
  assert.match(tooltipRule, /max-height:\s*min\(240px,/);
  assert.match(tooltipRule, /overflow:\s*hidden;/);
  assert.match(tooltipRule, /pointer-events:\s*none;/);
  assert.match(definitionRule, /overflow:\s*hidden;/);
  assert.doesNotMatch(tooltipRule, /overflow(?:-x|-y)?:\s*(?:auto|scroll);/);
  assert.doesNotMatch(definitionRule, /overflow(?:-x|-y)?:\s*(?:auto|scroll);/);
});
