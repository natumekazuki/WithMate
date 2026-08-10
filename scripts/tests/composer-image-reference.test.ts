import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMarkdownImageReferenceCandidates,
  findMarkdownImageReferences,
  formatMarkdownImageReference,
  isSupportedComposerImagePath,
  removeMarkdownImageReferences,
} from "../../src/composer-image-reference.js";

test("formatMarkdownImageReference は local path を安全な Markdown image にする", () => {
  assert.equal(
    formatMarkdownImageReference("C:\\Users\\A Name\\shot [1] (copy).png"),
    "![shot \\[1\\] (copy).png](C:/Users/A%20Name/shot%20%5B1%5D%20%28copy%29.png)",
  );
  assert.equal(
    formatMarkdownImageReference("\\\\server\\shared files\\shot (1).png"),
    "![shot (1).png](file://server/shared%20files/shot%20%281%29.png)",
  );
});

test("Markdown image reference は Windows path と file URL を local path として抽出する", () => {
  const markdown = [
    "![first](C:/Users/A%20Name/first.png)",
    "![second](file:///C:/Users/A%20Name/second.webp)",
    "![shared](file://server/shared%20files/third.gif)",
    "![remote](https://example.test/remote.png)",
    "![unsupported](C:/Users/A/image.avif)",
  ].join("\n");

  assert.deepEqual(extractMarkdownImageReferenceCandidates(markdown), [
    "C:/Users/A Name/first.png",
    "C:/Users/A Name/second.webp",
    "//server/shared files/third.gif",
  ]);
  assert.deepEqual(
    findMarkdownImageReferences(markdown).map(({ path }) => path),
    ["C:/Users/A Name/first.png", "C:/Users/A Name/second.webp", "//server/shared files/third.gif"],
  );
});

test("isSupportedComposerImagePath は既存7形式だけを画像として扱う", () => {
  for (const extension of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]) {
    assert.equal(isSupportedComposerImagePath(`C:/images/sample.${extension}`), true);
  }
  for (const extension of ["avif", "tiff", "tif", "ico", "txt"]) {
    assert.equal(isSupportedComposerImagePath(`C:/images/sample.${extension}`), false);
  }
});

test("removeMarkdownImageReferences は一致する画像だけを削除する", () => {
  const first = formatMarkdownImageReference("C:/images/first image (1).png");
  const second = formatMarkdownImageReference("C:/images/second.png");

  assert.equal(
    removeMarkdownImageReferences(`確認 ${first} と ${second}`, ["C:\\images\\first image (1).png"]),
    `確認  と ${second}`,
  );
});
