import type { MessageListProjection } from "./auxiliary-session-message-projection.js";
import type { SessionTurnExecutionProjection } from "./session-turn-execution.js";

export type SessionTurnMessageProjection = MessageListProjection & {
  turnExecutions: Array<SessionTurnExecutionProjection | null>;
};

export function appendTurnExecutionsToMessageList(
  projection: MessageListProjection,
  executions: SessionTurnExecutionProjection[],
  sessionRunState: string,
  runningProjectionBarrierExecutionId: string | null = null,
): SessionTurnMessageProjection {
  const runningExecution = executions.find((execution) => execution.state === "running") ?? null;
  const projectedRunningExecutions = runningExecution !== null && (
    sessionRunState !== "running" || runningExecution.executionId === runningProjectionBarrierExecutionId
  )
    ? [runningExecution]
    : [];
  const sortedQueuedTurns = executions.filter((execution) => execution.state === "queued").sort((left, right) => (
    left.queuePosition - right.queuePosition || left.executionId.localeCompare(right.executionId)
  ));
  const runningInsertIndex = projectedRunningExecutions.length > 0
    ? projection.sources.findIndex((source) => (
        source.kind === "live-assistant" && source.sessionId === runningExecution?.sessionId
      ))
    : -1;
  const persistedRunningIndex = runningExecution && projectedRunningExecutions.length === 0
    ? projection.messages.findLastIndex((message, index) => (
      message.role === "user"
      && message.text === runningExecution.userMessage
      && projection.sources[index]?.kind === "session"
    ))
    : -1;
  const runningPrefixLength = runningInsertIndex >= 0 ? runningInsertIndex : projection.messages.length;
  const runningMessages = projectedRunningExecutions.map((execution) => ({
    role: "user" as const,
    text: execution.userMessage,
  }));
  const runningSources = projectedRunningExecutions.map((execution) => ({
    kind: "turn-execution" as const,
    execution,
  }));
  const runningKeys = projectedRunningExecutions.map((execution) => `turn-execution-${execution.executionId}`);
  const queuedMessages = sortedQueuedTurns.map((execution) => ({ role: "user" as const, text: execution.userMessage }));
  const queuedSources = sortedQueuedTurns.map((execution) => ({ kind: "turn-execution" as const, execution }));
  const queuedKeys = sortedQueuedTurns.map((execution) => `turn-execution-${execution.executionId}`);
  const turnExecutions: Array<SessionTurnExecutionProjection | null> = [
    ...projection.messages.slice(0, runningPrefixLength).map(() => null),
    ...projectedRunningExecutions,
    ...projection.messages.slice(runningPrefixLength).map(() => null),
    ...sortedQueuedTurns,
  ];
  const keys = [
    ...projection.keys.slice(0, runningPrefixLength),
    ...runningKeys,
    ...projection.keys.slice(runningPrefixLength),
    ...queuedKeys,
  ];
  if (persistedRunningIndex >= 0 && runningExecution) {
    turnExecutions[persistedRunningIndex] = runningExecution;
    keys[persistedRunningIndex] = `turn-execution-${runningExecution.executionId}`;
  }
  return {
    messages: [
      ...projection.messages.slice(0, runningPrefixLength),
      ...runningMessages,
      ...projection.messages.slice(runningPrefixLength),
      ...queuedMessages,
    ],
    sources: [
      ...projection.sources.slice(0, runningPrefixLength),
      ...runningSources,
      ...projection.sources.slice(runningPrefixLength),
      ...queuedSources,
    ],
    keys,
    groups: [
      ...projection.groups.slice(0, runningPrefixLength),
      ...projectedRunningExecutions.map(() => null),
      ...projection.groups.slice(runningPrefixLength),
      ...sortedQueuedTurns.map(() => null),
    ],
    turnExecutions,
  };
}
