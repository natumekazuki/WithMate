import assert from "node:assert/strict";
import test from "node:test";

import { resolveOpenPathFeedback } from "../../src/file-explorer/open-path-result.js";

/** 実際に開けた場合だけ通知を省き、見つからない・開けない・代わりに表示した、という各結果では結果側のメッセージを使う。 */
test("resolveOpenPathFeedback は opened だけを空 feedback として扱う", async () => {
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "opened",
        targetType: "local-path",
        target: "C:/workspace",
      }),
      "fallback",
    ),
    "",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "not-found",
        targetType: "local-path",
        target: "C:/missing",
        message: "The local path was not found.",
      }),
      "fallback",
    ),
    "The local path was not found.",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "failed",
        targetType: "local-path",
        target: "C:/workspace/file.txt",
        message: "The default app could not open the file.",
      }),
      "fallback",
    ),
    "The default app could not open the file.",
  );
  assert.equal(
    await resolveOpenPathFeedback(
      async () => ({
        status: "revealed",
        targetType: "local-path",
        target: "C:/workspace/file.txt",
        message: "The file was revealed instead.",
      }),
      "fallback",
    ),
    "The file was revealed instead.",
  );
});

/** 処理の拒否も同じ通知経路に流し、Error の本文を使える場合と汎用文言に戻る場合を区別する。 */
test("resolveOpenPathFeedback は rejected operation も同じfeedback境界へ流す", async () => {
  assert.equal(
    await resolveOpenPathFeedback(async () => {
      throw new Error("open rejected");
    }, "fallback"),
    "open rejected",
  );
  assert.equal(
    await resolveOpenPathFeedback(async () => {
      throw "unknown";
    }, "fallback"),
    "fallback",
  );
});
