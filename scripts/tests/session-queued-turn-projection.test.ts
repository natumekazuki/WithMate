import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageListProjection } from "../../src/auxiliary-session-message-projection.js";
import { appendGuiTurnExecutionsToMessageList } from "../../src/session-queued-turn-projection.js";
import type {
  SessionQueuedTurn,
  SessionRunningTurn,
} from "../../src/session-gui-execution.js";
import {
  applySessionExecutionChangedEvent,
  applySessionExecutionChangedEventWithBarrier,
  createSessionRunningProjectionBarrier,
  mergeGuiTurnExecutionRefreshWithBarrier,
} from "../../src/session-gui-execution.js";

function queuedTurn(executionId: string, queuePosition: number, userMessage: string): SessionQueuedTurn {
  return {
    executionId,
    sessionId: "session-1",
    clientRequestId: null,
    userMessage,
    state: "queued",
    queuePosition,
    canCancel: true,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

function runningTurn(executionId: string, userMessage: string): SessionRunningTurn {
  return {
    executionId,
    sessionId: "session-1",
    clientRequestId: null,
    userMessage,
    state: "running",
    queuePosition: null,
    canCancel: false,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

test("queued Turnは既存message listの末尾へMainのFIFO位置順で投影する", () => {
  const base = buildMessageListProjection(
    [{ role: "user", text: "実行中" }],
    [],
    "session-1",
  );

  const projection = appendGuiTurnExecutionsToMessageList(base, [
    queuedTurn("execution-2", 2, "三つ目"),
    queuedTurn("execution-1", 1, "二つ目"),
  ], "running");

  assert.deepEqual(projection.messages.map((message) => message.text), ["実行中", "二つ目", "三つ目"]);
  assert.deepEqual(projection.keys, [
    "session-session-1-0",
    "gui-turn-execution-execution-1",
    "gui-turn-execution-execution-2",
  ]);
  assert.equal(projection.sources[1]?.kind, "gui-turn-execution");
  assert.equal(projection.queuedTurns[1]?.queuePosition, 1);
  assert.equal(projection.queuedTurns[2]?.queuePosition, 2);
});

test("runningへ昇格したGUI TurnはSession保存の反映前も同じ位置へ投影する", () => {
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
    ],
    [],
    "session-1",
  );

  const projection = appendGuiTurnExecutionsToMessageList(base, [
    queuedTurn("execution-3", 2, "三つ目"),
    runningTurn("execution-1", "二つ目"),
    queuedTurn("execution-2", 1, "その次"),
  ], "idle");

  assert.deepEqual(projection.messages.map((message) => message.text), [
    "一つ前の依頼",
    "一つ前の応答",
    "二つ目",
    "その次",
    "三つ目",
  ]);
  assert.equal(projection.sources[2]?.kind, "gui-turn-execution");
  assert.equal(projection.queuedTurns[2], null);
  assert.equal(projection.queuedTurns[3]?.executionId, "execution-2");
});

test("Session保存へ反映済みのrunning GUI Turnは重複投影しない", () => {
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
      { role: "user", text: "二つ目" },
    ],
    [],
    "session-1",
  );

  const projection = appendGuiTurnExecutionsToMessageList(base, [
    runningTurn("execution-1", "二つ目"),
    queuedTurn("execution-2", 1, "その次"),
  ], "running");

  assert.deepEqual(projection.messages.map((message) => message.text), [
    "一つ前の依頼",
    "一つ前の応答",
    "二つ目",
    "その次",
  ]);
  assert.equal(projection.sources[2]?.kind, "session");
  assert.equal(projection.queuedTurns[3]?.executionId, "execution-2");
});

test("running状態イベントを先に適用するとSession保存が続いても昇格Turnを重複投影しない", () => {
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
      { role: "user", text: "二つ目" },
    ],
    [],
    "session-1",
  );

  const executions = applySessionExecutionChangedEvent([
    queuedTurn("execution-1", 1, "二つ目"),
    queuedTurn("execution-2", 2, "その次"),
  ], {
    kind: "state-changed",
    sessionId: "session-1",
    executionId: "execution-1",
    state: "running",
  });
  const projection = appendGuiTurnExecutionsToMessageList(base, executions, "running");

  assert.deepEqual(projection.messages.map((message) => message.text), [
    "一つ前の依頼",
    "一つ前の応答",
    "二つ目",
    "その次",
  ]);
  assert.equal(projection.queuedTurns[2], null);
  assert.equal(projection.queuedTurns[3]?.executionId, "execution-2");
});

test("terminal状態イベントは対応するGUI executionだけを投影から除く", () => {
  const executions = applySessionExecutionChangedEvent([
    runningTurn("execution-1", "二つ目"),
    queuedTurn("execution-2", 1, "その次"),
  ], {
    kind: "state-changed",
    sessionId: "session-1",
    executionId: "execution-1",
    state: "completed",
  });

  assert.deepEqual(executions.map((execution) => execution.executionId), ["execution-2"]);
});

test("前Turnのrunning表示が残っていても昇格executionは永続化確認まで投影する", () => {
  const queued = queuedTurn("execution-1", 1, "二つ目");
  const event = {
    kind: "state-changed" as const,
    sessionId: "session-1",
    executionId: "execution-1",
    state: "running" as const,
  };
  const barrier = createSessionRunningProjectionBarrier(event);
  const executions = applySessionExecutionChangedEvent([queued], event);
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
    ],
    [],
    "session-1",
  );

  assert.deepEqual(barrier, { sessionId: "session-1", executionId: "execution-1" });
  assert.deepEqual(
    appendGuiTurnExecutionsToMessageList(base, executions, "running", barrier?.executionId).messages
      .map((message) => message.text),
    ["一つ前の依頼", "一つ前の応答", "二つ目"],
  );
});

test("running通知時にexecution一覧が空でも後続refreshのuserを永続化確認まで投影する", () => {
  const event = {
    kind: "state-changed" as const,
    sessionId: "session-1",
    executionId: "execution-1",
    state: "running" as const,
  };
  const barrier = createSessionRunningProjectionBarrier(event);
  const executions = mergeGuiTurnExecutionRefreshWithBarrier(
    applySessionExecutionChangedEvent([], event),
    [runningTurn("execution-1", "二つ目")],
    barrier,
  );
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
    ],
    [],
    "session-1",
  );

  assert.deepEqual(barrier, { sessionId: "session-1", executionId: "execution-1" });
  assert.deepEqual(
    appendGuiTurnExecutionsToMessageList(base, executions, "running", barrier?.executionId).messages
      .map((message) => message.text),
    ["一つ前の依頼", "一つ前の応答", "二つ目"],
  );
});

test("running refreshが通知より先着しても同じexecutionを永続化確認まで投影する", () => {
  const running = runningTurn("execution-1", "二つ目");
  const event = {
    kind: "state-changed" as const,
    sessionId: "session-1",
    executionId: "execution-1",
    state: "running" as const,
  };
  const barrier = createSessionRunningProjectionBarrier(event);
  const executions = applySessionExecutionChangedEventWithBarrier([running], event, null);
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
    ],
    [],
    "session-1",
  );

  assert.deepEqual(
    appendGuiTurnExecutionsToMessageList(base, executions, "running", barrier?.executionId).messages
      .map((message) => message.text),
    ["一つ前の依頼", "一つ前の応答", "二つ目"],
  );
});

test("terminal通知とactive refreshが先着しても永続Session hydrationまでは昇格userを保持する", () => {
  const running = runningTurn("execution-1", "二つ目");
  const barrier = { sessionId: "session-1", executionId: "execution-1" };
  const terminalEvent = {
    kind: "state-changed" as const,
    sessionId: "session-1",
    executionId: "execution-1",
    state: "completed" as const,
  };

  const afterTerminal = applySessionExecutionChangedEventWithBarrier(
    [running, queuedTurn("execution-2", 1, "その次")],
    terminalEvent,
    barrier,
  );
  const afterRefresh = mergeGuiTurnExecutionRefreshWithBarrier(
    afterTerminal,
    [queuedTurn("execution-2", 1, "その次")],
    barrier,
  );

  assert.deepEqual(afterRefresh.map((execution) => execution.executionId), ["execution-2", "execution-1"]);
});

test("live responseがSession hydrationより先着しても昇格userの直下へ配置する", () => {
  const base = buildMessageListProjection(
    [
      { role: "user", text: "一つ前の依頼" },
      { role: "assistant", text: "一つ前の応答" },
    ],
    [],
    "session-1",
    {
      liveAssistant: {
        sessionId: "session-1",
        threadId: "thread-1",
        messageIndex: 3,
        text: "二つ目の応答",
      },
    },
  );
  const projection = appendGuiTurnExecutionsToMessageList(
    base,
    [runningTurn("execution-1", "二つ目"), queuedTurn("execution-2", 1, "その次")],
    "running",
    "execution-1",
  );

  assert.deepEqual(projection.messages.map((message) => message.text), [
    "一つ前の依頼",
    "一つ前の応答",
    "二つ目",
    "二つ目の応答",
    "その次",
  ]);
});
