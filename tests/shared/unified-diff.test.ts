import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "../../src/file-explorer/unified-diff.js";

test("parseUnifiedDiff は複数hunkの行番号と変更blockをSplit表示用に揃える", () => {
  const parsed = parseUnifiedDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -2,3 +2,3 @@",
    " context",
    "-before one",
    "-before two",
    "+after one",
    "+after two",
    "@@ -10 +10,2 @@",
    "-old tail",
    "+new tail",
    "+added tail",
    "",
  ].join("\n"));

  assert.equal(parsed.hasTextChanges, true);
  assert.deepEqual(parsed.rows.slice(4, 10), [
    { kind: "hunk", text: "@@ -2,3 +2,3 @@", patchLineIndex: 4 },
    {
      kind: "context",
      leftNumber: 2,
      rightNumber: 2,
      leftText: "context",
      rightText: "context",
      leftPatchLineIndex: 5,
      rightPatchLineIndex: 5,
    },
    {
      kind: "modify",
      leftNumber: 3,
      rightNumber: 3,
      leftText: "before one",
      rightText: "after one",
      leftPatchLineIndex: 6,
      rightPatchLineIndex: 8,
    },
    {
      kind: "modify",
      leftNumber: 4,
      rightNumber: 4,
      leftText: "before two",
      rightText: "after two",
      leftPatchLineIndex: 7,
      rightPatchLineIndex: 9,
    },
    { kind: "hunk", text: "@@ -10 +10,2 @@", patchLineIndex: 10 },
    {
      kind: "modify",
      leftNumber: 10,
      rightNumber: 10,
      leftText: "old tail",
      rightText: "new tail",
      leftPatchLineIndex: 11,
      rightPatchLineIndex: 12,
    },
  ]);
  assert.deepEqual(parsed.rows[10], {
    kind: "add",
    rightNumber: 11,
    rightText: "added tail",
    rightPatchLineIndex: 13,
  });
});

test("parseUnifiedDiff はno-newline markerと空行をhunk外metadataへ誤分類しない", () => {
  const parsed = parseUnifiedDiff([
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
  ].join("\n"));

  assert.deepEqual(parsed.rows.slice(3), [
    { kind: "hunk", text: "@@ -1 +1 @@", patchLineIndex: 3 },
    {
      kind: "modify",
      leftNumber: 1,
      rightNumber: 1,
      leftText: "old",
      rightText: "new",
      leftPatchLineIndex: 4,
      rightPatchLineIndex: 6,
    },
    { kind: "note", text: "\\ No newline at end of file", patchLineIndex: 5 },
    { kind: "note", text: "\\ No newline at end of file", patchLineIndex: 7 },
  ]);
});

test("parseUnifiedDiff はrenameやbinaryなどhunkのないpatchもmetadataとして保持する", () => {
  const patch = [
    "diff --git a/old.bin b/new.bin",
    "similarity index 100%",
    "rename from old.bin",
    "rename to new.bin",
    "Binary files a/old.bin and b/new.bin differ",
  ].join("\n");
  const parsed = parseUnifiedDiff(patch);

  assert.equal(parsed.hasTextChanges, false);
  assert.deepEqual(parsed.rows, patch.split("\n").map((text, patchLineIndex) => ({
    kind: "metadata",
    text,
    patchLineIndex,
  })));
});

test("parseUnifiedDiff はhunk本文の---と+++をfile headerではなく変更内容として扱う", () => {
  const parsed = parseUnifiedDiff([
    "@@ -1 +1 @@",
    "----old content",
    "++++new content",
  ].join("\n"));

  assert.deepEqual(parsed.rows, [
    { kind: "hunk", text: "@@ -1 +1 @@", patchLineIndex: 0 },
    {
      kind: "modify",
      leftNumber: 1,
      rightNumber: 1,
      leftText: "---old content",
      rightText: "+++new content",
      leftPatchLineIndex: 1,
      rightPatchLineIndex: 2,
    },
  ]);
});
