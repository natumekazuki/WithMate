import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { WorkItemSourceIdentity } from "../src/work-item.js";
import type { ActualStartSourceIdentity } from "../src/session-execution.js";

/** The source planned by a caller when a Work Item is created. */
export type PlannedWorkItemSourceIdentity = WorkItemSourceIdentity;

export type { ActualStartSourceIdentity } from "../src/session-execution.js";

export function resolveActualStartSourceIdentity(workspacePath: string): ActualStartSourceIdentity {
  const workspace = canonicalPath(workspacePath);
  const topLevel = runGit(workspace, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok && topLevel.kind === "no_repository") {
    return { kind: "git_unavailable", workspace, repository: null, branch: null, base: null, head: null };
  }
  if (!topLevel.ok) throw new Error("Git repository resolution failed.");

  const repository = canonicalPath(topLevel.stdout);
  const branch = runGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch.ok && branch.kind === "command_error") throw new Error("Git symbolic HEAD resolution failed.");
  const head = runGit(repository, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok && head.kind === "command_error") throw new Error("Git HEAD resolution failed.");
  if (!branch.ok) {
    if (!head.ok) throw new Error("Git HEAD could not be resolved for detached workspace.");
    return {
      kind: "detached_head",
      workspace,
      repository,
      branch: null,
      base: null,
      head: head.stdout,
    };
  }
  if (!head.ok) {
    if (!isMissingBranchRef(repository, branch.stdout)) throw new Error("Git branch ref could not be resolved.");
    return { kind: "unborn_branch", workspace, repository, branch: branch.stdout, base: null, head: null };
  }

  return {
    kind: "resolved",
    workspace,
    repository,
    branch: branch.stdout,
    base: null,
    head: head.stdout,
  };
}

export function parseActualStartSourceIdentity(value: unknown): ActualStartSourceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Actual start source identity must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["kind", "workspace", "repository", "branch", "base", "head"]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new TypeError("Actual start source identity contains unknown fields.");
  }
  const kind = candidate.kind;
  const stringOrNull = (name: string): string | null => {
    const field = candidate[name];
    if (field !== null && typeof field !== "string") throw new TypeError(`Actual source ${name} is invalid.`);
    if (typeof field === "string" && !field.trim()) throw new TypeError(`Actual source ${name} is empty.`);
    return field as string | null;
  };
  const workspace = candidate.workspace;
  if (typeof workspace !== "string" || !workspace) throw new TypeError("Actual source workspace is invalid.");
  const repository = stringOrNull("repository");
  const branch = stringOrNull("branch");
  const base = stringOrNull("base");
  const head = stringOrNull("head");
  if (kind === "git_unavailable" && repository === null && branch === null && base === null && head === null) {
    return { kind, workspace, repository, branch, base, head };
  }
  if (kind === "detached_head" && repository !== null && branch === null && base === null && head !== null) {
    return { kind, workspace, repository, branch, base, head };
  }
  if (kind === "unborn_branch" && repository !== null && branch !== null && base === null && head === null) {
    return { kind, workspace, repository, branch, base, head };
  }
  if (kind === "resolved" && repository !== null && branch !== null && head !== null) {
    return { kind, workspace, repository, branch, base, head };
  }
  throw new TypeError("Actual start source identity has an invalid kind or field combination.");
}

function canonicalPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("Workspace path is required.");
  try {
    return normalizePath(realpathSync(trimmed));
  } catch {
    throw new Error(`Workspace path could not be canonicalized: ${trimmed}`);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

function runGit(cwd: string, args: readonly string[]):
  | { ok: true; stdout: string }
  | { ok: false; kind: "no_repository" | "command_error" | "expected_missing" } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Git executable is unavailable.");
    }
    throw new Error(`Git command failed: ${args.join(" ")}`);
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel"
      && /not a git repository|not a git repo/i.test(stderr)) {
      return { ok: false, kind: "no_repository" };
    }
    if (args[0] === "symbolic-ref" && result.status === 1 && stderr.trim() === "") {
      return { ok: false, kind: "expected_missing" };
    }
    if (args[0] === "rev-parse" && args[1] === "--verify"
      && result.status === 128 && /needed a single revision|unknown revision or path/i.test(stderr)) {
      return { ok: false, kind: "expected_missing" };
    }
    return { ok: false, kind: "command_error" };
  }
  const stdout = result.stdout.trim();
  return stdout ? { ok: true, stdout } : { ok: false, kind: "command_error" };
}

function isMissingBranchRef(repository: string, branch: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error) throw new Error("Git branch ref verification failed.");
  if (result.status === 0) return false;
  if (result.status === 1 && typeof result.stderr === "string" && result.stderr.trim() === "") return true;
  throw new Error("Git branch ref verification failed.");
}
