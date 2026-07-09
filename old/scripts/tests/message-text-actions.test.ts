import assert from "node:assert/strict";
import test from "node:test";

import {
  copyMessageTextToClipboard,
  copyMessageTextToClipboardWithFailureHandler,
  createCopyMessageTextHandler,
  createQuotedMessageInsertion,
  createQuotedMessageInsertionFromComposer,
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

test("createCopyMessageTextHandler は response text copy を fire-and-forget で開始する", async () => {
  const writes: string[] = [];
  const failures: unknown[] = [];
  const handleCopy = createCopyMessageTextHandler({
    writeText: async (text) => {
      writes.push(text);
    },
    onFailure: (error) => failures.push(error),
  });

  handleCopy("  hello  ");
  handleCopy("   ");
  await Promise.resolve();

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(failures, []);
});

test("createCopyMessageTextHandler は copy 失敗時に handler を呼ぶ", async () => {
  const failures: unknown[] = [];
  const error = new Error("denied");
  const handleCopy = createCopyMessageTextHandler({
    writeText: async () => {
      throw error;
    },
    onFailure: (caughtError) => failures.push(caughtError),
  });

  handleCopy("hello");
  await new Promise((resolve) => setTimeout(resolve, 0));

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

test("createQuotedMessageInsertionFromComposer は textarea selection を優先する", () => {
  assert.deepEqual(
    createQuotedMessageInsertionFromComposer({
      messageText: "quote",
      draft: "before after",
      fallbackCaret: "before after".length,
      textarea: { selectionStart: "before".length },
    }),
    {
      draft: "before\n\n> quote\n\n\n after",
      caret: "before\n\n> quote\n\n\n".length,
    },
  );
  assert.deepEqual(
    createQuotedMessageInsertionFromComposer({
      messageText: "quote",
      draft: "before",
      fallbackCaret: "before".length,
      textarea: null,
    }),
    {
      draft: "before\n\n> quote\n\n",
      caret: "before\n\n> quote\n\n".length,
    },
  );
});
