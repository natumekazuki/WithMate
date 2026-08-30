import assert from "node:assert/strict";
import test from "node:test";

import { calculateImageFitZoom } from "../../src/image-viewport.js";
import {
  decodeSessionFileBytes,
  findPreviewTextMatches,
  PreviewByteAccumulator,
  projectFileRootDiffAvailability,
  resolveAuthorizedMarkdownResource,
  resolveMarkdownImageTarget,
  resolveRelativeMarkdownResourcePath,
} from "../../src/file-explorer/file-preview-utils.js";
import { detectSessionFileEncoding } from "../../src/file-explorer/file-content-detection.js";

test("calculateImageFitZoom は画像を拡大せずviewport内に収める倍率を返す", () => {
  assert.equal(calculateImageFitZoom(800, 450, 1600, 900), 50);
  assert.equal(calculateImageFitZoom(800, 600, 400, 300), 100);
  assert.equal(calculateImageFitZoom(0, 600, 400, 300), 100);
});

test("decodeSessionFileBytes は Auto と手動指定で UTF-8 / Shift_JIS / UTF-16 を decode する", () => {
  assert.equal(decodeSessionFileBytes(new TextEncoder().encode("hello"), "auto", "utf-8"), "hello");
  assert.equal(
    decodeSessionFileBytes(Uint8Array.from([0x82, 0xa0, 0x82, 0xa2]), "shift_jis", "utf-8"),
    "あい",
  );
  assert.equal(
    decodeSessionFileBytes(Uint8Array.from([0x00, 0x41, 0x00, 0x42]), "utf-16be", "utf-8"),
    "AB",
  );
});

test("findPreviewTextMatches は同じ行の複数一致を別々の検索結果として返す", () => {
  assert.deepEqual(findPreviewTextMatches(["alpha alpha", "beta alpha"], "alpha"), [
    { lineIndex: 0, startOffset: 0, endOffset: 5 },
    { lineIndex: 0, startOffset: 6, endOffset: 11 },
    { lineIndex: 1, startOffset: 5, endOffset: 10 },
  ]);
});

test("decodeSessionFileBytes の Auto は ASCII inspection prefix より後ろの Shift_JIS まで検証する", () => {
  const bytes = new Uint8Array(8194).fill(0x61);
  bytes[8192] = 0x82;
  bytes[8193] = 0xa0;

  const decoded = decodeSessionFileBytes(bytes, "auto", "utf-8");

  assert.equal(decoded.length, 8193);
  assert.equal(decoded.slice(-1), "あ");
});

test("detectSessionFileEncoding は UTF-8 と Shift_JIS の両方に不正なbytesをShift_JIS扱いしない", () => {
  assert.equal(detectSessionFileEncoding(Uint8Array.of(0xff)), "utf-8");
});

test("PreviewByteAccumulator は破棄時に未完了世代の保持bytesを直ちに手放す", () => {
  const accumulator = new PreviewByteAccumulator();
  accumulator.append(Uint8Array.of(1, 2, 3));
  assert.equal(accumulator.retainedByteLength, 3);

  accumulator.release();

  assert.equal(accumulator.retainedByteLength, 0);
  assert.throws(() => accumulator.append(Uint8Array.of(4)), /replaced/);
});

test("projectFileRootDiffAvailability は変更なしとGit失敗を区別する", () => {
  assert.deepEqual(projectFileRootDiffAvailability({ status: "ok", entries: [] }, "src/App.tsx"), {
    scopes: [],
    message: "",
  });
  assert.deepEqual(projectFileRootDiffAvailability({ status: "not-git", message: "Not a Git repository." }, "src/App.tsx"), {
    scopes: [],
    message: "",
  });
  assert.deepEqual(projectFileRootDiffAvailability({
    status: "ok",
    entries: [{
      relativePath: "src/App.tsx",
      previousRelativePath: null,
      kinds: { "working-tree": "modified", staged: "untracked" },
      scopes: ["working-tree", "staged"],
    }],
  }, "src/App.tsx"), {
    scopes: ["working-tree"],
    message: "",
  });
});

test("resolveRelativeMarkdownResourcePath は Markdown 親基準で正規化し root 外へ出さない", () => {
  assert.equal(resolveRelativeMarkdownResourcePath("docs/guide/readme.md", "../images/hero.png"), "docs/images/hero.png");
  assert.equal(resolveRelativeMarkdownResourcePath("docs/readme.md", "images/hero%20one.png"), "docs/images/hero one.png");
  assert.equal(resolveRelativeMarkdownResourcePath("readme.md", "../secret.png"), null);
  assert.equal(resolveRelativeMarkdownResourcePath("readme.md", "%2e%2e/secret.png"), null);
});

test("resolveMarkdownImageTarget は external と認可済み local resource を一つの境界で分類する", () => {
  const roots = [
    { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:\\work" },
    { id: "extra", kind: "additional" as const, label: "Assets", displayPath: "C:\\work\\assets" },
  ];
  assert.deepEqual(resolveMarkdownImageTarget(roots, "workspace", "docs/readme.md", "//example.com/a.png"), {
    kind: "external",
    source: "https://example.com/a.png",
  });
  assert.deepEqual(resolveMarkdownImageTarget(roots, "workspace", "docs/readme.md", "images/hero%20one.png"), {
    kind: "local",
    resource: { rootId: "workspace", relativePath: "docs/images/hero one.png" },
  });
  assert.deepEqual(resolveMarkdownImageTarget(roots, "workspace", "docs/readme.md", "file:///C:/work/assets/hero%20one.png"), {
    kind: "local",
    resource: { rootId: "extra", relativePath: "hero one.png" },
  });
  assert.deepEqual(resolveMarkdownImageTarget(roots, "workspace", "docs/readme.md", "C:/outside/secret.png"), {
    kind: "unsupported",
  });
  assert.deepEqual(resolveMarkdownImageTarget(roots, "workspace", "readme.md", "%2e%2e/secret.png"), {
    kind: "unsupported",
  });
});

test("resolveAuthorizedMarkdownResource は登録 root 内の file URL と絶対 path だけを root request へ変換する", () => {
  const roots = [
    { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:\\work" },
    { id: "extra", kind: "additional" as const, label: "Assets", displayPath: "C:\\work\\assets" },
  ];
  assert.deepEqual(resolveAuthorizedMarkdownResource(roots, "file:///C:/work/assets/hero%20one.png"), {
    rootId: "extra",
    relativePath: "hero one.png",
  });
  assert.deepEqual(resolveAuthorizedMarkdownResource(roots, "c:\\WORK\\docs\\diagram.svg"), {
    rootId: "workspace",
    relativePath: "docs/diagram.svg",
  });
  assert.equal(resolveAuthorizedMarkdownResource(roots, "C:\\outside\\secret.png"), null);
  assert.deepEqual(resolveAuthorizedMarkdownResource([
    { id: "unc", kind: "additional" as const, label: "Share", displayPath: "\\\\server\\share" },
  ], "file://server/share/image.png"), {
    rootId: "unc",
    relativePath: "image.png",
  });
});
