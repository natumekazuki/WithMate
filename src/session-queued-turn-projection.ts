import type { MessageListProjection } from "./auxiliary-session-message-projection.js";
import type { SessionQueuedTurn } from "./session-gui-execution.js";

export type SessionQueuedTurnMessageProjection = MessageListProjection & {
  queuedTurns: Array<SessionQueuedTurn | null>;
};

export function appendQueuedTurnsToMessageList(
  projection: MessageListProjection,
  queuedTurns: SessionQueuedTurn[],
): SessionQueuedTurnMessageProjection {
  const sortedQueuedTurns = [...queuedTurns].sort((left, right) => (
    left.queuePosition - right.queuePosition || left.executionId.localeCompare(right.executionId)
  ));
  return {
    messages: [
      ...projection.messages,
      ...sortedQueuedTurns.map((execution) => ({ role: "user" as const, text: execution.userMessage })),
    ],
    sources: [
      ...projection.sources,
      ...sortedQueuedTurns.map((execution) => ({ kind: "queued-turn" as const, execution })),
    ],
    keys: [
      ...projection.keys,
      ...sortedQueuedTurns.map((execution) => `queued-turn-${execution.executionId}`),
    ],
    groups: [...projection.groups, ...sortedQueuedTurns.map(() => null)],
    queuedTurns: [
      ...projection.messages.map(() => null),
      ...sortedQueuedTurns,
    ],
  };
}
