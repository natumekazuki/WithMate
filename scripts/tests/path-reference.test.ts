import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTextReferenceCandidateState,
  extractTextReferenceCandidates,
  TEXT_PATH_REFERENCE_SIGNATURE_SEPARATOR,
} from "../../src/path-reference.js";

test("extractTextReferenceCandidates は plain / quoted path reference を抽出する", () => {
  assert.deepEqual(
    extractTextReferenceCandidates("確認 @src/App.tsx と @\"docs/my note.md\""),
    ["src/App.tsx", "docs/my note.md"],
  );
});

test("buildTextReferenceCandidateState は候補有無と signature を返す", () => {
  assert.deepEqual(
    buildTextReferenceCandidateState("確認 @src/App.tsx と @\"docs/my note.md\""),
    {
      candidates: ["src/App.tsx", "docs/my note.md"],
      hasCandidates: true,
      signature: ["src/App.tsx", "docs/my note.md"].join(TEXT_PATH_REFERENCE_SIGNATURE_SEPARATOR),
    },
  );
  assert.deepEqual(buildTextReferenceCandidateState("参照なし"), {
    candidates: [],
    hasCandidates: false,
    signature: "",
  });
});
