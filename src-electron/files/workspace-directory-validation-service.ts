import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

/** 絶対パス判定・項目種別・アクセス可否をOSから確認するための依存先。 */
type WorkspaceDirectoryValidationServiceDeps = {
  /** 実行環境のパス規則で絶対パスかを判定する。 */
  isAbsolute(targetPath: string): boolean;
  /** 対象の種別判定に使うファイルシステム情報を取得する。 */
  stat(targetPath: string): Promise<{
    /** 対象がディレクトリなら真を返す。 */
    isDirectory(): boolean;
  }>;
  /** 要求モードでアクセスできなければ失敗を返す。 */
  access(targetPath: string, mode: number): Promise<void>;
};

const DEFAULT_DEPS: WorkspaceDirectoryValidationServiceDeps = {
  isAbsolute: path.isAbsolute,
  stat,
  access,
};

/** パスが見つからない失敗を、権限などによるアクセス不能と区別する。 */
function isMissingPathError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** 選択されたパスが作業場所として使用できるディレクトリかを確認する。 */
export class WorkspaceDirectoryValidationService {
  /** 既定では実際のファイルシステムを検証し、必要に応じて判定手段を差し替えられる。 */
  constructor(
    private readonly deps: WorkspaceDirectoryValidationServiceDeps = DEFAULT_DEPS,
  ) {}

  /** 絶対パス・種別・読み取りと探索の可否を順に確認し、不適合の理由を結果で返す。 */
  async validate(
    targetPath: unknown,
  ): Promise<WorkspaceDirectoryValidationResult> {
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      return { valid: false, reason: "empty" };
    }
    if (!this.deps.isAbsolute(targetPath)) {
      return { valid: false, reason: "not-absolute" };
    }

    try {
      const stats = await this.deps.stat(targetPath);
      if (!stats.isDirectory()) {
        return { valid: false, reason: "not-directory" };
      }
      await this.deps.access(targetPath, constants.R_OK | constants.X_OK);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        reason: isMissingPathError(error) ? "missing" : "unavailable",
      };
    }
  }
}
