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

/** 選定と Worktree 配置の保存方針を読む・更新するための、同期または非同期のストア境界。 */
type PolicyStore = {
  [
    K in
      | "getSelectionPolicy"
      | "setSelectionPolicy"
      | "getWorktreePolicy"
      | "setWorktreeRoot"
      | "setWorktreeRepository"
  ]: (
    ...args: Parameters<AppSettingsStorage[K]>
  ) =>
    | ReturnType<AppSettingsStorage[K]>
    | Promise<ReturnType<AppSettingsStorage[K]>>;
};
const execFileAsync = promisify(execFile);
/** 指定ワークスペースで Git を起動し、待機時間と出力量を制限して標準出力だけを返す。 */
async function git(workspacePath: string, args: string[]): Promise<string> {
  return (
    await execFileAsync("git", ["-C", workspacePath, ...args], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    })
  ).stdout;
}
/** 入力違反を Session 管理 API の無変更のリクエストエラーとして伝える。 */
function invalid(message: string): never {
  throw new SessionManagementError("SESSION_INVALID_REQUEST", message);
}
/** この端末の絶対パスに限定し、Windows のドライブ相対パス等を拒否して正規化する。 */
function absolutePath(value: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    (process.platform === "win32" &&
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(value))
  ) {
    invalid("An absolute filesystem path on this device is required.");
  }
  return normalize(value);
}
/** 区切りを揃えて安全な相対ディレクトリ名に限定する。空は明示時だけ許し、親参照・予約名等を拒否する。 */
function relativePath(value: string, allowEmpty = false): string {
  const path = value.replaceAll("\\", "/");
  if (allowEmpty && path === "") return path;
  if (
    isAbsolute(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\x00-\x1f]/u.test(part) ||
          (process.platform === "win32" &&
            (/[<>:"|?*]/u.test(part) ||
              /[. ]$/u.test(part) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))),
      )
  ) {
    invalid(
      "Layout components must be safe relative directory names without traversal.",
    );
  }
  return path;
}
/** 分類と名前を検査し、既定の二つの置換項目を持つ安全な Worktree レイアウトを返す。 */
function normalizeRule(rule: WorktreeRepositoryRule): WorktreeRepositoryRule {
  const categoryPath = relativePath(rule.categoryPath, true);
  const repositoryName = relativePath(rule.repositoryName);
  if (repositoryName.includes("/"))
    invalid("repositoryName must be one directory name.");
  const layout = rule.layout.replaceAll("\\", "/");
  if (
    !layout.includes("{repository}") ||
    !layout.includes("{branch}") ||
    /[{}]/u.test(
      layout.replaceAll("{repository}", "").replaceAll("{branch}", ""),
    )
  ) {
    invalid(
      "layout must contain {repository} and {branch}, with no other placeholders.",
    );
  }
  relativePath(
    layout
      .replaceAll("{repository}", "repository")
      .replaceAll("{branch}", "branch"),
  );
  return { categoryPath, repositoryName, layout };
}
/** Git の共通管理ディレクトリの実体を基に、連結 Worktree 間で共通のリポジトリー ID を返す。 */
async function repositoryId(workspacePath: string): Promise<string> {
  absolutePath(workspacePath);
  try {
    const commonDir = await realpath(
      (
        await git(workspacePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).replace(/\r?\n$/u, ""),
    );
    return process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
  } catch {
    throw new SessionManagementError(
      "SESSION_WORKTREE_REPOSITORY_UNAVAILABLE",
      "workspacePath must identify an accessible Git repository on this device.",
    );
  }
}

/** 方針の案内と配置先の照会のみを行う。実行設定の選択や Git Worktree の作成は行わない。 */
export class SessionOperatingPolicyService {
  /** 保存方針のストアと、既に取得された利用枠を参照する依存を設定する。 */
  constructor(
    private readonly deps: {
      /** 現在のストアから選定・配置方針を読み書きする。 */
      getStore(): PolicyStore;
      /** 指定プロバイダーの現在の利用枠観測を返す。まだ得られていなければ null。 */
      getQuota(provider: string): ProviderQuotaTelemetry | null;
    },
  ) {}

  /** 方針の照会・更新と配置先の解決を行う。既存 Worktree があれば予定より優先し、解決処理では作成しない。 */
  async execute(
    operation: SessionOperatingPolicyOperation,
    body: unknown,
    actorWorkspace: string,
    assertCurrent: () => void,
  ): Promise<SessionOperationResult> {
    const store = this.deps.getStore();
    assertCurrent();
    switch (operation) {
      case "get_selection_policy":
        return { ok: true, policy: await store.getSelectionPolicy() };
      case "set_selection_policy":
        return {
          ok: true,
          policy: await store.setSelectionPolicy(
            (body as SessionOperatingPolicyRequest<"set_selection_policy">)
              .policy,
          ),
        };
      case "get_provider_quota": {
        const request =
          body as SessionOperatingPolicyRequest<"get_provider_quota">;
        return {
          ok: true,
          providers: (request.provider
            ? [request.provider]
            : OPERATING_POLICY_PROVIDERS
          ).map((provider) => ({
            provider,
            telemetry: this.deps.getQuota(provider),
          })),
        };
      }
      case "set_worktree_root": {
        const request =
          body as SessionOperatingPolicyRequest<"set_worktree_root">;
        return {
          ok: true,
          rootPath: await store.setWorktreeRoot(
            request.rootPath === null ? null : absolutePath(request.rootPath),
          ),
        };
      }
      case "get_worktree_policy":
      case "set_worktree_repository":
      case "resolve_worktree": {
        const request =
          body as SessionOperatingPolicyRequest<"resolve_worktree">;
        const workspacePath = request.workspacePath ?? actorWorkspace;
        const id = await repositoryId(workspacePath);
        assertCurrent();
        if (operation === "set_worktree_repository") {
          const { rule } =
            body as SessionOperatingPolicyRequest<"set_worktree_repository">;
          const policy = await store.setWorktreeRepository(
            id,
            rule === null ? null : normalizeRule(rule),
          );
          return {
            ok: true,
            repositoryId: id,
            rootPath: policy.rootPath,
            rule: policy.repositories[id] ?? null,
          };
        }
        const policy = await store.getWorktreePolicy();
        const rule = policy.repositories[id] ?? null;
        if (operation === "get_worktree_policy")
          return {
            ok: true,
            repositoryId: id,
            rootPath: policy.rootPath,
            rule,
          };
        // @{-1} などの省略記法は拒否する。呼び出し元が指定するのはブランチ名そのもの。
        if (request.branch.startsWith("-") || request.branch.includes("@{"))
          invalid("A literal branch name is required.");
        try {
          await git(workspacePath, [
            "check-ref-format",
            "--branch",
            request.branch,
          ]);
        } catch {
          invalid("Invalid Git branch name.");
        }
        const override =
          request.destinationPath === undefined
            ? null
            : absolutePath(request.destinationPath);
        const worktrees = (
          await git(workspacePath, ["worktree", "list", "--porcelain", "-z"])
        ).split("\0\0");
        assertCurrent();
        const existing = worktrees
          .map((record) => record.split("\0"))
          .find((fields) =>
            fields.includes(`branch refs/heads/${request.branch}`),
          )
          ?.find((field) => field.startsWith("worktree "))
          ?.slice("worktree ".length);
        const result = {
          ok: true as const,
          repositoryId: id,
          branch: request.branch,
        };
        if (existing)
          return {
            ...result,
            status: "existing",
            source: "git",
            destinationPath: normalize(existing),
            missing: [],
          };
        if (override)
          return {
            ...result,
            status: "planned",
            source: "override",
            destinationPath: override,
            missing: [],
          };
        const missing = [
          ...(policy.rootPath === null ? ["rootPath"] : []),
          ...(rule === null ? ["repositoryRule"] : []),
        ];
        if (!policy.rootPath || !rule)
          return {
            ...result,
            status: "unconfigured",
            source: null,
            destinationPath: null,
            missing,
          };
        const normalized = normalizeRule(rule);
        const branchPath = relativePath(request.branch);
        const layout = relativePath(
          normalized.layout.replace(/\{repository\}|\{branch\}/gu, (token) =>
            token === "{repository}" ? normalized.repositoryName : branchPath,
          ),
        );
        return {
          ...result,
          status: "planned",
          source: "policy",
          destinationPath: resolve(
            absolutePath(policy.rootPath),
            normalized.categoryPath,
            layout,
          ),
          missing: [],
        };
      }
    }
  }
}
