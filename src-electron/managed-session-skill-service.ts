import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProviderSkillRootPath, type AppSettings } from "../src/provider-settings-state.js";

export const WITHMATE_SESSION_SKILL_NAME = "withmate-session";
const MANAGED_MARKER_FILE = ".withmate-managed-skill.json";
const MANAGED_MARKER_VERSION = 1;

export type ManagedSessionSkillSyncStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped-unpackaged"
  | "skipped-unsupported-platform"
  | "skipped-unconfigured"
  | "skipped-collision"
  | "failed";

export type ManagedSessionSkillSyncResult = {
  providerId: "codex";
  skillRootPath: string | null;
  skillPath: string | null;
  status: ManagedSessionSkillSyncStatus;
  errorMessage?: string;
};

type ManagedSessionSkillMarker = {
  markerVersion: number;
  managedBy: "WithMate";
  skillName: typeof WITHMATE_SESSION_SKILL_NAME;
  bundleVersion: string;
  bundleDigest: string;
};

export type ManagedSessionSkillServiceDeps = {
  bundledSkillPath: string;
  getAppSettings(): AppSettings;
  getBundleVersion(): string;
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  renamePath?: typeof rename;
};

export class ManagedSessionSkillService {
  private readonly syncQueues = new Map<string, Promise<void>>();

  constructor(private readonly deps: ManagedSessionSkillServiceDeps) {}

  async syncConfiguredProviderSkill(): Promise<ManagedSessionSkillSyncResult> {
    const settings = this.deps.getAppSettings().codingProviderSettings.codex;
    return this.syncProviderSkill(resolveProviderSkillRootPath(settings));
  }

  async syncProviderSkill(skillRootPath: string): Promise<ManagedSessionSkillSyncResult> {
    const queueKey = skillRootPath.trim() ? path.resolve(skillRootPath.trim()) : "";
    const previousSync = this.syncQueues.get(queueKey) ?? Promise.resolve();
    let releaseSync = (): void => undefined;
    const currentSync = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    this.syncQueues.set(queueKey, currentSync);
    await previousSync;
    try {
      return await this.syncProviderSkillExclusive(skillRootPath);
    } finally {
      releaseSync();
      if (this.syncQueues.get(queueKey) === currentSync) {
        this.syncQueues.delete(queueKey);
      }
    }
  }

  private async syncProviderSkillExclusive(skillRootPath: string): Promise<ManagedSessionSkillSyncResult> {
    const normalizedSkillRootPath = skillRootPath.trim();
    if (!normalizedSkillRootPath) {
      return this.result(null, null, "skipped-unconfigured");
    }

    const resolvedSkillRootPath = path.resolve(normalizedSkillRootPath);
    const skillPath = path.join(resolvedSkillRootPath, WITHMATE_SESSION_SKILL_NAME);
    if (!this.deps.isPackagedApp()) {
      return this.result(resolvedSkillRootPath, skillPath, "skipped-unpackaged");
    }
    if ((this.deps.platform ?? process.platform) !== "win32") {
      return this.result(resolvedSkillRootPath, skillPath, "skipped-unsupported-platform");
    }

    let tempPath: string | null = null;
    let backupPath: string | null = null;
    let rollbackTempPath: string | null = null;
    try {
      await mkdir(resolvedSkillRootPath, { recursive: true });
      await this.recoverInterruptedReplacement(resolvedSkillRootPath, skillPath);
      const marker = await this.readMarker(skillPath);
      if (marker === "unmanaged") {
        return this.result(resolvedSkillRootPath, skillPath, "skipped-collision");
      }

      const nextMarker = await this.buildMarker();
      if (
        marker
        && marker.bundleVersion === nextMarker.bundleVersion
        && marker.bundleDigest === nextMarker.bundleDigest
        && await digestDirectory(skillPath, new Set([MANAGED_MARKER_FILE])) === nextMarker.bundleDigest
      ) {
        return this.result(resolvedSkillRootPath, skillPath, "unchanged");
      }

      const replacementId = `${process.pid}-${randomUUID()}`;
      tempPath = path.join(resolvedSkillRootPath, `.${WITHMATE_SESSION_SKILL_NAME}-${replacementId}.tmp`);
      backupPath = path.join(resolvedSkillRootPath, `.${WITHMATE_SESSION_SKILL_NAME}-${replacementId}.backup`);
      await rm(tempPath, { recursive: true, force: true });
      await rm(backupPath, { recursive: true, force: true });
      await cp(this.deps.bundledSkillPath, tempPath, { recursive: true });
      await writeFile(path.join(tempPath, MANAGED_MARKER_FILE), `${JSON.stringify(nextMarker, null, 2)}\n`, "utf8");

      const renamePath = this.deps.renamePath ?? rename;
      if (marker) {
        const previousSkillPath = backupPath;
        await renamePath(skillPath, previousSkillPath);
        try {
          await renamePath(tempPath, skillPath);
          tempPath = null;
        } catch (error) {
          try {
            await renamePath(previousSkillPath, skillPath);
            backupPath = null;
          } catch (rollbackError) {
            try {
              rollbackTempPath = `${previousSkillPath}.rollback.tmp`;
              await rm(rollbackTempPath, { recursive: true, force: true });
              await cp(previousSkillPath, rollbackTempPath, { recursive: true });
              await renamePath(rollbackTempPath, skillPath);
              rollbackTempPath = null;
              await rm(previousSkillPath, { recursive: true, force: true });
              backupPath = null;
            } catch (copyRollbackError) {
              throw new AggregateError(
                [error, rollbackError, copyRollbackError],
                `Managed Session Skill replacement failed; the previous bundle remains at ${backupPath}.`,
              );
            }
          }
          throw error;
        }
        await rm(backupPath, { recursive: true, force: true });
        backupPath = null;
      } else {
        await renamePath(tempPath, skillPath);
        tempPath = null;
      }

      return this.result(resolvedSkillRootPath, skillPath, marker ? "updated" : "installed");
    } catch (error) {
      return {
        ...this.result(resolvedSkillRootPath, skillPath, "failed"),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (tempPath) {
        await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      }
      if (rollbackTempPath) {
        await rm(rollbackTempPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private result(
    skillRootPath: string | null,
    skillPath: string | null,
    status: ManagedSessionSkillSyncStatus,
  ): ManagedSessionSkillSyncResult {
    return { providerId: "codex", skillRootPath, skillPath, status };
  }

  private async buildMarker(): Promise<ManagedSessionSkillMarker> {
    return {
      markerVersion: MANAGED_MARKER_VERSION,
      managedBy: "WithMate",
      skillName: WITHMATE_SESSION_SKILL_NAME,
      bundleVersion: this.deps.getBundleVersion(),
      bundleDigest: await digestDirectory(this.deps.bundledSkillPath),
    };
  }

  private async recoverInterruptedReplacement(skillRootPath: string, skillPath: string): Promise<void> {
    try {
      await stat(skillPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    const candidates = await Promise.all(
      (await readdir(skillRootPath, { withFileTypes: true }))
        .filter((entry) => (
          entry.isDirectory()
          && entry.name.startsWith(`.${WITHMATE_SESSION_SKILL_NAME}-`)
          && entry.name.endsWith(".backup")
        ))
        .map(async (entry) => {
          const candidatePath = path.join(skillRootPath, entry.name);
          const marker = await this.readMarker(candidatePath);
          if (!marker || marker === "unmanaged") return null;
          return { candidatePath, modifiedAt: (await stat(candidatePath)).mtimeMs };
        }),
    );
    const ownedBackup = candidates
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (ownedBackup) {
      await (this.deps.renamePath ?? rename)(ownedBackup.candidatePath, skillPath);
    }
  }

  private async readMarker(skillPath: string): Promise<ManagedSessionSkillMarker | "unmanaged" | null> {
    try {
      const raw = await readFile(path.join(skillPath, MANAGED_MARKER_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<ManagedSessionSkillMarker>;
      if (
        parsed.markerVersion === MANAGED_MARKER_VERSION
        && parsed.managedBy === "WithMate"
        && parsed.skillName === WITHMATE_SESSION_SKILL_NAME
        && typeof parsed.bundleVersion === "string"
        && typeof parsed.bundleDigest === "string"
      ) {
        return parsed as ManagedSessionSkillMarker;
      }
      return "unmanaged";
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code !== "ENOENT") {
        return "unmanaged";
      }
    }

    try {
      await stat(skillPath);
      return "unmanaged";
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

async function digestDirectory(rootPath: string, excludedRelativePaths: ReadonlySet<string> = new Set()): Promise<string> {
  const hash = createHash("sha256");
  const resolvedRootPath = path.resolve(rootPath);
  for (const filePath of await listFiles(resolvedRootPath)) {
    const relativePath = path.relative(resolvedRootPath, filePath).replace(/\\/g, "/");
    if (excludedRelativePaths.has(relativePath)) continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }));
  return files.flat().sort();
}
