import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { ButtonContent } from "../ui/button-content.js";

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
  RunSessionTurnRequest,
} from "../../src-shared/session/runtime-state.js";
import {
  getAuxiliarySessionIdFromLocation,
  getSessionIdFromLocation,
} from "./session-location.js";
import {
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
  getSessionIncarnationId,
  type Session,
} from "../../src-shared/session/session-state.js";
import { createMessageBookmarkHandler } from "../chat/conversation/session-message-bookmark-operation.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import {
  isSameModelCatalogWorkspace,
  startModelCatalogSubscription,
} from "../settings/model-catalog-subscription.js";
import type { ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import {
  buildSessionStopTarget,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
} from "../chat/send-or-cancel.js";
import { approvalModeLabel } from "../ui/ui-utils.js";
import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../chat/composer/composer-textarea-focus.js";
import { useMainAuxiliaryRuntimeSession } from "../chat/auxiliary/auxiliary-render-projections.js";
import {
  ChatWindow,
  ChatWindowStatusScreen,
  type ChatErrorNotice,
} from "../chat/chat-window.js";
import { FailedTurnRetryContext } from "../chat/runtime/failed-turn-retry-context.js";
import {
  resolveConversationAttentionEntries,
  type ConversationAttention,
} from "../chat/conversation-attention.js";
import { readReplyQuote } from "../chat/conversation/reply-quote.js";
import type { SessionReply } from "../../src-shared/session/session-reply.js";
import {
  conversationPeerKey,
  savedReplyConversationFrame,
} from "../../src-shared/session/conversation-threads.js";
import {
  ALL_MAIN_THREADS_ID,
  type MainConversationView,
} from "../chat/conversation/use-main-conversation-threads.js";
import { ChatSessionModals } from "../chat/chat-session-modals.js";
import { usePastedFileReplacement } from "../chat/use-pasted-file-replacement.js";
import { useResourceDiscovery } from "../chat/use-resource-discovery.js";
import {
  applySessionDocumentTitle,
  resolveAgentSessionDocumentTitle,
} from "../chat/window-title.js";
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
import { SessionInstructionsControl } from "../chat/composer/session-instructions-control.js";
import type { SessionInstructionsTarget } from "../../src-shared/session/session-instructions.js";
import { useAuxiliaryCreation } from "../chat/use-auxiliary-creation.js";
import { useAuxiliaryLaunchDialogState } from "../chat/use-auxiliary-launch-dialog-state.js";
import { useAuxiliaryWorkspace } from "../chat/use-auxiliary-workspace.js";
import {
  ComposerControllerRegistry,
  type ComposerOwner,
} from "../chat/composer-controller.js";
import { useAuxiliaryDraftPersistence } from "../chat/auxiliary/use-auxiliary-draft-persistence.js";
import { AuxiliaryExecutionOptionsOwner } from "../chat/auxiliary/auxiliary-runtime-option-operation.js";
import { useSessionTurnInput } from "../chat/runtime/use-session-turn-input.js";
import { useSessionComposerFeature } from "../chat/composer/use-session-composer-feature.js";
import {
  runMainRuntimeOptionOperation,
  type MainRuntimeOption,
} from "../chat/runtime/main-session-mutation-operations.js";
import { useMainSessionRuntime } from "../chat/runtime/use-main-session-runtime.js";
import { useSessionSummaryRead } from "../chat/runtime/use-session-summary-read.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { useSessionHeaderOperations } from "../chat/shell/use-session-header-operations.js";
import { updateMainSessionTitle } from "../chat/runtime/main-session-mutation-operations.js";
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
  selectAdditionalDirectoryPath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "../chat/composer/session-composer-paths.js";
import { applyComposerDraftChangeCommand } from "../chat/composer-draft-handlers.js";
import {
  useChatLayoutPresentation,
  useSessionSidePanes,
} from "../chat/shell/session-chat-layout-hooks.js";
import { persistChatLayoutPreference } from "../chat/chat-layout-preference.js";
import type { SessionSidePane } from "../../src-shared/settings/session-side-pane.js";
import { PromptTemplateWorkspace } from "../prompt-templates/PromptTemplateWorkspace.js";
import { insertComposerTextAtSelection } from "../chat/message-text-actions.js";
import type { GlossaryAnnotationMatcher } from "../glossary/glossary-annotation-projection.js";
import {
  SessionFilesFeature,
  type SessionFilesFeatureHandle,
} from "../file-explorer/session-files-feature.js";
import {
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "../file-explorer/preview-chat-activity.js";
import { resolveSessionRunErrorMessage } from "../chat/runtime/session-live-run-state.js";
import {
  StateMutationRevision,
  createSessionTurnClientRequestId,
} from "../chat/runtime/session-submit-coordinator.js";
import { useSessionChatConversationFeature } from "../chat/conversation/session-chat-conversation-feature.js";
import { buildSessionChatRuntimeFeature } from "../chat/runtime/session-chat-runtime-feature.js";
import {
  SessionContextFeature,
  type SessionContextFeatureHandle,
} from "../chat/runtime/session-context-feature.js";
import { ProviderQuota } from "../provider-usage/provider-quota.js";
import { composeAgentSessionChatWindow } from "../chat/session-chat-window-composition.js";
import { useSessionChatShellFeature } from "../chat/shell/session-chat-shell-feature.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import {
  SessionTerminal,
  type SessionTerminalHandle,
} from "../terminal/session-terminal.js";
import { ShortcutSettingsProvider } from "../settings/shortcut-settings-context.js";
import {
  QueuedTurnEditContext,
  isQueuedTurnEditBusy,
  queuedTurnEditOwner,
  useQueuedTurnEdit,
} from "../chat/conversation/use-queued-turn-edit.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { PreviewWheelZoomStepContext } from "../settings/preview-zoom-settings-context.js";
import {
  resolveOpenPathFeedback,
  showOpenPathFeedback,
} from "../file-explorer/open-path-result.js";
import {
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceExecutionGate,
  resolveSessionWorkspaceUnavailableMessage,
} from "../chat/runtime/session-workspace-availability.js";
import { useSessionWorkspaceAvailability } from "../chat/runtime/session-window-workspace-hooks.js";
import { useSessionRunControls } from "../chat/runtime/session-window-live-run-hooks.js";
import { useSessionRunActions } from "../chat/runtime/session-run-actions.js";
import { useLatestSessionTurn } from "../chat/runtime/use-latest-session-turn.js";
import { type AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createPastedSessionAttachmentHandler } from "../chat/composer-paste-handlers.js";
import { createCopyMessageTextHandler } from "../chat/message-text-actions.js";
import {
  applyRetryDraftRestoreCommand,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetrySource,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryActions,
} from "../chat/retry-state.js";
import {
  loadOwnedAuxiliaryMessageArtifact,
  resolvePendingAuxiliaryMessageGroupId,
} from "../chat/auxiliary/auxiliary-session-message-projection.js";
import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveWithQueue,
} from "../chat/auxiliary/auxiliary-session-update-operation.js";
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

/** ターン実行が止まったように見える際の調査用に、イベントと観測値を共通の接頭辞で記録する。 */
function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

/** ファイル変更の一行を表示するための操作名、色分けの種別、対象パス。 */
type ParsedFileChangeSummaryLine = {
  actionLabel: string;
  toneClassName: "add" | "edit" | "delete" | "rename";
  path: string;
};

const FILE_CHANGE_SUMMARY_ACTION_META: Record<
  string,
  Pick<ParsedFileChangeSummaryLine, "actionLabel" | "toneClassName">
> = {
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

/** 複数行すべてが既知の「操作: パス」なら表示用に変換し、一行以下や解釈できない行があれば通常の本文表示に戻す。 */
function parseFileChangeSummary(
  summary: string,
): ParsedFileChangeSummaryLine[] | null {
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

/** メッセージ本文や成果物の表示に関係する項目を、スクロールの変化検出用の文字列にまとめる。 */
function buildDisplayedMessagesScrollSignature(messages: Message[]): string {
  return messages
    .map((message) => {
      const artifact = message.artifact
        ? [
            message.artifact.title,
            message.artifact.activitySummary.join("\u001f"),
            message.artifact.runChecks
              .map((check) => `${check.label}=${check.value}`)
              .join("\u001f"),
            message.artifact.changedFiles
              .map(
                (file) =>
                  `${file.kind}:${file.path}:${file.summary}:${file.diffRows.length}`,
              )
              .join("\u001f"),
            message.artifact.operationTimeline
              ? message.artifact.operationTimeline
                  .map(
                    (operation) =>
                      `${operation.type}:${operation.summary}:${operation.details?.length ?? 0}`,
                  )
                  .join("\u001f")
              : "",
          ].join("\u001e")
        : "";

      return [
        message.role,
        message.accent ? "1" : "0",
        message.text,
        artifact,
      ].join("\u001d");
    })
    .join("\u001c");
}

/** 保存された承認モードの値を、セッション画面に出す共通ラベルに変換する。 */
function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

/** URLで指定されたMainセッションを開き、MainとAuxiliaryの会話・入力・実行操作をそれぞれの対象に接続する。 */
export default function AgentSessionWindowApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const [actionDockMode, setActionDockMode] = useState<"prompt" | "terminal">(
    "prompt",
  );
  const terminalRef = useRef<SessionTerminalHandle>(null);
  const composerRegistryRef = useRef<ComposerControllerRegistry | null>(null);
  if (!composerRegistryRef.current) {
    composerRegistryRef.current = new ComposerControllerRegistry();
  }
  const composerRegistry = composerRegistryRef.current;
  const queueEditor = useQueuedTurnEdit(withmateApi, composerRegistry);
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);
  const sessionSummaryRead = useSessionSummaryRead(withmateApi, selectedId);
  const [executionOptionsFeedback, setExecutionOptionsFeedback] = useState<{
    ownerId: string;
    message: string;
  } | null>(null);
  const [failedRetryFeedback, setFailedRetryFeedback] = useState<{
    ownerId: string;
    incarnationId: string;
    lastUserSeq: number | null;
    message: string;
  } | null>(null);
  const mainSessionRuntime = useMainSessionRuntime({
    api: withmateApi,
    selectedId,
    composerRegistry,
    /** 実行設定の保存失敗を、失敗した入力欄の所有者と一緒に保持する。 */
    onExecutionOptionsError: (ownerId, message) =>
      setExecutionOptionsFeedback({ ownerId, message }),
  });
  const {
    sessions,
    hasPendingSubmitFor,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn: runMainSessionTurnFromRuntime,
    getCurrentSession: getCurrentMainSession,
    selectExecutionOptions: selectMainExecutionOptions,
    updateSessionProjection,
  } = mainSessionRuntime;
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(
    null,
  );
  const [modelCatalogLoadStatus, setModelCatalogLoadStatus] =
    useState<ProviderLaunchLoadStatus>("loading");
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState("");
  const [modelCatalogReadRevision, setModelCatalogReadRevision] = useState(0);
  const modelCatalogRequestRevisionRef = useRef(0);
  const conversationFeature = useSessionChatConversationFeature();
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(
    null,
  );
  const [isPromptTemplateWorkspaceOpen, setIsPromptTemplateWorkspaceOpen] =
    useState(false);
  const promptTemplateCloseGuardRef = useRef<(() => boolean) | null>(null);
  const registerPromptTemplateCloseGuard = useCallback(
    (guard: (() => boolean) | null) => {
      promptTemplateCloseGuardRef.current = guard;
    },
    [],
  );
  const [previewChatActivity, setPreviewChatActivity] = useState(() =>
    endPreviewChatActivity(),
  );
  const [inlinePathError, setInlinePathError] = useState<{
    ownerSessionId: string;
    target: string;
    message: string;
  } | null>(null);
  const inlinePathOperationRevisionRef = useRef(new StateMutationRevision());
  const [appSettings, setAppSettings] = useState<AppSettings>(
    createDefaultAppSettings(),
  );
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [appSettingsLoadStatus, setAppSettingsLoadStatus] =
    useState<ProviderLaunchLoadStatus>("loading");
  const [appSettingsLoadError, setAppSettingsLoadError] = useState("");
  const [appSettingsReadRevision, setAppSettingsReadRevision] = useState(0);
  const [retryDraftReplaceRequestKey, setRetryDraftReplaceRequestKey] =
    useState<string | null>(null);
  const handleHeaderPreferenceChange = useCallback(
    (value: "hidden" | "visible") => {
      void persistChatLayoutPreference(withmateApi, {
        target: "header",
        value,
      });
    },
    [withmateApi],
  );
  const handleActionDockPreferenceChange = useCallback(
    (value: "compact" | "expanded") => {
      void persistChatLayoutPreference(withmateApi, {
        target: "actionDock",
        value,
      });
    },
    [withmateApi],
  );
  const layoutPresentation = useChatLayoutPresentation({
    initialHeader: isAppSettingsLoaded
      ? appSettings.chatLayoutPreference.header
      : null,
    initialActionDock: isAppSettingsLoaded
      ? appSettings.chatLayoutPreference.actionDock
      : null,
    onHeaderChange: handleHeaderPreferenceChange,
    onActionDockChange: handleActionDockPreferenceChange,
  });
  const { setIsActionDockPinnedExpanded } = layoutPresentation;
  const initialAuxiliarySessionId = useMemo(
    () => getAuxiliarySessionIdFromLocation(),
    [],
  );
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
  const activeAuxiliarySession =
    auxiliaryWorkspace.target === "auxiliary"
      ? auxiliaryWorkspace.selectedSession
      : null;
  const auxiliaryBinding = auxiliaryWorkspace.getBinding(
    auxiliaryWorkspace.selectedId,
  );
  const setActiveAuxiliarySession = auxiliaryBinding.setSession;
  const auxiliaryDraftPersistence = useAuxiliaryDraftPersistence({
    api: withmateApi,
    composerRegistry,
    touchRecency: auxiliaryWorkspace.touchRecency,
    /** 保存処理から、その時点の入力欄レジストリの凍結状態を参照する。 */
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
    /** 作成が確定したAuxiliaryをワークスペースに追加し、入力欄を展開して作成ダイアログを閉じる。 */
    onCommitted: (session) => {
      auxiliaryWorkspace.addSession(session);
      setIsActionDockPinnedExpanded(true);
      setForceComposerBlockedFeedback(false);
      closeAuxiliaryLaunchDialog();
    },
    /** Auxiliaryの作成失敗をダイアログに表示し、メッセージがなければ以前の通知を消す。 */
    onFeedback: (message) => {
      if (message) setAuxiliaryLaunchStartError(new Error(message));
      else resetAuxiliaryLaunchFeedback();
    },
    /** 作成リクエストのIDと投影の段階を記録し、古い結果の破棄だけを警告として扱う。 */
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
  const {
    starting: auxiliaryCreationStarting,
    cancelling: auxiliaryCreationCancelling,
    status: auxiliaryCreationStatus,
  } = auxiliaryCreation;
  const activeAuxiliarySessionRef = auxiliaryBinding.sessionRef;
  const auxiliaryExecutionOptionsOwner = useMemo(
    () => new AuxiliaryExecutionOptionsOwner(),
    [],
  );
  const auxiliarySessionMutationRevisionRef = auxiliaryBinding.mutationRevision;
  const auxiliaryDraftSaveQueueRef = auxiliaryBinding.draftSaveQueue;
  const auxiliarySessionSaveQueueRef = auxiliaryBinding.sessionSaveQueue;
  const loadedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );
  // 会話の読み取りが成功するまでは、この投影を表示にのみ使う。
  const selectedSession = useMemo<Session | null>(() => {
    if (loadedSession) return loadedSession;
    if (
      mainSessionRuntime.readStatus === "ready" ||
      !sessionSummaryRead.summary
    )
      return null;
    return {
      ...sessionSummaryRead.summary,
      characterRuntimeSnapshot: null,
      messages: [],
      stream: [],
    };
  }, [
    loadedSession,
    mainSessionRuntime.readStatus,
    sessionSummaryRead.summary,
  ]);
  const {
    workspaceAvailability,
    workspaceAvailabilityCheckRevision,
    setWorkspaceAvailabilityCheckRevision,
    validateSessionWorkspace,
  } = useSessionWorkspaceAvailability(withmateApi, selectedSession);
  const displayedSession = useMainAuxiliaryRuntimeSession(
    selectedSession,
    activeAuxiliarySession,
  );
  const selectedAuxiliaryRuntimeSession = useMainAuxiliaryRuntimeSession(
    selectedSession,
    auxiliaryWorkspace.selectedSession,
  );
  const isAuxiliaryMode = activeAuxiliarySession !== null;
  const selectedSessionId = selectedSession?.id ?? null;
  const handleSidePaneChange = useCallback(
    (sidePane: SessionSidePane) => {
      void persistChatLayoutPreference(withmateApi, {
        target: "sidePane",
        value: sidePane,
      });
    },
    [withmateApi],
  );
  const sidePanes = useSessionSidePanes({
    ownerKey: selectedSessionId,
    initialSidePane: isAppSettingsLoaded
      ? appSettings.chatLayoutPreference.sidePane
      : null,
    onSidePaneChange: handleSidePaneChange,
  });
  const { handleShowContextRail } = sidePanes;
  const activeRunSessionId =
    auxiliaryWorkspace.target === "auxiliary"
      ? auxiliaryWorkspace.selectedId
      : selectedSessionId;
  const {
    getLiveRunRevision,
    hasSelectedSessionLiveRun,
    selectedSessionCancellationState,
    cancellationState: activeCancellationState,
    stopTurnId,
    stopReceiptId,
    stopIncarnationId,
    mainStopTurnId,
    mainStopReceiptId,
    mainStopIncarnationId,
    hasLiveRun,
    hasAssistantText: hasLiveRunAssistantText,
    hasApprovalRequest: isApprovalRequestPending,
    hasElicitationRequest: isElicitationRequestPending,
    hasBlockingElicitationRequest: isBlockingElicitationRequestPending,
    approvalRequestId,
    blockingElicitationRequestIds,
    optionalElicitationRequestIds,
    hasInProgressStep: hasInProgressLiveRunStep,
    errorMessage: liveRunErrorMessage,
    inputTurnId,
    setLiveRunState,
  } = useSessionRunControls(withmateApi, selectedSession, activeRunSessionId);
  const [stopClaims, setStopClaims] = useState<
    Partial<
      Record<
        "main" | "auxiliary",
        { sessionId: string; incarnationId: string; receiptId: string }
      >
    >
  >({});
  const observeTurnReceipts = useCallback(
    (
      receipts: readonly SessionTurnQueueReceipt[],
      owner: {
        sessionId: string;
        incarnationId: string;
        kind: "main" | "auxiliary";
      },
    ) => {
      mainSessionRuntime.observeTurnReceipts(receipts);
      const receipt = receipts.find(
        (item) =>
          item.sessionId === owner.sessionId &&
          item.incarnationId === owner.incarnationId &&
          !item.inputTurnId &&
          (item.state === "starting" || item.state === "running"),
      );
      setStopClaims((current) => {
        const previous = current[owner.kind];
        if (
          !receipt
            ? !previous
            : previous?.receiptId === receipt.id &&
              previous.incarnationId === owner.incarnationId &&
              previous.sessionId === owner.sessionId
        )
          return current;
        return {
          ...current,
          [owner.kind]: receipt
            ? {
                sessionId: owner.sessionId,
                incarnationId: owner.incarnationId,
                receiptId: receipt.id,
              }
            : undefined,
        };
      });
    },
    [mainSessionRuntime.observeTurnReceipts],
  );
  const stopMainIncarnation = selectedSession
    ? getSessionIncarnationId(selectedSession)
    : "";
  const stopAuxiliaryId = activeAuxiliarySession?.id;
  const stopAuxiliaryIncarnation = activeAuxiliarySession?.createdAt;
  const mainStopTarget = useMemo(
    () =>
      buildSessionStopTarget(
        selectedSessionId
          ? { sessionId: selectedSessionId, incarnationId: stopMainIncarnation }
          : null,
        {
          turnId: mainStopTurnId,
          receiptId: mainStopReceiptId,
          incarnationId: mainStopIncarnationId,
        },
        stopClaims.main,
      ),
    [
      selectedSessionId,
      stopMainIncarnation,
      mainStopTurnId,
      mainStopReceiptId,
      mainStopIncarnationId,
      stopClaims.main,
    ],
  );
  const auxiliaryStopTarget = useMemo(
    () =>
      buildSessionStopTarget(
        stopAuxiliaryId && stopAuxiliaryIncarnation
          ? {
              sessionId: stopAuxiliaryId,
              incarnationId: stopAuxiliaryIncarnation,
            }
          : null,
        {
          turnId: stopTurnId,
          receiptId: stopReceiptId,
          incarnationId: stopIncarnationId,
        },
        stopClaims.auxiliary,
      ),
    [
      stopAuxiliaryId,
      stopAuxiliaryIncarnation,
      stopTurnId,
      stopReceiptId,
      stopIncarnationId,
      stopClaims.auxiliary,
    ],
  );
  const {
    approvalActionRequestId,
    elicitationActionRequestId,
    resolveLiveApproval,
    resolveLiveElicitation,
    cancelRun,
    pendingCancelSessionIds,
  } = useSessionRunActions({
    api: withmateApi,
    activeRunSessionId,
    stopTargets: [mainStopTarget, auxiliaryStopTarget],
    setLiveRunState,
    /** 承認・入力要求・停止の操作で返ったエラーをダイアログに出す。 */
    onError: (message) => window.alert(message),
  });
  const isActiveCancelRequested = pendingCancelSessionIds.has(
    activeRunSessionId ?? "",
  );
  const mainViewRef = useRef<MainConversationView>(null);
  const [mainViewSelection, setMainViewSelection] = useState<{
    ownerKey: string;
    id: string;
    missingEditFrameId?: string;
  }>();
  const onMainConversationView = useCallback(
    (view: MainConversationView) => {
      mainViewRef.current = view;
      const ownerKey = conversationPeerKey(view.main);
      const edit = queueEditor.edits[view.main.sessionId];
      const editingFrame =
        edit?.receipt.incarnationId === view.main.incarnationId
          ? edit.mainFrameId
          : undefined;
      setMainViewSelection((previous) => {
        // 編集中の相手がいなくなったと判断できるのは、スレッドの投影を正常に取得できたときだけ。
        const missingEditFrameId =
          editingFrame &&
          editingFrame !== ALL_MAIN_THREADS_ID &&
          (view.projection
            ? !view.projection.children.some(
                ({ target }) => conversationPeerKey(target) === editingFrame,
              )
            : previous?.ownerKey === ownerKey &&
              previous.missingEditFrameId === editingFrame)
            ? editingFrame
            : undefined;
        return previous?.ownerKey === ownerKey &&
          previous.id === view.id &&
          previous.missingEditFrameId === missingEditFrameId
          ? previous
          : { ownerKey, id: view.id, missingEditFrameId };
      });
    },
    [queueEditor.edits],
  );
  const mainIncarnation = selectedSession
    ? getSessionIncarnationId(selectedSession)
    : "";
  const mainView =
    selectedSession &&
    mainViewSelection?.ownerKey ===
      conversationPeerKey({
        kind: "main",
        sessionId: selectedSession.id,
        incarnationId: mainIncarnation,
      })
      ? mainViewSelection
      : undefined;
  const mainFrameId = mainView?.id ?? "";
  const composerFrameKey =
    auxiliaryWorkspace.target === "main" && mainFrameId
      ? JSON.stringify([mainIncarnation, mainFrameId])
      : undefined;
  const normalComposerOwner = useMemo<ComposerOwner>(
    () => ({
      kind: auxiliaryWorkspace.target === "auxiliary" ? "auxiliary" : "main",
      id: activeRunSessionId ?? "__none__",
      frameKey: composerFrameKey,
    }),
    [activeRunSessionId, auxiliaryWorkspace.target, composerFrameKey],
  );
  const queuedEditForTarget = queueEditor.edits[activeRunSessionId ?? ""];
  const editFrame = queuedEditForTarget?.mainFrameId;
  const activeQueuedTurnEdit =
    queuedEditForTarget &&
    (auxiliaryWorkspace.target === "auxiliary" ||
      (queuedEditForTarget.receipt.incarnationId === mainIncarnation &&
        editFrame !== undefined &&
        (editFrame === mainFrameId ||
          (mainFrameId === ALL_MAIN_THREADS_ID &&
            mainView?.missingEditFrameId === editFrame))))
      ? queuedEditForTarget
      : undefined;
  const composerOwner = useMemo<ComposerOwner>(
    () =>
      activeQueuedTurnEdit
        ? queuedTurnEditOwner(normalComposerOwner.id)
        : normalComposerOwner,
    [normalComposerOwner, !!activeQueuedTurnEdit],
  );
  const currentComposerOwner = useRef(composerOwner);
  currentComposerOwner.current = composerOwner;
  const subscribeMainReply = useCallback(
    (listener: () => void) =>
      composerRegistry.subscribe(normalComposerOwner, listener),
    [composerRegistry, normalComposerOwner],
  );
  const readMainReply = useCallback(
    () =>
      normalComposerOwner.kind === "main"
        ? composerRegistry.get(normalComposerOwner).reply
        : undefined,
    [composerRegistry, normalComposerOwner],
  );
  const mainReply = useSyncExternalStore(
    subscribeMainReply,
    readMainReply,
    readMainReply,
  );
  const composerDraft =
    activeQueuedTurnEdit?.receipt.captured.request.userMessage ??
    (auxiliaryWorkspace.target === "auxiliary"
      ? (activeAuxiliarySession?.composerDraft ?? "")
      : "");
  const isAuxiliaryTargetUnavailable =
    auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession;
  const composerFeature = useSessionComposerFeature({
    api: withmateApi,
    composerRegistry,
    composerOwner,
    composerDraft,
    canChangeDraft:
      composerOwner.kind === "queue-edit"
        ? () => queueEditor.canChangeDraft(composerOwner.id)
        : undefined,
    activeRunSessionId,
    selectedSessionId,
    sessionProvider: selectedSession?.provider ?? null,
    sessionWorkspacePath: selectedSession?.workspacePath,
    visibleRunState:
      activeAuxiliarySession?.runState ??
      resolveSelectedSessionRunState({
        runState: selectedSession?.runState,
        hasLiveRun: hasSelectedSessionLiveRun,
        isCancellationPending:
          !!selectedSessionCancellationState ||
          pendingCancelSessionIds.has(selectedSession?.id ?? ""),
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
  useEffect(() => {
    if (
      activeQueuedTurnEdit?.phase === "editing" &&
      actionDockMode === "prompt"
    )
      composerTextareaRef.current?.focus();
  }, [activeQueuedTurnEdit?.phase, activeRunSessionId]);
  const activeRunMessageCount = activeAuxiliarySession
    ? (activeAuxiliarySession.messageCount ??
      activeAuxiliarySession.messages.length)
    : (selectedSession?.messageCount ?? selectedSession?.messages.length ?? 0);
  const prepareCentralSurfaceOpenRef = useRef<() => boolean>(() => false);
  const filesFeatureRef = useRef<SessionFilesFeatureHandle>(null);
  const [filesPaneHost, setFilesPaneHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [filesPreviewHost, setFilesPreviewHost] =
    useState<HTMLDivElement | null>(null);
  const [isFilePreviewActive, setIsFilePreviewActive] = useState(false);
  const [localPrOpening, setLocalPrOpening] = useState(false);
  const [localPrError, setLocalPrError] = useState("");
  const closeFilePreviews = useCallback(
    () => filesFeatureRef.current?.closePreviews(),
    [],
  );
  const isConversationHidden =
    isFilePreviewActive || isPromptTemplateWorkspaceOpen;
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
    const shouldBeginPreviewActivity =
      !isConversationHidden && activeRunSessionId !== null;
    const canOpen = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen,
      canClosePromptTemplate,
      /** 別の中央表示へ進める場合に、テンプレート編集画面とスキル選択を閉じる。 */
      closeCentralSurface: () => {
        setIsPromptTemplateWorkspaceOpen(false);
        closeSkillPicker();
      },
    });
    if (!canOpen) {
      return false;
    }
    if (shouldBeginPreviewActivity) {
      setPreviewChatActivity(
        beginPreviewChatActivity(activeRunSessionId, activeRunMessageCount),
      );
    }
    return true;
  }, [
    activeRunMessageCount,
    activeRunSessionId,
    canClosePromptTemplate,
    closeSkillPicker,
    isConversationHidden,
    isPromptTemplateWorkspaceOpen,
  ]);
  prepareCentralSurfaceOpenRef.current = prepareCentralSurfaceOpen;
  const requestCentralSurfaceClose = useCallback(
    () =>
      applyCentralSurfaceOpenCommand({
        isPromptTemplateWorkspaceOpen,
        canClosePromptTemplate,
        closeCentralSurface: closeCentralPreview,
      }),
    [
      canClosePromptTemplate,
      closeCentralPreview,
      isPromptTemplateWorkspaceOpen,
    ],
  );
  useEffect(() => {
    if (!isConversationHidden || !activeRunSessionId) {
      setPreviewChatActivity((current) =>
        current.ownerSessionId === null ? current : endPreviewChatActivity(),
      );
      return;
    }

    setPreviewChatActivity((current) =>
      observePreviewChatMessageCount(
        current,
        activeRunSessionId,
        activeRunMessageCount,
      ),
    );
  }, [activeRunMessageCount, activeRunSessionId, isConversationHidden]);
  const recoverySession =
    auxiliaryWorkspace.target === "auxiliary"
      ? activeAuxiliarySession
      : selectedSession;
  const recoveryIncarnation =
    activeAuxiliarySession?.createdAt ??
    (selectedSession ? getSessionIncarnationId(selectedSession) : null);
  const latestRecoveryTurn = useLatestSessionTurn(
    withmateApi,
    recoverySession?.id ?? null,
    recoveryIncarnation,
    recoverySession?.updatedAt,
  );
  const selectedSessionRunState: Session["runState"] | null =
    resolveSelectedSessionRunState({
      runState: selectedSession?.runState,
      hasLiveRun: hasSelectedSessionLiveRun,
      isCancellationPending:
        !!selectedSessionCancellationState ||
        pendingCancelSessionIds.has(selectedSession?.id ?? ""),
    });
  const visibleSessionRunState: Session["runState"] | null =
    activeAuxiliarySession?.runState ?? selectedSessionRunState;
  const selectedSessionCharacter = useMemo(
    () =>
      displayedSession
        ? {
            id: displayedSession.characterId,
            name:
              displayedSession.character.trim() || DEFAULT_SESSION_RUNTIME_NAME,
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
  const isSelectedSessionReadOnly = selectedSession
    ? isReadOnlySession(selectedSession)
    : false;
  const retrySource = useMemo(
    () =>
      recoverySession
        ? resolveRetrySource({
            sessionId: recoverySession.id,
            messages: recoverySession.messages,
            latestUserMessage: activeAuxiliarySession
              ? null
              : selectedSession?.latestUserMessage,
            latestTurn: latestRecoveryTurn.turn,
            runState: visibleSessionRunState,
          })
        : null,
    [
      recoverySession,
      activeAuxiliarySession,
      selectedSession?.latestUserMessage,
      latestRecoveryTurn.turn,
      visibleSessionRunState,
    ],
  );
  const retryState = useMemo(() => {
    if (
      !retrySource ||
      retrySource.kind === "failed" ||
      !shouldShowRetryActions({
        hasLastUserMessage: true,
        isReadOnly: isSelectedSessionReadOnly,
        runState: visibleSessionRunState,
      })
    )
      return null;
    return {
      kind: retrySource.kind,
      lastRequestText: retrySource.lastRequestText,
    };
  }, [retrySource, isSelectedSessionReadOnly, visibleSessionRunState]);
  const retryRequestKey = retryState
    ? `${recoverySession?.id}:${recoveryIncarnation}:${retrySource?.userMessageSeq}`
    : "";
  const retryRequestKeyRef = useRef(retryRequestKey);
  retryRequestKeyRef.current = retryRequestKey;
  const isRetryDraftReplacePending =
    !!retryRequestKey && retryDraftReplaceRequestKey === retryRequestKey;
  /** 下書き上書きの確認待ちを、対象セッションと前回依頼から決まるキーに紐付ける。 */
  const setIsRetryDraftReplacePending = (pending: boolean) =>
    setRetryDraftReplaceRequestKey(pending ? retryRequestKey : null);
  useEffect(() => {
    setRetryDraftReplaceRequestKey(null);
  }, [retryRequestKey]);
  const sessionHeader = useSessionHeaderOperations({
    api: withmateApi,
    selectedSession,
    isReadOnly: isSelectedSessionReadOnly || !loadedSession,
    runState: selectedSessionRunState,
    /** 保存先のMainセッションと世代を確かめながらタイトルを更新する。 */
    updateTitle: async (session, title, isCurrent) => {
      if (!withmateApi) return;
      return updateMainSessionTitle({
        api: withmateApi,
        session,
        title,
        /** 編集操作がまだ有効で、開いているMainが同じID・世代かを確かめる。 */
        isCurrent: () => {
          const current = getCurrentMainSession();
          return (
            isCurrent() &&
            current?.id === session.id &&
            getSessionIncarnationId(current) ===
              getSessionIncarnationId(session)
          );
        },
        /** 保存済みタイトルは、操作が有効な間だけ同じ世代の投影へ反映する。 */
        applyTitle: (taskTitle) =>
          updateSessionProjection(session.id, (current) =>
            isCurrent() &&
            getSessionIncarnationId(current) ===
              getSessionIncarnationId(session)
              ? { ...current, taskTitle }
              : current,
          ),
      });
    },
    /** ヘッダー操作から、このセッションを表示しているウィンドウを閉じる。 */
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
    terminalDock: withmateApi
      ? {
          mode: actionDockMode,
          /** ターミナルへ切り替える際は、プロンプト入力に属する選択パネルを閉じる。 */
          onChange: (mode) => {
            setActionDockMode(mode);
            if (mode === "terminal") {
              setIsAgentPickerOpen(false);
              setIsSkillPickerOpen(false);
              composerFeature.setIsAdditionalDirectoryListOpen(false);
            }
          },
          /** ターミナルの実体が用意されていれば入力フォーカスを移す。 */
          focus: () => terminalRef.current?.focus(),
        }
      : undefined,
    forceActionDockExpanded: [isAgentPickerOpen, isSkillPickerOpen],
    /** 現在の入力欄にフォーカスを戻し、カーソルを末尾へ移す。 */
    focusComposer: () =>
      restoreCurrentComposerTextareaFocusToEnd(
        () => composerTextareaRef.current,
      ),
  });
  const sessionThemeStyle = useMemo(
    () =>
      selectedSession
        ? buildCharacterThemeStyle(selectedSession.characterThemeColors)
        : undefined,
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () =>
      selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : {},
    [selectedDiff],
  );
  const isSelectedProviderEnabled = useMemo(
    () =>
      !!displayedSession &&
      getProviderAppSettings(appSettings, displayedSession.provider).enabled,
    [appSettings, displayedSession],
  );
  const auxiliaryLaunchProviderItems = useMemo(
    () =>
      buildAuxiliaryLaunchProviderItems(
        modelCatalog?.providers ?? [],
        (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
      ),
    [appSettings, modelCatalog],
  );
  const auxiliaryProviderLoadStatus: ProviderLaunchLoadStatus =
    modelCatalogLoadStatus === "error" || appSettingsLoadStatus === "error"
      ? "error"
      : modelCatalogLoadStatus === "loading" ||
          appSettingsLoadStatus === "loading"
        ? "loading"
        : "loaded";
  const auxiliaryProviderLoadError =
    modelCatalogLoadStatus === "error"
      ? modelCatalogLoadError
      : appSettingsLoadStatus === "error"
        ? appSettingsLoadError
        : "";
  const workspaceExecutionGate = useMemo(
    () =>
      selectedSession
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
  const isWorkspaceAvailabilityCheckPending =
    workspaceAvailability.status === "checking" &&
    workspaceAvailability.sessionId === selectedSession?.id;
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isSelectedSessionReadOnly) {
      return "This session is read-only. Create a new session to send messages.";
    }

    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      return (
        auxiliaryWorkspace.detailError?.message ??
        auxiliaryWorkspace.error?.message ??
        ""
      );
    }

    if (auxiliaryWorkspace.target === "main" && !loadedSession) {
      return mainSessionRuntime.readError;
    }

    if (
      appSettingsLoadStatus !== "loaded" ||
      modelCatalogLoadStatus !== "loaded"
    ) {
      return appSettingsLoadError || modelCatalogLoadError;
    }

    if (!isSelectedProviderEnabled) {
      return "Provider is disabled. Enable it in Settings.";
    }

    if (workspaceExecutionGate.blockedReason) {
      return workspaceExecutionGate.blockedReason;
    }

    return "";
  }, [
    activeAuxiliarySession,
    auxiliaryWorkspace.detailError,
    auxiliaryWorkspace.error,
    auxiliaryWorkspace.target,
    isSelectedProviderEnabled,
    isSelectedSessionReadOnly,
    selectedSession,
    workspaceExecutionGate,
    loadedSession,
    mainSessionRuntime.readError,
    appSettingsLoadStatus,
    modelCatalogLoadStatus,
    appSettingsLoadError,
    modelCatalogLoadError,
  ]);
  const turnInput = useSessionTurnInput({
    api: withmateApi,
    composerRegistry,
    drafts: auxiliaryDraftPersistence,
    submitCoordinator: mainSessionRuntime.submitCoordinator,
  });
  /** 送信受付が不明かを、表示対象のMainまたはAuxiliaryの現在の世代に絞って調べる。 */
  const hasUncertainTurnFor = (id: string | null) =>
    id === activeAuxiliarySession?.id
      ? mainSessionRuntime.hasUncertainTurnFor(
          id,
          activeAuxiliarySession.createdAt,
        )
      : id === selectedSession?.id &&
        mainSessionRuntime.hasUncertainTurnFor(
          id,
          getSessionIncarnationId(selectedSession),
        );
  const canSendInput =
    displayedSession?.provider === "codex" &&
    visibleSessionRunState === "running" &&
    !!inputTurnId &&
    !isActiveCancelRequested;
  const steeringError =
    activeRunSessionId &&
    turnInput.errors[activeRunSessionId]?.revision ===
      composerRegistry.get(composerOwner).revision
      ? turnInput.errors[activeRunSessionId].message
      : "";
  const isInputSubmissionPending =
    !!activeRunSessionId && turnInput.pendingIds.has(activeRunSessionId);
  const composerBusyReason = isInputSubmissionPending
    ? "Input submission is in progress."
    : hasPendingSubmitFor(activeRunSessionId)
      ? "Message submission is in progress."
      : auxiliaryWorkspace.target === "main" &&
          !loadedSession &&
          !mainSessionRuntime.readError
        ? "The conversation is loading."
        : appSettingsLoadStatus === "loading" ||
            modelCatalogLoadStatus === "loading"
          ? "Execution settings are loading."
          : workspaceExecutionGate.isPending
            ? "Workspace availability is being checked."
            : "";
  const composerBlockedReason =
    composerBusyReason || sessionExecutionBlockedReason;

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  const contextFeatureRef = useRef<SessionContextFeatureHandle>(null);
  const [glossaryAnnotationMatcher, setGlossaryAnnotationMatcher] =
    useState<GlossaryAnnotationMatcher>();
  const handleActivateGlossaryEntry = useCallback(
    (term: string) => contextFeatureRef.current?.activateGlossaryEntry(term),
    [],
  );

  useEffect(() => {
    applySessionDocumentTitle(
      resolveAgentSessionDocumentTitle({
        sessionTitle: selectedSession?.taskTitle,
        sessionId: selectedId,
      }),
    );
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
    modelCatalogRequestRevisionRef.current += 1;
    const unsubscribe = startModelCatalogSubscription({
      api: withmateApi,
      enabled: Boolean(selectedSession?.workspacePath),
      workspacePath: selectedSession?.workspacePath,
      subscribe: true,
      /** 新しいカタログを反映し、先行していた再取得結果と初回取得エラーを無効にする。 */
      applyModelCatalog: (snapshot) => {
        modelCatalogRequestRevisionRef.current += 1;
        setModelCatalog(snapshot);
        setModelCatalogLoadStatus("loaded");
        setModelCatalogLoadError("");
      },
      /** 初回カタログ取得失敗を設定の失敗とは別の状態に保持する。 */
      onInitialLoadError: (error) => {
        setModelCatalogLoadStatus("error");
        setModelCatalogLoadError(
          error instanceof Error
            ? error.message
            : "Could not load model catalog.",
        );
      },
    });
    return () => {
      modelCatalogRequestRevisionRef.current += 1;
      unsubscribe();
    };
  }, [withmateApi, selectedSession?.workspacePath, modelCatalogReadRevision]);

  useEffect(() => {
    return startAppSettingsSubscription({
      api: withmateApi,
      loadInitial: true,
      /** 受け取ったアプリ設定を有効にし、既定値での仮表示と読み込みエラーを終える。 */
      applyAppSettings: (settings) => {
        setAppSettings(settings);
        setIsAppSettingsLoaded(true);
        setAppSettingsLoadStatus("loaded");
        setAppSettingsLoadError("");
      },
      /** 初回の設定取得失敗をカタログとは独立した再試行対象にする。 */
      onInitialLoadError: (error) => {
        setAppSettingsLoadStatus("error");
        setAppSettingsLoadError(
          error instanceof Error ? error.message : "Could not load app state.",
        );
      },
    });
  }, [withmateApi, appSettingsReadRevision]);

  const displayedMessages: Message[] = displayedSession?.messages ?? [];
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const isMessageListFollowing = true;
  const handleMessageListScroll = useCallback(() => {}, []);
  const followMessageListLatest = useCallback(() => {}, []);

  useEffect(() => {
    setIsRetryDraftReplacePending(false);
  }, [selectedSession?.provider, selectedSessionId]);

  useEffect(() => {
    if (!draft.trim()) {
      setIsRetryDraftReplacePending(false);
    }
  }, [draft]);

  const selectedProviderCatalog = useMemo(
    () =>
      modelCatalog && displayedSession
        ? getProviderCatalog(modelCatalog.providers, displayedSession.provider)
        : null,
    [displayedSession, modelCatalog],
  );
  const availableReasoningEfforts = useMemo(
    () =>
      selectedProviderCatalog && displayedSession
        ? getReasoningEffortOptionsForModel(
            selectedProviderCatalog,
            displayedSession.model,
          )
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

    const hasSelectedModel = options.some(
      (model) => model.id === displayedSession.model,
    );
    if (!hasSelectedModel) {
      options.unshift({
        id: displayedSession.model,
        label: displayedSession.model,
        reasoningEfforts:
          availableReasoningEfforts.length > 0
            ? [...availableReasoningEfforts]
            : [displayedSession.reasoningEffort],
      });
    }

    return options;
  }, [availableReasoningEfforts, displayedSession, selectedProviderCatalog]);
  const contextRenderedIsRunning = activeAuxiliarySession
    ? activeAuxiliarySession.runState === "running"
    : resolveSelectedSessionIsRunning({ runState: selectedSessionRunState });
  /** 前回依頼の編集を始める前に、入力欄に残る下書きの保護が必要かを判定する。 */
  const shouldProtectDraftOnRetryEdit = () =>
    shouldProtectRetryEditDraft({
      retryState,
      draft: getComposerDraft(),
    });
  const isComposerDisabled =
    !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        canQueueTurn: true,
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
    retryState,
    hasLastUserMessage: !!retrySource,
    composerBlocked:
      !!composerBlockedReason ||
      composerRegistry.isFrozen ||
      hasUncertainTurnFor(composerOwner.id) ||
      !!activeQueuedTurnEdit,
    isReadOnly: isSelectedSessionReadOnly,
    runState: visibleSessionRunState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const { handleExpandActionDock, handleToggleActionDock } = chatShellFeature;
  /** 予約の編集を開始し、予約元のMain枠またはAuxiliaryを表示して入力欄を開く。 */
  const handleBeginQueuedTurnEdit = (receipt: SessionTurnQueueReceipt) => {
    if (composerRegistry.isFrozen || isSelectedSessionReadOnly) return;
    void queueEditor.begin(
      receipt,
      receipt.sessionId === selectedId ? mainFrameId : undefined,
    );
    if (receipt.sessionId === selectedId) auxiliaryWorkspace.setTarget("main");
    else {
      auxiliaryWorkspace.selectSession(receipt.sessionId);
      auxiliaryWorkspace.setTarget("auxiliary");
    }
    handleExpandActionDock({ focusComposer: false });
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  };
  const dockContextRef = useRef({
    activeRunSessionId,
    isAgentPickerOpen,
    isSkillPickerOpen,
    isRetryDraftReplacePending,
  });
  if (
    dockContextRef.current.activeRunSessionId !== activeRunSessionId ||
    dockContextRef.current.isAgentPickerOpen !== isAgentPickerOpen ||
    dockContextRef.current.isSkillPickerOpen !== isSkillPickerOpen ||
    dockContextRef.current.isRetryDraftReplacePending !==
      isRetryDraftReplacePending
  ) {
    dockContextRef.current = {
      activeRunSessionId,
      isAgentPickerOpen,
      isSkillPickerOpen,
      isRetryDraftReplacePending,
    };
  }
  const autoCollapseRef = useRef(appSettings.autoCollapseActionDockOnSend);
  autoCollapseRef.current = appSettings.autoCollapseActionDockOnSend;
  /** 送信成功まで設定・入力先・開閉の意図が変わっていなければ、入力欄を折りたたむ処理を返す。 */
  const captureSendDockCollapse = () => {
    const context = dockContextRef.current;
    const isCurrentIntent = layoutPresentation.captureActionDockIntent();
    const autoCollapse = appSettings.autoCollapseActionDockOnSend;
    return () => {
      if (
        autoCollapse &&
        autoCollapseRef.current &&
        context === dockContextRef.current &&
        isCurrentIntent()
      ) {
        flushSync(() => setIsActionDockPinnedExpanded(false));
      }
    };
  };
  useEffect(() => {
    setForceComposerBlockedFeedback(false);
  }, [selectedSession?.id]);

  /** セッションが選ばれているとき、送信できない理由を入力欄に出す。 */
  const triggerComposerBlockedFeedback = () => {
    if (!selectedSession) {
      return;
    }

    setForceComposerBlockedFeedback(true);
  };

  const captureMessageListSendRef = useRef<
    ((sessionId: string) => () => void) | null
  >(null);
  const replyOwner = JSON.stringify([
    normalComposerOwner.kind,
    normalComposerOwner.id,
    activeAuxiliarySession?.createdAt ?? selectedSession?.incarnationId,
  ]);
  const [replyDraft, setReplyDraft] = useState<{
    owner: string;
    key: string;
    revision: number;
    reference?: SessionReply;
    error?: string;
  } | null>(null);
  const replyRevision = useRef(0);
  const auxiliaryReply = replyDraft?.owner === replyOwner ? replyDraft : null;
  const selectedReply = activeQueuedTurnEdit
    ? null
    : normalComposerOwner.kind === "main"
      ? mainReply
      : auxiliaryReply;
  /** 受付時のリビジョンと一致するAuxiliaryの返信選択だけを消す。 */
  const clearReply = (revision: number | undefined) => {
    if (revision === undefined) return;
    setReplyDraft((current) =>
      current?.revision === revision ? null : current,
    );
  };
  /** 返信先を切り替えて引用情報を取得し、取得中に選び直した対象を古い応答で上書きしない。 */
  const selectReply = (key: string, reference: SessionReply) => {
    if (
      !loadedSession ||
      loadedSession.sessionKind !== "default" ||
      isSelectedSessionReadOnly ||
      composerRegistry.isFrozen ||
      activeQueuedTurnEdit ||
      isAuxiliaryTargetUnavailable
    )
      return;
    if (normalComposerOwner.kind === "main") {
      if (composerRegistry.get(normalComposerOwner).reply?.key === key) {
        composerRegistry.setReply(normalComposerOwner, undefined);
        return;
      }
      const pending = { key };
      composerRegistry.setReply(normalComposerOwner, pending);
      void readReplyQuote(loadedSession.id, reference).then(
        (reply) => {
          composerRegistry.resolveReply(normalComposerOwner, pending, {
            key,
            reference: reply.reference,
          });
        },
        (error: unknown) => {
          composerRegistry.resolveReply(normalComposerOwner, pending, {
            key,
            error: resolveSessionRunErrorMessage(
              error,
              "Could not read the reply target.",
            ),
          });
        },
      );
      return;
    }
    if (auxiliaryReply?.key === key) {
      clearReply(auxiliaryReply.revision);
      return;
    }
    const revision = ++replyRevision.current;
    setReplyDraft({ owner: replyOwner, key, revision });
    void readReplyQuote(loadedSession.id, reference).then(
      (reply) => {
        setReplyDraft((current) =>
          current?.revision === revision
            ? { ...current, reference: reply.reference }
            : current,
        );
      },
      (error: unknown) => {
        setReplyDraft((current) =>
          current?.revision === revision
            ? {
                ...current,
                error: resolveSessionRunErrorMessage(
                  error,
                  "Could not read the reply target.",
                ),
              }
            : current,
        );
      },
    );
  };
  /** Mainへの送信要求に現在の実行設定と会話枠を取り込み、再送は通常入力の返信先や表示枠を引き継がない。 */
  const sendMessage = async (
    messageText: string,
    options?: {
      clearDraft?: boolean;
      collapseActionDock?: boolean;
      submitSource?: "composer" | "retry";
    },
  ) => {
    const sendSession = getCurrentMainSession();
    if (!withmateApi || !sendSession) {
      return;
    }
    const sessionId = sendSession.id;
    const incarnationId = getSessionIncarnationId(sendSession);
    const collapseSentActionDock = captureSendDockCollapse();
    const followAcceptedSend =
      options?.submitSource === "retry"
        ? undefined
        : captureMessageListSendRef.current?.(sessionId);
    /** 受付の反映時に、入力欄の所有者とMainのID・世代が送信時と同じかを確かめる。 */
    const isCurrentSubmission = () => {
      const current = getCurrentMainSession();
      return (
        composerOwnerRef.current === sessionId &&
        current?.id === sessionId &&
        getSessionIncarnationId(current) === incarnationId
      );
    };
    const clientRequestId = createSessionTurnClientRequestId();
    const reply =
      options?.submitSource === "retry"
        ? null
        : composerRegistry.get(composerOwner).reply;
    if (reply && !reply.reference) return;
    const main = { kind: "main" as const, sessionId, incarnationId };
    const view = mainViewRef.current;
    const currentView =
      view && conversationPeerKey(view.main) === conversationPeerKey(main)
        ? view
        : null;
    const replyFrame = savedReplyConversationFrame(
      main,
      currentView?.projection,
      reply?.reference,
    );
    const request: RunSessionTurnRequest = {
      userMessage: messageText,
      ...(reply?.reference ? { replyTo: reply.reference } : {}),
      ...(options?.submitSource === "retry"
        ? {}
        : {
            mainConversationFrame:
              replyFrame !== undefined
                ? replyFrame
                : (currentView?.child ?? null),
          }),
      clientRequestId,
      submitSource: options?.submitSource ?? "composer",
      executionOptions: captureSessionExecutionOptions(sendSession),
    };
    await runMainSessionTurnFromRuntime({
      sessionId,
      selectedSession: sendSession,
      request,
      composerOwner,
      clearDraft: options?.clearDraft ?? true,
      queueTurn: true,
      isCurrentSubmission,
      shouldCollapseActionDock: options?.collapseActionDock ?? false,
      selectedSessionRunState,
      blockedReason: sessionExecutionBlockedReason,
      isReadOnly: isSelectedSessionReadOnly,
      /** 実行直前に、送信対象のワークスペースの利用可否を再確認する。 */
      validateWorkspace: () => validateSessionWorkspace(sendSession, true),
      collapseActionDock: collapseSentActionDock,
      /** 受付時も同じ入力欄を表示している場合だけ、送信したメッセージを追従表示する。 */
      onSubmitted: () => {
        if (
          isCurrentSubmission() &&
          currentComposerOwner.current === composerOwner
        )
          followAcceptedSend?.();
      },
      log: logSessionRunStuckInvestigation,
    });
  };

  /** 入力欄の確定を予約編集・Auxiliary送信・Main送信に振り分け、送信条件を満たさなければ理由を表示する。 */
  const handleSend = async () => {
    if (composerRegistry.isFrozen) return;
    if (activeQueuedTurnEdit) {
      const id = activeQueuedTurnEdit.receipt.sessionId;
      if (await queueEditor.submit(id))
        requestAnimationFrame(() => {
          if (
            currentComposerOwner.current === normalComposerOwner ||
            currentComposerOwner.current === composerOwner
          )
            composerTextareaRef.current?.focus();
        });
      return;
    }
    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      triggerComposerBlockedFeedback();
      return;
    }
    if (activeAuxiliarySession) {
      const currentComposerState = composerRegistry.get(composerOwner);
      if (
        composerBusyReason ||
        hasUncertainTurnFor(activeAuxiliarySession.id)
      ) {
        return;
      }
      if (
        currentComposerState.saveState === "error" ||
        currentComposerState.preview.errors.length > 0
      ) {
        triggerComposerBlockedFeedback();
        return;
      }
      if (
        !currentComposerState.draft.trim() ||
        composerBlockedReason ||
        isSelectedSessionReadOnly
      ) {
        triggerComposerBlockedFeedback();
        return;
      }
      try {
        setForceComposerBlockedFeedback(false);
        await sendAuxiliaryMessage();
      } catch (error) {
        if (
          !mainSessionRuntime.turnSubmissions
            .getSnapshot()
            .some(
              (submission) =>
                submission.sessionId === activeAuxiliarySession.id &&
                submission.error,
            )
        ) {
          window.alert(
            resolveSessionRunErrorMessage(error, "Could not send the message."),
          );
        }
      }
      return;
    }

    const currentComposerState = composerRegistry.get(composerOwner);
    if (
      isComposerDisabled ||
      hasUncertainTurnFor(selectedId) ||
      currentComposerState.saveState === "error" ||
      currentComposerState.preview.errors.length > 0 ||
      !getComposerDraft().trim()
    ) {
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
      if (
        !mainSessionRuntime.turnSubmissions
          .getSnapshot()
          .some(
            (submission) =>
              submission.sessionId === selectedId && submission.error,
          )
      ) {
        window.alert(
          resolveSessionRunErrorMessage(error, "Could not send the message."),
        );
      }
    }
  };

  /** 通常送信や予約更新とは分けて実行中のターンへ入力し、受付時に対象と下書きの所有者を照合できるようにする。 */
  const handleSendInput = async () => {
    if (activeQueuedTurnEdit || (selectedReply && !selectedReply.reference))
      return;
    const selectionContext = dockContextRef.current;
    if (
      hasPendingSubmitFor(composerOwner.id) ||
      hasUncertainTurnFor(composerOwner.id)
    )
      return;
    const mainSession = getCurrentMainSession();
    if (!activeAuxiliarySession && !mainSession) return;
    await turnInput.send({
      owner: composerOwner,
      auxiliarySession: activeAuxiliarySession,
      replyTo: selectedReply?.reference,
      onAccepted: activeAuxiliarySession
        ? () => clearReply(auxiliaryReply?.revision)
        : undefined,
      turnId: inputTurnId ?? null,
      canSendInput,
      blockedReason: composerBlockedReason,
      isReadOnly: isSelectedSessionReadOnly,
      /** 受付時の表示が入力送信を始めたときと同じ入力先かを判定する。 */
      isCurrent: () =>
        dockContextRef.current === selectionContext &&
        composerOwnerRef.current === composerOwner.id,
      /** 送信先のセッションが同じ世代のままかを、最新の詳細で確かめる。 */
      isCurrentOwner: () => {
        if (activeAuxiliarySession)
          return (
            auxiliaryBinding.getSession()?.createdAt ===
            activeAuxiliarySession.createdAt
          );
        const latest = getCurrentMainSession();
        return (
          !!mainSession &&
          !!latest &&
          getSessionIncarnationId(latest) ===
            getSessionIncarnationId(mainSession)
        );
      },
      retainDetail: activeAuxiliarySession
        ? auxiliaryBinding.retainDetail
        : () => () => {},
      /** 実行中ターンへの入力がブロックされた理由を入力欄に出す。 */
      onBlocked: () => setForceComposerBlockedFeedback(true),
    });
  };

  /** 取消待ちなら重ねて要求せず、Mainの停止対象だけを取り消す。 */
  const handleCancelRun = async () => {
    if (selectedSessionCancellationState) return;
    await cancelRun(mainStopTarget, "main");
  };

  /** ショートカットから現在の入力欄を確定し、IME変換中や送信保留中の通常送信を避ける。 */
  const handleComposerSubmitShortcut = () => {
    if (activeQueuedTurnEdit) {
      if (!composerRegistry.get(composerOwner).isImeComposing)
        void handleSend();
      return;
    }
    return applyComposerSubmitCommand({
      /** キー入力を確定しない条件を、入力欄の最新状態と未確定の送信から判断する。 */
      isSubmitDisabled: () => {
        const current = composerRegistry.get(composerOwner);
        return (
          composerRegistry.isFrozen ||
          current.isImeComposing ||
          current.saveState === "error" ||
          hasPendingSubmitFor(composerOwner.id) ||
          hasUncertainTurnFor(composerOwner.id)
        );
      },
      /** 送信先のMainまたはAuxiliaryに合わせて、下書きと実行条件からブロック理由の表示要否を求める。 */
      isSubmitBlocked: () => {
        const current = composerRegistry.get(composerOwner);
        const activeSendability = activeAuxiliarySession
          ? buildComposerSendabilityState({
              runState: activeAuxiliarySession.runState,
              canQueueTurn: true,
              busyReason: composerBusyReason,
              blockedReason: sessionExecutionBlockedReason,
              inputErrors: current.preview.errors,
              draftText: current.draft,
            })
          : resolveComposerSendabilityState({
              runState: selectedSessionRunState,
              canQueueTurn: true,
              busyReason: composerBusyReason,
              blockedReason: sessionExecutionBlockedReason,
              inputErrors: current.preview.errors,
              draftText: current.draft,
              forceBlockedFeedback: forceComposerBlockedFeedback,
            });
        return (
          current.saveState === "error" || activeSendability.isSendDisabled
        );
      },
      notifySubmitBlocked: triggerComposerBlockedFeedback,
      /** 送信可能なショートカットを通常の確定処理へ渡す。 */
      submit: () => void handleSend(),
    });
  };

  useShortcutDispatcherSettings(appSettings.keyboardShortcuts);
  useShortcutScope("composer");
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.composerSubmit,
    handleComposerSubmitShortcut,
  );
  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.composerSendInput, () => {
    void handleSendInput();
  });

  const handleSelectSkill = createSkillPromptInsertionHandler<DiscoveredSkill>({
    /** Mainセッションで使うスキル構文を決めるProviderを返す。 */
    getProvider: () => selectedSession?.provider,
    /** スキルの挿入位置を計算するため、現在の入力欄の下書きを読む。 */
    getDraft: () => getComposerDraft(),
    /** スキルの挿入位置を決めるため、表示中の入力欄要素を返す。 */
    getTextarea: () => composerTextareaRef.current,
    setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
    setCaret: setComposerCaret,
    setSkillPickerOpen: setIsSkillPickerOpen,
    /** スキルを挿入した本文とカーソル位置を、通常の下書き変更処理に渡す。 */
    applyDraft: (nextDraft, nextCaret) => {
      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft,
        /** 更新後の選択開始位置をMain入力欄のカーソル参照にも保存する。 */
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

  /** 編集可能なCopilotのMainで、選択が変わったときだけカスタムエージェントを保存する。 */
  const handleSelectCustomAgent = async (
    agent: DiscoveredCustomAgent | null,
  ) => {
    if (
      composerRegistry.isFrozen ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      selectedSession.provider !== "copilot"
    ) {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === selectedSession.customAgentName) {
      closeAgentPicker();
      return;
    }

    await runMainRuntimeOption({
      kind: "custom-agent",
      value: nextCustomAgentName,
    });
    closeAgentPicker();
  };

  /** ピン操作の重複を避け、会話未取得時は更新後のピンを要約から読み直す。 */
  const handleToggleSessionPin = async () => {
    if (!withmateApi || !selectedSession || isSessionPinPending) {
      return;
    }
    try {
      await toggleSessionPin(selectedSession);
      if (!loadedSession) sessionSummaryRead.retry();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Could not update the pin.",
      );
    }
  };

  /** Mainの実行設定変更を、最新のセッション・カタログと読み取り専用状態に基づいて処理する。 */
  const runMainRuntimeOption = async (option: MainRuntimeOption) => {
    if (!withmateApi) return;
    await runMainRuntimeOptionOperation({
      session: getCurrentMainSession(),
      isReadOnly: isSelectedSessionReadOnly,
      providerCatalog: selectedProviderCatalog,
      option,
      /** 以前の失敗表示を消し、確認済みのレビュアー変更や承認の選択を添えて保存する。 */
      persist: (nextSession, confirmedReviewerChange, approvalChoice) => {
        setExecutionOptionsFeedback(null);
        return Promise.resolve(
          selectMainExecutionOptions(
            nextSession,
            confirmedReviewerChange,
            approvalChoice,
          ),
        );
      },
      createTimestampLabel: currentTimestampLabel,
    });
  };

  /** デスクトップAPIがあれば、指定の差分を別ウィンドウで開く。 */
  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(diffPreview);
  };

  /** 詳細を保持したまま、Auxiliaryの下書き・セッション保存キューと変更世代を使って更新する。 */
  const updateActiveAuxiliarySession = async (
    recipe: (current: AuxiliarySession) => AuxiliarySession,
  ) => {
    const releaseDetail = auxiliaryBinding.retainDetail();
    try {
      await createGuardedActiveAuxiliarySessionUpdater({
        activeSession: activeAuxiliarySession,
        /** 更新を開始した詳細の参照から、現在の保存対象を取得する。 */
        getCurrentSession: () => activeAuxiliarySessionRef.current,
        /** デスクトップAPIがなければ永続化できないことを更新処理に伝える。 */
        getApi: () => withmateApi,
        setActiveSession: setActiveAuxiliarySession,
        draftSaveQueue: auxiliaryDraftSaveQueueRef,
        sessionSaveQueue: auxiliarySessionSaveQueueRef,
        mutationRevision: auxiliarySessionMutationRevisionRef,
      })(recipe);
    } finally {
      releaseDetail();
    }
  };

  /** 選択中のAuxiliaryに実行設定の変更を送り、その所有者に紐付けて保存結果を伝える。 */
  const updateAuxiliaryExecutionOptions = (
    recipe: (current: AuxiliarySession) => AuxiliarySession,
    confirmedReviewerChange?: import("../../src-shared/session/session-mutation-contract.js").ConfirmedReviewerChange,
    approvalChoice?: import("../../src-shared/settings/session-approval-choice.js").SessionApprovalChoice,
  ) =>
    auxiliaryExecutionOptionsOwner.update({
      api: withmateApi,
      binding: auxiliaryBinding,
      isReadOnly: isSelectedSessionReadOnly,
      recipe,
      confirmedReviewerChange,
      approvalChoice,
      onFeedback: setExecutionOptionsFeedback,
    });

  const handleToggleMessageBookmark = createMessageBookmarkHandler({
    api: withmateApi,
    mainSession: selectedSession,
    isReadOnly: isSelectedSessionReadOnly,
    getAuxiliaryBinding: auxiliaryWorkspace.getBinding,
    updateSessionProjection,
  });

  /** 凍結中でなければ、選択したカスタムエージェント名を整えてAuxiliaryの設定変更に渡す。 */
  const handleSelectAuxiliaryCustomAgent = async (
    agent: DiscoveredCustomAgent | null,
  ) => {
    if (composerRegistry.isFrozen) return;
    const nextCustomAgentName = (agent?.name ?? "").trim();
    await runAuxiliaryCustomAgentSelectionOperation({
      activeSession: activeAuxiliarySession,
      customAgentName: nextCustomAgentName,
      /** カスタムエージェントだけを変更するパッチをAuxiliaryの実行設定として保存する。 */
      updateCustomAgent: async (customAgentName) => {
        await runAuxiliaryCustomAgentPatchOperation({
          customAgentName,
          updateActiveAuxiliarySession: updateAuxiliaryExecutionOptions,
          createTimestampLabel: currentTimestampLabel,
        });
      },
      closeAgentPicker,
    });
  };

  /** 選択したスキルを現在のAuxiliary下書きに挿入し、保存後に同じ入力欄へフォーカスを戻す。 */
  const handleSelectAuxiliarySkill = async (skill: DiscoveredSkill) => {
    if (composerRegistry.isFrozen) return;
    const textarea = composerTextareaRef.current;
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: activeAuxiliarySession
        ? { ...activeAuxiliarySession, composerDraft: getComposerDraft() }
        : null,
      skillName: skill.name,
      skillSourcePath: skill.sourcePath,
      /** スキル挿入で決まった開閉状態とカーソル位置を入力欄に反映する。 */
      applyUiState: (nextState) => {
        applySkillPromptInsertionUiState({
          state: nextState,
          setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
          setCaret: setComposerCaret,
          setSkillPickerOpen: setIsSkillPickerOpen,
        });
      },
      /** 挿入後の内容を通常のAuxiliary下書き更新に渡し、末尾を選択位置にする。 */
      updateDraft: async (draft) => {
        await handleAuxiliaryDraftChange(draft, draft.length);
      },
      /** 保存待ちに入力先が変わっていなければ、挿入位置にカーソルを戻す。 */
      afterDraftUpdated: (nextState) => {
        if (composerOwnerRef.current === activeRunSessionId) {
          restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
        }
      },
    });
  };

  /** 再送対象が変わっていないことを確かめ、前回依頼を現在のセッションへ送り直す。 */
  const handleResendLastMessage = async () => {
    await runRetryResendCommand({
      isDisabled:
        isRetryActionDisabled || retryRequestKeyRef.current !== retryRequestKey,
      messageText: retryState?.lastRequestText,
      /** Main・Auxiliaryのどちらでも、現在の通常下書きは消さずに前回依頼を再送する。 */
      resendMessage: async (messageText) => {
        if (activeAuxiliarySession) {
          await sendAuxiliaryMessage(messageText, {
            clearDraft: false,
            submitSource: "retry",
            collapseActionDock: false,
          });
        } else {
          await sendMessage(messageText, {
            clearDraft: false,
            submitSource: "retry",
          });
        }
      },
    });
  };

  /** 再試行対象が変わっていなければ、前回の本文を対象の下書きに復元する。 */
  const restoreLastUserMessageToDraft = (messageText: string) => {
    if (
      composerRegistry.isFrozen ||
      retryRequestKeyRef.current !== retryRequestKey
    )
      return;
    applyRetryDraftRestoreCommand({
      messageText,
      /** 復元した本文を表示できるよう入力欄を開き、フォーカスの移動は後段に任せる。 */
      setActionDockPinnedExpanded: () =>
        handleExpandActionDock({ focusComposer: false }),
      setDraft: activeAuxiliarySession
        ? (value) => {
            void auxiliaryDraftPersistence.changeDraft(
              activeAuxiliarySession,
              value,
              value.length,
            );
          }
        : setDraft,
      setCaret: setComposerCaret,
      syncCaret: activeAuxiliarySession
        ? undefined
        : (caret) => {
            mainComposerCaretRef.current = caret;
          },
      setRetryDraftReplacePending: setIsRetryDraftReplacePending,
      /** 展開後、同じ再試行対象なら入力欄にフォーカスし、指定位置にカーソルを置く。 */
      focusComposer: (caret) =>
        requestAnimationFrame(() => {
          if (retryRequestKeyRef.current !== retryRequestKey) return;
          const textarea = composerTextareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        }),
    });
  };

  const handleEditLastMessage = createRetryEditHandler({
    isDisabled: isRetryEditDisabled,
    messageText: retryState?.lastRequestText,
    shouldProtectDraft: shouldProtectDraftOnRetryEdit,
    /** 現在の再試行対象についてだけ、下書きの上書き確認を表示する。 */
    requestDraftReplaceConfirmation: () => {
      if (retryRequestKeyRef.current === retryRequestKey)
        setIsRetryDraftReplacePending(true);
    },
    restoreDraft: restoreLastUserMessageToDraft,
  });

  const handleConfirmRetryDraftReplace =
    createRetryDraftReplaceConfirmationHandler({
      isDisabled: isRetryEditDisabled || !isRetryDraftReplacePending,
      messageText: retryState?.lastRequestText,
      restoreDraft: restoreLastUserMessageToDraft,
    });

  const handleCancelRetryDraftReplace = createCancelRetryDraftReplaceHandler({
    setRetryDraftReplacePending: setIsRetryDraftReplacePending,
  });

  /** 本文のファイル参照をそのセッションのプレビューで開き、古い操作の結果はエラー表示に反映しない。 */
  const handleOpenInlinePath = async (
    target: string,
    ownerSessionId = activeRunSessionId,
  ) => {
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
      if (
        !inlinePathOperationRevisionRef.current.isCurrent(operationRevision)
      ) {
        return;
      }
      setInlinePathError(
        result.status === "opened"
          ? null
          : { ownerSessionId, target, message: result.message },
      );
    } catch (error) {
      if (
        !inlinePathOperationRevisionRef.current.isCurrent(operationRevision)
      ) {
        return;
      }
      setInlinePathError({
        ownerSessionId,
        target,
        message:
          error instanceof Error
            ? error.message
            : "The path could not be opened.",
      });
    }
  };

  /** 取消待ちでなければ、選択中のAuxiliaryの停止対象だけを取り消す。 */
  const handleCancelAuxiliaryRun = async () => {
    if (activeCancellationState) return;
    await cancelRun(auxiliaryStopTarget, "auxiliary");
  };

  const handleOpenAuxiliaryLaunchDialog =
    createAuxiliaryLaunchDialogOpenHandler({
      /** 親にあたるMainが選択されているときだけ、作成ダイアログを開ける。 */
      canOpen: () => !!selectedSession,
      providers: auxiliaryLaunchProviderItems,
      /** 初期Providerの候補として親のMainで使用中のProviderを返す。 */
      getSelectedProviderId: () => selectedSession?.provider,
      /** ダイアログを開くときに、判明している作成状態の通知を復元する。 */
      openAuxiliaryLaunchDialog: (params) => {
        openAuxiliaryLaunchDialog(params);
        const feedback = resolveAuxiliaryLaunchCreationFeedback({
          status: auxiliaryCreationStatus ?? "not-found",
        });
        if (feedback) setAuxiliaryLaunchStartError(new Error(feedback));
      },
    });

  const handleCloseAuxiliaryLaunchDialog =
    createAuxiliaryLaunchDialogCloseHandler({
      closeAuxiliaryLaunchDialog,
    });

  const handleSelectAuxiliaryLaunchProvider =
    createAuxiliaryLaunchProviderSelectHandler({
      selectAuxiliaryLaunchProvider,
    });

  /** 親とワークスペースが利用可能で有効なProviderが選べる場合に、Auxiliaryの作成を要求する。 */
  const handleStartAuxiliarySession = async () => {
    if (
      !selectedSession ||
      isSelectedSessionReadOnly ||
      !isSelectedWorkspaceAvailable ||
      auxiliaryProviderLoadStatus !== "loaded"
    )
      return;
    const startProvider = resolveAuxiliaryLaunchStartProvider({
      providerId: resolveAuxiliaryLaunchProviderId(
        auxiliaryLaunchProviderItems,
        auxiliaryLaunchProviderId,
      ),
    });
    if (startProvider.status === "blocked") {
      setAuxiliaryLaunchStartError(startProvider.error);
      return;
    }
    await auxiliaryCreation.start(startProvider.providerId);
  };

  /** 実行ターンではなく、進行中のAuxiliary作成要求を取り消す。 */
  const handleCancelAuxiliaryCreation = () => auxiliaryCreation.cancel();

  /** Auxiliaryの予約編集は予約専用の下書きに留め、通常入力はセッションの下書きとして保存する。 */
  const handleAuxiliaryDraftChange = async (
    value: string,
    selectionStart: number,
  ) => {
    const session = activeAuxiliarySession;
    if (!session || composerRegistry.isFrozen) return;
    setForceComposerBlockedFeedback(false);
    if (activeQueuedTurnEdit) {
      if (queueEditor.canChangeDraft(composerOwner.id))
        composerRegistry.setDraft(composerOwner, value, {
          start: selectionStart,
          end: selectionStart,
        });
      return;
    }
    await auxiliaryDraftPersistence.changeDraft(session, value, selectionStart);
  };

  /** 入力欄が凍結していなければ、選択中のAuxiliaryの下書き保存をやり直す。 */
  const handleRetryAuxiliaryDraftSave = () => {
    if (!activeAuxiliarySession || composerRegistry.isFrozen) return;
    auxiliaryDraftPersistence.retrySave(activeAuxiliarySession);
  };

  /** 選択中のAuxiliaryと下書きの所有者を固定して送信を登録し、受付が終わるまで対象の詳細を保持する。 */
  const sendAuxiliaryMessage = (
    messageText?: string,
    options?: {
      clearDraft?: boolean;
      collapseActionDock?: boolean;
      submitSource?: "composer" | "retry";
    },
  ): Promise<unknown> => {
    if (!withmateApi || composerRegistry.isFrozen) return Promise.resolve();
    const selected = activeAuxiliarySessionRef.current;
    if (!selected || !displayedSession) return Promise.resolve();
    const owner: ComposerOwner = { kind: "auxiliary", id: selected.id };
    const draftOwner = auxiliaryDraftPersistence.getOwner(selected);
    if (!draftOwner) return Promise.resolve();
    const selectionContext = dockContextRef.current;
    const collapseSentActionDock = captureSendDockCollapse();
    const followAcceptedSend =
      options?.submitSource === "retry"
        ? undefined
        : captureMessageListSendRef.current?.(selected.id);
    /** 受付時に表示と入力先が変わっておらず、Auxiliaryの世代も同じかを確認する。 */
    const isCurrentSubmission = () =>
      dockContextRef.current === selectionContext &&
      composerOwnerRef.current === selected.id &&
      auxiliaryBinding.getSession()?.createdAt === selected.createdAt;
    const releaseDetail = auxiliaryBinding.retainDetail();
    const reply = options?.submitSource === "retry" ? null : auxiliaryReply;
    if (reply && !reply.reference) {
      releaseDetail();
      return Promise.resolve();
    }
    return auxiliaryDraftPersistence.trackSend(
      runMainSessionTurnFromRuntime({
        sessionId: selected.id,
        selectedSession: {
          ...displayedSession,
          id: selected.id,
          incarnationId: selected.createdAt,
        },
        request: {
          userMessage: messageText ?? composerRegistry.capture(owner).draft,
          ...(reply?.reference ? { replyTo: reply.reference } : {}),
          clientRequestId: createSessionTurnClientRequestId(),
          submitSource: options?.submitSource ?? "composer",
          executionOptions: captureSessionExecutionOptions(selected),
          displayAnchorParentMessageCount:
            selectedSession?.messageCount ??
            selectedSession?.messages.length ??
            0,
        },
        composerOwner: owner,
        auxiliaryDraftOwner:
          options?.submitSource === "retry" ? undefined : draftOwner,
        isCurrentSubmission,
        clearDraft: options?.clearDraft ?? true,
        queueTurn: true,
        shouldCollapseActionDock:
          options?.collapseActionDock ??
          appSettings.autoCollapseActionDockOnSend,
        selectedSessionRunState: selected.runState,
        blockedReason: sessionExecutionBlockedReason,
        isReadOnly: isSelectedSessionReadOnly,
        /** 親のMainが使うワークスペースを再確認し、親を取得できなければ送信を許可しない。 */
        validateWorkspace: () =>
          selectedSession
            ? validateSessionWorkspace(selectedSession, true)
            : Promise.resolve(false),
        collapseActionDock: collapseSentActionDock,
        /** 受付時も同じAuxiliaryを表示している場合だけ、新しいメッセージへ追従する。 */
        onSubmitted: () => {
          if (isCurrentSubmission()) followAcceptedSend?.();
        },
        log: logSessionRunStuckInvestigation,
      })
        .then((receipt) => {
          if (receipt) clearReply(reply?.revision);
          return receipt;
        })
        .finally(releaseDetail),
    );
  };

  const handleCopyMessageText = createCopyMessageTextHandler({
    /** コピー用に整形済みのメッセージをクリップボードに書き込む。 */
    writeText: (normalized) => navigator.clipboard.writeText(normalized),
    /** コピーが失敗したときは、調査用の例外を記録し操作が失敗したことを知らせる。 */
    onFailure: (error) => {
      console.error(error);
      window.alert("Could not copy the content.");
    },
  });

  const handleQuoteMessageText = createQuoteMessageTextHandler({
    /** 凍結と対象セッションの入力制限から、引用の挿入が許されるかを確かめる。 */
    isBlocked: () =>
      composerRegistry.isFrozen ||
      (activeAuxiliarySession ? !!composerBlockedReason : isComposerDisabled),
    notifyBlocked: triggerComposerBlockedFeedback,
    /** 引用位置を決めるため、表示中の入力欄と要素がない場合のカーソル位置を渡す。 */
    getComposerState: () => ({
      draft: getComposerDraft(),
      fallbackCaret: composerRegistry.get(composerOwner).selection.start,
      textarea: composerTextareaRef.current,
    }),
    /** 引用を挿入した本文とカーソル位置を、表示中のMainまたはAuxiliaryの下書きへ反映する。 */
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
        /** 引用を挿入した直後の選択開始位置をMain入力欄の参照にも残す。 */
        syncMainComposerCaret: (selectionStart) => {
          mainComposerCaretRef.current = selectionStart;
        },
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  /** 選んだパスをワークスペース基準の参照として、現在の入力欄の選択位置に挿入する。 */
  const insertReferencePaths = (selectedPaths: string[]) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea =
      currentComposerOwner.current === composerOwner
        ? composerTextareaRef.current
        : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
    applySelectedPathReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: composerRegistry.get(composerOwner).selection.start,
      selectedPaths,
      textarea,
      workspacePath: selectedSession?.workspacePath ?? null,
      /** 挿入結果を、操作開始時に対象だったMainまたはAuxiliaryの下書きへ渡す。 */
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
            /** パス挿入後に使うMainのカーソル位置を保存する。 */
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  /** 単独で選ばれたパスを、複数選択と同じ扱いで下書きに挿入する。 */
  const insertReferencePath = (selectedPath: string) => {
    insertReferencePaths([selectedPath]);
  };

  /** 貼り付けファイルの保存結果から得た参照を、現在の入力欄に追加する。 */
  const insertPastedAttachments = (references: ComposerReferenceInput[]) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea =
      currentComposerOwner.current === composerOwner
        ? composerTextareaRef.current
        : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
    applyComposerReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: composerRegistry.get(composerOwner).selection.start,
      references,
      textarea,
      /** 貼り付け後の本文と選択位置を、操作対象の下書きに反映する。 */
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
            /** 添付後の選択開始位置を、Main入力欄のカーソル参照にも残す。 */
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  /** 指定のファイルまたはフォルダーの選択画面を開き、戻ったときも入力可能ならパスを扱う。 */
  const pickAndInsertPath = async (kind: ComposerPathPickerKind) => {
    if (
      composerRegistry.isFrozen ||
      !withmateApi ||
      isSelectedSessionReadOnly ||
      isAuxiliaryTargetUnavailable
    ) {
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
      /** 選択画面が返したパスを、下書きの参照として挿入する。 */
      insertReferencePath: (path) => insertReferencePath(path),
    });
  };

  /** 選択した外部ファイルをMainのセッションファイルへコピーし、保存先のパスを下書きに挿入する。 */
  const handleAddToSessionFiles = async () => {
    if (
      composerRegistry.isFrozen ||
      !withmateApi ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      isAuxiliaryTargetUnavailable
    ) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickFiles(
      pickerBaseDirectory || selectedSession.workspacePath || null,
    );
    if (composerRegistry.isFrozen || selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(
      selectedSession.id,
      selectedPaths,
    );
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

  /** Mainのセッションファイルから選んだ既存ファイルを、コピーせず下書きから参照する。 */
  const handlePickSessionFiles = async () => {
    if (
      composerRegistry.isFrozen ||
      !withmateApi ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      isAuxiliaryTargetUnavailable
    ) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickSessionFiles(
      selectedSession.id,
    );
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

  /** Mainのセッションファイル領域から選んだフォルダーを下書きに参照として挿入する。 */
  const handlePickSessionFolder = async () => {
    if (
      composerRegistry.isFrozen ||
      !withmateApi ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      isAuxiliaryTargetUnavailable
    ) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionFolder(
      selectedSession.id,
    );
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

  /** Mainのセッションファイル領域から画像を一つ選び、選択されたパスを下書きに挿入する。 */
  const handlePickSessionImage = async () => {
    if (
      composerRegistry.isFrozen ||
      !withmateApi ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      isAuxiliaryTargetUnavailable
    ) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionImageFile(
      selectedSession.id,
    );
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

  const { confirmReplacement, replacementDialog, notifyReuse, reuseNotice } =
    usePastedFileReplacement(
      activeRunSessionId,
      !composerRegistry.isFrozen &&
        !isSelectedSessionReadOnly &&
        !isAuxiliaryTargetUnavailable,
    );
  const handleComposerPaste = createPastedSessionAttachmentHandler({
    /** 貼り付けた添付ファイルを処理できなかった理由を利用者に知らせる。 */
    alertError: (message) => window.alert(message),
    /** デスクトップAPIと編集可能な入力先が揃う場合だけ、ファイルの貼り付けを扱う。 */
    canPaste: () => {
      return (
        !!withmateApi &&
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isAuxiliaryTargetUnavailable &&
        !isSelectedSessionReadOnly
      );
    },
    currentTimestampLabel,
    fallbackErrorMessage: "Could not save the pasted file.",
    /** クリップボードの項目が既存ファイルに裏付けられているかをデスクトップAPIで調べる。 */
    isFileBacked: (file) => withmateApi!.isClipboardFileBacked(file),
    /** 保存を実行する時点でも、入力欄が閉じかけておらず貼り付け先が同じか確認する。 */
    getSavePastedSessionFile: () => {
      return withmateApi
        ? (request) => {
            if (composerRegistry.isFrozen)
              throw new Error(
                "Attachments cannot be added while the window is closing.",
              );
            if (composerOwnerRef.current !== activeRunSessionId)
              throw new Error("The attachment target has changed.");
            return withmateApi.savePastedSessionFile(request);
          }
        : null;
    },
    /** 貼り付けたファイルの保存先には、Auxiliary表示中も親のMainを使う。 */
    getSessionId: () => selectedSession?.id,
    insertAttachments: insertPastedAttachments,
    confirmReplacement,
    onReuse: notifyReuse,
  });

  /** 指定または選択したディレクトリを、読み込み済みの同じ世代のMainに追加する。 */
  const handleAddAdditionalDirectory = async (directoryPath?: string) => {
    await runPickedAdditionalDirectoryOperation({
      /** Mainの設定を変更できるときに限り、ディレクトリ選択を許す。 */
      canPickDirectory: () =>
        !!withmateApi &&
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isSelectedSessionReadOnly,
      /** 選択画面の開始地点を前回の場所と現在のワークスペースから求める。 */
      getPickerBaseDirectory: () =>
        resolveAdditionalDirectoryPickerBase(
          pickerBaseDirectory,
          selectedSession?.workspacePath,
        ),
      /** 直接指定されたパスまたは選択画面の結果を、対象のMainに結び付ける。 */
      pickDirectory: (initialPath) =>
        withmateApi && selectedSession
          ? selectAdditionalDirectoryPath({
              sessionId: selectedSession.id,
              directoryPath,
              initialPath,
              api: withmateApi,
            })
          : Promise.resolve(null),
      /** 選択中に対象が変わっていないことを確かめ、選択場所を記憶して追加要求を送る。 */
      applyPickedDirectory: async (selectedPath) => {
        if (composerRegistry.isFrozen || !selectedSession) {
          return;
        }
        const current = getCurrentMainSession();
        if (
          !current ||
          current.id !== selectedSession.id ||
          getSessionIncarnationId(current) !==
            getSessionIncarnationId(selectedSession)
        ) {
          throw new Error(
            "Wait for the conversation to load before changing this session.",
          );
        }
        applyPickedAdditionalDirectoryUiStateCommand({
          selectedPath,
          setPickerBaseDirectory,
        });
        await withmateApi!.changeSessionAdditionalDirectory({
          sessionId: current.id,
          incarnationId: getSessionIncarnationId(current),
          operation: "add",
          directoryPath: selectedPath,
        });
      },
    });
  };

  /** Mainの追加ディレクトリから指定のパスを外す。 */
  const handleRemoveAdditionalDirectory = async (directoryPath: string) => {
    await runAdditionalDirectoryRemovalOperation({
      directoryPath,
      /** 選択されたMainがあり、入力が凍結中でも読み取り専用でもない場合だけ解除を許す。 */
      canRemoveDirectory: () =>
        !!selectedSession &&
        !composerRegistry.isFrozen &&
        !isSelectedSessionReadOnly,
      /** 読み込み済みのMainが同じID・世代であることを確認して解除要求を送る。 */
      removeDirectory: async (targetPath) => {
        if (!selectedSession) {
          return false;
        }
        const current = getCurrentMainSession();
        if (
          !current ||
          current.id !== selectedSession.id ||
          getSessionIncarnationId(current) !==
            getSessionIncarnationId(selectedSession)
        ) {
          throw new Error(
            "Wait for the conversation to load before changing this session.",
          );
        }
        if (!withmateApi) return false;
        await withmateApi.changeSessionAdditionalDirectory({
          sessionId: current.id,
          incarnationId: getSessionIncarnationId(current),
          operation: "remove",
          directoryPath: targetPath,
        });
        return true;
      },
    });
  };

  const handleTitleInputKeyDown = createTitleInputKeyHandler({
    /** タイトル欄をキー操作で確定したときに、ヘッダーの保存処理を呼ぶ。 */
    saveTitle: () => void handleSaveTitle(),
    cancelTitleEdit: handleCancelTitleEdit,
  });

  /** Mainのターミナルをデスクトップで開き、開けなかった理由をダイアログに出す。 */
  const handleOpenSessionTerminal = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    try {
      await withmateApi.openSessionTerminal(selectedSession.id);
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Could not open the terminal.",
      );
    }
  };

  /** Mainのワークスペースをエクスプローラーで開き、結果を共通のパス操作通知へ渡す。 */
  const handleOpenSessionExplorer = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    showOpenPathFeedback(
      await resolveOpenPathFeedback(
        () => withmateApi.openPath(selectedSession.workspacePath),
        "Could not open Explorer.",
      ),
    );
  };

  const handleOpenSessionFilesTerminal = createSessionFilesOpenHandler({
    /** セッションファイル用ターミナルの起点を決めるMainのID。 */
    getSessionId: () => selectedSession?.id,
    /** ワークスペースではなくセッションファイル領域を開くターミナル操作を返す。 */
    getOpenSessionFiles: () =>
      withmateApi
        ? (sessionId) => withmateApi.openSessionFilesTerminal(sessionId)
        : null,
    /** セッションファイル領域でターミナルを開けなかった理由を知らせる。 */
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "Could not open the Session files terminal.",
  });

  const handleOpenSessionFilesExplorer = createSessionFilesOpenHandler({
    /** エクスプローラーに表示するセッションファイル領域を、選択したMainのIDで指定する。 */
    getSessionId: () => selectedSession?.id,
    /** デスクトップAPIがあるとき、セッションファイル領域を開く操作を返す。 */
    getOpenSessionFiles: () =>
      withmateApi
        ? (sessionId) => withmateApi.openSessionFilesDirectory(sessionId)
        : null,
    /** セッションファイル領域をエクスプローラーに表示できなかった理由を知らせる。 */
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "Could not open the Session files directory.",
  });

  const pendingRunIndicatorAnnouncement =
    activeCancellationState || isActiveCancelRequested
      ? activeCancellationState === "terminating"
        ? "Waiting for the run to stop"
        : "Canceling run"
      : isApprovalRequestPending || isBlockingElicitationRequestPending
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
    ? activeAuxiliarySession.runState === "running" ||
      !!activeCancellationState ||
      isActiveCancelRequested
    : isSelectedSessionRunning;

  const renderedSession = displayedSession;
  const renderedMessages = displayedMessages;
  /** テンプレートワークスペースを開く前に中央表示を切り替え、挿入先となる下書きの選択範囲を記録する。 */
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
    const fallbackCaret = activeAuxiliarySession
      ? composerCaret
      : mainComposerCaretRef.current;
    promptTemplateSelectionRef.current = {
      start: textarea?.selectionStart ?? fallbackCaret,
      end: textarea?.selectionEnd ?? fallbackCaret,
    };
    closeFilePreviews();
    setIsPromptTemplateWorkspaceOpen(true);
  };
  /** テンプレート本文を記録済みの選択範囲に挿入し、中央プレビューを閉じて同じ入力先へ戻る。 */
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
        /** 挿入後の位置を、後でMain入力欄に戻るときにも使えるようにする。 */
        syncMainComposerCaret: (caret) => {
          mainComposerCaretRef.current = caret;
        },
        /** 新しい本文を入力した時点で、古い送信ブロックの強制表示を解除する。 */
        clearFeedback: () => setForceComposerBlockedFeedback(false),
      });
    }
    closeCentralPreview();
    window.requestAnimationFrame(() => {
      if (composerOwnerRef.current === activeRunSessionId) {
        restoreComposerTextareaFocusAndCaret(
          composerTextareaRef.current,
          insertion.caret,
        );
      }
    });
  };
  if (!desktopRuntime) {
    return (
      <ChatWindowStatusScreen message="Open the Session Window from Electron." />
    );
  }

  if (!selectedSession || !renderedSession || !selectedSessionCharacter) {
    if (selectedId && mainSessionRuntime.readStatus !== "ready") {
      const error = sessionSummaryRead.error || mainSessionRuntime.readError;
      return (
        <ChatWindowStatusScreen message="">
          {error ? (
            <LoadError
              message={error}
              onRetry={() => {
                sessionSummaryRead.retry();
                mainSessionRuntime.retryRead();
              }}
            />
          ) : (
            <LoadingIndicator label="Loading session" />
          )}
        </ChatWindowStatusScreen>
      );
    }
    return (
      <ChatWindowStatusScreen message="No session is selected. Open a session from the Home Window." />
    );
  }

  const canInsertFileTreePathReference = activeAuxiliarySession
    ? !composerBlockedReason
    : !isComposerDisabled;
  const fileExplorerPane = (
    <div ref={setFilesPaneHost} className="session-feature-host" />
  );
  const conversationTargetLabel = activeAuxiliarySession
    ? activeAuxiliarySession.title.trim()
      ? `Aux · ${activeAuxiliarySession.title}`
      : "Aux"
    : "Main";
  const conversationAttention: ConversationAttention = {
    targetLabel: conversationTargetLabel,
    entries: resolveConversationAttentionEntries({
      sessionId: activeRunSessionId,
      approvalRequestId,
      blockingElicitationRequestIds,
      optionalElicitationRequestIds,
      hasUnreadMessages:
        previewChatActivity.hasUnreadMessages &&
        previewChatActivity.ownerSessionId === activeRunSessionId,
    }),
    isConversationHidden,
    /** 承認依頼や未読の案内から、中央表示の閉鎖ガードを通して会話へ戻る。 */
    onShowConversation: () => {
      requestCentralSurfaceClose();
    },
  };
  const filePreviewContent =
    isPromptTemplateWorkspaceOpen && withmateApi ? (
      <PromptTemplateWorkspace
        api={withmateApi}
        canInsert={
          !isComposerFrozen &&
          (activeAuxiliarySession
            ? !composerBlockedReason
            : !isComposerDisabled)
        }
        onRegisterCloseGuard={registerPromptTemplateCloseGuard}
        onBack={closeCentralPreview}
        onInsert={handleInsertPromptTemplate}
      />
    ) : isFilePreviewActive ? (
      <div ref={setFilesPreviewHost} className="session-feature-host" />
    ) : undefined;

  const localPrHeaderAction =
    !isSelectedSessionReadOnly &&
    isSelectedWorkspaceAvailable &&
    selectedSession.sessionKind === "default" &&
    withmateApi ? (
      <div className="session-window-control-group session-local-pr-entry">
        <button
          type="button"
          className="drawer-toggle compact secondary"
          aria-label="Pull Requests"
          disabled={localPrOpening}
          aria-busy={localPrOpening || undefined}
          onClick={() => {
            setLocalPrError("");
            setLocalPrOpening(true);
            void withmateApi
              .openLocalPrWindow({
                kind: "main",
                sessionId: selectedSession.id,
                incarnationId: getSessionIncarnationId(selectedSession),
              })
              .catch((cause: unknown) =>
                setLocalPrError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setLocalPrOpening(false));
          }}
        >
          <ButtonContent busy={localPrOpening}>Pull Requests</ButtonContent>
        </button>
        {localPrError ? (
          <span role="alert" className="session-local-pr-entry-error">
            {localPrError}
          </span>
        ) : null}
      </div>
    ) : null;
  const chatHeaderFeature = sessionHeader.buildChatHeader({
    actions: localPrHeaderAction,
    isRunning: isSelectedSessionRunning,
    isReadOnly: isSelectedSessionReadOnly,
    isPinned: selectedSession.isPinned === true,
    isPinPending: isSessionPinPending,
    isAuxiliaryMode,
    isWorkspaceAvailable: isSelectedWorkspaceAvailable,
    /** セッションウィンドウ内の入力領域をターミナルに切り替える。 */
    onOpenSessionTerminal: () => {
      chatShellFeature.handleChangeActionDockMode("terminal");
    },
    /** 入力領域のターミナルとは別に、Mainのワークスペースのターミナルを開く。 */
    onOpenExternalTerminal: () => void handleOpenSessionTerminal(),
    /** セッションファイルの保存場所をエクスプローラーで開く。 */
    onOpenSessionFilesExplorer: () => void handleOpenSessionFilesExplorer(),
    /** セッションファイルの保存場所を起点にするターミナルを開く。 */
    onOpenSessionFilesTerminal: () => void handleOpenSessionFilesTerminal(),
    onTitleInputKeyDown: handleTitleInputKeyDown,
    /** ヘッダーの削除操作を、選択中のMainの削除手続きに委ねる。 */
    onDeleteSession: () => void handleDeleteSession(),
    /** ヘッダーのピン操作をMainの設定へ反映する。 */
    onToggleSessionPin: () => void handleToggleSessionPin(),
    /** ファイルの保存領域と区別して、Mainのワークスペースをエクスプローラーで開く。 */
    onOpenSessionExplorer: () => void handleOpenSessionExplorer(),
  });
  const chatComposerFeature = composerFeature.buildSurface({
    session: activeQueuedTurnEdit
      ? {
          ...renderedSession,
          ...activeQueuedTurnEdit.receipt.captured.request.executionOptions,
        }
      : renderedSession,
    canRemoveAdditionalDirectories: true,
    isCharacterAuthoringSession:
      renderedSession.sessionKind === "character-authoring",
    target: auxiliaryWorkspace.target,
    runtime: {
      isRunning:
        renderedIsRunning ||
        !!(activeAuxiliarySession ? auxiliaryStopTarget : mainStopTarget),
      canSendInput: !activeQueuedTurnEdit && canSendInput,
      queueTurnBusy: activeQueuedTurnEdit
        ? activeQueuedTurnEdit.phase === "beginning" ||
          activeQueuedTurnEdit.phase === "saving"
        : isInputSubmissionPending || hasPendingSubmitFor(renderedSession.id),
      hasUncertainTurn: hasUncertainTurnFor(renderedSession.id),
      inputAcceptanceError: !activeQueuedTurnEdit ? steeringError : undefined,
      inputError:
        activeQueuedTurnEdit?.error ||
        (!activeQueuedTurnEdit
          ? mainSessionRuntime.resendRecoveryError(
              renderedSession.id,
              getSessionIncarnationId(renderedSession),
            )
          : ""),
      isCanceling: !!activeCancellationState || isActiveCancelRequested,
      isAwaitingRunStop: !!activeCancellationState,
      selectedRunState: mainStopTarget ? "running" : selectedSessionRunState,
      auxiliaryRunState: auxiliaryStopTarget
        ? "running"
        : (activeAuxiliarySession?.runState ?? null),
      busyReason: composerBusyReason,
      blockedReason: sessionExecutionBlockedReason,
      isReadOnly:
        isSelectedSessionReadOnly ||
        (!activeAuxiliarySession && !loadedSession) ||
        appSettingsLoadStatus !== "loaded" ||
        modelCatalogLoadStatus !== "loaded",
      forceBlockedFeedback: forceComposerBlockedFeedback,
      isMessageListFollowing,
      isPromptTemplateWorkspaceOpen,
      providerCatalog: selectedProviderCatalog,
      models: modelOptions,
      modelAvailability: appSettings.modelAvailability,
      modelDiscoveryHasCache: Boolean(
        isSameModelCatalogWorkspace(
          modelCatalog?.workspacePath,
          renderedSession.workspacePath,
        ) && modelCatalog?.discovery?.[renderedSession.provider]?.fetchedAt,
      ),
      modelDiscoveryStatus:
        modelCatalog?.discovery?.[renderedSession.provider]?.status ??
        (modelCatalogLoadStatus === "error" ? "error" : "loading"),
      modelDiscoveryError:
        modelCatalog?.discovery?.[renderedSession.provider]?.error ??
        modelCatalogLoadError,
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
      /** ピッカーを開いたProviderのモデル探索を再取得し、通知や別ワークスペースの結果を古い応答で上書きしない。 */
      onModelPickerOpen: () => {
        if (!withmateApi) return;
        const workspacePath = renderedSession.workspacePath;
        const providerId = renderedSession.provider;
        const revision = ++modelCatalogRequestRevisionRef.current;
        void withmateApi
          .getModelCatalog({ providerId, workspacePath })
          .then((snapshot) => {
            if (modelCatalogRequestRevisionRef.current !== revision) return;
            if (
              snapshot &&
              isSameModelCatalogWorkspace(snapshot.workspacePath, workspacePath)
            ) {
              setModelCatalog((current) => {
                if (modelCatalogRequestRevisionRef.current !== revision)
                  return current;
                if (
                  !isSameModelCatalogWorkspace(
                    current?.workspacePath,
                    workspacePath,
                  )
                )
                  return snapshot;
                const discovery = snapshot.discovery?.[providerId];
                return current && discovery
                  ? {
                      ...current,
                      discovery: {
                        ...current.discovery,
                        [providerId]: discovery,
                      },
                    }
                  : (current ?? snapshot);
              });
            }
          })
          .catch((error: unknown) => {
            setModelCatalog((current) =>
              modelCatalogRequestRevisionRef.current === revision &&
              current &&
              isSameModelCatalogWorkspace(current.workspacePath, workspacePath)
                ? {
                    ...current,
                    discovery: {
                      ...current.discovery,
                      [providerId]: {
                        ...current.discovery?.[providerId],
                        status: "error",
                        error:
                          error instanceof Error
                            ? error.message
                            : "Could not load models.",
                      },
                    },
                  }
                : current,
            );
          });
      },
      send: {
        main: handleSend,
        auxiliary: handleSend,
        cancelMain: handleCancelRun,
        cancelAuxiliary: handleCancelAuxiliaryRun,
        input: handleSendInput,
        queue: handleSend,
        /** 今の表示先・世代に対する不明な送信の受付を、入力を再送せずに確認する。 */
        checkReceipt: () =>
          mainSessionRuntime.checkTurnReceipt(
            renderedSession.id,
            getSessionIncarnationId(renderedSession),
          ),
        /** 現在の表示先・世代で不明になった元の送信要求を再試行する。 */
        retryOriginal: () =>
          mainSessionRuntime.retryOriginalTurn(
            renderedSession.id,
            getSessionIncarnationId(renderedSession),
          ),
      },
      runtimeOptions: {
        /** 入力欄で選んだMainの実行設定を、保存が終わるまで待つ操作として渡す。 */
        runMain: async (option) => {
          await runMainRuntimeOption(option);
        },
        auxiliary: {
          session: activeAuxiliarySession,
          update: updateAuxiliaryExecutionOptions,
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
        /** Mainの入力変更を下書きに反映し、選択位置の同期とブロック理由の解除を行う。 */
        main: (value, selectionStart) => {
          applyComposerDraftChangeCommand({
            value,
            selectionStart,
            setDraft,
            setComposerCaret,
            /** 入力欄が切り替わっても使えるよう、Mainのカーソル位置を更新する。 */
            syncMainComposerCaret: (caret) => {
              mainComposerCaretRef.current = caret;
            },
            /** 編集された下書きに前回のブロック理由を強制表示し続けない。 */
            clearFeedback: () => setForceComposerBlockedFeedback(false),
          });
        },
        auxiliary: handleAuxiliaryDraftChange,
        /** 入力欄への貼り付けイベントを、セッションファイルの添付処理に渡す。 */
        paste: (event) => void handleComposerPaste(event),
        /** 入力欄がフォーカスされたら領域を展開し、フォーカス自体は移動し直さない。 */
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
        addAdditionalDirectory: handleAddAdditionalDirectory,
        removeAdditionalDirectory: handleRemoveAdditionalDirectory,
        expandActionDock: handleToggleActionDock,
        jumpToBottom: followMessageListLatest,
      },
      retryComposerSave: handleRetryAuxiliaryDraftSave,
    },
  });
  if (activeQueuedTurnEdit) {
    const busy = isQueuedTurnEditBusy(activeQueuedTurnEdit);
    chatComposerFeature.composer.isComposerDisabled ||= busy;
    chatComposerFeature.composer.queuedTurnEdit = {
      busy,
      canceling: activeQueuedTurnEdit.phase === "canceling",
      unavailable: activeQueuedTurnEdit.phase === "unavailable",
      /** 予約編集の確定を、現在の予約を更新する経路に渡す。 */
      onSubmit: () => void handleSend(),
      /** 予約編集を終了し、まだ同じ入力先であれば下書きの入力欄へフォーカスを戻す。 */
      onCancel: () => {
        const id = activeQueuedTurnEdit.receipt.sessionId;
        void queueEditor.cancel(id).then((ended) => {
          if (ended)
            requestAnimationFrame(() => {
              if (
                currentComposerOwner.current === normalComposerOwner ||
                currentComposerOwner.current === composerOwner
              )
                composerTextareaRef.current?.focus();
            });
        });
      },
    };
  }
  const chatConversationFeature = conversationFeature.buildSurface({
    sessionId: renderedSession.id,
    character: selectedSessionCharacter,
    messages: renderedMessages,
    isConversationVisible: !isConversationHidden,
    messageKeys: undefined,
    messageGroups: undefined,
    messageCollapseTargets: undefined,
    collapsedMessageKeys: undefined,
    messageJumpRequest: null,
    isRunning: renderedIsRunning,
    pendingRunIndicatorAnnouncement,
    pendingCancelSessionIds,
    liveApprovalRequest: null,
    approvalActionRequestId,
    liveElicitationRequest: null,
    elicitationActionRequestId,
    liveRunAssistantText: "",
    hasLiveRunAssistantText,
    liveRunErrorMessage,
    pendingMessageText,
    pendingMessageTextVisible: false,
    pendingMessageGroupId: resolvePendingAuxiliaryMessageGroupId(
      activeAuxiliarySession,
    ),
    isMessageListFollowing,
    messageListRef,
    onMessageListScroll: handleMessageListScroll,
    onToggleMessageBookmark: handleToggleMessageBookmark,
    /** Mainのメッセージ位置を指定して成果物の詳細を読み、デスクトップAPIがなければ空を返す。 */
    onLoadArtifactDetail: (messageIndex) =>
      Promise.resolve(
        withmateApi?.getSessionMessageArtifact(
          selectedSession.id,
          messageIndex,
        ) ?? null,
      ),
    /** 選択された成果物の差分を、Mainのテーマ色でプレビューする。 */
    onOpenDiff: (title, file) =>
      setSelectedDiff({
        title,
        file,
        themeColors: selectedSession.characterThemeColors,
      }),
    /** 会話上の承認判断を、その実行が待っている承認要求への応答として渡す。 */
    onResolveLiveApproval: (request, decision) =>
      void resolveLiveApproval(request, decision),
    /** 会話上で入力した回答を、実行中の対応する質問に返す。 */
    onResolveLiveElicitation: (request, response) =>
      void resolveLiveElicitation(request, response),
    onOpenPath: handleOpenInlinePath,
    onCopyMessageText: handleCopyMessageText,
    onQuoteMessageText: handleQuoteMessageText,
    glossaryAnnotationMatcher,
    onActivateGlossaryEntry: handleActivateGlossaryEntry,
  });
  const feedbackLastUserSeq =
    resolveRetrySource({
      sessionId: renderedSession.id,
      messages: renderedSession.messages,
      latestUserMessage: activeAuxiliarySession
        ? null
        : selectedSession.latestUserMessage,
      latestTurn: null,
      runState: "error",
    })?.userMessageSeq ?? null;
  const feedbackIncarnation =
    activeAuxiliarySession?.createdAt ??
    getSessionIncarnationId(selectedSession);
  const chatRuntimeFeature = buildSessionChatRuntimeFeature({
    recovery: {
      retryState,
      requestKey: retryRequestKey,
      targetLabel: activeAuxiliarySession
        ? activeAuxiliarySession.title.trim()
          ? `Aux · ${activeAuxiliarySession.title}`
          : "Aux"
        : "Main",
      latestTurnLoading: latestRecoveryTurn.loading,
      latestTurnError: latestRecoveryTurn.error,
      onRetryLatestTurn: latestRecoveryTurn.retry,
      isRetryActionDisabled,
      isRetryEditDisabled,
      isRetryDraftReplacePending,
      /** 直近依頼のリカバリー表示から、その本文を同じセッションへ再送する。 */
      onResendLastMessage: () => void handleResendLastMessage(),
      onEditLastMessage: handleEditLastMessage,
      onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
      onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
    },
    composerFeedback: {
      ...chatComposerFeature.composer.composerSendability,
      shouldShowFeedback:
        chatComposerFeature.composer.composerSendability.shouldShowFeedback &&
        !(
          auxiliaryWorkspace.target === "main" &&
          !loadedSession &&
          mainSessionRuntime.readError
        ) &&
        !(
          sessionExecutionBlockedReason &&
          (sessionExecutionBlockedReason === appSettingsLoadError ||
            sessionExecutionBlockedReason === modelCatalogLoadError)
        ),
    },
    workspaceAvailabilityMessage,
    isWorkspaceAvailabilityCheckPending,
    /** ワークスペースの利用可否チェックだけを再実行する。 */
    onRecheckWorkspaceAvailability: () => {
      setWorkspaceAvailabilityCheckRevision((current) => current + 1);
    },
    inlinePathFeedback:
      inlinePathError?.ownerSessionId === renderedSession.id
        ? inlinePathError.message
        : "",
    /** 表示中のセッションのパス操作エラーを消し、保留中の古い応答でも再表示しない。 */
    onDismissInlinePathFeedback: () => {
      inlinePathOperationRevisionRef.current.advance();
      setInlinePathError((current) =>
        current?.ownerSessionId === renderedSession.id ? null : current,
      );
    },
    executionOptionsFeedback:
      executionOptionsFeedback?.ownerId === renderedSession.id
        ? executionOptionsFeedback.message
        : "",
    /** 実行設定の保存失敗に対する現在の通知を閉じる。 */
    onDismissExecutionOptionsFeedback: () => setExecutionOptionsFeedback(null),
  });
  const sessionModals = (
    <ChatSessionModals
      selectedDiff={selectedDiff}
      selectedDiffThemeStyle={selectedDiffThemeStyle}
      onCloseDiff={() => setSelectedDiff(null)}
      onOpenDiffWindow={(payload) => void handleOpenDiffWindow(payload)}
    >
      {replacementDialog}
      {reuseNotice}
    </ChatSessionModals>
  );
  const chatShellSurface = chatShellFeature.buildSurface({
    terminalContent: withmateApi ? (
      <SessionTerminal
        ref={terminalRef}
        api={withmateApi}
        expanded={
          actionDockMode === "terminal" && chatShellFeature.isActionDockExpanded
        }
        onEmpty={() => chatShellFeature.handleChangeActionDockMode("prompt")}
      />
    ) : undefined,
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
  const settingsReadErrors: ChatErrorNotice[] = [];
  if (appSettingsLoadStatus === "error") {
    settingsReadErrors.push({
      id: "app-settings-read",
      message: `App settings could not be loaded: ${appSettingsLoadError}`,
      relatedControl: "composer",
      actionLabel: "Retry App Settings",
      /** 会話やモデルカタログを読み直さず、アプリ設定の初回取得だけをやり直す。 */
      onAction: () => {
        setAppSettingsLoadStatus("loading");
        setAppSettingsLoadError("");
        setAppSettingsReadRevision((revision) => revision + 1);
      },
    });
  }
  if (modelCatalogLoadStatus === "error") {
    settingsReadErrors.push({
      id: "model-catalog-read",
      message: `Model catalog could not be loaded: ${modelCatalogLoadError}`,
      relatedControl: "composer",
      actionLabel: "Retry Model Catalog",
      /** 会話やアプリ設定を読み直さず、モデルカタログの初回取得だけをやり直す。 */
      onAction: () => {
        setModelCatalogLoadStatus("loading");
        setModelCatalogLoadError("");
        setModelCatalogReadRevision((revision) => revision + 1);
      },
    });
  }
  const concurrentChats = auxiliaryWorkspace.buildConcurrentChats({
    mainSession: selectedSession,
    auxiliarySession: auxiliaryWorkspace.selectedSession
      ? selectedAuxiliaryRuntimeSession
      : null,
    api: withmateApi ?? undefined,
    messageColumn: {
      ...chatWindowProps.messageColumnProps,
      turnSubmissions: mainSessionRuntime.turnSubmissions,
      onTurnReceiptsObserved: observeTurnReceipts,
      selectedReplyKey: selectedReply?.key,
      onSelectReply:
        withmateApi?.readSessionExecution &&
        selectedSession.sessionKind === "default" &&
        !activeQueuedTurnEdit &&
        !isSelectedSessionReadOnly
          ? selectReply
          : undefined,
    },
    onToggleMessageBookmark: handleToggleMessageBookmark,
    /** Main会話の成果物は、入力欄の選択に関係なくMainのIDで読む。 */
    mainOnLoadArtifactDetail: (index) =>
      withmateApi?.getSessionMessageArtifact(selectedSession.id, index) ??
      Promise.resolve(null),
    /** Main会話から開いたパスの所有者には、入力先ではなくMainを使う。 */
    mainOnOpenPath: (target) =>
      handleOpenInlinePath(target, selectedSession.id),
    /** Auxiliary会話の成果物は、選択中の詳細の所有者を検証してから読み込む。 */
    auxiliaryOnLoadArtifactDetail: (index) =>
      loadOwnedAuxiliaryMessageArtifact({
        owner:
          auxiliaryWorkspace.selectedSession?.id ===
          auxiliaryWorkspace.selectedId
            ? auxiliaryWorkspace.selectedSession
            : null,
        /** 読み込み開始後も同じAuxiliaryを選んでいる場合に、その最新の詳細を返す。 */
        getCurrentOwner: () =>
          auxiliaryWorkspace.getCurrentSelectedId() ===
          auxiliaryWorkspace.selectedId
            ? auxiliaryBinding.getSession()
            : null,
        messageIndex: index,
        /** 検証済みのAuxiliaryのIDとメッセージ位置で成果物の詳細を問い合わせる。 */
        loadArtifact: (sessionId, messageIndex) =>
          withmateApi?.getSessionMessageArtifact(sessionId, messageIndex) ??
          Promise.resolve(null),
      }),
    /** Auxiliary会話から開いたパスを、選択中のAuxiliaryの操作として扱う。 */
    auxiliaryOnOpenPath: (target) =>
      handleOpenInlinePath(target, auxiliaryWorkspace.selectedId),
    onAddAuxiliary: handleOpenAuxiliaryLaunchDialog,
    isAddAuxiliaryDisabled:
      isSelectedSessionReadOnly || !isSelectedWorkspaceAvailable,
    scrollToLatestOnSend: appSettings.scrollToLatestOnSend,
  });
  concurrentChats.mainContentReady = loadedSession !== null;
  concurrentChats.onMainConversationView = onMainConversationView;
  concurrentChats.captureMessageListSendRef = captureMessageListSendRef;
  concurrentChats.mainReadFeedback = mainSessionRuntime.readError ? (
    <LoadError
      id="session-main-read-error"
      message={mainSessionRuntime.readError}
      onRetry={mainSessionRuntime.retryRead}
    />
  ) : !loadedSession ? (
    <LoadingIndicator
      className="concurrent-chat-state"
      label="Loading conversation"
    />
  ) : null;

  // フォーカス中の会話や実行中の Turn ではなく、ActionDock の対象を使う。
  const instructionTarget: SessionInstructionsTarget | null =
    !loadedSession || isSelectedSessionReadOnly
      ? null
      : auxiliaryWorkspace.target === "main"
        ? {
            kind: "main",
            sessionId: selectedSession.id,
            incarnationId: mainIncarnation,
          }
        : activeAuxiliarySession?.parentSessionId === selectedSession.id
          ? {
              kind: "auxiliary",
              sessionId: activeAuxiliarySession.id,
              incarnationId: activeAuxiliarySession.createdAt,
              mainSessionId: selectedSession.id,
              mainIncarnationId: mainIncarnation,
            }
          : null;

  return (
    <QueuedTurnEditContext.Provider
      value={
        withmateApi?.beginQueuedSessionTurnEdit
          ? { edits: queueEditor.edits, begin: handleBeginQueuedTurnEdit }
          : null
      }
    >
      <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
        <PreviewWheelZoomStepContext.Provider
          value={isAppSettingsLoaded ? appSettings.previewWheelZoomStep : null}
        >
          <FailedTurnRetryContext.Provider
            value={{
              /** 表示中の対象を再確認し、確定失敗したターンの再送に現在の実行設定を添える。 */
              submit: (request) => {
                setFailedRetryFeedback((current) =>
                  current?.ownerId === request.target.sessionId
                    ? null
                    : current,
                );
                const target =
                  request.target.sessionId === selectedSession.id
                    ? getCurrentMainSession()
                    : activeAuxiliarySession;
                if (!target || target.id !== request.target.sessionId)
                  return Promise.reject(
                    new Error("The selected conversation changed."),
                  );
                return mainSessionRuntime.submitFailedRetry({
                  ...request,
                  executionOptions: captureSessionExecutionOptions(target),
                });
              },
              // 保存済みの開始失敗は通常キューで受け付ける。実行中の Turn が止めるのは配送だけ。
              /** 受付不明・送信中・読み取り専用、または画面で扱っていないセッションへの再送を止める。 */
              blocked: (id) =>
                hasUncertainTurnFor(id) ||
                hasPendingSubmitFor(id) ||
                isSelectedSessionReadOnly ||
                (id !== selectedSession.id &&
                  id !== activeAuxiliarySession?.id),
              /** 受付確認を促すエラーと重複させず、再送失敗を対象のセッション・世代・依頼に紐付ける。 */
              onError: (ownerId, message, target) => {
                const owner =
                  ownerId === selectedSession.id
                    ? selectedSession
                    : activeAuxiliarySession;
                if (owner?.id === ownerId && !message.includes("Check Receipt"))
                  setFailedRetryFeedback({
                    ownerId,
                    incarnationId:
                      ownerId === selectedSession.id
                        ? getSessionIncarnationId(selectedSession)
                        : activeAuxiliarySession!.createdAt,
                    lastUserSeq:
                      resolveRetrySource({
                        sessionId: ownerId,
                        messages: owner.messages,
                        latestUserMessage:
                          ownerId === selectedSession.id
                            ? selectedSession.latestUserMessage
                            : null,
                        latestTurn: null,
                        runState: "error",
                      })?.userMessageSeq ?? null,
                    message: `Resend failed (${target}): ${message}`,
                  });
              },
            }}
          >
            <ChatWindow
              {...chatWindowProps}
              errorNotices={[
                ...(chatWindowProps.errorNotices ?? []),
                ...settingsReadErrors,
                ...(failedRetryFeedback?.ownerId === renderedSession.id &&
                failedRetryFeedback.incarnationId === feedbackIncarnation &&
                failedRetryFeedback.lastUserSeq === feedbackLastUserSeq
                  ? [
                      {
                        id: "failed-turn-retry",
                        message: failedRetryFeedback.message,
                        dismissLabel: "Dismiss resend error",
                        /** 現在の依頼に対応する再送失敗の通知を閉じる。 */
                        onDismiss: () => setFailedRetryFeedback(null),
                      },
                    ]
                  : []),
              ]}
              composerProps={{
                ...chatWindowProps.composerProps,
                sessionInstructionsControl:
                  withmateApi && instructionTarget ? (
                    <SessionInstructionsControl
                      key={JSON.stringify(instructionTarget)}
                      api={withmateApi}
                      target={instructionTarget}
                      title={
                        instructionTarget.kind === "main"
                          ? selectedSession.taskTitle
                          : activeAuxiliarySession?.title.trim() || "Auxiliary"
                      }
                    />
                  ) : null,
                replyUnavailableReason:
                  selectedReply && !selectedReply.reference
                    ? (selectedReply.error ?? "Loading the reply target.")
                    : undefined,
                externalErrorDescriptionIds:
                  auxiliaryWorkspace.target === "main" &&
                  !loadedSession &&
                  mainSessionRuntime.readError
                    ? "session-main-read-error"
                    : undefined,
              }}
              renderRightPane={(navigator, visible) => (
                <SessionContextFeature
                  ref={contextFeatureRef}
                  api={withmateApi}
                  selectedSession={selectedSession}
                  displayedSession={renderedSession}
                  activeRunSessionId={activeRunSessionId}
                  character={selectedSessionCharacter}
                  availableReasoningEfforts={availableReasoningEfforts}
                  renderedIsRunning={contextRenderedIsRunning}
                  onShowContextRail={handleShowContextRail}
                  navigator={navigator}
                  visible={visible}
                  onAnnotationMatcherChange={setGlossaryAnnotationMatcher}
                />
              )}
              rightPane={
                isAuxiliaryTargetUnavailable ? (
                  <div className="concurrent-chat-state" role="status">
                    {sessionExecutionBlockedReason}
                  </div>
                ) : (
                  chatWindowProps.rightPane
                )
              }
              headerProps={{
                ...chatWindowProps.headerProps,
                taskTitle: selectedSession.taskTitle,
                isRunning: isSelectedSessionRunning,
                isReadOnly: isSelectedSessionReadOnly || !loadedSession,
                showRenameButton: true,
                showDeleteButton: true,
              }}
              concurrentChats={concurrentChats}
              conversationAttention={conversationAttention}
              providerQuota={
                isAuxiliaryTargetUnavailable ? null : (
                  <ProviderQuota
                    key={renderedSession.provider}
                    api={withmateApi}
                    providerId={renderedSession.provider}
                  />
                )
              }
            />
          </FailedTurnRetryContext.Provider>
          <SessionFilesFeature
            ref={filesFeatureRef}
            api={withmateApi}
            activeRunSessionId={activeRunSessionId}
            prepareCentralSurfaceOpen={() =>
              prepareCentralSurfaceOpenRef.current()
            }
            workspacePath={selectedSession.workspacePath}
            additionalDirectories={selectedSession.allowedAdditionalDirectories}
            enabled={isSelectedWorkspaceAvailable}
            visible={
              Boolean(chatShellSurface.isLeftPaneVisible) &&
              !chatShellSurface.isSidePaneBudgetCollapsed
            }
            relatedSessionIds={[
              selectedSession.id,
              ...auxiliaryWorkspace.summaries.map((session) => session.id),
            ]}
            paneHost={filesPaneHost}
            previewHost={filesPreviewHost}
            composer={{
              canInsertPathReference: canInsertFileTreePathReference,
              insertReferencePaths,
            }}
            previewBindings={{
              onBack: closeCentralPreview,
              onCopyText: handleCopyMessageText,
              onQuoteText: handleQuoteMessageText,
            }}
            previewEnabled={!isPromptTemplateWorkspaceOpen}
            onPreviewActiveChange={setIsFilePreviewActive}
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
            checkingCreationResult={auxiliaryCreationStatus === "unknown"}
            cancelling={auxiliaryCreationCancelling}
            canCancelCreation={canCancelAuxiliaryLaunchCreation(
              auxiliaryCreationStatus,
            )}
            onClose={handleCloseAuxiliaryLaunchDialog}
            onCancelCreation={() => void handleCancelAuxiliaryCreation()}
            onSelectProvider={handleSelectAuxiliaryLaunchProvider}
            onStart={() => void handleStartAuxiliarySession()}
          />
        </PreviewWheelZoomStepContext.Provider>
      </ShortcutSettingsProvider>
    </QueuedTurnEditContext.Provider>
  );
}
