import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git fields retained for removal of a retired Companion session. */
export type CompanionRemovalGitInput = {
  sessionId: string;
  userDataPath: string;
  repoRoot: string;
  targetBranch: string;
  baseSnapshotRef: string;
  baseSnapshotCommit: string;
  companionBranch: string;
  worktreePath: string;
};

export type CompanionRemovalGitResult = {
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  baseSnapshotRefRemoved: boolean;
  stashesRemoved: number;
};

export type CompanionRemovalGitProgress = {
  worktreeDone: boolean;
  refs: Array<{ name: string; oid: string; symbolicTarget: string; done: boolean }>;
};

type GitResult = { stdout: string; stderr: string };

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", ["-c", "core.longpaths=true", "-C", cwd, ...args], {
      encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const candidate = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(candidate.stderr?.trim() || candidate.stdout?.trim() || candidate.message || "git command failed");
  }
}

function canonicalize(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function exists(value: string): Promise<boolean> {
  try { await lstat(value); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function requireRefName(value: string, kind: string): string {
  if (!value || value.includes("..") || /[\0\r\n]/.test(value)) throw new Error(`${kind} が不正です。`);
  return value;
}

type WorktreeEntry = { path: string; branch?: string };

function parseWorktreesZ(output: string): WorktreeEntry[] {
  const result: WorktreeEntry[] = [];
  let current: WorktreeEntry = { path: "" };
  for (const token of output.split("\0")) {
    if (!token) {
      if (current.path) result.push(current);
      current = { path: "" };
    } else if (token.startsWith("worktree ")) current.path = token.slice(9);
    else if (token.startsWith("branch ")) current.branch = token.slice(7);
  }
  if (current.path) result.push(current);
  return result;
}

async function expectedPaths(input: CompanionRemovalGitInput): Promise<{ branchRef: string; baseRef: string; worktree: string }> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Companion session ID が空です。");
  if (!path.isAbsolute(input.userDataPath) || !path.isAbsolute(input.repoRoot) || !path.isAbsolute(input.worktreePath)) {
    throw new Error("Companion path が絶対pathではありません。");
  }
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, "-");
  const branchRef = `refs/heads/withmate/companion/${safeId}`;
  const baseRef = `refs/withmate/companion/${safeId}/base`;
  const worktree = path.resolve(input.userDataPath, "cw", safeId.replace(/^companion-session-/, "cs-"));
  const branch = input.companionBranch.startsWith("refs/") ? input.companionBranch : `refs/heads/${input.companionBranch}`;
  const target = input.targetBranch.startsWith("refs/") ? input.targetBranch : `refs/heads/${input.targetBranch}`;
  const base = input.baseSnapshotRef;
  requireRefName(input.targetBranch, "target branch");
  requireRefName(input.companionBranch, "Companion branch");
  requireRefName(base, "base snapshot ref");
  if (branch !== branchRef || base !== baseRef) throw new Error("Companion Git資産の命名が専用namespaceと一致しません。");
  if (branch === target || base === target) throw new Error("target branch を削除対象にできません。");
  if (canonicalize(path.resolve(input.worktreePath)) !== canonicalize(worktree) && await exists(input.worktreePath)) {
    throw new Error("実在するCompanion worktree pathの配置が不正です。");
  }
  return { branchRef, baseRef, worktree };
}

async function assertExistingWorktreeBoundary(input: CompanionRemovalGitInput, expected: string): Promise<boolean> {
  if (!await exists(input.worktreePath)) return false;
  if (canonicalize(path.resolve(input.worktreePath)) !== canonicalize(expected)) throw new Error("Companion worktree pathの配置が不正です。");
  for (const candidate of [input.userDataPath, path.dirname(expected), expected]) {
    if ((await lstat(candidate)).isSymbolicLink()
      || canonicalize(await realpath(candidate)) !== canonicalize(path.resolve(candidate))) {
      throw new Error("Companion worktree path の祖先がsymlinkです。");
    }
  }
  return true;
}

async function inspectRepo(input: CompanionRemovalGitInput, branchRef: string) {
  let repoRoot: string;
  try { repoRoot = await realpath(input.repoRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // A retired workspace may remain as an ordinary directory after its Git
  // metadata has been removed. Do not discover or modify an ancestor repo.
  const hasGitEntry = await exists(path.join(repoRoot, ".git"));
  const hasBareMetadata = await exists(path.join(repoRoot, "HEAD")) && await exists(path.join(repoRoot, "objects"));
  if (!hasGitEntry && !hasBareMetadata) return null;
  if (canonicalize(repoRoot) === canonicalize(path.resolve(input.worktreePath))) {
    throw new Error("repo root をworktreeとして削除できません。");
  }
  if ((await runGit(repoRoot, ["rev-parse", "--is-bare-repository"])).stdout === "true") {
    return { repoRoot, registered: [] as WorktreeEntry[] };
  }
  const actualRoot = canonicalize((await runGit(repoRoot, ["rev-parse", "--show-toplevel"])).stdout);
  if (actualRoot !== canonicalize(repoRoot)) throw new Error("Companion repo root の所有を確認できません。");
  const listed = parseWorktreesZ((await runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"])).stdout);
  const requested = canonicalize(path.resolve(input.worktreePath));
  const registered = listed.filter((entry) => canonicalize(entry.path) === requested);
  if (listed.some((entry) => entry.branch === branchRef && canonicalize(entry.path) !== requested)) throw new Error("Companion branch が別worktreeでcheckoutされています。");
  if (registered.length > 1 || (registered.length === 1 && registered[0].branch !== branchRef)) throw new Error("Companion worktree のGit登録を確認できません。");
  return { repoRoot, registered };
}

async function readRef(repoRoot: string, name: string) {
  const output = (await runGit(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", name])).stdout;
  const row = output.split("\n").map((line) => line.split("\0")).find((fields) => fields[0] === name);
  return row ? { name, oid: row[1], symbolicTarget: row[2] ?? "" } : null;
}

/** Capture current removal targets, not the retired session's historical commit. */
export async function captureCompanionGitRemovalProgress(input: CompanionRemovalGitInput): Promise<CompanionRemovalGitProgress> {
  const { branchRef, baseRef, worktree } = await expectedPaths(input);
  await assertExistingWorktreeBoundary(input, worktree);
  const repo = await inspectRepo(input, branchRef);
  const refs: CompanionRemovalGitProgress["refs"] = [];
  if (repo) {
    for (const name of [branchRef, baseRef]) {
      const ref = await readRef(repo.repoRoot, name);
      if (ref) refs.push({ ...ref, done: false });
    }
  }
  return { worktreeDone: false, refs };
}

export async function removeCompanionGitAssets(
  input: CompanionRemovalGitInput,
  progress?: CompanionRemovalGitProgress,
  saveProgress: () => void = () => undefined,
): Promise<CompanionRemovalGitResult> {
  const state = progress ?? await captureCompanionGitRemovalProgress(input);
  const { branchRef, baseRef, worktree: expectedWorktree } = await expectedPaths(input);
  if (typeof state.worktreeDone !== "boolean" || !Array.isArray(state.refs)
    || state.refs.some((ref) => ![branchRef, baseRef].includes(ref.name) || !/^[a-f0-9]{40,64}$/.test(ref.oid)
      || typeof ref.symbolicTarget !== "string" || typeof ref.done !== "boolean")) {
    throw new Error("Companion Git removal progress is invalid.");
  }
  const worktreeExists = !state.worktreeDone && await assertExistingWorktreeBoundary(input, expectedWorktree);
  const repo = await inspectRepo(input, branchRef);
  if (!repo) {
    if (worktreeExists) await rm(input.worktreePath, { recursive: true, force: true });
    state.worktreeDone = true;
    saveProgress();
    return { worktreeRemoved: worktreeExists, branchRemoved: false, baseSnapshotRefRemoved: false, stashesRemoved: 0 };
  }
  const { repoRoot, registered } = repo;
  const assertRefUnchanged = async (ref: CompanionRemovalGitProgress["refs"][number]) => {
    const current = await readRef(repoRoot, ref.name);
    if (current && (current.oid !== ref.oid || current.symbolicTarget !== ref.symbolicTarget)) {
      throw new Error("A Companion removal ref was replaced; the replacement will not be deleted.");
    }
    return current;
  };
  for (const ref of state.refs) if (!ref.done) await assertRefUnchanged(ref);
  let worktreeRemoved = false;
  if (!state.worktreeDone) {
    if (registered.length > 0) {
      await runGit(repoRoot, ["worktree", "remove", "--force", input.worktreePath]);
      worktreeRemoved = true;
    } else if (worktreeExists) {
      await rm(input.worktreePath, { recursive: true, force: true });
      worktreeRemoved = true;
    }
    state.worktreeDone = true;
    saveProgress();
  }
  let branchRemoved = false;
  let baseSnapshotRefRemoved = false;
  for (const ref of state.refs) {
    if (ref.done) continue;
    if (await assertRefUnchanged(ref)) {
      await runGit(repoRoot, ["update-ref", "--no-deref", "-d", ref.name, ref.oid]);
      if (ref.name === branchRef) branchRemoved = true;
      else baseSnapshotRefRemoved = true;
    }
    ref.done = true;
    saveProgress();
  }
  return { worktreeRemoved, branchRemoved, baseSnapshotRefRemoved, stashesRemoved: 0 };
}
