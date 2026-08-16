import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  inspectCharacterAffectTurnSettlements,
  parseCharacterAffectTurnRecoveryCommand,
  releaseCharacterAffectTurnSettlement,
} from "../character-affect-turn-settlement-recovery.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";

describe("Character affect turn settlement recovery tool", () => {
  it("本文を表示せず隔離metadataをinspectし、明示対象だけreleaseしてread-backする", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-recovery-tool-"));
    const dbPath = path.join(directory, "withmate.db");
    let storage: CharacterAffectTurnSettlementStorage | null = null;
    try {
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      storage.enqueue({
        correlationId: "quarantined-correlation",
        characterId: "character-a",
        sessionId: "session-a",
        userMessage: "private user payload",
        assistantMessage: "private assistant payload",
        assistantMessageIndex: 1,
        occurredAt: "2026-08-14T00:00:00.000Z",
      });
      storage.markReady("quarantined-correlation");
      storage.recordAttempt("quarantined-correlation");
      storage.recordFailure({
        correlationId: "quarantined-correlation",
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
      storage.close();
      storage = null;

      const inspected = inspectCharacterAffectTurnSettlements(dbPath);
      assert.match(JSON.stringify(inspected), /quarantined-correlation|unknown_character/);
      assert.doesNotMatch(JSON.stringify(inspected), /private user|private assistant/);
      assert.throws(
        () => parseCharacterAffectTurnRecoveryCommand(["--db", dbPath, "--release", "quarantined-correlation"]),
        /confirm-app-stopped/,
      );
      assert.deepEqual(
        parseCharacterAffectTurnRecoveryCommand([
          "--db",
          dbPath,
          "--release",
          "quarantined-correlation",
          "--confirm-app-stopped",
        ]),
        {
          kind: "release",
          dbPath,
          correlationId: "quarantined-correlation",
          appStoppedConfirmed: true,
        },
      );
      assert.deepEqual(releaseCharacterAffectTurnSettlement(dbPath, "quarantined-correlation"), {
        correlationId: "quarantined-correlation",
        sessionId: "session-a",
        state: "ready",
        attemptCount: 0,
        nextAttemptAt: null,
        evaluationPersisted: false,
      });
    } finally {
      storage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
