import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";

// @test-value v2
// kind = "contract"
// claim = "画像専用読込はWorkspaceまたはpreview元を基準にroot外画像を解決し、chunkで画像bytesを返す"
// oracle = { type = "contract", ref = "src-shared/file-explorer/file-explorer-contract.ts: SessionImageResourceRequest" }
// fault = "root外画像の拒否、previewの相対基準をWorkspaceに誤固定、または画像bytesの欠落"
// observable = "descriptorのabsolutePath・mimeTypeとchunkのbytes"
// observation_boundary = "public-boundary"
// scope = "SessionFileExplorerService.inspectImage/readImageChunk"
// lifecycle = "permanent"
// impact = "chatとMarkdown/Mermaid previewの共通画像表示が成立しなくなる"
// distinction = "generic file readのroot制約testでは確認できない画像専用の実filesystem解決を小さいfixtureで確認する"
// @end-test-value
test("local images use workspace or source parent and allow targets outside roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-images-"));
  try {
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    const imagePath = path.join(directory, "image.svg");
    const image = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>";
    await writeFile(imagePath, image);
    await writeFile(path.join(workspace, "docs", "source.md"), "source");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(directory, "data"),
      async getSessionContext() {
        return { workspacePath: workspace, parentSessionId: "session", allowedAdditionalDirectories: [] };
      },
    });
    for (const request of [
      { sessionId: "session", target: "../image.svg" },
      { sessionId: "session", target: "../../image.svg", baseResource: { sessionId: "session", rootId: "workspace", relativePath: "docs/source.md" } },
      { sessionId: "session", target: "./image.svg", baseResource: { sessionId: "session", absolutePath: imagePath } },
      { sessionId: "session", target: imagePath },
      { sessionId: "session", target: pathToFileURL(imagePath).href },
      { sessionId: "session", target: imagePath, baseResource: { resourceKind: "git-commit-file" as const, sessionId: "session", rootId: "workspace", repositoryId: "repository", commitId: "a".repeat(40), relativePath: "source.md" } },
    ]) {
      const descriptor = await service.inspectImage(request);
      assert.equal("absolutePath" in descriptor && descriptor.absolutePath, imagePath);
      assert.equal(descriptor.mimeType, "image/svg+xml");
      const chunk = await service.readImageChunk({ ...request, offset: 0, length: 1024, expectedRevision: descriptor.revision });
      assert.equal(new TextDecoder().decode(chunk.data), image);
      assert.equal(chunk.done, true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "画像専用APIは画像でないbytes・directory・未知scheme・Git previewの相対targetとrevision不一致を拒否する"
// oracle = { type = "contract", ref = "src-electron/files/session-file-explorer-service.ts: inspectImage/readImageChunk" }
// fault = "拡張子だけで秘密textを画像と認定、未知schemeをfilenameとして読込、Git previewの相対targetを現在のWorkspaceと混同、または変更済み画像のchunkを返す"
// observable = "inspectImage/readImageChunkの拒否Errorと有効PNGのmimeType"
// observation_boundary = "public-boundary"
// scope = "画像専用型確認とrevision検証"
// lifecycle = "permanent"
// impact = "画像の自動読込権限が任意text readへ拡大する、または変更途中の画像を表示する"
// distinction = "typecheckやgeneric read testでは実bytesと画像だけの認可境界を保証できない;小さいfixtureで継続確認する"
// @end-test-value
test("local image reads reject non-image content, schemes, directories and stale revisions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-image-boundary-"));
  try {
    const imagePath = path.join(directory, "image.png");
    const fakePath = path.join(directory, "secret.png");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imagePath, png);
    await writeFile(fakePath, "private text");
    const service = new SessionFileExplorerService({
      userDataPath: path.join(directory, "data"),
      async getSessionContext() {
        return { workspacePath: directory, parentSessionId: "session", allowedAdditionalDirectories: [] };
      },
    });
    const descriptor = await service.inspectImage({ sessionId: "session", target: imagePath });
    assert.equal(descriptor.mimeType, "image/png");
    await assert.rejects(service.inspectImage({ sessionId: "session", target: fakePath }), /not a supported image/);
    await assert.rejects(service.readImageChunk({ sessionId: "session", target: fakePath, offset: 0, length: 1024, expectedRevision: (await service.inspectFile({ sessionId: "session", absolutePath: fakePath })).revision }), /not a supported image/);
    await assert.rejects(service.inspectImage({ sessionId: "session", target: directory }));
    await assert.rejects(service.inspectImage({ sessionId: "session", target: "custom:image.png" }), /local path or file URL/);
    await assert.rejects(service.inspectImage({ sessionId: "session", target: "image.png", baseResource: {
      resourceKind: "git-commit-file", sessionId: "session", rootId: "workspace", repositoryId: "repository", commitId: "a".repeat(40), relativePath: "source.md",
    } }), /Relative images from a Git commit/);
    await writeFile(imagePath, Uint8Array.from([...png, 1]));
    await assert.rejects(service.readImageChunk({ sessionId: "session", target: imagePath, offset: 0, length: 1024, expectedRevision: descriptor.revision }), /file changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
