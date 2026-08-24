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
  const outboundTurns = executions
    .filter((execution) => execution.state === "accepted")
    .sort((left, right) => left.acceptanceSequence - right.acceptanceSequence);
  const receivedTurns = executions
    .filter((execution) => execution.state === "received")
    .sort((left, right) => left.targetMessageSequence - right.targetMessageSequence);
  const mergedProjection = mergeOutboundTurns(
    bindReceivedTurns(projection, receivedTurns),
    outboundTurns,
  );
  const runningInsertIndex = projectedRunningExecutions.length > 0
    ? mergedProjection.sources.findIndex((source) => (
        source.kind === "live-assistant" && source.sessionId === runningExecution?.sessionId
      ))
    : -1;
  const persistedRunningIndex = runningExecution && projectedRunningExecutions.length === 0
    ? mergedProjection.messages.findLastIndex((message, index) => (
      message.role === "user"
      && message.text === runningExecution.userMessage
      && mergedProjection.sources[index]?.kind === "session"
    ))
    : -1;
  const runningPrefixLength = runningInsertIndex >= 0 ? runningInsertIndex : mergedProjection.messages.length;
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
    ...mergedProjection.turnExecutions.slice(0, runningPrefixLength),
    ...projectedRunningExecutions,
    ...mergedProjection.turnExecutions.slice(runningPrefixLength),
    ...sortedQueuedTurns,
  ];
  const keys = [
    ...mergedProjection.keys.slice(0, runningPrefixLength),
    ...runningKeys,
    ...mergedProjection.keys.slice(runningPrefixLength),
    ...queuedKeys,
  ];
  if (persistedRunningIndex >= 0 && runningExecution) {
    turnExecutions[persistedRunningIndex] = runningExecution;
    keys[persistedRunningIndex] = `turn-execution-${runningExecution.executionId}`;
  }
  return {
    messages: [
      ...mergedProjection.messages.slice(0, runningPrefixLength),
      ...runningMessages,
      ...mergedProjection.messages.slice(runningPrefixLength),
      ...queuedMessages,
    ],
    sources: [
      ...mergedProjection.sources.slice(0, runningPrefixLength),
      ...runningSources,
      ...mergedProjection.sources.slice(runningPrefixLength),
      ...queuedSources,
    ],
    keys,
    groups: [
      ...mergedProjection.groups.slice(0, runningPrefixLength),
      ...projectedRunningExecutions.map(() => null),
      ...mergedProjection.groups.slice(runningPrefixLength),
      ...sortedQueuedTurns.map(() => null),
    ],
    turnExecutions,
  };
}

function mergeOutboundTurns(
  projection: SessionTurnMessageProjection,
  outboundTurns: Extract<SessionTurnExecutionProjection, { state: "accepted" }>[],
): SessionTurnMessageProjection {
  const merged: SessionTurnMessageProjection = {
    messages: [...projection.messages],
    sources: [...projection.sources],
    keys: [...projection.keys],
    groups: [...projection.groups],
    turnExecutions: [...projection.turnExecutions],
  };
  for (const execution of outboundTurns) {
    const anchorIndex = merged.sources.findLastIndex((source) => (
      source.kind === "session" && source.messageIndex <= execution.sourceMessageSequence
    ));
    let insertionIndex = anchorIndex + 1;
    while (true) {
      const existing = merged.turnExecutions[insertionIndex];
      if (
        merged.sources[insertionIndex]?.kind !== "turn-execution"
        || existing?.state !== "accepted"
        || existing.sourceMessageSequence > execution.sourceMessageSequence
        || (
          existing.sourceMessageSequence === execution.sourceMessageSequence
          && existing.acceptanceSequence > execution.acceptanceSequence
        )
      ) break;
      insertionIndex += 1;
    }
    merged.messages.splice(insertionIndex, 0, { role: "user", text: execution.userMessage });
    merged.sources.splice(insertionIndex, 0, { kind: "turn-execution", execution });
    merged.keys.splice(insertionIndex, 0, `turn-execution-${execution.executionId}`);
    merged.groups.splice(insertionIndex, 0, null);
    merged.turnExecutions.splice(insertionIndex, 0, execution);
  }
  return merged;
}

function bindReceivedTurns(
  projection: MessageListProjection,
  receivedTurns: Extract<SessionTurnExecutionProjection, { state: "received" }>[],
): SessionTurnMessageProjection {
  const bound: SessionTurnMessageProjection = {
    messages: [...projection.messages],
    sources: [...projection.sources],
    keys: [...projection.keys],
    groups: [...projection.groups],
    turnExecutions: projection.messages.map(() => null),
  };
  for (const execution of receivedTurns) {
    const messageIndex = bound.sources.findIndex((source) => (
      source.kind === "session" && source.messageIndex === execution.targetMessageSequence
    ));
    if (messageIndex < 0) continue;
    bound.turnExecutions[messageIndex] = execution;
    bound.keys[messageIndex] = `turn-execution-${execution.executionId}`;
  }
  return bound;
}
