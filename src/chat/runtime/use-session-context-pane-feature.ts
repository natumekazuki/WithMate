import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  MessageOperation,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { CharacterProfile } from "../../../src-shared/character/character-state.js";

import type { SessionGlossaryPaneProps } from "../../glossary/SessionGlossaryPane.js";
import type { OpenCoordinationRequest } from "../../../src-shared/coordination/coordination-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  resolveAvailableContextPaneTabs,
  shouldIncludeGlossaryContextPane,
  type ContextPaneTabKey,
} from "./session-ui-projection.js";
import { buildLiveSessionCommonContextPaneProps } from "../live-session-projection.js";
import type { SessionContextPaneProps } from "../shell/session-context-pane.js";
import {
  applyUnavailableContextPaneTabFallbackCommand,
  createContextPaneTabCycleHandler,
} from "../session-shell-handlers.js";

/** コンテキスト欄が選択対象と表示対象を判別するために受け取るセッション情報。 */
type ContextPaneSession = Pick<
  Session,
  "id" | "updatedAt" | "provider" | "reasoningEffort"
> | null;

/** コンテキスト欄の切替と内容に必要な実行情報、履歴、テレメトリー、操作。 */
export type SessionContextPaneFeatureInput = {
  selectedSession: ContextPaneSession;
  displayedSession: ContextPaneSession;
  activeRunSessionId: string | null;
  character?: CharacterProfile | null;
  liveRun: LiveSessionRunState | null;
  operations?: readonly MessageOperation[];
  commandHistoryLoading?: boolean;
  commandHistoryError?: string | null;
  commandHistoryUnrecorded?: boolean;
  onRetryCommandHistory?: () => void;
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedProviderQuotaTelemetry: ProviderQuotaTelemetry | null;
  availableReasoningEfforts: readonly string[];
  renderedIsRunning: boolean;
  glossaryPaneProps?: SessionGlossaryPaneProps;
  onShowContextRail: () => void;
};

/** コンテキスト欄の描画設定、用語集への直接操作、実行中ステップの有無。 */
export type SessionContextPaneFeature = {
  rightPaneProps: ReturnType<typeof buildLiveSessionCommonContextPaneProps>;
  showGlossary: () => void;
  hasInProgressLiveRunStep: boolean;
};

/** 失敗・中止・進行中を先頭、完了済みを次、未着手やその他を末尾にする優先度を返す。 */
function liveRunStepBucketPriority(status: string): number {
  switch (status) {
    case "failed":
    case "canceled":
    case "in_progress":
      return 0;
    case "completed":
      return 1;
    case "pending":
      return 2;
    default:
      return 2;
  }
}

/** 利用可能なコンテキストタブと実行内容を投影し、利用できなくなったタブを切り替える。 */
export function useSessionContextPaneFeature({
  selectedSession,
  displayedSession,
  activeRunSessionId,
  character,
  liveRun,
  operations = [],
  commandHistoryLoading = false,
  commandHistoryError = null,
  commandHistoryUnrecorded = false,
  onRetryCommandHistory,
  selectedSessionContextTelemetry,
  selectedProviderQuotaTelemetry,
  availableReasoningEfforts,
  renderedIsRunning,
  glossaryPaneProps,
  onShowContextRail,
}: SessionContextPaneFeatureInput): SessionContextPaneFeature {
  const [activeContextPaneTab, setActiveContextPaneTab] =
    useState<ContextPaneTabKey>("latest-command");
  const [coordinationNavigation, setCoordinationNavigation] =
    useState<OpenCoordinationRequest | null>(null);
  useEffect(
    () =>
      getWithMateApi()?.subscribeOpenCoordination((request) => {
        setCoordinationNavigation(request);
        setActiveContextPaneTab("coordination");
        onShowContextRail();
      }),
    [onShowContextRail],
  );
  const isCopilotSession = displayedSession?.provider === "copilot";
  const selectedCopilotQuotaProjection = useMemo(
    () =>
      isCopilotSession
        ? buildCopilotQuotaProjection(selectedProviderQuotaTelemetry)
        : null,
    [isCopilotSession, selectedProviderQuotaTelemetry],
  );
  const selectedCopilotRemainingPercentLabel =
    selectedCopilotQuotaProjection?.remainingPercentLabel ?? "unavailable";
  const selectedCopilotRemainingRequestsLabel =
    selectedCopilotQuotaProjection?.remainingRequestsLabel ??
    "usage unavailable";
  const selectedCopilotQuotaResetLabel =
    selectedCopilotQuotaProjection?.resetLabel ?? "Unknown";
  const selectedSessionContextTelemetryProjection = useMemo(
    () =>
      buildSessionContextTelemetryProjection(selectedSessionContextTelemetry),
    [selectedSessionContextTelemetry],
  );
  const liveRunReasoningText = liveRun?.reasoningText ?? "";
  const hasLiveRunReasoningText = liveRunReasoningText.trim().length > 0;
  const hasReasoningCapability =
    availableReasoningEfforts.length > 0 ||
    Boolean(selectedSession?.reasoningEffort);
  const includeGlossaryContextPane = shouldIncludeGlossaryContextPane(
    glossaryPaneProps?.projection ?? null,
  );
  const availableContextPaneTabs = useMemo(
    () =>
      resolveAvailableContextPaneTabs({
        isCopilotSession,
        includeMessages: true,
        includeGlossary: includeGlossaryContextPane,
        hasReasoningCapability,
        hasReasoningText: hasLiveRunReasoningText,
      }),
    [
      hasLiveRunReasoningText,
      hasReasoningCapability,
      includeGlossaryContextPane,
      isCopilotSession,
    ],
  );

  const latestCommandProjection = useMemo(
    () =>
      buildLatestCommandProjection({
        liveSteps: liveRun?.steps ?? [],
        operations,
      }),
    [operations, liveRun?.steps],
  );
  const latestLiveCommandStep = latestCommandProjection.latestLiveCommandStep;
  const latestCommandView = latestCommandProjection.latestCommandView;
  const orderedLiveRunSteps = useMemo(
    () =>
      (liveRun?.steps ?? [])
        .map((step, index) => ({ step, index }))
        .sort((left, right) => {
          const bucketDiff =
            liveRunStepBucketPriority(left.step.status) -
            liveRunStepBucketPriority(right.step.status);
          return bucketDiff !== 0 ? bucketDiff : left.index - right.index;
        })
        .map(({ step }) => step),
    [liveRun?.steps],
  );
  const runningDetailsEntries = useMemo(
    () =>
      buildRunningDetailsEntries({
        liveSteps: orderedLiveRunSteps,
        latestLiveCommandStepId: latestLiveCommandStep?.id ?? null,
      }),
    [latestLiveCommandStep?.id, orderedLiveRunSteps],
  );
  const backgroundTasks = useMemo(
    () => liveRun?.backgroundTasks ?? [],
    [liveRun?.backgroundTasks],
  );
  const hasInProgressLiveRunStep = useMemo(
    () => orderedLiveRunSteps.some((step) => step.status === "in_progress"),
    [orderedLiveRunSteps],
  );
  const contextPaneProjection = useMemo(
    () =>
      buildContextPaneProjection({
        activeContextPaneTab,
        latestCommandView,
        backgroundTasks,
        hasReasoningText: hasLiveRunReasoningText,
        isSelectedSessionRunning: renderedIsRunning,
      }),
    [
      activeContextPaneTab,
      backgroundTasks,
      hasLiveRunReasoningText,
      latestCommandView,
      renderedIsRunning,
    ],
  );

  useEffect(() => {
    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: activeContextPaneTab,
      availableTabs: availableContextPaneTabs,
      setActiveTab: setActiveContextPaneTab,
    });
  }, [activeContextPaneTab, availableContextPaneTabs]);

  const handleCycleContextPaneTab = useMemo(
    () =>
      createContextPaneTabCycleHandler({
        availableTabs: availableContextPaneTabs,
        setActiveTab: setActiveContextPaneTab,
      }),
    [availableContextPaneTabs],
  );
  const showGlossary = useCallback(() => {
    setActiveContextPaneTab("glossary");
    onShowContextRail();
  }, [onShowContextRail]);
  const rightPaneProps = buildLiveSessionCommonContextPaneProps({
    activeContextPaneTab,
    availableContextPaneTabs,
    contextPaneProjection,
    latestCommandView,
    commandHistoryLoading,
    commandHistoryError,
    commandHistoryUnrecorded,
    onRetryCommandHistory,
    runningDetailsEntries,
    liveRunReasoningText,
    backgroundTasks,
    selectedSessionLiveRunErrorMessage: liveRun?.errorMessage ?? "",
    isSelectedSessionRunning: renderedIsRunning,
    isCopilotSession,
    selectedCopilotRemainingPercentLabel,
    selectedCopilotRemainingRequestsLabel,
    selectedCopilotQuotaResetLabel,
    selectedSessionContextTelemetry,
    selectedSessionContextTelemetryProjection,
    messageNavigatorSessionId: displayedSession?.id ?? undefined,
    messageNavigatorCharacter: character ?? undefined,
    glossaryPaneProps: includeGlossaryContextPane
      ? glossaryPaneProps
      : undefined,
    coordinationSessionId: selectedSession?.id,
    coordinationNavigation,
    onCycleContextPaneTab: handleCycleContextPaneTab,
    onSelectContextPaneTab: setActiveContextPaneTab,
  } satisfies SessionContextPaneProps);

  return {
    rightPaneProps,
    showGlossary,
    hasInProgressLiveRunStep,
  };
}
