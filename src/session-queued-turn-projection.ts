import type { MessageListProjection } from "./auxiliary-session-message-projection.js";
import type { SessionGuiTurnExecution, SessionQueuedTurn } from "./session-gui-execution.js";

export type SessionQueuedTurnMessageProjection = MessageListProjection & {
  queuedTurns: Array<SessionQueuedTurn | null>;
};

export function appendGuiTurnExecutionsToMessageList(
  projection: MessageListProjection,
  executions: SessionGuiTurnExecution[],
  sessionRunState: string,
  runningProjectionBarrierExecutionId: string | null = null,
): SessionQueuedTurnMessageProjection {
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
  const runningPrefixLength = runningInsertIndex >= 0 ? runningInsertIndex : projection.messages.length;
  const runningMessages = projectedRunningExecutions.map((execution) => ({
    role: "user" as const,
    text: execution.userMessage,
  }));
  const runningSources = projectedRunningExecutions.map((execution) => ({
    kind: "gui-turn-execution" as const,
    execution,
  }));
  const runningKeys = projectedRunningExecutions.map((execution) => `gui-turn-execution-${execution.executionId}`);
  const queuedMessages = sortedQueuedTurns.map((execution) => ({ role: "user" as const, text: execution.userMessage }));
  const queuedSources = sortedQueuedTurns.map((execution) => ({ kind: "gui-turn-execution" as const, execution }));
  const queuedKeys = sortedQueuedTurns.map((execution) => `gui-turn-execution-${execution.executionId}`);
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
    keys: [
      ...projection.keys.slice(0, runningPrefixLength),
      ...runningKeys,
      ...projection.keys.slice(runningPrefixLength),
      ...queuedKeys,
    ],
    groups: [
      ...projection.groups.slice(0, runningPrefixLength),
      ...projectedRunningExecutions.map(() => null),
      ...projection.groups.slice(runningPrefixLength),
      ...sortedQueuedTurns.map(() => null),
    ],
    queuedTurns: [
      ...projection.messages.slice(0, runningPrefixLength).map(() => null),
      ...projectedRunningExecutions.map(() => null),
      ...projection.messages.slice(runningPrefixLength).map(() => null),
      ...sortedQueuedTurns,
    ],
  };
}
