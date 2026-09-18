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
  sharedState: { cached: Session[]; revoked: string[] } = { cached: [session], revoked: [] },
): { service: SessionPersistenceService; getCached: () => Session[]; state: typeof sharedState } {
  const service = new SessionPersistenceService({
    getSessions: () => sharedState.cached,
    setSessions: (next) => { sharedState.cached = next; },
    getSession: (sessionId) => sharedState.cached.find((entry) => entry.id === sessionId) ?? null,
    isSessionRunInFlight: () => false,
    upsertStoredSession: updateStoredSession,
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
    broadcastSessions: () => undefined,
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
  // distinction = "通常のupsert/create互換ではなく、update-only APIの不在時動作を直接確認する"
  // @end-test-value
  it("deleted session is not recreated by update-only storage", async () => {
    await withStorage(async (storage) => {
      const session = createSession("deleted-before-update");
      storage.insertSession(session);
      storage.deleteSession(session.id);

      assert.throws(
        () => storage.updateSession({ ...session, taskTitle: "stale update" }),
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
  // observable = "update結果の拒否、storageの行、service cache"
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
        storage.insertSession(session);
        let release!: () => void;
        let reached!: () => void;
        const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
        const barrier = new Promise<void>((resolve) => { release = resolve; });
        const sharedState = { cached: [session], revoked: [] as string[] };
        const { service, getCached } = createService(storage, session, async (next, operation) => {
          assert.equal(operation, "upsert");
          reached();
          await barrier;
          return storage.updateSession(next);
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
        release();
        await assert.rejects(update, /対象セッションが見つからないよ/);
        assert.equal(storage.getSession(session.id), null);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.revoked, [session.id]);
      }
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "terminal updateは既存Sessionとrunning markerに対してのみatomicに確定する"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除済みSessionへのterminal保存がSessionやterminal markerを再作成する"
  // observable = "Session行とsession_turns_v6のphase"
  // observation_boundary = "public-boundary"
  // scope = "session-terminal-update-only"
  // lifecycle = "permanent"
  // impact = "Session本文とterminal markerの不一致や、削除した会話の復活によるデータ保全違反を防ぐ"
  // distinction = "既存terminal atomic commitのmarker更新と削除済みowner拒否を同じ一時V6 DBで確認する"
  // @end-test-value
  it("rejects deleted terminal owner and commits marker for existing owner", async () => {
    await withStorage(async (storage, dbPath) => {
      const session = createSession("terminal-owner");
      storage.insertSession(session);
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
        storage.updateTerminalSession({ ...session, threadId: commit.threadId }, commit);
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        assert.equal((db.prepare("SELECT phase FROM session_turns_v6 WHERE id = ?").get(turnId) as { phase: string }).phase, "completed");
        assert.throws(
          () => storage.updateTerminalSession({ ...session, threadId: "uncommitted-thread" }, commit),
          /terminal commit target mismatch/,
        );
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        storage.deleteSession(session.id);
        assert.throws(() => storage.updateTerminalSession(session, commit), /対象セッションが見つからないよ/);
        assert.equal(storage.getSession(session.id), null);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM session_turns_v6 WHERE id = ?").get(turnId) as { count: number }).count, 0);
      } finally {
        db.close();
      }
    });
  });
});
