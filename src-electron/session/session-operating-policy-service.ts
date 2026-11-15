import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import {
  OPERATING_POLICY_PROVIDERS,
  type SessionOperatingPolicyOperation,
  type SessionOperatingPolicyRequest,
  type WorktreeRepositoryRule,
} from "../../src-shared/session/session-operating-policy.js";
import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionOperationResult } from "../../src-shared/session/session-management-contract.js";
import type { AppSettingsStorage } from "../app/app-settings-storage.js";
import { SessionManagementError } from "./session-management-application.js";

type PolicyStore = {
  [K in "getSelectionPolicy" | "setSelectionPolicy" | "getWorktreePolicy" | "setWorktreeRoot" | "setWorktreeRepository"]:
    (...args: Parameters<AppSettingsStorage[K]>) => ReturnType<AppSettingsStorage[K]> | Promise<ReturnType<AppSettingsStorage[K]>>;
};
const execFileAsync = promisify(execFile);
async function git(workspacePath: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", workspacePath, ...args], {
    windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
  })).stdout;
}
function invalid(message: string): never {
  throw new SessionManagementError("SESSION_INVALID_REQUEST", message);
}
function absolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || (process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(value))) {
    invalid("An absolute filesystem path on this device is required.");
  }
  return normalize(value);
}
function relativePath(value: string, allowEmpty = false): string {
  const path = value.replaceAll("\\", "/");
  if (allowEmpty && path === "") return path;
  if (isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || /[\x00-\x1f]/u.test(part)
    || (process.platform === "win32" && (/[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))))) {
    invalid("Layout components must be safe relative directory names without traversal.");
  }
  return path;
}
function normalizeRule(rule: WorktreeRepositoryRule): WorktreeRepositoryRule {
  const categoryPath = relativePath(rule.categoryPath, true);
  const repositoryName = relativePath(rule.repositoryName);
  if (repositoryName.includes("/")) invalid("repositoryName must be one directory name.");
  const layout = rule.layout.replaceAll("\\", "/");
  if (!layout.includes("{repository}") || !layout.includes("{branch}") || /[{}]/u.test(layout.replaceAll("{repository}", "").replaceAll("{branch}", ""))) {
    invalid("layout must contain {repository} and {branch}, with no other placeholders.");
  }
  relativePath(layout.replaceAll("{repository}", "repository").replaceAll("{branch}", "branch"));
  return { categoryPath, repositoryName, layout };
}
async function repositoryId(workspacePath: string): Promise<string> {
  absolutePath(workspacePath);
  try {
    const commonDir = await realpath((await git(workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).replace(/\r?\n$/u, ""));
    return process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
  } catch {
    throw new SessionManagementError("SESSION_WORKTREE_REPOSITORY_UNAVAILABLE", "workspacePath must identify an accessible Git repository on this device.");
  }
}

/** Guidance and destination lookup only; never selects options or creates Git Worktrees. */
export class SessionOperatingPolicyService {
  constructor(private readonly deps: {
    getStore(): PolicyStore;
    getQuota(provider: string): ProviderQuotaTelemetry | null;
  }) {}

  async execute(operation: SessionOperatingPolicyOperation, body: unknown, actorWorkspace: string, assertCurrent: () => void): Promise<SessionOperationResult> {
    const store = this.deps.getStore();
    assertCurrent();
    switch (operation) {
      case "get_selection_policy":
        return { ok: true, policy: await store.getSelectionPolicy() };
      case "set_selection_policy":
        return { ok: true, policy: await store.setSelectionPolicy((body as SessionOperatingPolicyRequest<"set_selection_policy">).policy) };
      case "get_provider_quota": {
        const request = body as SessionOperatingPolicyRequest<"get_provider_quota">;
        return { ok: true, providers: (request.provider ? [request.provider] : OPERATING_POLICY_PROVIDERS).map((provider) => ({ provider, telemetry: this.deps.getQuota(provider) })) };
      }
      case "set_worktree_root": {
        const request = body as SessionOperatingPolicyRequest<"set_worktree_root">;
        return { ok: true, rootPath: await store.setWorktreeRoot(request.rootPath === null ? null : absolutePath(request.rootPath)) };
      }
      case "get_worktree_policy":
      case "set_worktree_repository":
      case "resolve_worktree": {
        const request = body as SessionOperatingPolicyRequest<"resolve_worktree">;
        const workspacePath = request.workspacePath ?? actorWorkspace;
        const id = await repositoryId(workspacePath);
        assertCurrent();
        if (operation === "set_worktree_repository") {
          const { rule } = body as SessionOperatingPolicyRequest<"set_worktree_repository">;
          const policy = await store.setWorktreeRepository(id, rule === null ? null : normalizeRule(rule));
          return { ok: true, repositoryId: id, rootPath: policy.rootPath, rule: policy.repositories[id] ?? null };
        }
        const policy = await store.getWorktreePolicy();
        const rule = policy.repositories[id] ?? null;
        if (operation === "get_worktree_policy") return { ok: true, repositoryId: id, rootPath: policy.rootPath, rule };
        // Reject shorthand such as @{-1}; it is not the caller's literal branch name.
        if (request.branch.startsWith("-") || request.branch.includes("@{")) invalid("A literal branch name is required.");
        try { await git(workspacePath, ["check-ref-format", "--branch", request.branch]); }
        catch { invalid("Invalid Git branch name."); }
        const override = request.destinationPath === undefined ? null : absolutePath(request.destinationPath);
        const worktrees = (await git(workspacePath, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
        assertCurrent();
        const existing = worktrees.map((record) => record.split("\0"))
          .find((fields) => fields.includes(`branch refs/heads/${request.branch}`))?.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
        const result = { ok: true as const, repositoryId: id, branch: request.branch };
        if (existing) return { ...result, status: "existing", source: "git", destinationPath: normalize(existing), missing: [] };
        if (override) return { ...result, status: "planned", source: "override", destinationPath: override, missing: [] };
        const missing = [...(policy.rootPath === null ? ["rootPath"] : []), ...(rule === null ? ["repositoryRule"] : [])];
        if (!policy.rootPath || !rule) return { ...result, status: "unconfigured", source: null, destinationPath: null, missing };
        const normalized = normalizeRule(rule);
        const branchPath = relativePath(request.branch);
        const layout = relativePath(normalized.layout.replace(/\{repository\}|\{branch\}/gu, (token) => token === "{repository}" ? normalized.repositoryName : branchPath));
        return { ...result, status: "planned", source: "policy", destinationPath: resolve(absolutePath(policy.rootPath), normalized.categoryPath, layout), missing: [] };
      }
    }
  }
}
