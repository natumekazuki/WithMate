import assert from "node:assert/strict";
import test from "node:test";

import { MainSessionPersistenceFacade } from "../../src-electron/main-session-persistence-facade.js";

test("MainSessionPersistenceFacade は upsert/replaceAll を SessionPersistenceService へ委譲する", () => {
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
    getSessionStorage: () => ({ listSessions: () => [] }) as never,
  });

  facade.upsertSession({ id: "s-1" } as never);
  facade.replaceAllSessions([{ id: "s-1" }] as never);

  assert.deepEqual(calls, ["upsert:s-1", "replace:1"]);
});

test("MainSessionPersistenceFacade は running session を interrupted に変換して再保存する", () => {
  const storedSessions = [
    {
      id: "s-1",
      status: "idle",
      runState: "interrupted",
      updatedAt: "2026-03-28 10:00:00",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。", accent: true },
      ],
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
          messages: [{ role: "user", text: "hello" }],
        },
      ] as never,
    setSessions: (nextSessions) => {
      setSessionsPayload = nextSessions;
    },
    getSessionPersistenceService: () =>
      ({
        upsertSession(session) {
          upserted.push(`${session.id}:${session.runState}:${session.messages.length}`);
          return session as never;
        },
      }) as never,
    getSessionStorage: () =>
      ({
        listSessions() {
          return storedSessions as never;
        },
      }) as never,
  });

  facade.recoverInterruptedSessions();

  assert.deepEqual(upserted, ["s-1:interrupted:2"]);
  assert.equal(setSessionsPayload, storedSessions);
});
