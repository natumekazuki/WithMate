import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDirectoryValidationResult } from "../src/workspace-directory-validation.js";

type WorkspaceDirectoryValidationServiceDeps = {
  isAbsolute(targetPath: string): boolean;
  stat(targetPath: string): Promise<{ isDirectory(): boolean }>;
  access(targetPath: string, mode: number): Promise<void>;
};

const DEFAULT_DEPS: WorkspaceDirectoryValidationServiceDeps = {
  isAbsolute: path.isAbsolute,
  stat,
  access,
};

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class WorkspaceDirectoryValidationService {
  constructor(private readonly deps: WorkspaceDirectoryValidationServiceDeps = DEFAULT_DEPS) {}

  async validate(targetPath: unknown): Promise<WorkspaceDirectoryValidationResult> {
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
