import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  MateGrowthStorage,
  type MateGrowthEventInput,
  type MateGrowthRunInput,
} from "../../src-electron/mate-growth-storage.js";

const BASE_TIME = "2026-01-02T00:00:00.000Z";

function createTempDbPath(): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
  return mkdtemp(path.join(os.tmpdir(), "withmate-mate-growth-storage-")).then((tmpDir) => ({
    dbPath: path.join(tmpDir, "withmate-v4.db"),
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  }));
}

function seedCurrentMateProfile(dbPath: string): void {
  const now = BASE_TIME;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO mate_profile (
        id,
        state,
        display_name,
        description,
        theme_main,
        theme_sub,
        avatar_file_path,
        avatar_sha256,
        avatar_byte_size,
        profile_generation,
        created_at,
        updated_at
      ) VALUES ('current', 'active', 'current', '', '#6f8cff', '#6fb8c7', '', '', 0, 1, ?, ?)
    `).run(now, now);
  } finally {
    db.close();
  }
}

function seedProfileRevision(dbPath: string, revisionId: string): void {
  const now = BASE_TIME;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO mate_profile_revisions (
        id,
        mate_id,
        seq,
        parent_revision_id,
        status,
        kind,
        source_growth_event_id,
        summary,
        snapshot_dir_path,
        created_by,
        created_at,
        ready_at,
        failed_at,
        reverted_by_revision_id
      ) VALUES (?, 'current', 1, NULL, 'ready', 'growth_apply', NULL, 'revision', '', 'system', ?, ?, NULL, NULL)
    `).run(revisionId, now, now);
  } finally {
    db.close();
  }
}

function buildRun(): MateGrowthRunInput {
  return {
    sourceType: "session",
    sourceSessionId: "session-1",
    sourceAuditLogId: 321,
    triggerReason: "test-trigger",
    providerId: "copilot",
    model: "mock-1",
    reasoningEffort: "low",
    inputHash: "input-hash",
  };
}

function seedProfileItem(dbPath: string, id: string): void {
  const now = BASE_TIME;
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO mate_profile_items (
        id,
        mate_id,
        section_key,
        category,
        claim_key,
        claim_value,
        claim_value_normalized,
        rendered_text,
        normalized_claim,
        confidence,
        salience_score,
        state,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      ) VALUES (?, 'current', 'core', 'preference', ?, ?, ?, ?, ?, 80, 80, 'active', ?, ?, ?, ?)
    `).run(id, `${id}-claim`, id, id, id, now, now, now, now, now);
  } finally {
    db.close();
  }
}

function buildEvent(input: Partial<MateGrowthEventInput> = {}): MateGrowthEventInput {
  return {
    sourceType: "session",
    growthSourceType: "assistant_inference",
    kind: "observation",
    targetSection: "core",
    statement: "テストイベント",
    confidence: 75,
    salienceScore: 62,
    projectionAllowed: true,
    ...input,
  };
}

function listStates(dbPath: string): Array<{ id: string; state: string; source_growth_run_id: number | null }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`
      SELECT id, state, source_growth_run_id
      FROM mate_growth_events
      ORDER BY id
    `).all() as Array<{ id: string; state: string; source_growth_run_id: number | null }>;
  } finally {
    db.close();
  }
}

function buildCursorInput(overrides: Partial<{
  cursorKey: "extraction_cursor" | "consolidation_cursor" | "applied_event_watermark" | "project_digest_cursor";
  scopeType: "global" | "session" | "companion" | "project";
  scopeId: string | null;
  lastMessageId: string;
  lastAuditLogId: number | null;
  lastGrowthEventId: string;
  lastProfileGeneration: number;
  contentFingerprint: string;
  updatedByRunId: number | null;
}> = {}): {
  cursorKey: "extraction_cursor" | "consolidation_cursor" | "applied_event_watermark" | "project_digest_cursor";
  scopeType: "global" | "session" | "companion" | "project";
  scopeId?: string | null;
  lastMessageId: string;
  lastAuditLogId: number | null;
  lastGrowthEventId: string;
  lastProfileGeneration: number;
  contentFingerprint: string;
  updatedByRunId: number | null;
} {
  return {
    cursorKey: "extraction_cursor",
    scopeType: "session",
    scopeId: "session-1",
    lastMessageId: "m-1",
    lastAuditLogId: 100,
    lastGrowthEventId: "g-1",
    lastProfileGeneration: 1,
    contentFingerprint: "fingerprint-1",
    updatedByRunId: null,
    ...overrides,
  };
}

describe("MateGrowthStorage", () => {
  it("getCursor は存在しないとき null を返す", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const cursor = storage.getCursor({
        cursorKey: "extraction_cursor",
        scopeType: "session",
        scopeId: "session-missing",
      });
      assert.equal(cursor, null);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("getCursor / upsertCursor は cursorKey / scope の validation を行う", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      assert.throws(() => {
        storage.getCursor({
          cursorKey: "invalid_key" as unknown as "extraction_cursor",
          scopeType: "global",
        });
      }, /不正です/);

      assert.throws(() => {
        storage.getCursor({
          cursorKey: "extraction_cursor",
          scopeType: "unknown" as unknown as "global",
        });
      }, /不正です/);

      assert.throws(() => {
        storage.upsertCursor({
          ...(buildCursorInput({
            scopeType: "session",
            scopeId: "  ",
          })),
        });
      }, /空/);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("global は scopeId が '' に正規化される", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      storage.upsertCursor({
        cursorKey: "consolidation_cursor",
        scopeType: "global",
        scopeId: "should-be-ignored",
        lastMessageId: "msg-1",
        lastAuditLogId: 1,
        lastGrowthEventId: "growth-1",
        lastProfileGeneration: 1,
        contentFingerprint: "cursor-fp",
      });

      const cursor = storage.getCursor({
        cursorKey: "consolidation_cursor",
        scopeType: "global",
        scopeId: "",
      });

      assert.equal(cursor?.scopeId, "");
      assert.equal(cursor?.lastMessageId, "msg-1");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertCursor は insert / update を返し、必要項目を正規化できる", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      const created = storage.upsertCursor(buildCursorInput({
        scopeId: "  session-1  ",
        lastMessageId: "  msg-1  ",
        lastGrowthEventId: "  growth-1  ",
        contentFingerprint: "  fp  ",
      }));

      assert.equal(created.scopeId, "session-1");
      assert.equal(created.lastMessageId, "msg-1");
      assert.equal(created.lastGrowthEventId, "growth-1");
      assert.equal(created.contentFingerprint, "fp");

      const updated = storage.upsertCursor(buildCursorInput({
        scopeId: "session-1",
        lastMessageId: "msg-2",
        lastAuditLogId: 200,
        lastGrowthEventId: "growth-2",
        lastProfileGeneration: 5,
        contentFingerprint: "fp-2",
      }));

      assert.equal(updated.lastMessageId, "msg-2");
      assert.equal(updated.lastAuditLogId, 200);
      assert.equal(updated.lastProfileGeneration, 5);
      assert.equal(updated.lastGrowthEventId, "growth-2");
      assert.equal(updated.contentFingerprint, "fp-2");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertCursorIfCurrent は一致時に更新し、mismatch 時は advanced=false を返す", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      storage.upsertCursor(buildCursorInput());

      const success = storage.upsertCursorIfCurrent({
        ...buildCursorInput(),
        lastMessageId: "msg-2",
        expectedContentFingerprint: "fingerprint-1",
        expectedLastAuditLogId: 100,
        expectedLastGrowthEventId: "g-1",
      });

      assert.equal(success.advanced, true);
      assert.equal(success.cursor?.lastMessageId, "msg-2");

      const failure = storage.upsertCursorIfCurrent({
        ...buildCursorInput(),
        lastMessageId: "msg-3",
        expectedContentFingerprint: "wrong-fingerprint",
      });

      assert.equal(failure.advanced, false);
      assert.equal(failure.cursor?.lastMessageId, "msg-2");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("advanceCursor は expected checkpoint なしでは更新しない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      storage.upsertCursor(buildCursorInput());

      assert.throws(() => {
        storage.advanceCursor({
          ...buildCursorInput({
            lastMessageId: "msg-without-checkpoint",
            contentFingerprint: "unchecked",
          }),
        });
      }, /expected checkpoint/);

      const cursor = storage.getCursor({
        cursorKey: "extraction_cursor",
        scopeType: "session",
        scopeId: "session-1",
      });
      assert.equal(cursor?.lastMessageId, "m-1");
      assert.equal(cursor?.contentFingerprint, "fingerprint-1");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("cursor の lastAuditLogId と expectedLastAuditLogId は負数を拒否する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      assert.throws(() => {
        storage.upsertCursor(buildCursorInput({ lastAuditLogId: -1 }));
      }, /lastAuditLogId は 0 以上/);

      storage.upsertCursor(buildCursorInput());
      assert.throws(() => {
        storage.advanceCursor({
          ...buildCursorInput(),
          expectedLastAuditLogId: -1,
        });
      }, /expectedLastAuditLogId は 0 以上/);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertCursor は lastAuditLogId と lastProfileGeneration の後退時に cursor 全体を更新しない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      storage.upsertCursor(buildCursorInput());

      const afterStale = storage.upsertCursor(buildCursorInput({
        lastAuditLogId: 20,
        lastProfileGeneration: 1,
        lastMessageId: "stale-message",
        lastGrowthEventId: "stale-growth",
        contentFingerprint: "stale-fingerprint",
      }));

      const afterStale2 = storage.upsertCursor(buildCursorInput({
        lastAuditLogId: 10,
        lastProfileGeneration: 0,
        contentFingerprint: "fingerprint-2",
      }));

      assert.equal(afterStale.lastAuditLogId, 100);
      assert.equal(afterStale.lastProfileGeneration, 1);
      assert.equal(afterStale.lastMessageId, "m-1");
      assert.equal(afterStale.lastGrowthEventId, "g-1");
      assert.equal(afterStale.contentFingerprint, "fingerprint-1");
      assert.equal(afterStale2.lastAuditLogId, 100);
      assert.equal(afterStale2.lastProfileGeneration, 1);
      assert.equal(afterStale2.contentFingerprint, "fingerprint-1");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertCursorIfCurrent は一致していても counter 後退なら advanced=false で更新しない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      storage.upsertCursor(buildCursorInput());

      const stale = storage.upsertCursorIfCurrent({
        ...buildCursorInput({
          lastAuditLogId: 99,
          lastGrowthEventId: "stale-growth",
          contentFingerprint: "stale-fingerprint",
        }),
        expectedContentFingerprint: "fingerprint-1",
        expectedLastAuditLogId: 100,
        expectedLastGrowthEventId: "g-1",
      });

      assert.equal(stale.advanced, false);
      assert.equal(stale.cursor?.lastAuditLogId, 100);
      assert.equal(stale.cursor?.lastGrowthEventId, "g-1");
      assert.equal(stale.cursor?.contentFingerprint, "fingerprint-1");
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertCursor は run の FK を満たす updatedByRunId を保存でき、null も許容する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const runId = storage.createRun(buildRun());

      const withRun = storage.upsertCursor({
        ...buildCursorInput({
          scopeType: "project",
          scopeId: "project-1",
          updatedByRunId: runId,
        }),
        cursorKey: "project_digest_cursor",
        lastMessageId: "msg-1",
      });

      assert.equal(withRun.updatedByRunId, runId);
      const fallback = storage.upsertCursor({
        ...buildCursorInput({
          cursorKey: "project_digest_cursor",
          scopeType: "project",
          scopeId: "project-1",
          updatedByRunId: null,
        }),
      });
      assert.equal(fallback.updatedByRunId, null);

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare(`
          SELECT updated_by_run_id
          FROM mate_growth_cursors
          WHERE cursor_key = ? AND scope_type = ? AND scope_id = ?
        `).get("project_digest_cursor", "project", "project-1") as { updated_by_run_id: number | null };
        assert.equal(row.updated_by_run_id, null);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("createRun は run を追加でき、finishRun で completed に更新できる", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const runInput = buildRun();
      const runId = storage.createRun(runInput);
      seedProfileRevision(dbPath, "rev-1");

      const db = new DatabaseSync(dbPath);
      const runAfterCreate = db.prepare("SELECT status, source_type, trigger_reason FROM mate_growth_runs WHERE id = ?").get(
        runId,
      ) as {
        status: string;
        source_type: string;
        trigger_reason: string;
      };
      assert.equal(runAfterCreate.status, "queued");
      assert.equal(runAfterCreate.source_type, runInput.sourceType);
      assert.equal(runAfterCreate.trigger_reason, runInput.triggerReason);
      db.close();

      storage.finishRun(runId, {
        outputRevisionId: "rev-1",
        outputHash: "hash-1",
        appliedCount: 1,
        invalidCount: 0,
      });

      const db2 = new DatabaseSync(dbPath);
      try {
        const runAfterFinish = db2.prepare(`
          SELECT status, output_revision_id, output_hash, applied_count, invalid_count, finished_at, error_preview
          FROM mate_growth_runs WHERE id = ?
        `).get(runId) as {
          status: string;
          output_revision_id: string;
          output_hash: string;
          applied_count: number;
          invalid_count: number;
          finished_at: string;
          error_preview: string;
        };

        assert.equal(runAfterFinish.status, "completed");
        assert.equal(runAfterFinish.output_revision_id, "rev-1");
        assert.equal(runAfterFinish.output_hash, "hash-1");
        assert.equal(runAfterFinish.applied_count, 1);
        assert.equal(runAfterFinish.invalid_count, 0);
        assert.equal(typeof runAfterFinish.finished_at, "string");
        assert.equal(runAfterFinish.error_preview, "");
      } finally {
        db2.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("acquireGrowthApplyRun は同一 operation_id を同時利用時に lock を共有し、既存 run を再利用できる", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const first = storage.acquireGrowthApplyRun({
        operationId: "growth-apply:fingerprint-1",
        inputHash: "fingerprint-1",
        candidateCount: 3,
      });
      const second = storage.acquireGrowthApplyRun({
        operationId: "growth-apply:fingerprint-1",
        inputHash: "fingerprint-1",
        candidateCount: 3,
      });

      assert.equal(first.isOwner, true);
      assert.equal(second.isOwner, false);
      assert.equal(second.runId, first.runId);

      storage.markGrowthApplyRunApplying(first.runId);
      storage.finishRun(first.runId, {
        appliedCount: 2,
        invalidCount: 1,
      });

      const run = storage.getGrowthApplyRunByOperationId("growth-apply:fingerprint-1");
      assert.equal(run?.id, first.runId);
      assert.equal(run?.status, "completed");
      assert.equal(run?.candidateCount, 3);
      assert.equal(run?.appliedCount, 2);
      assert.equal(run?.outputRevisionId, null);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("acquireGrowthApplyRun は failed の同一 operationId を owner として再取得する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const operationId = "growth-apply:reset-failed";
      const first = storage.acquireGrowthApplyRun({
        operationId,
        inputHash: "input-fingerprint-1",
        candidateCount: 1,
      });

      storage.failRun(first.runId, "temporary failure");

      const second = storage.acquireGrowthApplyRun({
        operationId,
        inputHash: "input-fingerprint-2",
        candidateCount: 3,
      });
      assert.equal(second.isOwner, true);
      assert.equal(second.runId, first.runId);

      const db = new DatabaseSync(dbPath);
      try {
        const runRow = db.prepare("SELECT input_hash, status, candidate_count FROM mate_growth_runs WHERE id = ?")
          .get(second.runId) as {
            input_hash: string;
            status: string;
            candidate_count: number;
          };

        assert.equal(runRow.input_hash, "input-fingerprint-2");
        assert.equal(runRow.status, "queued");
        assert.equal(runRow.candidate_count, 3);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("acquireGrowthApplyRun は別 operation の active growth-apply があるときエラーで拒否する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const active = storage.acquireGrowthApplyRun({
        operationId: "growth-apply:active-a",
        inputHash: "fingerprint-active-a",
        candidateCount: 1,
      });
      storage.markGrowthApplyRunApplying(active.runId);

      assert.throws(() => {
        storage.acquireGrowthApplyRun({
          operationId: "growth-apply:active-b",
          inputHash: "fingerprint-active-b",
          candidateCount: 2,
        });
      }, /Growth apply はすでに実行中です。/);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("cleanupStaleGrowthApplyRuns は古い queued / applying の growth-apply run を failed 化する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      const oldQueuedRunId = storage.createRun({
        ...buildRun(),
        operationId: "growth-apply:queued",
        inputHash: "old-queued",
        candidateCount: 1,
      });
      const oldApplyingRunId = storage.createRun({
        ...buildRun(),
        operationId: "growth-apply:applying",
        inputHash: "old-applying",
        candidateCount: 2,
      });
      storage.markGrowthApplyRunApplying(oldApplyingRunId);

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_runs SET started_at = ? WHERE id IN (?, ?)").run(
          "2026-01-01T00:00:00.000Z",
          oldQueuedRunId,
          oldApplyingRunId,
        );
      } finally {
        db.close();
      }

      const updated = storage.cleanupStaleGrowthApplyRuns({
        staleBeforeIso: "2026-01-02T00:00:00.000Z",
        errorPreview: "stale",
      });
      assert.equal(updated, 2);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const rows = dbAfter.prepare(`
          SELECT id, status, error_preview, finished_at
          FROM mate_growth_runs
          WHERE id IN (?, ?)
          ORDER BY id
        `).all(oldQueuedRunId, oldApplyingRunId) as Array<{
          id: number;
          status: string;
          error_preview: string;
          finished_at: string | null;
        }>;

        const sorted = rows.sort((a, b) => a.id - b.id);
        assert.equal(sorted[0].status, "failed");
        assert.equal(sorted[0].error_preview, "stale");
        assert.equal(typeof sorted[0].finished_at, "string");
        assert.equal(sorted[1].status, "failed");
        assert.equal(sorted[1].error_preview, "stale");
        assert.equal(typeof sorted[1].finished_at, "string");
      } finally {
        dbAfter.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("cleanupStaleGrowthApplyRuns は新しい growth-apply active run を対象外にする", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      const activeRunId = storage.createRun({
        ...buildRun(),
        operationId: "growth-apply:active",
        inputHash: "active",
        candidateCount: 1,
      });
      storage.markGrowthApplyRunApplying(activeRunId);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_runs SET started_at = ? WHERE id = ?").run("2026-01-04T00:00:00.000Z", activeRunId);
      } finally {
        db.close();
      }

      const updated = storage.cleanupStaleGrowthApplyRuns({
        staleBeforeIso: "2026-01-03T00:00:00.000Z",
        errorPreview: "ignored",
      });
      assert.equal(updated, 0);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const row = dbAfter.prepare("SELECT status FROM mate_growth_runs WHERE id = ?").get(activeRunId) as {
          status: string;
        };
        assert.equal(row.status, "applying");
      } finally {
        dbAfter.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("cleanupStaleGrowthApplyRuns は非 growth-apply active run を対象外にする", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);

      const nonGrowthApplyRunId = storage.createRun({
        ...buildRun(),
        operationId: "analysis-run:active",
        inputHash: "analysis-active",
        candidateCount: 1,
      });
      storage.markGrowthApplyRunApplying(nonGrowthApplyRunId);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_runs SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", nonGrowthApplyRunId);
      } finally {
        db.close();
      }

      const updated = storage.cleanupStaleGrowthApplyRuns({
        staleBeforeIso: "2026-01-03T00:00:00.000Z",
      });
      assert.equal(updated, 0);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const row = dbAfter.prepare("SELECT status, operation_id FROM mate_growth_runs WHERE id = ?").get(
          nonGrowthApplyRunId,
        ) as {
          status: string;
          operation_id: string;
        };
        assert.equal(row.operation_id, "analysis-run:active");
        assert.equal(row.status, "applying");
      } finally {
        dbAfter.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("cleanupStaleGrowthApplyRuns 後、同一 operationId が owner として再取得できる", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const staleRunId = storage.createRun({
        ...buildRun(),
        operationId: "growth-apply:reacquire",
        inputHash: "reacquire-old",
        candidateCount: 1,
      });
      storage.markGrowthApplyRunApplying(staleRunId);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_runs SET started_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", staleRunId);
      } finally {
        db.close();
      }

      const cleaned = storage.cleanupStaleGrowthApplyRuns({
        staleBeforeIso: "2026-01-03T00:00:00.000Z",
        errorPreview: "stale-run-cleaned",
      });
      assert.equal(cleaned, 1);

      const reacquired = storage.acquireGrowthApplyRun({
        operationId: "growth-apply:reacquire",
        inputHash: "reacquire-new",
        candidateCount: 5,
      });
      assert.equal(reacquired.isOwner, true);
      assert.equal(reacquired.runId, staleRunId);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("failRun は run を failed 化し error_preview を保存する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const runId = storage.createRun(buildRun());
      storage.failRun(runId, "temporary error");

      const db = new DatabaseSync(dbPath);
      try {
        const row = db.prepare("SELECT status, error_preview, finished_at FROM mate_growth_runs WHERE id = ?").get(runId) as {
          status: string;
          error_preview: string;
          finished_at: string;
        };

        assert.equal(row.status, "failed");
        assert.equal(row.error_preview, "temporary error");
        assert.equal(typeof row.finished_at, "string");
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertEvent は id 指定なしでも同じ fingerprint なら同一 id を再利用する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const first = storage.upsertEvent(buildEvent({
        statement: "会話は要点を重視する",
        statementFingerprint: "fingerprint-1",
      }));
      const second = storage.upsertEvent(buildEvent({
        statement: "会話は要点を重視する（更新）",
        statementFingerprint: "fingerprint-1",
        confidence: 88,
      }));

      assert.equal(first.id, second.id);
      assert.equal(second.created, false);

      const db = new DatabaseSync(dbPath);
      try {
        const count = db.prepare("SELECT COUNT(*) AS count FROM mate_growth_events").get() as { count: number };
        const event = db.prepare("SELECT statement, confidence FROM mate_growth_events WHERE id = ?").get(first.id) as {
          statement: string;
          confidence: number;
        };
        assert.equal(count.count, 1);
        assert.equal(event.statement, "会話は要点を重視する（更新）");
        assert.equal(event.confidence, 88);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertEvent は forgotten の同一 fingerprint を復活させず新規候補として保存する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const first = storage.upsertEvent(buildEvent({
        id: "growth-forgotten-original",
        statement: "復活させない Growth",
        statementFingerprint: "growth-fingerprint-no-revive",
      }));

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_events SET state = 'forgotten', forgotten_at = ?, updated_at = ? WHERE id = ?").run(
          "2026-01-03T00:00:00.000Z",
          "2026-01-03T00:00:00.000Z",
          first.id,
        );
      } finally {
        db.close();
      }

      const second = storage.upsertEvent(buildEvent({
        id: "growth-forgotten-regenerated",
        statement: "復活させない Growth",
        statementFingerprint: "growth-fingerprint-no-revive",
      }));

      assert.notEqual(first.id, second.id);
      assert.equal(second.created, true);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const rows = dbAfter.prepare(`
          SELECT id, state
          FROM mate_growth_events
          WHERE statement_fingerprint = ?
          ORDER BY id
        `).all("growth-fingerprint-no-revive") as Array<{ id: string; state: string }>;
        assert.deepEqual(rows.map((row) => ({ ...row })), [{
          id: "growth-forgotten-original",
          state: "forgotten",
        }, {
          id: "growth-forgotten-regenerated",
          state: "candidate",
        }]);
      } finally {
        dbAfter.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertEvent は forgotten event id を指定されても復活させない", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const first = storage.upsertEvent(buildEvent({
        id: "growth-forgotten-by-id",
        statement: "id 復活させない Growth",
        statementFingerprint: "growth-fingerprint-forgotten-id",
      }));

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE mate_growth_events SET state = 'forgotten', forgotten_at = ?, updated_at = ? WHERE id = ?").run(
          "2026-01-03T00:00:00.000Z",
          "2026-01-03T00:00:00.000Z",
          first.id,
        );
      } finally {
        db.close();
      }

      const second = storage.upsertEvent(buildEvent({
        id: first.id,
        statement: "id 復活させない Growth updated",
        statementFingerprint: "growth-fingerprint-forgotten-id",
      }));

      assert.equal(second.id, first.id);
      assert.equal(second.created, false);
      assert.equal(second.state, "forgotten");

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const row = dbAfter.prepare("SELECT statement, state FROM mate_growth_events WHERE id = ?").get(first.id) as {
          statement: string;
          state: string;
        };
        assert.equal(row.statement, "id 復活させない Growth");
        assert.equal(row.state, "forgotten");
      } finally {
        dbAfter.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertEvent は relatedRefs / supersedesRefs を event link として保存し更新時に差し替える", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      storage.upsertEvent(buildEvent({
        id: "event-related",
        statement: "関連先",
        statementFingerprint: "fingerprint-related",
      }));
      storage.upsertEvent(buildEvent({
        id: "event-superseded",
        statement: "上書き対象",
        statementFingerprint: "fingerprint-superseded",
      }));
      storage.upsertEvent(buildEvent({
        id: "event-next",
        statement: "次の関連先",
        statementFingerprint: "fingerprint-next",
      }));

      storage.upsertEvent(buildEvent({
        id: "event-source",
        statement: "ユーザーは短い報告を好む",
        statementFingerprint: "fingerprint-source",
        relation: "updates",
        relatedRefs: ["event-related", "event-related", "event-source", "event-missing"],
        supersedesRefs: ["event-superseded"],
      }));

      const db = new DatabaseSync(dbPath);
      try {
        const links = db.prepare(`
          SELECT source_growth_event_id, target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'event-source'
          ORDER BY target_growth_event_id, link_type
        `).all() as Array<{ source_growth_event_id: string; target_growth_event_id: string; link_type: string }>;

        assert.deepEqual(links.map((link) => ({ ...link })), [{
          source_growth_event_id: "event-source",
          target_growth_event_id: "event-related",
          link_type: "updates",
        }, {
          source_growth_event_id: "event-source",
          target_growth_event_id: "event-superseded",
          link_type: "supersedes",
        }]);
      } finally {
        db.close();
      }

      storage.upsertEvent(buildEvent({
        id: "event-source",
        statement: "ユーザーは短い報告を好む（更新）",
        statementFingerprint: "fingerprint-source",
        relation: "reinforces",
        relatedRefs: ["event-next"],
      }));

      const db2 = new DatabaseSync(dbPath);
      try {
        const links = db2.prepare(`
          SELECT source_growth_event_id, target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'event-source'
          ORDER BY target_growth_event_id, link_type
        `).all() as Array<{ source_growth_event_id: string; target_growth_event_id: string; link_type: string }>;

        assert.deepEqual(links.map((link) => ({ ...link })), [{
          source_growth_event_id: "event-source",
          target_growth_event_id: "event-next",
          link_type: "reinforces",
        }]);
      } finally {
        db2.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("upsertEvent は profile_item refs を profile item link に保存し、未知 profile item を無視する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      seedProfileItem(dbPath, "profile-1");
      seedProfileItem(dbPath, "profile-2");
      storage.upsertEvent(buildEvent({
        id: "growth-related",
        statement: "関連先イベント",
        statementFingerprint: "fingerprint-related",
      }));

      storage.upsertEvent(buildEvent({
        id: "growth-source",
        statement: "profile item を参照するイベント",
        statementFingerprint: "fingerprint-source",
        relation: "updates",
        relatedRefs: [
          { type: "memory", id: "growth-related" },
          { type: "profile_item", id: "profile-1" },
          { type: "profile_item", id: "missing" },
          { type: "memory", id: "growth-source" },
        ],
        supersedesRefs: [
          { type: "profile_item", id: "profile-2" },
        ],
      }));

      const db = new DatabaseSync(dbPath);
      try {
        const memoryLinks = db.prepare(`
          SELECT source_growth_event_id, target_growth_event_id, link_type
          FROM mate_growth_event_links
          WHERE source_growth_event_id = 'growth-source'
          ORDER BY target_growth_event_id, link_type
        `).all() as Array<{ source_growth_event_id: string; target_growth_event_id: string; link_type: string }>;

        const profileLinks = db.prepare(`
          SELECT growth_event_id, profile_item_id, link_type
          FROM mate_growth_event_profile_item_links
          WHERE growth_event_id = 'growth-source'
          ORDER BY profile_item_id, link_type
        `).all() as Array<{ growth_event_id: string; profile_item_id: string; link_type: string }>;

        assert.deepEqual(memoryLinks.map((link) => ({ ...link })), [{
          source_growth_event_id: "growth-source",
          target_growth_event_id: "growth-related",
          link_type: "updates",
        }]);
        assert.deepEqual(profileLinks.map((link) => ({ ...link })), [{
          growth_event_id: "growth-source",
          profile_item_id: "profile-1",
          link_type: "updates",
        }, {
          growth_event_id: "growth-source",
          profile_item_id: "profile-2",
          link_type: "supersedes",
        }]);
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("listPendingEvents は candidate のみ列挙し、runId で絞り込める", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const runIdA = storage.createRun(buildRun());
      const runIdB = storage.createRun({
        ...buildRun(),
        sourceSessionId: "session-2",
        triggerReason: "another-trigger",
      });

      const eventA = storage.upsertEvent(buildEvent({
        id: "event-a",
        sourceGrowthRunId: runIdA,
        statement: "A candidate",
        statementFingerprint: "fingerprint-a",
      }));
      storage.upsertEvent(buildEvent({
        sourceGrowthRunId: runIdB,
        statement: "B candidate",
        statementFingerprint: "fingerprint-b",
      }));
      storage.markEventApplied(eventA.id, "rev-event-a");

      const pendingAll = storage.listPendingEvents();
      const pendingA = storage.listPendingEvents({ runId: runIdA });
      const pendingB = storage.listPendingEvents({ runId: runIdB, limit: 1 });

      assert.equal(pendingAll.length, 1);
      assert.equal(pendingAll[0].statement, "B candidate");
      assert.equal(pendingA.length, 0);

      assert.equal(pendingB.length, 1);
      assert.equal(pendingB[0].sourceGrowthRunId, runIdB);
    } finally {
      storage.close();
      await cleanup();
    }
  });

  it("markEventApplied / markEventSkipped はそれぞれ state を更新する", async () => {
    const { dbPath, cleanup } = await createTempDbPath();
    const storage = new MateGrowthStorage(dbPath);
    try {
      seedCurrentMateProfile(dbPath);
      const applied = storage.upsertEvent(buildEvent({
        id: "event-applied",
        statement: "適用イベント",
        statementFingerprint: "f-applied",
      }));
      const skipped = storage.upsertEvent(buildEvent({
        id: "event-skipped",
        statement: "スキップイベント",
        statementFingerprint: "f-skipped",
      }));

      storage.markEventApplied(applied.id, "rev-applied");
      storage.markEventSkipped(skipped.id);

      const rows = listStates(dbPath);
      assert.equal(rows.find((row) => row.id === "event-applied")?.state, "applied");
      assert.equal(rows.find((row) => row.id === "event-applied")?.source_growth_run_id, null);
      assert.equal(rows.find((row) => row.id === "event-skipped")?.state, "disabled");

      const db = new DatabaseSync(dbPath);
      try {
        const skippedRow = db.prepare("SELECT disabled_at FROM mate_growth_events WHERE id = ?").get("event-skipped") as {
          disabled_at: string | null;
        };
        assert.equal(typeof skippedRow.disabled_at, "string");
      } finally {
        db.close();
      }
    } finally {
      storage.close();
      await cleanup();
    }
  });
});
