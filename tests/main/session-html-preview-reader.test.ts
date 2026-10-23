import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";
import { readSessionHtmlPreview } from "../../src-electron/files/session-html-preview-reader.js";
import type { SessionFileChunkResult, SessionFileDescriptor, SessionFilePreviewTargetResolution } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { HTML_PREVIEW_MAX_BYTES } from "../../src-shared/file-explorer/session-html-preview-contract.js";

const resource = { sessionId: "session-1", absolutePath: path.resolve("sample.html") };

function createExplorer(bytes = new TextEncoder().encode("<p>hello</p>")) {
  const descriptor: SessionFileDescriptor = {
    ...resource, absoluteFilePath: resource.absolutePath, name: "sample.html", kind: "text",
    byteLength: bytes.byteLength, modifiedAt: "2026-10-24T00:00:00.000Z", mimeType: "text/plain",
    suggestedEncoding: "utf-8", revision: "revision-1",
  };
  return {
    descriptor,
    async resolvePreviewTarget(): Promise<SessionFilePreviewTargetResolution> { return { type: "file", resource }; },
    async inspectFile() { return descriptor; },
    async readFileChunk(request: { offset: number; length: number; expectedRevision: string }): Promise<SessionFileChunkResult> {
      assert.equal(request.expectedRevision, "revision-1");
      const data = bytes.slice(request.offset, request.offset + request.length).buffer;
      const nextOffset = request.offset + data.byteLength;
      return { data, offset: request.offset, nextOffset, totalBytes: bytes.byteLength, done: nextOffset === bytes.byteLength, revision: "revision-1" };
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "HTMLリンクは既存resolverの相対baseとroot外absolute file契約を保ち、元ファイルのUTF-16本文を復号する"
// oracle = { type = "contract", ref = "issue #849: self-contained local HTML preview; SessionFileExplorerService.resolvePreviewTarget" }
// fault = "workspaceを固定baseとして別fileを読む、root外fileを拒否する、またはUTF-16を文字化けさせる"
// observable = "実filesystemからreadSessionHtmlPreviewが返すhtmlとfileName"
// observation_boundary = "public-boundary"
// scope = "HTML readerとSessionFileExplorerServiceの結合"
// lifecycle = "permanent"
// impact = "チャットにリンクされたローカルHTMLを正しい文字と内容で表示する"
// distinction = "resolver単体testではHTML readerからのbase引継ぎと復号の結合を確認しない"
// @end-test-value
test("HTML reader は相対baseとroot外absolute HTMLを既存resolverで読む", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-html-reader-"));
  try {
    const workspacePath = path.join(directory, "workspace");
    const outsidePath = path.join(directory, "outside");
    await mkdir(workspacePath);
    await mkdir(outsidePath);
    const basePath = path.join(outsidePath, "base.md");
    const htmlPath = path.join(outsidePath, "日本語.HTM");
    const html = "<!doctype html><p>日本語の本文</p><script>window.value=3</script>";
    await writeFile(basePath, "[preview](日本語.HTM)");
    await writeFile(htmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, "utf16le")]));
    const service = new SessionFileExplorerService({
      userDataPath: path.join(directory, "user-data"),
      getSessionContext: async () => ({ workspacePath, parentSessionId: "session-1", allowedAdditionalDirectories: [] }),
    });
    assert.deepEqual(await readSessionHtmlPreview(service, {
      sessionId: "session-1", target: "日本語.HTM", baseResource: { sessionId: "session-1", absolutePath: basePath },
    }), { html, fileName: "日本語.HTM" });
    assert.deepEqual(await readSessionHtmlPreview(service, { sessionId: "session-1", target: htmlPath }), { html, fileName: "日本語.HTM" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "HTML readerは複数chunkの全バイトを順序通り読み、chunk境界を跨ぐUTF-8文字も保持する"
// oracle = { type = "contract", ref = "issue #849: original HTML content preview" }
// fault = "先頭chunkだけを返す、chunkを欠落させる、またはchunkごとの復号で文字を壊す"
// observable = "返されたhtml全文と末尾の日本語文字"
// observation_boundary = "public-boundary"
// scope = "HTML reader chunk assembly and decoding"
// lifecycle = "permanent"
// impact = "大きなHTMLでもscriptと本文を欠落せず表示できる"
// distinction = "型検査と短いfileのtestではchunk境界による破損を検出しない"
// @end-test-value
test("HTML reader は複数chunkを結合してから復号する", async () => {
  const html = "a".repeat(1024 * 1024 - 1) + "日本語<p>end</p>";
  assert.deepEqual(await readSessionHtmlPreview(createExplorer(new TextEncoder().encode(html)), {
    sessionId: "session-1", target: "sample.html",
  }), { html, fileName: "sample.html" });
});

// @test-value v2
// kind = "contract"
// claim = "HTML readerは外部URL・directory・非HTML・binary・上限超過fileを本文として返さない"
// oracle = { type = "contract", ref = "issue #849: bounded local HTML-only reader contract" }
// fault = "リンク先の種類やsize制約を無視して本文を返す"
// observable = "各不適格targetのreadSessionHtmlPreview拒否と本文read回数"
// observation_boundary = "public-boundary"
// scope = "HTML reader eligibility and size boundary"
// lifecycle = "permanent"
// impact = "HTMLでない対象の誤表示と上限を超えるメモリ消費を防ぐ"
// distinction = "resolverはdirectoryと外部URLも正常な解決結果として返すためreader固有の制限を実行時に確認する"
// @end-test-value
test("HTML reader はlocal HTML textと50 MiB上限に制限する", async () => {
  const request = { sessionId: "session-1", target: "sample.html" };
  for (const resolution of [
    { type: "external-url", target: "https://example.com/sample.html" },
    { type: "directory", targetPath: resource.absolutePath },
    { type: "failed", targetPath: "missing.html", message: "missing" },
  ] satisfies SessionFilePreviewTargetResolution[]) {
    const explorer = createExplorer();
    explorer.resolvePreviewTarget = async () => resolution;
    await assert.rejects(readSessionHtmlPreview(explorer, request));
  }
  for (const change of [
    { name: "sample.txt" }, { kind: "binary" as const }, { byteLength: HTML_PREVIEW_MAX_BYTES + 1 },
  ]) {
    const explorer = createExplorer();
    Object.assign(explorer.descriptor, change);
    let reads = 0;
    explorer.readFileChunk = async () => { reads += 1; throw new Error("unexpected read"); };
    await assert.rejects(readSessionHtmlPreview(explorer, request), /requires a text|size limit/);
    assert.equal(reads, 0);
  }
  const hiddenBinary = new Uint8Array(9000);
  hiddenBinary.fill(65);
  hiddenBinary[8999] = 0;
  await assert.rejects(readSessionHtmlPreview(createExplorer(hiddenBinary), request), /requires a text/);
});

// @test-value v2
// kind = "contract"
// claim = "HTML readerはrevision・offset・size・終端の不整合chunkからHTMLを返さない"
// oracle = { type = "contract", ref = "SessionFileChunkResult revision-stable exact-byte contract" }
// fault = "読み込み途中の更新や欠落を成功したHTMLとして返す"
// observable = "不整合chunkを返すreadSessionHtmlPreviewの拒否"
// observation_boundary = "public-boundary"
// scope = "HTML reader revision and chunk validation"
// lifecycle = "permanent"
// impact = "別revisionのscriptや欠損本文を混在させずreload可能な失敗として扱う"
// distinction = "型では保証できないchunkの値の対応をservice境界で検証する"
// @end-test-value
test("HTML reader は不整合chunkと途中更新を拒否する", async () => {
  for (const change of [
    { revision: "changed" }, { offset: 1 }, { nextOffset: 0 }, { totalBytes: 99 },
    { nextOffset: 99 }, { data: new ArrayBuffer(0) }, { done: false },
  ]) {
    const explorer = createExplorer();
    const read = explorer.readFileChunk;
    explorer.readFileChunk = async (request) => ({ ...await read(request), ...change });
    await assert.rejects(readSessionHtmlPreview(explorer, { sessionId: "session-1", target: "sample.html" }), /changed while/);
  }
  const explorer = createExplorer(new Uint8Array(1024 * 1024 + 1).fill(65));
  const read = explorer.readFileChunk;
  explorer.readFileChunk = async (request) => {
    if (request.offset > 0) throw new Error("The file changed while it was being read.");
    return read(request);
  };
  await assert.rejects(readSessionHtmlPreview(explorer, { sessionId: "session-1", target: "sample.html" }), /file changed/);
});
