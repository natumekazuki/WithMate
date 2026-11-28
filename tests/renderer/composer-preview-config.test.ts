import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyComposerPreview } from "../../src/chat/composer/composer-preview-config.js";

/** 初期プレビューには添付もエラーもないことを確認する。 */
test("composer preview config は空 preview を作る", () => {
  assert.deepEqual(createEmptyComposerPreview(), {
    attachments: [],
    errors: [],
  });
});

/** 添付とエラーの配列をインスタンス間で共有せず、別の初期プレビューへ変更が波及しないようにする。 */
test("createEmptyComposerPreview は呼び出しごとに新しい配列を返す", () => {
  const first = createEmptyComposerPreview();
  const second = createEmptyComposerPreview();

  assert.notEqual(first, second);
  assert.notEqual(first.attachments, second.attachments);
  assert.notEqual(first.errors, second.errors);
});
