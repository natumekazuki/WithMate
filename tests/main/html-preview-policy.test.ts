import assert from "node:assert/strict";
import test from "node:test";
import { assertHtmlPreviewMount } from "../../src-electron/files/html-preview-policy.js";
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
  const source = { kind: "link" as const, request: { sessionId: "session", target: "preview.html" } };
  assert.doesNotThrow(() => assertHtmlPreviewMount({ id: "preview-1", html: "<p>日本語</p>", source }));
  assert.throws(() => assertHtmlPreviewMount({ id: "../other", html: "", source }), /invalid/);
  const withinLimit = "x".repeat(HTML_PREVIEW_MAX_BYTES);
  assert.doesNotThrow(() => assertHtmlPreviewMount({ id: "limit", html: withinLimit, source }));
  assert.throws(() => assertHtmlPreviewMount({ id: "limit", html: withinLimit + "x", source }), /50 MiB/);
  assert.throws(() => assertHtmlPreviewMount({ id: "multibyte", html: "語".repeat(Math.ceil(HTML_PREVIEW_MAX_BYTES / 3)), source }), /50 MiB/);
});
