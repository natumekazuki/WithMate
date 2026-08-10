import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildNewSession, type Session } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { drainCharacterAffectTurnSettlementBatch } from "../../src-electron/character-affect-turn-drain.js";
import { CharacterAffectTurnSettlementStorage } from "../../src-electron/character-affect-turn-settlement-storage.js";

function createCommittedSession(sessionId: string, assistantMessage: string): Session {
  return {
    ...buildNewSession({
      taskTitle: "Affect drain test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    id: sessionId,
    messages: [
      { role: "user", text: "user" },
      { role: "assistant", text: assistantMessage },
    ],
  };
}

function enqueue(
  storage: CharacterAffectTurnSettlementStorage,
  correlationId: string,
  sessionId: string,
  assistantMessage: string,
): void {
  storage.enqueue({
    correlationId,
    characterId: "character-a",
    sessionId,
    userMessage: "user",
    assistantMessage,
    assistantMessageIndex: 1,
    occurredAt: "2026-08-10T00:00:00.000Z",
  });
}

describe("drainCharacterAffectTurnSettlementBatch", () => {
  it("現processのunreadyが100件あっても各drainでready settlementを前進させる", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-fairness-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const sessions = new Map<string, Session>();
    const settledCorrelations: string[] = [];
    let cursor = undefined;
    try {
      for (let index = 0; index < 100; index += 1) {
        enqueue(storage, `unready-${index}`, `uncommitted-session-${index}`, `unready-${index}`);
      }

      for (let drainIndex = 0; drainIndex < 3; drainIndex += 1) {
        const correlationId = `ready-${drainIndex}`;
        const sessionId = `committed-session-${drainIndex}`;
        const assistantMessage = `ready assistant ${drainIndex}`;
        enqueue(storage, correlationId, sessionId, assistantMessage);
        storage.markReady(correlationId);
        sessions.set(sessionId, createCommittedSession(sessionId, assistantMessage));

        const result = await drainCharacterAffectTurnSettlementBatch({
          storage,
          runtimeAvailable: true,
          startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
          readyCursor: cursor,
          getSession: async (id) => sessions.get(id) ?? null,
          settle: async (item) => {
            settledCorrelations.push(item.correlationId);
            storage.markSettled(item.correlationId);
            return true;
          },
          onDiscard() {
            assert.fail("current-process unready settlement must not be discarded");
          },
          onFailure(_item, error) {
            throw error;
          },
          now: () => "9999-12-31T23:59:59.999Z",
        });
        cursor = result.nextReadyCursor;

        assert.equal(storage.getPending(correlationId), null);
        assert.equal(result.retryRequired, true);
      }

      assert.deepEqual(settledCorrelations, ["ready-0", "ready-1", "ready-2"]);
      assert.equal(storage.listUnreadyPendingBefore("9999-12-31T23:59:59.999Z", 200).length, 100);
      assert.deepEqual(storage.listReadyPending(), []);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("startup cutoffより古い未commit settlementは従来どおり破棄する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-orphan-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const discarded: string[] = [];
    try {
      enqueue(storage, "old-orphan", "missing-session", "orphan assistant");
      await drainCharacterAffectTurnSettlementBatch({
        storage,
        runtimeAvailable: true,
        startupRecoveryCutoff: "9999-01-01T00:00:00.000Z",
        getSession: async () => null,
        settle: async () => {
          assert.fail("orphan must not be appraised");
        },
        onDiscard(item) {
          discarded.push(item.correlationId);
        },
        onFailure(_item, error) {
          throw error;
        },
        now: () => "9999-12-31T23:59:59.999Z",
      });

      assert.deepEqual(discarded, ["old-orphan"]);
      assert.equal(storage.getPending("old-orphan"), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ready full pageの失敗後は次drain内でcursorをwrapして再試行する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-cursor-wrap-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const sessions = new Map<string, Session>();
    const attempts = new Map<string, number>();
    try {
      for (let index = 0; index < 100; index += 1) {
        enqueue(storage, `unready-${index}`, `uncommitted-session-${index}`, `unready-${index}`);
        const correlationId = `ready-${index.toString().padStart(3, "0")}`;
        const sessionId = `committed-session-${index}`;
        const assistantMessage = `ready assistant ${index}`;
        enqueue(storage, correlationId, sessionId, assistantMessage);
        storage.markReady(correlationId);
        sessions.set(sessionId, createCommittedSession(sessionId, assistantMessage));
      }

      const first = await drainCharacterAffectTurnSettlementBatch({
        storage,
        runtimeAvailable: true,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        getSession: async (id) => sessions.get(id) ?? null,
        settle: async (item) => {
          const attempt = (attempts.get(item.correlationId) ?? 0) + 1;
          attempts.set(item.correlationId, attempt);
          if (item.correlationId === "ready-000" && attempt === 1) {
            return false;
          }
          storage.markSettled(item.correlationId);
          return true;
        },
        onDiscard() {
          assert.fail("current-process unready settlement must not be discarded");
        },
        onFailure(_item, error) {
          throw error;
        },
        now: () => "9999-12-31T23:59:59.999Z",
      });

      assert.ok(first.nextReadyCursor);
      assert.equal(attempts.size, 100);
      assert.ok(storage.getPending("ready-000"));

      const second = await drainCharacterAffectTurnSettlementBatch({
        storage,
        runtimeAvailable: true,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        readyCursor: first.nextReadyCursor,
        getSession: async (id) => sessions.get(id) ?? null,
        settle: async (item) => {
          attempts.set(item.correlationId, (attempts.get(item.correlationId) ?? 0) + 1);
          storage.markSettled(item.correlationId);
          return true;
        },
        onDiscard() {
          assert.fail("current-process unready settlement must not be discarded");
        },
        onFailure(_item, error) {
          throw error;
        },
        now: () => "9999-12-31T23:59:59.999Z",
      });

      assert.equal(attempts.get("ready-000"), 2);
      assert.equal(storage.getPending("ready-000"), null);
      assert.equal(second.retryRequired, true);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("1 drainのunready recoveryとready settlementを各100件に制限する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-bounds-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    let unreadyLookups = 0;
    let readyLookups = 0;
    let settleCalls = 0;
    try {
      for (let index = 0; index < 101; index += 1) {
        enqueue(storage, `unready-${index}`, `uncommitted-session-${index}`, `unready-${index}`);
        const correlationId = `ready-${index.toString().padStart(3, "0")}`;
        const sessionId = `committed-session-${index}`;
        const assistantMessage = `ready assistant ${index}`;
        enqueue(storage, correlationId, sessionId, assistantMessage);
        storage.markReady(correlationId);
      }

      const result = await drainCharacterAffectTurnSettlementBatch({
        storage,
        runtimeAvailable: true,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        getSession: async (id) => {
          if (id.startsWith("uncommitted-")) {
            unreadyLookups += 1;
            return null;
          }
          readyLookups += 1;
          return createCommittedSession(id, `ready assistant ${Number(id.split("-").at(-1))}`);
        },
        settle: async (item) => {
          settleCalls += 1;
          storage.markSettled(item.correlationId);
          return true;
        },
        onDiscard() {
          assert.fail("current-process unready settlement must not be discarded");
        },
        onFailure(_item, error) {
          throw error;
        },
        now: () => "9999-12-31T23:59:59.999Z",
      });

      assert.equal(unreadyLookups, 100);
      assert.equal(readyLookups, 100);
      assert.equal(settleCalls, 100);
      assert.equal(storage.listUnreadyPendingBefore("9999-12-31T23:59:59.999Z", 200).length, 101);
      assert.equal(storage.listReadyPending().length, 1);
      assert.equal(result.retryRequired, true);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
