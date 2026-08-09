import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTextReferenceCandidateState,
  extractComposerAttachmentReferenceCandidates,
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

test("extractComposerAttachmentReferenceCandidates は @path と local Markdown image を区別して返す", () => {
  assert.deepEqual(
    extractComposerAttachmentReferenceCandidates([
      "確認 @src/App.tsx",
      "![pasted](C:/session-files/pasted%20image.png)",
      "![remote](https://example.test/image.png)",
    ].join("\n")),
    [
      { path: "src/App.tsx", source: "text" },
      { path: "C:/session-files/pasted image.png", source: "markdown-image", kind: "image" },
    ],
  );
});
