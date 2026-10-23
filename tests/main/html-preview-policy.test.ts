import assert from "node:assert/strict";
import test from "node:test";
import { assertHtmlPreviewMount, clipHtmlPreviewLayout } from "../../src-electron/files/html-preview-policy.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../src-shared/file-explorer/session-html-preview-contract.js";

// @test-value v2
// kind = "invariant"
// claim = "HTML実行入力はUTF-8の50 MiB境界を超えると拒否され、ASCII文字数では判定しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "多バイト文字列を文字数だけで判定して実行上限を超える入力を許可する"
// observable = "mount入力検証の正常終了と上限超過の例外"
// observation_boundary = "public-boundary"
// scope = "HTML preview mount input policy"
// lifecycle = "permanent"
// @end-test-value
test("HTML preview mount validates identity and UTF-8 byte length", () => {
  assert.doesNotThrow(() => assertHtmlPreviewMount({ id: "preview-1", html: "<p>日本語</p>" }));
  assert.throws(() => assertHtmlPreviewMount({ id: "../other", html: "" }), /invalid/);
  const withinLimit = "x".repeat(HTML_PREVIEW_MAX_BYTES);
  assert.doesNotThrow(() => assertHtmlPreviewMount({ id: "limit", html: withinLimit }));
  assert.throws(() => assertHtmlPreviewMount({ id: "limit", html: withinLimit + "x" }), /50 MiB/);
  assert.throws(() => assertHtmlPreviewMount({ id: "multibyte", html: "語".repeat(Math.ceil(HTML_PREVIEW_MAX_BYTES / 3)) }), /50 MiB/);
});

// @test-value v2
// kind = "invariant"
// claim = "native HTML viewのclipはWindowと本文矩形の共通部分に制限し、非有限値と不可視領域を表示しない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation" }
// fault = "本文の外やwindow外へHTMLがはみ出す、負寸法やNaNでnative boundsを壊す"
// observable = "clip矩形、visible値、不正入力の例外"
// observation_boundary = "public-boundary"
// scope = "HTML native view layout policy"
// lifecycle = "permanent"
// @end-test-value
test("HTML preview clip is bounded by content and window", () => {
  const bounds = { x: -30, y: 40, width: 400, height: 300 };
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(clipHtmlPreviewLayout({ bounds, clip: { x: -100, y: 50, width: 1000, height: 160 }, visible: true }, viewport), {
    bounds, clip: { x: 0, y: 50, width: 370, height: 160 }, visible: true,
  });
  assert.equal(clipHtmlPreviewLayout({ bounds, clip: { x: 0, y: 800, width: 300, height: 100 }, visible: true }, viewport).visible, false);
  assert.equal(clipHtmlPreviewLayout({ bounds, clip: bounds, visible: false }, viewport).visible, false);
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(() => clipHtmlPreviewLayout({ bounds: { ...bounds, width: value }, clip: bounds, visible: true }, viewport), /invalid/);
  }
});
