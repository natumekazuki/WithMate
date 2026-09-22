import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
  type SetStateAction,
} from "react";

import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type {
  DiscoveredCustomAgent,
  DiscoveredSkill,
  ComposerPreview,
} from "../../../src-shared/session/runtime-state.js";
import type {
  ModelCatalogItem,
  ModelCatalogProvider,
  ModelReasoningEffort,
} from "../../../src-shared/settings/model-catalog.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { AuxiliaryDraftPersistence } from "../auxiliary/use-auxiliary-draft-persistence.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
  ComposerSelection,
  ComposerSaveState,
} from "../composer-controller.js";
import { useSessionDraftFlushLifecycle } from "../runtime/use-session-draft-flush-lifecycle.js";
import {
  buildAuxiliaryAwareRuntimeOptionChangeHandler,
} from "../auxiliary-runtime-option-routing.js";
import { buildAuxiliaryAwareSendOrCancelHandler } from "../send-or-cancel.js";
import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryCodexSpeedChangeOperation,
  runAuxiliaryCodexReviewerChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../auxiliary/auxiliary-runtime-option-operation.js";
import {
  buildLiveSessionComposerDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionCompactActionDockProps,
  type LiveSessionComposerDockPropsInput,
} from "../chat-window-adapter.js";
import {
  buildAdditionalDirectoryItems,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "./session-composer-paths.js";
import {
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
} from "./session-composer-selection.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
} from "./session-composer-feedback.js";
import { buildRuntimeSelectionOptions } from "../../settings/runtime-selection-options.js";
import {
  applyComposerDraftClearCommand,
  buildOnDraftCompositionHandlers,
} from "../composer-draft-handlers.js";
import type { SessionComposerExpandedProps } from "./session-composer.js";
import type { ChatWindowProps } from "../chat-window.js";
import type { MainRuntimeOption } from "../runtime/main-session-mutation-operations.js";
import { createEmptyComposerPreview } from "./composer-preview-config.js";
import {
  createAgentPickerToggleHandler as createAgentPickerStateToggleHandler,
  createSkillPickerToggleHandler as createSkillPickerStateToggleHandler,
} from "../session-shell-handlers.js";

type SessionComposerOperation = () => void | Promise<void>;
type SessionComposerValueOperation<T> = (value: T) => void | Promise<void>;

export type SessionComposerFeatureBridge = {
  session: Session;
  isCharacterAuthoringSession: boolean;
  target: "main" | "auxiliary";
  runtime: {
    isRunning: boolean;
    selectedRunState: Session["runState"] | null;
    auxiliaryRunState: Session["runState"] | null;
    busyReason: string;
    blockedReason: string;
    isReadOnly: boolean;
    forceBlockedFeedback: boolean;
    pendingRunIndicatorAnnouncement?: string;
    pendingRunIndicatorText?: string;
    pendingRunIndicatorTextVisible?: boolean;
    isMessageListFollowing: boolean;
    isPromptTemplateWorkspaceOpen: boolean;
    chatNotice?: string;
    providerCatalog: ModelCatalogProvider | null | undefined;
    models: readonly ModelCatalogItem[];
    reasoningEfforts: readonly ModelReasoningEffort[];
  };
  resources: {
    availableCustomAgents: readonly DiscoveredCustomAgent[];
    availableSkills: readonly DiscoveredSkill[];
    isCustomAgentListLoading: boolean;
    isSkillListLoading: boolean;
    skillListError: string | null;
  };
  operations: {
    send: {
      main: SessionComposerOperation;
      auxiliary: SessionComposerOperation;
      cancelMain: SessionComposerOperation;
      cancelAuxiliary: SessionComposerOperation;
    };
    runtimeOptions: {
      runMain: (option: MainRuntimeOption) => void | Promise<void>;
      auxiliary: {
        session: AuxiliarySession | null;
        update: (recipe: (current: AuxiliarySession) => AuxiliarySession) => Promise<void>;
        catalogRevision: number | null;
        timestamp: () => string;
      };
    };
    customAgent: {
      main: SessionComposerValueOperation<DiscoveredCustomAgent | null>;
      auxiliary: SessionComposerValueOperation<DiscoveredCustomAgent | null>;
    };
    skill: {
      main: SessionComposerValueOperation<DiscoveredSkill>;
      auxiliary: SessionComposerValueOperation<DiscoveredSkill>;
    };
    draft: {
      main: (value: string, selectionStart: number) => void | Promise<void>;
      auxiliary: (value: string, selectionStart: number) => void | Promise<void>;
      paste?: ClipboardEventHandler<HTMLTextAreaElement>;
      focus: () => void;
    };
    files: {
      pick: (kind: ComposerPathPickerKind) => void | Promise<void>;
      addToSessionFiles?: SessionComposerOperation;
      pickSessionFiles?: SessionComposerOperation;
      pickSessionFolder?: SessionComposerOperation;
      pickSessionImage?: SessionComposerOperation;
    };
    layout: {
      beforeOpenSkillPicker?: () => boolean;
      openPromptTemplates?: SessionComposerOperation;
      addAdditionalDirectory: {
        main: SessionComposerOperation;
        auxiliary: SessionComposerOperation;
      };
      removeAdditionalDirectory: {
        main: (path: string) => void | Promise<void>;
        auxiliary: (path: string) => void | Promise<void>;
      };
      expandActionDock: () => void;
      jumpToBottom: () => void;
    };
    retryComposerSave?: SessionComposerOperation;
  };
};

export type SessionComposerFeatureSurface = {
  composer: ReturnType<typeof buildLiveSessionComposerDockProps>["composer"];
  compactActionDock: ReturnType<typeof buildLiveSessionComposerDockProps>["compactActionDock"];
  additionalDirectoryListProps: NonNullable<ChatWindowProps["additionalDirectoryListProps"]>;
  skillPickerProps: NonNullable<ChatWindowProps["skillPickerProps"]>;
  skillItems: NonNullable<ChatWindowProps["skillPickerProps"]>["items"];
  onSelectSkill: NonNullable<ChatWindowProps["skillPickerProps"]>["onSelectSkill"];
  onToggleSkillPicker: () => void;
  isSkillPickerOpen: boolean;
  isSkillListLoading: boolean;
  skillListError: string | null;
  additionalDirectoryItems: NonNullable<ChatWindowProps["additionalDirectoryListProps"]>["items"];
  isAdditionalDirectoryListOpen: boolean;
  onRemoveAdditionalDirectory: (path: string) => void;
  isComposerFrozen: boolean;
};

export type SessionComposerFeature = ReturnType<typeof useSessionComposerFeature>;

/**
 * Own the per-target composer state. The root supplies only the selected
 * owner and the existing persistence service; picker state, selection refs,
 * preview state, and the close-time flush lifecycle stay with the composer.
 */
export function useSessionComposerFeature(input: {
  api: WithMateWindowApi | null;
  composerRegistry: ComposerControllerRegistry;
  composerOwner: ComposerOwner;
  composerDraft: string;
  activeRunSessionId: string | null;
  selectedSessionId?: string | null;
  sessionProvider?: string | null;
  sessionWorkspacePath?: string;
  visibleRunState?: Session["runState"] | null;
  auxiliaryDraftPersistence: AuxiliaryDraftPersistence;
  setForceComposerBlockedFeedback: (value: boolean) => void;
}) {
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerOwnerRef = useRef<string | null>(null);
  const mainComposerCaretRef = useRef(0);
  const promptTemplateSelectionRef = useRef({ start: 0, end: 0 });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);

  composerOwnerRef.current = input.activeRunSessionId;
  const composerSnapshot = input.composerRegistry.get(input.composerOwner, input.composerDraft);
  useLayoutEffect(() => {
    input.composerRegistry.hydrateIfUnedited(input.composerOwner, input.composerDraft);
  }, [input.composerDraft, input.composerOwner, input.composerRegistry]);

  const composerState = {
    ...composerSnapshot,
    setDraft: (value: string, selection?: ComposerSelection) => input.composerRegistry.setDraft(input.composerOwner, value, selection),
    setSelection: (value: SetStateAction<ComposerSelection>) => input.composerRegistry.setSelection(input.composerOwner, value),
    setPreview: (value: ComposerPreview) => input.composerRegistry.setPreview(input.composerOwner, value),
    setImeComposing: (value: boolean) => input.composerRegistry.setImeComposing(input.composerOwner, value),
    setSaveState: (value: ComposerSaveState, error?: string | null) => input.composerRegistry.setSaveState(input.composerOwner, value, error),
    capture: () => input.composerRegistry.capture(input.composerOwner),
  };

  const isComposerFrozen = useSessionDraftFlushLifecycle({
    api: input.api,
    composerRegistry: input.composerRegistry,
    persistence: input.auxiliaryDraftPersistence,
  });
  const draft = composerState.draft;
  const setDraft = useCallback((update: SetStateAction<string>) => {
    const current = input.composerRegistry.get(input.composerOwner).draft;
    const next = typeof update === "function" ? update(current) : update;
    composerState.setDraft(next);
  }, [composerState.setDraft, input.composerOwner, input.composerRegistry]);
  const { preview: composerPreview, setPreview: setComposerPreview } = composerState;
  const composerCaret = composerState.selection.start;
  const setComposerCaret = useCallback((caret: number) => {
    composerState.setSelection({ start: caret, end: caret });
  }, [composerState.setSelection]);
  const getComposerDraft = useCallback(
    () => input.composerRegistry.get(input.composerOwner).draft,
    [input.composerOwner, input.composerRegistry],
  );
  const closeAgentPicker = useCallback(() => setIsAgentPickerOpen(false), []);
  const closeSkillPicker = useCallback(() => setIsSkillPickerOpen(false), []);

  const buildSurface = (bridge: SessionComposerFeatureBridge): SessionComposerFeatureSurface => {
    const isAuxiliaryTarget = bridge.target === "auxiliary";
    const selectedAgentName = bridge.session.customAgentName.trim().toLowerCase();
    const selectedCustomAgent = bridge.resources.availableCustomAgents.find(
      (agent) => agent.name.trim().toLowerCase() === selectedAgentName,
    ) ?? null;
    const selectedCustomAgentDisplay = buildSelectedCustomAgentDisplay(bridge.session, selectedCustomAgent);
    const canSelectCustomAgent = !bridge.isCharacterAuthoringSession && bridge.session.provider === "copilot";
    const customAgentItems: SessionComposerExpandedProps["customAgentItems"] = [
      {
        key: "default",
        value: null,
        primaryLabel: "DefaultAgent",
        secondaryLabel: "Use the default Copilot agent",
        title: "Do not use a custom agent",
        isSelected: !bridge.session.customAgentName,
      },
      ...bridge.resources.availableCustomAgents.map((agent) => {
        const display = buildCustomAgentMatchDisplay(agent);
        return {
          key: agent.id,
          value: agent.name,
          primaryLabel: display.primaryLabel,
          secondaryLabel: display.secondaryLabel,
          title: display.title,
          isSelected: bridge.session.customAgentName.trim().toLowerCase() === agent.name.trim().toLowerCase(),
        };
      }),
    ];
    const skillItems: NonNullable<ChatWindowProps["skillPickerProps"]>["items"] = bridge.resources.availableSkills.map((skill) => {
      const display = buildSkillMatchDisplay(skill);
      return {
        key: skill.id,
        skillId: skill.id,
        primaryLabel: display.primaryLabel,
        secondaryLabel: display.secondaryLabel,
        title: display.title,
        searchText: `${skill.name}\n${skill.description}`,
      };
    });
    const runtimeOptions = buildRuntimeSelectionOptions({
      providerId: bridge.session.provider,
      providerCatalog: bridge.runtime.providerCatalog,
      models: bridge.runtime.models,
      selectedModel: bridge.session.model,
      reasoningEfforts: bridge.runtime.reasoningEfforts,
      selectedApprovalMode: bridge.session.approvalMode,
      selectedCodexSandboxMode: bridge.session.codexSandboxMode,
      selectedCodexSpeed: bridge.session.codexSpeed,
      selectedCodexReviewer: bridge.session.codexReviewer,
    });
    const composerSendability = bridge.target === "auxiliary"
      ? buildComposerSendabilityState({
          runState: bridge.runtime.auxiliaryRunState,
          busyReason: bridge.runtime.busyReason,
          blockedReason: bridge.runtime.blockedReason,
          inputErrors: composerPreview.errors,
          draftText: getComposerDraft(),
        })
      : resolveComposerSendabilityState({
          runState: bridge.runtime.selectedRunState,
          busyReason: bridge.runtime.busyReason,
          blockedReason: bridge.runtime.blockedReason,
          inputErrors: composerPreview.errors,
          draftText: getComposerDraft(),
          forceBlockedFeedback: bridge.runtime.forceBlockedFeedback,
        });
    const isComposerDisabled = bridge.runtime.isReadOnly
      || !!bridge.runtime.blockedReason
      || composerSendability.isRunning;
    const onSendOrCancel = buildAuxiliaryAwareSendOrCancelHandler({
      shouldSendAuxiliary: isAuxiliaryTarget,
      isAuxiliarySessionRunning: bridge.runtime.auxiliaryRunState === "running",
      isSelectedSessionRunning: bridge.runtime.selectedRunState === "running",
      preferAuxiliarySendOverSelectedCancel: true,
      onCancelAuxiliaryRun: bridge.operations.send.cancelAuxiliary,
      onSendAuxiliary: bridge.operations.send.auxiliary,
      onCancelSelectedSessionRun: bridge.operations.send.cancelMain,
      onSendSelectedSession: bridge.operations.send.main,
    });
    const auxiliaryRuntime = bridge.operations.runtimeOptions.auxiliary;
    const onAuxiliaryApproval = (approvalMode: Session["approvalMode"]) => runAuxiliaryApprovalModeChangeOperation({
      approvalMode,
      updateActiveAuxiliarySession: auxiliaryRuntime.update,
      createTimestampLabel: auxiliaryRuntime.timestamp,
    });
    const onAuxiliarySandbox = (codexSandboxMode: Session["codexSandboxMode"]) => runAuxiliarySandboxModeChangeOperation({
      codexSandboxMode,
      updateActiveAuxiliarySession: auxiliaryRuntime.update,
      createTimestampLabel: auxiliaryRuntime.timestamp,
    });
    const onAuxiliarySpeed = (codexSpeed: Session["codexSpeed"]) => runAuxiliaryCodexSpeedChangeOperation({
      codexSpeed,
      updateActiveAuxiliarySession: auxiliaryRuntime.update,
      createTimestampLabel: auxiliaryRuntime.timestamp,
    });
    const onAuxiliaryReviewer = (codexReviewer: Session["codexReviewer"]) => {
      if (auxiliaryRuntime.session?.approvalMode === "never") {
        return;
      }
      return runAuxiliaryCodexReviewerChangeOperation({
        codexReviewer,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    };
    const onAuxiliaryModel = (model: string) => {
      if (!bridge.runtime.providerCatalog || auxiliaryRuntime.catalogRevision === null) {
        return;
      }
      return runAuxiliaryModelChangeOperation({
        model,
        providerCatalog: bridge.runtime.providerCatalog,
        catalogRevision: auxiliaryRuntime.catalogRevision,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    };
    const onAuxiliaryReasoning = (reasoningEffort: string) => {
      if (!bridge.runtime.providerCatalog || auxiliaryRuntime.catalogRevision === null || !auxiliaryRuntime.session) {
        return;
      }
      return runAuxiliaryReasoningEffortChangeOperation({
        reasoningEffort: reasoningEffort as Session["reasoningEffort"],
        providerCatalog: bridge.runtime.providerCatalog,
        catalogRevision: auxiliaryRuntime.catalogRevision,
        updateActiveAuxiliarySession: auxiliaryRuntime.update,
        createTimestampLabel: auxiliaryRuntime.timestamp,
      });
    };
    const onChangeApprovalMode = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliaryApproval,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "approval-mode", value }),
    });
    const onChangeCodexSandboxMode = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliarySandbox,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "codex-sandbox-mode", value }),
    });
    const onChangeCodexSpeed = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliarySpeed,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "codex-speed", value }),
    });
    const onChangeCodexReviewer = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliaryReviewer,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "codex-reviewer", value }),
    });
    const onChangeModel = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliaryModel,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "model", value }),
    });
    const onChangeReasoningEffort = buildAuxiliaryAwareRuntimeOptionChangeHandler({
      shouldUseAuxiliary: isAuxiliaryTarget,
      onAuxiliaryChange: onAuxiliaryReasoning,
      onSelectedSessionChange: (value) => bridge.operations.runtimeOptions.runMain({ kind: "reasoning-effort", value: value as ModelReasoningEffort }),
    });
    const onDraftChange = (value: string, selectionStart: number) => {
      if (isAuxiliaryTarget) {
        void bridge.operations.draft.auxiliary(value, selectionStart);
        return;
      }
      bridge.operations.draft.main(value, selectionStart);
    };
    const onSelectCustomAgent = (value: string | null) => {
      const agent = value
        ? bridge.resources.availableCustomAgents.find((entry) => entry.name === value) ?? null
        : null;
      void (isAuxiliaryTarget
        ? bridge.operations.customAgent.auxiliary(agent)
        : bridge.operations.customAgent.main(agent));
    };
    const onSelectSkill = (skillId: string) => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      const skill = bridge.resources.availableSkills.find((entry) => entry.id === skillId);
      if (!skill) {
        return;
      }
      void (isAuxiliaryTarget
        ? bridge.operations.skill.auxiliary(skill)
        : bridge.operations.skill.main(skill));
    };
    const toggleAgentPickerState = createAgentPickerStateToggleHandler({
      setAgentPickerOpen: setIsAgentPickerOpen,
      setSkillPickerOpen: setIsSkillPickerOpen,
    });
    const toggleAgentPicker = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      toggleAgentPickerState();
    };
    const toggleSkillPickerState = createSkillPickerStateToggleHandler({
      setAgentPickerOpen: setIsAgentPickerOpen,
      setSkillPickerOpen: setIsSkillPickerOpen,
    });
    const toggleSkillPicker = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      if (!isSkillPickerOpen && bridge.operations.layout.beforeOpenSkillPicker && !bridge.operations.layout.beforeOpenSkillPicker()) {
        return;
      }
      toggleSkillPickerState();
    };
    const toggleAdditionalDirectoryList = () => {
      if (input.composerRegistry.isFrozen) {
        return;
      }
      setIsAdditionalDirectoryListOpen((current) => !current);
    };
    const onAddAdditionalDirectory = () => {
      void (isAuxiliaryTarget
        ? bridge.operations.layout.addAdditionalDirectory.auxiliary()
        : bridge.operations.layout.addAdditionalDirectory.main());
    };
    const onRemoveAdditionalDirectory = (path: string) => {
      void (isAuxiliaryTarget
        ? bridge.operations.layout.removeAdditionalDirectory.auxiliary(path)
        : bridge.operations.layout.removeAdditionalDirectory.main(path));
    };
    const onDraftSelect = (selectionStart: number) => {
      if (!input.activeRunSessionId) {
        return;
      }
      const selectionEnd = composerTextareaRef.current?.selectionEnd ?? selectionStart;
      composerState.setSelection({ start: selectionStart, end: selectionEnd });
      if (!isAuxiliaryTarget) {
        mainComposerCaretRef.current = selectionStart;
      }
    };
    const onDraftComposition = buildOnDraftCompositionHandlers({
      setComposerCaret,
      setIsComposerImeComposing: (value) => composerState.setImeComposing(value),
      getSelectionStart: () => composerOwnerRef.current === input.activeRunSessionId
        ? composerTextareaRef.current?.selectionStart
        : composerCaret,
      getFallbackSelectionStart: () => draft.length,
      syncMainComposerCaret: !isAuxiliaryTarget
        ? (selectionStart) => {
            mainComposerCaretRef.current = selectionStart;
          }
        : undefined,
    });
    const isComposerBlockedFeedbackActive = bridge.runtime.forceBlockedFeedback
      && composerSendability.feedbackTone === "blocked";
    const sendButtonTitle = getComposerSendButtonTitle(composerSendability);
    const dock: LiveSessionComposerDockPropsInput = {
      canSelectCustomAgent,
      additionalDirectoryCount: bridge.session.allowedAdditionalDirectories.length,
      isRunning: bridge.runtime.isRunning,
      pendingRunIndicatorAnnouncement: bridge.runtime.pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText: bridge.runtime.pendingRunIndicatorText,
      pendingRunIndicatorTextVisible: bridge.runtime.pendingRunIndicatorTextVisible,
      composerBlocked: !!bridge.runtime.blockedReason,
      isAgentPickerOpen,
      isSkillPickerOpen,
      isPromptTemplateWorkspaceOpen: bridge.runtime.isPromptTemplateWorkspaceOpen,
      isAdditionalDirectoryListOpen,
      selectedCustomAgentLabel: canSelectCustomAgent ? selectedCustomAgentDisplay.label : "Agent",
      selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Select a Copilot custom agent",
      isMessageListFollowing: bridge.runtime.isMessageListFollowing,
      isCustomAgentListLoading: bridge.resources.isCustomAgentListLoading,
      customAgentItems,
      draft,
      composerController: {
        owner: input.composerOwner,
        registry: input.composerRegistry,
        initialDraft: input.composerDraft,
      },
      onRetryComposerSave: isAuxiliaryTarget && bridge.operations.retryComposerSave
        ? () => void bridge.operations.retryComposerSave?.()
        : undefined,
      composerTextareaRef,
      isComposerDisabled,
      isSendDisabled: composerSendability.isSendDisabled,
      composerSendability,
      forceComposerBlockedFeedback: bridge.runtime.forceBlockedFeedback,
      sendButtonTitle,
      isComposerBlockedFeedbackActive,
      approvalOptions: runtimeOptions.approvalChoiceOptions,
      selectedApprovalMode: bridge.session.approvalMode,
      reviewerOptions: runtimeOptions.reviewerSelectOptions,
      selectedCodexReviewer: bridge.session.codexReviewer,
      sandboxOptions: runtimeOptions.sandboxChoiceOptions,
      selectedCodexSandboxMode: bridge.session.codexSandboxMode,
      speedOptions: runtimeOptions.speedSelectOptions,
      selectedCodexSpeed: bridge.session.codexSpeed,
      modelOptions: runtimeOptions.modelSelectOptions,
      selectedModel: bridge.session.model,
      selectedModelFallbackLabel: runtimeOptions.selectedModelFallbackLabel,
      reasoningOptions: runtimeOptions.reasoningSelectOptions,
      selectedReasoningEffort: bridge.session.reasoningEffort,
      chatNotice: bridge.runtime.chatNotice,
      onPickFile: () => void bridge.operations.files.pick("file"),
      onPickFolder: () => void bridge.operations.files.pick("folder"),
      onPickImage: () => void bridge.operations.files.pick("image"),
      onAddToSessionFiles: bridge.operations.files.addToSessionFiles
        ? () => void bridge.operations.files.addToSessionFiles?.()
        : undefined,
      onPickSessionFiles: bridge.operations.files.pickSessionFiles
        ? () => void bridge.operations.files.pickSessionFiles?.()
        : undefined,
      onPickSessionFolder: bridge.operations.files.pickSessionFolder
        ? () => void bridge.operations.files.pickSessionFolder?.()
        : undefined,
      onPickSessionImage: bridge.operations.files.pickSessionImage
        ? () => void bridge.operations.files.pickSessionImage?.()
        : undefined,
      onToggleAgentPicker: toggleAgentPicker,
      onToggleSkillPicker: toggleSkillPicker,
      onOpenPromptTemplates: bridge.operations.layout.openPromptTemplates
        ? () => void bridge.operations.layout.openPromptTemplates?.()
        : undefined,
      onAddAdditionalDirectory,
      onToggleAdditionalDirectoryList: toggleAdditionalDirectoryList,
      onExpandActionDock: bridge.operations.layout.expandActionDock,
      onJumpToBottom: bridge.operations.layout.jumpToBottom,
      onSelectCustomAgent,
      onDraftChange,
      onDraftFocus: bridge.operations.draft.focus,
      onDraftKeyDown: undefined as KeyboardEventHandler<HTMLTextAreaElement> | undefined,
      onDraftPaste: bridge.operations.draft.paste,
      onDraftSelect,
      ...onDraftComposition,
      onSendOrCancel,
      onChangeApprovalMode,
      onChangeCodexReviewer,
      onChangeCodexSandboxMode,
      onChangeCodexSpeed,
      onChangeModel,
      onChangeReasoningEffort,
    };

    const dockSurface = buildLiveSessionComposerDockProps({
      ...dock,
      showCustomAgentPicker: canSelectCustomAgent,
      showSkillPicker: !bridge.isCharacterAuthoringSession,
      showPromptTemplateButton: true,
    });

    return {
      composer: buildLiveSessionComposerProps(dockSurface.composer),
      compactActionDock: buildLiveSessionCompactActionDockProps(dockSurface.compactActionDock),
      additionalDirectoryListProps: {
        isOpen: isAdditionalDirectoryListOpen,
        items: buildAdditionalDirectoryItems(
          bridge.session.allowedAdditionalDirectories,
          bridge.session.provider === "codex",
        ),
        isInteractionDisabled:
          bridge.runtime.isRunning
          || !!bridge.runtime.blockedReason
          || isComposerFrozen,
        onRemove: onRemoveAdditionalDirectory,
      },
      skillPickerProps: {
        isOpen: !bridge.isCharacterAuthoringSession && isSkillPickerOpen,
        isInteractionDisabled: isComposerFrozen,
        isLoading: bridge.resources.isSkillListLoading,
        errorMessage: bridge.resources.skillListError,
        items: skillItems,
        onSelectSkill,
        onDismiss: toggleSkillPicker,
      },
      skillItems,
      onSelectSkill,
      onToggleSkillPicker: toggleSkillPicker,
      isSkillPickerOpen,
      isSkillListLoading: bridge.resources.isSkillListLoading,
      skillListError: bridge.resources.skillListError,
      additionalDirectoryItems: buildAdditionalDirectoryItems(
        bridge.session.allowedAdditionalDirectories,
        bridge.session.provider === "codex",
      ),
      isAdditionalDirectoryListOpen,
      onRemoveAdditionalDirectory,
      isComposerFrozen,
    };
  };

  useLayoutEffect(() => {
    const selection = composerState.selection;
    composerTextareaRef.current?.setSelectionRange(selection.start, selection.end);
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
    setIsAdditionalDirectoryListOpen(false);
    input.setForceComposerBlockedFeedback(false);
    composerState.setImeComposing(false);
  }, [input.activeRunSessionId]);

  useLayoutEffect(() => {
    applyComposerDraftClearCommand({
      setDraft,
      setComposerCaret,
      syncMainComposerCaret: (selectionStart) => {
        mainComposerCaretRef.current = selectionStart;
      },
      nextCaret: 0,
    });
    setComposerPreview(createEmptyComposerPreview());
    setPickerBaseDirectory(input.sessionWorkspacePath ?? "");
    composerState.setImeComposing(false);
    input.setForceComposerBlockedFeedback(false);
  }, [input.selectedSessionId, input.sessionProvider]);

  useLayoutEffect(() => {
    if (input.visibleRunState !== "running") {
      return;
    }
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
  }, [input.visibleRunState]);

  return {
    composerState,
    composerSnapshot,
    composerTextareaRef,
    composerOwnerRef,
    mainComposerCaretRef,
    promptTemplateSelectionRef,
    composerDraft: input.composerDraft,
    draft,
    setDraft,
    composerPreview,
    setComposerPreview,
    composerCaret,
    setComposerCaret,
    getComposerDraft,
    isComposerFrozen,
    pickerBaseDirectory,
    setPickerBaseDirectory,
    isAgentPickerOpen,
    setIsAgentPickerOpen,
    closeAgentPicker,
    isSkillPickerOpen,
    setIsSkillPickerOpen,
    closeSkillPicker,
    isAdditionalDirectoryListOpen,
    setIsAdditionalDirectoryListOpen,
    buildSurface,
  };
}
