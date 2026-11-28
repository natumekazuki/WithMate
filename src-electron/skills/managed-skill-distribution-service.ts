import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  resolveProviderSkillRootPath,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 同梱する用語集スキルのインストール先ディレクトリ名。 */
export const WITHMATE_GLOSSARY_SKILL_NAME = "withmate-glossary";
const MANAGED_MARKER_FILE = ".withmate-managed-skill.json";
const MANAGED_MARKER_VERSION = 1;
const MANAGED_SKILL_FILE_NAME = "SKILL.md";

/** 配布先ごとのインストール・更新、処理の省略、失敗を区別する結果コード。 */
export type ManagedSkillSyncStatus =
  | "installed"
  | "updated"
  | "unchanged"
  | "skipped-unpackaged"
  | "skipped-unconfigured"
  | "skipped-collision"
  | "failed";

/** 配布先プロバイダー、解決したパス、同期結果と失敗時の詳細。 */
export type ManagedSkillSyncResult = {
  providerId: string;
  skillRootPath: string | null;
  skillPath: string | null;
  status: ManagedSkillSyncStatus;
  errorMessage?: string;
};

/** スキルの名前・同梱元と、文書のみを配布する場合にコピーする相対パスの一覧。 */
export type ManagedSkillBundleDescriptor = {
  skillName: string;
  bundledSkillPath: string;
  documentationRelativePaths: readonly string[];
};

/** WithMate が管理する配布先を識別し、同梱版とファイル内容の一致を調べるためのマーカー。 */
type ManagedSkillMarker = {
  markerVersion: number;
  managedBy: "WithMate";
  skillName: string;
  bundleVersion: string;
  bundleDigest: string;
};

/** 配布先の設定、同梱版の情報、文書のみを同期する条件をサービスへ供給する。 */
export type ManagedSkillDistributionServiceDeps = {
  /** 同期対象のプロバイダーとスキルルートを選ぶためのアプリ設定を返す。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** 配布マーカーに記録するアプリのバージョンを返す。 */
  getAppVersion(): string;
  /** 実際に配布先を書き換える対象となるパッケージ版の起動かを判定する。 */
  isPackagedApp(): boolean;
  platform?: NodeJS.Platform;
  shouldSyncDocumentationOnly?: (
    bundle: ManagedSkillBundleDescriptor,
  ) => boolean | Promise<boolean>;
};

/** 同梱スキルを設定済みプロバイダーへ同期し、管理外として検出した同名スキルは上書きしない。 */
export class ManagedSkillDistributionService {
  /** アプリ環境と配布対象を解決するための依存処理を受け取る。 */
  constructor(private readonly deps: ManagedSkillDistributionServiceDeps) {}

  /** 設定にある全プロバイダーについて配布先を解決し、それぞれの同期結果を返す。 */
  async syncConfiguredProviderSkills(
    bundle: ManagedSkillBundleDescriptor,
  ): Promise<ManagedSkillSyncResult[]> {
    const appSettings = await this.deps.getAppSettings();
    const providerEntries = Object.entries(appSettings.codingProviderSettings);
    return Promise.all(
      providerEntries.map(([providerId, providerSettings]) =>
        this.syncProviderSkill(
          bundle,
          providerId,
          resolveProviderSkillRootPath(providerSettings),
        ),
      ),
    );
  }

  /** 管理中のスキルを同梱内容で更新するか、新規に配置する。未設定・開発版・管理外の競合は状態で返し、同期処理中の例外は失敗結果に変換する。 */
  async syncProviderSkill(
    bundle: ManagedSkillBundleDescriptor,
    providerId: string,
    skillRootPath: string,
  ): Promise<ManagedSkillSyncResult> {
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
      const syncDocumentationOnly =
        await this.shouldSyncDocumentationOnly(bundle);
      const nextMarker = await this.buildMarker(bundle, syncDocumentationOnly);
      if (marker && marker.bundleVersion === nextMarker.bundleVersion) {
        if (
          marker.bundleDigest === nextMarker.bundleDigest &&
          (await digestDirectory(skillPath, new Set([MANAGED_MARKER_FILE]))) ===
            nextMarker.bundleDigest
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
      await writeFile(
        path.join(tempPath, MANAGED_MARKER_FILE),
        `${JSON.stringify(nextMarker, null, 2)}\n`,
        "utf8",
      );
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

  /** 現行アプリ版と配布する内容のダイジェストから、新しく書き込む管理マーカーを作る。 */
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

  /** Windows では文書だけを配布し、他のOSでは依存処理に指定された条件で配布範囲を決める。 */
  private async shouldSyncDocumentationOnly(
    bundle: ManagedSkillBundleDescriptor,
  ): Promise<boolean> {
    if ((this.deps.platform ?? process.platform) === "win32") {
      return true;
    }
    return Boolean(await this.deps.shouldSyncDocumentationOnly?.(bundle));
  }

  /** 既存マーカーで管理対象を識別する。マーカーがなければ、SKILL.md がある場合は管理外、なければ未配置として扱う。 */
  private async readMarker(
    bundle: ManagedSkillBundleDescriptor,
    skillPath: string,
  ): Promise<ManagedSkillMarker | "unmanaged" | null> {
    try {
      const raw = await readFile(
        path.join(skillPath, MANAGED_MARKER_FILE),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Partial<ManagedSkillMarker>;
      if (
        parsed.markerVersion === MANAGED_MARKER_VERSION &&
        parsed.managedBy === "WithMate" &&
        parsed.skillName === bundle.skillName &&
        typeof parsed.bundleVersion === "string"
      ) {
        return {
          markerVersion: MANAGED_MARKER_VERSION,
          managedBy: "WithMate",
          skillName: bundle.skillName,
          bundleVersion: parsed.bundleVersion,
          bundleDigest:
            typeof parsed.bundleDigest === "string" ? parsed.bundleDigest : "",
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

/** 文書のみの配布で使用するファイルを集め、相対パスと内容からダイジェストを計算する。 */
async function digestManagedSkillSource(
  bundle: ManagedSkillBundleDescriptor,
): Promise<string> {
  const hash = createHash("sha256");
  const sourcePaths = (
    await Promise.all(
      bundle.documentationRelativePaths.map(async (relativePath) => {
        const sourcePath = path.join(bundle.bundledSkillPath, relativePath);
        const stats = await lstat(sourcePath);
        return stats.isDirectory() ? listFiles(sourcePath) : [sourcePath];
      }),
    )
  )
    .flat()
    .sort();
  for (const filePath of sourcePaths) {
    const relativePath = path
      .relative(bundle.bundledSkillPath, filePath)
      .replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 指定の文書とディレクトリだけを、同梱元の相対パスを保って配布先へ再帰的にコピーする。 */
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

/** 除外対象を除いた相対パスとファイル内容から、ディレクトリの比較用ダイジェストを計算する。 */
async function digestDirectory(
  rootPath: string,
  excludedRelativePaths: ReadonlySet<string> = new Set(),
): Promise<string> {
  const hash = createHash("sha256");
  const resolvedRootPath = path.resolve(rootPath);
  const files = await listFiles(resolvedRootPath);
  for (const filePath of files) {
    const relativePath = path
      .relative(resolvedRootPath, filePath)
      .replace(/\\/g, "/");
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

/** 通常のファイルだけを再帰的に列挙し、比較結果が列挙順に依存しないようパスを整列する。 */
async function listFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}
