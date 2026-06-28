import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { readdir } from "node:fs/promises";

import { resolveProviderSkillRootPath, type AppSettings } from "../src/provider-settings-state.js";

export const WITHMATE_MEMORY_SKILL_NAME = "withmate-memory";
const MANAGED_MARKER_FILE = ".withmate-managed-skill.json";
const MANAGED_MARKER_VERSION = 1;
const MANAGED_SKILL_FILE_NAME = "SKILL.md";

export type ManagedMemorySkillSyncStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped-unconfigured"
  | "skipped-collision"
  | "failed";

export type ManagedMemorySkillSyncResult = {
  providerId: string;
  skillRootPath: string | null;
  skillPath: string | null;
  status: ManagedMemorySkillSyncStatus;
  errorMessage?: string;
};

type ManagedSkillMarker = {
  markerVersion: number;
  managedBy: "WithMate";
  skillName: typeof WITHMATE_MEMORY_SKILL_NAME;
  bundleVersion: string;
  bundleDigest: string;
};

export type ManagedMemorySkillServiceDeps = {
  bundledSkillPath: string;
  getAppSettings(): AppSettings;
  getAppVersion(): string;
  platform?: NodeJS.Platform;
};

export class ManagedMemorySkillService {
  constructor(private readonly deps: ManagedMemorySkillServiceDeps) {}

  async syncConfiguredProviderSkills(): Promise<ManagedMemorySkillSyncResult[]> {
    const appSettings = this.deps.getAppSettings();
    const providerEntries = Object.entries(appSettings.codingProviderSettings);

    return Promise.all(providerEntries.map(([providerId, providerSettings]) =>
      this.syncProviderSkill(providerId, resolveProviderSkillRootPath(providerSettings)),
    ));
  }

  async syncProviderSkill(providerId: string, skillRootPath: string): Promise<ManagedMemorySkillSyncResult> {
    const normalizedSkillRootPath = skillRootPath.trim();
    if (!normalizedSkillRootPath) {
      return {
        providerId,
        skillRootPath: null,
        skillPath: null,
        status: "skipped-unconfigured",
      };
    }

    const resolvedSkillRootPath = path.resolve(normalizedSkillRootPath);
    const skillPath = path.join(resolvedSkillRootPath, WITHMATE_MEMORY_SKILL_NAME);
    try {
      const marker = await this.readMarker(skillPath);
      if (marker === "unmanaged") {
        return {
          providerId,
          skillRootPath: resolvedSkillRootPath,
          skillPath,
          status: "skipped-collision",
        };
      }

      await mkdir(resolvedSkillRootPath, { recursive: true });

      const nextMarker = await this.buildMarker();
      if (marker && marker.bundleVersion === nextMarker.bundleVersion) {
        if (
          marker.bundleDigest === nextMarker.bundleDigest
          && await digestDirectory(skillPath, new Set([MANAGED_MARKER_FILE])) === nextMarker.bundleDigest
        ) {
          return {
            providerId,
            skillRootPath: resolvedSkillRootPath,
            skillPath,
            status: "unchanged",
          };
        }
      }

      const tempPath = path.join(
        resolvedSkillRootPath,
        `.${WITHMATE_MEMORY_SKILL_NAME}-${process.pid}-${Date.now()}.tmp`,
      );
      await rm(tempPath, { recursive: true, force: true });
      if (this.shouldSyncSkillMarkdownOnly()) {
        await mkdir(tempPath, { recursive: true });
        await writeFile(
          path.join(tempPath, MANAGED_SKILL_FILE_NAME),
          await readFile(path.join(this.deps.bundledSkillPath, MANAGED_SKILL_FILE_NAME), "utf8"),
          "utf8",
        );
      } else {
        await cp(this.deps.bundledSkillPath, tempPath, { recursive: true });
      }
      await writeFile(path.join(tempPath, MANAGED_MARKER_FILE), `${JSON.stringify(nextMarker, null, 2)}\n`, "utf8");
      await rm(skillPath, { recursive: true, force: true });
      await rename(tempPath, skillPath);

      return {
        providerId,
        skillRootPath: resolvedSkillRootPath,
        skillPath,
        status: marker ? "updated" : "installed",
      };
    } catch (error) {
      return {
        providerId,
        skillRootPath: resolvedSkillRootPath,
        skillPath,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async buildMarker(): Promise<ManagedSkillMarker> {
    return {
      markerVersion: MANAGED_MARKER_VERSION,
      managedBy: "WithMate",
      skillName: WITHMATE_MEMORY_SKILL_NAME,
      bundleVersion: this.deps.getAppVersion(),
      bundleDigest: this.shouldSyncSkillMarkdownOnly()
        ? await digestManagedSkillSource(this.deps.bundledSkillPath)
        : await digestDirectory(this.deps.bundledSkillPath),
    };
  }

  private shouldSyncSkillMarkdownOnly(): boolean {
    return (this.deps.platform ?? process.platform) === "win32";
  }

  private async readMarker(skillPath: string): Promise<ManagedSkillMarker | "unmanaged" | null> {
    try {
      const raw = await readFile(path.join(skillPath, MANAGED_MARKER_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<ManagedSkillMarker>;
      if (
        parsed.markerVersion === MANAGED_MARKER_VERSION
        && parsed.managedBy === "WithMate"
        && parsed.skillName === WITHMATE_MEMORY_SKILL_NAME
        && typeof parsed.bundleVersion === "string"
      ) {
        return {
          markerVersion: MANAGED_MARKER_VERSION,
          managedBy: "WithMate",
          skillName: WITHMATE_MEMORY_SKILL_NAME,
          bundleVersion: parsed.bundleVersion,
          bundleDigest: typeof parsed.bundleDigest === "string" ? parsed.bundleDigest : "",
        };
      }
      return "unmanaged";
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await readFile(path.join(skillPath, MANAGED_SKILL_FILE_NAME), "utf8");
      return "unmanaged";
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

async function digestManagedSkillSource(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(MANAGED_SKILL_FILE_NAME);
  hash.update("\0");
  hash.update(await readFile(path.join(rootPath, MANAGED_SKILL_FILE_NAME)));
  hash.update("\0");
  return hash.digest("hex");
}

async function digestDirectory(rootPath: string, excludedRelativePaths: ReadonlySet<string> = new Set()): Promise<string> {
  const hash = createHash("sha256");
  const resolvedRootPath = path.resolve(rootPath);
  const files = await listFiles(resolvedRootPath);
  for (const filePath of files) {
    const relativePath = path.relative(resolvedRootPath, filePath).replace(/\\/g, "/");
    if (excludedRelativePaths.has(relativePath)) {
      continue;
    }
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
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }
    return entry.isFile() ? [entryPath] : [];
  }));
  return files.flat().sort();
}
