import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CharacterContextResponse } from "../../src/character-context/character-context-contract.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";
import { settleCharacterAffectTurnWithRetry } from "../../src-electron/character-affect-turn-settler.js";

// @test-value v2
// kind = "invariant"
// claim = "settlerがawait後にstorage交換を検出するとinvalidatedを返し、後続の評価保存・適用・settlement更新を行わない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
// fault = "await後に閉じたstorageで評価保存・適用・settled更新を継続する"
// observable = "invalidated結果、再openしたDBのpending settlement、失効後のappraise呼出し数"
// observation_boundary = "component-behavior"
// scope = "character-affect-settlement-storage-lifecycle"
// lifecycle = "permanent"
// impact = "DB再作成やruntime交換後に古い評価結果が書き込まれることを防ぐ"
// distinction = "通常retryやowner削除では扱えない、実SQLite接続の交換を各await境界で固定する"
// @end-test-value
test("Affect settlementは非同期処理中のstorage交換で失効する", { timeout: 10_000 }, async () => {
  for (const stage of ["context", "evaluation", "admission", "owner", "appraisal"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-generation-"));
    const dbPath = path.join(directory, "settlement.db");
    const storage = new CharacterAffectTurnSettlementStorage(dbPath);
    let currentStorage = storage;
    const correlationId = `generation-${stage}`;
    const occurredAt = "2026-09-19T00:00:00.000Z";
    storage.enqueue({
      correlationId,
      characterId: "character-a",
      sessionId: "session-a",
      userMessage: "user",
      assistantMessage: "assistant",
      assistantMessageIndex: 1,
      occurredAt,
    });
    let release!: () => void;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const pause = async (at: typeof stage) => {
      if (at === stage) {
        reached();
        await barrier;
      }
    };
    let staleAppraisals = 0;
    try {
      const settling = settleCharacterAffectTurnWithRetry({
        correlationId,
        isCurrentGeneration: () => currentStorage === storage,
        getPending: () => storage.getPending(correlationId),
        getContext: async () => {
          await pause("context");
          return {
            schemaVersion: "withmate-character-context-v1",
            baseline: { definitionSha256: "fixture", snapshotAt: occurredAt },
            affect: { mode: "active", effective: [], evaluatedAt: occurredAt, version: "v1", updatedAt: null },
            memory: { items: [], updatedAt: null },
          } satisfies CharacterContextResponse;
        },
        evaluate: async () => {
          await pause("evaluation");
          return [{
            schemaVersion: "withmate-affect-v1",
            characterId: "character-a",
            userId: "local-user",
            sessionId: "session-a",
            layer: "session",
            targetType: "task",
            targetId: "current-task",
            family: "interest",
            value: { label: "interest", valence: 0.4 },
            intensity: 0.5,
            reason: "fixture",
            evidence: "fixture",
            occurredAt,
            idempotencyKey: correlationId,
          }];
        },
        persistEvaluation: (input) => { storage.saveEvaluation({ correlationId, ...input }); },
        runAppraisalExclusive: async (operation) => {
          await pause("admission");
          return operation();
        },
        validateOwner: async () => {
          await pause("owner");
          return true;
        },
        appraise: async () => {
          if (currentStorage !== storage) staleAppraisals += 1;
          await pause("appraisal");
          return {
            schemaVersion: "withmate-character-context-v1",
            characterId: "character-a",
            sessionId: "session-a",
            saved: [],
            rejected: [],
            version: "v2",
            updatedAt: occurredAt,
          };
        },
        recordAppraisalFailure: (input) => storage.recordAppraisalFailure({ correlationId, ...input }),
        markSettled: () => { storage.markSettled(correlationId); },
        markDiscarded: () => { storage.markDiscarded(correlationId); },
      });
      await entered;
      storage.close();
      currentStorage = new CharacterAffectTurnSettlementStorage(dbPath);
      const beforeResume = currentStorage.getPending(correlationId);
      release();
      assert.deepEqual(await settling, { status: "invalidated" }, stage);
      assert.equal(staleAppraisals, 0, stage);
      assert.deepEqual(currentStorage.getPending(correlationId), beforeResume, stage);
    } finally {
      release();
      currentStorage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
