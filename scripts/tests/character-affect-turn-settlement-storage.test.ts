import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
      }]);
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
});
