import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnTerminalCommit } from "../../src-electron/session/session-turn-terminal-commit.js";
import { MainSessionPersistenceFacade } from "../../src-electron/app/main-session-persistence-facade.js";

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
test("MainSessionPersistenceFacade は upsert/replaceAll を SessionPersistenceService へ委譲する", async () => {
  const session = { id: "s-1", status: "idle", runState: "idle", messages: [] } as never as Session;
  const terminalCommit = {
    auditLogId: 4,
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
  const returnedTerminalSession = { ...session, runState: "completed" } as Session;
  const returnedPinnedSession = { ...session, taskTitle: "pinned" } as Session;
  const returnedSessions = [{ ...session, taskTitle: "replaced" }] as Session[];
  const calls: unknown[] = [];
  const facade = new MainSessionPersistenceFacade({
    getSessions: () => [],
    setSessions: () => undefined,
    getSessionPersistenceService: () =>
      ({
        upsertSession(session: Session) {
          calls.push({ method: "upsertSession", session });
          return returnedSession;
        },
        upsertTerminalSession(session: Session, terminalCommit: SessionTurnTerminalCommit) {
          calls.push({ method: "upsertTerminalSession", session, terminalCommit });
          return returnedTerminalSession;
        },
        upsertSessionPreservingPin(session: Session) {
          calls.push({ method: "upsertSessionPreservingPin", session });
          return returnedPinnedSession;
        },
        replaceAllSessions(sessions: Session[], options?: { broadcast?: boolean; invalidateSessionIds?: Iterable<string> }) {
          calls.push({ method: "replaceAllSessions", sessions, options: options ? {
            broadcast: options.broadcast,
            invalidateSessionIds: [...(options.invalidateSessionIds ?? [])],
          } : undefined });
          return returnedSessions;
        },
      }) as never,
    getSessionStorage: () => ({ listSessionSummaries: () => [], getSession: () => null }) as never,
  });

  assert.strictEqual(await facade.upsertSession(session), returnedSession);
  assert.strictEqual(await facade.upsertTerminalSession(session, terminalCommit), returnedTerminalSession);
  assert.strictEqual(await facade.upsertSessionPreservingPin(session), returnedPinnedSession);
  assert.strictEqual(await facade.replaceAllSessions(replacementSessions, replaceOptions), returnedSessions);

  assert.deepEqual(calls, [
    { method: "upsertSession", session },
    { method: "upsertTerminalSession", session, terminalCommit },
    { method: "upsertSessionPreservingPin", session },
    { method: "replaceAllSessions", sessions: replacementSessions, options: replaceOptions },
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "running sessionの復旧時に詳細hydrateとinterrupted message追加を一度だけ行う"
// oracle = { type = "contract", ref = "src-electron/app/main-session-persistence-facade.ts#recoverInterruptedSessions" }
// fault = "保存済みsummaryとdetailの対応を誤り、復旧状態または通知messageを失う"
// observable = "hydrateされたsessionのupsert結果とsetSessions投影"
// observation_boundary = "public-boundary"
// scope = "session-recovery"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionPersistenceFacade は running session を詳細 hydrate して interrupted に変換する", async () => {
  const storedSessionSummaries = [
    {
      id: "s-1",
      status: "idle",
      runState: "interrupted",
      updatedAt: "2026-03-28 10:00:00",
      taskTitle: "Recovered",
    },
  ];
  const hydratedSession = {
    id: "s-1",
    status: "running",
    runState: "running",
    updatedAt: "2026-03-28 09:00:00",
    taskTitle: "Recovered",
    messages: [
      { role: "user", text: "hello" },
    ],
  };
  const expectedInterruptedMessage = "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
  const expectedSetSessionsPayload = [
    {
      id: "s-1",
      taskTitle: "Recovered",
      status: "idle",
      runState: "interrupted",
      updatedAt: "2026-03-28 10:00:00",
      characterRuntimeSnapshot: null,
      messages: [],
      stream: [],
    },
  ];
  const upserted: string[] = [];
  let getSessionCalls = 0;
  let listSessionSummariesCalls = 0;
  let setSessionsPayload: unknown = null;
  const facade = new MainSessionPersistenceFacade({
    getSessions: () =>
      [
        {
          id: "s-1",
          status: "running",
          runState: "running",
          updatedAt: "2026-03-28 09:00:00",
          messages: [],
        },
      ] as never,
    setSessions: (nextSessions) => {
      setSessionsPayload = nextSessions;
    },
    getSessionPersistenceService: () =>
      ({
        upsertSession(session: Session) {
          upserted.push(`${session.id}:${session.status}:${session.runState}:${session.messages.length}:${session.messages.at(-1)?.text}`);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        getSession(sessionId: string) {
          getSessionCalls += 1;
          return sessionId === "s-1" ? hydratedSession : null;
        },
        listSessionSummaries() {
          listSessionSummariesCalls += 1;
          return storedSessionSummaries as never;
        },
      }) as never,
  });

  await facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, [`s-1:idle:interrupted:2:${expectedInterruptedMessage}`]);
  assert.deepEqual(setSessionsPayload, expectedSetSessionsPayload);
  assert.equal(getSessionCalls, 1);
  assert.equal(listSessionSummariesCalls, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "既存のinterrupted messageを復旧処理で重複追加しない"
// oracle = { type = "contract", ref = "src-electron/app/main-session-persistence-facade.ts#recoverInterruptedSessions" }
// fault = "再起動のたびに同一の中断通知がsessionへ蓄積する"
// observable = "upsertされたmessage数と最終message"
// observation_boundary = "public-boundary"
// scope = "session-recovery"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionPersistenceFacade は既存 interrupted message を重複追加しない", async () => {
  const interruptedMessage = "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
  const hydratedSession = {
    id: "s-1",
    status: "running",
    runState: "running",
    updatedAt: "2026-03-28 09:00:00",
    taskTitle: "Recovered",
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: interruptedMessage, accent: true },
    ],
  };
  const upserted: string[] = [];
  const facade = new MainSessionPersistenceFacade({
    getSessions: () =>
      [
        {
          id: "s-1",
          status: "running",
          runState: "running",
          updatedAt: "2026-03-28 09:00:00",
          messages: [],
        },
      ] as never,
    setSessions: () => undefined,
    getSessionPersistenceService: () =>
      ({
        upsertSession(session: Session) {
          upserted.push(`${session.id}:${session.runState}:${session.messages.length}:${session.messages.at(-1)?.text}`);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        getSession(sessionId: string) {
          return sessionId === "s-1" ? hydratedSession : null;
        },
        listSessionSummaries() {
          return [] as never;
        },
      }) as never,
  });

  await facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, [`s-1:interrupted:2:${interruptedMessage}`]);
});

// @test-value v2
// kind = "contract"
// claim = "detail hydrateできないrunning sessionを保存更新せずskipする"
// oracle = { type = "contract", ref = "src-electron/app/main-session-persistence-facade.ts#recoverInterruptedSessions" }
// fault = "存在しないdetailを成功扱いし、壊れたsessionを上書きする"
// observable = "persistence serviceのupsert呼出し不在"
// observation_boundary = "public-boundary"
// scope = "session-recovery"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionPersistenceFacade は hydrate できない running session を skip する", async () => {
  const upserted: string[] = [];
  const facade = new MainSessionPersistenceFacade({
    getSessions: () =>
      [
        {
          id: "s-1",
          status: "running",
          runState: "running",
          updatedAt: "2026-03-28 09:00:00",
          messages: [],
        },
      ] as never,
    setSessions: () => undefined,
    getSessionPersistenceService: () =>
      ({
        upsertSession(session: Session) {
          upserted.push(session.id);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        getSession() {
          return null;
        },
        listSessionSummaries() {
          return [] as never;
        },
      }) as never,
  });

  await facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, []);
});

// @test-value v2
// kind = "contract"
// claim = "running sessionがない場合は詳細storageを読まず復旧処理を終了する"
// oracle = { type = "contract", ref = "src-electron/app/main-session-persistence-facade.ts#recoverInterruptedSessions" }
// fault = "不要なstorage readを行い、通常sessionの復旧状態を変える"
// observable = "session storage portのgetSession呼出しとupsert呼出しの不在"
// observation_boundary = "implementation"
// scope = "session-recovery"
// lifecycle = "permanent"
// @end-test-value
test("MainSessionPersistenceFacade は running session がなければ storage を読まない", async () => {
  let storagePortCalls = 0;
  const facade = new MainSessionPersistenceFacade({
    getSessions: () =>
      [
        {
          id: "s-1",
          status: "idle",
          runState: "idle",
          updatedAt: "2026-03-28 09:00:00",
          messages: [],
        },
      ] as never,
    setSessions: () => undefined,
    getSessionPersistenceService: () => ({}) as never,
    getSessionStorage: () => ({
      getSession() {
        storagePortCalls += 1;
        throw new Error("running session がない時は storage port を読まない");
      },
    }) as never,
  });

  await facade.recoverInterruptedSessions();
  assert.equal(storagePortCalls, 0);
});
