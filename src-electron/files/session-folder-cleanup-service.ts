import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import fs, { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  isSessionFolderCleanupDateMatch,
  type SessionFolderCleanupRequest,
  type SessionFolderCleanupScan,
  type SessionFolderCleanupResult,
} from "../../src-shared/session/session-folder-cleanup.js";
import {
  getSessionIncarnationId,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import { resolveSessionFilesDirectory } from "./session-files.js";

type CleanupSession = Pick<
  SessionSummary,
  "id" | "incarnationId" | "updatedAt" | "workspacePath" | "status" | "runState"
>;
type State = { identity: object; sessions: readonly CleanupSession[] };
type Entry = { relativePath: string; stat: Stats };
type Folder = {
  session: CleanupSession;
  root: string;
  canonicalRoot: string;
  directories: Entry[];
  files: Entry[];
};
type Snapshot = {
  scan: SessionFolderCleanupScan;
  identity: object;
  folders: Folder[];
  managedStat?: Stats;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}
function overlaps(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  const a = normalize(left);
  const b = normalize(right);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  };
  return contains(a, b) || contains(b, a);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException)?.code;
}

export class SessionFolderCleanupService {
  private latest: Snapshot | null = null;
  private busy = false;

  constructor(
    private readonly deps: {
      userDataPath: string;
      readState(): Promise<State>;
      assertCurrent(identity: object): void;
      isRunning(sessionId: string): boolean;
    },
  ) {}

  private running(session: CleanupSession): boolean {
    return (
      session.status === "running" ||
      session.runState === "running" ||
      this.deps.isRunning(session.id)
    );
  }

  private async workspacePaths(
    sessions: readonly CleanupSession[],
  ): Promise<string[]> {
    const result: string[] = [];
    for (const session of sessions) {
      if (!session.workspacePath) continue;
      result.push(session.workspacePath);
      try {
        result.push(await realpath(session.workspacePath));
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR")
          throw error;
      }
    }
    return result;
  }

  async scan(
    request: SessionFolderCleanupRequest,
  ): Promise<SessionFolderCleanupScan> {
    if (this.busy)
      throw new Error("Session Folder cleanup is already in progress.");
    this.busy = true;
    this.latest = null;
    try {
      const state = await this.deps.readState();
      const workspaces = await this.workspacePaths(state.sessions);
      const scan: SessionFolderCleanupScan = {
        scanId: randomUUID(),
        request: { ...request },
        sessionCount: 0,
        totalFileCount: 0,
        totalBytes: 0,
        matchedFileCount: 0,
        matchedBytes: 0,
        skippedRunningSessionCount: 0,
        skippedWorkspaceSessionCount: 0,
        skippedLinkCount: 0,
        issues: [],
      };
      const folders: Folder[] = [];
      const managedRoot = path.join(this.deps.userDataPath, "session-files");
      let managedStat: Stats;
      try {
        managedStat = await lstat(managedRoot);
        if (managedStat.isSymbolicLink() || !managedStat.isDirectory())
          throw new Error(
            "The Session Folder storage root is not a regular directory.",
          );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        this.deps.assertCurrent(state.identity);
        this.latest = { scan, identity: state.identity, folders };
        return scan;
      }
      for (const session of state.sessions) {
        if (!isSessionFolderCleanupDateMatch(session.updatedAt, request))
          continue;
        if (this.running(session)) {
          scan.skippedRunningSessionCount++;
          continue;
        }
        const root = resolveSessionFilesDirectory(
          this.deps.userDataPath,
          session.id,
        );
        let canonicalRoot = root;
        try {
          canonicalRoot = await realpath(root);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            scan.issues.push({
              sessionId: session.id,
              relativePath: "",
              message: message(error),
              kind: "failed",
            });
            continue;
          }
        }
        if (
          workspaces.some(
            (workspace) =>
              overlaps(root, workspace) || overlaps(canonicalRoot, workspace),
          )
        ) {
          scan.skippedWorkspaceSessionCount++;
          continue;
        }
        const folder: Folder = {
          session: { ...session },
          root,
          canonicalRoot,
          files: [],
          directories: [],
        };
        const walk = async (relativePath: string): Promise<void> => {
          const absolutePath = path.join(root, relativePath);
          try {
            const stat = await lstat(absolutePath);
            if (stat.isSymbolicLink()) {
              scan.skippedLinkCount++;
              return;
            }
            if (stat.isDirectory()) {
              folder.directories.push({ relativePath, stat });
              for (const name of await readdir(absolutePath))
                await walk(path.join(relativePath, name));
            } else if (stat.isFile()) {
              scan.totalFileCount++;
              scan.totalBytes += stat.size;
              if (
                stat.size >= Math.ceil(request.minimumFileSizeMiB * 1024 * 1024)
              ) {
                folder.files.push({ relativePath, stat });
                scan.matchedFileCount++;
                scan.matchedBytes += stat.size;
              }
            }
          } catch (error) {
            if (relativePath === "" && errorCode(error) === "ENOENT") return;
            scan.issues.push({
              sessionId: session.id,
              relativePath,
              message: message(error),
              kind: "failed",
            });
          }
        };
        await walk("");
        if (folder.directories.length) {
          scan.sessionCount++;
          folders.push(folder);
        }
      }
      this.deps.assertCurrent(state.identity);
      this.latest = { scan, identity: state.identity, folders, managedStat };
      return scan;
    } finally {
      this.busy = false;
    }
  }

  async run(scanId: string): Promise<SessionFolderCleanupResult> {
    if (this.busy)
      throw new Error("Session Folder cleanup is already in progress.");
    const snapshot = this.latest;
    if (!snapshot || snapshot.scan.scanId !== scanId)
      throw new Error(
        "The cleanup scan has expired. Scan again before deleting files.",
      );
    this.latest = null;
    this.busy = true;
    try {
      const state = await this.deps.readState();
      if (state.identity !== snapshot.identity)
        throw new Error(
          "Storage has changed. Scan again before deleting files.",
        );
      const workspaces = await this.workspacePaths(state.sessions);
      const result: SessionFolderCleanupResult = {
        deletedFileCount: 0,
        deletedBytes: 0,
        deletedDirectoryCount: 0,
        skippedFileCount: 0,
        failedFileCount: 0,
        issues: [],
      };
      try {
        for (const folder of snapshot.folders) {
          this.deps.assertCurrent(state.identity);
          const current = state.sessions.find(
            (session) => session.id === folder.session.id,
          );
          if (
            !current ||
            getSessionIncarnationId(current) !==
              getSessionIncarnationId(folder.session) ||
            current.updatedAt !== folder.session.updatedAt ||
            this.running(current) ||
            !isSessionFolderCleanupDateMatch(
              current.updatedAt,
              snapshot.scan.request,
            ) ||
            workspaces.some(
              (workspace) =>
                overlaps(folder.root, workspace) ||
                overlaps(folder.canonicalRoot, workspace),
            )
          ) {
            result.skippedFileCount += folder.files.length;
            if (folder.files.length)
              result.issues.push({
                sessionId: folder.session.id,
                relativePath: "",
                message:
                  "Skipped because the Session state or Workspace has changed.",
                kind: "skipped",
              });
            continue;
          }
          const directories = new Map(
            folder.directories.map((entry) => [entry.relativePath, entry.stat]),
          );
          const validateDirectories = async (
            relativePath: string,
            isDirectory = false,
          ): Promise<boolean> => {
            const managed = await lstat(path.dirname(folder.root));
            if (
              managed.isSymbolicLink() ||
              !managed.isDirectory() ||
              !snapshot.managedStat ||
              !sameIdentity(managed, snapshot.managedStat)
            )
              return false;
            let parent = isDirectory
              ? relativePath
              : path.dirname(relativePath);
            while (true) {
              if (parent === ".") parent = "";
              const expected = directories.get(parent);
              if (!expected) return false;
              const stat = await lstat(path.join(folder.root, parent));
              if (
                stat.isSymbolicLink() ||
                !stat.isDirectory() ||
                !sameIdentity(stat, expected)
              )
                return false;
              if (!parent) return true;
              parent = path.dirname(parent);
            }
          };
          for (const file of folder.files) {
            try {
              this.deps.assertCurrent(state.identity);
              const stat = await lstat(
                path.join(folder.root, file.relativePath),
              );
              if (
                !(await validateDirectories(file.relativePath)) ||
                stat.isSymbolicLink() ||
                !stat.isFile() ||
                !sameIdentity(stat, file.stat) ||
                stat.size !== file.stat.size ||
                stat.mtimeMs !== file.stat.mtimeMs ||
                stat.ctimeMs !== file.stat.ctimeMs
              ) {
                result.skippedFileCount++;
                result.issues.push({
                  sessionId: current.id,
                  relativePath: file.relativePath,
                  message:
                    "Skipped because the file or its directory has changed since the scan.",
                  kind: "skipped",
                });
                continue;
              }
              this.deps.assertCurrent(state.identity);
              if (this.running(current)) {
                result.skippedFileCount++;
                result.issues.push({
                  sessionId: current.id,
                  relativePath: file.relativePath,
                  message: "Skipped because the Session is running.",
                  kind: "skipped",
                });
                continue;
              }
              await fs.unlink(path.join(folder.root, file.relativePath));
              result.deletedFileCount++;
              result.deletedBytes += file.stat.size;
            } catch (error) {
              this.deps.assertCurrent(state.identity);
              if (errorCode(error) === "ENOENT") result.skippedFileCount++;
              else result.failedFileCount++;
              result.issues.push({
                sessionId: current.id,
                relativePath: file.relativePath,
                message: message(error),
                kind: errorCode(error) === "ENOENT" ? "skipped" : "failed",
              });
            }
          }
          for (const directory of [...folder.directories].reverse()) {
            if (!directory.relativePath) continue;
            try {
              this.deps.assertCurrent(state.identity);
              if (!(await validateDirectories(directory.relativePath, true)))
                continue;
              this.deps.assertCurrent(state.identity);
              if (this.running(current)) continue;
              await fs.rmdir(path.join(folder.root, directory.relativePath));
              result.deletedDirectoryCount++;
            } catch (error) {
              this.deps.assertCurrent(state.identity);
              if (
                !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
                  String(errorCode(error)),
                )
              ) {
                result.issues.push({
                  sessionId: current.id,
                  relativePath: directory.relativePath,
                  message: message(error),
                  kind: "failed",
                });
              }
            }
          }
        }
      } catch (error) {
        result.skippedFileCount +=
          snapshot.scan.matchedFileCount -
          result.deletedFileCount -
          result.failedFileCount -
          result.skippedFileCount;
        result.issues.push({
          sessionId: "",
          relativePath: "",
          message: message(error),
          kind: "skipped",
        });
      }
      return result;
    } finally {
      this.busy = false;
    }
  }
}
