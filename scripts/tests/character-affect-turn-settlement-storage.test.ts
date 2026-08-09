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
        attemptCount: 0,
      }]);
      recovered.recordAttempt(input.correlationId);
      assert.equal(recovered.listPending()[0]?.attemptCount, 1);
      assert.equal(recovered.markSettled(input.correlationId, "2026-08-09T04:01:00.000Z"), true);
      assert.deepEqual(recovered.listPending(), []);
      recovered.close();
      recovered = null;

      db = openAppDatabase(dbPath);
      const row = db.prepare(`
        SELECT status, user_message, assistant_message, settled_at
        FROM character_affect_turn_settlements
        WHERE correlation_id = ?
      `).get(input.correlationId) as Record<string, unknown>;
      assert.equal(row.status, "settled");
      assert.equal(row.user_message, "");
      assert.equal(row.assistant_message, "");
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
