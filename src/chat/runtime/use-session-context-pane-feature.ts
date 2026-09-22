import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AuditLogSummary,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../../src-shared/session/runtime-state.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { MicrocopySlot } from "../../../src-shared/settings/microcopy-state.js";

import type { SessionGlossaryPaneProps } from "../../glossary/SessionGlossaryPane.js";
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
import { isTerminalAuditLogPhase } from "./audit-log-phase.js";
import { buildLiveSessionCommonContextPaneProps } from "../live-session-projection.js";
import type { SessionContextPaneProps } from "../shell/session-context-pane.js";
import {
  applyUnavailableContextPaneTabFallbackCommand,
  createContextPaneTabCycleHandler,
} from "../session-shell-handlers.js";

type ContextPaneSession = Pick<
  Session,
  "id" | "updatedAt" | "provider" | "reasoningEffort"
> | null;

export type SessionContextPaneFeatureInput = {
  selectedSession: ContextPaneSession;
  displayedSession: ContextPaneSession;
  activeRunSessionId: string | null;
  character?: CharacterProfile | null;
  liveRun: LiveSessionRunState | null;
  auditLogEntries?: readonly AuditLogSummary[];
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedProviderQuotaTelemetry: ProviderQuotaTelemetry | null;
  availableReasoningEfforts: readonly string[];
  renderedIsRunning: boolean;
  visibleRunState: Session["runState"] | null;
  glossaryPaneProps?: SessionGlossaryPaneProps;
  resolveSessionMicrocopy: (
    slot: MicrocopySlot,
    seedParts: Array<string | number | null | undefined>,
  ) => string;
  onShowContextRail: () => void;
};

export type SessionContextPaneFeature = {
  rightPaneProps: ReturnType<typeof buildLiveSessionCommonContextPaneProps>;
  showGlossary: () => void;
  hasInProgressLiveRunStep: boolean;
  liveRunStepStatusSignature: string;
};

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

export function useSessionContextPaneFeature({
  selectedSession,
  displayedSession,
  activeRunSessionId,
  character,
  liveRun,
  auditLogEntries = [],
  selectedSessionContextTelemetry,
  selectedProviderQuotaTelemetry,
  availableReasoningEfforts,
  renderedIsRunning,
  visibleRunState,
  glossaryPaneProps,
  resolveSessionMicrocopy,
  onShowContextRail,
}: SessionContextPaneFeatureInput): SessionContextPaneFeature {
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const isCopilotSession = displayedSession?.provider === "copilot";
  const selectedCopilotQuotaProjection = useMemo(
    () => (isCopilotSession ? buildCopilotQuotaProjection(selectedProviderQuotaTelemetry) : null),
    [isCopilotSession, selectedProviderQuotaTelemetry],
  );
  const selectedCopilotRemainingPercentLabel = selectedCopilotQuotaProjection?.remainingPercentLabel ?? "unavailable";
  const selectedCopilotRemainingRequestsLabel = selectedCopilotQuotaProjection?.remainingRequestsLabel ?? "usage unavailable";
  const selectedCopilotQuotaResetLabel = selectedCopilotQuotaProjection?.resetLabel ?? "未確認";
  const selectedSessionContextTelemetryProjection = useMemo(
    () => buildSessionContextTelemetryProjection(selectedSessionContextTelemetry),
    [selectedSessionContextTelemetry],
  );
  const liveRunReasoningText = liveRun?.reasoningText ?? "";
  const hasLiveRunReasoningText = liveRunReasoningText.trim().length > 0;
  const hasReasoningCapability = availableReasoningEfforts.length > 0 || Boolean(selectedSession?.reasoningEffort);
  const includeGlossaryContextPane = shouldIncludeGlossaryContextPane(glossaryPaneProps?.projection ?? null);
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
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

  const latestTerminalAuditLog = useMemo(
    () => auditLogEntries.find((entry) => (
      entry.sessionId === activeRunSessionId && isTerminalAuditLogPhase(entry.phase)
    )) ?? null,
    [activeRunSessionId, auditLogEntries],
  );
  const latestCommandProjection = useMemo(
    () => buildLatestCommandProjection({
      liveSteps: liveRun?.steps ?? [],
      auditOperations: latestTerminalAuditLog?.operations ?? [],
      latestTerminalAuditPhase: latestTerminalAuditLog?.phase,
    }),
    [latestTerminalAuditLog?.operations, latestTerminalAuditLog?.phase, liveRun?.steps],
  );
  const latestLiveCommandStep = latestCommandProjection.latestLiveCommandStep;
  const latestCommandView = latestCommandProjection.latestCommandView;
  const orderedLiveRunSteps = useMemo(
    () =>
      (liveRun?.steps ?? [])
        .map((step, index) => ({ step, index }))
        .sort((left, right) => {
          const bucketDiff =
            liveRunStepBucketPriority(left.step.status) - liveRunStepBucketPriority(right.step.status);
          return bucketDiff !== 0 ? bucketDiff : left.index - right.index;
        })
        .map(({ step }) => step),
    [liveRun?.steps],
  );
  const runningDetailsEntries = useMemo(
    () => buildRunningDetailsEntries({
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
  const liveRunStepStatusSignature = useMemo(
    () => orderedLiveRunSteps.map((step) => `${step.id}:${step.status}`).join("|"),
    [orderedLiveRunSteps],
  );
  const selectedContextEmptyText = useMemo(
    () => resolveSessionMicrocopy("empty.context", [
      "context-empty",
      selectedSession?.id,
      selectedSession?.updatedAt,
    ]),
    [resolveSessionMicrocopy, selectedSession?.id, selectedSession?.updatedAt],
  );
  const latestCommandEmptyText = useMemo(
    () => resolveSessionMicrocopy(
      visibleRunState === "running" ? "empty.latest_command.waiting" : "empty.latest_command",
      [
        "latest-command-empty",
        selectedSession?.id,
        visibleRunState,
        latestTerminalAuditLog?.id,
      ],
    ),
    [
      latestTerminalAuditLog?.id,
      resolveSessionMicrocopy,
      selectedSession?.id,
      visibleRunState,
    ],
  );
  const contextPaneProjection = useMemo(
    () => buildContextPaneProjection({
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
    () => createContextPaneTabCycleHandler({
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
    contextEmptyText: selectedContextEmptyText,
    latestCommandEmptyText,
    messageNavigatorSessionId: displayedSession?.id ?? undefined,
    messageNavigatorCharacter: character ?? undefined,
    glossaryPaneProps: includeGlossaryContextPane ? glossaryPaneProps : undefined,
    onCycleContextPaneTab: handleCycleContextPaneTab,
    onSelectContextPaneTab: setActiveContextPaneTab,
  } satisfies SessionContextPaneProps);

  return {
    rightPaneProps,
    showGlossary,
    hasInProgressLiveRunStep,
    liveRunStepStatusSignature,
  };
}
