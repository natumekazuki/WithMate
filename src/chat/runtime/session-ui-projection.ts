import type { MessageOperation } from "../../../src-shared/session/runtime-state.js";
import type {
  LiveBackgroundTask,
  LiveRunStep,
  ProviderQuotaSnapshot,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";
import type { SessionGlossaryProjection } from "../../../src-shared/glossary/glossary-contract.js";
import { liveRunStepStatusLabel } from "../../ui/ui-utils.js";

/** コンテキスト欄で選択と表示をひも付けるタブ識別子。 */
export type ContextPaneTabKey =
  | "latest-command"
  | "coordination"
  | "messages"
  | "glossary"
  | "reasoning"
  | "tasks";

/** 利用可能なタブを表示し、順に切り替えるときの基準順。 */
export const CONTEXT_PANE_TAB_ORDER: ContextPaneTabKey[] = [
  "latest-command",
  "coordination",
  "messages",
  "glossary",
  "reasoning",
  "tasks",
];

/** 最新コマンド欄に表示する実行状態、短縮済み詳細、出所、注意ラベル。 */
export type LatestCommandView = {
  status: string;
  summary: string;
  details?: string;
  exitCode?: number;
  errorMessage?: string;
  truncated?: boolean;
  sourceLabel: string;
  riskLabels: string[];
};

/** 最新コマンド欄の表示と、詳細一覧から除外するための実行中コマンド。 */
export type LatestCommandProjection = {
  latestLiveCommandStep: LiveRunStep | null;
  latestCommandView: LatestCommandView | null;
};

/** 実行中の詳細欄に掲示する、個別ステップの状態と内容。 */
export type RunningDetailsEntry = {
  id: string;
  type: string;
  status: string;
  summary: string;
  details?: string;
};

const COMMAND_DETAILS_PREVIEW_MAX_CHARS = 4000;

/** 空の詳細を省き、表示上限を超えるときは省略した文字数を末尾に示す。 */
function previewCommandDetails(
  details: string | undefined,
): string | undefined {
  if (!details) {
    return undefined;
  }

  if (details.length <= COMMAND_DETAILS_PREVIEW_MAX_CHARS) {
    return details;
  }

  return `${details.slice(0, COMMAND_DETAILS_PREVIEW_MAX_CHARS)}\n\n... truncated ${details.length - COMMAND_DETAILS_PREVIEW_MAX_CHARS} chars`;
}

/** Copilot の利用枠として選んだ項目と、残量・更新日の表示文。 */
export type CopilotQuotaProjection = {
  snapshot: ProviderQuotaSnapshot | null;
  remainingPercentLabel: string;
  remainingRequestsLabel: string;
  resetLabel: string;
};

/** コンテキスト欄の選択中タブと、各パネルの状態表示に使うラベル・表示種別。 */
export type ContextPaneProjection = {
  activeTab: ContextPaneTabKey;
  badgeLabel: string;
  toneClassName: string;
  latestCommandToneClassName: string;
  latestCommandStatusLabel: string;
  latestCommandSourceCopy: string;
  reasoningToneClassName: string;
  tasksToneClassName: string;
};

/** コンテキスト使用量の概要と、内訳の表示用文字列。 */
export type SessionContextTelemetryProjection = {
  summaryLabel: string;
  currentTokensLabel: string;
  tokenLimitLabel: string;
  messagesLengthLabel: string;
  systemTokensLabel: string;
  conversationTokensLabel: string;
};

/** 既知の実行状態だけを表示種別に使い、その他は不明として扱う。 */
export function liveRunStepToneClassName(status: string): string {
  switch (status) {
    case "in_progress":
    case "completed":
    case "failed":
    case "canceled":
    case "pending":
      return status;
    default:
      return "unknown";
  }
}

/** コマンド概要の語句から削除・書き込み・通信の目安を付ける。実際の動作や安全性は判定しない。 */
export function buildCommandRiskLabels(command: string): string[] {
  const normalizedCommand = command.toLowerCase();
  const labels: string[] = [];

  if (
    /\b(rm|del|rmdir|rd|truncate|delete|remove)\b/.test(normalizedCommand) ||
    /\b(remove-item|remove-itemproperty)\b/.test(normalizedCommand)
  ) {
    labels.push("Delete");
  }

  if (
    /\b(mv|move|cp|copy|mkdir|md|touch|tee|create|edit|replace|insert|write|rename)\b/.test(
      normalizedCommand,
    ) ||
    /\b(new-item|set-content|add-content|out-file|rename-item|move-item|copy-item)\b/.test(
      normalizedCommand,
    ) ||
    /\b(git apply|git checkout|git restore|git clean)\b/.test(normalizedCommand)
  ) {
    labels.push("Write");
  }

  if (
    /\b(curl|wget)\b/.test(normalizedCommand) ||
    /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b/.test(
      normalizedCommand,
    ) ||
    /\b(npm|pnpm|yarn|pip|uv|cargo|go)\s+(install|add|get)\b/.test(
      normalizedCommand,
    )
  ) {
    labels.push("Network");
  }

  return labels;
}

/** 実行ステップ列の末尾から、最後に記録されたコマンド実行を探す。 */
export function findLatestLiveCommandStep(
  steps: readonly LiveRunStep[],
): LiveRunStep | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.type === "command_execution") {
      return step;
    }
  }

  return null;
}

/** 保存された操作列の末尾から、最後のコマンド実行を探す。 */
export function findLatestCommandOperation(
  operations: readonly MessageOperation[],
): MessageOperation | null {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation?.type === "command_execution") {
      return operation;
    }
  }

  return null;
}

/** ライブのコマンドを履歴より優先し、出所と表示用の詳細を付ける。 */
export function buildLatestCommandView({
  latestLiveCommandStep,
  latestCommandOperation,
}: {
  latestLiveCommandStep: LiveRunStep | null;
  latestCommandOperation: MessageOperation | null;
}): LatestCommandView | null {
  const operation = latestLiveCommandStep ?? latestCommandOperation;
  if (!operation) return null;
  return {
    status: operation.status ?? "unknown",
    summary: operation.summary,
    details: previewCommandDetails(operation.details),
    ...(operation.exitCode !== undefined
      ? { exitCode: operation.exitCode }
      : {}),
    ...(operation.error ? { errorMessage: operation.error.message } : {}),
    ...(operation.truncated !== undefined
      ? { truncated: operation.truncated }
      : {}),
    sourceLabel: latestLiveCommandStep ? "live" : "latest run",
    riskLabels: buildCommandRiskLabels(operation.summary),
  };
}

/** ライブと保存済みの操作から最新コマンドの表示を作り、ライブ側の選択結果も返す。 */
export function buildLatestCommandProjection({
  liveSteps,
  operations,
}: {
  liveSteps: readonly LiveRunStep[];
  operations: readonly MessageOperation[];
}): LatestCommandProjection {
  const latestLiveCommandStep = findLatestLiveCommandStep(liveSteps);
  return {
    latestLiveCommandStep,
    latestCommandView: buildLatestCommandView({
      latestLiveCommandStep,
      latestCommandOperation: findLatestCommandOperation(operations),
    }),
  };
}

/** 最新コマンド欄との重複、処理待ち・進行中、空の内容を除き、末尾から指定件数を表示する。 */
export function buildRunningDetailsEntries({
  liveSteps,
  latestLiveCommandStepId,
  maxEntries = 3,
}: {
  liveSteps: LiveRunStep[];
  latestLiveCommandStepId?: string | null;
  maxEntries?: number;
}): RunningDetailsEntry[] {
  return liveSteps
    .filter((step) => step.id !== latestLiveCommandStepId)
    .filter(
      (step) => step.status !== "in_progress" && step.status !== "pending",
    )
    .filter(
      (step) =>
        step.summary.trim().length > 0 ||
        (step.details?.trim().length ?? 0) > 0,
    )
    .slice(-maxEntries)
    .map((step) => ({
      id: step.id,
      type: step.type,
      status: step.status,
      summary: step.summary,
      details: previewCommandDetails(step.details),
    }));
}

/** クレジットなど既知の利用枠を優先順で選び、該当がなければ最初の項目を使う。 */
export function selectPrimaryQuotaSnapshot(
  telemetry: ProviderQuotaTelemetry | null,
): ProviderQuotaSnapshot | null {
  if (!telemetry || telemetry.snapshots.length === 0) {
    return null;
  }

  const preferredKeys = [
    "ai_credits",
    "ai_credit",
    "aiu",
    "premium_interactions",
    "premium_requests",
    "premium",
    "chat",
  ];
  for (const preferredKey of preferredKeys) {
    const matched = telemetry.snapshots.find(
      (snapshot) => snapshot.quotaKey === preferredKey,
    );
    if (matched) {
      return matched;
    }
  }

  return telemetry.snapshots[0] ?? null;
}

/** 利用枠キーの表記に応じてクレジット数かリクエスト数の単位を選ぶ。 */
function formatCopilotQuotaUnitLabel(quotaKey: string): string {
  const normalized = quotaKey.toLowerCase();
  if (normalized.includes("credit") || normalized.includes("aiu")) {
    return "credits";
  }
  return "requests";
}

/** 更新日時を短く表示し、日時として読めない非空の値は元の表記を保つ。 */
export function formatQuotaResetLabel(resetDate: string | undefined): string {
  if (!resetDate?.trim()) {
    return "Unknown";
  }

  const parsed = new Date(resetDate);
  if (Number.isNaN(parsed.getTime())) {
    return resetDate;
  }

  return parsed.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 代表利用枠の残量を負にせず表示し、取得できない値は欠落が分かる文にする。 */
export function buildCopilotQuotaProjection(
  telemetry: ProviderQuotaTelemetry | null,
): CopilotQuotaProjection {
  const snapshot = selectPrimaryQuotaSnapshot(telemetry);
  if (!snapshot) {
    return {
      snapshot: null,
      remainingPercentLabel: "unavailable",
      remainingRequestsLabel: "usage unavailable",
      resetLabel: "Unknown",
    };
  }

  const remainingRequests = Math.max(
    0,
    snapshot.entitlementRequests - snapshot.usedRequests,
  );
  const unitLabel = formatCopilotQuotaUnitLabel(snapshot.quotaKey);
  return {
    snapshot,
    remainingPercentLabel: Number.isFinite(snapshot.remainingPercentage)
      ? `${Math.max(0, Math.round(snapshot.remainingPercentage))}% left`
      : "unavailable",
    remainingRequestsLabel: `${remainingRequests} / ${snapshot.entitlementRequests} ${unitLabel} left`,
    resetLabel: formatQuotaResetLabel(snapshot.resetDate),
  };
}

/** トークン数とメッセージ長を表示用に整形し、取得できない内訳は欠落表示にする。 */
export function buildSessionContextTelemetryProjection(
  telemetry: SessionContextTelemetry | null,
): SessionContextTelemetryProjection {
  if (!telemetry) {
    return {
      summaryLabel: "unavailable",
      currentTokensLabel: "-",
      tokenLimitLabel: "-",
      messagesLengthLabel: "-",
      systemTokensLabel: "-",
      conversationTokensLabel: "-",
    };
  }

  return {
    summaryLabel: `${telemetry.currentTokens.toLocaleString("en-US")} / ${telemetry.tokenLimit.toLocaleString("en-US")}`,
    currentTokensLabel: telemetry.currentTokens.toLocaleString("en-US"),
    tokenLimitLabel: telemetry.tokenLimit.toLocaleString("en-US"),
    messagesLengthLabel: telemetry.messagesLength.toLocaleString("en-US"),
    systemTokensLabel: telemetry.systemTokens?.toLocaleString("en-US") ?? "-",
    conversationTokensLabel:
      telemetry.conversationTokens?.toLocaleString("en-US") ?? "-",
  };
}

/** 既知のバックグラウンド作業状態を表示文にし、未知の値はそのまま返す。 */
export function sessionBackgroundActivityStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

/** 作業が複数ある場合、実行中、失敗、完了の順に優先して代表状態を決める。 */
export function summarizeBackgroundTasksStatus(
  backgroundTasks: LiveBackgroundTask[],
): string {
  if (backgroundTasks.some((task) => task.status === "running")) {
    return "running";
  }

  if (backgroundTasks.some((task) => task.status === "failed")) {
    return "failed";
  }

  if (backgroundTasks.some((task) => task.status === "completed")) {
    return "completed";
  }

  return "unknown";
}

/** コンテキストタブの識別子を画面に出す名前へ変換する。 */
export function contextPaneTabLabel(tab: ContextPaneTabKey): string {
  switch (tab) {
    case "latest-command":
      return "Latest Command";
    case "messages":
      return "Messages";
    case "coordination":
      return "Coordination";
    case "glossary":
      return "Glossary";
    case "reasoning":
      return "Reasoning";
    case "tasks":
      return "Tasks";
    default:
      return tab;
  }
}

/** 設定と実行内容に応じて表示できるタブだけを基準順で返す。 */
export function resolveAvailableContextPaneTabs({
  isCopilotSession,
  includeMessages = false,
  includeGlossary = false,
  hasReasoningCapability = false,
  hasReasoningText = false,
}: {
  isCopilotSession: boolean;
  includeMessages?: boolean;
  includeGlossary?: boolean;
  hasReasoningCapability?: boolean;
  hasReasoningText?: boolean;
}): ContextPaneTabKey[] {
  return CONTEXT_PANE_TAB_ORDER.filter((tab) => {
    if (tab === "reasoning") {
      return hasReasoningCapability || hasReasoningText;
    }

    if (tab === "messages") {
      return includeMessages;
    }

    if (tab === "glossary") {
      return includeGlossary;
    }

    if (tab === "tasks") {
      return isCopilotSession;
    }

    return true;
  });
}

/** 用語集のデータ取得状況によらず、コンテキスト欄に用語集タブを含める。 */
export function shouldIncludeGlossaryContextPane(
  _projection: SessionGlossaryProjection | null,
): boolean {
  return true;
}

/** 利用可能なタブ内で前後に循環し、候補が空の場合は最新コマンドに戻す。 */
export function cycleContextPaneTab(
  currentTab: ContextPaneTabKey,
  direction: -1 | 1,
  availableTabs: ContextPaneTabKey[] = CONTEXT_PANE_TAB_ORDER,
): ContextPaneTabKey {
  const order: ContextPaneTabKey[] =
    availableTabs.length > 0 ? availableTabs : ["latest-command"];
  const currentIndex = order.indexOf(currentTab);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + order.length) % order.length;
  return order[nextIndex] ?? "latest-command";
}

/** 最新コマンド、推論、バックグラウンド作業の表示状態を求め、選択タブの装飾とバッジを決める。 */
export function buildContextPaneProjection({
  activeContextPaneTab,
  latestCommandView,
  backgroundTasks,
  hasReasoningText = false,
  isSelectedSessionRunning = false,
}: {
  activeContextPaneTab: ContextPaneTabKey;
  latestCommandView: LatestCommandView | null;
  backgroundTasks: LiveBackgroundTask[];
  hasReasoningText?: boolean;
  isSelectedSessionRunning?: boolean;
}): ContextPaneProjection {
  const latestCommandToneClassName = latestCommandView
    ? liveRunStepToneClassName(latestCommandView.status)
    : "unknown";
  const latestCommandStatusLabel = latestCommandView
    ? liveRunStepStatusLabel(latestCommandView.status)
    : "Idle";
  const latestCommandSourceCopy =
    latestCommandView?.sourceLabel === "live" ? "Live Run" : "Last Run";
  const tasksToneClassName = summarizeBackgroundTasksStatus(backgroundTasks);
  const reasoningToneClassName = hasReasoningText
    ? isSelectedSessionRunning
      ? "in_progress"
      : "completed"
    : "unknown";
  let badgeLabel = "";
  switch (activeContextPaneTab) {
    case "tasks":
      badgeLabel =
        backgroundTasks.length > 0
          ? sessionBackgroundActivityStatusLabel(tasksToneClassName)
          : "";
      break;
    case "reasoning":
      badgeLabel = hasReasoningText
        ? isSelectedSessionRunning
          ? "Live"
          : "Retained"
        : "";
      break;
    default:
      badgeLabel = "";
      break;
  }

  let toneClassName = "unknown";
  switch (activeContextPaneTab) {
    case "latest-command":
      toneClassName = latestCommandToneClassName;
      break;
    case "tasks":
      toneClassName = tasksToneClassName;
      break;
    case "reasoning":
      toneClassName = reasoningToneClassName;
      break;
    default:
      toneClassName = "unknown";
      break;
  }

  return {
    activeTab: activeContextPaneTab,
    badgeLabel,
    toneClassName,
    latestCommandToneClassName,
    latestCommandStatusLabel,
    latestCommandSourceCopy,
    reasoningToneClassName,
    tasksToneClassName,
  };
}

/** 用語集の検索結果が現在表示している版に対応し、版が未取得ではないことを確認する。 */
export function isGlossarySearchRevisionCurrent(
  resultRevision: string | null,
  projectionRevision: string | null | undefined,
): boolean {
  return resultRevision !== null && resultRevision === projectionRevision;
}
