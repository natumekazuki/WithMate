import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateGrowthApplyService } from "../../src-electron/mate-growth-apply-service.js";
import { MateGrowthStorage } from "../../src-electron/mate-growth-storage.js";
import { MateProfileItemStorage } from "../../src-electron/mate-profile-item-storage.js";
import { MateStorage } from "../../src-electron/mate-storage.js";

function createTempPaths(): Promise<{ dbPath: string; userDataPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-growth-apply-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    userDataPath: path.join(tmpDir, "user-data"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

describe("MateGrowthApplyService", () => {
  it("candidate growth events を profile item 化し Mate ファイルへ反映する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const applicable = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "explicit_user_instruction",
        kind: "conversation",
        targetSection: "core",
        statement: "一人称は「ぼく」を使う",
        statementFingerprint: "first-person-boku",
        targetClaimKey: "first_person",
        confidence: 90,
        salienceScore: 80,
        projectionAllowed: true,
      });
      const skipped = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "assistant_inference",
        kind: "observation",
        targetSection: "none",
        statement: "投影対象なし",
        statementFingerprint: "none-target",
        confidence: 50,
        salienceScore: 50,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(growthStorage, profileItemStorage, mateStorage);
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.candidateCount, 2);
      assert.equal(result.appliedCount, 1);
      assert.equal(result.skippedCount, 1);
      assert.equal(typeof result.revisionId, "string");

      const coreContent = await readFile(path.join(userDataPath, "mate/core.md"), "utf8");
      assert.equal(coreContent.includes("- 一人称は「ぼく」を使う"), true);

      const items = profileItemStorage.listProfileItems({ sectionKey: "core", state: "active" });
      assert.equal(items.length, 1);
      assert.equal(items[0].claimKey, "first_person");
      assert.equal(items[0].category, "voice");

      const db = new DatabaseSync(dbPath);
      try {
        const rows = db.prepare(`
          SELECT id, state, applied_revision_id
          FROM mate_growth_events
          ORDER BY id
        `).all() as Array<{ id: string; state: string; applied_revision_id: string | null }>;

        assert.equal(rows.find((row) => row.id === applicable.id)?.state, "applied");
        assert.equal(rows.find((row) => row.id === applicable.id)?.applied_revision_id, result.revisionId);
        assert.equal(rows.find((row) => row.id === skipped.id)?.state, "disabled");
      } finally {
        db.close();
      }
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });
});
