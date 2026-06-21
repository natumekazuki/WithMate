import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_PREVIEW_DEBOUNCE_MS,
  COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS,
  createEmptyComposerPreview,
  WORKSPACE_PATH_QUERY_MIN_LENGTH,
  WORKSPACE_PATH_SEARCH_DEBOUNCE_MS,
} from "../../src/composer-preview-config.js";

test("composer preview config は Agent / Companion 共有値を維持する", () => {
  assert.deepEqual(createEmptyComposerPreview(), { attachments: [], errors: [] });
  assert.equal(COMPOSER_PREVIEW_DEBOUNCE_MS, 120);
  assert.equal(COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS, 280);
  assert.equal(WORKSPACE_PATH_QUERY_MIN_LENGTH, 2);
  assert.equal(WORKSPACE_PATH_SEARCH_DEBOUNCE_MS, 100);
});

test("createEmptyComposerPreview は呼び出しごとに新しい配列を返す", () => {
  const first = createEmptyComposerPreview();
  const second = createEmptyComposerPreview();

  assert.notEqual(first, second);
  assert.notEqual(first.attachments, second.attachments);
  assert.notEqual(first.errors, second.errors);
});
