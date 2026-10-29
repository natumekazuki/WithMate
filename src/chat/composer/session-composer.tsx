import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";

import { ButtonContent } from "../../ui/button-content.js";
import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";
import { getApprovalReviewerOptionsForProvider } from "../../../src-shared/settings/provider-runtime-options.js";
import type { ConfirmedReviewerChange } from "../../../src-shared/session/session-mutation-contract.js";

import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import { isCodexReviewerControlDisabled, type CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";

import { useShortcutSettings } from "../../settings/shortcut-settings-context.js";

import { ComposerAttachmentMenu } from "../../chat/composer-attachment-menu.js";
import { AdditionalDirectoryPathControl } from "./additional-directory-path-control.js";
import type { WorkspaceDirectoryValidationResult } from "../../../src-shared/window/workspace-directory-validation.js";
import { ComposerIcon } from "./composer-icon.js";
import { ComposerErrorDetails } from "./composer-error-details.js";
import { ComposerSettingSelect } from "./composer-setting-select.js";
import { ModelPicker } from "./model-picker.js";
import { CustomAgentPicker, type SessionCustomAgentItem } from "./custom-agent-picker.js";
import type { ModelSelectOption } from "../../settings/model-select-options.js";
import type { ModelCatalogItem } from "../../../src-shared/settings/model-catalog.js";
import { useComposerController, type ComposerControllerRegistry, type ComposerOwner } from "../../chat/composer-controller.js";
import {
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
} from "./session-composer-feedback.js";

import { appendShortcutLabel, SHORTCUT_COMMAND_IDS } from "../../settings/shortcut-registry.js";


export type SessionSelectOption = {
  value: string;
  label: string;
  sourceLabel?: string;
  disabled?: boolean;
};

export type SessionSkillItem = {
  key: string;
  skillId: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  searchText?: string;
};

type SessionComposerSendabilityView = {
  isBusy?: boolean;
  busyReason?: string;
  primaryFeedback: string;
  secondaryFeedback: string[];
  feedbackTone: "blocked" | "helper" | null;
  shouldShowFeedback: boolean;
};

export type SessionComposerExpandedProps = {
  isActive?: boolean;
  directoryScopeLabel?: string;
  composerController?: { owner: ComposerOwner; registry: ComposerControllerRegistry; initialDraft?: string };
  onRetryComposerSave?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  canSendInput?: boolean;
  onSendInput?: () => void;
  onQueueTurn?: () => void;
  queueTurnBusy?: boolean;
  turnRecoveryAction?: "check" | "retry";
  turnRecoveryError?: string;
  onCheckTurnReceipt?: () => void;
  onRetryOriginalTurn?: () => void;
  submissionError?: string;
  targetDock?: ReactNode;
  recoveryActions?: ReactNode;
  dockModeSwitch?: ReactNode;
  providerQuota?: ReactNode;
  chatNotice?: string;
  composerBlocked: boolean;
  canSelectCustomAgent: boolean;
  showAttachmentControls?: boolean;
  showCustomAgentPicker?: boolean;
  showSkillPicker?: boolean;
  showPromptTemplateButton?: boolean;
  showAdditionalDirectoryControls?: boolean;
  showExecutionModeControls?: boolean;
  showMessageViewModeControls?: boolean;
  messageViewMode?: MessageViewMode;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
  isPromptTemplateWorkspaceOpen?: boolean;
  isAdditionalDirectoryListOpen: boolean;
  selectedCustomAgentLabel: string;
  selectedCustomAgentTitle: string;
  additionalDirectoryCount: number;
  showJumpToBottom: boolean;
  isCustomAgentListLoading: boolean;
  customAgentItems: SessionCustomAgentItem[];
  draft: string;
  placeholder?: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  skillButtonRef?: RefObject<HTMLButtonElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerSendabilityView;
  forceComposerBlockedFeedback?: boolean;
  externalErrorDescriptionIds?: string;
  sendButtonTitle?: string;
  isComposerBlockedFeedbackActive: boolean;
  approvalOptions: Array<{ value: ApprovalMode; label: string; disabled?: boolean }>;
  providerId?: string;
  runtimeSelectionIdentity?: string;
  selectedApprovalMode: ApprovalMode;
  reviewerOptions: Array<{ value: CodexReviewer; label: string; disabled?: boolean }>;
  selectedCodexReviewer: CodexReviewer;
  sandboxOptions: Array<{ value: CodexSandboxMode; label: string }>;
  selectedCodexSandboxMode: CodexSandboxMode;
  speedOptions: Array<{ value: CodexSpeed; label: string }>;
  selectedCodexSpeed: CodexSpeed;
  modelOptions: ModelSelectOption[];
  modelDiscoveryStatus?: "idle" | "loading" | "ready" | "error";
  modelDiscoveryError?: string;
  modelDiscoveryHasCache?: boolean;
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: SessionSelectOption[];
  selectedReasoningEffort: string;
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  onAddToSessionFiles?: () => void;
  onPickSessionFiles?: () => void;
  onPickSessionFolder?: () => void;
  onPickSessionImage?: () => void;
  onToggleAgentPicker: () => void;
  onCloseAgentPicker?: () => void;
  onToggleSkillPicker: () => void;
  onOpenPromptTemplates?: () => void;
  onAddAdditionalDirectory: (directoryPath?: string) => void | Promise<void>;
  onValidateAdditionalDirectory: (directoryPath: string) => Promise<WorkspaceDirectoryValidationResult>;
  onToggleAdditionalDirectoryList: () => void;
  onJumpToBottom: () => void;
  onSelectCustomAgent: (value: string | null) => void;
  onDraftChange: (value: string, selectionStart: number) => void;
  onDraftFocus: () => void;
  onDraftKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onChangeApprovalMode: (value: ApprovalMode, confirmedReviewerChange?: ConfirmedReviewerChange) => void;
  onChangeCodexReviewer: (value: CodexReviewer) => void;
  onChangeCodexSandboxMode: (value: CodexSandboxMode) => void;
  onChangeCodexSpeed: (value: CodexSpeed) => void;
  onChangeModel: (model: ModelCatalogItem) => void;
  onModelPickerOpen?: () => void;
  onChangeReasoningEffort: (value: string) => void;
  onMessageViewModeChange?: (mode: MessageViewMode) => void;
};

export function SessionComposerExpanded({
  isActive = true,
  composerController,
  onRetryComposerSave,
  isRunning,
  isCanceling = false,
  canSendInput = false,
  onSendInput,
  onQueueTurn,
  queueTurnBusy = false,
  turnRecoveryAction,
  turnRecoveryError,
  onCheckTurnReceipt,
  onRetryOriginalTurn,
  submissionError,
  targetDock = null,
  recoveryActions = null,
  dockModeSwitch = null,
  providerQuota = null,
  chatNotice,
  composerBlocked,
  canSelectCustomAgent,
  showAttachmentControls = true,
  showCustomAgentPicker = true,
  showSkillPicker = true,
  showPromptTemplateButton = false,
  showAdditionalDirectoryControls = true,
  showExecutionModeControls = true,
  showMessageViewModeControls = false,
  messageViewMode = "preview",
  isAgentPickerOpen,
  isSkillPickerOpen,
  isPromptTemplateWorkspaceOpen = false,
  isAdditionalDirectoryListOpen,
  selectedCustomAgentLabel,
  selectedCustomAgentTitle,
  additionalDirectoryCount,
  showJumpToBottom,
  isCustomAgentListLoading,
  customAgentItems,
  draft,
  placeholder,
  composerTextareaRef,
  skillButtonRef,
  isComposerDisabled,
  isSendDisabled,
  composerSendability,
  forceComposerBlockedFeedback = false,
  externalErrorDescriptionIds,
  sendButtonTitle,
  isComposerBlockedFeedbackActive,
  approvalOptions,
  providerId,
  runtimeSelectionIdentity,
  selectedApprovalMode,
  reviewerOptions = [],
  selectedCodexReviewer = "user",
  sandboxOptions,
  selectedCodexSandboxMode,
  speedOptions = [],
  selectedCodexSpeed = "standard",
  modelOptions,
  modelDiscoveryStatus,
  modelDiscoveryError,
  modelDiscoveryHasCache,
  selectedModel,
  selectedModelFallbackLabel,
  reasoningOptions,
  selectedReasoningEffort,
  onPickFile,
  onPickFolder,
  onPickImage,
  onAddToSessionFiles = () => {},
  onPickSessionFiles = () => {},
  onPickSessionFolder = () => {},
  onPickSessionImage = () => {},
  onToggleAgentPicker,
  onCloseAgentPicker = onToggleAgentPicker,
  onToggleSkillPicker,
  onOpenPromptTemplates = () => {},
  onAddAdditionalDirectory,
  directoryScopeLabel,
  onValidateAdditionalDirectory,
  onToggleAdditionalDirectoryList,
  onJumpToBottom,
  onSelectCustomAgent,
  onDraftChange,
  onDraftFocus,
  onDraftKeyDown,
  onDraftPaste,
  onDraftSelect,
  onDraftCompositionStart,
  onDraftCompositionEnd,
  onSendOrCancel,
  onChangeApprovalMode,
  onChangeCodexReviewer = () => {},
  onChangeCodexSandboxMode,
  onChangeCodexSpeed = () => {},
  onChangeModel,
  onModelPickerOpen,
  onChangeReasoningEffort,
  onMessageViewModeChange = () => {},
}: SessionComposerExpandedProps) {
  const keyboardShortcuts = useShortcutSettings();
  const controllerOwner = composerController?.owner ?? { kind: "main" as const, id: "__legacy__" };
  const composerControllerState = useComposerController(
    controllerOwner,
    composerController?.initialDraft ?? draft,
    composerController?.registry,
  );
  const displayedDraft = composerController ? composerControllerState.draft : draft;
  const composerFrozen = composerController?.registry.isFrozen === true;
  const composerSaveFailed = composerControllerState.saveState === "error";
  const canQueueTurn = isRunning && !!onQueueTurn;
  const composerControlsDisabled = !isActive || composerBlocked || composerFrozen || (isRunning && !canQueueTurn);
  const turnRecoveryBusyReason = turnRecoveryAction === "check" ? "Checking turn acceptance."
    : turnRecoveryAction === "retry" ? "Retrying the original turn." : "";
  const projectedComposerSendability = composerController
    ? resolveComposerSendabilityState({
        runState: isRunning ? "running" : "idle",
        canSendInput: !canQueueTurn && canSendInput && !isCanceling,
        canQueueTurn,
        busyReason: turnRecoveryBusyReason || (queueTurnBusy ? "Message submission is in progress." : composerSendability.busyReason),
        blockedReason: composerBlocked ? (composerSendability.primaryFeedback ?? "") : "",
        inputErrors: composerControllerState.preview.errors,
        draftText: displayedDraft,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      })
    : null;
  const resolvedComposerSendability = projectedComposerSendability ?? composerSendability;
  const displayedComposerSendability = resolvedComposerSendability;
  const errorOwnerKey = `${controllerOwner.kind}:${controllerOwner.id}`;
  const displayedIsSendDisabled = composerController
    ? isComposerDisabled || projectedComposerSendability!.isSendDisabled || composerSaveFailed || !!onCheckTurnReceipt
    : isComposerDisabled || isSendDisabled || composerSaveFailed || !!onCheckTurnReceipt;
  const displayedSendButtonTitle = composerSaveFailed
    ? "Draft could not be saved. Retry before sending."
    : projectedComposerSendability
      ? getComposerSendButtonTitle(projectedComposerSendability)
      : sendButtonTitle;
  const showBusySendState = !turnRecoveryAction && (queueTurnBusy || ((!isRunning || canSendInput || canQueueTurn) && displayedComposerSendability.isBusy === true));
  const sendDisabled = (isRunning && !canSendInput && !canQueueTurn) || (isCanceling && !canQueueTurn)
    || displayedIsSendDisabled || composerBlocked || composerFrozen || queueTurnBusy || !!turnRecoveryAction;
  const sendDisabledReason = composerFrozen
    ? "Input is frozen while the window is closing."
    : turnRecoveryAction === "check"
      ? "Checking turn acceptance."
      : turnRecoveryAction === "retry"
        ? "Retrying the original turn."
        : onCheckTurnReceipt
          ? "Turn acceptance is unknown. Check Receipt or Retry Original Turn before sending."
          : (isRunning && !canSendInput && !canQueueTurn) || (isCanceling && !canQueueTurn)
            ? "Cannot send while a run is active."
            : queueTurnBusy
              ? displayedComposerSendability.busyReason || "Message submission is in progress."
              : composerBlocked || isComposerDisabled
                ? displayedComposerSendability.primaryFeedback || "Message cannot be sent in this conversation."
                : displayedSendButtonTitle || displayedComposerSendability.busyReason || "Message cannot be sent.";
  const sendTitle = appendShortcutLabel(
    sendDisabled ? sendDisabledReason : displayedSendButtonTitle || "Send",
    SHORTCUT_COMMAND_IDS.composerSubmit,
    undefined,
    keyboardShortcuts,
  );
  const sendReasonId = useId();
  const submissionErrorId = useId();
  const [isSendReasonFocused, setIsSendReasonFocused] = useState(false);
  const hasVisibleSendReason = !composerFrozen && (!!onCheckTurnReceipt || composerSaveFailed
    || (displayedComposerSendability.shouldShowFeedback && !externalErrorDescriptionIds));
  const showFocusedSendReason = sendDisabled && isSendReasonFocused && !hasVisibleSendReason;
  const composerDescriptionIds = [
    externalErrorDescriptionIds,
    composerSaveFailed ? "composer-save-feedback" : undefined,
    submissionError && !onCheckTurnReceipt ? submissionErrorId : undefined,
    displayedComposerSendability.shouldShowFeedback && !externalErrorDescriptionIds
      ? "composer-sendability-feedback"
      : undefined,
  ].filter(Boolean).join(" ") || undefined;
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const approvalSelectRef = useRef<HTMLSelectElement>(null);
  const approvalDialogRef = useRef<HTMLDialogElement>(null);
  const approvalCancelRef = useRef<HTMLButtonElement>(null);
  const approvalDescriptionId = useId();
  const [pendingApproval, setPendingApproval] = useState<{ value: ApprovalMode; previousApprovalMode: ApprovalMode; owner: string } | null>(null);
  const approvalOwnerKey = `${errorOwnerKey}:${runtimeSelectionIdentity ?? ""}`;
  const isPendingApprovalCurrent = !!pendingApproval && pendingApproval.owner === approvalOwnerKey
    && pendingApproval.previousApprovalMode === selectedApprovalMode && selectedCodexReviewer === "auto-review"
    && providerId === "claude" && !composerControlsDisabled && showExecutionModeControls;

  useEffect(() => {
    const dialog = approvalDialogRef.current;
    if (!dialog) return;
    if (isPendingApprovalCurrent && !dialog.open) {
      dialog.showModal();
      approvalCancelRef.current?.focus();
    } else if (!isPendingApprovalCurrent && dialog.open) {
      dialog.close();
    }
    if (pendingApproval && !isPendingApprovalCurrent) setPendingApproval(null);
  }, [isPendingApprovalCurrent, pendingApproval]);

  const dismissApprovalConfirmation = () => {
    approvalDialogRef.current?.close();
    setPendingApproval(null);
    approvalSelectRef.current?.focus();
  };

  const selectApprovalMode = (value: ApprovalMode) => {
    const reviewerConflict = selectedCodexReviewer === "auto-review"
      && getApprovalReviewerOptionsForProvider(providerId, value)
        .some((option) => option.value === "auto-review" && option.disabled);
    if (reviewerConflict) {
      setPendingApproval({ value, previousApprovalMode: selectedApprovalMode, owner: approvalOwnerKey });
      return;
    }
    onChangeApprovalMode(value);
  };

  useEffect(() => {
    if (!isActive || !showAttachmentControls || (isRunning && !canSendInput && !onQueueTurn) || composerBlocked || composerFrozen) {
      setIsAttachmentMenuOpen(false);
    }
  }, [isActive, canSendInput, composerBlocked, composerFrozen, isRunning, onQueueTurn, showAttachmentControls]);

  useLayoutEffect(() => setIsAttachmentMenuOpen(false), [errorOwnerKey]);
  useEffect(() => {
    if (!isActive && isAgentPickerOpen) onCloseAgentPicker();
  }, [isActive, isAgentPickerOpen, onCloseAgentPicker]);

  const showComposerToolbar =
    showAttachmentControls ||
    showCustomAgentPicker ||
    showSkillPicker ||
    showPromptTemplateButton ||
    showAdditionalDirectoryControls ||
    showMessageViewModeControls ||
    showJumpToBottom ||
    !!targetDock ||
    !!recoveryActions ||
    !!providerQuota ||
    !!chatNotice ||
    isRunning;

  return (
    <div className="composer">
      {showComposerToolbar ? (
        <div className="composer-attachments-toolbar">
          {chatNotice ? (
            <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
          ) : null}
          {showAttachmentControls ? (
            <ComposerAttachmentMenu
              disabled={!isActive || (isRunning && !canSendInput && !onQueueTurn) || composerBlocked || composerFrozen}
              isOpen={isActive && isAttachmentMenuOpen}
              onOpenChange={(isOpen) => {
                if (isOpen) {
                  if (isAgentPickerOpen) {
                    onToggleAgentPicker();
                  }
                  if (isSkillPickerOpen) {
                    onToggleSkillPicker();
                  }
                  if (isAdditionalDirectoryListOpen) {
                    onToggleAdditionalDirectoryList();
                  }
                }
                setIsAttachmentMenuOpen(isOpen);
              }}
              onPickFile={onPickFile}
              onPickFolder={onPickFolder}
              onPickImage={onPickImage}
              onAddToSessionFiles={onAddToSessionFiles}
              onPickSessionFiles={onPickSessionFiles}
              onPickSessionFolder={onPickSessionFolder}
              onPickSessionImage={onPickSessionImage}
            />
          ) : null}
          {showPromptTemplateButton ? (
            <button
              className={`drawer-toggle compact secondary composer-skill-button composer-icon-button${isPromptTemplateWorkspaceOpen ? " is-open" : ""}`}
              type="button"
              title="Template"
              onClick={() => {
                setIsAttachmentMenuOpen(false);
                if (isAgentPickerOpen) {
                  onToggleAgentPicker();
                }
                if (isSkillPickerOpen) {
                  onToggleSkillPicker();
                }
                if (isAdditionalDirectoryListOpen) {
                  onToggleAdditionalDirectoryList();
                }
                onOpenPromptTemplates();
              }}
              aria-pressed={isPromptTemplateWorkspaceOpen}
              disabled={composerControlsDisabled}
            >
              <ComposerIcon name="template" />
              <span className="visually-hidden">Template</span>
            </button>
          ) : null}
          {showCustomAgentPicker ? (
            <CustomAgentPicker
              key={errorOwnerKey}
              items={customAgentItems}
              isOpen={isAgentPickerOpen}
              loading={isCustomAgentListLoading}
              label={selectedCustomAgentLabel}
              title={selectedCustomAgentTitle}
              disabled={!canSelectCustomAgent || composerControlsDisabled}
              onSelect={onSelectCustomAgent}
              onClose={onCloseAgentPicker}
              onToggle={() => {
                setIsAttachmentMenuOpen(false);
                if (isAdditionalDirectoryListOpen) {
                  onToggleAdditionalDirectoryList();
                }
                onToggleAgentPicker();
              }}
            />
          ) : null}
          {showSkillPicker ? (
            <button
              ref={skillButtonRef}
              className={`drawer-toggle compact secondary composer-skill-button composer-icon-button${isSkillPickerOpen ? " is-open" : ""}`}
              type="button"
              title="Skill"
              onClick={() => {
                setIsAttachmentMenuOpen(false);
                if (isAdditionalDirectoryListOpen) {
                  onToggleAdditionalDirectoryList();
                }
                onToggleSkillPicker();
              }}
              disabled={composerControlsDisabled}
              aria-expanded={isSkillPickerOpen}
              aria-haspopup="dialog"
              aria-controls={isSkillPickerOpen ? "composer-skill-picker-list" : undefined}
            >
              <ComposerIcon name="skill" />
              <span className="visually-hidden">Skill</span>
            </button>
          ) : null}
          {showAdditionalDirectoryControls ? (
            <div className="composer-additional-directory-toolbar">
              <div className="composer-directory-add-group" role="group" aria-label="Add directory">
                <button
                  className="drawer-toggle compact secondary composer-skill-button composer-icon-button"
                  type="button"
                  title="Add Directory"
                  onClick={() => {
                    setIsAttachmentMenuOpen(false);
                    if (isAgentPickerOpen) {
                      onToggleAgentPicker();
                    }
                    if (isSkillPickerOpen) {
                      onToggleSkillPicker();
                    }
                    if (isAdditionalDirectoryListOpen) {
                      onToggleAdditionalDirectoryList();
                    }
                    onAddAdditionalDirectory();
                  }}
                  disabled={composerControlsDisabled}
                >
                  <ComposerIcon name="folder-add" />
                  <span className="visually-hidden">Add Directory</span>
                </button>
                <AdditionalDirectoryPathControl
                  key={`${controllerOwner.kind}:${controllerOwner.id}`}
                  disabled={composerControlsDisabled}
                  directoryScopeLabel={directoryScopeLabel}
                  onAdd={onAddAdditionalDirectory}
                  onValidate={onValidateAdditionalDirectory}
                />
              </div>
              <button
                className={`drawer-toggle compact secondary composer-skill-button composer-icon-button composer-directory-list-button${isAdditionalDirectoryListOpen ? " is-open" : ""}`}
                type="button"
                title={`Additional Directories: ${additionalDirectoryCount}`}
                aria-label={`Additional Directories: ${additionalDirectoryCount}`}
                onClick={() => {
                  setIsAttachmentMenuOpen(false);
                  if (isAgentPickerOpen) {
                    onToggleAgentPicker();
                  }
                  if (isSkillPickerOpen) {
                    onToggleSkillPicker();
                  }
                  onToggleAdditionalDirectoryList();
                }}
                disabled={additionalDirectoryCount === 0 || composerFrozen}
                aria-expanded={isAdditionalDirectoryListOpen}
              >
                <ComposerIcon name="folders" />
                <span className="composer-directory-count" aria-hidden="true">{additionalDirectoryCount}</span>
              </button>
            </div>
          ) : null}
          {providerQuota ? <div className="session-provider-quota-slot">{providerQuota}</div> : null}
          {isRunning || showJumpToBottom || showMessageViewModeControls || targetDock || dockModeSwitch || recoveryActions ? (
            <div className="composer-toolbar-view-actions">
              {recoveryActions}
              <div
                className={`session-action-dock-cancel-slot${isRunning ? " is-active" : ""}`}
                aria-hidden={isRunning ? undefined : true}
              >
                {isRunning ? (
                  <button
                    className="danger session-send-button composer-icon-button"
                    type="button"
                    onClick={onSendOrCancel}
                    title={isCanceling ? "Canceling" : canSendInput ? "Cancel run" : sendButtonTitle || "Cancel"}
                    disabled={isCanceling}
                    aria-busy={isCanceling || undefined}
                  >
                    <ButtonContent busy={isCanceling}><ComposerIcon name="stop" /><span className="visually-hidden">Cancel</span></ButtonContent>
                  </button>
                ) : null}
              </div>
              {targetDock ? <div className="composer-target-dock-slot">{targetDock}</div> : null}
              {showJumpToBottom ? (
                <button
                  className="drawer-toggle compact secondary message-jump-bottom-button composer-icon-button"
                  type="button"
                  title="Jump To Latest"
                  onClick={onJumpToBottom}
                >
                  <ComposerIcon name="jump-bottom" />
                  <span className="visually-hidden">Jump To Latest</span>
                </button>
              ) : null}
              {showMessageViewModeControls ? (
                <div className="composer-message-view-mode" role="group" aria-label="Message display mode">
                  <button
                    className="composer-message-view-mode-button"
                    type="button"
                    aria-pressed={messageViewMode === "preview"}
                    title="Preview"
                    onClick={() => onMessageViewModeChange("preview")}
                  >
                    <ComposerIcon name="preview" />
                    <span className="visually-hidden">Preview</span>
                  </button>
                  <button
                    className="composer-message-view-mode-button"
                    type="button"
                    aria-pressed={messageViewMode === "source"}
                    title="Source"
                    onClick={() => onMessageViewModeChange("source")}
                  >
                    <ComposerIcon name="source" />
                    <span className="visually-hidden">Source</span>
                  </button>
                </div>
              ) : null}
              {dockModeSwitch}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="composer-input-row">
        <div className={`composer-box${isComposerBlockedFeedbackActive ? " blocked-feedback-active" : ""}`}>
          <textarea
            ref={composerTextareaRef}
            aria-label="Message"
            data-shortcut-scope="composer"
            value={displayedDraft}
            placeholder={placeholder}
            onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onFocus={onDraftFocus}
            onKeyDown={onDraftKeyDown}
            onPaste={onDraftPaste}
            onSelect={(event) => onDraftSelect(event.currentTarget.selectionStart ?? 0)}
            onCompositionStart={onDraftCompositionStart}
            onCompositionEnd={onDraftCompositionEnd}
            disabled={isComposerDisabled || composerFrozen}
            aria-busy={displayedComposerSendability.isBusy || undefined}
            aria-describedby={composerDescriptionIds}
            aria-invalid={displayedComposerSendability.feedbackTone === "blocked" || composerSaveFailed || !!submissionError ? true : undefined}
          />
          {composerControllerState.saveState === "error" ? (
            <div id="composer-save-feedback" className="composer-save-feedback">
              <span role="status">Draft could not be saved. Retry before sending.</span>
              <ComposerErrorDetails key={`${errorOwnerKey}:save:${composerControllerState.saveError}`} isActive={isActive} label="Draft Save Error Details" message={composerControllerState.saveError ?? "Draft could not be saved."} />
              {onRetryComposerSave ? (
                <button
                  className="composer-save-retry"
                  type="button"
                  onClick={onRetryComposerSave}
                  disabled={composerFrozen}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {onCheckTurnReceipt ? (
            <div className="composer-save-feedback composer-turn-recovery">
              <span>Turn acceptance is unknown. Your draft is preserved.</span>
              <span className="composer-turn-recovery-details" inert={!turnRecoveryError} aria-hidden={!turnRecoveryError}>
                <ComposerErrorDetails key={`${errorOwnerKey}:recovery:${turnRecoveryError}`} isActive={isActive} label="Turn Recovery Error Details" message={turnRecoveryError ?? ""} />
              </span>
              <button type="button" className="drawer-toggle compact secondary" onClick={onCheckTurnReceipt} disabled={queueTurnBusy || !!turnRecoveryAction} aria-busy={turnRecoveryAction === "check" || undefined}>
                <ButtonContent busy={turnRecoveryAction === "check"}>Check Receipt</ButtonContent>
              </button>
              <button type="button" className="drawer-toggle compact secondary" onClick={onRetryOriginalTurn} disabled={queueTurnBusy || !!turnRecoveryAction || composerFrozen || !onRetryOriginalTurn} aria-busy={turnRecoveryAction === "retry" || undefined}>
                <ButtonContent busy={turnRecoveryAction === "retry"}>Retry Original Turn</ButtonContent>
              </button>
            </div>
          ) : null}
          {submissionError && !onCheckTurnReceipt ? (
            <div id={submissionErrorId} className="composer-save-feedback">
              <span role="status">Message could not be sent.</span>
              <ComposerErrorDetails key={`${errorOwnerKey}:submission:${submissionError}`} isActive={isActive} label="Message Submission Error Details" message={submissionError} />
            </div>
          ) : null}
          {displayedComposerSendability.isBusy && displayedComposerSendability.busyReason ? (
            <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {displayedComposerSendability.busyReason}
            </span>
          ) : null}
          {displayedComposerSendability.shouldShowFeedback && !externalErrorDescriptionIds ? (
            <div
              id="composer-sendability-feedback"
              className={`composer-sendability-feedback ${displayedComposerSendability.feedbackTone ?? "helper"}`}
            >
              {displayedComposerSendability.primaryFeedback ? <p>{displayedComposerSendability.primaryFeedback}</p> : null}
              {displayedComposerSendability.secondaryFeedback.length > 0 ? (
                <ul>
                  {displayedComposerSendability.secondaryFeedback.map((feedback) => (
                    <li key={feedback}>{feedback}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer-control-row">
        <div className="composer-settings">
          {showExecutionModeControls ? (
            <>
              <ComposerSettingSelect
                className="composer-setting-approval"
                label="Approval"
                value={selectedApprovalMode}
                options={approvalOptions}
                onChange={(value) => selectApprovalMode(value as ApprovalMode)}
                selectRef={approvalSelectRef}
                disabled={composerControlsDisabled}
                invalid={approvalOptions.some((option) => option.value === selectedApprovalMode && option.disabled)}
              />

              {reviewerOptions.length > 0 ? (
                <ComposerSettingSelect
                  className="composer-setting-reviewer"
                  label="Reviewer"
                  value={selectedCodexReviewer}
                  options={reviewerOptions}
                  onChange={(value) => onChangeCodexReviewer(value as CodexReviewer)}
                  invalid={reviewerOptions.some((option) => option.value === selectedCodexReviewer && option.disabled)}
                  disabled={isCodexReviewerControlDisabled({
                    approvalMode: selectedApprovalMode,
                    isRunning: isRunning && !canQueueTurn,
                    composerBlocked: composerBlocked || composerFrozen,
                  }) || (reviewerOptions.filter((option) => !option.disabled).length === 1
                    && reviewerOptions.some((option) => option.value === selectedCodexReviewer && !option.disabled))}
                />
              ) : null}

              {sandboxOptions.length > 0 ? (
                <ComposerSettingSelect
                  className="composer-setting-sandbox"
                  label="Sandbox"
                  value={selectedCodexSandboxMode}
                  options={sandboxOptions}
                  onChange={(value) => onChangeCodexSandboxMode(value as CodexSandboxMode)}
                  disabled={composerControlsDisabled}
                />
              ) : null}
            </>
          ) : null}

          <ModelPicker
            key={errorOwnerKey}
            options={modelOptions}
            discoveryStatus={modelDiscoveryStatus}
            discoveryError={modelDiscoveryError}
            discoveryHasCache={modelDiscoveryHasCache}
            value={selectedModel}
            fallbackLabel={selectedModelFallbackLabel}
            onChange={onChangeModel}
            onOpen={onModelPickerOpen}
            disabled={composerControlsDisabled}
          />

          {reasoningOptions.length > 0 ? <ComposerSettingSelect
            className="composer-setting-depth"
            label="Reasoning depth"
            value={selectedReasoningEffort}
            options={reasoningOptions}
            onChange={onChangeReasoningEffort}
            disabled={composerControlsDisabled}
          /> : null}

          {speedOptions.length > 0 ? (
            <ComposerSettingSelect
              className="composer-setting-speed"
              label="Speed"
              value={selectedCodexSpeed}
              options={speedOptions}
              onChange={(value) => onChangeCodexSpeed(value as CodexSpeed)}
              disabled={composerControlsDisabled}
            />
          ) : null}
        </div>

        <span
          className="composer-send-control"
          title={sendTitle}
          tabIndex={sendDisabled ? 0 : undefined}
          role={sendDisabled ? "group" : undefined}
          aria-label={sendDisabled ? "Send unavailable" : undefined}
          aria-describedby={sendDisabled ? sendReasonId : undefined}
          onFocus={(event) => setIsSendReasonFocused(event.target === event.currentTarget)}
          onBlur={() => setIsSendReasonFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && showFocusedSendReason) {
              event.preventDefault();
              event.stopPropagation();
              setIsSendReasonFocused(false);
            }
          }}
        >
          <button
            className={`session-send-button composer-icon-button${showBusySendState ? " loading" : ""}`}
            type="button"
            onClick={canQueueTurn ? onQueueTurn : canSendInput ? onSendInput : onSendOrCancel}
            disabled={sendDisabled}
            aria-describedby={sendDisabled ? sendReasonId : undefined}
            aria-busy={showBusySendState || undefined}
            title={sendTitle}
          >
            <ButtonContent busy={showBusySendState}><ComposerIcon name="send" /><span className="visually-hidden">Send</span></ButtonContent>
          </button>
          {sendDisabled ? (
            <span
              id={sendReasonId}
              role={showFocusedSendReason ? "tooltip" : undefined}
              className={showFocusedSendReason ? "composer-send-reason" : "visually-hidden"}
            >
              {sendDisabledReason}
            </span>
          ) : null}
        </span>
      </div>

      <dialog ref={approvalDialogRef} className="session-recovery-conflict" aria-label="Change Approval and Reviewer" aria-describedby={approvalDescriptionId}
        onCancel={(event) => { event.preventDefault(); dismissApprovalConfirmation(); }}>
        <p id={approvalDescriptionId}>{approvalOptions.find((option) => option.value === pendingApproval?.value)?.label} requires Reviewer to be User. Switch from Auto Review to User and change Approval?</p>
        <div className="session-recovery-conflict-actions">
          <button ref={approvalCancelRef} className="drawer-toggle compact secondary" type="button" onClick={dismissApprovalConfirmation}>Cancel</button>
          <button className="drawer-toggle compact" type="button" disabled={!isPendingApprovalCurrent} onClick={() => {
            if (!pendingApproval || !isPendingApprovalCurrent) return;
            onChangeApprovalMode(pendingApproval.value, { previousApprovalMode: pendingApproval.previousApprovalMode });
            dismissApprovalConfirmation();
          }}>Switch Reviewer and Approval</button>
        </div>
      </dialog>
    </div>
  );
}
