import assert from "node:assert/strict";
import test from "node:test";

import {
  copyMessageTextToClipboard,
  createQuotedMessageInsertion,
  formatMarkdownQuote,
  normalizeMessageTextForCopy,
} from "../../src/chat/message-text-actions.js";

test("normalizeMessageTextForCopy は response text の前後空白を除く", () => {
  assert.equal(normalizeMessageTextForCopy("  hello\n"), "hello");
  assert.equal(normalizeMessageTextForCopy("   "), "");
});

test("copyMessageTextToClipboard は空でない response text だけを書き込む", async () => {
  const writes: string[] = [];
  const writeText = async (text: string) => {
    writes.push(text);
  };

  assert.equal(await copyMessageTextToClipboard("  hello  ", writeText), true);
  assert.equal(await copyMessageTextToClipboard("   ", writeText), false);
  assert.deepEqual(writes, ["hello"]);
});

test("formatMarkdownQuote は response text を Markdown quote に整形する", () => {
  assert.equal(formatMarkdownQuote("a\r\nb"), "> a\n> b\n\n");
  assert.equal(formatMarkdownQuote("   "), "");
});

test("createQuotedMessageInsertion は quote を caret 位置へ挿入する", () => {
  assert.deepEqual(createQuotedMessageInsertion("a\nb", "before", 6), {
    draft: "before\n\n> a\n> b\n\n",
    caret: 17,
  });
  assert.equal(createQuotedMessageInsertion("   ", "before", 0), null);
});
