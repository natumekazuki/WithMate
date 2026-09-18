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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  // @test-value v2
  // kind = "invariant"
  // claim = "retry期限前と隔離済みpendingは保持し、後続の期限到達pendingだけをsettleする"
  // oracle = { type = "contract", ref = "docs/adr/020-memory-affect-mcp-application-boundary.md" }
  // fault = "期限前や隔離済み評価を再実行する、または後続の処理可能pendingが詰まる"
  // observable = "settle対象ID、pendingの再試行時刻、隔離一覧、retryRequired"
  // observation_boundary = "public-boundary"
  // scope = "Affect drainのretry選択と実SQLite pending"
  // lifecycle = "permanent"
  // @end-test-value
  it("future deferredとquarantined itemをskipして後続due itemをsettleする", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-due-"));
    const storage = new CharacterAffectTurnSettlementStorage(path.join(directory, "settlement.db"));
    const sessions = new Map<string, Session>();
    const settled: string[] = [];
    try {
      for (const correlationId of ["deferred", "quarantined", "due"]) {
        const sessionId = `session-${correlationId}`;
        const assistantMessage = `assistant-${correlationId}`;
        enqueue(storage, correlationId, sessionId, assistantMessage);
        storage.markReady(correlationId);
        sessions.set(sessionId, createCommittedSession(sessionId, assistantMessage));
      }
      storage.recordAttempt("deferred", "2026-08-14T00:00:00.000Z");
      storage.recordFailure({
        correlationId: "deferred",
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
      storage.recordAttempt("quarantined", "2026-08-14T00:00:00.000Z");
      storage.recordFailure({
        correlationId: "quarantined",
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

      const result = await drainCharacterAffectTurnSettlementBatch({
        storage,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        getSession: async (id) => sessions.get(id) ?? null,
        settle: async (item) => {
          settled.push(item.correlationId);
          storage.markSettled(item.correlationId);
          return true;
        },
        onDiscard() {
          assert.fail("owned settlement must not be discarded");
        },
        onFailure(_item, error) {
          throw error;
        },
        now: () => "2026-08-14T00:00:30.000Z",
      });

      assert.deepEqual(settled, ["due"]);
      assert.equal(storage.getPending("due"), null);
      assert.equal(storage.getPending("deferred")?.nextAttemptAt, "2026-08-14T00:01:00.000Z");
      assert.equal(storage.listQuarantined()[0]?.correlationId, "quarantined");
      assert.equal(result.retryRequired, true);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "generation交換中にunready回収を再開しない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
  // fault = "getSession待機中のstorage交換を無視して旧storageへreadyまたはdiscardを書き込む"
  // observable = "close/reopen後もunready pendingが不変でretry要求になり、新storageの次回drainでsettleする"
  // observation_boundary = "public-boundary"
  // scope = "character affect drain recovery"
  // lifecycle = "permanent"
  // distinction = "旧generationで回収済み扱いにして現generationのdrainを欠落させない"
  // impact = "storage再open後にpending評価が失われることを防ぐ"
  // @end-test-value
  it("unready回収のgetSession待機中にgenerationが交換されたら旧storageへ書き込まない", { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-unready-generation-"));
    const dbPath = path.join(directory, "settlement.db");
    let storage = new CharacterAffectTurnSettlementStorage(dbPath);
    const initialStorage = storage;
    const sessionReady = deferred<Session | null>();
    const reading = deferred<void>();
    try {
      enqueue(storage, "unready-generation", "committed-session", "assistant");

      const draining = drainCharacterAffectTurnSettlementBatch({
        storage,
        startupRecoveryCutoff: "9999-01-01T00:00:00.000Z",
        getSession: async () => { reading.resolve(); return sessionReady.promise; },
        settle: async () => {
          assert.fail("unready item must not be settled");
        },
        onDiscard: () => assert.fail("generation exchange must not discard the item"),
        onFailure: (_item, error) => { throw error; },
        isCurrentGeneration: () => initialStorage === storage,
        now: () => "9999-12-31T23:59:59.999Z",
      });

      await reading.promise;
      const pendingBefore = storage.getPending("unready-generation");
      storage.close();
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      sessionReady.resolve(createCommittedSession("committed-session", "assistant"));

      const result = await draining;
      assert.deepEqual(result, { retryRequired: true, nextReadyCursor: undefined });
      assert.deepEqual(storage.getPending("unready-generation"), pendingBefore);
      await drainCharacterAffectTurnSettlementBatch({
        storage,
        startupRecoveryCutoff: "9999-01-01T00:00:00.000Z",
        getSession: async () => createCommittedSession("committed-session", "assistant"),
        settle: async (item) => { storage.markSettled(item.correlationId); return true; },
        onDiscard: () => assert.fail("current owner must not be discarded"),
        onFailure: (_item, error) => { throw error; },
      });
      assert.equal(storage.getPending("unready-generation"), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "generation交換中にready settlementのsession再取得を再開しない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#character-affect-の完了後評価" }
  // fault = "ready itemのgetSession待機中のstorage交換を無視して旧pendingを処理する"
  // observable = "close/reopen後もready pendingが不変でcursorなしのretry要求になり、新storageの次回drainでsettleする"
  // observation_boundary = "public-boundary"
  // scope = "character affect drain ready settlement"
  // lifecycle = "permanent"
  // distinction = "旧generationのsession read後に競合書込を発生させず、現generationがready itemを再処理できる"
  // impact = "storage再open後の評価欠落や旧storageへのアクセス失敗を防ぐ"
  // @end-test-value
  it("ready settlementのgetSession待機中にgenerationが交換されたらcursorを返さず旧storageへ書き込まない", { timeout: 10_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-affect-drain-ready-generation-"));
    const dbPath = path.join(directory, "settlement.db");
    let storage = new CharacterAffectTurnSettlementStorage(dbPath);
    const initialStorage = storage;
    const sessionReady = deferred<Session | null>();
    const reading = deferred<void>();
    try {
      enqueue(storage, "ready-generation", "ready-session", "assistant");
      storage.markReady("ready-generation");

      const draining = drainCharacterAffectTurnSettlementBatch({
        storage,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        getSession: async () => { reading.resolve(); return sessionReady.promise; },
        settle: async () => assert.fail("generation exchange must not settle the item"),
        onDiscard: () => assert.fail("generation exchange must not discard the item"),
        onFailure: (_item, error) => { throw error; },
        isCurrentGeneration: () => initialStorage === storage,
        now: () => "9999-12-31T23:59:59.999Z",
      });

      await reading.promise;
      const pendingBefore = storage.getPending("ready-generation");
      storage.close();
      storage = new CharacterAffectTurnSettlementStorage(dbPath);
      sessionReady.resolve(createCommittedSession("ready-session", "assistant"));

      const result = await draining;
      assert.deepEqual(result, { retryRequired: true, nextReadyCursor: undefined });
      assert.deepEqual(storage.getPending("ready-generation"), pendingBefore);
      await drainCharacterAffectTurnSettlementBatch({
        storage,
        startupRecoveryCutoff: "2000-01-01T00:00:00.000Z",
        getSession: async () => createCommittedSession("ready-session", "assistant"),
        settle: async (item) => { storage.markSettled(item.correlationId); return true; },
        onDiscard: () => assert.fail("current owner must not be discarded"),
        onFailure: (_item, error) => { throw error; },
      });
      assert.equal(storage.getPending("ready-generation"), null);
    } finally {
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
