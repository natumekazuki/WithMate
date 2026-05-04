import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { MateProfile } from "../../src/mate-state.js";
import {
  MATE_PROFILE_BLOCK_ID,
  upsertMateInstructionBlock,
} from "../../src-electron/mate-instruction-projection.js";
import {
  createDefaultProviderInstructionTargets,
  resolveProviderInstructionFilePath,
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
  const marker = `<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`;
  const matches = content.match(new RegExp(marker, "g"));
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
      const expectedContent = upsertMateInstructionBlock("", profile);

      assert.equal(updated, expectedContent);
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
      assert.ok(updated.includes(`<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`));
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
        + `<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->\n`
        + "## WithMate Mate Profile\n"
        + "old body\n"
        + `<!-- WITHMATE:END ${MATE_PROFILE_BLOCK_ID} -->\n`
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

      assert.ok(updated.includes(`<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`));
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
      assert.ok(updated.includes(`<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`));
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
      assert.ok(successContent.includes(`<!-- WITHMATE:BEGIN ${MATE_PROFILE_BLOCK_ID} -->`));
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
      await assert.rejects(
        () => syncEnabledProviderInstructionTargets(storage, profile, FILE_DEPENDENCIES),
        /providerId=codex, targetId=main/,
      );

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
