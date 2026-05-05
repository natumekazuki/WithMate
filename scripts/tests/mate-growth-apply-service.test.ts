import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { MateGrowthApplyService } from "../../src-electron/mate-growth-apply-service.js";
import { MateGrowthStorage } from "../../src-electron/mate-growth-storage.js";
import { MateProfileItemStorage } from "../../src-electron/mate-profile-item-storage.js";
import { MateProjectDigestStorage } from "../../src-electron/mate-project-digest-storage.js";
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

  it("project_digest は projectDigestId があれば apply される", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const projectDigestStorage = new MateProjectDigestStorage(dbPath);

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const projectDigest = projectDigestStorage.resolveProjectDigestForWorkspace(process.cwd());
      assert.ok(projectDigest);
      const projectDigestId = projectDigest.id;
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const projectDigestEvent = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "repeated_user_behavior",
        kind: "project_context",
        targetSection: "project_digest",
        projectDigestId,
        statement: "このプロジェクトでは TypeScript を重視する",
        statementFingerprint: "project-typescript-first",
        targetClaimKey: "project-preference",
        confidence: 84,
        salienceScore: 70,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        undefined,
        undefined,
        projectDigestStorage,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.candidateCount, 1);
      assert.equal(result.appliedCount, 1);
      assert.equal(result.skippedCount, 0);
      assert.equal(typeof result.revisionId, "string");

      const projectDigestItems = profileItemStorage.listProfileItems({
        sectionKey: "project_digest",
        state: "active",
        projectDigestId,
      });
      assert.equal(projectDigestItems.length, 1);
      assert.equal(projectDigestItems[0].projectDigestId, projectDigestId);
      assert.equal(projectDigestItems[0].claimKey, "project-preference");
      assert.equal(projectDigestItems[0].category, "project_context");

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT state, applied_revision_id FROM mate_growth_events WHERE id = ?").get(
          projectDigestEvent.id,
        ) as { state: string; applied_revision_id: string | null };
        assert.equal(row.state, "applied");
        assert.equal(row.applied_revision_id, result.revisionId);
      } finally {
        db.close();
      }
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      projectDigestStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("project_digest は projectDigestId がない場合 skipped になる", async () => {
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
      growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "repeated_user_behavior",
        kind: "project_context",
        targetSection: "project_digest",
        statement: "このプロジェクトでは TypeScript を重視する",
        statementFingerprint: "project-typescript-first",
        targetClaimKey: "project-preference",
        confidence: 84,
        salienceScore: 70,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(growthStorage, profileItemStorage, mateStorage);
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.candidateCount, 1);
      assert.equal(result.appliedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.revisionId, null);

      const projectDigestItems = profileItemStorage.listProfileItems({ sectionKey: "project_digest", state: "active" });
      assert.equal(projectDigestItems.length, 0);
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("project_digest は存在しない projectDigestId の場合 skipped になる", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const projectDigestStorage = new MateProjectDigestStorage(dbPath);

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const event = growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "repeated_user_behavior",
        kind: "project_context",
        targetSection: "project_digest",
        projectDigestId: "missing-project-digest",
        statement: "このプロジェクトでは TypeScript を重視する",
        statementFingerprint: "project-typescript-first",
        targetClaimKey: "project-preference",
        confidence: 84,
        salienceScore: 70,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        undefined,
        undefined,
        projectDigestStorage,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.candidateCount, 1);
      assert.equal(result.appliedCount, 0);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.revisionId, null);

      const projectDigestItems = profileItemStorage.listProfileItems({ sectionKey: "project_digest", state: "active" });
      assert.equal(projectDigestItems.length, 0);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT state, applied_revision_id FROM mate_growth_events WHERE id = ?").get(
          event.id,
        ) as { state: string; applied_revision_id: string | null };
        assert.equal(row.state, "disabled");
        assert.equal(row.applied_revision_id, null);
      } finally {
        db.close();
      }
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      projectDigestStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("適用対象イベントと profile item に対してのみ embedding index が呼ばれる", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const indexedGrowthEventIds: string[] = [];
    const indexedProfileItemIds: string[] = [];

    const embeddingIndexService = {
      indexGrowthEvent: async (event) => {
        indexedGrowthEventIds.push(event.id);
      },
      indexProfileItem: async (item) => {
        indexedProfileItemIds.push(item.id);
      },
    };

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const skippedCore = growthStorage.upsertEvent({
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
      const applicableBond = growthStorage.upsertEvent({
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
      const applicableWorkStyle = growthStorage.upsertEvent({
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

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        embeddingIndexService,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.appliedCount, 2);
      assert.deepEqual(
        indexedGrowthEventIds.sort(),
        [applicableBond.id, applicableWorkStyle.id].sort(),
      );

      const activeProfileItems = profileItemStorage.listProfileItems({ state: "active" });
      const indexedProfileItems = profileItemStorage.listProfileItems({ state: "active" })
        .filter((item) => indexedProfileItemIds.includes(item.id));
      assert.equal(indexedProfileItemIds.length, 2);
      assert.equal(indexedProfileItemIds.length, result.appliedCount);
      assert.equal(indexedProfileItems.length, 2);
      const indexedClaimKeys = new Set(indexedProfileItems.map((item) => item.claimKey));
      assert.equal(indexedClaimKeys.has("reply_length"), true);
      assert.equal(indexedClaimKeys.has("plan_first"), true);
      assert.equal(indexedProfileItems.every((item) => activeProfileItems.some((active) => active.id === item.id)), true);
      assert.equal(indexedGrowthEventIds.includes(skippedCore.id), false);
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("applyProfileFiles 失敗時は profile item を active として残さず、適用済み状態にもしない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    let originalApplyProfileFiles = mateStorage.applyProfileFiles;

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      growthStorage.upsertEvent({
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

      mateStorage.applyProfileFiles = (async () => {
        throw new Error("profile files commit failed");
      }) as typeof mateStorage.applyProfileFiles;

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
      );

      await assert.rejects(
        () => service.applyPendingGrowth({ runId }),
        /profile files commit failed/,
      );

      const activeBondItems = profileItemStorage.listProfileItems({ sectionKey: "bond", state: "active" });
      assert.equal(activeBondItems.length, 0);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT state, applied_revision_id FROM mate_growth_events WHERE source_growth_run_id = ?").get(runId) as {
          state: string;
          applied_revision_id: string | null;
        };
        assert.equal(row.state, "candidate");
        assert.equal(row.applied_revision_id, null);
      } finally {
        db.close();
      }
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.applyProfileFiles = originalApplyProfileFiles;
      mateStorage.close();
      await cleanup();
    }
  });

  it("適用イベントがある場合は provider instruction target の stale 無効化が呼ばれる", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    let staleCallCount = 0;
    const targetInvalidator = {
      markEnabledTargetsStale: () => {
        staleCallCount += 1;
        return 1;
      },
    };

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      growthStorage.upsertEvent({
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

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        undefined,
        targetInvalidator,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.appliedCount, 1);
      assert.equal(staleCallCount, 1);
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("適用イベントがない場合は provider instruction target の stale 無効化を呼ばない", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    let staleCallCount = 0;
    const targetInvalidator = {
      markEnabledTargetsStale: () => {
        staleCallCount += 1;
        return 1;
      },
    };

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      growthStorage.upsertEvent({
        sourceGrowthRunId: runId,
        sourceType: "session",
        sourceSessionId: "session-1",
        growthSourceType: "assistant_inference",
        kind: "conversation",
        targetSection: "core",
        statement: "一人称は「ぼく」を使う",
        statementFingerprint: "first-person-boku",
        targetClaimKey: "first_person",
        confidence: 90,
        salienceScore: 80,
        projectionAllowed: true,
      });

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        undefined,
        targetInvalidator,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.appliedCount, 0);
      assert.equal(staleCallCount, 0);
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      await cleanup();
    }
  });

  it("provider instruction target の stale 無効化が失敗しても growth apply は成功する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    const targetInvalidator = {
      markEnabledTargetsStale: () => {
        throw new Error("provider instruction storage unavailable");
      },
    };

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const event = growthStorage.upsertEvent({
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

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        undefined,
        targetInvalidator,
      );
      const result = await service.applyPendingGrowth({ runId });

      assert.equal(result.appliedCount, 1);
      assert.equal(typeof result.revisionId, "string");
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0] ?? ""), /provider instruction targets stale/i);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT state, applied_revision_id FROM mate_growth_events WHERE id = ?").get(event.id) as {
          state: string;
          applied_revision_id: string | null;
        };
        assert.equal(row.state, "applied");
        assert.equal(row.applied_revision_id, result.revisionId);
      } finally {
        db.close();
      }
    } finally {
      profileItemStorage.close();
      growthStorage.close();
      mateStorage.close();
      console.warn = originalWarn;
      await cleanup();
    }
  });

  it("embedding index が例外を投げても growth apply は成功しつつ状態更新が完了する", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const embeddingIndexService = {
      indexGrowthEvent: async () => {
        throw new Error("index service unavailable");
      },
      indexProfileItem: async () => {
        throw new Error("index service unavailable");
      },
    };

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });
      const event = growthStorage.upsertEvent({
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

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
        embeddingIndexService,
      );
      const result = await service.applyPendingGrowth({ runId });

      const bondContent = await readFile(path.join(userDataPath, "mate/bond.md"), "utf8");
      assert.equal(result.appliedCount, 1);
      assert.equal(typeof result.revisionId, "string");
      assert.equal(bondContent.includes("- ユーザーは短文を好む"), true);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare(`SELECT state, applied_revision_id FROM mate_growth_events WHERE id = ?`)
          .get(event.id) as { state: string; applied_revision_id: string | null };
        assert.equal(row.state, "applied");
        assert.equal(row.applied_revision_id, result.revisionId);
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

  it("同時実行時に writer lock で二重 revision / applied 更新を避ける", async () => {
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
      const event = growthStorage.upsertEvent({
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

      const service = new MateGrowthApplyService(growthStorage, profileItemStorage, mateStorage);
      const beforeDb = new DatabaseSync(dbPath);
      const beforeRevisionCount = beforeDb.prepare(`
        SELECT COUNT(*) AS count
        FROM mate_profile_revisions
        WHERE kind = 'growth_apply'
      `).get() as { count: number };
      beforeDb.close();

      const [first, second] = await Promise.all([
        service.applyPendingGrowth({ runId }),
        service.applyPendingGrowth({ runId }),
      ]);

      assert.equal(first.appliedCount, 1);
      assert.equal(second.appliedCount, 1);
      assert.equal(first.revisionId, second.revisionId);
      assert.equal(typeof first.revisionId, "string");

      const db = new DatabaseSync(dbPath);
      try {
        const revisionCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM mate_profile_revisions
          WHERE kind = 'growth_apply'
        `).get() as { count: number };
        const row = db.prepare("SELECT state, applied_revision_id FROM mate_growth_events WHERE id = ?").get(event.id) as {
          state: string;
          applied_revision_id: string | null;
        };
        assert.equal(revisionCount.count, beforeRevisionCount.count + 1);
        assert.equal(row.state, "applied");
        assert.equal(row.applied_revision_id, first.revisionId);
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

  it("event を更新すると operation fingerprint が変わり、別 run で適用される", async () => {
    const { dbPath, userDataPath, cleanup } = await createTempPaths();
    const mateStorage = new MateStorage(dbPath, userDataPath);
    const growthStorage = new MateGrowthStorage(dbPath);
    const profileItemStorage = new MateProfileItemStorage(dbPath);
    const eventId = "fingerprint-event-1";

    try {
      await mateStorage.createMate({ displayName: "Mika" });
      const runId = growthStorage.createRun({
        sourceType: "session",
        sourceSessionId: "session-1",
        triggerReason: "test",
      });

      growthStorage.upsertEvent({
        id: eventId,
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

      const service = new MateGrowthApplyService(
        growthStorage,
        profileItemStorage,
        mateStorage,
      );
      const first = await service.applyPendingGrowth({ runId });
      assert.equal(typeof first.revisionId, "string");

      const db = new DatabaseSync(dbPath);
      try {
        const firstRun = db.prepare(`
          SELECT id, operation_id
          FROM mate_growth_runs
          WHERE output_revision_id = ?
        `).get(first.revisionId) as {
          id: number;
          operation_id: string;
        };

        growthStorage.upsertEvent({
          id: eventId,
          sourceGrowthRunId: runId,
          sourceType: "session",
          sourceSessionId: "session-1",
          growthSourceType: "repeated_user_behavior",
          kind: "relationship",
          targetSection: "bond",
          statement: "ユーザーは短文を好む（さらに短く）",
          statementFingerprint: "short-message-preference",
          targetClaimKey: "reply_length",
          confidence: 84,
          salienceScore: 69,
          projectionAllowed: true,
        });

        const second = await service.applyPendingGrowth({ runId });
        assert.equal(typeof second.revisionId, "string");

        const secondRun = db.prepare(`
          SELECT id, operation_id
          FROM mate_growth_runs
          WHERE output_revision_id = ?
        `).get(second.revisionId) as {
          id: number;
          operation_id: string;
        };

        assert.notEqual(firstRun.id, secondRun.id);
        assert.notEqual(firstRun.operation_id, secondRun.operation_id);
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
