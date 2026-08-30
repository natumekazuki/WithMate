import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveProviderSkillRootPath, type AppSettings } from "../src/provider-settings-state.js";

export const WITHMATE_MEMORY_SKILL_NAME = "withmate-memory";
export const WITHMATE_GLOSSARY_SKILL_NAME = "withmate-glossary";
const MANAGED_MARKER_FILE = ".withmate-managed-skill.json";
const MANAGED_MARKER_VERSION = 1;
const MANAGED_SKILL_FILE_NAME = "SKILL.md";

export type ManagedMemorySkillSyncStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped-unpackaged"
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

export type ManagedSkillBundleDescriptor = {
  skillName: string;
  bundledSkillPath: string;
  documentationRelativePaths: readonly string[];
};

type ManagedSkillMarker = {
  markerVersion: number;
  managedBy: "WithMate";
  skillName: string;
  bundleVersion: string;
  bundleDigest: string;
};

export type ManagedSkillDistributionServiceDeps = {
  getAppSettings(): AppSettings;
  getAppVersion(): string;
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  shouldSyncDocumentationOnly?: (
    bundle: ManagedSkillBundleDescriptor,
  ) => boolean | Promise<boolean>;
};

export class ManagedSkillDistributionService {
  constructor(private readonly deps: ManagedSkillDistributionServiceDeps) {}

  async syncConfiguredProviderSkills(
    bundle: ManagedSkillBundleDescriptor,
  ): Promise<ManagedMemorySkillSyncResult[]> {
    const appSettings = this.deps.getAppSettings();
    const providerEntries = Object.entries(appSettings.codingProviderSettings);
    return Promise.all(providerEntries.map(([providerId, providerSettings]) =>
      this.syncProviderSkill(bundle, providerId, resolveProviderSkillRootPath(providerSettings)),
    ));
  }

  async syncProviderSkill(
    bundle: ManagedSkillBundleDescriptor,
    providerId: string,
    skillRootPath: string,
  ): Promise<ManagedMemorySkillSyncResult> {
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
    const skillPath = path.join(resolvedSkillRootPath, bundle.skillName);
    if (!this.deps.isPackagedApp()) {
      return {
        providerId,
        skillRootPath: resolvedSkillRootPath,
        skillPath,
        status: "skipped-unpackaged",
      };
    }

    try {
      const marker = await this.readMarker(bundle, skillPath);
      if (marker === "unmanaged") {
        return {
          providerId,
          skillRootPath: resolvedSkillRootPath,
          skillPath,
          status: "skipped-collision",
        };
      }

      await mkdir(resolvedSkillRootPath, { recursive: true });
      const syncDocumentationOnly = await this.shouldSyncDocumentationOnly(bundle);
      const nextMarker = await this.buildMarker(bundle, syncDocumentationOnly);
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
        `.${bundle.skillName}-${process.pid}-${Date.now()}.tmp`,
      );
      await rm(tempPath, { recursive: true, force: true });
      if (syncDocumentationOnly) {
        await copyManagedSkillDocumentation(bundle, tempPath);
      } else {
        await cp(bundle.bundledSkillPath, tempPath, { recursive: true });
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

  private async buildMarker(
    bundle: ManagedSkillBundleDescriptor,
    syncDocumentationOnly: boolean,
  ): Promise<ManagedSkillMarker> {
    return {
      markerVersion: MANAGED_MARKER_VERSION,
      managedBy: "WithMate",
      skillName: bundle.skillName,
      bundleVersion: this.deps.getAppVersion(),
      bundleDigest: syncDocumentationOnly
        ? await digestManagedSkillSource(bundle)
        : await digestDirectory(bundle.bundledSkillPath),
    };
  }

  private async shouldSyncDocumentationOnly(bundle: ManagedSkillBundleDescriptor): Promise<boolean> {
    if ((this.deps.platform ?? process.platform) === "win32") {
      return true;
    }
    return Boolean(await this.deps.shouldSyncDocumentationOnly?.(bundle));
  }

  private async readMarker(
    bundle: ManagedSkillBundleDescriptor,
    skillPath: string,
  ): Promise<ManagedSkillMarker | "unmanaged" | null> {
    try {
      const raw = await readFile(path.join(skillPath, MANAGED_MARKER_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<ManagedSkillMarker>;
      if (
        parsed.markerVersion === MANAGED_MARKER_VERSION
        && parsed.managedBy === "WithMate"
        && parsed.skillName === bundle.skillName
        && typeof parsed.bundleVersion === "string"
      ) {
        return {
          markerVersion: MANAGED_MARKER_VERSION,
          managedBy: "WithMate",
          skillName: bundle.skillName,
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

export type ManagedMemorySkillServiceDeps = ManagedSkillDistributionServiceDeps & {
  bundledSkillPath: string;
  shouldSyncSkillMarkdownOnly?: () => boolean | Promise<boolean>;
};

export class ManagedMemorySkillService {
  readonly #distribution: ManagedSkillDistributionService;
  readonly #bundle: ManagedSkillBundleDescriptor;

  constructor(deps: ManagedMemorySkillServiceDeps) {
    this.#distribution = new ManagedSkillDistributionService({
      getAppSettings: deps.getAppSettings,
      getAppVersion: deps.getAppVersion,
      isPackagedApp: deps.isPackagedApp,
      platform: deps.platform,
      shouldSyncDocumentationOnly: () => deps.shouldSyncSkillMarkdownOnly?.() ?? false,
    });
    this.#bundle = {
      skillName: WITHMATE_MEMORY_SKILL_NAME,
      bundledSkillPath: deps.bundledSkillPath,
      documentationRelativePaths: [MANAGED_SKILL_FILE_NAME, "reference"],
    };
  }

  syncConfiguredProviderSkills(): Promise<ManagedMemorySkillSyncResult[]> {
    return this.#distribution.syncConfiguredProviderSkills(this.#bundle);
  }

  syncProviderSkill(providerId: string, skillRootPath: string): Promise<ManagedMemorySkillSyncResult> {
    return this.#distribution.syncProviderSkill(this.#bundle, providerId, skillRootPath);
  }
}

async function digestManagedSkillSource(bundle: ManagedSkillBundleDescriptor): Promise<string> {
  const hash = createHash("sha256");
  const sourcePaths = (await Promise.all(bundle.documentationRelativePaths.map(async (relativePath) => {
    const sourcePath = path.join(bundle.bundledSkillPath, relativePath);
    const stats = await lstat(sourcePath);
    return stats.isDirectory() ? listFiles(sourcePath) : [sourcePath];
  }))).flat().sort();
  for (const filePath of sourcePaths) {
    const relativePath = path.relative(bundle.bundledSkillPath, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function copyManagedSkillDocumentation(
  bundle: ManagedSkillBundleDescriptor,
  destinationPath: string,
): Promise<void> {
  await mkdir(destinationPath, { recursive: true });
  for (const relativePath of bundle.documentationRelativePaths) {
    const sourcePath = path.join(bundle.bundledSkillPath, relativePath);
    const targetPath = path.join(destinationPath, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }
}

async function digestDirectory(
  rootPath: string,
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): Promise<string> {
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
