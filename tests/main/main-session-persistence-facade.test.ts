import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "../../src-electron/session/session-turn-terminal-commit.js";
import { MainSessionPersistenceFacade } from "../../src-electron/app/main-session-persistence-facade.js";

// @test-value v2
// kind = "contract"
// claim = "title専用facadeは保存済み通知失敗の結果と保存前rejectを呼出側へそのまま伝える"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md#実行設定と-send" }
// fault = "facadeがcommit結果をvoidへ捨てるか保存前失敗を成功応答へ変換する"
// observable = "title facade応答、serviceに渡るowner/title、保存前例外"
// observation_boundary = "public-boundary"
// scope = "main-title-facade-result"
// lifecycle = "permanent"
// impact = "呼出側がcommit済み通知失敗を識別できず表示復旧できない"
// distinction = "service testでは通らないfacadeの結果転送を確認し、小さいstubだけで実行する"
// @end-test-value
/** タイトルの変更では、保存済みだが通知に失敗した結果も、保存前の拒否も、所有者とタイトルの引数を変えずに呼び出し側へ伝える。 */
test("title facadeはcommit結果と保存前失敗を保持する", async () => {
  const calls: unknown[] = [];
  let failure: Error | null = null;
  const result = { status: "committed", projectionUpdated: false } as const;
  const facade = new MainSessionPersistenceFacade({
    /** タイトル専用の保存操作を持つ代替サービスを返す。 */
    getSessionPersistenceService: () =>
      ({
        /** 渡された引数を記録し、保存前の例外と保存後の通知失敗を切り替える。 */
        setSessionTitle: async (...args: unknown[]) => {
          calls.push(args);
          if (failure) throw failure;
          return result;
        },
      }) as never,
  });
  assert.strictEqual(
    await facade.setSessionTitle("session", "owner", "After"),
    result,
  );
  failure = new Error("storage failed");
  await assert.rejects(
    facade.setSessionTitle("session", "owner", "Rejected"),
    failure,
  );
  assert.deepEqual(calls, [
    ["session", "owner", "After"],
    ["session", "owner", "Rejected"],
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "MainSessionPersistenceFacadeがsession persistence操作を対応するserviceへ委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-session-persistence-facade.ts" }
// fault = "upsert、terminal commit、replaceAllの入力または順序がfacade境界で失われる"
// observable = "persistence serviceへ渡されたsessionとterminal commit"
// observation_boundary = "public-boundary"
// scope = "main-session-persistence-facade"
// lifecycle = "permanent"
// @end-test-value
/** 通常保存・終了ターンの保存・ピン保持・一括置換を対応する操作へ順番どおり渡し、各保存結果をそのまま返す。 */
test("MainSessionPersistenceFacade は upsert/replaceAll を SessionPersistenceService へ委譲する", async () => {
  const session = {
    id: "s-1",
    status: "idle",
    runState: "idle",
    messages: [],
  } as never as Session;
  const terminalCommit = {
    turnId: 4,
    sessionId: "s-1",
    phase: "completed",
    assistantMessageSeq: 1,
    threadId: "",
    errorMessage: "",
    completedAt: "2026-08-16T00:00:00.000Z",
  } as SessionTurnTerminalCommit;
  const replacementSessions = [session];
  const replaceOptions = { broadcast: true, invalidateSessionIds: ["s-1"] };
  const returnedSession = { ...session, status: "running" } as Session;
  const returnedTerminalSession = {
    ...session,
    runState: "completed",
  } as Session;
  const returnedPinnedSession = { ...session, taskTitle: "pinned" } as Session;
  const returnedSessions = [{ ...session, taskTitle: "replaced" }] as Session[];
  const calls: unknown[] = [];
  const facade = new MainSessionPersistenceFacade({
    /** 委譲先の違いを呼び出し記録と個別の戻り値で識別できるようにする。 */
    getSessionPersistenceService: () =>
      ({
        /** 通常の保存先に届いたセッションを記録する。 */
        upsertSession(session: Session) {
          calls.push({ method: "upsertSession", session });
          return returnedSession;
        },
        /** 終了時の保存先にセッションとターン完了情報の両方が届いたことを記録する。 */
        upsertTerminalSession(
          session: Session,
          terminalCommit: SessionTurnTerminalCommit,
        ) {
          calls.push({
            method: "upsertTerminalSession",
            session,
            terminalCommit,
          });
          return returnedTerminalSession;
        },
        /** ピンを保持する保存操作が通常の保存とは別に呼ばれたことを記録する。 */
        upsertSessionPreservingPin(session: Session) {
          calls.push({ method: "upsertSessionPreservingPin", session });
          return returnedPinnedSession;
        },
        /** 一括置換に渡されたセッション一覧、通知指定、無効化対象を比較できる形で記録する。 */
        replaceAllSessions(
          sessions: Session[],
          options?: {
            broadcast?: boolean;
            invalidateSessionIds?: Iterable<string>;
          },
        ) {
          calls.push({
            method: "replaceAllSessions",
            sessions,
            options: options
              ? {
                  broadcast: options.broadcast,
                  invalidateSessionIds: [
                    ...(options.invalidateSessionIds ?? []),
                  ],
                }
              : undefined,
          });
          return returnedSessions;
        },
      }) as never,
  });

  assert.strictEqual(await facade.upsertSession(session), returnedSession);
  assert.strictEqual(
    await facade.upsertTerminalSession(session, terminalCommit),
    returnedTerminalSession,
  );
  assert.strictEqual(
    await facade.upsertSessionPreservingPin(session),
    returnedPinnedSession,
  );
  assert.strictEqual(
    await facade.replaceAllSessions(replacementSessions, replaceOptions),
    returnedSessions,
  );

  assert.deepEqual(calls, [
    { method: "upsertSession", session },
    { method: "upsertTerminalSession", session, terminalCommit },
    { method: "upsertSessionPreservingPin", session },
    {
      method: "replaceAllSessions",
      sessions: replacementSessions,
      options: replaceOptions,
    },
  ]);
});
