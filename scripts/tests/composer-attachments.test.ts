import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveComposerPreview, resolveSessionFolderAttachments } from "../../src-electron/composer-attachments.js";
import { formatMarkdownImageReference } from "../../src/composer-image-reference.js";

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

test("EXT-AUTH-01: SessionFolder policyはrelative pathだけをroot内の添付へ解決する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-session-folder-attachment-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const outsidePath = path.join(root, "outside.txt");
  await mkdir(sessionFolderPath, { recursive: true });
  await writeFile(path.join(sessionFolderPath, "inside.txt"), "inside", "utf8");
  await writeFile(outsidePath, "outside", "utf8");

  try {
    const inside = await resolveComposerPreview(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      "@inside.txt",
      { rootRelativeOnly: true },
    );
    assert.deepEqual(inside.errors, []);
    assert.equal(inside.attachments[0]?.absolutePath, path.join(sessionFolderPath, "inside.txt"));

    const absolute = await resolveComposerPreview(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [root] },
      `@${outsidePath}`,
      { rootRelativeOnly: true },
    );
    assert.equal(absolute.attachments.length, 0);
    assert.match(absolute.errors[0] ?? "", /relative path/);

    const traversal = await resolveComposerPreview(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [root] },
      "@../outside.txt",
      { rootRelativeOnly: true },
    );
    assert.equal(traversal.attachments.length, 0);
    assert.match(traversal.errors[0] ?? "", /SessionFolder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-AUTH-01: SessionFolder policyはsymlinkによるroot外escapeを拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-session-folder-symlink-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const outsideDirectory = path.join(root, "outside");
  await mkdir(sessionFolderPath, { recursive: true });
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(path.join(outsideDirectory, "secret.txt"), "secret", "utf8");
  await symlink(outsideDirectory, path.join(sessionFolderPath, "linked"), "junction");

  try {
    const preview = await resolveComposerPreview(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      "@linked/secret.txt",
      { rootRelativeOnly: true },
    );
    assert.equal(preview.attachments.length, 0);
    assert.match(preview.errors[0] ?? "", /SessionFolder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ATTACHMENT-REALPATH-01: SessionFolder内aliasは検証済みcanonical pathとして返す", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-session-folder-canonical-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const imagePath = path.join(sessionFolderPath, "images", "actual.png");
  const aliasPath = path.join(sessionFolderPath, "alias");
  await mkdir(path.dirname(imagePath), { recursive: true });
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));
  await symlink(path.dirname(imagePath), aliasPath, "junction");

  try {
    const preview = await resolveComposerPreview(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      "@alias/actual.png",
      { rootRelativeOnly: true },
    );
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.attachments[0]?.absolutePath, imagePath);
    assert.equal(preview.attachments[0]?.workspaceRelativePath, "images/actual.png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-AUTH-ROOT-02: SessionFolder policyはroot自体がjunctionなら添付を拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-session-folder-root-junction-"));
  const managedSessionFolderPath = path.join(root, "session-folder");
  const outsideDirectory = path.join(root, "outside");
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(path.join(outsideDirectory, "secret.txt"), "secret", "utf8");
  await symlink(outsideDirectory, managedSessionFolderPath, "junction");

  try {
    const preview = await resolveComposerPreview(
      { workspacePath: managedSessionFolderPath, allowedAdditionalDirectories: [] },
      "@secret.txt",
      { rootRelativeOnly: true },
    );
    assert.equal(preview.attachments.length, 0);
    assert.match(preview.errors[0] ?? "", /SessionFolder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-ATTACH-10: 明示attachmentはkindを検証しdispatch前のidentity差替えを拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-explicit-attachment-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const targetPath = path.join(sessionFolderPath, "brief.txt");
  await mkdir(sessionFolderPath, { recursive: true });
  await writeFile(targetPath, "first", "utf8");
  const references = [{ kind: "file" as const, relativePath: "brief.txt" }];

  try {
    const admitted = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    assert.deepEqual(admitted.errors, []);
    assert.ok(references[0]?.identity);

    const kindMismatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      [{ kind: "folder", relativePath: "brief.txt" }],
    );
    assert.equal(kindMismatch.attachments.length, 0);
    assert.match(kindMismatch.errors[0] ?? "", /フォルダ/);

    await rm(targetPath);
    await writeFile(targetPath, "second", "utf8");
    const dispatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    assert.equal(dispatch.attachments.length, 0);
    assert.match(dispatch.errors[0] ?? "", /changed before dispatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
