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
  it("session 経由 core は skipped、bond/work_style は適用される", async () => {
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
      const bond = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "repeated_user_behavior",
        kind: "relationship",
        targetSection: "bond",
        statement: "ユーザーは短文を好む",
        statementFingerprint: "short-message-preference",
        targetClaimKey: "reply_length",
        confidence: 82,
        salienceScore: 68,
        projectionAllowed: true,
      });
      const workStyle = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "assistant_inference",
        kind: "work_style",
        targetSection: "work_style",
        statement: "最初に方針を簡潔に共有する",
        statementFingerprint: "share-plan-first",
        targetClaimKey: "plan_first",
        confidence: 88,
        salienceScore: 76,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(growthStorage, profileItemStorage, mateStorage);
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.candidateCount, 3);
      assert.equal(result.appliedCount, 2);
      assert.equal(result.skippedCount, 1);
      assert.equal(typeof result.revisionId, "string");

      const coreContent = await readFile(path.join(userDataPath, "mate/core.md"), "utf8");
      const bondContent = await readFile(path.join(userDataPath, "mate/bond.md"), "utf8");
      const workStyleContent = await readFile(path.join(userDataPath, "mate/work-style.md"), "utf8");
      assert.equal(coreContent.includes("一人称は"), false);
      assert.equal(bondContent.includes("- ユーザーは短文を好む"), true);
      assert.equal(workStyleContent.includes("- 最初に方針を簡潔に共有する"), true);

      const coreItems = profileItemStorage.listProfileItems({ sectionKey: "core", state: "active" });
      const bondItems = profileItemStorage.listProfileItems({ sectionKey: "bond", state: "active" });
      const workStyleItems = profileItemStorage.listProfileItems({ sectionKey: "work_style", state: "active" });
      assert.equal(coreItems.length, 0);
      assert.equal(bondItems.length, 1);
      assert.equal(bondItems[0].claimKey, "reply_length");
      assert.equal(bondItems[0].category, "relationship");
      assert.equal(workStyleItems.length, 1);
      assert.equal(workStyleItems[0].claimKey, "plan_first");
      assert.equal(workStyleItems[0].category, "work_style");

      const db = new DatabaseSync(dbPath);
      try {
        const rows = db.prepare(`
          SELECT id, state, applied_revision_id
          FROM mate_growth_events
          ORDER BY id
        `).all() as Array<{ id: string; state: string; applied_revision_id: string | null }>;

        assert.equal(rows.find((row) => row.id === applicable.id)?.state, "disabled");
        assert.equal(rows.find((row) => row.id === bond.id)?.state, "applied");
        assert.equal(rows.find((row) => row.id === workStyle.id)?.state, "applied");
        assert.equal(rows.find((row) => row.id === applicable.id)?.applied_revision_id, null);
        assert.equal(rows.find((row) => row.id === bond.id)?.applied_revision_id, result.revisionId);
        assert.equal(rows.find((row) => row.id === workStyle.id)?.applied_revision_id, result.revisionId);
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
