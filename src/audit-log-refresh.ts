import type {
  AuditLogSummary,
  LiveSessionRunState,
} from "./app-state.js";
import { buildLiveRunAuditOperations } from "./live-run-audit-operations.js";
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
  persistedEntries: AuditLogSummary[];
  liveRun: LiveSessionRunState | null;
};

function serializeBackgroundActivity(activity: AuditLogRefreshActivity): string {
  if (!activity) {
    return "none";
  }

  return `${activity.kind}:${activity.status}:${activity.updatedAt}`;
}

// persisted audit log の running row があれば、live run state を merge して最新化する。
// late running update (persisted が既に terminal に更新済みなのに live state が残っている) から
// 最終 state を守るため、このマージは persisted が running の時だけ行う。
function mergeRunningAuditLogEntry(entry: AuditLogSummary, liveRun: LiveSessionRunState): AuditLogSummary {
  const operations = buildLiveRunAuditOperations(liveRun);
  const assistantText = liveRun.assistantText.trim();
  const errorMessage = liveRun.errorMessage.trim();
  const threadId = liveRun.threadId.trim();
  const previousAssistantText = entry.assistantTextPreview
    || ("assistantText" in entry && typeof entry.assistantText === "string" ? entry.assistantText : "");

  return {
    ...entry,
    phase: "running",
    threadId: threadId || entry.threadId,
    assistantTextPreview: assistantText || previousAssistantText,
    assistantText: assistantText || previousAssistantText,
    operations,
    usage: liveRun.usage ?? entry.usage,
    errorMessage: errorMessage || entry.errorMessage,
  } as AuditLogSummary;
}

// 新しい run が live 中の時に、persisted に running row が無い場合に synthetic running row を生成する。
// ID は既存 persisted row の最小 ID - 1 として、先頭に挿入しても既存 ID と衝突しないようにする。
// UI の key として十分安全（既存 ID と重複しない限り、同一 session 内で unique）。
function buildSyntheticRunningAuditLog(
  selectedSession: BuildDisplayedAuditLogsInput["selectedSession"],
  persistedEntries: AuditLogSummary[],
  liveRun: LiveSessionRunState,
): AuditLogSummary | null {
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
    assistantTextPreview: liveRun.assistantText,
    logicalPrompt: {
      systemText: "",
      inputText: "",
      composedText: "",
    },
    transportPayload: null,
    assistantText: liveRun.assistantText,
    operations: buildLiveRunAuditOperations(liveRun),
    rawItemsJson: "[]",
    usage: liveRun.usage,
    errorMessage: liveRun.errorMessage,
    detailAvailable: false,
  } as AuditLogSummary;
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
export function buildDisplayedAuditLogs(input: BuildDisplayedAuditLogsInput): AuditLogSummary[] {
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
