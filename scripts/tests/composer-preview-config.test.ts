import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyComposerPreview,
} from "../../src/composer-preview-config.js";

test("composer preview config は空 preview を作る", () => {
  assert.deepEqual(createEmptyComposerPreview(), { attachments: [], errors: [] });
});

test("createEmptyComposerPreview は呼び出しごとに新しい配列を返す", () => {
  const first = createEmptyComposerPreview();
  const second = createEmptyComposerPreview();

  assert.notEqual(first, second);
  assert.notEqual(first.attachments, second.attachments);
  assert.notEqual(first.errors, second.errors);
});
