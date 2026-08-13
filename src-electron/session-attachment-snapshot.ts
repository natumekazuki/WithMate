import { createWriteStream, type Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  ComposerAttachment,
  SessionTurnAttachmentIdentity,
  SessionTurnAttachmentReference,
} from "../src/app-state.js";
import { secureWindowsRuntimePath, type RuntimeAclTargetKind } from "./runtime-path-security.js";

const SESSION_ATTACHMENT_SNAPSHOT_NAMESPACE_PREFIX = "withmate-session-attachments-v1-";
const SESSION_ATTACHMENT_SNAPSHOT_PREFIX = "snapshot-";

export type SessionAttachmentSnapshotLease = {
  attachments: ComposerAttachment[];
  rootPath: string | null;
  dispose(): Promise<void>;
};

type FileSystemIdentity = Pick<Stats, "dev" | "ino">;

type SessionAttachmentSnapshotDeps = {
  platform?: NodeJS.Platform;
  snapshotNamespacePath: string;
  secureWindowsPath?: (targetPath: string, targetKind: RuntimeAclTargetKind) => Promise<void>;
};

export function resolveSessionAttachmentSnapshotNamespace(
  userDataPath: string,
  tempDirectoryPath = os.tmpdir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedUserDataPath = path.resolve(userDataPath);
  const identityInput = platform === "win32" ? normalizedUserDataPath.toLowerCase() : normalizedUserDataPath;
  const digest = createHash("sha256").update(identityInput, "utf8").digest("hex");
  return path.join(tempDirectoryPath, `${SESSION_ATTACHMENT_SNAPSHOT_NAMESPACE_PREFIX}${digest}`);
}

async function secureSnapshotRoot(
  rootPath: string,
  deps: SessionAttachmentSnapshotDeps,
): Promise<void> {
  const before = await lstat(rootPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Session attachment snapshot root must be a real directory.");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && before.uid !== currentUid) {
    throw new Error("Session attachment snapshot root must be owned by the current user.");
  }

  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    await (deps.secureWindowsPath ?? secureWindowsRuntimePath)(rootPath, "directory");
  } else {
    await chmod(rootPath, 0o700);
  }

  const verified = await lstat(rootPath);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("Session attachment snapshot root changed during permission verification.");
  }
  if (currentUid !== null && verified.uid !== currentUid) {
    throw new Error("Session attachment snapshot root owner changed during permission verification.");
  }
  if (platform !== "win32" && (verified.mode & 0o077) !== 0) {
    throw new Error("Session attachment snapshot root permissions are too broad.");
  }
}

export async function cleanupSessionAttachmentSnapshotOrphans(
  snapshotNamespacePath: string,
  deps: Omit<SessionAttachmentSnapshotDeps, "snapshotNamespacePath"> = {},
): Promise<void> {
  await mkdir(snapshotNamespacePath, { recursive: true, mode: 0o700 });
  await secureSnapshotRoot(snapshotNamespacePath, { ...deps, snapshotNamespacePath });
  const entries = await readdir(snapshotNamespacePath, { withFileTypes: true });
  const orphanPaths = entries
    .filter((entry) => entry.name.startsWith(SESSION_ATTACHMENT_SNAPSHOT_PREFIX))
    .map((entry) => path.join(snapshotNamespacePath, entry.name));

  const cleanupResults = await Promise.allSettled(orphanPaths.map(async (orphanPath) => {
    const stats = await lstat(orphanPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unexpected Session attachment snapshot orphan type: ${path.basename(orphanPath)}`);
    }
    await rm(orphanPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }));
  const cleanupErrors = cleanupResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Session attachment snapshot orphan cleanup failed.");
  }
}

function sameFileSystemIdentity(expected: FileSystemIdentity, actual: FileSystemIdentity): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

function sameSourceState(expected: Stats, actual: Stats): boolean {
  return sameFileSystemIdentity(expected, actual)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs;
}

async function assertCurrentIdentity(
  targetPath: string,
  expected: FileSystemIdentity,
  expectedKind: "file" | "folder",
): Promise<Stats> {
  const stats = await lstat(targetPath);
  const hasExpectedKind = expectedKind === "folder" ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !hasExpectedKind || !sameFileSystemIdentity(expected, stats)) {
    throw new Error("SessionFolder attachment changed while creating its provider snapshot.");
  }
  return stats;
}

async function copyOpenFile(
  sourcePath: string,
  destinationPath: string,
  expected: FileSystemIdentity,
): Promise<void> {
  let sourceHandle: FileHandle | null = null;
  try {
    sourceHandle = await open(sourcePath, "r");
    const openedStats = await sourceHandle.stat();
    if (!openedStats.isFile() || !sameFileSystemIdentity(expected, openedStats)) {
      throw new Error("SessionFolder attachment changed before its provider snapshot was captured.");
    }
    await pipeline(
      sourceHandle.createReadStream({ autoClose: false }),
      createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
    );
    const completedStats = await sourceHandle.stat();
    if (!completedStats.isFile() || !sameSourceState(openedStats, completedStats)) {
      throw new Error("SessionFolder attachment changed while its provider snapshot was captured.");
    }
  } finally {
    await sourceHandle?.close();
  }
}

async function copyDirectoryTree(
  sourcePath: string,
  destinationPath: string,
  rootPath: string,
  rootIdentity: Stats,
  directoryIdentity: Stats,
): Promise<void> {
  await assertCurrentIdentity(rootPath, rootIdentity, "folder");
  await assertCurrentIdentity(sourcePath, directoryIdentity, "folder");
  await mkdir(destinationPath, { mode: 0o700 });

  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    await assertCurrentIdentity(rootPath, rootIdentity, "folder");
    await assertCurrentIdentity(sourcePath, directoryIdentity, "folder");
    const childSourcePath = path.join(sourcePath, entry.name);
    const childDestinationPath = path.join(destinationPath, entry.name);
    const childStats = await lstat(childSourcePath);
    if (childStats.isSymbolicLink()) {
      throw new Error("SessionFolder folder attachments containing symbolic links cannot be snapshotted safely.");
    }
    if (childStats.isDirectory()) {
      await copyDirectoryTree(
        childSourcePath,
        childDestinationPath,
        rootPath,
        rootIdentity,
        childStats,
      );
      continue;
    }
    if (childStats.isFile()) {
      await copyOpenFile(childSourcePath, childDestinationPath, childStats);
      continue;
    }
    throw new Error("SessionFolder folder attachments may only contain files and directories.");
  }

  await assertCurrentIdentity(sourcePath, directoryIdentity, "folder");
  await assertCurrentIdentity(rootPath, rootIdentity, "folder");
  const completedDirectoryStats = await lstat(sourcePath);
  if (!sameSourceState(directoryIdentity, completedDirectoryStats)) {
    throw new Error("SessionFolder folder attachment changed while its provider snapshot was captured.");
  }
}

function assertSnapshotInput(
  attachment: ComposerAttachment,
  reference: SessionTurnAttachmentReference,
): SessionTurnAttachmentIdentity {
  const identity = reference.identity;
  if (!identity) {
    throw new Error("SessionFolder attachment admission identity is missing.");
  }
  if (
    attachment.kind !== reference.kind
    || attachment.workspaceRelativePath !== identity.canonicalRelativePath
  ) {
    throw new Error("SessionFolder attachment metadata changed before snapshot creation.");
  }
  return identity;
}

function makeSnapshotName(index: number, attachment: ComposerAttachment): string {
  const basename = path.basename(attachment.absolutePath) || attachment.kind;
  return `${index}-${basename}`;
}

export async function createSessionAttachmentSnapshot(
  attachments: readonly ComposerAttachment[],
  references: readonly SessionTurnAttachmentReference[],
  deps: SessionAttachmentSnapshotDeps,
): Promise<SessionAttachmentSnapshotLease> {
  if (attachments.length !== references.length) {
    throw new Error("SessionFolder attachment snapshot input is incomplete.");
  }
  if (attachments.length === 0) {
    return {
      attachments: [],
      rootPath: null,
      async dispose() {},
    };
  }

  await mkdir(deps.snapshotNamespacePath, { recursive: true, mode: 0o700 });
  await secureSnapshotRoot(deps.snapshotNamespacePath, deps);
  const rootPath = await mkdtemp(path.join(deps.snapshotNamespacePath, SESSION_ATTACHMENT_SNAPSHOT_PREFIX));
  let cleanupPromise: Promise<void> | null = null;
  const dispose = () => {
    cleanupPromise ??= rm(rootPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
    return cleanupPromise;
  };

  try {
    await secureSnapshotRoot(rootPath, deps);
    const snapshotAttachments: ComposerAttachment[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const reference = references[index];
      if (!attachment || !reference) {
        throw new Error("SessionFolder attachment snapshot input is incomplete.");
      }
      const identity = assertSnapshotInput(attachment, reference);
      const destinationPath = path.join(rootPath, makeSnapshotName(index, attachment));
      if (attachment.kind === "folder") {
        const sourceDirectoryStats = await assertCurrentIdentity(
          attachment.absolutePath,
          { dev: identity.device, ino: identity.inode },
          "folder",
        );
        await copyDirectoryTree(
          attachment.absolutePath,
          destinationPath,
          attachment.absolutePath,
          sourceDirectoryStats,
          sourceDirectoryStats,
        );
      } else {
        await assertCurrentIdentity(
          attachment.absolutePath,
          { dev: identity.device, ino: identity.inode },
          "file",
        );
        await copyOpenFile(
          attachment.absolutePath,
          destinationPath,
          { dev: identity.device, ino: identity.inode },
        );
      }
      snapshotAttachments.push({ ...attachment, absolutePath: destinationPath });
    }

    return {
      attachments: snapshotAttachments,
      rootPath,
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "SessionFolder attachment snapshot creation and cleanup failed.");
    }
    throw error;
  }
}
