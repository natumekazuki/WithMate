import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveSessionFolderAttachments } from "../../src-electron/composer-attachments.js";
import {
  cleanupSessionAttachmentSnapshotOrphans,
  createSessionAttachmentSnapshot,
  resolveSessionAttachmentSnapshotNamespace,
} from "../../src-electron/session-attachment-snapshot.js";
import type { SessionTurnAttachmentReference } from "../../src/app-state.js";

async function replacePath(targetPath: string, replacementPath: string, content: string): Promise<void> {
  await writeFile(replacementPath, content, "utf8");
  await rm(targetPath, { force: true });
  await rename(replacementPath, targetPath);
}

function snapshotDeps(rootPath: string) {
  return {
    snapshotNamespacePath: resolveSessionAttachmentSnapshotNamespace(path.join(rootPath, "user-data"), rootPath),
  };
}

test("EXT-ATTACH-10-SNAPSHOT: provider snapshotはdispatch後のfile path差替えに追従せずcleanupされる", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-snapshot-file-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const sourcePath = path.join(sessionFolderPath, "brief.txt");
  const replacementPath = path.join(root, "private.txt");
  await mkdir(sessionFolderPath, { recursive: true });
  await writeFile(sourcePath, "admitted content", "utf8");
  const references: SessionTurnAttachmentReference[] = [{ kind: "file", relativePath: "brief.txt" }];

  try {
    await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    const dispatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    assert.deepEqual(dispatch.errors, []);

    const lease = await createSessionAttachmentSnapshot(dispatch.attachments, references, snapshotDeps(root));
    const snapshotPath = lease.attachments[0]?.absolutePath;
    assert.ok(snapshotPath);
    assert.notEqual(snapshotPath, sourcePath);
    assert.equal(lease.attachments[0]?.workspaceRelativePath, "brief.txt");

    await replacePath(sourcePath, replacementPath, "private replacement");
    assert.equal(await readFile(snapshotPath, "utf8"), "admitted content");

    const snapshotRoot = lease.rootPath;
    assert.ok(snapshotRoot);
    await lease.dispose();
    await assert.rejects(stat(snapshotRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-ATTACH-10-SNAPSHOT: Windows snapshot rootは内容書込前にprotected ACLを確定する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-snapshot-acl-test-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const sourcePath = path.join(sessionFolderPath, "brief.txt");
  await mkdir(sessionFolderPath, { recursive: true });
  await writeFile(sourcePath, "personal data", "utf8");
  const references: SessionTurnAttachmentReference[] = [{ kind: "file", relativePath: "brief.txt" }];

  try {
    await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    const dispatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    const securedRoots: string[] = [];
    const lease = await createSessionAttachmentSnapshot(dispatch.attachments, references, {
      platform: "win32",
      snapshotNamespacePath: resolveSessionAttachmentSnapshotNamespace(path.join(root, "user-data"), root),
      secureWindowsPath: async (targetPath, targetKind) => {
        assert.equal(targetKind, "directory");
        assert.deepEqual(await readdir(targetPath), []);
        securedRoots.push(targetPath);
      },
    });

    assert.deepEqual(securedRoots, [path.dirname(lease.rootPath ?? ""), lease.rootPath]);
    assert.equal(await readFile(lease.attachments[0]?.absolutePath ?? "", "utf8"), "personal data");
    await lease.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ATTACH-SNAPSHOT-OWNER-01: startup sweepは同じuserData namespaceのorphanだけを除去する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-snapshot-orphan-test-"));
  const userDataA = path.join(root, "user-data-a");
  const userDataB = path.join(root, "user-data-b");
  const namespaceA = resolveSessionAttachmentSnapshotNamespace(userDataA, root);
  const namespaceB = resolveSessionAttachmentSnapshotNamespace(userDataB, root);
  const orphanPath = path.join(namespaceA, "snapshot-orphan");
  const activePath = path.join(namespaceB, "snapshot-active");
  const legacyPath = path.join(root, "withmate-session-attachments-legacy");
  const unrelatedPath = path.join(root, "unrelated");
  assert.notEqual(namespaceA, namespaceB);
  assert.equal(resolveSessionAttachmentSnapshotNamespace(userDataA, root), namespaceA);
  await mkdir(orphanPath, { recursive: true });
  await mkdir(activePath, { recursive: true });
  await mkdir(legacyPath);
  await mkdir(unrelatedPath);
  await writeFile(path.join(orphanPath, "personal.txt"), "orphaned personal data", "utf8");
  await writeFile(path.join(activePath, "personal.txt"), "active personal data", "utf8");

  try {
    await cleanupSessionAttachmentSnapshotOrphans(namespaceA);
    await assert.rejects(stat(orphanPath), { code: "ENOENT" });
    assert.equal(await readFile(path.join(activePath, "personal.txt"), "utf8"), "active personal data");
    assert.ok((await stat(legacyPath)).isDirectory());
    assert.ok((await stat(unrelatedPath)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-ATTACH-10-SNAPSHOT: Copilot用folder snapshotも元directoryの後続変更から分離する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-snapshot-folder-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const sourceDirectoryPath = path.join(sessionFolderPath, "docs");
  const sourceFilePath = path.join(sourceDirectoryPath, "notes.txt");
  await mkdir(sourceDirectoryPath, { recursive: true });
  await writeFile(sourceFilePath, "snapshot notes", "utf8");
  const references: SessionTurnAttachmentReference[] = [{ kind: "folder", relativePath: "docs" }];

  try {
    await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    const dispatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    assert.deepEqual(dispatch.errors, []);

    const lease = await createSessionAttachmentSnapshot(dispatch.attachments, references, snapshotDeps(root));
    const snapshotDirectoryPath = lease.attachments[0]?.absolutePath;
    assert.ok(snapshotDirectoryPath);
    await writeFile(sourceFilePath, "changed after dispatch", "utf8");

    assert.equal(await readFile(path.join(snapshotDirectoryPath, "notes.txt"), "utf8"), "snapshot notes");
    await lease.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXT-ATTACH-10-SNAPSHOT: dispatch後かつsnapshot前のidentity差替えはprovider開始前に拒否する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-attachment-snapshot-race-"));
  const sessionFolderPath = path.join(root, "session-folder");
  const sourcePath = path.join(sessionFolderPath, "brief.txt");
  const replacementPath = path.join(root, "private.txt");
  await mkdir(sessionFolderPath, { recursive: true });
  await writeFile(sourcePath, "admitted content", "utf8");
  const references: SessionTurnAttachmentReference[] = [{ kind: "file", relativePath: "brief.txt" }];

  try {
    await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    const dispatch = await resolveSessionFolderAttachments(
      { workspacePath: sessionFolderPath, allowedAdditionalDirectories: [] },
      references,
    );
    assert.deepEqual(dispatch.errors, []);

    await replacePath(sourcePath, replacementPath, "private replacement");
    await assert.rejects(
      createSessionAttachmentSnapshot(dispatch.attachments, references, snapshotDeps(root)),
      /changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
