import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  getRenderedTextSearchIndexStats,
  resolveRenderedTextMatch,
} from "../../src/file-explorer/rendered-text-search.js";

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
