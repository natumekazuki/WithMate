import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PDF_READER_DOCUMENT_URL, servePdfReaderAsset, shouldBlockPdfReaderNavigation } from "../../src-electron/windows/pdf-reader-assets.js";

// @test-value v2
// kind = "invariant"
// claim = "PDF asset配信は固定reader hostの同梱資材だけを返し、外側path・別host・write要求を拒否する"
// oracle = { type = "contract", ref = "src-electron/windows/pdf-reader-assets.ts: servePdfReaderAsset の同梱資材境界" }
// fault = "URLのpathまたはauthority検証を欠き、同梱外のファイルかwrite要求を受け付ける"
// observable = "配信Responseのstatus、body、MIME、CSP"
// observation_boundary = "public-boundary"
// scope = "PDF reader custom protocol asset handler"
// lifecycle = "permanent"
// impact = "PDF表示領域から同梱外のlocalファイルを取得できると情報漏えいになる"
// distinction = "型やbuildではURL解釈とfilesystem境界の一致を検出できず、数個の一時fileで実配信境界を確認する"
// @end-test-value
test("PDF reader assets stay inside their bundle and carry the isolated CSP", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-pdf-assets-"));
  const root = path.join(temporaryRoot, "reader");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "index.html"), "reader document");
    await writeFile(path.join(temporaryRoot, "secret.html"), "outside bundle");
    await symlink(temporaryRoot, path.join(root, "escape"), "junction");
    const response = await servePdfReaderAsset({ url: PDF_READER_DOCUMENT_URL, method: "GET" }, root);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "reader document");
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    const csp = response.headers.get("Content-Security-Policy")!;
    for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-src 'none'", "form-action 'none'", "script-src 'self' 'wasm-unsafe-eval'"]) assert.ok(csp.includes(directive));
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    for (const url of [
      "withmate-pdf://other/index.html",
      "file://reader/index.html",
      "withmate-pdf://reader:99/index.html",
      "withmate-pdf://user@reader/index.html",
      "withmate-pdf://reader/index.html?destination=outside",
      "withmate-pdf://reader/%2e%2e%2fsecret.html",
      "withmate-pdf://reader/%2e%2e%5csecret.html",
      "withmate-pdf://reader/%00.html",
      "withmate-pdf://reader/index.html:stream",
      "withmate-pdf://reader/missing.html",
      "withmate-pdf://reader/escape/secret.html",
    ]) assert.equal((await servePdfReaderAsset({ url, method: "GET" }, root)).status, 404, url);
    assert.equal((await servePdfReaderAsset({ url: PDF_READER_DOCUMENT_URL, method: "POST" }, root)).status, 405);
    const head = await servePdfReaderAsset({ url: PDF_READER_DOCUMENT_URL, method: "HEAD" }, root);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "PDF frameは固定document以外へ遷移できず、通常Windowの既存navigationは変更しない"
// oracle = { type = "contract", ref = "src-electron/windows/pdf-reader-protocol.ts: will-frame-navigate のPDF限定navigation境界" }
// fault = "reader自身のlocation変更で外部URLへ通信するか、親main frameへreaderをロードできる"
// observable = "navigation policyの拒否判定"
// observation_boundary = "public-boundary"
// scope = "PDF frame navigation policy"
// lifecycle = "permanent"
// impact = "PDF内action等による自動外部通信と、preload付きmain frameへのreader移動を防ぐ"
// distinction = "CSP connect-srcはdocument navigationを防がず、buildでもイベント条件の誤りを検出できない"
// @end-test-value
test("PDF navigation is confined to its iframe document without changing normal navigation", () => {
  assert.equal(shouldBlockPdfReaderNavigation({ url: PDF_READER_DOCUMENT_URL, isMainFrame: false }), false);
  assert.equal(shouldBlockPdfReaderNavigation({ url: `${PDF_READER_DOCUMENT_URL}#instanceId=current&hostOrigin=file%3A%2F%2F`, isMainFrame: false }), false);
  assert.equal(shouldBlockPdfReaderNavigation({ url: `${PDF_READER_DOCUMENT_URL}?external=1#instanceId=current`, isMainFrame: false }), true);
  assert.equal(shouldBlockPdfReaderNavigation({ url: PDF_READER_DOCUMENT_URL, isMainFrame: true }), true);
  assert.equal(shouldBlockPdfReaderNavigation({ url: "https://example.com/", frameUrl: PDF_READER_DOCUMENT_URL, isMainFrame: false }), true);
  assert.equal(shouldBlockPdfReaderNavigation({ url: "file:///secret.pdf", initiatorUrl: PDF_READER_DOCUMENT_URL, isMainFrame: false }), true);
  assert.equal(shouldBlockPdfReaderNavigation({ url: "withmate-pdf://reader/other.html", isMainFrame: false }), true);
  assert.equal(shouldBlockPdfReaderNavigation({ url: "https://example.com/", frameUrl: "file:///session.html", isMainFrame: true }), false);
});
