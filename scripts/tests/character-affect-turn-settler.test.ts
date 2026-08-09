import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { AffectEventInput } from "../../src/character-affect/affect-contract.js";
import {
  createCharacterContextError,
  type CharacterAffectAppraiseResponse,
  type CharacterContextErrorResponse,
  type CharacterContextResponse,
} from "../../src/character-context/character-context-contract.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";
import { settleCharacterAffectTurnWithRetry } from "../../src-electron/character-affect-turn-settler.js";

function context(version: string): CharacterContextResponse {
  return {
    schemaVersion: "withmate-character-context-v1",
    characterId: "character-a",
    sessionId: "session-a",
    baseline: { definitionSha256: "sha", snapshotAt: "2026-08-09T00:00:00.000Z" },
    affect: { mode: "active", effective: [], version, updatedAt: null },
    memory: { items: [], updatedAt: null },
    scope: { userId: "local-user", characterId: "character-a", sessionId: "session-a" },
  };
}

function candidate(idempotencyKey: string, reason = "stable candidate"): AffectEventInput {
  return {
    schemaVersion: "withmate-affect-v1",
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "task",
    targetId: "current-task",
    value: { label: "interest", valence: 0.4 },
    intensity: 0.5,
    reason,
    evidence: "settlement recovery test",
    occurredAt: "2026-08-09T04:00:00.000Z",
    idempotencyKey,
  };
}

function success(candidateIndex = 0): CharacterAffectAppraiseResponse {
  return {
    schemaVersion: "withmate-character-context-v1",
    characterId: "character-a",
    sessionId: "session-a",
    saved: [{ candidateIndex, eventId: `event-${candidateIndex}`, memoryEntryId: null, replayed: false }],
    rejected: [],
    version: "v-next",
    updatedAt: "2026-08-09T04:01:00.000Z",
  };
}

function enqueue(storage: CharacterAffectTurnSettlementStorage, correlationId: string): void {
  storage.enqueue({
    correlationId,
    characterId: "character-a",
    sessionId: "session-a",
    userMessage: "user",
    assistantMessage: "assistant",
    assistantMessageIndex: 1,
    occurredAt: "2026-08-09T04:00:00.000Z",
  });
}

function settle(
  storage: CharacterAffectTurnSettlementStorage,
  correlationId: string,
  deps: {
    getContext(): Promise<CharacterContextResponse | CharacterContextErrorResponse>;
    evaluate(context: CharacterContextResponse, idempotencyPrefix: string): Promise<AffectEventInput[]>;
    appraise(
      expectedVersion: string,
      candidates: AffectEventInput[],
    ): Promise<CharacterAffectAppraiseResponse | CharacterContextErrorResponse>;
    afterRecordAppraisalFailure?(result: { reevaluationPrepared: boolean }): void;
  },
) {
  return settleCharacterAffectTurnWithRetry({
    correlationId,
    getPending: () => storage.getPending(correlationId),
    getContext: deps.getContext,
    evaluate: deps.evaluate,
    persistEvaluation: (input) => {
      storage.saveEvaluation({ correlationId, ...input });
    },
    appraise: deps.appraise,
    recordAppraisalFailure: (input) => {
      const result = storage.recordAppraisalFailure({ correlationId, ...input });
      deps.afterRecordAppraisalFailure?.(result);
      return result;
    },
    markSettled: () => {
      storage.markSettled(correlationId);
    },
  });
}

describe("settleCharacterAffectTurnWithRetry", () => {
  it("effect:noneのversion conflictだけ最新contextで再評価し、別idempotency namespaceを使う", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-version-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const correlationId = "turn:session-a:audit:42";
    const prefixes: string[] = [];
    let contextReadCount = 0;
    let appraisalCount = 0;
    try {
      enqueue(storage, correlationId);
      const result = await settle(storage, correlationId, {
        async getContext() {
          contextReadCount += 1;
          return context(`v${contextReadCount}`);
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, `evaluation ${prefixes.length}`)];
        },
        async appraise() {
          appraisalCount += 1;
          if (appraisalCount === 1) {
            return createCharacterContextError("version_conflict", "stale", {
              retryable: true,
              conversationMayContinue: true,
              effect: "none",
            });
          }
          return success();
        },
      });

      assert.equal(result.status, "settled");
      assert.deepEqual(prefixes, [correlationId, `${correlationId}:evaluation:1`]);
      assert.equal(storage.getPending(correlationId), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("effect:noneの再評価は再起動をまたいでも一度だけで、2回目のconflictはcandidateを維持する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-durable-retry-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:durable-retry";
    const prefixes: string[] = [];
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      const firstResult = await settle(first, correlationId, {
        async getContext() {
          return context(`v${prefixes.length + 1}`);
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, `evaluation ${prefixes.length}`)];
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(firstResult.status, "pending");
      assert.deepEqual(prefixes, [correlationId, `${correlationId}:evaluation:1`]);
      const persisted = first.getPending(correlationId);
      assert.equal(persisted?.evaluationAttempt, 1);
      assert.deepEqual(persisted?.evaluation?.observedEffects, ["none"]);
      const persistedCandidate = persisted?.evaluation?.candidates;
      first.close();
      first = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const recoveredResult = await settle(recovered, correlationId, {
        async getContext() {
          throw new Error("durable retry budget must prevent another context fetch");
        },
        async evaluate() {
          throw new Error("durable retry budget must prevent another evaluation");
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "still stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(recoveredResult.status, "pending");
      assert.equal(recovered.getPending(correlationId)?.evaluationAttempt, 1);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.candidates, persistedCandidate);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.observedEffects, ["none", "none"]);
    } finally {
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("effect:noneの記録直後にprocessが終了しても再評価準備をatomicに復旧する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-atomic-retry-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:atomic-retry";
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      await assert.rejects(() => settle(first!, correlationId, {
        async getContext() {
          return context("v1");
        },
        async evaluate(_current, idempotencyPrefix) {
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
        afterRecordAppraisalFailure(result) {
          assert.deepEqual(result, { reevaluationPrepared: true });
          throw new Error("simulated process exit after atomic retry commit");
        },
      }), /simulated process exit/);
      assert.equal(first.getPending(correlationId)?.evaluationAttempt, 1);
      assert.equal(first.getPending(correlationId)?.evaluation, null);
      first.close();
      first = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const prefixes: string[] = [];
      const result = await settle(recovered, correlationId, {
        async getContext() {
          return context("v2");
        },
        async evaluate(_current, idempotencyPrefix) {
          prefixes.push(idempotencyPrefix);
          return [candidate(`${idempotencyPrefix}:0`, "recovered evaluation")];
        },
        async appraise() {
          return success();
        },
      });
      assert.equal(result.status, "settled");
      assert.deepEqual(prefixes, [`${correlationId}:evaluation:1`]);
      assert.equal(recovered.getPending(correlationId), null);
    } finally {
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("unknown後にeffect:noneのversion conflictを受けても保存済みcandidateを再評価しない", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-ambiguous-conflict-"));
    const dbPath = path.join(directory, "settlement.db");
    const correlationId = "turn:session-a:audit:ambiguous-conflict";
    let first: CharacterAffectTurnSettlementStorage | null = null;
    let recovered: CharacterAffectTurnSettlementStorage | null = null;
    try {
      first = new CharacterAffectTurnSettlementStorage(dbPath);
      enqueue(first, correlationId);
      const firstResult = await settle(first, correlationId, {
        async getContext() {
          return context("v1");
        },
        async evaluate(_current, idempotencyPrefix) {
          return [candidate(`${idempotencyPrefix}:0`)];
        },
        async appraise() {
          return createCharacterContextError("storage_unavailable", "response lost", {
            retryable: true,
            conversationMayContinue: true,
            effect: "unknown",
          });
        },
      });
      assert.equal(firstResult.status, "pending");
      const persistedCandidate = first.getPending(correlationId)?.evaluation?.candidates;
      first.close();
      first = null;

      recovered = new CharacterAffectTurnSettlementStorage(dbPath);
      const recoveredResult = await settle(recovered, correlationId, {
        async getContext() {
          throw new Error("ambiguous appraisal must not fetch a new context");
        },
        async evaluate() {
          throw new Error("ambiguous appraisal must not replace candidate identity");
        },
        async appraise() {
          return createCharacterContextError("version_conflict", "reconcile conflict", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        },
      });
      assert.equal(recoveredResult.status, "pending");
      assert.equal(recovered.getPending(correlationId)?.evaluationAttempt, 0);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.candidates, persistedCandidate);
      assert.deepEqual(recovered.getPending(correlationId)?.evaluation?.observedEffects, ["unknown", "none"]);
    } finally {
      recovered?.close();
      first?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const effect of ["partial", "committed", "unknown"] as const) {
    it(`${effect} effect後のrestart recoveryは保存済みcandidateを再評価せずreconcileする`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `withmate-affect-settler-${effect}-`));
      const dbPath = path.join(directory, "settlement.db");
      const correlationId = `turn:session-a:audit:${effect}`;
      let first: CharacterAffectTurnSettlementStorage | null = null;
      let recovered: CharacterAffectTurnSettlementStorage | null = null;
      const evaluatedCandidates: AffectEventInput[][] = [];
      try {
        first = new CharacterAffectTurnSettlementStorage(dbPath);
        enqueue(first, correlationId);
        const firstResult = await settle(first, correlationId, {
          async getContext() {
            return context("v1");
          },
          async evaluate(_current, idempotencyPrefix) {
            return [candidate(`${idempotencyPrefix}:0`)];
          },
          async appraise(_expectedVersion, candidates) {
            evaluatedCandidates.push(candidates);
            return createCharacterContextError(
              effect === "unknown" ? "version_conflict" : "partial_failure",
              "injected ambiguous result",
              {
                retryable: true,
                conversationMayContinue: true,
                effect,
                ...(effect === "partial"
                  ? { details: { saved: [{ candidateIndex: 0 }] } }
                  : effect === "committed"
                    ? { details: { failedCandidateIndex: 0 } }
                    : {}),
              },
            );
          },
        });
        assert.equal(firstResult.status, "pending");
        const persistedCandidate = first.getPending(correlationId)?.evaluation?.candidates[0];
        assert.equal(first.getPending(correlationId)?.evaluation?.lastEffect, effect);
        first.close();
        first = null;

        recovered = new CharacterAffectTurnSettlementStorage(dbPath);
        const recoveredResult = await settle(recovered, correlationId, {
          async getContext() {
            throw new Error("stored evaluation must not fetch context before reconcile");
          },
          async evaluate() {
            throw new Error("stored candidate must not be re-evaluated");
          },
          async appraise(_expectedVersion, candidates) {
            evaluatedCandidates.push(candidates);
            return success();
          },
        });
        assert.equal(recoveredResult.status, "settled");
        assert.deepEqual(evaluatedCandidates[1], [persistedCandidate]);
        assert.equal(recovered.getPending(correlationId), null);
      } finally {
        recovered?.close();
        first?.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("ambiguous pendingが残っても後続settlementを処理できる", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-settler-starvation-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const firstCorrelation = "turn:session-a:audit:first";
    const secondCorrelation = "turn:session-a:audit:second";
    try {
      enqueue(storage, firstCorrelation);
      enqueue(storage, secondCorrelation);
      for (const pending of storage.listPending()) {
        await settle(storage, pending.correlationId, {
          async getContext() {
            return context("v1");
          },
          async evaluate(_current, idempotencyPrefix) {
            return [candidate(`${idempotencyPrefix}:0`)];
          },
          async appraise() {
            if (pending.correlationId === firstCorrelation) {
              return createCharacterContextError("storage_unavailable", "unknown", {
                retryable: true,
                conversationMayContinue: true,
                effect: "unknown",
              });
            }
            return success();
          },
        });
      }
      assert.equal(storage.getPending(firstCorrelation)?.evaluation?.lastEffect, "unknown");
      assert.equal(storage.getPending(secondCorrelation), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
