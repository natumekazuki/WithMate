import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageListProjection } from "../../src/auxiliary-session-message-projection.js";
import { appendQueuedTurnsToMessageList } from "../../src/session-queued-turn-projection.js";
import type { SessionQueuedTurn } from "../../src/session-gui-execution.js";

function queuedTurn(executionId: string, queuePosition: number, userMessage: string): SessionQueuedTurn {
  return {
    executionId,
    sessionId: "session-1",
    clientRequestId: null,
    userMessage,
    queuePosition,
    canCancel: true,
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

  const projection = appendQueuedTurnsToMessageList(base, [
    queuedTurn("execution-2", 2, "三つ目"),
    queuedTurn("execution-1", 1, "二つ目"),
  ]);

  assert.deepEqual(projection.messages.map((message) => message.text), ["実行中", "二つ目", "三つ目"]);
  assert.deepEqual(projection.keys, [
    "session-session-1-0",
    "queued-turn-execution-1",
    "queued-turn-execution-2",
  ]);
  assert.equal(projection.sources[1]?.kind, "queued-turn");
  assert.equal(projection.queuedTurns[1]?.queuePosition, 1);
  assert.equal(projection.queuedTurns[2]?.queuePosition, 2);
});
