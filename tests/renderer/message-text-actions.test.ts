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
  insertComposerTextAtSelection,
} from "../../src/chat/message-text-actions.js";

/** コピー用本文の外側の空白を除き、空白だけの入力を空文字にすることを確認する。 */
test("normalizeMessageTextForCopy は response text の前後空白を除く", () => {
  assert.equal(normalizeMessageTextForCopy("  hello\n"), "hello");
  assert.equal(normalizeMessageTextForCopy("   "), "");
});

/** 整形後に空でない本文だけが書込みに進むことを確認する。 */
test("copyMessageTextToClipboard は空でない response text だけを書き込む", async () => {
  const writes: string[] = [];
  /** クリップボードに渡された文字列を記録する。 */
  const writeText = async (text: string) => {
    writes.push(text);
  };

  assert.equal(await copyMessageTextToClipboard("  hello  ", writeText), true);
  assert.equal(await copyMessageTextToClipboard("   ", writeText), false);
  assert.deepEqual(writes, ["hello"]);
});

// @test-value v2
// kind = "contract"
// claim = "clipboard失敗の例外をfailure handlerから取得でき、空白入力ではhandlerを追加で呼ばない"
// oracle = { type = "contract", ref = "src/chat/message-text-actions.ts" }
// fault = "clipboard失敗の例外がhandlerへ届かない、または空白入力で追加通知する"
// observable = "copy result, collected failure errors, and clipboard call count"
// observation_boundary = "public-boundary"
// scope = "message-copy-failure-handler"
// lifecycle = "permanent"
// @end-test-value
/** 書込みが拒否されたときだけ失敗ハンドラーが呼ばれることを確認する。 */
test("copyMessageTextToClipboardWithFailureHandler は失敗時だけ handler を呼ぶ", async () => {
  const failures: unknown[] = [];
  const error = new Error("denied");
  let writeCount = 0;
  /** 書込み試行を数えたうえで拒否を再現する。 */
  const writeText = async () => {
    writeCount += 1;
    throw error;
  };
  /** 失敗通知で受け取った例外を保持する。 */
  const onFailure = (caughtError: unknown) => failures.push(caughtError);

  assert.equal(
    await copyMessageTextToClipboardWithFailureHandler({
      text: "hello",
      writeText,
      onFailure,
    }),
    false,
  );
  assert.deepEqual(failures, [error]);
  assert.equal(writeCount, 1);

  assert.equal(
    await copyMessageTextToClipboardWithFailureHandler({
      text: "   ",
      writeText,
      onFailure,
    }),
    false,
  );
  assert.deepEqual(failures, [error]);
  assert.equal(writeCount, 1);
});

/** 待機を要求しないコピー操作で、空白だけの入力がクリップボードに書かれないことを確認する。 */
test("createCopyMessageTextHandler は response text copy を fire-and-forget で開始する", async () => {
  const writes: string[] = [];
  const failures: unknown[] = [];
  const handleCopy = createCopyMessageTextHandler({
    /** 非同期処理から実際に書き込まれた本文を集める。 */
    writeText: async (text) => {
      writes.push(text);
    },
    /** 成功時に予期しない失敗通知があれば記録する。 */
    onFailure: (error) => failures.push(error),
  });

  handleCopy("  hello  ");
  handleCopy("   ");
  await Promise.resolve();

  assert.deepEqual(writes, ["hello"]);
  assert.deepEqual(failures, []);
});

/** コピー操作を待たなくても、後から起きた書込み失敗がハンドラーに届くことを確認する。 */
test("createCopyMessageTextHandler は copy 失敗時に handler を呼ぶ", async () => {
  const failures: unknown[] = [];
  const error = new Error("denied");
  const handleCopy = createCopyMessageTextHandler({
    /** クリップボードのアクセス拒否を再現する。 */
    writeText: async () => {
      throw error;
    },
    /** 非同期書込みが拒否された理由を捕捉する。 */
    onFailure: (caughtError) => failures.push(caughtError),
  });

  handleCopy("hello");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(failures, [error]);
});

/** 改行を正規化したうえで各行を引用し、空白だけなら引用を作らないことを確認する。 */
test("formatMarkdownQuote は response text を Markdown quote に整形する", () => {
  assert.equal(formatMarkdownQuote("a\r\nb"), "> a\n> b\n\n");
  assert.equal(formatMarkdownQuote("   "), "");
});

/** 下書きのキャレットへ引用を足し、引用末尾に新しいキャレットを置くことを確認する。 */
test("createQuotedMessageInsertion は quote を caret 位置へ挿入する", () => {
  assert.deepEqual(createQuotedMessageInsertion("a\nb", "before", 6), {
    draft: "before\n\n> a\n> b\n\n",
    caret: 17,
  });
  assert.equal(createQuotedMessageInsertion("   ", "before", 0), null);
});

/** エディターの選択開始位置を優先し、エディター不在時だけ退避した位置を使うことを確認する。 */
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

/** 選択済みの範囲だけを置換し、その前後の下書きを削らないことを確認する。 */
test("insertComposerTextAtSelection は選択範囲を置換し、周囲の下書きを保持する", () => {
  assert.deepEqual(
    insertComposerTextAtSelection("before OLD after", "template", 7, 10),
    {
      draft: "before \n\ntemplate\n after",
      caret: 18,
    },
  );
});
