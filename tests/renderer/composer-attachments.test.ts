import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertCapturedComposerAttachmentsAvailable, resolveComposerPreview } from "../../src-electron/files/composer-attachments.js";
import { formatMarkdownImageReference } from "../../src-shared/files/composer-image-reference.js";

// @test-value v2
// kind = "contract"
// claim = "添付はworkspace自体のlinkを解決し、junction先が作業範囲内の時だけ受理して送信直前にも実体を再確認する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Composer attachment work scope" }
// fault = "字句上workspace配下のjunctionで範囲外添付を受理する、workspace aliasを拒否する、またはcaptured後のlink差替えを見逃す"
// observable = "添付候補のattachments/errorsとcaptured attachments再検証の成功・拒否"
// observation_boundary = "public-boundary"
// scope = "composer candidate and captured attachment validation with real directory links"
// lifecycle = "permanent"
// impact = "添付候補と実行時の作業範囲の食い違いを防ぐ"
// distinction = "既存testの通常pathや型検査ではfilesystem linkの実体と再解決を確認できない;小さな一時directoryのみ使用する"
// @end-test-value
test("添付はlink先の実体で作業範囲を判定しcaptured後の差替えも再検証する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-links-"));
  const workspace = path.join(root, "workspace");
  const workspacePath = path.join(root, "workspace-alias");
  const approved = path.join(root, "approved");
  const denied = path.join(root, "denied");
  const link = path.join(workspace, "linked");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    for (const directory of [workspace, approved, denied]) {
      await mkdir(directory);
      await writeFile(path.join(directory, "file.txt"), "content");
    }
    await symlink(workspace, workspacePath, linkType);
    await symlink(approved, link, linkType);
    const session = { workspacePath, allowedAdditionalDirectories: [] as string[] };
    assert.equal((await resolveComposerPreview(session, "@file.txt")).attachments.length, 1);
    const outside = await resolveComposerPreview(session, "@linked/file.txt");
    assert.equal(outside.attachments.length, 0);
    assert.match(outside.errors[0]!, /outside the workspace/);
    session.allowedAdditionalDirectories = [approved, path.join(root, "missing")];
    const accepted = await resolveComposerPreview(session, "@linked/file.txt");
    assert.deepEqual(accepted.errors, []);
    assert.equal(accepted.attachments.length, 1);
    await assertCapturedComposerAttachmentsAvailable(session, accepted.attachments);
    await rm(link);
    await symlink(denied, link, linkType);
    await assert.rejects(assertCapturedComposerAttachmentsAvailable(session, accepted.attachments), /outside the workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveComposerPreview はMarkdown画像をprovider画像添付として解決する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-markdown-image-"));
  const workspacePath = path.join(root, "workspace");
  const sessionFilesPath = path.join(root, "session-files");
  const imagePath = path.join(sessionFilesPath, "pasted image (1).png");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionFilesPath, { recursive: true });
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));

  try {
    const preview = await resolveComposerPreview(
      { workspacePath, allowedAdditionalDirectories: [sessionFilesPath] },
      formatMarkdownImageReference(imagePath),
    );

    assert.deepEqual(preview.errors, []);
    assert.equal(preview.attachments.length, 1);
    assert.equal(preview.attachments[0]?.kind, "image");
    assert.equal(preview.attachments[0]?.source, "markdown-image");
    assert.equal(preview.attachments[0]?.absolutePath, imagePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveComposerPreview は同じ画像のMarkdownと@pathを一つの添付へ集約する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-markdown-image-dedupe-"));
  const workspacePath = path.join(root, "workspace");
  const imagePath = path.join(workspacePath, "image.png");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(imagePath, new Uint8Array([1]));

  try {
    const preview = await resolveComposerPreview(
      { workspacePath, allowedAdditionalDirectories: [] },
      `${formatMarkdownImageReference(imagePath)} @image.png`,
    );
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.attachments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
