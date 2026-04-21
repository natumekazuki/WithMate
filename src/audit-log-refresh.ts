import type {
  AuditLogEntry,
  LiveApprovalRequest,
  LiveBackgroundTask,
  LiveElicitationRequest,
  LiveRunStep,
  LiveSessionRunState,
} from "./app-state.js";
import type { SessionBackgroundActivityState } from "./memory-state.js";
import type { Session } from "./session-state.js";

type AuditLogRefreshActivity = Pick<SessionBackgroundActivityState, "kind" | "status" | "updatedAt"> | null | undefined;

type BuildAuditLogRefreshSignatureInput = {
  selectedSession: Pick<Session, "id" | "runState" | "updatedAt"> | null;
  displayedMessagesLength: number;
  selectedMemoryGenerationActivity?: AuditLogRefreshActivity;
  selectedCharacterMemoryGenerationActivity?: AuditLogRefreshActivity;
  selectedMonologueActivity?: AuditLogRefreshActivity;
};

type BuildDisplayedAuditLogsInput = {
  selectedSession: Pick<
    Session,
    "id" | "updatedAt" | "provider" | "model" | "reasoningEffort" | "approvalMode" | "threadId" | "runState"
  > | null;
  persistedEntries: AuditLogEntry[];
  liveRun: LiveSessionRunState | null;
};

function serializeBackgroundActivity(activity: AuditLogRefreshActivity): string {
  if (!activity) {
    return "none";
  }

  return `${activity.kind}:${activity.status}:${activity.updatedAt}`;
}

function buildStepOperation(step: LiveRunStep): AuditLogEntry["operations"][number] {
  const details = [step.status, step.details].filter((value) => typeof value === "string" && value.trim().length > 0).join("\n");
  return {
    type: step.type,
    summary: step.summary,
    details: details || undefined,
  };
}

function buildBackgroundTaskOperation(task: LiveBackgroundTask): AuditLogEntry["operations"][number] {
  const details = [task.status, task.details].filter((value) => typeof value === "string" && value.trim().length > 0).join("\n");
  return {
    type: `background-${task.kind}`,
    summary: task.title,
    details: details || undefined,
  };
}

function buildApprovalRequestOperation(request: LiveApprovalRequest): AuditLogEntry["operations"][number] {
  return {
    type: "approval_request",
    summary: request.title,
    details: [
      "status:pending",
      `kind:${request.kind}`,
      request.summary,
      request.details,
      request.warning ? `warning:${request.warning}` : "",
    ].filter((value) => typeof value === "string" && value.trim().length > 0).join("\n") || undefined,
  };
}

function buildElicitationRequestOperation(request: LiveElicitationRequest): AuditLogEntry["operations"][number] {
  return {
    type: "elicitation_request",
    summary: request.message,
    details: [
      "status:pending",
      `mode:${request.mode}`,
      request.source ? `source:${request.source}` : "",
      request.url ? `url:${request.url}` : "",
      ...request.fields.map((field) => `${field.required ? "required" : "optional"}:${field.title}`),
    ].filter((value) => typeof value === "string" && value.trim().length > 0).join("\n") || undefined,
  };
}

function buildLiveRunOperations(liveRun: LiveSessionRunState): AuditLogEntry["operations"] {
  return [
    ...(liveRun.approvalRequest ? [buildApprovalRequestOperation(liveRun.approvalRequest)] : []),
    ...(liveRun.elicitationRequest ? [buildElicitationRequestOperation(liveRun.elicitationRequest)] : []),
    ...liveRun.steps.map(buildStepOperation),
    ...liveRun.backgroundTasks.map(buildBackgroundTaskOperation),
  ];
}

// persisted audit log の running row があれば、live run state を merge して最新化する。
// late running update (persisted が既に terminal に更新済みなのに live state が残っている) から
// 最終 state を守るため、このマージは persisted が running の時だけ行う。
function mergeRunningAuditLogEntry(entry: AuditLogEntry, liveRun: LiveSessionRunState): AuditLogEntry {
  const operations = buildLiveRunOperations(liveRun);
  const assistantText = liveRun.assistantText.trim();
  const errorMessage = liveRun.errorMessage.trim();
  const threadId = liveRun.threadId.trim();

  return {
    ...entry,
    phase: "running",
    threadId: threadId || entry.threadId,
    assistantText: assistantText || entry.assistantText,
    operations: operations.length > 0 ? operations : entry.operations,
    usage: liveRun.usage ?? entry.usage,
    errorMessage: errorMessage || entry.errorMessage,
  };
}

// 新しい run が live 中の時に、persisted に running row が無い場合に synthetic running row を生成する。
// ID は既存 persisted row の最小 ID - 1 として、先頭に挿入しても既存 ID と衝突しないようにする。
// UI の key として十分安全（既存 ID と重複しない限り、同一 session 内で unique）。
function buildSyntheticRunningAuditLog(
  selectedSession: BuildDisplayedAuditLogsInput["selectedSession"],
  persistedEntries: AuditLogEntry[],
  liveRun: LiveSessionRunState,
): AuditLogEntry | null {
  if (!selectedSession) {
    return null;
  }

  const latestEntry = persistedEntries[0] ?? null;
  const syntheticId = latestEntry
    ? persistedEntries.slice(1).reduce((currentMin, entry) => Math.min(currentMin, entry.id), latestEntry.id) - 1
    : -1;

  return {
    id: syntheticId,
    sessionId: selectedSession.id,
    createdAt: selectedSession.updatedAt,
    phase: "running",
    provider: selectedSession.provider,
    model: selectedSession.model,
    reasoningEffort: selectedSession.reasoningEffort,
    approvalMode: selectedSession.approvalMode,
    threadId: liveRun.threadId.trim() || selectedSession.threadId || latestEntry?.threadId || "",
    logicalPrompt: {
      systemText: "",
      inputText: "",
      composedText: "",
    },
    transportPayload: null,
    assistantText: liveRun.assistantText,
    operations: buildLiveRunOperations(liveRun),
    rawItemsJson: "[]",
    usage: liveRun.usage,
    errorMessage: liveRun.errorMessage,
  };
}

export function buildAuditLogRefreshSignature(input: BuildAuditLogRefreshSignatureInput): string {
  if (!input.selectedSession) {
    return "no-session";
  }

  return [
    input.selectedSession.id,
    input.displayedMessagesLength,
    input.selectedSession.runState,
    input.selectedSession.updatedAt,
    serializeBackgroundActivity(input.selectedMemoryGenerationActivity),
    serializeBackgroundActivity(input.selectedCharacterMemoryGenerationActivity),
    serializeBackgroundActivity(input.selectedMonologueActivity),
  ].join("|");
}

// persisted audit logs と live run state を統合して、UI に表示する audit log 配列を生成する。
// - live run が無い、または session 自体が running でない場合は persisted をそのまま返す (stale live state 抑止)
// - persisted に running row がある場合は、そこへ live state をマージ
// - persisted に running row が無く、session が running 中なら synthetic running row を先頭に挿入
//   (前回の run が completed で persisted に残っていても、新しい live run があれば synthetic row を表示する)
export function buildDisplayedAuditLogs(input: BuildDisplayedAuditLogsInput): AuditLogEntry[] {
  // live run が無い、または session 自体が running でない場合は persisted をそのまま返す
  const liveRun = input.liveRun;
  if (!liveRun || input.selectedSession?.runState !== "running") {
    return input.persistedEntries;
  }

  // persisted に running row がある場合は live state でマージ
  const runningEntryIndex = input.persistedEntries.findIndex((entry) => entry.phase === "running");
  if (runningEntryIndex >= 0) {
    return input.persistedEntries.map((entry, index) =>
      index === runningEntryIndex ? mergeRunningAuditLogEntry(entry, liveRun) : entry,
    );
  }

  // persisted に running row が無い場合は synthetic running row を先頭に挿入
  // (先頭が terminal でも、session.runState === "running" なら新しい run が開始されているので挿入する)
  const syntheticEntry = buildSyntheticRunningAuditLog(input.selectedSession, input.persistedEntries, liveRun);
  return syntheticEntry ? [syntheticEntry, ...input.persistedEntries] : input.persistedEntries;
}
