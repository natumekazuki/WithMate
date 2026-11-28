import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import {
  buildNewSession,
  type Session,
} from "../../src-shared/session/session-state.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import { createSessionStorageCommandAdapter } from "../../src-electron/session/session-storage-command-adapter.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

/** 同一IDの削除・再作成を比較できるよう、IDと更新時刻を指定したSessionを作る。 */
function createSession(
  id: string,
  updatedAt = "2026-09-19T00:00:00.000Z",
): Session {
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

/** 一時SQLiteストアを用意して検証を実行し、終了時はDBを閉じて試験ディレクトリーを削除する。 */
async function withStorage<T>(
  run: (storage: SessionStorageV6, dbPath: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "withmate-session-update-only-"),
  );
  const storage = new SessionStorageV6(path.join(root, "app.db"));
  try {
    return await run(storage, path.join(root, "app.db"));
  } finally {
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** 永続化の依存先を差し替え、更新拒否時にキャッシュと失効・配信記録が変化しないかを観測する。 */
function createService(
  storage: SessionStorageV6,
  session: Session,
  updateStoredSession: (
    next: Session,
    operation: "create" | "upsert",
  ) => Promise<Session>,
  sharedState: {
    cached: Session[];
    revoked: string[];
    broadcasts: string[][];
  } = { cached: [session], revoked: [], broadcasts: [] },
  updateStoredTerminalSession?: (
    next: Session,
    terminalCommit: Parameters<
      SessionPersistenceService["upsertTerminalSession"]
    >[1],
  ) => Promise<Session>,
): {
  service: SessionPersistenceService;
  getCached: () => Session[];
  state: typeof sharedState;
} {
  const service = new SessionPersistenceService({
    /** 永続化サービスが一覧として参照する現在のキャッシュを返す。 */
    getSessions: () => sharedState.cached,
    /** 更新後のキャッシュを後続のID検索とテストの照合に使えるよう保持する。 */
    setSessions: (next) => {
      sharedState.cached = next;
    },
    /** ID単位のサービス参照はキャッシュだけから解決する。 */
    getSession: (sessionId) =>
      sharedState.cached.find((entry) => entry.id === sessionId) ?? null,
    /** 実行中ガードとは独立して削除との競合を調べるため、実行中のターンなしとする。 */
    isSessionRunInFlight: () => false,
    upsertStoredSession: updateStoredSession,
    upsertStoredTerminalSession: updateStoredTerminalSession,
    /** 削除操作を実SQLiteストアへ渡す。 */
    deleteStoredSessions: (sessionIds) => storage.deleteSessions(sessionIds),
    /** 全置換は対象外なので、スタブではストアを書き換えない。 */
    replaceStoredSessions: () => undefined,
    /** DBの生存行を実ストレージの一覧から返す。 */
    listStoredSessions: () => storage.listSessions(),
    /** 期間削除の候補IDの判定を実ストレージへ任せる。 */
    listStoredSessionIdsLastActiveBefore: (cutoff) =>
      storage.listSessionIdsLastActiveBefore(cutoff),
    /** 永続化の競合に無関係なアプリ設定は既定値で揃える。 */
    getAppSettings: () => normalizeAppSettings({}),
    /** Session更新で参照する固定のCodexモデル設定を提供する。 */
    getModelCatalogSnapshot: () => ({
      revision: 1,
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-test",
          defaultReasoningEffort: "medium",
          models: [
            { id: "gpt-test", label: "Test", reasoningEfforts: ["medium"] },
          ],
        },
      ],
    }),

    /** 削除時の測定値消去は記録せず、DB・キャッシュ・配信を観測する。 */
    clearSessionContextTelemetry: () => undefined,

    /** Providerスレッド自体への外部無効化は呼ばない。 */
    invalidateProviderSessionThread: () => undefined,
    /** 削除が取り消した実行バインディングをSession ID単位で記録する。 */
    revokeSessionAgentRuntimeBindings: (sessionId) => {
      sharedState.revoked.push(sessionId);
    },
    /** 実Windowは作らないため、削除後の閉じ処理でUIを操作しない。 */
    closeSessionWindow: () => undefined,
    /** 成功または削除で配信対象になったIDを、呼び出しごとに保持する。 */
    broadcastSessions: (sessionIds) => {
      sharedState.broadcasts.push([...(sessionIds ?? [])]);
    },
  });
  return {
    service,
    /** 配信や更新後のキャッシュをテスト側から最新状態で参照する。 */
    getCached: () => sharedState.cached,
    state: sharedState,
  };
}

/** 既存Sessionの更新と終端確定が、削除・ID再利用をまたいで古い行を復活させないことを検証する。 */
describe("Session update-only persistence", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "既存Session限定のupdateは削除後にSessionを復活させない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除後のstale updateがupsertとしてSession行を再作成する"
  // observable = "updateのSessionNotFoundErrorとlistSessionsの結果"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-update-only"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのprovider bindingやcache投影の復活を防ぐ"
  // distinction = "通常のupsert/create互換ではなく、production adapterのupdate-only API経由で削除済み行への更新拒否を確認する"
  // @end-test-value
  /** 削除済みIDの更新をストレージが拒否し、そのIDが一覧に再作成されない。 */
  it("deleted session is not recreated by update-only storage", async () => {
    await withStorage(async (storage) => {
      const session = createSession("deleted-before-update");
      const commands = createSessionStorageCommandAdapter(() => storage);
      const storedSession = commands.upsertStoredSession(
        session,
        "create",
      ) as Session;
      storage.deleteSession(session.id);

      assert.throws(
        () =>
          commands.upsertStoredSession(
            { ...storedSession, taskTitle: "stale update" },
            "upsert",
          ),
        (error: unknown) =>
          error instanceof Error && error.name === "SessionNotFoundError",
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
  /** 更新待ち中に個別・期間削除が確定したら、更新再開時にDBやキャッシュを復活させず、失敗の配信も追加しない。 */
  it("does not resurrect after deferred update and deletion", async () => {
    await withStorage(async (storage) => {
      for (const deletion of ["single", "cutoff"] as const) {
        const session = createSession(`race-${deletion}`);
        const commands = createSessionStorageCommandAdapter(() => storage);
        const storedSession = commands.upsertStoredSession(
          session,
          "create",
        ) as Session;
        let release!: () => void;
        let reached!: () => void;
        const reachedPromise = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const sharedState = {
          cached: [storedSession],
          revoked: [] as string[],
          broadcasts: [] as string[][],
        };
        const { service, getCached } = createService(
          storage,
          storedSession,
          async (next, operation) => {
            assert.equal(operation, "upsert");
            reached();
            await barrier;
            return commands.upsertStoredSession(next, operation);
          },
          sharedState,
        );
        const update = service.updateSession({
          ...storedSession,
          taskTitle: "stale update",
        });
        await reachedPromise;
        const deleteResult =
          deletion === "single"
            ? await service.deleteSession(session.id)
            : await service.deleteSessionsLastActiveBefore({
                cutoffDate: "2026-09-20",
                cutoffIso: "2026-09-20T00:00:00.000Z",
                cutoffTimestampMs: Date.parse("2026-09-20T00:00:00.000Z"),
              });
        assert.deepEqual(deleteResult.deletedSessionIds, [session.id]);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.revoked, [session.id]);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
        release();
        await assert.rejects(update, /The session could not be found/);
        assert.equal(storage.getSession(session.id), null);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.revoked, [session.id]);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
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
  /** 本番ストレージアダプターで成功した更新はDBとキャッシュに反映され、更新したIDを一度配信する。 */
  it("projects successful adapter update to cache and broadcast", async () => {
    await withStorage(async (storage) => {
      const session = createSession("successful-adapter-update");
      const commands = createSessionStorageCommandAdapter(() => storage);
      const storedSession = commands.upsertStoredSession(
        session,
        "create",
      ) as Session;
      const sharedState = {
        cached: [storedSession],
        revoked: [] as string[],
        broadcasts: [] as string[][],
      };
      const { service, getCached } = createService(
        storage,
        storedSession,
        async (next, operation) =>
          commands.upsertStoredSession(next, operation),
        sharedState,
      );

      const updated = await service.updateSession({
        ...storedSession,
        threadId: "updated-through-adapter",
      });

      assert.equal(updated.threadId, "updated-through-adapter");
      assert.equal(getCached()[0]?.threadId, "updated-through-adapter");
      assert.deepEqual(sharedState.broadcasts, [[storedSession.id]]);
      assert.equal(
        storage.getSession(session.id)?.threadId,
        "updated-through-adapter",
      );
    });
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "同じSession IDを再利用した場合、旧incarnationの通常更新とterminal保存は新しい行へ適用されない"
  // oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#session-delete" }
  // fault = "削除後に同じIDで再作成されたSessionへstale updateまたはterminal commitが本文・threadを上書きする"
  // observable = "incarnationIdの差異、旧更新と旧terminal保存の拒否、新行・running marker・cache・broadcastの不変、現行incarnationによる更新成功"
  // observation_boundary = "public-boundary"
  // scope = "session-storage-v6-incarnation-update-only"
  // lifecycle = "permanent"
  // impact = "削除済みSessionのstale処理が新しい会話へ混入することを防ぐ"
  // distinction = "同じID・同じupdatedAt・同じ内容を再利用したABA競合を、通常更新とterminal保存の両方で確認する"
  // @end-test-value
  /** 同じIDを再作成した場合は旧世代の通常・終端更新を拒否し、新世代の行と配信を保つ。 */
  it("rejects stale updates after same-id session recreation", async () => {
    await withStorage(async (storage, dbPath) => {
      const first = storage.insertSession(createSession("same-id-recreated"));
      const commands = createSessionStorageCommandAdapter(() => storage);
      const { service, state } = createService(
        storage,
        first,
        async (next, operation) =>
          commands.upsertStoredSession(next, operation),
        undefined,
        async (next, commit) =>
          commands.upsertStoredTerminalSession(next, commit),
      );
      await service.deleteSession(first.id);
      const recreated = await service.upsertSession({ ...first }, "create");
      const broadcastsBefore = structuredClone(state.broadcasts);
      const cacheBefore = structuredClone(state.cached);
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          `INSERT INTO session_turns_v6 (session_id, phase, started_at, updated_at)
          VALUES (?, 'running', ?, ?)`,
        ).run(first.id, first.updatedAt, first.updatedAt);
        const marker = db
          .prepare(
            "SELECT id, phase FROM session_turns_v6 WHERE session_id = ?",
          )
          .get(first.id) as { id: number; phase: string };
        assert.notEqual(first.incarnationId, recreated.incarnationId);
        await assert.rejects(
          service.updateSession({ ...first, taskTitle: "stale update" }),
          (error: unknown) =>
            error instanceof Error && error.name === "SessionNotFoundError",
        );
        await assert.rejects(
          service.upsertTerminalSession(
            { ...first, threadId: "stale-thread" },
            {
              turnId: marker.id,
              sessionId: first.id,
              phase: "completed",
              assistantMessageSeq: 0,
              threadId: "stale-thread",
              errorMessage: "",
              completedAt: first.updatedAt,
            },
          ),
          (error: unknown) =>
            error instanceof Error && error.name === "SessionNotFoundError",
        );
        assert.deepEqual(storage.getSession(recreated.id), recreated);
        assert.deepEqual(
          db
            .prepare(
              "SELECT id, phase FROM session_turns_v6 WHERE session_id = ?",
            )
            .get(first.id),
          marker,
        );
        assert.deepEqual(state.cached, cacheBefore);
        assert.deepEqual(state.broadcasts, broadcastsBefore);
        const updated = await service.updateSession({
          ...recreated,
          threadId: "fresh-update-thread",
        });
        assert.equal(updated.threadId, "fresh-update-thread");
        assert.equal(updated.incarnationId, recreated.incarnationId);
      } finally {
        db.close();
      }
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
  /** 終端更新は現行行と一致するrunning markerを一緒に確定し、不一致や削除済みではDB・キャッシュ・配信を変えない。 */
  it("rejects deleted terminal owner and commits marker for existing owner", async () => {
    await withStorage(async (storage, dbPath) => {
      const session = createSession("terminal-owner");
      const commands = createSessionStorageCommandAdapter(() => storage);
      const storedSession = commands.upsertStoredSession(
        session,
        "create",
      ) as Session;
      const sharedState = {
        cached: [storedSession],
        revoked: [] as string[],
        broadcasts: [] as string[][],
      };
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          `
          INSERT INTO session_turns_v6 (
            session_id, auxiliary_session_id, phase, assistant_message_seq,
            started_at, completed_at, updated_at
          ) VALUES (?, NULL, 'running', NULL, ?, NULL, ?)
        `,
        ).run(session.id, session.updatedAt, session.updatedAt);
        const turnId = Number(
          (
            db
              .prepare("SELECT id FROM session_turns_v6 WHERE session_id = ?")
              .get(session.id) as { id: number }
          ).id,
        );
        const commit = {
          turnId,
          sessionId: session.id,
          phase: "completed" as const,
          assistantMessageSeq: 0,
          threadId: "thread-terminal",
          errorMessage: "",
          completedAt: "2026-09-19T00:01:00.000Z",
        };
        const { service, getCached } = createService(
          storage,
          storedSession,
          async (next, operation) =>
            commands.upsertStoredSession(next, operation),
          sharedState,
          async (next, terminalCommit) =>
            commands.upsertStoredTerminalSession(next, terminalCommit),
        );
        await service.upsertTerminalSession(
          { ...storedSession, threadId: commit.threadId },
          commit,
        );
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        assert.equal(getCached()[0]?.threadId, commit.threadId);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
        assert.equal(
          (
            db
              .prepare("SELECT phase FROM session_turns_v6 WHERE id = ?")
              .get(turnId) as { phase: string }
          ).phase,
          "completed",
        );
        const markerBeforeMismatch = db
          .prepare("SELECT * FROM session_turns_v6 WHERE id = ?")
          .get(turnId);
        await assert.rejects(
          service.upsertTerminalSession(
            { ...storedSession, threadId: "uncommitted-thread" },
            commit,
          ),
          /terminal commit target mismatch/,
        );
        assert.deepEqual(
          db.prepare("SELECT * FROM session_turns_v6 WHERE id = ?").get(turnId),
          markerBeforeMismatch,
        );
        assert.equal(storage.getSession(session.id)?.threadId, commit.threadId);
        assert.equal(getCached()[0]?.threadId, commit.threadId);
        assert.deepEqual(sharedState.broadcasts, [[session.id]]);
        await service.deleteSession(session.id);
        await assert.rejects(
          service.upsertTerminalSession(storedSession, commit),
          /The session could not be found/,
        );
        assert.equal(storage.getSession(session.id), null);
        assert.deepEqual(getCached(), []);
        assert.deepEqual(sharedState.broadcasts, [[session.id], [session.id]]);
        assert.equal(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM session_turns_v6 WHERE id = ?",
              )
              .get(turnId) as { count: number }
          ).count,
          0,
        );
      } finally {
        db.close();
      }
    });
  });
});
