import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill, LiveSessionRunState, RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import { getAuxiliarySessionIdFromLocation, getSessionIdFromLocation } from "./session-location.js";
import {
  buildSessionWithAddedAdditionalDirectory,
  buildSessionWithRemovedAdditionalDirectory,
  resolveAdditionalDirectoryPickerBase,
  runAdditionalDirectoryRemovalOperation,
  runPickedAdditionalDirectoryOperation,
} from "../../src-shared/settings/additional-directory-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  type DiffPreviewPayload,
  type Message,
  isReadOnlySession,
  setMessageBookmarked,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { MessageCollapseTarget } from "../chat/conversation/session-message-collapse.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { startModelCatalogSubscription } from "../settings/model-catalog-subscription.js";
import type { ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import {
  buildAuxiliarySessionCancelTarget,
  buildRunningSessionCancelTarget,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
  runRunningSessionCancelOperation,
} from "../chat/send-or-cancel.js";
import {
  approvalModeLabel,
} from "../ui/ui-utils.js";
import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../chat/composer/composer-textarea-focus.js";
import { buildMainAuxiliaryRuntimeSession } from "../chat/auxiliary/auxiliary-runtime-projection.js";
import {
  useMainAuxiliaryRuntimeSession,
} from "../chat/auxiliary/auxiliary-render-projections.js";
import { ChatWindow, ChatWindowStatusScreen } from "../chat/chat-window.js";
import { ChatSessionModals } from "../chat/chat-session-modals.js";
import { useResourceDiscovery } from "../chat/use-resource-discovery.js";
import { applySessionDocumentTitle, resolveAgentSessionDocumentTitle } from "../chat/window-title.js";
import { resolveAuditLogOwner } from "../chat/audit-log-owner.js";
import {
  buildAuxiliaryLaunchProviderItems,
  createAuxiliaryLaunchDialogCloseHandler,
  createAuxiliaryLaunchDialogOpenHandler,
  createAuxiliaryLaunchProviderSelectHandler,
  canCancelAuxiliaryLaunchCreation,
  resolveAuxiliaryLaunchCreationFeedback,
  resolveAuxiliaryLaunchProviderId,
  resolveAuxiliaryLaunchStartProvider,
} from "../chat/auxiliary-launch-state.js";
import { AuxiliaryLaunchProviderDialog } from "../chat/AuxiliaryLaunchProviderDialog.js";
import { useAuxiliaryCreation } from "../chat/use-auxiliary-creation.js";
import { useAuxiliaryLaunchDialogState } from "../chat/use-auxiliary-launch-dialog-state.js";
import { useAuxiliaryWorkspace } from "../chat/use-auxiliary-workspace.js";
import {
  ComposerControllerRegistry,
  type ComposerOwner,
} from "../chat/composer-controller.js";
import { useAuxiliaryDraftPersistence } from "../chat/auxiliary/use-auxiliary-draft-persistence.js";
import { useSessionComposerFeature } from "../chat/composer/use-session-composer-feature.js";
import {
  runMainRuntimeOptionOperation,
  type MainRuntimeOption,
} from "../chat/runtime/main-session-mutation-operations.js";
import { useMainSessionRuntime } from "../chat/runtime/use-main-session-runtime.js";
import { useSessionHeaderOperations } from "../chat/shell/use-session-header-operations.js";
import {
  buildComposerSendabilityState,
  resolveComposerSendabilityState,
  type ComposerSendabilityState,
} from "../chat/composer/session-composer-feedback.js";
import {
  runAuxiliaryCustomAgentPatchOperation,
  runAuxiliaryCustomAgentSelectionOperation,
} from "../chat/auxiliary/auxiliary-custom-agent-operation.js";
import { runAuxiliarySkillPromptInsertionOperation } from "../chat/auxiliary/auxiliary-skill-prompt-operation.js";
import {
  pickComposerReferencePath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "../chat/composer/session-composer-paths.js";
import {
  applyComposerDraftChangeCommand,
} from "../chat/composer-draft-handlers.js";
import {
  useChatLayoutPresentation,
  useSessionSidePanes,
} from "../chat/shell/session-chat-layout-hooks.js";
import { persistChatLayoutPreference } from "../chat/chat-layout-preference.js";
import type { SessionSidePane } from "../../src-shared/settings/session-side-pane.js";
import { PromptTemplateWorkspace } from "../prompt-templates/PromptTemplateWorkspace.js";
import { insertComposerTextAtSelection } from "../chat/message-text-actions.js";
import { useSessionGlossary } from "../glossary/use-session-glossary.js";
import { useSessionFilesFeature } from "../file-explorer/use-session-files-feature.js";
import {
  acknowledgePreviewChatMessageCount,
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "../file-explorer/preview-chat-activity.js";
import {
  createOwnedPendingLiveSessionRunState,
  resolveSessionRunErrorMessage,
} from "../chat/runtime/session-live-run-state.js";
import {
  StateMutationRevision,
  createSessionTurnClientRequestId,
} from "../chat/runtime/session-submit-coordinator.js";
import { useSessionChatConversationFeature } from "../chat/conversation/session-chat-conversation-feature.js";
import { buildSessionChatRuntimeFeature } from "../chat/runtime/session-chat-runtime-feature.js";
import { useSessionContextPaneFeature } from "../chat/runtime/use-session-context-pane-feature.js";
import { composeAgentSessionChatWindow } from "../chat/session-chat-window-composition.js";
import { useSessionChatShellFeature } from "../chat/shell/session-chat-shell-feature.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { ShortcutSettingsProvider } from "../settings/shortcut-settings-context.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "../file-explorer/open-path-result.js";
import {
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceExecutionGate,
  resolveSessionWorkspaceUnavailableMessage,
} from "../chat/runtime/session-workspace-availability.js";
import { useSessionWorkspaceAvailability } from "../chat/runtime/session-window-workspace-hooks.js";
import { useActiveSessionLiveRun } from "../chat/runtime/session-window-live-run-hooks.js";
import { useSessionRunActions } from "../chat/runtime/session-run-actions.js";
import { useSessionAuditLogs } from "../chat/runtime/session-audit-log-state.js";
import {
  type AuxiliarySession,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createPastedSessionAttachmentHandler } from "../chat/composer-paste-handlers.js";
import { useSessionTelemetry } from "../chat/runtime/session-window-telemetry-hooks.js";
import {
  createCopyMessageTextHandler,
} from "../chat/message-text-actions.js";
import {
  applyRetryDraftRestoreCommand,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetryBannerSource,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
  type RetryBannerKind,
  type RetryBannerState,
} from "../chat/retry-state.js";
import { resolvePendingAuxiliaryMessageGroupId } from "../chat/auxiliary/auxiliary-session-message-projection.js";
import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveWithQueue,
} from "../chat/auxiliary/auxiliary-session-update-operation.js";
import {
  runAddAuxiliaryAdditionalDirectoryOperationWithApi,
  runRemoveAuxiliaryAdditionalDirectoryOperation,
} from "../chat/auxiliary/auxiliary-additional-directory-operation.js";
import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperationWithApi,
} from "../chat/auxiliary/auxiliary-session-send-operation.js";
import {
  applyComposerSubmitCommand,
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applyComposerReferenceInsertionCommand,
  applyCentralSurfaceOpenCommand,
  applySelectedPathReferenceInsertionCommand,
  applySkillPromptInsertionCommand,
  applySessionFilesReferencePathsCommand,
  applySkillPromptInsertionUiState,
  createAgentPickerCloseHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
  createSkillPromptInsertionHandler,
  createTitleInputKeyHandler,
} from "../chat/session-shell-handlers.js";
import {
  SHORTCUT_COMMAND_IDS,
  useShortcutCommandHandler,
  useShortcutDispatcherSettings,
  useShortcutScope,
} from "../settings/shortcut-registry.js";

const DEFAULT_SESSION_RUNTIME_NAME = "Mate";
const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

type ParsedFileChangeSummaryLine = {
  actionLabel: string;
  toneClassName: "add" | "edit" | "delete" | "rename";
  path: string;
};

const FILE_CHANGE_SUMMARY_ACTION_META: Record<string, Pick<ParsedFileChangeSummaryLine, "actionLabel" | "toneClassName">> = {
  add: { actionLabel: "Added", toneClassName: "add" },
  added: { actionLabel: "Added", toneClassName: "add" },
  create: { actionLabel: "Added", toneClassName: "add" },
  created: { actionLabel: "Added", toneClassName: "add" },
  new: { actionLabel: "Added", toneClassName: "add" },
  edit: { actionLabel: "Modified", toneClassName: "edit" },
  edited: { actionLabel: "Modified", toneClassName: "edit" },
  modify: { actionLabel: "Modified", toneClassName: "edit" },
  modified: { actionLabel: "Modified", toneClassName: "edit" },
  update: { actionLabel: "Modified", toneClassName: "edit" },
  updated: { actionLabel: "Modified", toneClassName: "edit" },
  delete: { actionLabel: "Deleted", toneClassName: "delete" },
  deleted: { actionLabel: "Deleted", toneClassName: "delete" },
  remove: { actionLabel: "Deleted", toneClassName: "delete" },
  removed: { actionLabel: "Deleted", toneClassName: "delete" },
  move: { actionLabel: "Moved", toneClassName: "rename" },
  moved: { actionLabel: "Moved", toneClassName: "rename" },
  rename: { actionLabel: "Moved", toneClassName: "rename" },
  renamed: { actionLabel: "Moved", toneClassName: "rename" },
};

function parseFileChangeSummary(summary: string): ParsedFileChangeSummaryLine[] | null {
  const lines = summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return null;
  }

  const parsedLines = lines.map((line) => {
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex <= 0) {
      return null;
    }

    const actionToken = line.slice(0, separatorIndex).trim().toLowerCase();
    const path = line.slice(separatorIndex + 2).trim();
    const actionMeta = FILE_CHANGE_SUMMARY_ACTION_META[actionToken];
    if (!actionMeta || !path) {
      return null;
    }

    return {
      actionLabel: actionMeta.actionLabel,
      toneClassName: actionMeta.toneClassName,
      path,
    } satisfies ParsedFileChangeSummaryLine;
  });

  return parsedLines.every((line) => line !== null) ? parsedLines : null;
}

function buildDisplayedMessagesScrollSignature(messages: Message[]): string {
  return messages
    .map((message) => {
      const artifact = message.artifact
        ? [
            message.artifact.title,
            message.artifact.activitySummary.join("\u001f"),
            message.artifact.runChecks.map((check) => `${check.label}=${check.value}`).join("\u001f"),
            message.artifact.changedFiles
              .map((file) => `${file.kind}:${file.path}:${file.summary}:${file.diffRows.length}`)
              .join("\u001f"),
            message.artifact.operationTimeline
              ? message.artifact.operationTimeline
                  .map((operation) => `${operation.type}:${operation.summary}:${operation.details?.length ?? 0}`)
                  .join("\u001f")
              : "",
          ].join("\u001e")
        : "";

      return [message.role, message.accent ? "1" : "0", message.text, artifact].join("\u001d");
    })
    .join("\u001c");
}

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function buildLiveRunScrollSignature(liveRun: LiveSessionRunState | null): string {
  if (!liveRun) {
    return "";
  }

  return [
    liveRun.assistantText,
    liveRun.reasoningText ?? "",
    liveRun.errorMessage,
    liveRun.approvalRequest
      ? [
          liveRun.approvalRequest.requestId,
          liveRun.approvalRequest.kind,
          liveRun.approvalRequest.summary,
          liveRun.approvalRequest.details ?? "",
          liveRun.approvalRequest.warning ?? "",
        ].join("\u001d")
      : "",
    liveRun.elicitationRequest
      ? [
          liveRun.elicitationRequest.requestId,
          liveRun.elicitationRequest.mode,
          liveRun.elicitationRequest.message,
          liveRun.elicitationRequest.url ?? "",
        ].join("\u001d")
      : "",
    liveRun.usage
      ? [liveRun.usage.inputTokens, liveRun.usage.cachedInputTokens, liveRun.usage.outputTokens].join(":")
      : "",
    liveRun.steps
      .map((step) => [step.id, step.type, step.status, step.summary, step.details ?? ""].join("\u001d"))
      .join("\u001c"),
    liveRun.backgroundTasks
      .map((task) => [task.id, task.kind, task.status, task.title, task.details ?? "", task.updatedAt].join("\u001d"))
      .join("\u001c"),
  ].join("\u001b");
}

export default function AgentSessionWindowApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const composerRegistryRef = useRef<ComposerControllerRegistry | null>(null);
  if (!composerRegistryRef.current) {
    composerRegistryRef.current = new ComposerControllerRegistry();
  }
  const composerRegistry = composerRegistryRef.current;
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);
  const mainSessionRuntime = useMainSessionRuntime({ api: withmateApi, selectedId, composerRegistry });
  const {
    sessions,
    pendingSubmitSessionId,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    persistSession: persistMainSessionState,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn: runMainSessionTurnFromRuntime,
  } = mainSessionRuntime;
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [modelCatalogLoadStatus, setModelCatalogLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState("");
  const conversationFeature = useSessionChatConversationFeature();
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [isPromptTemplateWorkspaceOpen, setIsPromptTemplateWorkspaceOpen] = useState(false);
  const promptTemplateCloseGuardRef = useRef<(() => boolean) | null>(null);
  const registerPromptTemplateCloseGuard = useCallback((guard: (() => boolean) | null) => {
    promptTemplateCloseGuardRef.current = guard;
  }, []);
  const [previewChatActivity, setPreviewChatActivity] = useState(() => endPreviewChatActivity());
  const [inlinePathError, setInlinePathError] = useState<{
    ownerSessionId: string;
    target: string;
    message: string;
  } | null>(null);
  const inlinePathOperationRevisionRef = useRef(new StateMutationRevision());
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [appSettingsLoadStatus, setAppSettingsLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [appSettingsLoadError, setAppSettingsLoadError] = useState("");
  const [isActivityMonitorFollowing, setIsActivityMonitorFollowing] = useState(true);
  const [hasActivityMonitorUnread, setHasActivityMonitorUnread] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const handleHeaderPreferenceChange = useCallback((value: "hidden" | "visible") => {
    void persistChatLayoutPreference(withmateApi, { target: "header", value });
  }, [withmateApi]);
  const handleActionDockPreferenceChange = useCallback((value: "compact" | "expanded") => {
    void persistChatLayoutPreference(withmateApi, { target: "actionDock", value });
  }, [withmateApi]);
  const layoutPresentation = useChatLayoutPresentation({
    initialHeader: isAppSettingsLoaded ? appSettings.chatLayoutPreference.header : null,
    initialActionDock: isAppSettingsLoaded ? appSettings.chatLayoutPreference.actionDock : null,
    onHeaderChange: handleHeaderPreferenceChange,
    onActionDockChange: handleActionDockPreferenceChange,
  });
  const {
    setIsActionDockPinnedExpanded,
  } = layoutPresentation;
  const initialAuxiliarySessionId = useMemo(() => getAuxiliarySessionIdFromLocation(), []);
  const auxiliaryWorkspace = useAuxiliaryWorkspace({
    parentSessionId: selectedId,
    api: withmateApi,
    initialSelectedId: initialAuxiliarySessionId,
  });
  useEffect(() => {
    if (!withmateApi || !selectedId) {
      return;
    }
    return withmateApi.subscribeAuxiliarySessionNavigation((payload) => {
      if (payload.parentSessionId !== selectedId) {
        return;
      }
      auxiliaryWorkspace.selectSession(payload.auxiliarySessionId);
    });
  }, [auxiliaryWorkspace.selectSession, selectedId, withmateApi]);
  const activeAuxiliarySession = auxiliaryWorkspace.target === "auxiliary" ? auxiliaryWorkspace.selectedSession : null;
  const auxiliaryBinding = auxiliaryWorkspace.getBinding(auxiliaryWorkspace.selectedId);
  const setActiveAuxiliarySession = auxiliaryBinding.setSession;
  const auxiliaryDraftPersistence = useAuxiliaryDraftPersistence({
    api: withmateApi,
    composerRegistry,
    touchRecency: auxiliaryWorkspace.touchRecency,
    isFrozen: () => composerRegistry.isFrozen,
  });
  const {
    auxiliaryLaunchDialogOpen,
    auxiliaryLaunchProviderId,
    auxiliaryLaunchFeedback,
    openAuxiliaryLaunchDialog,
    closeAuxiliaryLaunchDialog,
    selectAuxiliaryLaunchProvider,
    resetAuxiliaryLaunchFeedback,
    setAuxiliaryLaunchStartError,
  } = useAuxiliaryLaunchDialogState();
  const auxiliaryCreation = useAuxiliaryCreation({
    parentSessionId: selectedId,
    api: withmateApi,
    onCommitted: (session) => {
      auxiliaryWorkspace.addSession(session);
      setIsActionDockPinnedExpanded(true);
      setForceComposerBlockedFeedback(false);
      closeAuxiliaryLaunchDialog();
    },
    onFeedback: (message) => {
      if (message) setAuxiliaryLaunchStartError(new Error(message));
      else resetAuxiliaryLaunchFeedback();
    },
    onDiagnostic: (request, stage) => {
      withmateApi?.reportRendererLog({
        level: stage === "stale-drop" ? "warn" : "info",
        kind: "renderer.auxiliary-launch",
        message: "Auxiliary creation projection",
        correlationId: request.clientRequestId,
        data: { stage },
      });
    },
  });
  const { starting: auxiliaryCreationStarting, cancelling: auxiliaryCreationCancelling, status: auxiliaryCreationStatus } = auxiliaryCreation;
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
  const activeAuxiliarySessionRef = auxiliaryBinding.sessionRef;
  const auxiliarySessionMutationRevisionRef = auxiliaryBinding.mutationRevision;
  const auxiliaryDraftSaveQueueRef = auxiliaryBinding.draftSaveQueue;
  const auxiliarySessionSaveQueueRef = auxiliaryBinding.sessionSaveQueue;
  const auxiliarySendInFlightIdsRef = useRef<Set<string>>(new Set());
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );
  const {
    workspaceAvailability,
    workspaceAvailabilityCheckRevision,
    setWorkspaceAvailabilityCheckRevision,
    validateSessionWorkspace,
  } = useSessionWorkspaceAvailability(withmateApi, selectedSession);
  const displayedSession = useMainAuxiliaryRuntimeSession(selectedSession, activeAuxiliarySession);
  const selectedAuxiliaryRuntimeSession = useMainAuxiliaryRuntimeSession(selectedSession, auxiliaryWorkspace.selectedSession);
  const isAuxiliaryMode = activeAuxiliarySession !== null;
  const selectedSessionId = selectedSession?.id ?? null;
  const handleSidePaneChange = useCallback((sidePane: SessionSidePane) => {
    void persistChatLayoutPreference(withmateApi, { target: "sidePane", value: sidePane });
  }, [withmateApi]);
  const sidePanes = useSessionSidePanes({
    ownerKey: selectedSessionId,
    initialSidePane: isAppSettingsLoaded ? appSettings.chatLayoutPreference.sidePane : null,
    onSidePaneChange: handleSidePaneChange,
  });
  const { handleShowContextRail } = sidePanes;
  const activeRunSessionId = auxiliaryWorkspace.target === "auxiliary"
    ? auxiliaryWorkspace.selectedId
    : selectedSessionId;
  const {
    getLiveRunRevision,
    hasSelectedSessionLiveRun,
    selectedSessionLiveRun,
    setLiveRunState,
  } = useActiveSessionLiveRun(withmateApi, selectedSession, activeRunSessionId);
  const {
    approvalActionRequestId,
    elicitationActionRequestId,
    resolveLiveApproval,
    resolveLiveElicitation,
    cancelRun,
  } = useSessionRunActions({
    api: withmateApi,
    activeRunSessionId,
    setLiveRunState,
    onError: (message) => window.alert(message),
  });
  const {
    selectedProviderQuotaTelemetry,
    selectedSessionContextTelemetry,
  } = useSessionTelemetry(withmateApi, displayedSession?.provider, activeRunSessionId);
  const composerOwner = useMemo<ComposerOwner>(
    () => ({
      kind: auxiliaryWorkspace.target === "auxiliary" ? "auxiliary" : "main",
      id: activeRunSessionId ?? "__none__",
    }),
    [activeRunSessionId, auxiliaryWorkspace.target],
  );
  const composerDraft = auxiliaryWorkspace.target === "auxiliary" ? activeAuxiliarySession?.composerDraft ?? "" : "";
  const isAuxiliaryTargetUnavailable = auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession;
  const composerFeature = useSessionComposerFeature({
    api: withmateApi,
    composerRegistry,
    composerOwner,
    composerDraft,
    activeRunSessionId,
    selectedSessionId,
    sessionProvider: selectedSession?.provider ?? null,
    sessionWorkspacePath: selectedSession?.workspacePath,
    visibleRunState: activeAuxiliarySession?.runState ?? resolveSelectedSessionRunState({
      runState: selectedSession?.runState,
      hasLiveRun: hasSelectedSessionLiveRun,
    }),
    auxiliaryDraftPersistence,
    setForceComposerBlockedFeedback,
  });
  const {
    composerState,
    composerTextareaRef,
    composerOwnerRef,
    mainComposerCaretRef,
    promptTemplateSelectionRef,
    draft,
    setDraft,
    composerPreview,
    composerCaret,
    setComposerCaret,
    getComposerDraft,
    isComposerFrozen,
    pickerBaseDirectory,
    setPickerBaseDirectory,
    isAgentPickerOpen,
    setIsAgentPickerOpen,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
    closeSkillPicker,
  } = composerFeature;
  const activeRunMessageCount = activeAuxiliarySession?.messages.length ?? selectedSession?.messages.length ?? 0;
  const prepareCentralSurfaceOpenRef = useRef<() => boolean>(() => false);
  const fileRootPreview = useSessionFilesFeature({
    api: withmateApi,
    activeRunSessionId,
    prepareCentralSurfaceOpen: () => prepareCentralSurfaceOpenRef.current(),
    workspacePath: selectedSession?.workspacePath ?? null,
    additionalDirectories: activeAuxiliarySession?.allowedAdditionalDirectories
      ?? selectedSession?.allowedAdditionalDirectories
      ?? [],
    enabled: selectedSession
      ? isSessionWorkspaceAvailable(workspaceAvailability, selectedSession.id, selectedSession.workspacePath)
      : false,
  });
  const closeFilePreviews = fileRootPreview.closeFilePreviews;
  const isCentralPreviewActive = fileRootPreview.isPreviewActive
    || isPromptTemplateWorkspaceOpen;
  const closeCentralPreview = useCallback(() => {
    closeFilePreviews();
    setIsPromptTemplateWorkspaceOpen(false);
    closeSkillPicker();
    setPreviewChatActivity(endPreviewChatActivity());
  }, [closeFilePreviews, closeSkillPicker]);
  const canClosePromptTemplate = useCallback(
    () => promptTemplateCloseGuardRef.current?.() ?? true,
    [],
  );
  const prepareCentralSurfaceOpen = useCallback((): boolean => {
    const shouldBeginPreviewActivity = !isCentralPreviewActive && activeRunSessionId !== null;
    const canOpen = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen,
      canClosePromptTemplate,
      closeCentralSurface: () => {
        setIsPromptTemplateWorkspaceOpen(false);
        closeSkillPicker();
      },
    });
    if (!canOpen) {
      return false;
    }
    if (shouldBeginPreviewActivity) {
      setPreviewChatActivity(beginPreviewChatActivity(activeRunSessionId, activeRunMessageCount));
    }
    return true;
  }, [
    activeRunMessageCount,
    activeRunSessionId,
    canClosePromptTemplate,
    closeSkillPicker,
    isCentralPreviewActive,
    isPromptTemplateWorkspaceOpen,
  ]);
  prepareCentralSurfaceOpenRef.current = prepareCentralSurfaceOpen;
  const requestCentralSurfaceClose = useCallback(
    () => applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen,
      canClosePromptTemplate,
      closeCentralSurface: closeCentralPreview,
    }),
    [canClosePromptTemplate, closeCentralPreview, isPromptTemplateWorkspaceOpen],
  );
  useEffect(() => {
    if (!isCentralPreviewActive || !activeRunSessionId) {
      setPreviewChatActivity((current) => (
        current.ownerSessionId === null ? current : endPreviewChatActivity()
      ));
      return;
    }

    setPreviewChatActivity((current) => observePreviewChatMessageCount(
      current,
      activeRunSessionId,
      activeRunMessageCount,
    ));
  }, [activeRunMessageCount, activeRunSessionId, isCentralPreviewActive]);
  const {
    session: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    sourceLabel: auditLogSourceLabel,
  } = resolveAuditLogOwner({
    parentSession: selectedSession,
    displayedSession,
    parentSourceLabel: "Main session",
  });
  const {
    modalProps: auditLogModalProps,
    setAuditLogsOpen,
    persistedEntries: selectedSessionAuditLogs,
  } = useSessionAuditLogs({
    withmateApi,
    selectedSession: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    cacheScopeKey: "session",
    sourceLabel: auditLogSourceLabel,
    liveRun: selectedSessionLiveRun,
  });
  const selectedSessionRunState: Session["runState"] | null = resolveSelectedSessionRunState({
    runState: selectedSession?.runState,
    hasLiveRun: hasSelectedSessionLiveRun,
  });
  const visibleSessionRunState: Session["runState"] | null = activeAuxiliarySession?.runState ?? selectedSessionRunState;
  const liveRunAssistantText = selectedSessionLiveRun?.assistantText ?? "";
  const liveApprovalRequest = selectedSessionLiveRun?.approvalRequest ?? null;
  const liveElicitationRequest = selectedSessionLiveRun?.elicitationRequest ?? null;
  const isApprovalRequestPending = !!liveApprovalRequest;
  const isElicitationRequestPending = !!liveElicitationRequest;
  const hasLiveRunAssistantText = liveRunAssistantText.length > 0;

  const selectedSessionCharacter = useMemo(
    () =>
      displayedSession
        ? {
            id: displayedSession.characterId,
            name: displayedSession.character.trim() || DEFAULT_SESSION_RUNTIME_NAME,
            iconPath: displayedSession.characterIconPath,
            description: "",
            roleMarkdown: "",
            notesMarkdown: "",
            updatedAt: displayedSession.updatedAt,
            themeColors: displayedSession.characterThemeColors,
          }
        : null,
    [displayedSession],
  );
  const isSelectedSessionReadOnly = selectedSession ? isReadOnlySession(selectedSession) : false;
  const persistSession = useCallback(async (nextSession: Session) => {
    return persistMainSessionState(nextSession, isSelectedSessionReadOnly);
  }, [isSelectedSessionReadOnly, persistMainSessionState]);
  const sessionHeader = useSessionHeaderOperations({
    api: withmateApi,
    selectedSession,
    isReadOnly: isSelectedSessionReadOnly,
    runState: selectedSessionRunState,
    persistSession,
    closeWindow: () => window.close(),
  });
  const {
    titleDraft,
    setTitleDraft,
    isEditingTitle,
    startTitleEdit: handleStartTitleEdit,
    cancelTitleEdit: handleCancelTitleEdit,
    saveTitle: handleSaveTitle,
    deleteSession: handleDeleteSession,
  } = sessionHeader;
  const chatShellFeature = useSessionChatShellFeature({
    ownerKey: selectedSessionId,
    presentation: layoutPresentation,
    sidePanes,
    isEditingTitle,
    forceActionDockExpanded: [
      isAgentPickerOpen,
      isSkillPickerOpen,
      isRetryDraftReplacePending,
    ],
    focusComposer: () => restoreCurrentComposerTextareaFocusToEnd(() => composerTextareaRef.current),
  });
  const sessionThemeStyle = useMemo(
    () => (selectedSession ? buildCharacterThemeStyle(selectedSession.characterThemeColors) : undefined),
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : {}),
    [selectedDiff],
  );
  const isSelectedProviderEnabled = useMemo(
    () => !!displayedSession && getProviderAppSettings(appSettings, displayedSession.provider).enabled,
    [appSettings, displayedSession],
  );
  const auxiliaryLaunchProviderItems = useMemo(
    () => buildAuxiliaryLaunchProviderItems(
      modelCatalog?.providers ?? [],
      (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
    ),
    [appSettings, modelCatalog],
  );
  const auxiliaryProviderLoadStatus: ProviderLaunchLoadStatus = modelCatalogLoadStatus === "error"
    || appSettingsLoadStatus === "error"
    ? "error"
    : modelCatalogLoadStatus === "loading" || appSettingsLoadStatus === "loading"
      ? "loading"
      : "loaded";
  const auxiliaryProviderLoadError = modelCatalogLoadStatus === "error"
    ? modelCatalogLoadError
    : appSettingsLoadStatus === "error"
      ? appSettingsLoadError
      : "";
  const workspaceExecutionGate = useMemo(
    () => selectedSession
      ? resolveSessionWorkspaceExecutionGate(
          workspaceAvailability,
          selectedSession.id,
          selectedSession.workspacePath,
        )
      : { isPending: false, blockedReason: "" },
    [selectedSession, workspaceAvailability],
  );
  const isSelectedWorkspaceAvailable = selectedSession
    ? isSessionWorkspaceAvailable(
        workspaceAvailability,
        selectedSession.id,
        selectedSession.workspacePath,
      )
    : false;
  const workspaceAvailabilityMessage = selectedSession
    ? resolveSessionWorkspaceUnavailableMessage(
        workspaceAvailability,
        selectedSession.id,
        selectedSession.workspacePath,
      )
    : "";
  const isWorkspaceAvailabilityCheckPending = workspaceAvailability.status === "checking"
    && workspaceAvailability.sessionId === selectedSession?.id;
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isSelectedSessionReadOnly) {
      return "This session is read-only. Create a new session to send messages.";
    }

    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      return auxiliaryWorkspace.detailError?.message ?? auxiliaryWorkspace.error?.message ?? "";
    }

    if (!isSelectedProviderEnabled) {
      return "Provider is disabled. Enable it in Settings.";
    }

    if (workspaceExecutionGate.blockedReason) {
      return workspaceExecutionGate.blockedReason;
    }

    return "";
  }, [activeAuxiliarySession, auxiliaryWorkspace.detailError, auxiliaryWorkspace.error, auxiliaryWorkspace.target, isSelectedProviderEnabled, isSelectedSessionReadOnly, selectedSession, workspaceExecutionGate]);
  const composerBusyReason = pendingSubmitSessionId !== null && pendingSubmitSessionId === activeRunSessionId
    ? "Message submission is in progress."
    : workspaceExecutionGate.isPending
      ? "Workspace availability is being checked."
      : "";
  const composerBlockedReason = composerBusyReason || sessionExecutionBlockedReason;

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  const glossary = useSessionGlossary({
    api: withmateApi,
    selectedSession: selectedSession ? {
      id: selectedSession.id,
      revision: selectedSession.updatedAt,
      workspaceLabel: selectedSession.workspaceLabel,
      branch: selectedSession.branch,
    } : null,
    onActivatePane: () => contextPaneFeature.showGlossary(),
  });
  const sessionGlossaryPaneProps = glossary.paneProps;
  const handleActivateGlossaryEntry = glossary.actions.onActivateGlossaryEntry;
  const glossaryAnnotationMatcher = glossary.annotationMatcher;

  useEffect(() => {
    applySessionDocumentTitle(resolveAgentSessionDocumentTitle({
      sessionTitle: selectedSession?.taskTitle,
      sessionId: selectedId,
    }));
  }, [selectedId, selectedSession?.taskTitle]);

  const {
    availableSkills,
    availableCustomAgents,
    isCustomAgentListLoading,
    isSkillListLoading,
    skillListError,
  } = useResourceDiscovery({
    api: withmateApi,
    activeRunSessionId,
    displayedProvider: displayedSession?.provider,
    selectedProvider: selectedSession?.provider,
    selectedWorkspacePath: selectedSession?.workspacePath,
    auxiliaryProvider: activeAuxiliarySession?.provider,
    appSettingsRevision: appSettings,
  });

  useEffect(() => {
    return startModelCatalogSubscription({
      api: withmateApi,
      enabled: true,
      subscribe: true,
      applyModelCatalog: (snapshot) => {
        setModelCatalog(snapshot);
        setModelCatalogLoadStatus("loaded");
        setModelCatalogLoadError("");
      },
      onInitialLoadError: (error) => {
        setModelCatalog(null);
        setModelCatalogLoadStatus("error");
        setModelCatalogLoadError(error instanceof Error ? error.message : "Could not load model catalog.");
      },
    });
  }, [selectedSession?.id, withmateApi]);

  useEffect(() => {
    return startAppSettingsSubscription({
      api: withmateApi,
      loadInitial: true,
      applyAppSettings: (settings) => {
        setAppSettings(settings);
        setIsAppSettingsLoaded(true);
        setAppSettingsLoadStatus("loaded");
        setAppSettingsLoadError("");
      },
      onInitialLoadError: (error) => {
        setAppSettingsLoadStatus("error");
        setAppSettingsLoadError(error instanceof Error ? error.message : "Could not load app state.");
      },
    });
  }, [withmateApi]);

  const displayedMessages: Message[] = displayedSession?.messages ?? [];
  const activityMonitorScrollSignature = useMemo(
    () => buildLiveRunScrollSignature(selectedSessionLiveRun),
    [selectedSessionLiveRun],
  );
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const isMessageListFollowing = true;
  const handleMessageListScroll = useCallback(() => {}, []);
  const followMessageListLatest = useCallback(() => {}, []);

  useEffect(() => {
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    setIsRetryDraftReplacePending(false);
  }, [selectedSession?.provider, selectedSessionId]);

  useEffect(() => {
    if (!draft.trim()) {
      setIsRetryDraftReplacePending(false);
    }
  }, [draft]);

  useLayoutEffect(() => {
    const isActivityMonitorVisible = visibleSessionRunState === "running";
    const activityMonitorElement = activityMonitorRef.current;
    const currentSignature = activityMonitorScrollSignature;
    const wasSameSession = activityMonitorSessionIdRef.current === selectedSessionId;
    const hasSignatureChanged = activityMonitorSignatureRef.current !== currentSignature;

    if (!isActivityMonitorVisible) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      setIsActivityMonitorFollowing(true);
      setHasActivityMonitorUnread(false);
      return;
    }

    if (!activityMonitorElement) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      return;
    }

    if (!wasSameSession) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      setIsActivityMonitorFollowing(true);
      setHasActivityMonitorUnread(false);
      activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    activityMonitorSignatureRef.current = currentSignature;

    if (isActivityMonitorFollowing) {
      activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
      return;
    }

    setHasActivityMonitorUnread(true);
  }, [activityMonitorScrollSignature, isActivityMonitorFollowing, visibleSessionRunState, selectedSessionId]);

  const selectedProviderCatalog = useMemo(
    () => (modelCatalog && displayedSession ? getProviderCatalog(modelCatalog.providers, displayedSession.provider) : null),
    [displayedSession, modelCatalog],
  );
  const availableReasoningEfforts = useMemo(
    () =>
      selectedProviderCatalog && displayedSession
        ? getReasoningEffortOptionsForModel(selectedProviderCatalog, displayedSession.model)
        : [],
    [displayedSession, selectedProviderCatalog],
  );
  const modelOptions = useMemo(() => {
    if (!selectedProviderCatalog) {
      return [];
    }

    const options = [...selectedProviderCatalog.models];
    if (!displayedSession) {
      return options;
    }

    const hasSelectedModel = options.some((model) => model.id === displayedSession.model);
    if (!hasSelectedModel) {
      options.unshift({
        id: displayedSession.model,
        label: displayedSession.model,
        reasoningEfforts: availableReasoningEfforts.length > 0 ? [...availableReasoningEfforts] : [displayedSession.reasoningEffort],
      });
    }

    return options;
  }, [availableReasoningEfforts, displayedSession, selectedProviderCatalog]);
  const lastUserMessage = useMemo(
    () =>
      selectedSession
        ? [...selectedSession.messages].reverse().find((message) => message.role === "user") ?? null
        : null,
    [selectedSession],
  );
  const contextRenderedIsRunning = activeAuxiliarySession
    ? activeAuxiliarySession.runState === "running"
    : resolveSelectedSessionIsRunning({ runState: selectedSessionRunState });
  const contextPaneFeature = useSessionContextPaneFeature({
    selectedSession,
    displayedSession,
    activeRunSessionId,
    character: selectedSessionCharacter,
    liveRun: selectedSessionLiveRun,
    auditLogEntries: selectedSessionAuditLogs,
    selectedSessionContextTelemetry,
    selectedProviderQuotaTelemetry,
    availableReasoningEfforts,
    renderedIsRunning: contextRenderedIsRunning,
    glossaryPaneProps: sessionGlossaryPaneProps,
    onShowContextRail: handleShowContextRail,
  });
  const {
    rightPaneProps: contextPaneProps,
    hasInProgressLiveRunStep,
  } = contextPaneFeature;
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!selectedSession || !shouldShowRetryBanner({
      hasActiveAuxiliarySession: !!activeAuxiliarySession,
      hasLastUserMessage: !!lastUserMessage,
      isReadOnly: isSelectedSessionReadOnly,
      runState: selectedSessionRunState,
    })) {
      return null;
    }

    const source = resolveRetryBannerSource({
      sessionId: selectedSession.id,
      messages: selectedSession.messages,
      auditLogs: selectedSessionAuditLogs,
      runState: selectedSessionRunState,
    });
    if (!source) {
      return null;
    }

    const { kind, lastRequestText } = source;

    switch (kind) {
      case "interrupted":
        return {
          kind,
          badge: "Interrupted",
          title: "The previous request was interrupted",
          lastRequestText,
        };
      case "failed":
        return {
          kind,
          badge: "Failed",
          title: "The previous request could not be completed",
          lastRequestText,
        };
      case "canceled":
        return {
          kind,
          badge: "Canceled",
          title: "This request was stopped",
          lastRequestText,
        };
      default:
        return null;
    }
  }, [
    lastUserMessage,
    selectedSession,
    selectedSessionAuditLogs,
    selectedSessionRunState,
    isSelectedSessionReadOnly,
    activeAuxiliarySession,
  ]);
  const shouldProtectDraftOnRetryEdit = () => shouldProtectRetryEditDraft({
    retryBanner,
    draft: getComposerDraft(),
  });
  const isComposerDisabled = selectedSessionRunState === "running" || !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        busyReason: composerBusyReason,
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: getComposerDraft(),
        forceBlockedFeedback: forceComposerBlockedFeedback,
      }),
    [
      composerBusyReason,
      composerPreview.errors,
      draft,
      forceComposerBlockedFeedback,
      selectedSessionRunState,
      sessionExecutionBlockedReason,
    ],
  );
  const isSendDisabled = composerSendability.isSendDisabled;
  const isRetryActionDisabled = resolveRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: !!lastUserMessage,
    composerBlocked: !!composerBlockedReason,
    isReadOnly: isSelectedSessionReadOnly,
    runState: selectedSessionRunState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const {
    handleExpandActionDock,
    handleToggleActionDock,
  } = chatShellFeature;
  useEffect(() => {
    if (!retryBanner) {
      setIsRetryDraftReplacePending(false);
    }
  }, [retryBanner]);

  useEffect(() => {
    setForceComposerBlockedFeedback(false);
  }, [selectedSession?.id]);

  const triggerComposerBlockedFeedback = () => {
    if (!selectedSession || selectedSessionRunState === "running") {
      return;
    }

    setForceComposerBlockedFeedback(true);
  };

  const sendMessage = async (
    messageText: string,
    options?: { clearDraft?: boolean; collapseActionDock?: boolean; submitSource?: "composer" | "retry" },
  ) => {
    if (!withmateApi || !selectedSession) {
      return;
    }
    const sessionId = selectedSession.id;
    const clientRequestId = createSessionTurnClientRequestId();
    const request: RunSessionTurnRequest = {
      userMessage: messageText,
      clientRequestId,
      submitSource: options?.submitSource ?? "composer",
      codexReviewer: selectedSession.codexReviewer,
    };
    await runMainSessionTurnFromRuntime({
      sessionId,
      selectedSession,
      request,
      composerOwner,
      clearDraft: options?.clearDraft ?? true,
      shouldCollapseActionDock: options?.collapseActionDock ?? false,
      isCentralPreviewActive,
      hasLiveRun: !!selectedSessionLiveRun,
      selectedSessionRunState,
      blockedReason: sessionExecutionBlockedReason,
      isReadOnly: isSelectedSessionReadOnly,
      currentTimestamp: currentTimestampLabel(),
      validateWorkspace: () => validateSessionWorkspace(selectedSession, true),
      liveRun: { getRevision: getLiveRunRevision, setState: setLiveRunState },
      acknowledgePreviewChatMessageCount: (id, count) => setPreviewChatActivity((current) => acknowledgePreviewChatMessageCount(current, id, count)),
      collapseActionDock: () => setIsActionDockPinnedExpanded(false),
      log: logSessionRunStuckInvestigation,
    });
  };

  const handleSend = async () => {
    if (composerRegistry.isFrozen) return;
    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      triggerComposerBlockedFeedback();
      return;
    }
    if (activeAuxiliarySession) {
      const auxiliaryDraft = composerState.capture().draft;
      const currentComposerState = composerRegistry.get(composerOwner);
      const auxiliarySessionId = activeAuxiliarySession.id;
      if (auxiliarySendInFlightIdsRef.current.has(auxiliarySessionId) || composerBusyReason) {
        return;
      }
      if (currentComposerState.saveState === "error" || currentComposerState.preview.errors.length > 0) {
        triggerComposerBlockedFeedback();
        return;
      }
      if (!auxiliaryDraft.trim() || activeAuxiliarySession.runState === "running") {
        triggerComposerBlockedFeedback();
        return;
      }

      auxiliarySendInFlightIdsRef.current.add(auxiliarySessionId);
      try {
        setForceComposerBlockedFeedback(false);
        await sendAuxiliaryMessage(auxiliaryDraft);
      } catch (error) {
        window.alert(resolveSessionRunErrorMessage(error, "Could not send the message."));
      } finally {
        auxiliarySendInFlightIdsRef.current.delete(auxiliarySessionId);
      }
      return;
    }

    if (isComposerDisabled || !getComposerDraft().trim()) {
      triggerComposerBlockedFeedback();
      return;
    }

    try {
      setForceComposerBlockedFeedback(false);
      await sendMessage(draft, {
        clearDraft: true,
        collapseActionDock: appSettings.autoCollapseActionDockOnSend,
        submitSource: "composer",
      });
    } catch (error) {
      window.alert(resolveSessionRunErrorMessage(error, "Could not send the message."));
    }
  };

  const handleCancelRun = async () => {
    await cancelRun(buildRunningSessionCancelTarget({
      sessionId: selectedSession?.id,
      runState: selectedSessionRunState,
      isRunning: isSelectedSessionRunning,
    }));
  };

  const handleComposerSubmitShortcut = () => applyComposerSubmitCommand({
    isSubmitDisabled: () => {
      const current = composerRegistry.get(composerOwner);
      return composerRegistry.isFrozen
        || current.isImeComposing
        || current.saveState === "error"
        || (activeAuxiliarySession
          ? activeAuxiliarySession.runState === "running"
          : current.preview.errors.length > 0 || selectedSessionRunState === "running");
    },
    isSubmitBlocked: () => {
      const current = composerRegistry.get(composerOwner);
      const activeSendability = activeAuxiliarySession
        ? buildComposerSendabilityState({
            runState: activeAuxiliarySession.runState,
            busyReason: composerBusyReason,
            blockedReason: sessionExecutionBlockedReason,
            inputErrors: current.preview.errors,
            draftText: current.draft,
          })
        : resolveComposerSendabilityState({
            runState: selectedSessionRunState,
            busyReason: composerBusyReason,
            blockedReason: sessionExecutionBlockedReason,
            inputErrors: current.preview.errors,
            draftText: current.draft,
            forceBlockedFeedback: forceComposerBlockedFeedback,
          });
      return current.saveState === "error" || activeSendability.isSendDisabled;
    },
    notifySubmitBlocked: triggerComposerBlockedFeedback,
    submit: () => void handleSend(),
  });

  useShortcutDispatcherSettings(appSettings.keyboardShortcuts);
  useShortcutScope("composer");
  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.composerSubmit, handleComposerSubmitShortcut);

  const handleSelectSkill = createSkillPromptInsertionHandler<DiscoveredSkill>({
    getProvider: () => selectedSession?.provider,
    getDraft: () => getComposerDraft(),
    getTextarea: () => composerTextareaRef.current,
    setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
    setCaret: setComposerCaret,
    setSkillPickerOpen: setIsSkillPickerOpen,
    applyDraft: (nextDraft, nextCaret) => {
      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft,
        syncMainComposerCaret: (selectionStart) => {
          mainComposerCaretRef.current = selectionStart;
        },
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const closeAgentPicker = createAgentPickerCloseHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
  });

  const handleSelectCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    if (composerRegistry.isFrozen || !selectedSession || isSelectedSessionReadOnly || selectedSession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === selectedSession.customAgentName) {
      closeAgentPicker();
      return;
    }

    await runMainRuntimeOption({ kind: "custom-agent", value: nextCustomAgentName });
    closeAgentPicker();
  };

  const handleToggleSessionPin = async () => {
    if (!withmateApi || !selectedSession || isSessionPinPending) {
      return;
    }
    try {
      await toggleSessionPin(selectedSession);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not update the pin.");
    }
  };

  const runMainRuntimeOption = async (option: MainRuntimeOption) => {
    if (!withmateApi) return;
    await runMainRuntimeOptionOperation({
      session: selectedSession,
      isReadOnly: isSelectedSessionReadOnly,
      runState: selectedSessionRunState,
      providerCatalog: selectedProviderCatalog,
      catalogRevision: modelCatalog?.revision ?? null,
      option,
      persist: persistSession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(diffPreview);
  };

  const updateActiveAuxiliarySession = async (recipe: (current: AuxiliarySession) => AuxiliarySession) => {
    await createGuardedActiveAuxiliarySessionUpdater({
      activeSession: activeAuxiliarySession,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      getApi: () => withmateApi,
      activeSessionRef: activeAuxiliarySessionRef,
      setActiveSession: setActiveAuxiliarySession,
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
    })(recipe);
  };

  const handleToggleMessageBookmark = async (target: MessageCollapseTarget): Promise<void> => {
    const nextIsBookmarked = !target.isBookmarked;
    if (target.source.kind === "auxiliary") {
      if (
        isSelectedSessionReadOnly
        || !activeAuxiliarySession
        || activeAuxiliarySession.runState === "running"
        || activeAuxiliarySession.id !== target.source.sessionId
      ) {
        return;
      }

      await updateActiveAuxiliarySession((current) => {
        const message = current.messages[target.source.messageIndex];
        if (!message) {
          return current;
        }

        return {
          ...current,
          updatedAt: currentTimestampLabel(),
          messages: current.messages.map((currentMessage, index) => (
            index === target.source.messageIndex
              ? setMessageBookmarked(currentMessage, nextIsBookmarked)
              : currentMessage
          )),
        };
      });
      return;
    }

    if (!selectedSession || isSelectedSessionReadOnly || selectedSessionRunState === "running") {
      return;
    }

    const message = selectedSession.messages[target.source.messageIndex];
    if (!message) {
      return;
    }

    await persistSession({
      ...selectedSession,
      updatedAt: currentTimestampLabel(),
      messages: selectedSession.messages.map((currentMessage, index) => (
        index === target.source.messageIndex
          ? setMessageBookmarked(currentMessage, nextIsBookmarked)
          : currentMessage
      )),
    });
  };

  const handleSelectAuxiliaryCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    if (composerRegistry.isFrozen) return;
    const nextCustomAgentName = (agent?.name ?? "").trim();
    await runAuxiliaryCustomAgentSelectionOperation({
      activeSession: activeAuxiliarySession,
      customAgentName: nextCustomAgentName,
      updateCustomAgent: async (customAgentName) => {
        await runAuxiliaryCustomAgentPatchOperation({
          customAgentName,
          updateActiveAuxiliarySession,
          createTimestampLabel: currentTimestampLabel,
        });
      },
      closeAgentPicker,
    });
  };

  const handleSelectAuxiliarySkill = async (skill: DiscoveredSkill) => {
    if (composerRegistry.isFrozen) return;
    const textarea = composerTextareaRef.current;
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: activeAuxiliarySession
        ? { ...activeAuxiliarySession, composerDraft: getComposerDraft() }
        : null,
      skillName: skill.name,
      applyUiState: (nextState) => {
        applySkillPromptInsertionUiState({
          state: nextState,
          setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
          setCaret: setComposerCaret,
          setSkillPickerOpen: setIsSkillPickerOpen,
        });
      },
      updateDraft: async (draft) => {
        await handleAuxiliaryDraftChange(draft, draft.length);
      },
      afterDraftUpdated: (nextState) => {
        if (composerOwnerRef.current === activeRunSessionId) {
          restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
        }
      },
    });
  };

  const handleResendLastMessage = async () => {
    await runRetryResendCommand({
      isDisabled: !!composerBlockedReason || isSelectedSessionReadOnly,
      messageText: lastUserMessage?.text,
      resendMessage: (messageText) => sendMessage(messageText, { clearDraft: false, submitSource: "retry" }),
    });
  };

  const restoreLastUserMessageToDraft = (messageText: string) => {
    if (composerRegistry.isFrozen) return;
    const textarea = composerTextareaRef.current;
    applyRetryDraftRestoreCommand({
      messageText,
      setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
      setDraft,
      setCaret: setComposerCaret,
      syncCaret: (caret) => {
        mainComposerCaretRef.current = caret;
      },
      setRetryDraftReplacePending: setIsRetryDraftReplacePending,
      focusComposer: (caret) => restoreComposerTextareaFocusAndCaret(textarea, caret),
    });
  };

  const handleEditLastMessage = createRetryEditHandler({
    isDisabled: !retryBanner || isRetryEditDisabled,
    messageText: lastUserMessage?.text,
    shouldProtectDraft: shouldProtectDraftOnRetryEdit,
    requestDraftReplaceConfirmation: () => setIsRetryDraftReplacePending(true),
    restoreDraft: restoreLastUserMessageToDraft,
  });

  const handleConfirmRetryDraftReplace = createRetryDraftReplaceConfirmationHandler({
    isDisabled: !retryBanner || isRetryEditDisabled,
    messageText: lastUserMessage?.text,
    restoreDraft: restoreLastUserMessageToDraft,
  });

  const handleCancelRetryDraftReplace = createCancelRetryDraftReplaceHandler({
    setRetryDraftReplacePending: setIsRetryDraftReplacePending,
  });

  const handleOpenInlinePath = async (target: string, ownerSessionId = activeRunSessionId) => {
    if (!withmateApi || !ownerSessionId) {
      return;
    }
    inlinePathOperationRevisionRef.current.advance();
    const operationRevision = inlinePathOperationRevisionRef.current.capture();
    try {
      const result = await withmateApi.openSessionFilePreviewWindow({
        kind: "link",
        sessionId: ownerSessionId,
        target,
      });
      if (!inlinePathOperationRevisionRef.current.isCurrent(operationRevision)) {
        return;
      }
      setInlinePathError(result.status === "opened"
        ? null
        : { ownerSessionId, target, message: result.message });
    } catch (error) {
      if (!inlinePathOperationRevisionRef.current.isCurrent(operationRevision)) {
        return;
      }
      setInlinePathError({
        ownerSessionId,
        target,
        message: error instanceof Error ? error.message : "The path could not be opened.",
      });
    }
  };

  const handleCancelAuxiliaryRun = async () => {
    try {
      await runRunningSessionCancelOperation({
        target: buildAuxiliarySessionCancelTarget({ session: activeAuxiliarySession }),
        cancelRun: withmateApi ? (sessionId) => withmateApi.cancelAuxiliarySessionRun(sessionId) : null,
      });
    } catch (error) {
      window.alert(resolveSessionRunErrorMessage(error, "Could not cancel the run."));
    }
  };

  const handleOpenAuxiliaryLaunchDialog = createAuxiliaryLaunchDialogOpenHandler({
    canOpen: () => !!selectedSession,
    providers: auxiliaryLaunchProviderItems,
    getSelectedProviderId: () => selectedSession?.provider,
    openAuxiliaryLaunchDialog: (params) => {
      openAuxiliaryLaunchDialog(params);
      const feedback = resolveAuxiliaryLaunchCreationFeedback({ status: auxiliaryCreationStatus ?? "not-found" });
      if (feedback) setAuxiliaryLaunchStartError(new Error(feedback));
    },
  });

  const handleCloseAuxiliaryLaunchDialog = createAuxiliaryLaunchDialogCloseHandler({
    closeAuxiliaryLaunchDialog,
  });

  const handleSelectAuxiliaryLaunchProvider = createAuxiliaryLaunchProviderSelectHandler({
    selectAuxiliaryLaunchProvider,
  });

  const handleStartAuxiliarySession = async () => {
    if (
      !selectedSession
      || isSelectedSessionReadOnly
      || !isSelectedWorkspaceAvailable
      || auxiliaryProviderLoadStatus !== "loaded"
    ) return;
    const startProvider = resolveAuxiliaryLaunchStartProvider({
      providerId: resolveAuxiliaryLaunchProviderId(auxiliaryLaunchProviderItems, auxiliaryLaunchProviderId),
    });
    if (startProvider.status === "blocked") {
      setAuxiliaryLaunchStartError(startProvider.error);
      return;
    }
    await auxiliaryCreation.start(startProvider.providerId);
  };

  const handleCancelAuxiliaryCreation = () => auxiliaryCreation.cancel();

  const handleAuxiliaryDraftChange = async (value: string, selectionStart: number) => {
    const session = activeAuxiliarySession;
    if (!session || composerRegistry.isFrozen) return;
    setForceComposerBlockedFeedback(false);
    await auxiliaryDraftPersistence.changeDraft(session, value, selectionStart);
  };

  const handleRetryAuxiliaryDraftSave = () => {
    if (!activeAuxiliarySession || composerRegistry.isFrozen) return;
    auxiliaryDraftPersistence.retrySave(activeAuxiliarySession);
  };

  const sendAuxiliaryMessage = (messageText: string): Promise<void> => {
    if (composerRegistry.isFrozen) return Promise.resolve();
    return auxiliaryDraftPersistence.trackSend(performAuxiliarySend(messageText));
  };

  const performAuxiliarySend = async (messageText: string) => {
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const sendCapture = composerRegistry.capture(composerOwner);
    messageText = sendCapture.draft;
    const draftOwner = auxiliaryDraftPersistence.getOwner(activeAuxiliarySession);
    try {
      await draftOwner?.flush();
      await draftOwner?.ensureLoaded();
    } catch {
      composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
      return;
    }
    if (composerRegistry.isFrozen) return;
    const durableDraft = draftOwner?.durableRecord;
    const latestCapture = composerRegistry.capture(composerOwner);
    if (!draftOwner || !durableDraft || latestCapture.revision !== sendCapture.revision || latestCapture.draft !== sendCapture.draft || durableDraft.text !== sendCapture.draft) {
      // A newer local revision is a normal send-capture invalidation, not a save failure.
      // Keep it editable and let the next explicit Send capture that revision.
      if (latestCapture.revision !== sendCapture.revision || latestCapture.draft !== sendCapture.draft) {
        composerRegistry.setSaveState(composerOwner, "saved");
      } else {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
      }
      return;
    }

    let clearedRevision: number | null = null;
    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: activeAuxiliarySession,
      composerBlockedReason: sessionExecutionBlockedReason,
      messageText,
      auxiliaryDraftIncarnation: durableDraft.incarnation,
      auxiliaryDraftDurableRevision: durableDraft.durableRevision,
      parentMessageCount: selectedSession?.messages.length ?? null,
      updatedAt: currentTimestampLabel(),
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      canStartRun: () => !composerRegistry.isFrozen,
      beforeRunningSessionApplied: () => {
        clearedRevision = composerRegistry.clearIfRevision(composerOwner, sendCapture.revision);
        setIsActionDockPinnedExpanded(false);
      },
      onRunError: () => {
        if (clearedRevision !== null) {
          const restoredRevision = composerRegistry.restoreIfRevision(composerOwner, clearedRevision, () => sendCapture.draft);
          if (restoredRevision !== null) {
            void auxiliaryDraftPersistence.observeSave(activeAuxiliarySession.id, restoredRevision, draftOwner.enqueue(sendCapture.draft, durableDraft));
          }
        }
      },
      applyRunningSession: createAuxiliarySessionRunningApplier({
        activeSessionRef: activeAuxiliarySessionRef,
        setActiveSession: setActiveAuxiliarySession,
        updateLiveRunState: (update) => setLiveRunState(update),
        buildRuntimeSession: (runningSession) => buildMainAuxiliaryRuntimeSession(
          selectedSession!,
          runningSession,
        ),
      }),
      afterRunningSessionApplied: (runningSession) => {
        if (isCentralPreviewActive) {
          setPreviewChatActivity((current) => acknowledgePreviewChatMessageCount(
            current,
            runningSession.id,
            runningSession.messages.length,
          ));
        }
      },
      ...createAuxiliarySessionSendResultAppliers({
        activeSessionRef: activeAuxiliarySessionRef,
        setActiveSession: setActiveAuxiliarySession,
      }),
      clearPendingLiveRun: createAuxiliarySessionPendingLiveRunClearer({
        updateLiveRunState: (update) => setLiveRunState(update),
      }),
      api: withmateApi,
    });
    await draftOwner?.reload().catch(() => undefined);
    handleAuxiliarySessionSendOperationResult({
      result,
      onBlocked: (preflight) => {
        throw new Error(preflight.blockedMessage);
      },
      onRunningTargetBlocked: () => {
        throw new Error("The Auxiliary session is still running.");
      },
      onError: (error) => {
        console.error(error);
        throw error;
      },
    });
  };

  const handleCopyMessageText = createCopyMessageTextHandler({
    writeText: (normalized) => navigator.clipboard.writeText(normalized),
    onFailure: (error) => {
      console.error(error);
      window.alert("Could not copy the content.");
    },
  });

  const handleQuoteMessageText = createQuoteMessageTextHandler({
    isBlocked: () => (
      composerRegistry.isFrozen || (activeAuxiliarySession
        ? activeAuxiliarySession.runState === "running" || !!composerBlockedReason
        : isComposerDisabled)
    ),
    notifyBlocked: triggerComposerBlockedFeedback,
    getComposerState: () => ({
      draft: getComposerDraft(),
      fallbackCaret: composerRegistry.get(composerOwner).selection.start,
      textarea: composerTextareaRef.current,
    }),
    applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
      if (activeAuxiliarySession) {
        void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        return;
      }

      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft,
        setComposerCaret,
        syncMainComposerCaret: (selectionStart) => {
          mainComposerCaretRef.current = selectionStart;
        },
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const insertReferencePaths = (selectedPaths: string[]) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea = composerOwnerRef.current === activeRunSessionId ? composerTextareaRef.current : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
    applySelectedPathReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: targetAuxiliarySession ? composerCaret : mainComposerCaretRef.current,
      selectedPaths,
      textarea,
      workspacePath: selectedSession?.workspacePath ?? null,
      applyInsertion: (insertionState) => {
        const { draft: nextDraft, caret: nextCaret } = insertionState;
        if (targetAuxiliarySession) {
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
          setComposerCaret(nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  const insertReferencePath = (selectedPath: string) => {
    insertReferencePaths([selectedPath]);
  };

  const insertPastedAttachments = (references: ComposerReferenceInput[]) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea = composerOwnerRef.current === activeRunSessionId ? composerTextareaRef.current : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
    applyComposerReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: composerCaret,
      references,
      textarea,
      applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
        if (targetAuxiliarySession) {
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
          setComposerCaret(nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  const pickAndInsertPath = async (kind: ComposerPathPickerKind) => {
    if (composerRegistry.isFrozen || !withmateApi || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await pickComposerReferencePath(
      kind,
      pickerBaseDirectory || selectedSession?.workspacePath || null,
      withmateApi,
    );
    if (composerRegistry.isFrozen) return;
    applyPickedComposerReferencePathCommand({
      kind,
      selectedPath,
      setPickerBaseDirectory,
      insertReferencePath: (path) => insertReferencePath(path),
    });
  };

  const handleAddToSessionFiles = async () => {
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickFiles(pickerBaseDirectory || selectedSession.workspacePath || null);
    if (composerRegistry.isFrozen || selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(selectedSession.id, selectedPaths);
    if (composerRegistry.isFrozen || savedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: savedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionFiles = async () => {
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickSessionFiles(selectedSession.id);
    if (composerRegistry.isFrozen || selectedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: selectedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionFolder = async () => {
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionFolder(selectedSession.id);
    if (composerRegistry.isFrozen || !selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionImage = async () => {
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionImageFile(selectedSession.id);
    if (composerRegistry.isFrozen || !selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handleComposerPaste = createPastedSessionAttachmentHandler({
    alertError: (message) => window.alert(message),
    canPaste: () => {
      const targetAuxiliarySession = activeAuxiliarySession;
      return !!withmateApi &&
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isAuxiliaryTargetUnavailable &&
        !isSelectedSessionReadOnly &&
        !(targetAuxiliarySession
          ? targetAuxiliarySession.runState === "running"
          : selectedSessionRunState === "running");
    },
    currentTimestampLabel,
    fallbackErrorMessage: "Could not save the pasted file.",
    getSavePastedSessionFile: () => {
      return withmateApi ? (request) => {
        if (composerRegistry.isFrozen) throw new Error("Attachments cannot be added while the window is closing.");
        return withmateApi.savePastedSessionFile(request);
      } : null;
    },
    getSessionId: () => selectedSession?.id,
    insertAttachments: insertPastedAttachments,
  });

  const handleAddAdditionalDirectory = async () => {
    await runPickedAdditionalDirectoryOperation({
      canPickDirectory: () => !!withmateApi &&
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isSelectedSessionReadOnly &&
        selectedSessionRunState !== "running",
      getPickerBaseDirectory: () => resolveAdditionalDirectoryPickerBase(pickerBaseDirectory, selectedSession?.workspacePath),
      pickDirectory: (baseDirectory) => withmateApi?.pickDirectory(baseDirectory) ?? Promise.resolve(null),
      applyPickedDirectory: async (selectedPath) => {
        if (composerRegistry.isFrozen || !selectedSession) {
          return;
        }
        const nextSession: Session = buildSessionWithAddedAdditionalDirectory(selectedSession, selectedPath);
        applyPickedAdditionalDirectoryUiStateCommand({
          selectedPath,
          setPickerBaseDirectory,
        });
        await persistSession(nextSession);
      },
    });
  };

  const handleRemoveAdditionalDirectory = async (directoryPath: string) => {
    await runAdditionalDirectoryRemovalOperation({
      directoryPath,
      canRemoveDirectory: () => !!selectedSession &&
        !composerRegistry.isFrozen &&
        !isSelectedSessionReadOnly &&
        selectedSession.provider === "codex" &&
        selectedSessionRunState !== "running",
      removeDirectory: async (targetPath) => {
        if (!selectedSession) {
          return false;
        }
        const nextSession = buildSessionWithRemovedAdditionalDirectory(selectedSession, targetPath);
        if (!nextSession) {
          return false;
        }
        await persistSession(nextSession);
        return true;
      },
    });
  };

  const handleAddAuxiliaryAdditionalDirectory = async () => {
    if (composerRegistry.isFrozen || !withmateApi) return;
    await runAddAuxiliaryAdditionalDirectoryOperationWithApi({
      api: {
        pickDirectory: async (basePath) => {
          const selectedPath = await withmateApi.pickDirectory(basePath);
          return composerRegistry.isFrozen ? null : selectedPath;
        },
      },
      hasParentSession: !!selectedSession,
      activeAuxiliarySession,
      pickerBaseDirectory,
      workspacePath: selectedSession?.workspacePath,
      setPickerBaseDirectory,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleRemoveAuxiliaryAdditionalDirectory = async (directoryPath: string) => {
    if (composerRegistry.isFrozen) return;
    await runRemoveAuxiliaryAdditionalDirectoryOperation({
      directoryPath,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleTitleInputKeyDown = createTitleInputKeyHandler({
    saveTitle: () => void handleSaveTitle(),
    cancelTitleEdit: handleCancelTitleEdit,
  });

  const scrollActivityMonitorToBottom = () => {
    const activityMonitorElement = activityMonitorRef.current;
    if (!activityMonitorElement) {
      return;
    }

    activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
  };

  const handleActivityMonitorScroll = () => {
    const activityMonitorElement = activityMonitorRef.current;
    if (!activityMonitorElement) {
      return;
    }

    const bottomGap = Math.max(
      0,
      activityMonitorElement.scrollHeight - activityMonitorElement.clientHeight - activityMonitorElement.scrollTop,
    );
    const nextFollowing = bottomGap <= 48;

    setIsActivityMonitorFollowing((current) => (current === nextFollowing ? current : nextFollowing));
    if (nextFollowing) {
      setHasActivityMonitorUnread(false);
    }
  };

  const handleOpenSessionTerminal = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    try {
      await withmateApi.openSessionTerminal(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not open the terminal.");
    }
  };

  const handleOpenSessionExplorer = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    showOpenPathFeedback(await resolveOpenPathFeedback(
      () => withmateApi.openPath(selectedSession.workspacePath),
      "Could not open Explorer.",
    ));
  };

  const handleOpenSessionFilesTerminal = createSessionFilesOpenHandler({
    getSessionId: () => selectedSession?.id,
    getOpenSessionFiles: () => (
      withmateApi ? (sessionId) => withmateApi.openSessionFilesTerminal(sessionId) : null
    ),
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "Could not open the Session files terminal.",
  });

  const handleOpenSessionFilesExplorer = createSessionFilesOpenHandler({
    getSessionId: () => selectedSession?.id,
    getOpenSessionFiles: () => (
      withmateApi ? (sessionId) => withmateApi.openSessionFilesDirectory(sessionId) : null
    ),
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "Could not open the Session files directory.",
  });

  const handleJumpToActivityMonitorBottom = () => {
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    scrollActivityMonitorToBottom();
  };

  const pendingRunIndicatorAnnouncement = isApprovalRequestPending || isElicitationRequestPending
    ? "Waiting for approval"
    : hasInProgressLiveRunStep
      ? "Working"
      : hasLiveRunAssistantText
        ? "Generating a response"
        : "Preparing a response";
  const pendingMessageText = "Preparing a response";
  const isSelectedSessionRunning = resolveSelectedSessionIsRunning({
    runState: selectedSessionRunState,
  });
  const renderedIsRunning = activeAuxiliarySession
    ? activeAuxiliarySession.runState === "running"
    : isSelectedSessionRunning;

  const renderedSession = displayedSession;
  const renderedMessages = displayedMessages;
  const handleOpenPromptTemplates = () => {
    if (composerRegistry.isFrozen) return;
    closeFilePreviews();
    if (isPromptTemplateWorkspaceOpen) {
      requestCentralSurfaceClose();
      return;
    }
    if (!prepareCentralSurfaceOpen()) {
      return;
    }
    const textarea = composerTextareaRef.current;
    const fallbackCaret = activeAuxiliarySession ? composerCaret : mainComposerCaretRef.current;
    promptTemplateSelectionRef.current = {
      start: textarea?.selectionStart ?? fallbackCaret,
      end: textarea?.selectionEnd ?? fallbackCaret,
    };
    closeFilePreviews();
    setIsPromptTemplateWorkspaceOpen(true);
  };
  const handleInsertPromptTemplate = (prompt: string) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const insertion = insertComposerTextAtSelection(
      getComposerDraft(),
      prompt,
      promptTemplateSelectionRef.current.start,
      promptTemplateSelectionRef.current.end,
    );
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(insertion.draft, insertion.caret);
    } else {
      applyComposerDraftChangeCommand({
        value: insertion.draft,
        selectionStart: insertion.caret,
        setDraft,
        setComposerCaret,
        syncMainComposerCaret: (caret) => {
          mainComposerCaretRef.current = caret;
        },
        clearFeedback: () => setForceComposerBlockedFeedback(false),
      });
    }
    closeCentralPreview();
    window.requestAnimationFrame(() => {
      if (composerOwnerRef.current === activeRunSessionId) {
        restoreComposerTextareaFocusAndCaret(composerTextareaRef.current, insertion.caret);
      }
    });
  };
  if (!desktopRuntime) {
    return <ChatWindowStatusScreen message="Open the Session Window from Electron." />;
  }

  if (!selectedSession || !renderedSession || !selectedSessionCharacter) {
    return <ChatWindowStatusScreen message="No session is selected. Open a session from the Home Window." />;
  }

  const canInsertFileTreePathReference = activeAuxiliarySession
    ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason
    : !isComposerDisabled;
  const fileExplorerPane = fileRootPreview.renderPane({
    canInsertPathReference: canInsertFileTreePathReference,
    insertReferencePaths,
  });
  const previewChatNotice = liveApprovalRequest
    ? "Approval required"
    : liveElicitationRequest
      ? "Input required"
      : renderedIsRunning
        ? "Running"
        : previewChatActivity.hasUnreadMessages && previewChatActivity.ownerSessionId === activeRunSessionId
          ? "NewMessages"
          : "";
  const actionDockChatNotice = liveApprovalRequest
    ? "Approval required"
    : liveElicitationRequest
      ? "Input required"
      : previewChatActivity.hasUnreadMessages && previewChatActivity.ownerSessionId === activeRunSessionId
        ? "NewMessages"
        : "";
  const filePreviewContent = isPromptTemplateWorkspaceOpen && withmateApi ? (
    <PromptTemplateWorkspace
      api={withmateApi}
      canInsert={!isComposerFrozen && (activeAuxiliarySession
        ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason
        : !isComposerDisabled)}
      onRegisterCloseGuard={registerPromptTemplateCloseGuard}
      onBack={closeCentralPreview}
      onInsert={handleInsertPromptTemplate}
    />
  ) : fileRootPreview.renderPreview({
    onBack: closeCentralPreview,
    onCopyText: handleCopyMessageText,
    onQuoteText: handleQuoteMessageText,
    chatNotice: previewChatNotice,
  });

  const chatHeaderFeature = sessionHeader.buildChatHeader({
    isRunning: isSelectedSessionRunning,
    isReadOnly: isSelectedSessionReadOnly,
    isPinned: selectedSession.isPinned === true,
    isPinPending: isSessionPinPending,
    isAuxiliaryMode,
    isWorkspaceAvailable: isSelectedWorkspaceAvailable,
    onOpenAuditLog: () => setAuditLogsOpen(true),
    onOpenSessionTerminal: () => void handleOpenSessionTerminal(),
    onOpenSessionFilesExplorer: () => void handleOpenSessionFilesExplorer(),
    onOpenSessionFilesTerminal: () => void handleOpenSessionFilesTerminal(),
    onTitleInputKeyDown: handleTitleInputKeyDown,
    onDeleteSession: () => void handleDeleteSession(),
    onToggleSessionPin: () => void handleToggleSessionPin(),
    onOpenSessionExplorer: () => void handleOpenSessionExplorer(),
  });
  const chatComposerFeature = composerFeature.buildSurface({
    session: renderedSession,
    isCharacterAuthoringSession: renderedSession.sessionKind === "character-authoring",
    target: auxiliaryWorkspace.target,
    runtime: {
      isRunning: renderedIsRunning,
      selectedRunState: selectedSessionRunState,
      auxiliaryRunState: activeAuxiliarySession?.runState ?? null,
      busyReason: composerBusyReason,
      blockedReason: sessionExecutionBlockedReason,
      isReadOnly: isSelectedSessionReadOnly,
      forceBlockedFeedback: forceComposerBlockedFeedback,
      isMessageListFollowing,
      isPromptTemplateWorkspaceOpen,
      chatNotice: isCentralPreviewActive ? actionDockChatNotice : "",
      providerCatalog: selectedProviderCatalog,
      models: modelOptions,
      reasoningEfforts: availableReasoningEfforts,
    },
    resources: {
      availableCustomAgents,
      availableSkills,
      isCustomAgentListLoading,
      isSkillListLoading,
      skillListError,
    },
    operations: {
      send: {
        main: handleSend,
        auxiliary: handleSend,
        cancelMain: handleCancelRun,
        cancelAuxiliary: handleCancelAuxiliaryRun,
      },
      runtimeOptions: {
        runMain: async (option) => {
          await runMainRuntimeOption(option);
        },
        auxiliary: {
          session: activeAuxiliarySession,
          update: updateActiveAuxiliarySession,
          catalogRevision: modelCatalog?.revision ?? null,
          timestamp: currentTimestampLabel,
        },
      },
      customAgent: {
        main: handleSelectCustomAgent,
        auxiliary: handleSelectAuxiliaryCustomAgent,
      },
      skill: {
        main: handleSelectSkill,
        auxiliary: handleSelectAuxiliarySkill,
      },
      draft: {
        main: (value, selectionStart) => {
          applyComposerDraftChangeCommand({
            value,
            selectionStart,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (caret) => {
              mainComposerCaretRef.current = caret;
            },
            clearFeedback: () => setForceComposerBlockedFeedback(false),
          });
        },
        auxiliary: handleAuxiliaryDraftChange,
        paste: (event) => void handleComposerPaste(event),
        focus: () => handleExpandActionDock({ focusComposer: false }),
      },
      files: {
        pick: pickAndInsertPath,
        addToSessionFiles: handleAddToSessionFiles,
        pickSessionFiles: handlePickSessionFiles,
        pickSessionFolder: handlePickSessionFolder,
        pickSessionImage: handlePickSessionImage,
      },
      layout: {
        beforeOpenSkillPicker: requestCentralSurfaceClose,
        openPromptTemplates: handleOpenPromptTemplates,
        addAdditionalDirectory: {
          main: handleAddAdditionalDirectory,
          auxiliary: handleAddAuxiliaryAdditionalDirectory,
        },
        removeAdditionalDirectory: {
          main: handleRemoveAdditionalDirectory,
          auxiliary: handleRemoveAuxiliaryAdditionalDirectory,
        },
        expandActionDock: handleToggleActionDock,
        jumpToBottom: followMessageListLatest,
      },
      retryComposerSave: handleRetryAuxiliaryDraftSave,
    },
  });
  const chatConversationFeature = conversationFeature.buildSurface({
    sessionId: renderedSession.id,
    character: selectedSessionCharacter,
    messages: renderedMessages,
    mainContent: filePreviewContent,
    messageKeys: undefined,
    messageGroups: undefined,
    messageCollapseTargets: undefined,
    collapsedMessageKeys: undefined,
    messageJumpRequest: null,
    isRunning: renderedIsRunning,
    pendingRunIndicatorAnnouncement,
    liveApprovalRequest,
    approvalActionRequestId,
    liveElicitationRequest,
    elicitationActionRequestId,
    liveRunAssistantText,
    hasLiveRunAssistantText,
    liveRunErrorMessage: selectedSessionLiveRun?.errorMessage ?? "",
    pendingMessageText,
    pendingMessageTextVisible: false,
    pendingMessageGroupId: resolvePendingAuxiliaryMessageGroupId(activeAuxiliarySession),
    isMessageListFollowing,
    messageListRef,
    onMessageListScroll: handleMessageListScroll,
    onToggleMessageBookmark: handleToggleMessageBookmark,
    onLoadArtifactDetail: (messageIndex) =>
      Promise.resolve(withmateApi?.getSessionMessageArtifact(selectedSession.id, messageIndex) ?? null),
    onOpenDiff: (title, file) =>
      setSelectedDiff({
        title,
        file,
        themeColors: selectedSession.characterThemeColors,
      }),
    onResolveLiveApproval: (request, decision) => void resolveLiveApproval(request, decision),
    onResolveLiveElicitation: (request, response) => void resolveLiveElicitation(request, response),
    onOpenPath: handleOpenInlinePath,
    onCopyMessageText: handleCopyMessageText,
    onQuoteMessageText: handleQuoteMessageText,
    glossaryAnnotationMatcher,
    onActivateGlossaryEntry: handleActivateGlossaryEntry,
  });
  const chatRuntimeFeature = buildSessionChatRuntimeFeature({
    recovery: {
      retryBanner: activeAuxiliarySession ? null : retryBanner,
      isRetryActionDisabled,
      isRetryEditDisabled,
      isRetryDraftReplacePending,
      onResendLastMessage: () => void handleResendLastMessage(),
      onEditLastMessage: handleEditLastMessage,
      onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
      onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
    },
    composerFeedback: chatComposerFeature.composer.composerSendability,
    workspaceAvailabilityMessage,
    isWorkspaceAvailabilityCheckPending,
    onRecheckWorkspaceAvailability: () => {
      setWorkspaceAvailabilityCheckRevision((current) => current + 1);
    },
    inlinePathFeedback: inlinePathError?.ownerSessionId === renderedSession.id
      ? inlinePathError.message
      : "",
    onDismissInlinePathFeedback: () => {
      inlinePathOperationRevisionRef.current.advance();
      setInlinePathError((current) => current?.ownerSessionId === renderedSession.id ? null : current);
    },
    contextPane: contextPaneProps,
  });
  const sessionModals = (
    <ChatSessionModals
      selectedDiff={selectedDiff}
      selectedDiffThemeStyle={selectedDiffThemeStyle}
      auditLogProps={auditLogModalProps}
      onCloseDiff={() => setSelectedDiff(null)}
      onOpenDiffWindow={(payload) => void handleOpenDiffWindow(payload)}
    />
  );
  const chatShellSurface = chatShellFeature.buildSurface({
    mainContent: filePreviewContent,
    leftPane: fileExplorerPane,
    themeStyle: sessionThemeStyle,
    modals: sessionModals,
    isAuxiliaryMode,
  });
  const chatWindowProps = composeAgentSessionChatWindow({
    shell: chatShellSurface,
    header: chatHeaderFeature,
    composer: chatComposerFeature,
    conversation: chatConversationFeature,
    runtime: chatRuntimeFeature,
  });
  const concurrentChats = auxiliaryWorkspace.buildConcurrentChats({
    mainSession: selectedSession,
    auxiliarySession: auxiliaryWorkspace.selectedSession ? selectedAuxiliaryRuntimeSession : null,
    api: withmateApi ?? undefined,
    mainLiveRun: auxiliaryWorkspace.target === "auxiliary" ? undefined : selectedSessionLiveRun,
    auxiliaryLiveRun: auxiliaryWorkspace.target === "auxiliary" ? selectedSessionLiveRun : undefined,
    messageColumn: chatWindowProps.messageColumnProps,
    mainOnToggleMessageBookmark: auxiliaryWorkspace.target === "main"
      && !isSelectedSessionReadOnly
      && !isSelectedSessionRunning
      ? handleToggleMessageBookmark
      : undefined,
    mainOnLoadArtifactDetail: (index) => withmateApi?.getSessionMessageArtifact(selectedSession.id, index) ?? Promise.resolve(null),
    mainOnOpenPath: (target) => handleOpenInlinePath(target, selectedSession.id),
    auxiliaryOnToggleMessageBookmark: auxiliaryWorkspace.target === "auxiliary"
      && !isSelectedSessionReadOnly
      && auxiliaryWorkspace.selectedSession?.runState !== "running"
      ? handleToggleMessageBookmark
      : undefined,
    auxiliaryOnLoadArtifactDetail: (index) => Promise.resolve(auxiliaryWorkspace.selectedSession?.messages[index]?.artifact ?? null),
    auxiliaryOnOpenPath: (target) => handleOpenInlinePath(target, auxiliaryWorkspace.selectedId),
    onAddAuxiliary: handleOpenAuxiliaryLaunchDialog,
    isAddAuxiliaryDisabled: isSelectedSessionReadOnly || !isSelectedWorkspaceAvailable,
    scrollToLatestOnSend: appSettings.scrollToLatestOnSend,
  });

  return (
    <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
      <>
      <ChatWindow
        {...chatWindowProps}
        rightPane={isAuxiliaryTargetUnavailable
          ? <div className="concurrent-chat-state" role="status">{sessionExecutionBlockedReason}</div>
          : chatWindowProps.rightPane}
        headerProps={{
          ...chatWindowProps.headerProps,
          taskTitle: selectedSession.taskTitle,
          isRunning: isSelectedSessionRunning,
          isReadOnly: isSelectedSessionReadOnly,
          showRenameButton: true,
          showDeleteButton: true,
        }}
        concurrentChats={concurrentChats}
      />
      <AuxiliaryLaunchProviderDialog
        open={auxiliaryLaunchDialogOpen}
        providers={auxiliaryLaunchProviderItems}
        selectedProviderId={auxiliaryLaunchProviderId}
        providerLoadStatus={auxiliaryProviderLoadStatus}
        providerLoadError={auxiliaryProviderLoadError}
        feedback={auxiliaryLaunchFeedback}
        starting={auxiliaryCreationStarting}
        creationInFlight={auxiliaryCreation.inFlight}
        cancelling={auxiliaryCreationCancelling}
        canCancelCreation={canCancelAuxiliaryLaunchCreation(auxiliaryCreationStatus)}
        onClose={handleCloseAuxiliaryLaunchDialog}
        onCancelCreation={() => void handleCancelAuxiliaryCreation()}
        onSelectProvider={handleSelectAuxiliaryLaunchProvider}
        onStart={() => void handleStartAuxiliarySession()}
      />
      </>
    </ShortcutSettingsProvider>
  );
}
