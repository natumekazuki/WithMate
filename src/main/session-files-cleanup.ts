import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveApplicationDataRoot,
  resolveWithMateApplicationDirectory,
  resolveWithMateSessionFilesRoot,
} from "./application-data-path.js";
import {
  removeSessionFilesFromAnchoredRoot,
  type AnchoredSessionFilesRemoveHook,
  type SessionFilesRootIdentity,
} from "./anchored-session-files-remover.js";
import { isIssuedSessionId } from "../shared/session-id.js";

type SessionFilesFileSystem = Pick<typeof fs, "lstat" | "realpath" | "stat">;
type CanonicalDirectory = Readonly<{ path: string; identity: SessionFilesRootIdentity }>;

export interface SessionFilesCleanupPort {
  deleteSessionFiles(sessionId: string): Promise<void>;
}

export class SessionFilesCleanupError extends Error {
  constructor(
    readonly code: "invalid_session_id" | "unsafe_path" | "filesystem_failed",
    options?: ErrorOptions,
  ) {
    super(
      code === "invalid_session_id"
        ? "Session ID cannot identify a Session Files directory."
        : code === "unsafe_path"
          ? "Session Files cleanup path is unsafe."
          : "Session Files cleanup failed.",
      options,
    );
  }
}

export class LocalSessionFilesCleanup implements SessionFilesCleanupPort {
  readonly #applicationDirectory: string;
  readonly #sessionFilesRoot: string;
  readonly #fileSystem: SessionFilesFileSystem;
  readonly #beforeAnchoredDelete: AnchoredSessionFilesRemoveHook | undefined;
  readonly #beforeAnchor: AnchoredSessionFilesRemoveHook | undefined;
  readonly #expectedApplicationDirectory: CanonicalDirectory | undefined;
  readonly #expectedSessionFilesRoot: CanonicalDirectory | undefined;

  constructor(
    applicationDataRoot: string = resolveApplicationDataRoot(),
    fileSystem: SessionFilesFileSystem = fs,
    beforeAnchoredDelete?: AnchoredSessionFilesRemoveHook,
    beforeAnchor?: AnchoredSessionFilesRemoveHook,
    expectedApplicationDirectory?: CanonicalDirectory,
    expectedSessionFilesRoot?: CanonicalDirectory,
  ) {
    this.#applicationDirectory = resolveWithMateApplicationDirectory(applicationDataRoot);
    this.#sessionFilesRoot = resolveWithMateSessionFilesRoot(applicationDataRoot);
    this.#fileSystem = fileSystem;
    this.#beforeAnchoredDelete = beforeAnchoredDelete;
    this.#beforeAnchor = beforeAnchor;
    this.#expectedApplicationDirectory = expectedApplicationDirectory;
    this.#expectedSessionFilesRoot = expectedSessionFilesRoot;
  }

  static async bindToApplicationDataRoot(
    applicationDataRoot: string = resolveApplicationDataRoot(),
  ): Promise<LocalSessionFilesCleanup> {
    const applicationDirectory = resolveWithMateApplicationDirectory(applicationDataRoot);
    await fs.mkdir(applicationDirectory, { recursive: true });
    const expectedApplicationDirectory = await canonicalPlainDirectoryIfPresent(applicationDirectory, fs);
    if (expectedApplicationDirectory === undefined) throw new SessionFilesCleanupError("unsafe_path");
    const sessionFilesRoot = resolveWithMateSessionFilesRoot(applicationDataRoot);
    await fs.mkdir(sessionFilesRoot, { recursive: true });
    const expectedSessionFilesRoot = await canonicalChildDirectoryIfPresent(
      sessionFilesRoot,
      expectedApplicationDirectory,
      fs,
    );
    if (expectedSessionFilesRoot === undefined) throw new SessionFilesCleanupError("unsafe_path");
    return new LocalSessionFilesCleanup(
      applicationDataRoot,
      fs,
      undefined,
      undefined,
      expectedApplicationDirectory,
      expectedSessionFilesRoot,
    );
  }

  async assertStorageOwner(): Promise<void> {
    if (this.#expectedApplicationDirectory === undefined) return;
    await assertCanonicalDirectoryIdentity(
      this.#applicationDirectory,
      this.#expectedApplicationDirectory,
      this.#fileSystem,
    );
    if (this.#expectedSessionFilesRoot === undefined) throw new SessionFilesCleanupError("unsafe_path");
    const actualSessionFilesRoot = await canonicalChildDirectoryIfPresent(
      this.#sessionFilesRoot,
      this.#expectedApplicationDirectory,
      this.#fileSystem,
    );
    if (
      actualSessionFilesRoot === undefined ||
      !sameCanonicalDirectory(actualSessionFilesRoot, this.#expectedSessionFilesRoot)
    ) {
      throw new SessionFilesCleanupError("unsafe_path");
    }
  }

  async deleteSessionFiles(sessionId: string): Promise<void> {
    assertSessionIdPathComponent(sessionId);
    try {
      const canonicalApplicationDirectory = await canonicalPlainDirectoryIfPresent(
        this.#applicationDirectory,
        this.#fileSystem,
      );
      if (canonicalApplicationDirectory === undefined) {
        if (this.#expectedApplicationDirectory !== undefined) throw new SessionFilesCleanupError("unsafe_path");
        return;
      }
      if (
        this.#expectedApplicationDirectory !== undefined &&
        !sameCanonicalDirectory(canonicalApplicationDirectory, this.#expectedApplicationDirectory)
      ) {
        throw new SessionFilesCleanupError("unsafe_path");
      }
      const canonicalSessionFilesRoot = await canonicalChildDirectoryIfPresent(
        this.#sessionFilesRoot,
        canonicalApplicationDirectory,
        this.#fileSystem,
      );
      if (canonicalSessionFilesRoot === undefined) {
        if (this.#expectedSessionFilesRoot !== undefined) throw new SessionFilesCleanupError("unsafe_path");
        return;
      }
      if (
        this.#expectedSessionFilesRoot !== undefined &&
        !sameCanonicalDirectory(canonicalSessionFilesRoot, this.#expectedSessionFilesRoot)
      ) {
        throw new SessionFilesCleanupError("unsafe_path");
      }
      await this.#beforeAnchor?.();
      await removeSessionFilesFromAnchoredRoot(
        this.#sessionFilesRoot,
        canonicalSessionFilesRoot.path,
        canonicalSessionFilesRoot.identity,
        sessionId,
        this.#beforeAnchoredDelete,
      );
    } catch (error) {
      if (error instanceof SessionFilesCleanupError) throw error;
      throw new SessionFilesCleanupError("filesystem_failed", { cause: error });
    }
  }
}

function assertSessionIdPathComponent(sessionId: string): void {
  if (!isIssuedSessionId(sessionId)) {
    throw new SessionFilesCleanupError("invalid_session_id");
  }
}

async function canonicalPlainDirectoryIfPresent(
  directoryPath: string,
  fileSystem: SessionFilesFileSystem,
): Promise<CanonicalDirectory | undefined> {
  const stats = await lstatIfPresent(directoryPath, fileSystem);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SessionFilesCleanupError("unsafe_path");
  const canonicalDirectory = await realpathIfPresent(directoryPath, fileSystem);
  if (canonicalDirectory === undefined) return undefined;
  const identity = await directoryIdentityIfPresent(directoryPath, fileSystem);
  if (identity === undefined) return undefined;

  const finalStats = await lstatIfPresent(directoryPath, fileSystem);
  const finalCanonicalDirectory = await realpathIfPresent(directoryPath, fileSystem);
  const finalIdentity = await directoryIdentityIfPresent(directoryPath, fileSystem);
  if (
    finalStats === undefined ||
    finalStats.isSymbolicLink() ||
    !finalStats.isDirectory() ||
    finalCanonicalDirectory !== canonicalDirectory ||
    finalIdentity === undefined ||
    !sameDirectoryIdentity(finalIdentity, identity)
  ) {
    throw new SessionFilesCleanupError("unsafe_path");
  }
  return { path: canonicalDirectory, identity };
}

async function canonicalChildDirectoryIfPresent(
  directoryPath: string,
  canonicalParent: CanonicalDirectory,
  fileSystem: SessionFilesFileSystem,
): Promise<CanonicalDirectory | undefined> {
  const canonicalDirectory = await canonicalPlainDirectoryIfPresent(directoryPath, fileSystem);
  if (canonicalDirectory === undefined) return undefined;
  await assertCanonicalDirectoryIdentity(canonicalParent.path, canonicalParent, fileSystem);
  assertContainedChild(canonicalParent.path, canonicalDirectory.path);
  return canonicalDirectory;
}

async function assertCanonicalDirectoryIdentity(
  directoryPath: string,
  expected: CanonicalDirectory,
  fileSystem: SessionFilesFileSystem,
): Promise<void> {
  const actual = await canonicalPlainDirectoryIfPresent(directoryPath, fileSystem);
  if (actual === undefined || !sameCanonicalDirectory(actual, expected)) {
    throw new SessionFilesCleanupError("unsafe_path");
  }
}

function sameCanonicalDirectory(left: CanonicalDirectory, right: CanonicalDirectory): boolean {
  return left.path === right.path && sameDirectoryIdentity(left.identity, right.identity);
}

async function directoryIdentityIfPresent(
  directoryPath: string,
  fileSystem: SessionFilesFileSystem,
): Promise<SessionFilesRootIdentity | undefined> {
  try {
    const stats = await fileSystem.stat(directoryPath, { bigint: true });
    if (!stats.isDirectory() || stats.ino === 0n) throw new SessionFilesCleanupError("unsafe_path");
    return {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      birthtimeNanoseconds: stats.birthtimeNs.toString(),
    };
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function sameDirectoryIdentity(left: SessionFilesRootIdentity, right: SessionFilesRootIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNanoseconds === right.birthtimeNanoseconds
  );
}

async function realpathIfPresent(entryPath: string, fileSystem: SessionFilesFileSystem): Promise<string | undefined> {
  try {
    return await fileSystem.realpath(entryPath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

async function lstatIfPresent(entryPath: string, fileSystem: SessionFilesFileSystem) {
  try {
    return await fileSystem.lstat(entryPath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertContainedChild(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SessionFilesCleanupError("unsafe_path");
  }
}
