import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ProviderInstructionTargetStorage,
  type ProviderInstructionTargetInput,
  type ProviderInstructionTargetSyncRunInput,
} from "../../src-electron/provider-instruction-target-storage.js";

async function createStorage(): Promise<{
  storage: ProviderInstructionTargetStorage;
  tempDirectory: string;
  dbPath: string;
}> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "withmate-provider-instruction-target-storage-"));
  const dbPath = path.join(tempDirectory, "withmate-v4.db");
  const storage = new ProviderInstructionTargetStorage(dbPath);
  return { storage, tempDirectory, dbPath };
}

function targetInput(overrides: Partial<ProviderInstructionTargetInput> = {}): ProviderInstructionTargetInput {
  return {
    providerId: "codex",
    enabled: true,
    rootDirectory: "/workspace",
    instructionRelativePath: path.join(".github", "copilot-instructions.md"),
    writeMode: "managed_block",
    failPolicy: "warn_continue",
    ...overrides,
  };
}

describe("ProviderInstructionTargetStorage", () => {
  it("v4 schema が適用され、provider_instruction_targets を利用できる", async () => {
    const { storage, dbPath, tempDirectory } = await createStorage();

    try {
      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'provider_instruction_targets'",
        ).get() as { name: string } | undefined;
        assert.equal(row?.name, "provider_instruction_targets");
      } finally {
        db.close();
      }

      const targets = storage.listTargets();
      assert.equal(targets.length, 0);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("upsertTarget は最後の同期状態を never で作成し、getTarget で読み取れる", async () => {
    const { storage, tempDirectory } = await createStorage();

    try {
      storage.upsertTarget(targetInput());
      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(target.providerId, "codex");
      assert.equal(target.targetId, "main");
      assert.equal(target.enabled, true);
      assert.equal(target.writeMode, "managed_block");
      assert.equal(target.projectionScope, "mate_only");
      assert.equal(target.lastSyncState, "never");
      assert.equal(target.lastSyncRunId, null);
      assert.equal(target.lastSyncedAt, null);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("listTargets は enabledOnly 条件でフィルタできる", async () => {
    const { storage, tempDirectory } = await createStorage();

    try {
      storage.upsertTarget({
        ...targetInput(),
        providerId: "copilot",
        enabled: true,
      });
      storage.upsertTarget({
        ...targetInput(),
        providerId: "codex",
        enabled: false,
        instructionRelativePath: "AGENTS.md",
      });

      const all = storage.listTargets();
      const enabledOnly = storage.listTargets({ enabledOnly: true });

      assert.equal(all.length, 2);
      assert.equal(enabledOnly.length, 1);
      assert.equal(enabledOnly[0]?.providerId, "copilot");
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("markTargetStale は last_sync_state を stale に更新する", async () => {
    const { storage, tempDirectory } = await createStorage();

    try {
      storage.upsertTarget(targetInput());
      storage.markTargetStale("codex", "main");

      const target = storage.getTarget("codex", "main");
      if (!target) {
        throw new Error("target がありません");
      }

      assert.equal(target.lastSyncState, "stale");
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("recordSyncRun で run を記録し、target の同期情報を更新する", async () => {
    const { storage, dbPath, tempDirectory } = await createStorage();

    try {
      const target = targetInput();
      storage.upsertTarget(target);

      const syncRunInput: ProviderInstructionTargetSyncRunInput = {
        providerId: target.providerId,
        writeMode: "managed_block",
        projectionScope: "mate_only",
        projectionSha256: "dummy-hash",
        status: "synced",
        errorPreview: "x".repeat(1024),
        requiresRestart: true,
      };
      const syncRun = storage.recordSyncRun(syncRunInput);

      const updatedTarget = storage.getTarget(target.providerId, "main");
      if (!updatedTarget) {
        throw new Error("target がありません");
      }

      assert.equal(updatedTarget.lastSyncState, "synced");
      assert.equal(updatedTarget.lastSyncRunId, syncRun.id);
      assert.equal(updatedTarget.lastSyncedRevisionId, null);
      assert.equal(updatedTarget.requiresRestart, true);
      assert.ok(updatedTarget.lastErrorPreview.length <= 512);
      assert.equal(syncRun.finishedAt, syncRun.startedAt);

      const db = new DatabaseSync(dbPath);
      try {
        const runRow = db.prepare("SELECT * FROM provider_instruction_sync_runs WHERE id = ?").get(syncRun.id) as
          | { status: string; projection_scope: string; requires_restart: number; error_preview: string }
          | undefined;
        if (!runRow) {
          throw new Error("sync run が見つからないよ");
        }

        assert.equal(runRow.status, "synced");
        assert.equal(runRow.projection_scope, "mate_only");
        assert.equal(runRow.requires_restart, 1);
        assert.equal(runRow.error_preview, syncRun.errorPreview);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("deleteTarget で target を削除でき、run も外部キーで削除される", async () => {
    const { storage, dbPath, tempDirectory } = await createStorage();

    try {
      const target = targetInput();
      storage.upsertTarget(target);
      storage.recordSyncRun({
        providerId: target.providerId,
        writeMode: "managed_block",
        projectionScope: "mate_only",
        projectionSha256: "dummy-hash",
        status: "skipped",
      });

      const deleted = storage.deleteTarget(target.providerId);
      assert.equal(deleted, true);
      assert.equal(storage.getTarget(target.providerId, "main"), null);

      const db = new DatabaseSync(dbPath);
      try {
        const runCountRow = db
          .prepare("SELECT COUNT(*) AS count FROM provider_instruction_sync_runs WHERE provider_id = ?")
          .get(target.providerId) as { count: number };
        assert.equal(runCountRow.count, 0);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("providerId / targetId / instructionRelativePath の不正値を拒否する", async () => {
    const { storage, tempDirectory } = await createStorage();

    try {
      assert.throws(() =>
        storage.upsertTarget({
          ...targetInput(),
          providerId: "../codex",
        }),
      /invalid providerId/);

      assert.throws(() =>
        storage.upsertTarget({
          ...targetInput(),
          targetId: "../main",
        }),
      /invalid targetId/);

      assert.throws(() =>
        storage.upsertTarget({
          ...targetInput(),
          instructionRelativePath: "..\\foo.md",
        }),
      /instructionRelativePath/);
    } finally {
      storage.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
