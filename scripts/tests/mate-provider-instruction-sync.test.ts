import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { MateProfile } from "../../src/mate-state.js";
import {
  MATE_PROFILE_BLOCK_ID,
} from "../../src-electron/mate-instruction-projection.js";
import {
  createDefaultProviderInstructionTargets,
  MateProviderInstructionSyncBlockedError,
  resolveProviderInstructionFilePath,
  syncDisabledProviderInstructionTargets,
  syncEnabledProviderInstructionTargets,
  syncMateInstructionFile,
  syncMateInstructionFiles,
} from "../../src-electron/mate-provider-instruction-sync.js";
import { ProviderInstructionTargetStorage } from "../../src-electron/provider-instruction-target-storage.js";

const FILE_DEPENDENCIES = {
  async readTextFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf8");
  },
  async writeTextFile(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf8");
  },
};

const DEFAULT_TARGET_ID = "main";

function buildManagedProfileBeginMarker(
  providerId: string,
  targetId = DEFAULT_TARGET_ID,
  mode = "managed-block",
): string {
  return `<!-- WITHMATE:BEGIN provider=${providerId} target=${targetId} mode=${mode} block=${MATE_PROFILE_BLOCK_ID} -->`;
}

function buildManagedProfileEndMarker(
  providerId: string,
  targetId = DEFAULT_TARGET_ID,
  mode = "managed-block",
): string {
  return `<!-- WITHMATE:END provider=${providerId} target=${targetId} mode=${mode} block=${MATE_PROFILE_BLOCK_ID} -->`;
}

function createProfile(partial: Partial<MateProfile> = {}): MateProfile {
  return {
    id: "current",
    state: "active",
    displayName: "Mia",
    description: "",
    themeMain: "#6f8cff",
    themeSub: "#6fb8c7",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    sections: [],
    ...partial,
  };
}

function countProfileBlocks(content: string): number {
  const matches = content.match(new RegExp(`<!--\\s*WITHMATE:BEGIN[^>]*\\b${MATE_PROFILE_BLOCK_ID}\\b`, "g"));
  return matches ? matches.length : 0;
}

describe("createDefaultProviderInstructionTargets", () => {
  it("providerId から既定の instruction file path を作る", () => {
    const workspacePath = "/tmp/workspace";
    const targets = createDefaultProviderInstructionTargets(workspacePath, ["codex", "copilot"]);

    assert.equal(targets.length, 2);
    assert.equal(targets[0]?.filePath, path.join("/tmp/workspace", "AGENTS.md"));
    assert.equal(targets[1]?.filePath, path.join("/tmp/workspace", ".github", "copilot-instructions.md"));
  });

  it("providerId を正規化し、path に使えない値は拒否する", () => {
    assert.equal(resolveProviderInstructionFilePath("Copilot"), path.join(".github", "copilot-instructions.md"));
    assert.equal(resolveProviderInstructionFilePath("custom_provider"), path.join(".github", "custom_provider-instructions.md"));
    assert.throws(() => resolveProviderInstructionFilePath("../outside"), /Invalid providerId/);
  });
});

describe("syncMateInstructionFile", () => {
  it("missing file を作成できる", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-sync-"));
    try {
      const target = { providerId: "codex", filePath: path.join(workspacePath, "AGENTS.md") };
      const profile = createProfile({ displayName: "Mia" });

      await syncMateInstructionFile(target, profile, FILE_DEPENDENCIES);
      const updated = await readFile(target.filePath, "utf8");
      assert.equal(countProfileBlocks(updated), 1);
      assert.ok(updated.includes(buildManagedProfileBeginMarker("codex")));
      assert.ok(updated.includes(`- **displayName:** ${profile.displayName}`));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("既存ユーザー文を保持して managed block を追記する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-sync-"));
    try {
      const target = { providerId: "codex", filePath: path.join(workspacePath, "AGENTS.md") };
      const profile = createProfile({ displayName: "Mia" });
      await writeFile(target.filePath, "User note\n", "utf8");

      await syncMateInstructionFile(target, profile, FILE_DEPENDENCIES);
      const updated = await readFile(target.filePath, "utf8");

      assert.match(updated, /^User note\n/);
      assert.ok(updated.includes(buildManagedProfileBeginMarker("codex")));
      assert.ok(updated.includes("## WithMate Mate Profile"));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("既存 block があれば重複なく置換する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-sync-"));
    try {
      const target = { providerId: "codex", filePath: path.join(workspacePath, "AGENTS.md") };
      const profile = createProfile({ displayName: "Mia", description: "new profile" });
      const baseContent =
        "Header\n"
        + `${buildManagedProfileBeginMarker("codex")}\n`
        + "## WithMate Mate Profile\n"
        + "old body\n"
        + `${buildManagedProfileEndMarker("codex")}\n`
        + "Footer\n";
      await writeFile(target.filePath, baseContent, "utf8");

      await syncMateInstructionFile(target, profile, FILE_DEPENDENCIES);
      const updated = await readFile(target.filePath, "utf8");

      assert.equal(countProfileBlocks(updated), 1);
      assert.equal(updated.includes("old body"), false);
      assert.ok(updated.includes("new profile"));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("copilot の parent directory を作成して同期できる", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-sync-"));
    try {
      const target = {
        providerId: "copilot",
        filePath: path.join(workspacePath, ".github", "copilot-instructions.md"),
      };
      const profile = createProfile({ displayName: "Mia", description: "copilot" });

      await syncMateInstructionFile(target, profile, FILE_DEPENDENCIES);
      const updated = await readFile(target.filePath, "utf8");

      assert.ok(updated.includes(buildManagedProfileBeginMarker("copilot")));
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("syncMateInstructionFiles", () => {
  it("複数 target を同期できる", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-sync-"));
    try {
      const targets = createDefaultProviderInstructionTargets(workspacePath, ["codex", "copilot"]);
      const profile = createProfile({ displayName: "Mia" });

      await syncMateInstructionFiles(targets, profile, FILE_DEPENDENCIES);

      const contents = await Promise.all(targets.map(async (target) => readFile(target.filePath, "utf8")));
      for (const content of contents) {
        assert.equal(countProfileBlocks(content), 1);
      }
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("syncEnabledProviderInstructionTargets", () => {
  it("有効な target のみ managed_block 同期でき、結果に run id が含まれる", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-sync-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);

    try {
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "copilot-instructions.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      storage.upsertTarget({
        providerId: "codex",
        targetId: "disabled",
        enabled: false,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "skip.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "sync all" });
      const result = await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);

      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      const updated = await readFile(path.join(workspacePath, ".github", "copilot-instructions.md"), "utf8");

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 1);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.runIds.length, 1);
      assert.equal(result.runIds[0], target.lastSyncRunId);
      assert.equal(target.lastSyncState, "synced");
      assert.ok(updated.includes(buildManagedProfileBeginMarker("codex")));
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("同一 provider/target/mode の block は置換され、他の provider/target block は保持される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-sync-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);
    const targetPath = path.join(workspacePath, ".github", "copilot-instructions.md");
    const existingContent =
      "User note\n"
      + `${buildManagedProfileBeginMarker("codex", "main")}\n`
      + "## WithMate Mate Profile\n"
      + "main body\n"
      + `${buildManagedProfileEndMarker("codex", "main")}\n`
      + `${buildManagedProfileBeginMarker("codex", "feature")}\n`
      + "## WithMate Mate Profile\n"
      + "old body\n"
      + `${buildManagedProfileEndMarker("codex", "feature")}\n`
      + `${buildManagedProfileBeginMarker("copilot", "main")}\n`
      + "## WithMate Mate Profile\n"
      + "copilot body\n"
      + `${buildManagedProfileEndMarker("copilot", "main")}\n`;

    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, existingContent, "utf8");

      storage.upsertTarget({
        providerId: "codex",
        targetId: "feature",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "copilot-instructions.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "sync target", sections: [] });
      const result = await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);

      const updated = await readFile(targetPath, "utf8");
      const target = storage.getTarget("codex", "feature");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 1);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.runIds.length, 1);
      assert.equal(result.runIds[0], target.lastSyncRunId);
      assert.equal(target.lastSyncState, "synced");
      assert.equal(countProfileBlocks(updated), 3);
      assert.equal(updated.includes("old body"), false);
      assert.equal(updated.includes("main body"), true);
      assert.equal(updated.includes("copilot body"), true);
      assert.equal(updated.includes(buildManagedProfileBeginMarker("codex", "main")), true);
      assert.equal(updated.includes(buildManagedProfileBeginMarker("codex", "feature")), true);
      assert.equal(updated.includes(buildManagedProfileBeginMarker("copilot", "main")), true);
      assert.equal(updated.includes("- **displayName:** Mia"), true);
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("managed_file は skipped として記録する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-sync-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);

    try {
      storage.upsertTarget({
        providerId: "copilot",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "copilot-instructions.md"),
        writeMode: "managed_file",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "managed file" });
      const result = await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);
      const target = storage.getTarget("copilot", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 0);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.runIds.length, 1);
      assert.equal(target.lastSyncState, "skipped");
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("失敗しても他 target の同期を続行する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-sync-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);

    try {
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: "relative/root",
        instructionRelativePath: path.join("AGENTS.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      storage.upsertTarget({
        providerId: "copilot",
        enabled: true,
        targetId: "valid",
        rootDirectory: workspacePath,
        instructionRelativePath: path.join("AGENTS.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "partial" });
      const result = await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);

      const failed = storage.getTarget("codex", "main");
      if (!failed) {
        throw new Error("失敗 target がありません");
      }
      const success = storage.getTarget("copilot", "valid");
      if (!success) {
        throw new Error("成功 target がありません");
      }
      const successContent = await readFile(path.join(workspacePath, "AGENTS.md"), "utf8");

      assert.equal(result.targetCount, 2);
      assert.equal(result.syncedCount, 1);
      assert.equal(result.failedCount, 1);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.runIds.length, 2);
      assert.equal(failed.lastSyncState, "failed");
      assert.equal(success.lastSyncState, "synced");
      assert.ok(successContent.includes(buildManagedProfileBeginMarker("copilot", "valid")));
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("block_session が有効な失敗 target は reject し、失敗 target は failed として記録する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-sync-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);

    try {
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: "relative/root",
        instructionRelativePath: path.join("AGENTS.md"),
        writeMode: "managed_block",
        failPolicy: "block_session",
      });

      storage.upsertTarget({
        providerId: "copilot",
        enabled: true,
        targetId: "valid",
        rootDirectory: workspacePath,
        instructionRelativePath: path.join("AGENTS.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "blocking fail" });
      await assert.rejects(async () => {
        try {
          await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);
        } catch (error) {
          if (!(error instanceof MateProviderInstructionSyncBlockedError)) {
            throw error;
          }
          assert.equal(error.providerId, "codex");
          assert.equal(error.targetId, "main");
          assert.match(error.errorPreview, /rootDirectory/);
          throw error;
        }
      });

      const failed = storage.getTarget("codex", "main");
      if (!failed) {
        throw new Error("失敗 target がありません");
      }
      const skipped = storage.getTarget("copilot", "valid");
      if (!skipped) {
        throw new Error("次 target がありません");
      }

      assert.equal(failed.lastSyncState, "failed");
      assert.equal(skipped.lastSyncState, "never");
      assert.match(failed.lastErrorPreview, /rootDirectory/);
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("target path が空の場合は failed として記録する", async () => {
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);

    try {
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: "",
        instructionRelativePath: path.join("AGENTS.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const profile = createProfile({ displayName: "Mia", description: "invalid root" });
      const result = await syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES);
      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.failedCount, 1);
      assert.equal(target.lastSyncState, "failed");
      assert.match(target.lastErrorPreview, /rootDirectory/);
    } finally {
      storage.close();
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });
});

describe("syncDisabledProviderInstructionTargets", () => {
  it("managed_block で既存の user content を保持しつつ Mate projection block を削除する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-reset-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);
    const targetPath = path.join(workspacePath, ".github", "copilot-instructions.md");
    const existingContent = "User note\n"
      + `${buildManagedProfileBeginMarker("codex", "feature")}\n`
      + "## WithMate Mate Profile\n"
      + "other target\n"
      + `${buildManagedProfileEndMarker("codex", "feature")}\n`
      + `${buildManagedProfileBeginMarker("copilot")}\n`
      + "## WithMate Mate Profile\n"
      + "other provider\n"
      + `${buildManagedProfileEndMarker("copilot")}\n`
      + `${buildManagedProfileBeginMarker("codex", "main")}\n`
      + "## WithMate Mate Profile\n"
      + "old body\n"
      + `${buildManagedProfileEndMarker("codex", "main")}\n`
      + "Footer\n";

    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, existingContent, "utf8");
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "copilot-instructions.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const result = await syncDisabledProviderInstructionTargets(storage, FILE_DEPENDENCIES);
      const updated = await readFile(targetPath, "utf8");
      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 1);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(result.runIds.length, 1);
      assert.equal(result.runIds[0], target.lastSyncRunId);
      assert.equal(target.lastSyncState, "synced");
      assert.equal(countProfileBlocks(updated), 2);
      assert.equal(updated.includes("User note"), true);
      assert.equal(updated.includes("Footer"), true);
      assert.equal(updated.includes("other target"), true);
      assert.equal(updated.includes("other provider"), true);
      assert.equal(updated.includes("old body"), false);
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("managed_file は空コンテンツへ更新される", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-reset-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);
    const targetPath = path.join(workspacePath, "AGENTS.md");

    try {
      await writeFile(targetPath, "managed file content", "utf8");
      storage.upsertTarget({
        providerId: "copilot",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: "AGENTS.md",
        writeMode: "managed_file",
        failPolicy: "warn_continue",
      });

      const result = await syncDisabledProviderInstructionTargets(storage, FILE_DEPENDENCIES);
      const updated = await readFile(targetPath, "utf8");

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 1);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 0);
      assert.equal(updated, "");
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("対象ファイルが存在しない場合は新規作成せず skipped として記録する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-reset-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);
    const targetPath = path.join(workspacePath, ".github", "copilot-instructions.md");

    try {
      storage.upsertTarget({
        providerId: "copilot",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: path.join(".github", "copilot-instructions.md"),
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const result = await syncDisabledProviderInstructionTargets(storage, FILE_DEPENDENCIES);
      const target = storage.getTarget("copilot", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 0);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(target.lastSyncState, "skipped");
      await assert.rejects(() => readFile(targetPath, "utf8"), /ENOENT/);
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });

  it("managed_block が存在しない既存ファイルは変更せず skipped として記録する", async () => {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "withmate-mate-instruction-target-reset-"));
    const tempDatabaseDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-target-db-"));
    const storagePath = path.join(tempDatabaseDirectory, "withmate-v4.db");
    const storage = new ProviderInstructionTargetStorage(storagePath);
    const targetPath = path.join(workspacePath, "AGENTS.md");
    const existingContent = "User note without managed block";

    try {
      await writeFile(targetPath, existingContent, "utf8");
      storage.upsertTarget({
        providerId: "codex",
        enabled: true,
        rootDirectory: workspacePath,
        instructionRelativePath: "AGENTS.md",
        writeMode: "managed_block",
        failPolicy: "warn_continue",
      });

      const result = await syncDisabledProviderInstructionTargets(storage, FILE_DEPENDENCIES);
      const updated = await readFile(targetPath, "utf8");
      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(result.targetCount, 1);
      assert.equal(result.syncedCount, 0);
      assert.equal(result.failedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(target.lastSyncState, "skipped");
      assert.equal(updated, existingContent);
    } finally {
      storage.close();
      await rm(workspacePath, { recursive: true, force: true });
      await rm(tempDatabaseDirectory, { recursive: true, force: true });
    }
  });
});
