import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  CharacterAffectTurnSettlementStorage,
  hasCommittedAssistantMessage,
} from "../../src-electron/character-affect-turn-settlement-storage.js";
import { openAppDatabase } from "../../src-electron/sqlite-connection.js";

describe("CharacterAffectTurnSettlementStorage", () => {
  it("Session commit前のrowをready drainから隠し、前processの未準備rowだけstartup recoveryへ返す", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-ready-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const correlationId = "turn:session-a:audit:ready";
    try {
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      assert.deepEqual(storage.listReadyPending(), []);
      assert.equal(storage.listUnreadyPendingBefore("9999-12-31T23:59:59.999Z").length, 1);
      assert.equal(storage.listUnreadyPendingBefore("0000-01-01T00:00:00.000Z").length, 0);

      assert.deepEqual(storage.markReady(correlationId), { updated: true });
      assert.equal(storage.listReadyPending()[0]?.correlationId, correlationId);
      assert.notEqual(storage.listReadyPending()[0]?.readyAt, null);
      assert.deepEqual(storage.listUnreadyPendingBefore("9999-12-31T23:59:59.999Z"), []);
      assert.deepEqual(storage.markReady("missing-correlation"), { updated: false });
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pendingを再起動後も列挙し、settled後は会話payloadを除去する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-"));
    const dbPath = path.join(directory, "settlement.db");
    const input = {
      correlationId: "turn:session-a:audit:42",
      characterId: "character-a",
      sessionId: "session-a",
      userMessage: "A turn that must survive a crash.",
      assistantMessage: "A completed response.",
      assistantMessageIndex: 1,
      occurredAt: "2026-08-09T04:00:00.000Z",
    };
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    let db: ReturnType<typeof openAppDatabase> | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      assert.deepEqual(first.enqueue(input), { created: true });
      assert.deepEqual(first.enqueue(input), { created: false });
      assert.throws(() => first.enqueue({ ...input, assistantMessage: "different" }), /reused/);
      first.close();
      first = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      assert.deepEqual(recovered.listPending(), [{
        ...input,
        createdAt: recovered.listPending()[0]?.createdAt,
        readyAt: null,
        attemptCount: 0,
        evaluationAttempt: 0,
        evaluation: null,
        nextAttemptAt: null,
        attemptStartedAt: null,
        quarantinedAt: null,
        lastFailure: null,
      }]);
      recovered.markReady(input.correlationId);
      recovered.recordAttempt(input.correlationId);
      assert.equal(recovered.listPending()[0]?.attemptCount, 1);
      assert.equal(recovered.markSettled(input.correlationId, "2026-08-09T04:01:00.000Z"), true);
      assert.deepEqual(recovered.listPending(), []);
      recovered.close();
      recovered = null;

      db = openAppDatabase(dbPath);
      const row = db.prepare(`
        SELECT status, user_message, assistant_message, expected_version, candidates_json, settled_at
        FROM character_affect_turn_settlements
        WHERE correlation_id = ?
      `).get(input.correlationId) as Record<string, unknown>;
      assert.equal(row.status, "settled");
      assert.equal(row.user_message, "");
      assert.equal(row.assistant_message, "");
      assert.equal(row.expected_version, null);
      assert.equal(row.candidates_json, null);
      assert.equal(row.settled_at, "2026-08-09T04:01:00.000Z");
      db.close();
      db = null;
    } finally {
      db?.close();
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("candidate identityとeffect進捗を再起動後も保持し、同じkeyへの再割当てを拒否する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-candidate-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:99";
    const candidate = {
      schemaVersion: "withmate-affect-v1" as const,
      characterId: "character-a",
      userId: "local-user",
      sessionId: "session-a",
      layer: "session" as const,
      targetType: "task" as const,
      targetId: "current-task",
      family: "interest" as const,
      value: { label: "interest", valence: 0.4 },
      intensity: 0.5,
      reason: "persist candidate identity",
      evidence: "storage contract test",
      occurredAt: "2026-08-09T04:00:00.000Z",
      idempotencyKey: `${correlationId}:0`,
    };
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    let migrationDb: ReturnType<typeof openAppDatabase> | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      first.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      assert.deepEqual(first.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "v1",
        candidates: [candidate],
      }), { created: true });
      first.recordAppraisalFailure({
        correlationId,
        evaluationAttempt: 0,
        effect: "unknown",
        savedCandidateIndices: [],
        prepareReevaluation: false,
      });
      first.close();
      first = null;

      migrationDb = openAppDatabase(dbPath);
      migrationDb.exec("ALTER TABLE character_affect_turn_settlements DROP COLUMN observed_effects_json");
      migrationDb.close();
      migrationDb = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const pending = recovered.getPending(correlationId);
      assert.equal(pending?.evaluation?.lastEffect, "unknown");
      assert.deepEqual(pending?.evaluation?.observedEffects, ["unknown"]);
      assert.deepEqual(pending?.evaluation?.candidates, [candidate]);
      assert.deepEqual(recovered.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "v1",
        candidates: [candidate],
      }), { created: false });
      assert.throws(() => recovered!.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "v1",
        candidates: [{ ...candidate, reason: "different candidate" }],
      }), /cannot be reassigned/);
      recovered.recordAppraisalFailure({
        correlationId,
        evaluationAttempt: 0,
        effect: "partial",
        savedCandidateIndices: [0],
        prepareReevaluation: false,
      });
      assert.deepEqual(recovered.recordAppraisalFailure({
        correlationId,
        evaluationAttempt: 0,
        effect: "none",
        savedCandidateIndices: [],
        prepareReevaluation: true,
      }), { reevaluationPrepared: false });
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.observedEffects, ["unknown", "partial", "none"]);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.savedCandidateIndices, [0]);
      assert.equal(recovered.getPending(correlationId)?.evaluationAttempt, 0);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.candidates, [candidate]);
    } finally {
      migrationDb?.close();
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retry generationへ進んだ後は遅延した旧generationのcandidate保存を拒否する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-stale-generation-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:stale-generation";
    const initialCandidate = {
      schemaVersion: "withmate-affect-v1" as const,
      characterId: "character-a",
      userId: "local-user",
      sessionId: "session-a",
      layer: "session" as const,
      targetType: "task" as const,
      targetId: "current-task",
      family: "interest" as const,
      value: { label: "interest", valence: 0.4 },
      intensity: 0.5,
      reason: "initial generation",
      evidence: "storage contract test",
      occurredAt: "2026-08-09T04:00:00.000Z",
      idempotencyKey: `${correlationId}:0`,
    };
    const storage = new CharacterAffectTurnSettlementStorage(dbPath);
    try {
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "v1",
        candidates: [initialCandidate],
      });
      assert.deepEqual(storage.recordAppraisalFailure({
        correlationId,
        evaluationAttempt: 0,
        effect: "none",
        savedCandidateIndices: [],
        prepareReevaluation: true,
      }), { reevaluationPrepared: true });

      assert.throws(() => storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "v-stale",
        candidates: [{ ...initialCandidate, reason: "late stale evaluation" }],
      }), /generation is stale/);
      const nextCandidate = {
        ...initialCandidate,
        reason: "next generation",
        idempotencyKey: `${correlationId}:evaluation:1:0`,
      };
      assert.deepEqual(storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 1,
        expectedVersion: "v2",
        candidates: [nextCandidate],
      }), { created: true });
      assert.deepEqual(storage.getPending(correlationId)?.evaluation?.candidates, [nextCandidate]);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("commit markerで未保存turnを除外し、100件を超えるpendingをcursorで列挙する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-page-"));
    const dbPath = path.join(directory, "settlement.db");
    let storage: CharacterAffectTurnSettlementStorage | null = null;
    try {
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      for (let index = 0; index < 105; index += 1) {
        storage.enqueue({
          correlationId: `turn:session-a:audit:${String(index).padStart(3, "0")}`,
          characterId: "character-a",
          sessionId: "session-a",
          userMessage: `user-${index}`,
          assistantMessage: `assistant-${index}`,
          assistantMessageIndex: index * 2 + 1,
          occurredAt: "2026-08-09T04:00:00.000Z",
        });
      }
      const firstPage = storage.listPending(100);
      const secondPage = storage.listPending(100, firstPage.at(-1));
      assert.equal(firstPage.length, 100);
      assert.equal(secondPage.length, 5);
      assert.equal(new Set([...firstPage, ...secondPage].map((item) => item.correlationId)).size, 105);

      const pending = firstPage[0]!;
      assert.equal(hasCommittedAssistantMessage([], pending), false);
      assert.equal(hasCommittedAssistantMessage([
        { role: "user", text: "user-0" },
        { role: "assistant", text: "assistant-0" },
      ], { ...pending, assistantMessageIndex: 1 }), true);
      assert.equal(storage.markDiscarded(pending.correlationId), true);
      assert.equal(storage.listPending(1)[0]?.correlationId, firstPage[1]?.correlationId);
    } finally {
      storage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retryable failureを項目単位の永続backoffへ移し、8回目で本文を保持したまま隔離する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-backoff-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:bounded-retry";
    let storage: CharacterAffectTurnSettlementStorage | null = null;
    try {
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "payload retained for recovery",
        assistantMessage: "assistant payload retained for recovery",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-14T00:00:00.000Z",
      });
      storage.markReady(correlationId);

      assert.equal(storage.recordAttempt(correlationId, "2026-08-14T00:00:00.000Z"), 1);
      const first = storage.recordFailure({
        correlationId,
        retryable: true,
        observedAt: "2026-08-14T00:00:00.000Z",
        diagnostic: {
          code: "provider_timeout",
          stage: "evaluation",
          errorName: "AbortError",
          safeMessage: "Character affect turn evaluation failed with provider_timeout.",
          durationMs: 15_000,
        },
      });
      assert.deepEqual(first, {
        attemptCount: 1,
        state: "deferred",
        nextAttemptAt: "2026-08-14T00:01:00.000Z",
        quarantinedAt: null,
      });
      assert.deepEqual(storage.listDueReadyPending("2026-08-14T00:00:59.999Z"), []);
      assert.equal(storage.listDueReadyPending("2026-08-14T00:01:00.000Z")[0]?.correlationId, correlationId);
      storage.close();
      storage = new CharacterAffectTurnSettlementStorage(dbPath);

      for (let attempt = 2; attempt <= 8; attempt += 1) {
        const observedAt = `2026-08-${String(14 + attempt).padStart(2, "0")}T00:00:00.000Z`;
        assert.equal(storage.recordAttempt(correlationId, observedAt), attempt);
        const disposition = storage.recordFailure({
          correlationId,
          retryable: true,
          observedAt,
          diagnostic: {
            code: "provider_timeout",
            stage: "evaluation",
            errorName: "AbortError",
            safeMessage: "Character affect turn evaluation failed with provider_timeout.",
            durationMs: 15_000,
          },
        });
        assert.equal(disposition.state, attempt === 8 ? "quarantined" : "deferred");
      }

      const quarantined = storage.listQuarantined()[0];
      assert.equal(quarantined?.correlationId, correlationId);
      assert.equal(quarantined?.attemptCount, 8);
      assert.equal(quarantined?.userMessage, "payload retained for recovery");
      assert.equal(quarantined?.lastFailure?.stage, "evaluation");
      assert.equal(storage.hasRecoverablePending(), false);
      assert.deepEqual(storage.listDueReadyPending("9999-12-31T23:59:59.999Z"), []);

      assert.equal(storage.releaseQuarantined(correlationId), true);
      const released = storage.getPending(correlationId);
      assert.equal(released?.attemptCount, 0);
      assert.equal(released?.quarantinedAt, null);
      assert.equal(released?.lastFailure, null);
      assert.equal(storage.hasRecoverablePending(), true);
    } finally {
      storage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("同一itemのattemptをatomicに一つだけclaimし、中断した8回目を再起動時にprovider実行前隔離する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-claim-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:atomic-claim";
    let storage: CharacterAffectTurnSettlementStorage | null = null;
    try {
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "payload retained for recovery",
        assistantMessage: "assistant payload retained for recovery",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-14T00:00:00.000Z",
      });
      storage.markReady(correlationId);

      for (let attempt = 1; attempt <= 7; attempt += 1) {
        const observedAt = `2026-08-14T${String(attempt).padStart(2, "0")}:00:00.000Z`;
        assert.equal(storage.recordAttempt(correlationId, observedAt), attempt);
        assert.equal(storage.recordAttempt(correlationId, observedAt), null);
        storage.recordFailure({
          correlationId,
          retryable: true,
          observedAt,
          diagnostic: {
            code: "provider_timeout",
            stage: "evaluation",
            errorName: "AbortError",
            safeMessage: "Character affect turn evaluation failed with provider_timeout.",
            durationMs: 15_000,
          },
        });
      }

      assert.equal(storage.recordAttempt(correlationId, "2026-08-15T00:00:00.000Z"), 8);
      assert.equal(storage.recordAttempt(correlationId, "2026-08-15T00:00:00.000Z"), null);
      storage.close();
      storage = new CharacterAffectTurnSettlementStorage(dbPath);

      const quarantined = storage.listQuarantined()[0];
      assert.equal(quarantined?.correlationId, correlationId);
      assert.equal(quarantined?.attemptCount, 8);
      assert.equal(quarantined?.attemptStartedAt, null);
      assert.equal(quarantined?.lastFailure?.code, "attempt_limit_exceeded");
      assert.equal(storage.recordAttempt(correlationId, "9999-12-31T23:59:59.999Z"), null);
      assert.deepEqual(storage.listDueReadyPending("9999-12-31T23:59:59.999Z"), []);
    } finally {
      storage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("non-retryable failureを初回で隔離し、旧schemaへretry metadataを非破壊追加する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-migration-"));
    const dbPath = path.join(directory, "settlement.db");
    let db: ReturnType<typeof openAppDatabase> | null = null;
    let storage: CharacterAffectTurnSettlementStorage | null = null;
    try {
      db = openAppDatabase(dbPath);
      db.exec(`
        CREATE TABLE character_affect_turn_settlements (
          correlation_id TEXT PRIMARY KEY,
          character_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          user_message TEXT NOT NULL,
          assistant_message TEXT NOT NULL,
          assistant_message_index INTEGER NOT NULL,
          occurred_at TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'settled')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          ready_at TEXT,
          evaluation_attempt INTEGER NOT NULL DEFAULT 0,
          expected_version TEXT,
          candidates_json TEXT,
          last_effect TEXT NOT NULL DEFAULT 'none',
          observed_effects_json TEXT NOT NULL DEFAULT '[]',
          saved_candidate_indices_json TEXT NOT NULL DEFAULT '[]',
          settled_at TEXT
        )
      `);
      db.close();
      db = null;

      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      storage.enqueue({
        correlationId: "non-retryable",
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-14T00:00:00.000Z",
      });
      storage.markReady("non-retryable");
      storage.recordAttempt("non-retryable", "2026-08-14T00:00:00.000Z");
      const disposition = storage.recordFailure({
        correlationId: "non-retryable",
        retryable: false,
        observedAt: "2026-08-14T00:00:00.000Z",
        diagnostic: {
          code: "unknown_character",
          stage: "runtime",
          errorName: "CharacterContextError",
          safeMessage: "Character affect turn runtime failed with unknown_character.",
          durationMs: 0,
        },
      });
      assert.equal(disposition.state, "quarantined");
      assert.equal(storage.listQuarantined()[0]?.lastFailure?.code, "unknown_character");

      storage.enqueue({
        correlationId: "legacy-over-limit",
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "legacy payload retained",
        assistantMessage: "legacy assistant payload retained",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-14T00:00:00.000Z",
      });
      storage.markReady("legacy-over-limit");
      storage.close();
      storage = null;
      db = openAppDatabase(dbPath);
      db.prepare(`
        UPDATE character_affect_turn_settlements
        SET attempt_count = 508, attempt_started_at = NULL, quarantined_at = NULL
        WHERE correlation_id = 'legacy-over-limit'
      `).run();
      db.close();
      db = null;

      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      const legacyQuarantined = storage.listQuarantined().find(
        (item) => item.correlationId === "legacy-over-limit",
      );
      assert.equal(legacyQuarantined?.attemptCount, 508);
      assert.equal(legacyQuarantined?.lastFailure?.code, "attempt_limit_exceeded");
      assert.equal(legacyQuarantined?.userMessage, "legacy payload retained");
      assert.deepEqual(
        storage.listDueReadyPending("9999-12-31T23:59:59.999Z")
          .filter((item) => item.correlationId === "legacy-over-limit"),
        [],
      );
      assert.equal(storage.hasRecoverablePending(), false);
      assert.equal(storage.releaseQuarantined("legacy-over-limit"), true);
      assert.equal(storage.getPending("legacy-over-limit")?.attemptCount, 0);
      assert.equal(storage.getPending("legacy-over-limit")?.quarantinedAt, null);
    } finally {
      storage?.close();
      db?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("familyなしの永続pending評価を即時隔離し、明示release後だけ新世代へ再評価する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-family-migration-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:legacy-family";
    let storage = new CharacterAffectTurnSettlementStorage(dbPath);
    try {
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      storage.markReady(correlationId);
      storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "affect-v1-before-family",
        candidates: [{
          schemaVersion: "withmate-affect-v1",
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-a",
          layer: "session",
          targetType: "task",
          targetId: "current-task",
          family: "interest",
          value: { label: "legacy free label", valence: 0.4 },
          intensity: 0.5,
          reason: "legacy candidate",
          evidence: "migration test",
          occurredAt: "2026-08-09T04:00:00.000Z",
          idempotencyKey: `${correlationId}:0`,
        }],
      });
      storage.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          UPDATE character_affect_turn_settlements
          SET candidates_json = json_remove(candidates_json, '$[0].family')
          WHERE correlation_id = ?
        `).run(correlationId);
      } finally {
        db.close();
      }

      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      assert.equal(storage.listDueReadyPending("2026-08-10T00:00:00.000Z").length, 0);
      const quarantined = storage.listQuarantined();
      assert.equal(quarantined.length, 1);
      assert.equal(quarantined[0]?.evaluation, null);
      assert.equal(quarantined[0]?.lastFailure?.code, "affect_schema_version_rejected");
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const candidatesJson = (raw.prepare(`
          SELECT candidates_json AS candidatesJson
          FROM character_affect_turn_settlements WHERE correlation_id = ?
        `).get(correlationId) as { candidatesJson: string }).candidatesJson;
        assert.equal(JSON.parse(candidatesJson)[0].family, undefined);
      } finally {
        raw.close();
      }

      assert.equal(storage.releaseQuarantined(correlationId), true);
      const released = storage.getPending(correlationId);
      assert.equal(released?.evaluationAttempt, 1);
      assert.equal(released?.evaluation, null);
      storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 1,
        expectedVersion: "affect-v1-after-family",
        candidates: [{
          schemaVersion: "withmate-affect-v1",
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-a",
          layer: "session",
          targetType: "task",
          targetId: "current-task",
          family: "interest",
          value: { label: "classified", valence: 0.4 },
          intensity: 0.5,
          reason: "reevaluated candidate",
          evidence: "migration test",
          occurredAt: "2026-08-09T04:00:00.000Z",
          idempotencyKey: `${correlationId}:evaluation:1:0`,
        }],
      });
      assert.equal(storage.getPending(correlationId)?.evaluation?.candidates[0]?.family, "interest");
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("別理由で隔離済みのfamilyなしcandidateもrelease時に破棄して新世代へ進める", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settlement-family-release-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:legacy-family-quarantined";
    let storage = new CharacterAffectTurnSettlementStorage(dbPath);
    try {
      storage.enqueue({
        correlationId,
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "user",
        assistantMessage: "assistant",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-09T04:00:00.000Z",
      });
      storage.markReady(correlationId);
      storage.saveEvaluation({
        correlationId,
        evaluationAttempt: 0,
        expectedVersion: "affect-v1-before-family",
        candidates: [{
          schemaVersion: "withmate-affect-v1",
          characterId: "character-a",
          userId: "local-user",
          sessionId: "session-a",
          layer: "session",
          targetType: "task",
          targetId: "current-task",
          family: "interest",
          value: { label: "legacy free label", valence: 0.4 },
          intensity: 0.5,
          reason: "legacy candidate",
          evidence: "migration test",
          occurredAt: "2026-08-09T04:00:00.000Z",
          idempotencyKey: `${correlationId}:0`,
        }],
      });
      storage.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          UPDATE character_affect_turn_settlements
          SET candidates_json = json_remove(candidates_json, '$[0].family'),
              quarantined_at = '2026-08-09T05:00:00.000Z',
              last_failure_code = 'unknown_character',
              last_failure_stage = 'appraisal',
              last_error_name = 'Error',
              last_error_message = 'Stored failure',
              last_duration_ms = 1
          WHERE correlation_id = ?
        `).run(correlationId);
      } finally {
        db.close();
      }

      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      assert.equal(storage.listQuarantined()[0]?.lastFailure?.code, "unknown_character");
      assert.equal(storage.releaseQuarantined(correlationId), true);
      const released = storage.getPending(correlationId);
      assert.equal(released?.quarantinedAt, null);
      assert.equal(released?.evaluationAttempt, 1);
      assert.equal(released?.evaluation, null);
      storage.close();
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      assert.equal(storage.listQuarantined().length, 0);
      assert.equal(storage.getPending(correlationId)?.evaluationAttempt, 1);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
