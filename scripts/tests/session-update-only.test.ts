import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "../../src-electron/session-storage-command-adapter.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

function createSession(id: string, updatedAt = "2026-09-19T00:00:00.000Z"): Session {
  return {
    ...buildNewSession({
    id,
    taskTitle: "Update only test",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    characterId: "char-a",
    character: "A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    updatedAt,
  };
}

async function withStorage<T>(run: (storage: SessionStorageV6, dbPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-session-update-only-"));
  const storage = new SessionStorageV6(path.join(root, "app.db"));
  try {
    return await run(storage, path.join(root, "app.db"));
  } finally {
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

function createService(
  storage: SessionStorageV6,
  session: Session,
  updateStoredSession: (next: Session, operation: "create" | "upsert") => Promise<Session>,
  sharedState: { cached: Session[]; revoked: string[]; broadcasts: string[][] } = { cached: [session], revoked: [], broadcasts: [] },
  updateStoredTerminalSession?: (next: Session, terminalCommit: Parameters<SessionPersistenceService["upsertTerminalSession"]>[1]) => Promise<Session>,
): { service: SessionPersistenceService; getCached: () => Session[]; state: typeof sharedState } {
  const service = new SessionPersistenceService({
    getSessions: () => sharedState.cached,
    setSessions: (next) => { sharedState.cached = next; },
    getSession: (sessionId) => sharedState.cached.find((entry) => entry.id === sessionId) ?? null,
    isSessionRunInFlight: () => false,
    upsertStoredSession: updateStoredSession,
    upsertStoredTerminalSession: updateStoredTerminalSession,
    deleteStoredSessions: (sessionIds) => storage.deleteSessions(sessionIds),
    replaceStoredSessions: () => undefined,
    listStoredSessions: () => storage.listSessions(),
    listStoredSessionIdsLastActiveBefore: (cutoff) => storage.listSessionIdsLastActiveBefore(cutoff),
    getAppSettings: () => normalizeAppSettings({}),
    getModelCatalogSnapshot: () => ({ revision: 1, providers: [{
      id: "codex",
      label: "Codex",
      defaultModelId: "gpt-test",
      defaultReasoningEffort: "medium",
      models: [{ id: "gpt-test", label: "Test", reasoningEfforts: ["medium"] }],
    }] }),
    syncSessionDependencies: () => undefined,
    clearSessionContextTelemetry: () => undefined,
    clearSessionBackgroundActivities: () => undefined,
    invalidateProviderSessionThread: () => undefined,
    revokeSessionAgentRuntimeBindings: (sessionId) => { sharedState.revoked.push(sessionId); },
    closeSessionWindow: () => undefined,
    broadcastSessions: (sessionIds) => { sharedState.broadcasts.push([...(sessionIds ?? [])]); },
  });
  return { service, getCached: () => sharedState.cached, state: sharedState };
}

describe("Session update-only persistence", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "既存Session限定のupdateは削除後にSessionを復活させない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除後のstale updateがupsertとして行とmessageを再作成する"
  // observable = "updateのSessionNotFoundErrorとlistSessionsの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-update-only"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのprovider bindingやcache投影の復活を防ぐ"
  // distinction = "通常のupsert/create互換ではなく、production adapterのupdate-only API経由で削除済み行への更新拒否を確認する"
  // @end-test-value
  it("deleted session is not recreated by update-only storage", async () => {
    await withStorage(async (storage) => {
      const session = createSession("deleted-before-update");
      const commands = createSessionStorageCommandAdapter(() => storage);
      commands.upsertStoredSession(session, "create");
      storage.deleteSession(session.id);

      assert.throws(
        () => commands.upsertStoredSession({ ...session, taskTitle: "stale update" }, "upsert"),
        (error: unknown) => error instanceof Error && error.name === "SessionNotFoundError",
      );
      assert.deepEqual(storage.listSessions(), []);
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "update待機中に単体削除または期間削除が確定した場合、再開したupdateはcacheとDBを復活させない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除と競合するstale updateがDBへ再挿入されcacheへ投影される"
  // observable = "update結果の拒否、storageの行、service cache、削除時のbinding失効と失敗updateによるbroadcast非追加"
  // observation_boundary = "public-boundary"
  // scope = "session-persistence-update-delete-race"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのprovider binding・cache・messageが復活する"
  // distinction = "storage単体ではなく実SessionPersistenceServiceのdeferred update経路を一時DBで確認する"
  // @end-test-value
  it("does not resurrect after deferred update and deletion", async () => {
    await withStorage(async (storage) => {
      for (const deletion of ["single", "cutoff"] as const) {
        const session = createSession(`race-${deletion}`);
        const commands = createSessionStorageCommandAdapter(() => storage);
        commands.upsertStoredSession(session, "create");
        let release!: () => void;
        let reached!: () => void;
        const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const sharedState = { cached: [session], revoked: [] as string[], broadcasts: [] as string[][] };
        const { service, getCached } = createService(storage, session, async (next, operation) => {
          assert.equal(operation, "upsert");
          reached();
          await barrier;
          return commands.upsertStoredSession(next, operation);
        }, sharedState);
        const update = service.updateSession({ ...session, taskTitle: "stale update" });
        await reachedPromise;
        const deleteResult = deletion === "single"
          ? await service.deleteSession(session.id)
          : await service.deleteSessionsLastActiveBefore({
            cutoffDate: "2026-09-20",
            cutoffIso: "2026-09-20T00:00:00.000Z",
            cutoffTimestampMs: Date.parse("2026-09-20T00:00:00.000Z"),
          });
        assert.deepEqual(deleteResult.deletedSessionIds, [session.id]);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.revoked, [session.id]);
        assert.deepEqual(sharedState.broadcasts, [ [session.id] ]);
        release();
        await assert.rejects(update, /対象セッションが見つからないよ/);
        assert.equal(storage.getSession(session.id), null);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.revoked, [session.id]);
        assert.deepEqual(sharedState.broadcasts, [ [session.id] ]);
      }
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "productionのSession storage command adapterによる成功したupdateはcacheとbroadcastへ反映される"
  // oracle = { type = "contract", ref = "docs/design/electron-session-store.md#sessionpersistenceservice" }
  // fault = "永続化成功後のcacheまたはbroadcast投影が欠落する"
  // observable = "更新結果、service cache、broadcast対象、storageのSession行"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-command-adapter-success-projection"
  // lifecycle = "permanent"
  // impact = "更新済みSessionが画面へ反映されず、他windowへ通知されない"
  // distinction = "Mainと同じproduction adapterを通るSessionPersistenceServiceの成功経路を確認する"
  // @end-test-value
  it("projects successful adapter update to cache and broadcast", async () => {
    await withStorage(async (storage) => {
      const session = createSession("successful-adapter-update");
      const commands = createSessionStorageCommandAdapter(() => storage);
      commands.upsertStoredSession(session, "create");
      const sharedState = { cached: [session], revoked: [] as string[], broadcasts: [] as string[][] };
      const { service, getCached } = createService(
        storage,
        session,
        async (next, operation) => commands.upsertStoredSession(next, operation),
        sharedState,
      );

      const updated = await service.updateSession({ ...session, taskTitle: "updated through adapter" });

      assert.equal(updated.taskTitle, "updated through adapter");
      assert.equal(getCached()[0]?.taskTitle, "updated through adapter");
      assert.deepEqual(sharedState.broadcasts, [[session.id]]);
      assert.equal(storage.getSession(session.id)?.taskTitle, "updated through adapter");
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "terminal updateは既存Sessionとrunning markerに対してのみatomicに確定する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除済みSessionへのterminal保存がSessionやmarkerを再作成する、marker不一致時に本文・cacheが更新される、または成功時のcache・broadcast投影が欠落する"
  // observable = "Session行とsession_turns_v6のphase、成功時のcache・broadcast、marker不一致と削除後のterminal保存拒否時のDB・cache・broadcast不変"
  // observation_boundary = "public-boundary"
  // scope = "session-terminal-update-only"
  // lifecycle = "permanent"
  // impact = "Session本文とterminal markerの不一致や、削除した会話の復活によるデータ保全違反を防ぐ"
  // distinction = "既存terminal atomic commitのmarker更新と削除済みowner拒否を同じ一時V6 DBで確認する"
  // @end-test-value
  it("rejects deleted terminal owner and commits marker for existing owner", async () => {
    await withStorage(async (storage, dbPath) => {
      const session = createSession("terminal-owner");
      const commands = createSessionStorageCommandAdapter(() => storage);
      commands.upsertStoredSession(session, "create");
      const sharedState = { cached: [session], revoked: [] as string[], broadcasts: [] as string[][] };
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`
          INSERT INTO session_turns_v6 (
            session_id, auxiliary_session_id, phase, assistant_message_seq,
            started_at, completed_at, updated_at
          ) VALUES (?, NULL, 'running', NULL, ?, NULL, ?)
        `).run(session.id, session.updatedAt, session.updatedAt);
        const turnId = Number((db.prepare("SELECT id FROM session_turns_v6 WHERE session_id = ?").get(session.id) as { id: number }).id);
        const commit = {
          auditLogId: turnId,
          sessionId: session.id,
          phase: "completed" as const,
          assistantMessageSeq: 0,
          threadId: "thread-terminal",
          errorMessage: "",
          completedAt: "2026-09-19T00:01:00.000Z",
        };
        const { service, getCached } = createService(
          storage,
          session,
          async (next, operation) => commands.upsertStoredSession(next, operation),
          sharedState,
          async (next, terminalCommit) => commands.upsertStoredTerminalSession(next, terminalCommit),
        );
        await service.upsertTerminalSession({ ...session, threadId: commit.threadId }, commit);
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        assert.equal(getCached()[0]?.threadId, commit.threadId);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
        assert.equal((db.prepare("SELECT phase FROM session_turns_v6 WHERE id = ?").get(turnId) as { phase: string }).phase, "completed");
        await assert.rejects(
          service.upsertTerminalSession({ ...session, threadId: "uncommitted-thread" }, commit),
          /terminal commit target mismatch/,
        );
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        assert.equal(getCached()[0]?.threadId, commit.threadId);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
        await service.deleteSession(session.id);
        await assert.rejects(service.upsertTerminalSession(session, commit), /対象セッションが見つからないよ/);
        assert.equal(storage.getSession(session.id), null);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.broadcasts, [[session.id], [session.id]]);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_turns_v6 WHERE id = ?").get(turnId) as { count: number }).count, 0);
      } finally {
        db.close();
      }
    });
  });
});
