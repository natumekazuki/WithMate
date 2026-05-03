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

describe("MateGrowthStorage", () => {
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
