import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  WorkspaceChangeEntry,
  WorkspaceChangeKind,
  WorkspaceChangesResult,
  WorkspaceFileDiffRequest,
  WorkspaceFileDiffResult,
} from "../src/file-explorer/file-explorer-contract.js";

export type WorkspaceGitContext = {
  workspacePath: string;
};

export type WorkspaceGitChangesServiceDeps = {
  getWorkspaceContext(sessionId: string): Promise<WorkspaceGitContext | null>;
  runGit?: (
    workspacePath: string,
    args: string[],
    options: WorkspaceGitProcessOptions,
  ) => Promise<{ exitCode: number; stdout: Buffer; stderr: string }>;
  resolveGitExecutablePath?: () => Promise<string>;
  processEnv?: NodeJS.ProcessEnv;
  operationTimeoutMs?: number;
  cleanupRetryDelayMs?: number;
  removeTemporaryDirectory?: (directoryPath: string) => Promise<void>;
  closeDirectoryLease?: (fileHandle: FileHandle) => Promise<void>;
};

type WorkspaceGitProcessOptions = {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  stdin?: Buffer;
  signal?: AbortSignal;
};

type GitCommandResult = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
};

const GIT_GLOBAL_ARGS = ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false"] as const;
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;
const WINDOWS_UV_FS_O_TEMPORARY = 0x0040;
const MAX_CONCURRENT_WORKSPACE_GIT_OPERATIONS = 2;
const MAX_PENDING_WORKSPACE_GIT_OPERATIONS = 16;
const DEFAULT_WORKSPACE_GIT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_CLEANUP_RETRY_DELAY_MS = 50;
const CLEANUP_ATTEMPTS = 3;
let defaultGitExecutablePath: Promise<string> | null = null;

function normalizeGitConfigPath(directoryPath: string): string {
  return process.platform === "win32" ? directoryPath.replace(/\\/g, "/") : directoryPath;
}

function listAncestorDirectoryPaths(directoryPath: string): string[] {
  const ancestors: string[] = [];
  let currentPath = path.resolve(directoryPath);
  while (true) {
    ancestors.push(currentPath);
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return ancestors;
    }
    currentPath = parentPath;
  }
}

function createSafeDirectoryArgs(directoryPaths: string[]): string[] {
  return directoryPaths.flatMap((directoryPath) => [
    "-c",
    `safe.directory=${normalizeGitConfigPath(directoryPath)}`,
  ]);
}

const WORK_TREE_CONFIG_KEYS = [
  "core.autocrlf",
  "core.eol",
  "core.filemode",
  "core.symlinks",
  "core.ignorecase",
  "core.precomposeunicode",
] as const;

function normalizeGitBoolean(value: string | null): "true" | "false" | null {
  if (value === null) {
    return "true";
  }
  if (value === "") {
    return "false";
  }
  if (/^(?:true|yes|on|1)$/i.test(value)) {
    return "true";
  }
  if (/^(?:false|no|off|0)$/i.test(value)) {
    return "false";
  }
  const numericMatch = /^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)$/.exec(value);
  if (numericMatch) {
    const [, , digits, suffix] = numericMatch;
    const radix = digits.toLowerCase().startsWith("0x") ? 16 : digits.length > 1 && digits.startsWith("0") ? 8 : 10;
    const magnitudeDigits = (radix === 16 ? digits.slice(2) : radix === 8 ? digits.slice(1) : digits)
      .replace(/^0+/, "")
      .toLowerCase();
    if (!magnitudeDigits) {
      return "false";
    }
    const multiplier = suffix.toLowerCase() === "k"
      ? 1024n
      : suffix.toLowerCase() === "m"
        ? 1024n ** 2n
        : suffix.toLowerCase() === "g"
          ? 1024n ** 3n
          : 1n;
    const maximumMagnitude = process.platform === "win32"
      ? 0x7fffffffn
      : 0x7fffffffffffffffn;
    const maximumInputDigits = (maximumMagnitude / multiplier).toString(radix);
    if (
      magnitudeDigits.length > maximumInputDigits.length
      || (
        magnitudeDigits.length === maximumInputDigits.length
        && magnitudeDigits > maximumInputDigits
      )
    ) {
      return null;
    }
    return "true";
  }
  return null;
}

function normalizeWorkTreeConfigValue(key: string, value: string | null): string | null {
  if (["core.filemode", "core.symlinks", "core.ignorecase", "core.precomposeunicode"].includes(key)) {
    return normalizeGitBoolean(value);
  }
  if (key === "core.autocrlf") {
    const normalizedBoolean = normalizeGitBoolean(value);
    return normalizedBoolean ?? (value?.toLowerCase() === "input" ? "input" : null);
  }
  if (key === "core.eol") {
    const normalized = value?.toLowerCase();
    return normalized === "lf" || normalized === "crlf" || normalized === "native" ? normalized : null;
  }
  return null;
}

function parseWorkTreeConfigArgs(output: Buffer): string[] {
  const values = new Map<string, string>();
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    const separatorIndex = record.indexOf("\n");
    if (separatorIndex === 0) {
      throw new Error("Git work tree config returned an unsupported result.");
    }
    const key = (separatorIndex < 0 ? record : record.slice(0, separatorIndex)).toLowerCase();
    if (!WORK_TREE_CONFIG_KEYS.includes(key as (typeof WORK_TREE_CONFIG_KEYS)[number])) {
      continue;
    }
    const value = normalizeWorkTreeConfigValue(
      key,
      separatorIndex < 0 ? null : record.slice(separatorIndex + 1),
    );
    if (value === null) {
      throw new Error(`Git work tree config ${key} has an unsupported value.`);
    }
    values.set(key, value);
  }
  return WORK_TREE_CONFIG_KEYS.flatMap((key) => {
    const value = values.get(key);
    return value === undefined ? [] : ["-c", `${key}=${value}`];
  });
}

type WorkspaceGitAdmissionJob = {
  supersessionKey: string;
  start(): Promise<void>;
  reject(error: unknown): void;
};

const pendingWorkspaceGitOperations: WorkspaceGitAdmissionJob[] = [];
let activeWorkspaceGitOperations = 0;

type PendingTemporaryDirectoryCleanup = {
  remove(): Promise<void>;
};

type PendingLeaseCleanup = {
  close(): Promise<void>;
};

const pendingWorkspaceGitTemporaryDirectories = new Map<string, PendingTemporaryDirectoryCleanup>();
const pendingWorkspaceGitLeaseHandles = new Map<FileHandle, PendingLeaseCleanup>();
let workspaceGitCleanupTail: Promise<void> = Promise.resolve();

class WorkspaceGitOperationTimeoutError extends Error {
  constructor() {
    super("Workspace Git preview timed out before the operation completed.");
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new WorkspaceGitOperationTimeoutError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function drainWorkspaceGitOperationQueue(): void {
  while (
    activeWorkspaceGitOperations < MAX_CONCURRENT_WORKSPACE_GIT_OPERATIONS
    && pendingWorkspaceGitOperations.length > 0
  ) {
    const job = pendingWorkspaceGitOperations.shift()!;
    activeWorkspaceGitOperations += 1;
    job.start().finally(() => {
      activeWorkspaceGitOperations -= 1;
      drainWorkspaceGitOperationQueue();
    });
  }
}

function runWorkspaceGitOperationWithAdmission<T>(
  supersessionKey: string,
  timeoutMs: number,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const supersededIndex = pendingWorkspaceGitOperations.findIndex(
      (job) => job.supersessionKey === supersessionKey,
    );
    if (supersededIndex >= 0) {
      pendingWorkspaceGitOperations.splice(supersededIndex, 1)[0]?.reject(
        new Error("Workspace Git preview was superseded by a newer request."),
      );
    }
    if (pendingWorkspaceGitOperations.length >= MAX_PENDING_WORKSPACE_GIT_OPERATIONS) {
      reject(new Error("Too many Workspace Git previews are already waiting."));
      return;
    }
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    pendingWorkspaceGitOperations.push({
      supersessionKey,
      reject,
      async start() {
        timeout = setTimeout(() => {
          abortController.abort(new WorkspaceGitOperationTimeoutError());
        }, timeoutMs);
        timeout.unref?.();
        try {
          const result = await execute(abortController.signal);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          if (timeout) {
            clearTimeout(timeout);
          }
        }
      },
    });
    drainWorkspaceGitOperationQueue();
  });
}

function getDefaultGitExecutablePath(): Promise<string> {
  defaultGitExecutablePath ??= resolveTrustedGitExecutablePath(process.env);
  return defaultGitExecutablePath;
}

function createWorkspaceGitConfigReadEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inheritedEnv = Object.fromEntries(
    Object.entries(sourceEnv).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
  return {
    ...inheritedEnv,
    LC_ALL: "C",
    LANG: "C",
  };
}

function createWorkspaceGitProcessEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...createWorkspaceGitConfigReadEnv(sourceEnv),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
  };
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["git.exe"] : ["git"];
}

async function resolveTrustedGitExecutablePath(sourceEnv: NodeJS.ProcessEnv): Promise<string> {
  const pathValue = Object.entries(sourceEnv).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  for (const directoryPath of pathValue.split(path.delimiter)) {
    const trimmedPath = directoryPath.trim().replace(/^"|"$/g, "");
    if (!trimmedPath || !path.isAbsolute(trimmedPath)) {
      continue;
    }
    for (const executableName of executableNames()) {
      const candidatePath = path.join(trimmedPath, executableName);
      try {
        const canonicalPath = await realpath(candidatePath);
        const candidateStat = await stat(canonicalPath);
        if (candidateStat.isFile()) {
          return canonicalPath;
        }
      } catch {
        // Continue searching the process-start PATH.
      }
    }
  }
  throw new Error("Git executable could not be resolved from an absolute PATH entry.");
}

function runGitProcess(
  workspacePath: string,
  args: string[],
  options: WorkspaceGitProcessOptions,
): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.executablePath, args, {
        cwd: workspacePath,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdin || !childStdout || !childStderr) {
      child.kill();
      reject(new Error("Git process did not expose the required standard streams."));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let processError: Error | null = null;
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (options.signal) {
        options.signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };
    const handleAbort = () => {
      child.kill();
    };
    childStdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    childStderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", (error) => {
      processError = error;
      if (child.pid === undefined) {
        settle(() => reject(error));
      }
    });
    childStdin.once("error", (error) => {
      processError = error;
      child.kill();
    });
    child.once("close", (exitCode) => {
      settle(() => {
        if (options.signal?.aborted) {
          reject(abortReason(options.signal));
          return;
        }
        if (processError) {
          reject(processError);
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
        });
      });
    });
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) {
      handleAbort();
    }
    childStdin.end(options.stdin);
  });
}

function normalizeGitRelativePath(value: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error("Git path must be a non-empty workspace-relative path.");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Git path contains an invalid segment.");
  }
  return segments.join("/");
}

function changeKind(status: string, fallback: WorkspaceChangeKind = "modified"): WorkspaceChangeKind {
  if (status === "R" || status === "C") {
    return "renamed";
  }
  if (status === "D") {
    return "deleted";
  }
  if (status === "A") {
    return "added";
  }
  return fallback;
}

function normalizeWorkspacePrefix(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/` : "";
}

function toWorkspaceRelativePath(repositoryRelativePath: string, workspacePrefix: string): string | null {
  const normalizedPath = repositoryRelativePath.replaceAll("\\", "/");
  const normalizedPrefix = normalizeWorkspacePrefix(workspacePrefix);
  if (!normalizedPrefix) {
    return normalizeGitRelativePath(normalizedPath);
  }
  if (!normalizedPath.startsWith(normalizedPrefix)) {
    return null;
  }
  return normalizeGitRelativePath(normalizedPath.slice(normalizedPrefix.length));
}

export function parseGitPorcelainV1Z(output: Buffer, workspacePrefix = ""): WorkspaceChangeEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: WorkspaceChangeEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) {
      continue;
    }
    if (field.length < 4 || field[2] !== " ") {
      throw new Error("Git status returned an unsupported porcelain record.");
    }
    const x = field[0] ?? " ";
    const y = field[1] ?? " ";
    const repositoryRelativePath = normalizeGitRelativePath(field.slice(3));
    const isRename = x === "R" || x === "C" || y === "R" || y === "C";
    const repositoryPreviousPath = isRename ? normalizeGitRelativePath(fields[index + 1] ?? "") : null;
    if (isRename) {
      index += 1;
    }
    const currentRelativePath = toWorkspaceRelativePath(repositoryRelativePath, workspacePrefix);
    const previousRelativePath = repositoryPreviousPath
      ? toWorkspaceRelativePath(repositoryPreviousPath, workspacePrefix)
      : null;
    if (!currentRelativePath && !previousRelativePath) {
      continue;
    }
    const relativePath = currentRelativePath ?? previousRelativePath!;

    if (x === "?" && y === "?") {
      entries.push({
        relativePath,
        previousRelativePath: null,
        kinds: { "working-tree": "untracked" },
        scopes: ["working-tree"],
      });
      continue;
    }

    const scopes: WorkspaceChangeEntry["scopes"] = [];
    const kinds: WorkspaceChangeEntry["kinds"] = {};
    if (x !== " " && x !== "?") {
      scopes.push("staged");
      kinds.staged = !currentRelativePath
        ? "deleted"
        : isRename && !previousRelativePath
          ? "added"
          : changeKind(x);
    }
    if (y !== " " && y !== "?") {
      scopes.push("working-tree");
      kinds["working-tree"] = !currentRelativePath
        ? "deleted"
        : isRename && !previousRelativePath
          ? "added"
          : changeKind(y);
    }
    entries.push({
      relativePath,
      previousRelativePath: currentRelativePath ? previousRelativePath : null,
      kinds,
      scopes,
    });
  }
  return entries;
}

type WorkspaceGitFailure = {
  status: "not-git" | "failed";
  message: string;
};

type WorkspaceGitOperationFailure = WorkspaceGitFailure | {
  status: "workspace-not-found";
  message: string;
};

function failedStatus(message: string): WorkspaceGitFailure {
  return { status: "failed", message: message || "Git status failed." };
}

type DirectoryIdentity = {
  realPath: string;
  device: bigint;
  inode: bigint;
};

type GitRepositoryIdentity = {
  topLevel: DirectoryIdentity;
  gitDirectory: DirectoryIdentity;
  commonDirectory: DirectoryIdentity;
};

type WorkspaceGitOperation = {
  workspacePath: string;
  workspaceIdentity: DirectoryIdentity;
  repositoryIdentity: GitRepositoryIdentity;
  workspaceLease: DirectoryLease;
  repositoryLeases: DirectoryLease[];
  isolatedGitDirectoryPath: string | null;
  workTreeConfigArgs: string[] | null;
  signal: AbortSignal;
};

type DirectoryLease = {
  fileHandle: FileHandle;
  fileName: string;
};

type IsolatedGitContext = {
  gitDirectoryPath: string;
  lockRepositoryRelativePath: string;
  workTreeConfigArgs: string[];
};

class OperationIdentityChangedError extends Error {
  constructor() {
    super("Workspace or Git repository changed during the operation.");
  }
}

class WorkspaceNotGitRepositoryError extends Error {
  constructor() {
    super("Workspace is not a Git repository.");
  }
}

class WorkspaceGitCleanupError extends Error {
  constructor(messages: string[]) {
    super(`Workspace Git preview cleanup failed: ${messages.join("; ")}`);
  }
}

async function captureDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(directoryPath);
  const directoryStat = await stat(canonicalPath, { bigint: true });
  if (!directoryStat.isDirectory()) {
    throw new Error("Expected a directory while resolving Git identity.");
  }
  return {
    realPath: canonicalPath,
    device: directoryStat.dev,
    inode: directoryStat.ino,
  };
}

function directoryIdentityMatches(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.realPath === right.realPath
    && left.device === right.device
    && left.inode === right.inode;
}

function normalizeObjectId(output: Buffer): string | null {
  const value = output.toString("utf8").trim();
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value) ? value : null;
}

function normalizeObjectFormat(output: Buffer): "sha1" | "sha256" {
  const value = output.toString("utf8").trim();
  if (value !== "sha1" && value !== "sha256") {
    throw new Error("Git repository uses an unsupported object format.");
  }
  return value;
}

function normalizeSymbolicHead(output: Buffer): string {
  const value = output.toString("utf8").trim();
  if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error("Git HEAD uses an unsupported symbolic reference.");
  }
  return value;
}

function parseRepositoryIdentityPaths(output: Buffer): [string, string, string] {
  const lines = output.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => !line)) {
    throw new Error("Git repository identity returned an unsupported result.");
  }
  return [lines[0]!, lines[1]!, lines[2]!];
}

type GitIndexEntry = {
  mode: string;
  objectId: string;
  stage: number;
  path: string;
};

function parseGitIndexEntries(output: Buffer): GitIndexEntry[] {
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tabIndex = record.indexOf("\t");
    const match = tabIndex >= 0
      ? /^(\d+) ([0-9a-f]+) ([0-3])$/.exec(record.slice(0, tabIndex))
      : null;
    if (!match) {
      throw new Error("Git index returned an unsupported stage record.");
    }
    return {
      mode: match[1]!,
      objectId: match[2]!,
      stage: Number(match[3]),
      path: record.slice(tabIndex + 1),
    };
  });
}

function serializeGitIndexEntries(entries: GitIndexEntry[]): Buffer {
  return Buffer.from(entries.map((entry) => (
    `${entry.mode} ${entry.objectId} ${entry.stage}\t${entry.path}\0`
  )).join(""), "utf8");
}

function parseNullSeparatedPaths(output: Buffer): Set<string> {
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

function parseGitIndexFlags(output: Buffer): {
  assumeUnchangedPaths: string[];
  skipWorktreePaths: string[];
} {
  const assumeUnchangedPaths: string[] = [];
  const skipWorktreePaths: string[] = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) {
      continue;
    }
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("Git index returned an unsupported flag record.");
    }
    const tag = record[0]!;
    const filePath = record.slice(2);
    if (tag === tag.toLowerCase()) {
      assumeUnchangedPaths.push(filePath);
    }
    if (tag.toUpperCase() === "S") {
      skipWorktreePaths.push(filePath);
    }
  }
  return { assumeUnchangedPaths, skipWorktreePaths };
}

function serializeNullSeparatedPaths(paths: string[]): Buffer {
  return Buffer.from(paths.map((filePath) => `${filePath}\0`).join(""), "utf8");
}

function parseActiveGitFilterDrivers(output: Buffer): string[] {
  const fields = output.toString("utf8").split("\0");
  const drivers = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (attribute !== "filter" || !value || value === "unspecified" || value === "unset") {
      continue;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
      throw new Error("Git clean/process filters are not supported for Workspace changes.");
    }
    drivers.add(value);
  }
  return [...drivers];
}

export class WorkspaceGitChangesService {
  readonly #getWorkspaceContext: WorkspaceGitChangesServiceDeps["getWorkspaceContext"];
  readonly #runGit: NonNullable<WorkspaceGitChangesServiceDeps["runGit"]>;
  readonly #resolveGitExecutablePath: () => Promise<string>;
  readonly #gitProcessEnv: NodeJS.ProcessEnv;
  readonly #gitConfigReadEnv: NodeJS.ProcessEnv;
  readonly #operationTimeoutMs: number;
  readonly #cleanupRetryDelayMs: number;
  readonly #removeTemporaryDirectory: (directoryPath: string) => Promise<void>;
  readonly #closeDirectoryLease: (fileHandle: FileHandle) => Promise<void>;
  #gitExecutablePath: Promise<string> | null = null;

  constructor(deps: WorkspaceGitChangesServiceDeps) {
    this.#getWorkspaceContext = deps.getWorkspaceContext;
    this.#runGit = deps.runGit ?? runGitProcess;
    this.#resolveGitExecutablePath = deps.resolveGitExecutablePath
      ?? (deps.runGit ? async () => "git" : getDefaultGitExecutablePath);
    this.#gitProcessEnv = createWorkspaceGitProcessEnv(deps.processEnv ?? process.env);
    this.#gitConfigReadEnv = createWorkspaceGitConfigReadEnv(deps.processEnv ?? process.env);
    this.#operationTimeoutMs = deps.operationTimeoutMs ?? DEFAULT_WORKSPACE_GIT_OPERATION_TIMEOUT_MS;
    this.#cleanupRetryDelayMs = deps.cleanupRetryDelayMs ?? DEFAULT_CLEANUP_RETRY_DELAY_MS;
    this.#removeTemporaryDirectory = deps.removeTemporaryDirectory
      ?? ((directoryPath) => rm(directoryPath, { recursive: true, force: true }));
    this.#closeDirectoryLease = deps.closeDirectoryLease ?? ((fileHandle) => fileHandle.close());
  }

  async #getGitExecutablePath(): Promise<string> {
    if (!this.#gitExecutablePath) {
      this.#gitExecutablePath = Promise.resolve().then(() => this.#resolveGitExecutablePath());
    }
    try {
      return await this.#gitExecutablePath;
    } catch (error) {
      this.#gitExecutablePath = null;
      throw error;
    }
  }

  async #runGitCommand(
    workspacePath: string,
    args: string[],
    stdin?: Buffer,
    commonDirectoryPath?: string,
    signal?: AbortSignal,
    indexFilePath?: string,
    safeDirectoryPaths: string[] = [],
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    throwIfAborted(signal);
    const executablePath = await this.#getGitExecutablePath();
    return this.#runGit(workspacePath, [
      ...GIT_GLOBAL_ARGS,
      ...createSafeDirectoryArgs(safeDirectoryPaths),
      ...args,
    ], {
      executablePath,
      env: commonDirectoryPath || indexFilePath
        ? {
            ...this.#gitProcessEnv,
            ...(commonDirectoryPath ? { GIT_COMMON_DIR: commonDirectoryPath } : {}),
            ...(indexFilePath ? { GIT_INDEX_FILE: indexFilePath } : {}),
          }
        : this.#gitProcessEnv,
      stdin,
      signal,
    });
  }

  async #readWorkTreeConfigArgs(operation: WorkspaceGitOperation): Promise<string[]> {
    await this.#assertOperationIdentity(operation);
    const executablePath = await this.#getGitExecutablePath();
    let result: GitCommandResult;
    try {
      result = await this.#runGit(operation.workspaceIdentity.realPath, [
        ...GIT_GLOBAL_ARGS,
        ...createSafeDirectoryArgs([operation.repositoryIdentity.topLevel.realPath]),
        `--git-dir=${operation.repositoryIdentity.gitDirectory.realPath}`,
        `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
        "config",
        "--null",
        "--get-regexp",
        "^core\\.(autocrlf|eol|filemode|symlinks|ignorecase|precomposeunicode)$",
      ], {
        executablePath,
        env: {
          ...this.#gitConfigReadEnv,
          GIT_COMMON_DIR: operation.repositoryIdentity.commonDirectory.realPath,
        },
        signal: operation.signal,
      });
    } finally {
      await this.#assertOperationIdentity(operation);
    }
    if (result.exitCode === 1 && result.stdout.length === 0) {
      return [];
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git work tree config could not be resolved.");
    }
    return parseWorkTreeConfigArgs(result.stdout);
  }

  async #captureRepositoryIdentity(
    workspacePath: string,
    expectedWorkspaceIdentity: DirectoryIdentity,
    signal: AbortSignal,
  ): Promise<GitRepositoryIdentity> {
    throwIfAborted(signal);
    await this.#assertWorkspaceIdentity(workspacePath, expectedWorkspaceIdentity);
    let result: GitCommandResult;
    try {
      result = await this.#runGitCommand(expectedWorkspaceIdentity.realPath, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ], undefined, undefined, signal, undefined, listAncestorDirectoryPaths(expectedWorkspaceIdentity.realPath));
    } finally {
      await this.#assertWorkspaceIdentity(workspacePath, expectedWorkspaceIdentity);
    }
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr)) {
        throw new WorkspaceNotGitRepositoryError();
      }
      throw new Error(result.stderr || "Git repository identity could not be resolved.");
    }
    const [topLevelPath, gitDirectoryPath, commonDirectoryPath] = parseRepositoryIdentityPaths(result.stdout);
    const identity = {
      topLevel: await captureDirectoryIdentity(topLevelPath),
      gitDirectory: await captureDirectoryIdentity(gitDirectoryPath),
      commonDirectory: await captureDirectoryIdentity(commonDirectoryPath),
    };
    await this.#assertWorkspaceIdentity(workspacePath, expectedWorkspaceIdentity);
    return identity;
  }

  async #assertWorkspaceIdentity(workspacePath: string, expected: DirectoryIdentity): Promise<void> {
    try {
      const current = await captureDirectoryIdentity(workspacePath);
      if (!directoryIdentityMatches(current, expected)) {
        throw new OperationIdentityChangedError();
      }
    } catch (error) {
      if (error instanceof OperationIdentityChangedError) {
        throw error;
      }
      throw new OperationIdentityChangedError();
    }
  }

  async #assertOperationIdentity(operation: WorkspaceGitOperation): Promise<void> {
    throwIfAborted(operation.signal);
    try {
      await this.#assertWorkspaceIdentity(operation.workspacePath, operation.workspaceIdentity);
      for (const expectedIdentity of [
        operation.repositoryIdentity.topLevel,
        operation.repositoryIdentity.gitDirectory,
        operation.repositoryIdentity.commonDirectory,
      ]) {
        const currentIdentity = await captureDirectoryIdentity(expectedIdentity.realPath);
        if (!directoryIdentityMatches(currentIdentity, expectedIdentity)) {
          throw new OperationIdentityChangedError();
        }
      }
      await this.#assertWorkspaceIdentity(operation.workspacePath, operation.workspaceIdentity);
    } catch (error) {
      if (error instanceof OperationIdentityChangedError) {
        throw error;
      }
      throw new OperationIdentityChangedError();
    }
  }

  async #runIdentityBoundGit(
    operation: WorkspaceGitOperation,
    args: string[],
    stdin?: Buffer,
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    await this.#assertOperationIdentity(operation);
    let result: GitCommandResult;
    try {
      result = await this.#runGitCommand(
        operation.workspaceIdentity.realPath,
        [
          `--git-dir=${operation.repositoryIdentity.gitDirectory.realPath}`,
          `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
          ...args,
        ],
        stdin,
        operation.repositoryIdentity.commonDirectory.realPath,
        operation.signal,
        undefined,
        [operation.repositoryIdentity.topLevel.realPath],
      );
    } catch (error) {
      await this.#assertOperationIdentity(operation);
      throw error;
    }
    await this.#assertOperationIdentity(operation);
    return result;
  }

  async #hasConfiguredFilterCommand(
    operation: WorkspaceGitOperation,
    driver: string,
    commandName: "clean" | "process",
  ): Promise<boolean> {
    const result = await this.#runIdentityBoundGit(operation, [
      "config",
      "--includes",
      "--get-all",
      `filter.${driver}.${commandName}`,
    ]);
    if (result.exitCode === 1) {
      return false;
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git filter configuration could not be inspected.");
    }
    return result.stdout.toString("utf8").split(/\r?\n/).some((value) => value.trim().length > 0);
  }

  async #assertNoActiveExternalFilters(
    operation: WorkspaceGitOperation,
    lockRepositoryRelativePath: string,
  ): Promise<void> {
    const files = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      `:(exclude,top,literal)${lockRepositoryRelativePath}`,
    ]);
    if (files.exitCode !== 0) {
      throw new Error(files.stderr || "Git file attributes could not be inspected.");
    }
    if (files.stdout.length === 0) {
      return;
    }
    const attributes = await this.#runIdentityBoundGit(
      operation,
      ["check-attr", "-z", "--stdin", "filter"],
      files.stdout,
    );
    if (attributes.exitCode !== 0) {
      throw new Error(attributes.stderr || "Git file attributes could not be inspected.");
    }
    for (const driver of parseActiveGitFilterDrivers(attributes.stdout)) {
      if (
        await this.#hasConfiguredFilterCommand(operation, driver, "clean")
        || await this.#hasConfiguredFilterCommand(operation, driver, "process")
      ) {
        throw new Error("Git clean/process filters are not supported for Workspace changes.");
      }
    }
  }

  async #runIsolatedGit(
    operation: WorkspaceGitOperation,
    isolatedContext: IsolatedGitContext,
    args: string[],
    stdin?: Buffer,
  ): Promise<GitCommandResult> {
    await this.#assertOperationIdentity(operation);
    const result = await this.#runGitCommand(
      operation.workspaceIdentity.realPath,
      [
        `--git-dir=${isolatedContext.gitDirectoryPath}`,
        `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
        "-c",
        "core.bare=false",
        ...isolatedContext.workTreeConfigArgs,
        ...args,
      ],
      stdin,
      undefined,
      operation.signal,
    );
    await this.#assertOperationIdentity(operation);
    return result;
  }

  async #projectWorkspaceIndex(
    operation: WorkspaceGitOperation,
    rootPath: string,
    gitDirectoryPath: string,
    headObjectId: string | null,
  ): Promise<void> {
    const indexEntriesResult = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "--stage",
      "--full-name",
      "-z",
      "--",
      ".",
    ]);
    if (indexEntriesResult.exitCode !== 0) {
      throw new Error(indexEntriesResult.stderr || "Git index could not be captured.");
    }
    const indexFlagsResult = await this.#runIdentityBoundGit(operation, [
      "ls-files",
      "-v",
      "--full-name",
      "-z",
      "--",
      ".",
    ]);
    if (indexFlagsResult.exitCode !== 0) {
      throw new Error(indexFlagsResult.stderr || "Git index flags could not be captured.");
    }
    const cachedAddedResult = await this.#runIdentityBoundGit(operation, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=A",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ".",
    ]);
    if (cachedAddedResult.exitCode !== 0) {
      throw new Error(cachedAddedResult.stderr || "Git staged additions could not be captured.");
    }
    const headPaths = new Set<string>();
    if (headObjectId) {
      const headPathsResult = await this.#runIdentityBoundGit(operation, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ".",
      ]);
      if (headPathsResult.exitCode !== 0) {
        throw new Error(headPathsResult.stderr || "Git HEAD paths could not be captured.");
      }
      for (const filePath of parseNullSeparatedPaths(headPathsResult.stdout)) {
        headPaths.add(filePath);
      }
    }
    const emptyBlobResult = await this.#runGitCommand(
      rootPath,
      [
        `--git-dir=${gitDirectoryPath}`,
        "hash-object",
        "--stdin",
      ],
      Buffer.alloc(0),
      undefined,
      operation.signal,
    );
    const emptyBlobObjectId = emptyBlobResult.exitCode === 0
      ? normalizeObjectId(emptyBlobResult.stdout)
      : null;
    if (!emptyBlobObjectId) {
      throw new Error(emptyBlobResult.stderr || "Git empty blob identity could not be resolved.");
    }

    const indexEntries = parseGitIndexEntries(indexEntriesResult.stdout);
    const cachedAddedPaths = parseNullSeparatedPaths(cachedAddedResult.stdout);
    const intentToAddEntries = indexEntries
      .filter((entry) => entry.stage === 0
        && entry.objectId === emptyBlobObjectId
        && !headPaths.has(entry.path)
        && !cachedAddedPaths.has(entry.path));
    const intentToAddPaths = intentToAddEntries.map((entry) => entry.path);
    const intentToAddPathSet = new Set(intentToAddPaths);
    const materializedEntries = indexEntries.filter((entry) => !intentToAddPathSet.has(entry.path));
    if (intentToAddPaths.length > 0) {
      const intentWorkTreePath = path.join(rootPath, "intent-worktree");
      const intentIndexPath = path.join(rootPath, "intent-index");
      await mkdir(intentWorkTreePath, { recursive: true });
      for (const intentToAddPath of intentToAddPaths) {
        const placeholderPath = path.resolve(
          intentWorkTreePath,
          ...normalizeGitRelativePath(intentToAddPath).split("/"),
        );
        const relativePlaceholderPath = path.relative(intentWorkTreePath, placeholderPath);
        if (!relativePlaceholderPath || relativePlaceholderPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePlaceholderPath)) {
          throw new Error("Intent-to-add path escaped the isolated work tree.");
        }
      }

      const emptyTreeResult = await this.#runGitCommand(rootPath, [
        `--git-dir=${gitDirectoryPath}`,
        "hash-object",
        "-w",
        "-t",
        "tree",
        "--stdin",
      ], Buffer.alloc(0), undefined, operation.signal);
      const emptyTreeObjectId = emptyTreeResult.exitCode === 0
        ? normalizeObjectId(emptyTreeResult.stdout)
        : null;
      if (!emptyTreeObjectId) {
        throw new Error(emptyTreeResult.stderr || "Git empty tree identity could not be resolved.");
      }

      // Let Git quote every path and carry the original index mode into the isolated intent-to-add entries.
      const intentIndexResult = await this.#runGitCommand(intentWorkTreePath, [
        `--git-dir=${gitDirectoryPath}`,
        `--work-tree=${intentWorkTreePath}`,
        "-c",
        "core.bare=false",
        "update-index",
        "-z",
        "--index-info",
      ], serializeGitIndexEntries(intentToAddEntries), undefined, operation.signal, intentIndexPath);
      if (intentIndexResult.exitCode !== 0) {
        throw new Error(intentIndexResult.stderr || "Intent-to-add index metadata could not be projected.");
      }
      const intentPatchResult = await this.#runGitCommand(intentWorkTreePath, [
        `--git-dir=${gitDirectoryPath}`,
        `--work-tree=${intentWorkTreePath}`,
        "-c",
        "core.bare=false",
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        emptyTreeObjectId,
      ], undefined, undefined, operation.signal, intentIndexPath);
      if (intentPatchResult.exitCode !== 0 || intentPatchResult.stdout.length === 0) {
        throw new Error(intentPatchResult.stderr || "Intent-to-add patch could not be projected.");
      }
      const intentResult = await this.#runGitCommand(intentWorkTreePath, [
        `--git-dir=${gitDirectoryPath}`,
        `--work-tree=${intentWorkTreePath}`,
        "-c",
        "core.bare=false",
        "-c",
        "core.symlinks=false",
        "apply",
        "--intent-to-add",
        "--unidiff-zero",
        "--whitespace=nowarn",
        "-",
      ], intentPatchResult.stdout, undefined, operation.signal);
      if (intentResult.exitCode !== 0) {
        throw new Error(intentResult.stderr || "Intent-to-add index entries could not be projected.");
      }
    }
    if (materializedEntries.length > 0) {
      const updateIndexResult = await this.#runGitCommand(rootPath, [
        `--git-dir=${gitDirectoryPath}`,
        `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
        "-c",
        "core.bare=false",
        "update-index",
        "-z",
        "--index-info",
      ], serializeGitIndexEntries(materializedEntries), undefined, operation.signal);
      if (updateIndexResult.exitCode !== 0) {
        throw new Error(updateIndexResult.stderr || "Isolated Git index could not be created.");
      }
    }

    const { assumeUnchangedPaths, skipWorktreePaths } = parseGitIndexFlags(indexFlagsResult.stdout);
    for (const [flag, filePaths] of [
      ["--assume-unchanged", assumeUnchangedPaths],
      ["--skip-worktree", skipWorktreePaths],
    ] as const) {
      if (filePaths.length === 0) {
        continue;
      }
      const flagResult = await this.#runGitCommand(rootPath, [
        `--git-dir=${gitDirectoryPath}`,
        `--work-tree=${operation.repositoryIdentity.topLevel.realPath}`,
        "-c",
        "core.bare=false",
        "update-index",
        flag,
        "-z",
        "--stdin",
      ], serializeNullSeparatedPaths(filePaths), undefined, operation.signal);
      if (flagResult.exitCode !== 0) {
        throw new Error(flagResult.stderr || "Git index flags could not be projected.");
      }
    }
  }

  async #prepareIsolatedGit(
    operation: WorkspaceGitOperation,
    workspacePrefix: string,
  ): Promise<IsolatedGitContext> {
    if (operation.isolatedGitDirectoryPath) {
      return {
        gitDirectoryPath: path.join(operation.isolatedGitDirectoryPath, "repository.git"),
        lockRepositoryRelativePath: `${normalizeWorkspacePrefix(workspacePrefix)}${operation.workspaceLease.fileName}`,
        workTreeConfigArgs: operation.workTreeConfigArgs ?? [],
      };
    }
    throwIfAborted(operation.signal);
    operation.workTreeConfigArgs = await this.#readWorkTreeConfigArgs(operation);
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "withmate-git-preview-"));
    operation.isolatedGitDirectoryPath = rootPath;
    const gitDirectoryPath = path.join(rootPath, "repository.git");

    const objectFormatResult = await this.#runIdentityBoundGit(operation, [
      "rev-parse",
      "--show-object-format",
    ]);
    if (objectFormatResult.exitCode !== 0) {
      throw new Error(objectFormatResult.stderr || "Git object format could not be resolved.");
    }
    const objectFormat = normalizeObjectFormat(objectFormatResult.stdout);
    const initResult = await this.#runGitCommand(rootPath, [
      "init",
      "--bare",
      "--quiet",
      ...(objectFormat === "sha256" ? ["--object-format=sha256"] : []),
      gitDirectoryPath,
    ], undefined, undefined, operation.signal);
    if (initResult.exitCode !== 0) {
      throw new Error(initResult.stderr || "Isolated Git metadata could not be initialized.");
    }

    const objectDirectoryPath = path.join(operation.repositoryIdentity.commonDirectory.realPath, "objects");
    if (/\r|\n/.test(objectDirectoryPath)) {
      throw new Error("Git object directory path contains an unsupported newline.");
    }
    await mkdir(path.join(gitDirectoryPath, "objects", "info"), { recursive: true });
    await writeFile(
      path.join(gitDirectoryPath, "objects", "info", "alternates"),
      `${objectDirectoryPath.replaceAll("\\", "/")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const headResult = await this.#runIdentityBoundGit(operation, ["rev-parse", "--verify", "HEAD"]);
    const headObjectId = headResult.exitCode === 0 ? normalizeObjectId(headResult.stdout) : null;
    if (headResult.exitCode === 0 && !headObjectId) {
      throw new Error("Git HEAD returned an unsupported object ID.");
    }
    if (headObjectId) {
      await writeFile(path.join(gitDirectoryPath, "HEAD"), `${headObjectId}\n`, { encoding: "utf8", mode: 0o600 });
    } else {
      const symbolicHeadResult = await this.#runIdentityBoundGit(operation, ["symbolic-ref", "-q", "HEAD"]);
      if (symbolicHeadResult.exitCode !== 0) {
        throw new Error(symbolicHeadResult.stderr || "Git HEAD could not be resolved.");
      }
      const symbolicHead = normalizeSymbolicHead(symbolicHeadResult.stdout);
      await writeFile(
        path.join(gitDirectoryPath, "HEAD"),
        `ref: ${symbolicHead}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }

    await this.#projectWorkspaceIndex(operation, rootPath, gitDirectoryPath, headObjectId);

    return {
      gitDirectoryPath,
      lockRepositoryRelativePath: `${normalizeWorkspacePrefix(workspacePrefix)}${operation.workspaceLease.fileName}`,
      workTreeConfigArgs: operation.workTreeConfigArgs,
    };
  }

  async #retryCleanup(label: string, execute: () => Promise<void>): Promise<Error | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await execute();
        return null;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < CLEANUP_ATTEMPTS && this.#cleanupRetryDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.#cleanupRetryDelayMs));
        }
      }
    }
    const code = typeof lastError === "object" && lastError !== null && "code" in lastError
      ? String(lastError.code)
      : "unknown error";
    return new Error(`${label} (${code})`);
  }

  async #cleanupPendingResources(): Promise<WorkspaceGitCleanupError | null> {
    let releaseCleanup!: () => void;
    const previousCleanup = workspaceGitCleanupTail;
    workspaceGitCleanupTail = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    await previousCleanup;
    try {
      return await this.#cleanupPendingResourcesExclusive();
    } finally {
      releaseCleanup();
    }
  }

  async #cleanupPendingResourcesExclusive(): Promise<WorkspaceGitCleanupError | null> {
    const failures: string[] = [];
    for (const [directoryPath, cleanup] of [...pendingWorkspaceGitTemporaryDirectories]) {
      const error = await this.#retryCleanup(
        "temporary Git directory could not be removed",
        cleanup.remove,
      );
      if (error) {
        failures.push(error.message);
      } else {
        pendingWorkspaceGitTemporaryDirectories.delete(directoryPath);
      }
    }
    for (const [fileHandle, cleanup] of [...pendingWorkspaceGitLeaseHandles]) {
      const error = await this.#retryCleanup(
        "directory lease could not be released",
        cleanup.close,
      );
      if (error) {
        failures.push(error.message);
      } else {
        pendingWorkspaceGitLeaseHandles.delete(fileHandle);
      }
    }
    return failures.length > 0 ? new WorkspaceGitCleanupError(failures) : null;
  }

  #trackTemporaryDirectory(directoryPath: string): void {
    pendingWorkspaceGitTemporaryDirectories.set(directoryPath, {
      remove: () => this.#removeTemporaryDirectory(directoryPath),
    });
  }

  #trackLeaseHandle(fileHandle: FileHandle): void {
    pendingWorkspaceGitLeaseHandles.set(fileHandle, {
      close: () => this.#closeDirectoryLease(fileHandle),
    });
  }

  async #acquireDirectoryLease(identity: DirectoryIdentity): Promise<DirectoryLease> {
    if (process.platform !== "win32") {
      throw new Error("Secure Workspace Git preview is not available on this platform.");
    }
    const fileName = `.withmate-git-preview-${randomUUID()}.tmp`;
    const filePath = path.join(identity.realPath, fileName);
    const flags = fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_RDWR
      | WINDOWS_UV_FS_O_TEMPORARY;
    const fileHandle = await open(filePath, flags, 0o600);
    try {
      const currentIdentity = await captureDirectoryIdentity(identity.realPath);
      if (!directoryIdentityMatches(currentIdentity, identity)) {
        throw new OperationIdentityChangedError();
      }
      return { fileHandle, fileName };
    } catch (error) {
      this.#trackLeaseHandle(fileHandle);
      const cleanupError = await this.#cleanupPendingResources();
      throw cleanupError ?? error;
    }
  }

  async #openOperation(workspacePath: string, signal: AbortSignal): Promise<WorkspaceGitOperation> {
    throwIfAborted(signal);
    const workspaceIdentity = await captureDirectoryIdentity(workspacePath);
    const workspaceLease = await this.#acquireDirectoryLease(workspaceIdentity);
    const repositoryLeases: DirectoryLease[] = [];
    try {
      const repositoryIdentity = await this.#captureRepositoryIdentity(workspacePath, workspaceIdentity, signal);
      const leasedIdentityKeys = new Set([
        `${workspaceIdentity.device}:${workspaceIdentity.inode}`,
      ]);
      for (const identity of [
        repositoryIdentity.topLevel,
        repositoryIdentity.gitDirectory,
        repositoryIdentity.commonDirectory,
      ]) {
        const identityKey = `${identity.device}:${identity.inode}`;
        if (leasedIdentityKeys.has(identityKey)) {
          continue;
        }
        repositoryLeases.push(await this.#acquireDirectoryLease(identity));
        leasedIdentityKeys.add(identityKey);
      }
      return {
        workspacePath,
        workspaceIdentity,
        repositoryIdentity,
        workspaceLease,
        repositoryLeases,
        isolatedGitDirectoryPath: null,
        workTreeConfigArgs: null,
        signal,
      };
    } catch (error) {
      for (const lease of [workspaceLease, ...repositoryLeases]) {
        this.#trackLeaseHandle(lease.fileHandle);
      }
      const cleanupError = await this.#cleanupPendingResources();
      throw cleanupError ?? error;
    }
  }

  async #closeOperation(operation: WorkspaceGitOperation): Promise<WorkspaceGitCleanupError | null> {
    if (operation.isolatedGitDirectoryPath) {
      this.#trackTemporaryDirectory(operation.isolatedGitDirectoryPath);
    }
    for (const lease of [operation.workspaceLease, ...operation.repositoryLeases]) {
      this.#trackLeaseHandle(lease.fileHandle);
    }
    return this.#cleanupPendingResources();
  }

  async #readWorkspacePrefix(operation: WorkspaceGitOperation): Promise<string> {
    const prefixResult = await this.#runIdentityBoundGit(operation, ["rev-parse", "--show-prefix"]);
    if (prefixResult.exitCode !== 0) {
      throw new Error(prefixResult.stderr || "Git Workspace prefix could not be resolved.");
    }
    const prefix = prefixResult.stdout.toString("utf8").replace(/\r?\n$/, "");
    const prefixedDirectory = await captureDirectoryIdentity(
      path.resolve(operation.repositoryIdentity.topLevel.realPath, prefix),
    );
    if (!directoryIdentityMatches(prefixedDirectory, operation.workspaceIdentity)) {
      throw new OperationIdentityChangedError();
    }
    return prefix;
  }

  async #listChangesInOperation(operation: WorkspaceGitOperation): Promise<WorkspaceChangeEntry[]> {
    const workspacePrefix = await this.#readWorkspacePrefix(operation);
    const isolatedContext = await this.#prepareIsolatedGit(operation, workspacePrefix);
    await this.#assertNoActiveExternalFilters(operation, isolatedContext.lockRepositoryRelativePath);
    const result = await this.#runIsolatedGit(operation, isolatedContext, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=dirty",
      "--",
      ".",
      `:(exclude,top,literal)${isolatedContext.lockRepositoryRelativePath}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "Git status failed.");
    }
    return parseGitPorcelainV1Z(result.stdout, workspacePrefix);
  }

  async #resolveOperation(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceGitOperation | WorkspaceGitOperationFailure> {
    throwIfAborted(signal);
    const context = await this.#getWorkspaceContext(sessionId);
    throwIfAborted(signal);
    if (!context) {
      return { status: "workspace-not-found", message: "Workspace could not be resolved for this session." };
    }
    try {
      return await this.#openOperation(context.workspacePath, signal);
    } catch (error) {
      if (error instanceof WorkspaceGitCleanupError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Workspace directory was not found.";
      if (error instanceof WorkspaceNotGitRepositoryError) {
        return { status: "not-git", message };
      }
      if (error instanceof OperationIdentityChangedError) {
        return { status: "failed", message };
      }
      try {
        const workspaceStat = await stat(context.workspacePath);
        if (!workspaceStat.isDirectory()) {
          return { status: "workspace-not-found", message: "Workspace directory was not found." };
        }
      } catch {
        return { status: "workspace-not-found", message: "Workspace directory was not found." };
      }
      return failedStatus(message);
    }
  }

  async #listChangesRequest(sessionId: string, signal: AbortSignal): Promise<WorkspaceChangesResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return failedStatus(pendingCleanupError.message);
    }
    throwIfAborted(signal);
    const operation = await this.#resolveOperation(sessionId, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let result: WorkspaceChangesResult;
    try {
      const entries = await this.#listChangesInOperation(operation);
      await this.#assertOperationIdentity(operation);
      result = { status: "ok", entries };
    } catch (error) {
      result = failedStatus(error instanceof Error ? error.message : "Git status failed.");
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return failedStatus(cleanupError.message);
    }
    throwIfAborted(signal);
    return result;
  }

  async listChanges(sessionId: string): Promise<WorkspaceChangesResult> {
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${sessionId}:list`,
        this.#operationTimeoutMs,
        (signal) => this.#listChangesRequest(sessionId, signal),
      );
    } catch (error) {
      return failedStatus(error instanceof Error ? error.message : "Git status failed.");
    }
  }

  async #getFileDiffRequest(
    request: WorkspaceFileDiffRequest,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<WorkspaceFileDiffResult> {
    const pendingCleanupError = await this.#cleanupPendingResources();
    if (pendingCleanupError) {
      return failedStatus(pendingCleanupError.message);
    }
    throwIfAborted(signal);
    const operation = await this.#resolveOperation(request.sessionId, signal);
    if (!("workspacePath" in operation)) {
      throwIfAborted(signal);
      return operation;
    }
    let response: WorkspaceFileDiffResult;
    try {
      const entries = await this.#listChangesInOperation(operation);
      const change = entries.find((entry) => entry.relativePath === relativePath);
      if (!change || !change.scopes.includes(request.scope)) {
        await this.#assertOperationIdentity(operation);
        response = { status: "not-changed", message: "The selected file is not changed in this scope." };
      } else if (change.kinds[request.scope] === "untracked") {
        await this.#assertOperationIdentity(operation);
        response = { status: "untracked", message: "Untracked files do not have a Git diff yet." };
      } else {
        const workspacePrefix = normalizeWorkspacePrefix(await this.#readWorkspacePrefix(operation));
        const repositoryRelativePath = `${workspacePrefix}${relativePath}`;
        const isolatedContext = await this.#prepareIsolatedGit(operation, workspacePrefix);
        const args = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=3",
          "--ignore-submodules=dirty",
        ];
        if (request.scope === "staged") {
          args.push("--cached");
        }
        const diffPathspecs = [`:(top,literal)${repositoryRelativePath}`];
        if (change.kinds[request.scope] === "renamed" && change.previousRelativePath) {
          diffPathspecs.push(`:(top,literal)${workspacePrefix}${change.previousRelativePath}`);
        }
        args.push("--", ...diffPathspecs);
        await this.#assertNoActiveExternalFilters(operation, isolatedContext.lockRepositoryRelativePath);
        const result = await this.#runIsolatedGit(operation, isolatedContext, args);
        if (result.exitCode !== 0) {
          response = { status: "failed", message: result.stderr || "Git diff failed." };
        } else {
          const patch = result.stdout.toString("utf8");
          await this.#assertOperationIdentity(operation);
          response = patch
            ? { status: "ok", relativePath, scope: request.scope, patch }
            : { status: "not-changed", message: "Git returned an empty diff for this file." };
        }
      }
    } catch (error) {
      response = { status: "failed", message: error instanceof Error ? error.message : "Git diff failed." };
    }
    const cleanupError = await this.#closeOperation(operation);
    if (cleanupError) {
      return failedStatus(cleanupError.message);
    }
    throwIfAborted(signal);
    return response;
  }

  async getFileDiff(request: WorkspaceFileDiffRequest): Promise<WorkspaceFileDiffResult> {
    const relativePath = normalizeGitRelativePath(request.relativePath);
    if (request.scope !== "working-tree" && request.scope !== "staged") {
      return { status: "failed", message: "Unknown Git change scope." };
    }
    try {
      return await runWorkspaceGitOperationWithAdmission(
        `${request.sessionId}:diff`,
        this.#operationTimeoutMs,
        (signal) => this.#getFileDiffRequest(request, relativePath, signal),
      );
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : "Git diff failed." };
    }
  }
}
