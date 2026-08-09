import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCharacterContextError,
  type CharacterContextResponse,
} from "../../src/character-context/character-context-contract.js";
import type { AffectEventInput } from "../../src/character-affect/affect-contract.js";
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

function candidate(version: string): AffectEventInput {
  return {
    schemaVersion: "withmate-affect-v1",
    eventId: `event-${version}`,
    characterId: "character-a",
    userId: "local-user",
    sessionId: "session-a",
    layer: "session",
    targetType: "task",
    targetId: "current-task",
    value: { label: "interest", valence: 0.4 },
    intensity: 0.5,
    reason: `evaluated from ${version}`,
    evidence: "bounded concurrency test",
    occurredAt: "2026-08-09T04:00:00.000Z",
    idempotencyKey: `turn:session-a:audit:42:${version}`,
  };
}

describe("settleCharacterAffectTurnWithRetry", () => {
  it("version conflictでは最新contextを再取得・再評価して一度だけsettleする", async () => {
    const evaluatedVersions: string[] = [];
    const appraisalVersions: string[] = [];
    let readCount = 0;
    let settledCount = 0;
    const result = await settleCharacterAffectTurnWithRetry({
      async getContext() {
        readCount += 1;
        return context(`v${readCount}`);
      },
      async evaluate(current) {
        evaluatedVersions.push(current.affect.version);
        return [candidate(current.affect.version)];
      },
      async appraise(current) {
        appraisalVersions.push(current.affect.version);
        if (current.affect.version === "v1") {
          return createCharacterContextError("version_conflict", "stale", {
            retryable: true,
            conversationMayContinue: true,
            effect: "none",
          });
        }
        return {
          schemaVersion: "withmate-character-context-v1",
          characterId: "character-a",
          sessionId: "session-a",
          saved: [{ candidateIndex: 0, eventId: "event-v2", memoryEntryId: null, replayed: false }],
          rejected: [],
          version: "v3",
          updatedAt: "2026-08-09T04:01:00.000Z",
        };
      },
      markSettled() {
        settledCount += 1;
      },
    });

    assert.equal(result.status, "settled");
    assert.deepEqual(evaluatedVersions, ["v1", "v2"]);
    assert.deepEqual(appraisalVersions, ["v1", "v2"]);
    assert.equal(settledCount, 1);
  });
});
