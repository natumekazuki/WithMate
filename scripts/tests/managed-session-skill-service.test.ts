import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import {
  ManagedSessionSkillService,
  WITHMATE_SESSION_SKILL_NAME,
} from "../../src-electron/managed-session-skill-service.js";

async function createBundle(content = "bundle-v1\n"): Promise<string> {
  const bundlePath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-bundle-"));
  await mkdir(path.join(bundlePath, "references"), { recursive: true });
  await writeFile(path.join(bundlePath, "SKILL.md"), content, "utf8");
  await writeFile(path.join(bundlePath, "references", "operations.md"), "reference-v1\n", "utf8");
  return bundlePath;
}

function createService(input: {
  bundlePath: string;
  skillRootPath: string;
  bundleVersion?: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  renamePath?: typeof rename;
}): ManagedSessionSkillService {
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.codex = {
    enabled: true,
    apiKey: "",
    skillRootPath: input.skillRootPath,
    skillRelativePath: ".codex/skills",
    instructionRelativePath: "",
  };
  return new ManagedSessionSkillService({
    bundledSkillPath: input.bundlePath,
    getAppSettings: () => settings,
    getBundleVersion: () => input.bundleVersion ?? "6.4.0-test",
    isPackagedApp: () => input.isPackaged ?? true,
    platform: input.platform ?? "win32",
    ...(input.renamePath ? { renamePath: input.renamePath } : {}),
  });
}

describe("ManagedSessionSkillService", () => {
  it("packaged bundleをCodex Skill rootへmarker付きでinstallする", async () => {
    const bundlePath = path.resolve("resources", "skills", WITHMATE_SESSION_SKILL_NAME);
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const service = createService({ bundlePath, skillRootPath: rootPath });
      const result = await service.syncConfiguredProviderSkill();
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);

      assert.equal(result.status, "installed");
      assert.equal(
        await readFile(path.join(installedPath, "SKILL.md"), "utf8"),
        await readFile(path.join(bundlePath, "SKILL.md"), "utf8"),
      );
      assert.equal(
        await readFile(path.join(installedPath, "references", "operations.md"), "utf8"),
        await readFile(path.join(bundlePath, "references", "operations.md"), "utf8"),
      );
      const marker = JSON.parse(await readFile(path.join(installedPath, ".withmate-managed-skill.json"), "utf8"));
      assert.deepEqual(
        { markerVersion: marker.markerVersion, managedBy: marker.managedBy, skillName: marker.skillName, bundleVersion: marker.bundleVersion },
        { markerVersion: 1, managedBy: "WithMate", skillName: WITHMATE_SESSION_SKILL_NAME, bundleVersion: "6.4.0-test" },
      );
      assert.match(marker.bundleDigest, /^[0-9a-f]{64}$/);
      assert.equal((await service.syncConfiguredProviderSkill()).status, "unchanged");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("bundle versionまたはdigestが変わるとmanaged directoryを更新する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      assert.equal((await createService({ bundlePath, skillRootPath: rootPath }).syncConfiguredProviderSkill()).status, "installed");
      await writeFile(path.join(bundlePath, "SKILL.md"), "bundle-v2\n", "utf8");

      const result = await createService({
        bundlePath,
        skillRootPath: rootPath,
        bundleVersion: "6.4.1-test",
      }).syncConfiguredProviderSkill();
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);

      assert.equal(result.status, "updated");
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v2\n");
      const marker = JSON.parse(await readFile(path.join(installedPath, ".withmate-managed-skill.json"), "utf8"));
      assert.equal(marker.bundleVersion, "6.4.1-test");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("同一serviceの並行syncを直列化して一つの完全なbundleへ収束させる", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const service = createService({ bundlePath, skillRootPath: rootPath });
      const results = await Promise.all([
        service.syncConfiguredProviderSkill(),
        service.syncConfiguredProviderSkill(),
      ]);
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);

      assert.deepEqual(results.map((result) => result.status), ["installed", "unchanged"]);
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v1\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("旧rootのpending syncは別rootへのsyncを塞がない", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    const firstSkillRoot = path.join(rootPath, "first");
    const secondSkillRoot = path.join(rootPath, "second");
    let releaseFirstRename = (): void => undefined;
    const firstRenamePending = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let firstRenameStarted = (): void => undefined;
    const firstRenameStart = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });
    try {
      const renamePath: typeof rename = async (oldPath, newPath) => {
        if (path.resolve(newPath.toString()).startsWith(path.resolve(firstSkillRoot))) {
          firstRenameStarted();
          await firstRenamePending;
        }
        await rename(oldPath, newPath);
      };
      const service = createService({ bundlePath, skillRootPath: firstSkillRoot, renamePath });
      const firstSync = service.syncProviderSkill(firstSkillRoot);
      await firstRenameStart;

      const secondResult = await service.syncProviderSkill(secondSkillRoot);
      releaseFirstRename();
      const firstResult = await firstSync;

      assert.equal(secondResult.status, "installed");
      assert.equal(firstResult.status, "installed");
    } finally {
      releaseFirstRename();
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("markerのない同名directoryは内容にかかわらず上書きしない", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    const collisionPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);
    try {
      await mkdir(collisionPath, { recursive: true });
      await writeFile(path.join(collisionPath, "user.txt"), "keep\n", "utf8");

      const result = await createService({ bundlePath, skillRootPath: rootPath }).syncConfiguredProviderSkill();

      assert.equal(result.status, "skipped-collision");
      assert.equal(await readFile(path.join(collisionPath, "user.txt"), "utf8"), "keep\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("replacement publish失敗時は直前のmanaged bundleを復元する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      assert.equal((await createService({ bundlePath, skillRootPath: rootPath }).syncConfiguredProviderSkill()).status, "installed");
      await writeFile(path.join(bundlePath, "SKILL.md"), "bundle-v2\n", "utf8");
      let renameCount = 0;
      const renamePath: typeof rename = async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("injected publish failure");
        await rename(oldPath, newPath);
      };

      const result = await createService({
        bundlePath,
        skillRootPath: rootPath,
        bundleVersion: "6.4.1-test",
        renamePath,
      }).syncConfiguredProviderSkill();
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);

      assert.equal(result.status, "failed");
      assert.match(result.errorMessage ?? "", /injected publish failure/);
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v1\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("publishとrename rollbackが失敗してもcopy rollbackで直前bundleを復元する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      assert.equal((await createService({ bundlePath, skillRootPath: rootPath }).syncConfiguredProviderSkill()).status, "installed");
      await writeFile(path.join(bundlePath, "SKILL.md"), "bundle-v2\n", "utf8");
      let renameCount = 0;
      const renamePath: typeof rename = async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount === 2 || renameCount === 3) throw new Error(`injected rename failure ${renameCount}`);
        await rename(oldPath, newPath);
      };

      const result = await createService({
        bundlePath,
        skillRootPath: rootPath,
        bundleVersion: "6.4.1-test",
        renamePath,
      }).syncConfiguredProviderSkill();
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);

      assert.equal(result.status, "failed");
      assert.match(result.errorMessage ?? "", /injected rename failure 2/);
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v1\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rollback中に空のunmanaged canonicalが現れた場合も上書きせずbackupを保持する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      assert.equal((await createService({ bundlePath, skillRootPath: rootPath }).syncConfiguredProviderSkill()).status, "installed");
      await writeFile(path.join(bundlePath, "SKILL.md"), "bundle-v2\n", "utf8");
      const installedPath = path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME);
      let renameCount = 0;
      const renamePath: typeof rename = async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("injected publish failure");
        if (renameCount === 3) {
          await mkdir(installedPath, { recursive: true });
          throw new Error("injected rollback race");
        }
        await rename(oldPath, newPath);
      };

      const result = await createService({
        bundlePath,
        skillRootPath: rootPath,
        bundleVersion: "6.4.1-test",
        renamePath,
      }).syncConfiguredProviderSkill();

      assert.equal(result.status, "failed");
      assert.deepEqual(await readdir(installedPath), []);
      const skillRootEntries = await readdir(path.dirname(installedPath));
      assert.ok(skillRootEntries.some((entry) => entry.endsWith(".backup")));
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("中断でcanonical pathが消えた場合はmarker付きbackupから復旧する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const service = createService({ bundlePath, skillRootPath: rootPath });
      assert.equal((await service.syncConfiguredProviderSkill()).status, "installed");
      const skillRootPath = path.join(rootPath, ".codex", "skills");
      const installedPath = path.join(skillRootPath, WITHMATE_SESSION_SKILL_NAME);
      const interruptedBackupPath = path.join(skillRootPath, `.${WITHMATE_SESSION_SKILL_NAME}-interrupted.backup`);
      await rename(installedPath, interruptedBackupPath);

      const result = await service.syncConfiguredProviderSkill();

      assert.equal(result.status, "unchanged");
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v1\n");
      await assert.rejects(readFile(path.join(interruptedBackupPath, "SKILL.md"), "utf8"));
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("中断復旧中に空のunmanaged canonicalが現れた場合は上書きしない", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const initialService = createService({ bundlePath, skillRootPath: rootPath });
      assert.equal((await initialService.syncConfiguredProviderSkill()).status, "installed");
      const skillRootPath = path.join(rootPath, ".codex", "skills");
      const installedPath = path.join(skillRootPath, WITHMATE_SESSION_SKILL_NAME);
      const interruptedBackupPath = path.join(skillRootPath, `.${WITHMATE_SESSION_SKILL_NAME}-interrupted.backup`);
      await rename(installedPath, interruptedBackupPath);
      const renamePath: typeof rename = async (oldPath, newPath) => {
        await mkdir(installedPath, { recursive: true });
        await rename(oldPath, newPath);
      };

      const result = await createService({ bundlePath, skillRootPath: rootPath, renamePath })
        .syncConfiguredProviderSkill();

      assert.equal(result.status, "failed");
      assert.deepEqual(await readdir(installedPath), []);
      assert.equal(await readFile(path.join(interruptedBackupPath, "SKILL.md"), "utf8"), "bundle-v1\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rollback stagingが途中で残っても完全なmarker付きbackupから復旧する", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const service = createService({ bundlePath, skillRootPath: rootPath });
      assert.equal((await service.syncConfiguredProviderSkill()).status, "installed");
      const skillRootPath = path.join(rootPath, ".codex", "skills");
      const installedPath = path.join(skillRootPath, WITHMATE_SESSION_SKILL_NAME);
      const interruptedBackupPath = path.join(skillRootPath, `.${WITHMATE_SESSION_SKILL_NAME}-interrupted.backup`);
      await rename(installedPath, interruptedBackupPath);
      const partialRollbackPath = `${interruptedBackupPath}.rollback.tmp`;
      await mkdir(partialRollbackPath, { recursive: true });
      await writeFile(path.join(partialRollbackPath, "partial.txt"), "partial\n", "utf8");

      const result = await service.syncConfiguredProviderSkill();

      assert.equal(result.status, "unchanged");
      assert.equal(await readFile(path.join(installedPath, "SKILL.md"), "utf8"), "bundle-v1\n");
      assert.equal(await readFile(path.join(partialRollbackPath, "partial.txt"), "utf8"), "partial\n");
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("unpackaged app、非Windows、未設定rootではfilesystemを変更しない", async () => {
    const bundlePath = await createBundle();
    const rootPath = await mkdtemp(path.join(tmpdir(), "withmate-session-skill-root-"));
    try {
      const unpackaged = await createService({
        bundlePath,
        skillRootPath: rootPath,
        isPackaged: false,
      }).syncConfiguredProviderSkill();
      const unconfigured = await createService({
        bundlePath,
        skillRootPath: "",
      }).syncConfiguredProviderSkill();
      const unsupportedPlatform = await createService({
        bundlePath,
        skillRootPath: rootPath,
        platform: "darwin",
      }).syncConfiguredProviderSkill();

      assert.equal(unpackaged.status, "skipped-unpackaged");
      assert.equal(unsupportedPlatform.status, "skipped-unsupported-platform");
      assert.equal(unconfigured.status, "skipped-unconfigured");
      await assert.rejects(
        readFile(path.join(rootPath, ".codex", "skills", WITHMATE_SESSION_SKILL_NAME, "SKILL.md"), "utf8"),
      );
    } finally {
      await rm(bundlePath, { recursive: true, force: true });
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
