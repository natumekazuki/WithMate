import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const FIRST_TIME = "2026-09-19T00:00:00.000Z";
const SECOND_TIME = "2026-09-19T00:01:00.000Z";

function createSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      id,
      taskTitle: "thread patch",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-a",
      character: "Character A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    provider: "codex",
    catalogRevision: 4,
    model: "gpt-test",
    reasoningEffort: "medium",
    threadId: "thread-old",
    updatedAt: FIRST_TIME,
    messages: [{ role: "user", text: "keep this message" }],
    ...overrides,
  };
}

function createAuxiliary(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "aux-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "idle",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 4,
    model: "gpt-test",
    reasoningEffort: "medium",
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: "workspace-write-network",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "aux-thread-old",
    composerDraft: "keep draft",
    messages: [{ role: "user", text: "keep auxiliary message" }],
    displayAfterMessageIndex: null,
    createdAt: FIRST_TIME,
    updatedAt: FIRST_TIME,
    closedAt: "",
    ...overrides,
  };
}

async function withTempDb<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-thread-patch-"));
  try {
    return await run(path.join(root, "app.db"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// @test-value v2
// kind = "invariant"
// claim = "Main Sessionのthread条件付き更新は対象行の本文・model・sandbox・Characterを保持し、owner条件不一致と旧incarnationを拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
// fault = "thread patchが別provider・別incarnation・別threadを誤って更新する、またはthread以外の保存状態を失う"
// observable = "実V6一時DBの更新結果、保持されたSession状態、条件不一致のnull、同ID再作成後の新行不変"
// observation_boundary = "public-boundary"
// scope = "session-storage-v6-thread-patch"
// lifecycle = "permanent"
// impact = "古いprovider応答が別の会話へ混入し、本文や実行ポリシーを壊す"
// distinction = "通常upsertではなく実SessionStorageV6の条件付きthread更新SQLを通り、削除・同ID再作成境界まで確認する"
// @end-test-value
test("SessionStorageV6 thread patchはowner条件を満たすとthreadだけ更新する", async () => {
  await withTempDb(async (dbPath) => {
    const storage = new SessionStorageV6(dbPath);
    try {
      const first = storage.insertSession(createSession("main-1"));
      const input = {
        sessionId: first.id,
        incarnationId: first.incarnationId!,
        provider: first.provider,
        expectedThreadId: first.threadId,
        nextThreadId: "thread-new",
        updatedAt: SECOND_TIME,
      };
      const patched = storage.updateSessionThreadIfMatches(input);
      assert.equal(patched?.threadId, "thread-new");
      assert.equal(patched?.updatedAt, SECOND_TIME);
      assert.deepEqual(patched?.messages, first.messages);
      assert.equal(patched?.model, first.model);
      assert.equal(patched?.codexSandboxMode, first.codexSandboxMode);
      assert.equal(patched?.characterId, first.characterId);
      const reset = storage.updateSessionThreadIfMatches({ ...input, expectedThreadId: "thread-new", nextThreadId: "", updatedAt: "2026-09-19T00:02:00.000Z" });
      assert.equal(reset?.threadId, "");
      const changedElsewhere = storage.updateSession({
        ...reset!,
        model: "gpt-updated",
        messages: [{ role: "assistant", text: "newer body" }],
        updatedAt: "2026-09-19T00:03:00.000Z",
      });
      const reversed = storage.updateSessionThreadIfMatches({
        ...input,
        expectedThreadId: "",
        nextThreadId: "thread-new",
        updatedAt: "2026-09-19T00:04:00.000Z",
      });
      assert.equal(reversed?.threadId, "thread-new");
      assert.equal(reversed?.model, changedElsewhere.model);
      assert.deepEqual(reversed?.messages.map((message) => message.text), ["newer body"]);
      assert.equal(storage.updateSessionThreadIfMatches({ ...input, expectedThreadId: "wrong" }), null);
      assert.equal(storage.updateSessionThreadIfMatches({ ...input, provider: "copilot", expectedThreadId: "thread-new" }), null);
      assert.equal(storage.updateSessionThreadIfMatches({ ...input, incarnationId: "old-incarnation", expectedThreadId: "thread-new" }), null);

      storage.deleteSession(first.id);
      const recreated = storage.insertSession(createSession(first.id));
      assert.notEqual(recreated.incarnationId, first.incarnationId);
      assert.equal(storage.updateSessionThreadIfMatches(input), null);
      assert.equal(storage.getSession(recreated.id)?.threadId, "thread-old");
    } finally {
      storage.close();
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryのthread条件付き更新はpayloadとsummaryのthreadを同期し、本文とcomposer draftを保持してowner条件不一致・削除後を拒否する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
// fault = "Auxiliary patchが親・provider・createdAt・threadの異なる行を更新する、または並行保存された本文・draftを上書きする"
// observable = "実AuxiliarySessionStorage一時DBのpayload/summary、更新後のmessages・composerDraft、条件不一致と削除後のnull"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-storage-thread-patch"
// lifecycle = "permanent"
// impact = "古いAuxiliary応答が別親の会話へ混入し、ユーザーの本文や入力中draftを失う"
// distinction = "payloadとsummaryを同じstorage transactionで更新し、patch前の本文/draftをfixtureではなくDBの現行値から検証する"
// @end-test-value
test("AuxiliarySessionStorage thread patchはpayloadとsummaryを同期する", async () => {
  await withTempDb(async (dbPath) => {
    const storage = new AuxiliarySessionStorage(dbPath);
    const parentStorage = new SessionStorageV6(dbPath);
    parentStorage.upsertSession(createSession("parent-1"));
    try {
      const stored = storage.upsertAuxiliarySession(createAuxiliary());
      const current = storage.getAuxiliarySession(stored.id)!;
      const patched = storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: current.threadId,
        nextThreadId: "aux-thread-new",
        updatedAt: SECOND_TIME,
        createdAt: current.createdAt,
      });
      assert.equal(patched?.threadId, "aux-thread-new");
      assert.equal(patched?.messages[0]?.text, stored.messages[0]?.text);
      assert.equal(patched?.composerDraft, stored.composerDraft);
      assert.equal(storage.listAuxiliarySessions(stored.parentSessionId)[0]?.threadId, "aux-thread-new");
      const reset = storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: "aux-thread-new",
        nextThreadId: "",
        updatedAt: "2026-09-19T00:02:00.000Z",
        createdAt: stored.createdAt,
      });
      assert.equal(reset?.threadId, "");
      storage.upsertAuxiliarySession({
        ...reset!,
        messages: [{ role: "assistant", text: "newer auxiliary body" }],
        composerDraft: "keep draft",
        updatedAt: "2026-09-19T00:03:00.000Z",
      });
      const newerDraft = storage.getAuxiliaryDraft(stored.id)!;
      assert.equal(storage.saveAuxiliaryDraft({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        incarnation: newerDraft.incarnation,
        expectedDurableRevision: newerDraft.durableRevision,
        text: "newer draft",
        updatedAt: "2026-09-19T00:03:00.000Z",
      }).outcome, "saved");
      const reversed = storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: "",
        nextThreadId: "aux-thread-new",
        updatedAt: "2026-09-19T00:04:00.000Z",
        createdAt: stored.createdAt,
      });
      assert.equal(reversed?.threadId, "aux-thread-new");
      assert.deepEqual(reversed?.messages.map((message) => message.text), ["newer auxiliary body"]);
      assert.equal(reversed?.composerDraft, "newer draft");
      assert.equal(storage.listAuxiliarySessions(stored.parentSessionId)[0]?.threadId, "aux-thread-new");
      assert.equal(storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: "wrong-thread",
        nextThreadId: "wrong-expected",
        updatedAt: SECOND_TIME,
        createdAt: stored.createdAt,
      }), null);
      assert.equal(storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: "other-parent",
        provider: stored.provider,
        expectedThreadId: "aux-thread-new",
        nextThreadId: "wrong-parent",
        updatedAt: SECOND_TIME,
        createdAt: stored.createdAt,
      }), null);
      assert.equal(storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: "copilot",
        expectedThreadId: "aux-thread-new",
        nextThreadId: "wrong-provider",
        updatedAt: SECOND_TIME,
        createdAt: stored.createdAt,
      }), null);
      assert.equal(storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: "aux-thread-new",
        nextThreadId: "wrong-created",
        updatedAt: SECOND_TIME,
        createdAt: "wrong-created-at",
      }), null);
      storage.deleteAuxiliarySessionsForParent(stored.parentSessionId);
      assert.equal(storage.updateAuxiliarySessionThreadIfMatches({
        auxiliarySessionId: stored.id,
        parentSessionId: stored.parentSessionId,
        provider: stored.provider,
        expectedThreadId: "aux-thread-new",
        nextThreadId: "after-delete",
        updatedAt: SECOND_TIME,
        createdAt: stored.createdAt,
      }), null);
    } finally {
      storage.close();
      parentStorage.close();
    }
  });
});

// @test-value v2
// kind = "invariant"
// claim = "SessionPersistenceServiceのdeferred thread patchは保存成功時だけthreadをcacheへ投影し、応答待ち中に消えたcacheを復活させず新しい本文を保持する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#settingscatalogservice" }
// fault = "storage commit後の遅延応答が、別処理で消えたcacheへSession全体を再挿入するか新しい本文を上書きする"
// observable = "deferred実storage結果、service cache、実V6 DBのmessagesとthread"
// observation_boundary = "public-boundary"
// scope = "session-persistence-service-thread-patch"
// lifecycle = "permanent"
// impact = "画面上に消えた会話が復活し、provider thread応答が別のcache状態へ混入する"
// distinction = "単体storageではなくproduction SessionPersistenceServiceのdeferred adapter経路を一時V6 DBとcontrolled cache mutationで確認する"
// @end-test-value
test("SessionPersistenceService deferred thread patchはcacheを安全に投影する", async () => {
  await withTempDb(async (dbPath) => {
    const storage = new SessionStorageV6(dbPath);
    try {
      const initial = storage.insertSession(createSession("service-main"));
      let cached = [initial];
      let release!: () => void;
      let reached!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      const service = new SessionPersistenceService({
        getSessions: () => cached,
        setSessions: (next) => { cached = next; },
        getSession: (sessionId) => cached.find((session) => session.id === sessionId) ?? null,
        isSessionRunInFlight: () => false,
        upsertStoredSession: async () => { throw new Error("unused"); },
        updateStoredSessionThreadIfMatches: async (input) => {
          const stored = storage.updateSessionThreadIfMatches(input);
          reached();
          await barrier;
          if (input.sessionId === "service-surviving") {
            cached = cached.map((session) => ({
              ...session,
              messages: [{ role: "assistant", text: "newer cached response" }],
            }));
          }
          return stored;
        },
        replaceStoredSessions: async () => undefined,
        listStoredSessions: async () => storage.listSessions(),
        deleteStoredSessions: async (sessionIds) => storage.deleteSessions(sessionIds),
        getAppSettings: () => ({}) as never,
        getModelCatalogSnapshot: () => ({ revision: 1, providers: [] }),
        syncSessionDependencies: () => undefined,
        clearSessionContextTelemetry: () => undefined,
        clearSessionBackgroundActivities: () => undefined,
        invalidateProviderSessionThread: async () => undefined,
        closeSessionWindow: () => undefined,
        broadcastSessions: () => undefined,
      });
      const update = service.updateSessionThreadIfMatches({
        sessionId: initial.id,
        incarnationId: initial.incarnationId!,
        provider: initial.provider,
        expectedThreadId: initial.threadId,
        nextThreadId: "service-thread-new",
        updatedAt: SECOND_TIME,
      });
      await reachedPromise;
      // The storage commit already happened. Mutate only the in-memory projection
      // while the returned committed row is deferred; this avoids coupling the
      // assertion to SessionPersistenceService's mutation queue.
      cached = [];
      release();
      assert.equal((await update)?.threadId, "service-thread-new");
      assert.deepEqual(cached, []);
      assert.equal(storage.getSession(initial.id)?.threadId, "service-thread-new");

      const surviving = storage.insertSession(createSession("service-surviving"));
      cached = [surviving];
      const successful = await service.updateSessionThreadIfMatches({
        sessionId: surviving.id,
        incarnationId: surviving.incarnationId!,
        provider: surviving.provider,
        expectedThreadId: surviving.threadId,
        nextThreadId: "service-thread-success",
        updatedAt: SECOND_TIME,
      });
      assert.equal(successful?.threadId, "service-thread-success");
      assert.deepEqual(cached[0]?.messages.map((message) => message.text), ["newer cached response"]);
      assert.equal(cached[0]?.threadId, "service-thread-success");
      assert.equal(storage.getSession(surviving.id)?.threadId, "service-thread-success");
    } finally {
      storage.close();
    }
  });
});
