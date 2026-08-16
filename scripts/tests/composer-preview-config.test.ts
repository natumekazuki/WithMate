import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyComposerPreview,
  resolveComposerPreviewDisplay,
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

test("resolveComposerPreviewDisplay は存在しない @path エラーを microcopy で表示する", () => {
  const preview = resolveComposerPreviewDisplay(
    {
      attachments: [],
      errors: ["Path not found: missing.txt"],
    },
    {
      "composer.error.path_not_found": ["Missing attachment: {path}"],
    },
  );

  assert.deepEqual(preview.errors, ["Missing attachment: missing.txt"]);
});

test("resolveComposerPreviewDisplay は未対応エラーをそのまま返す", () => {
  const preview = resolveComposerPreviewDisplay(
    {
      attachments: [],
      errors: ["Path is outside the workspace. Add its directory before attaching: ../secret.txt"],
    },
    {
      "composer.error.path_not_found": ["Missing attachment: {path}"],
    },
  );

  assert.deepEqual(preview.errors, [
    "Path is outside the workspace. Add its directory before attaching: ../secret.txt",
  ]);
});
