import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";

// @test-value v2
// kind = "contract"
// claim = "PDF専用読込はroot外PDFをWorkspace・preview元・file URLから解決し、元bytesとrevisionを返す"
// oracle = { type = "contract", ref = "src-shared/file-explorer/file-explorer-contract.ts: SessionPdfResourceRequest/SessionPdfChunkRequest" }
// fault = "root制約で本文PDFを拒否する、相対基準を誤る、chunk bytesを欠落させる"
// observable = "descriptorのkind・mimeType・absoluteFilePathとchunkのbytes・done・revision"
// observation_boundary = "public-boundary"
// scope = "SessionFileExplorerService.inspectPdf/readPdfChunk"
// lifecycle = "permanent"
// impact = "本文から生成済みPDFを閲覧できなくなる"
// distinction = "generic fileと画像testではPDF限定経路の実filesystem解決を保証できず、小さいfixtureで確認する"
// @end-test-value
test("linked PDF reads resolve local targets and return revision-bound bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-pdf-links-"));
  try {
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await writeFile(path.join(workspace, "docs", "source.md"), "source");
    const pdfPath = path.join(directory, "result.pdf");
    const pdf = "%PDF-1.7\nfixture";
    await writeFile(pdfPath, pdf);
    const service = new SessionFileExplorerService({
      userDataPath: path.join(directory, "data"),
      async getSessionContext() { return { workspacePath: workspace, parentSessionId: "session", allowedAdditionalDirectories: [] }; },
    });
    for (const request of [
      { sessionId: "session", target: "../result.pdf" },
      { sessionId: "session", target: "../../result.pdf", baseResource: { sessionId: "session", rootId: "workspace", relativePath: "docs/source.md" } },
      { sessionId: "session", target: pdfPath },
      { sessionId: "session", target: pathToFileURL(pdfPath).href },
    ]) {
      const descriptor = await service.inspectPdf(request);
      assert.equal(descriptor.kind, "pdf");
      assert.equal(descriptor.mimeType, "application/pdf");
      assert.equal(descriptor.absoluteFilePath, pdfPath);
      const chunk = await service.readPdfChunk({ ...request, offset: 0, length: 1024, expectedRevision: descriptor.revision });
      assert.equal(new TextDecoder().decode(chunk.data), pdf);
      assert.equal(chunk.done, true);
      assert.equal(chunk.revision, descriptor.revision);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "security"
// claim = "PDF専用APIは非PDF・remote・別Session基準・Git相対参照と古いrevisionを拒否する"
// oracle = { type = "contract", ref = "src-shared/file-explorer/file-explorer-contract.ts: SessionPdfResourceRequest/SessionPdfChunkRequest" }
// fault = "pdf拡張子だけで任意textを返す、remote参照や別Session基準を許す、変更後bytesを返す"
// observable = "inspectPdf/readPdfChunkの拒否Error"
// observation_boundary = "public-boundary"
// scope = "PDF自動読込の種別・参照・revision境界"
// lifecycle = "permanent"
// impact = "本文PDF読込が任意text読込へ拡大する、または変更途中のPDFを返す"
// distinction = "型検査やgeneric file testでは自動PDF読込のbytes種別と認可を保証できず、小さい実fileで確認する"
// @end-test-value
test("linked PDF reads reject non-PDF targets and stale revisions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-pdf-boundary-"));
  try {
    const pdfPath = path.join(directory, "result.pdf");
    const fakePath = path.join(directory, "private.pdf");
    await writeFile(pdfPath, "%PDF-1.7\nfixture");
    await writeFile(fakePath, "private text");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(directory, "data"),
      async getSessionContext() { return { workspacePath: directory, parentSessionId: "session", allowedAdditionalDirectories: [] }; },
    });
    const request = { sessionId: "session", target: pdfPath };
    const descriptor = await service.inspectPdf(request);
    await assert.rejects(service.inspectPdf({ ...request, target: fakePath }), /not a PDF/);
    const fake = await service.inspectFile({ sessionId: "session", absolutePath: fakePath });
    await assert.rejects(service.readPdfChunk({ ...request, target: fakePath, offset: 0, length: 1024, expectedRevision: fake.revision }), /not a PDF/);
    for (const target of ["https://example.com/result.pdf", "custom:result.pdf"]) {
      await assert.rejects(service.inspectPdf({ ...request, target }), /local path or file URL/);
      await assert.rejects(service.readPdfChunk({ ...request, target, offset: 0, length: 1024, expectedRevision: descriptor.revision }), /local path or file URL/);
    }
    await assert.rejects(service.inspectPdf({ ...request, baseResource: { sessionId: "other", absolutePath: pdfPath } }), /does not belong/);
    await assert.rejects(service.inspectPdf({ ...request, target: "result.pdf", baseResource: { resourceKind: "git-commit-file", sessionId: "session", rootId: "workspace", repositoryId: "repository", commitId: "a".repeat(40), relativePath: "source.md" } }), /Relative PDFs/);
    await writeFile(pdfPath, "%PDF-1.7\nchanged fixture");
    await assert.rejects(service.readPdfChunk({ ...request, offset: 0, length: 1024, expectedRevision: descriptor.revision }), /file changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
