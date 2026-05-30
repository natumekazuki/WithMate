import assert from "node:assert/strict";
import test from "node:test";

import {
  copyMessageTextToClipboard,
  copyMessageTextToClipboardWithFailureHandler,
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

test("copyMessageTextToClipboardWithFailureHandler は失敗時だけ handler を呼ぶ", async () => {
  const failures: unknown[] = [];
  const error = new Error("denied");
  const writeText = async () => {
    throw error;
  };

  assert.equal(
    await copyMessageTextToClipboardWithFailureHandler({
      text: "hello",
      writeText,
      onFailure: (caughtError) => failures.push(caughtError),
    }),
    false,
  );
  assert.deepEqual(failures, [error]);

  assert.equal(
    await copyMessageTextToClipboardWithFailureHandler({
      text: "   ",
      writeText,
      onFailure: (caughtError) => failures.push(caughtError),
    }),
    false,
  );
  assert.deepEqual(failures, [error]);
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
