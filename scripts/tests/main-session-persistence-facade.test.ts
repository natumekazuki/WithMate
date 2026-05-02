import assert from "node:assert/strict";
import test from "node:test";

import { MainSessionPersistenceFacade } from "../../src-electron/main-session-persistence-facade.js";

test("MainSessionPersistenceFacade は upsert/replaceAll を SessionPersistenceService へ委譲する", async () => {
  const calls: string[] = [];
  const facade = new MainSessionPersistenceFacade({
    getSessions: () => [],
    setSessions: () => undefined,
    getSessionPersistenceService: () =>
      ({
        upsertSession(session) {
          calls.push(`upsert:${session.id}`);
          return session as never;
        },
        replaceAllSessions(sessions) {
          calls.push(`replace:${sessions.length}`);
          return sessions as never;
        },
      }) as never,
    getSessionStorage: () => ({ listSessionSummaries: () => [], getSession: () => null }) as never,
  });

  await facade.upsertSession({ id: "s-1" } as never);
  await facade.replaceAllSessions([{ id: "s-1" }] as never);

  assert.deepEqual(calls, ["upsert:s-1", "replace:1"]);
});

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
      messages: [],
      stream: [],
    },
  ];
  const upserted: string[] = [];
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
        upsertSession(session) {
          upserted.push(`${session.id}:${session.runState}:${session.messages.length}:${session.messages.at(-1)?.text}`);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        getSession(sessionId) {
          return sessionId === "s-1" ? hydratedSession : null;
        },
        listSessionSummaries() {
          return storedSessionSummaries as never;
        },
      }) as never,
  });

  await facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, [`s-1:interrupted:2:${expectedInterruptedMessage}`]);
  assert.deepEqual(setSessionsPayload, expectedSetSessionsPayload);
});

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
        upsertSession(session) {
          upserted.push(`${session.id}:${session.runState}:${session.messages.length}`);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        getSession(sessionId) {
          return sessionId === "s-1" ? hydratedSession : null;
        },
        listSessionSummaries() {
          return [] as never;
        },
      }) as never,
  });

  await facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, ["s-1:interrupted:2"]);
});

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
        upsertSession(session) {
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

test("MainSessionPersistenceFacade は running session がなければ storage を読まない", async () => {
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
    getSessionStorage: () => {
      throw new Error("running session がない時は storage を読まない");
    },
  });

  await facade.recoverInterruptedSessions();
});
