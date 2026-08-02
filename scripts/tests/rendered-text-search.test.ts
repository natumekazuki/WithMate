import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  appendRenderedTextMatches,
  applyRenderedTextHighlights,
  clearRenderedTextHighlights,
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  getRenderedTextSearchIndexStats,
  MAX_RENDERED_TEXT_HIGHLIGHT_RANGES,
  resolveRenderedTextMatch,
  resolveRenderedTextMatches,
} from "../../src/file-explorer/rendered-text-search.js";

class TestHighlight {
  readonly ranges: Range[] = [];

  constructor(...ranges: Range[]) {
    assert.equal(ranges.length, 0, "CSS Highlight は多数のRangeをvariadic引数へ展開しない");
  }

  add(range: Range) {
    this.ranges.push(range);
    return this;
  }
}

test("Rendered text search は inline node をまたぐ表示文字列を DOM Range へ対応付ける", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\">alpha <strong>beta</strong></div>");
  try {
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    const index = createRenderedTextSearchIndex(preview);
    const matches = findRenderedTextMatchOffsets(index, "ALPHA BETA");
    assert.equal(matches.offsets.length, 1);
    const match = resolveRenderedTextMatch(index, matches, 0);
    assert.ok(match);
    const range = dom.window.document.createRange();
    range.setStart(match.startNode, match.startOffset);
    range.setEnd(match.endNode, match.endOffset);
    assert.equal(range.toString(), "alpha beta");
  } finally {
    dom.window.close();
  }
});

test("resolveRenderedTextMatches は全一致を表示順のDOM Rangeへ解決する", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\">alpha <strong>alpha</strong></div>");
  try {
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    const index = createRenderedTextSearchIndex(preview);
    const matches = findRenderedTextMatchOffsets(index, "alpha");
    assert.deepEqual(resolveRenderedTextMatches(index, matches).map((match) => {
      const range = dom.window.document.createRange();
      range.setStart(match.startNode, match.startOffset);
      range.setEnd(match.endNode, match.endOffset);
      return range.toString();
    }), ["alpha", "alpha"]);
  } finally {
    dom.window.close();
  }
});

test("Rendered text search は全一致と現在位置を別のCSS Highlightへ投影する", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\">alpha <strong>alpha</strong></div>");
  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    const index = createRenderedTextSearchIndex(preview);
    const matches = resolveRenderedTextMatches(index, findRenderedTextMatchOffsets(index, "alpha"));

    assert.equal(applyRenderedTextHighlights(dom.window.document, matches, matches[1] ?? null), true);
    assert.deepEqual(
      highlights.get("withmate-find-match")?.ranges.map((range) => range.toString()),
      ["alpha", "alpha"],
    );
    assert.deepEqual(
      highlights.get("withmate-find-current")?.ranges.map((range) => range.toString()),
      ["alpha"],
    );

    clearRenderedTextHighlights(dom.window.document);
    assert.equal(highlights.size, 0);
  } finally {
    dom.window.close();
  }
});

test("Rendered text search はdense一致もincrementalにCSS Highlightへ追加する", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\">a</div>");
  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    const index = createRenderedTextSearchIndex(preview);
    const match = resolveRenderedTextMatch(index, findRenderedTextMatchOffsets(index, "a"), 0);
    assert.ok(match);
    const denseMatches = Array.from({ length: MAX_RENDERED_TEXT_HIGHLIGHT_RANGES + 2048 }, () => match);

    assert.equal(applyRenderedTextHighlights(dom.window.document, denseMatches, match), true);
    assert.equal(
      highlights.get("withmate-find-match")?.ranges.length,
      MAX_RENDERED_TEXT_HIGHLIGHT_RANGES,
    );
  } finally {
    dom.window.close();
  }
});

test("Rendered text search のchat集約は大量一致を共通budget内へ収める", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\"></div>");
  try {
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    preview.textContent = "a".repeat(125_000);
    const index = createRenderedTextSearchIndex(preview);
    const matches = findRenderedTextMatchOffsets(index, "a");
    const resolved: ReturnType<typeof resolveRenderedTextMatches> = [];

    appendRenderedTextMatches(resolved, index, matches);

    assert.equal(matches.offsets.length, 125_000);
    assert.equal(resolved.length, MAX_RENDERED_TEXT_HIGHLIGHT_RANGES);
  } finally {
    dom.window.close();
  }
});

test("Rendered text search は lowercase で長さが変わる文字の後も元 node offset を返す", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\">İX</div>");
  try {
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    const index = createRenderedTextSearchIndex(preview);
    const matches = findRenderedTextMatchOffsets(index, "x");
    assert.equal(matches.offsets.length, 1);
    const match = resolveRenderedTextMatch(index, matches, 0);
    assert.ok(match);
    assert.equal(match.startOffset, 1);
    assert.equal(match.endOffset, 2);
    const range = dom.window.document.createRange();
    range.setStart(match.startNode, match.startOffset);
    range.setEnd(match.endNode, match.endOffset);
    assert.equal(range.toString(), "X");
  } finally {
    dom.window.close();
  }
});

test("createRenderedTextSearchIndex は通常文字列を文字数比例のobjectへ展開しない", () => {
  const dom = new JSDOM("<!doctype html><div id=\"preview\"></div>");
  try {
    const preview = dom.window.document.getElementById("preview") as HTMLElement;
    preview.textContent = "a".repeat(1024 * 1024);
    const index = createRenderedTextSearchIndex(preview);
    assert.deepEqual(getRenderedTextSearchIndexStats(index), {
      runCount: 1,
      expandedOffsetCount: 0,
    });
    assert.equal(findRenderedTextMatchOffsets(index, "not-present").offsets.length, 0);
    const denseMatches = findRenderedTextMatchOffsets(index, "a");
    assert.equal(denseMatches.offsets.length, 1024 * 1024);
    assert.equal(denseMatches.offsets.byteLength, 4 * 1024 * 1024);
    assert.ok(resolveRenderedTextMatch(index, denseMatches, denseMatches.offsets.length - 1));
  } finally {
    dom.window.close();
  }
});
