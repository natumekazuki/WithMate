import { useEffect, useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";

import { focusRovingItemByKey } from "../../ui/a11y.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";

import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import { isCodexReviewerControlDisabled, type CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";

import { useShortcutSettings } from "../../settings/shortcut-settings-context.js";

import { ComposerAttachmentMenu } from "../../chat/composer-attachment-menu.js";
import { AdditionalDirectoryPathControl } from "./additional-directory-path-control.js";
import { ComposerIcon } from "./composer-icon.js";
import { ComposerSettingSelect } from "./composer-setting-select.js";
import { useComposerController, type ComposerControllerRegistry, type ComposerOwner } from "../../chat/composer-controller.js";
import {
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
} from "./session-composer-feedback.js";

import { appendShortcutLabel, SHORTCUT_COMMAND_IDS } from "../../settings/shortcut-registry.js";


export type SessionSelectOption = {
  value: string;
  label: string;
};

type SessionCustomAgentItem = {
  key: string;
  value: string | null;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  isSelected: boolean;
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
  composerController?: { owner: ComposerOwner; registry: ComposerControllerRegistry; initialDraft?: string };
  onRetryComposerSave?: () => void;
  isRunning: boolean;
  isCanceling?: boolean;
  canSendInput?: boolean;
  onSendInput?: () => void;
  onQueueTurn?: () => void;
  queueTurnBusy?: boolean;
  onCheckTurnReceipt?: () => void;
  onRetryOriginalTurn?: () => void;
  submissionError?: string;
  targetDock?: ReactNode;
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
  selectedApprovalMode: ApprovalMode;
  reviewerOptions: Array<{ value: CodexReviewer; label: string }>;
  selectedCodexReviewer: CodexReviewer;
  sandboxOptions: Array<{ value: CodexSandboxMode; label: string }>;
  selectedCodexSandboxMode: CodexSandboxMode;
  speedOptions: Array<{ value: CodexSpeed; label: string }>;
  selectedCodexSpeed: CodexSpeed;
  modelOptions: SessionSelectOption[];
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
  onToggleSkillPicker: () => void;
  onOpenPromptTemplates?: () => void;
  onAddAdditionalDirectory: (directoryPath?: string) => void | Promise<void>;
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
  onChangeApprovalMode: (value: ApprovalMode) => void;
  onChangeCodexReviewer: (value: CodexReviewer) => void;
  onChangeCodexSandboxMode: (value: CodexSandboxMode) => void;
  onChangeCodexSpeed: (value: CodexSpeed) => void;
  onChangeModel: (value: string) => void;
  onChangeReasoningEffort: (value: string) => void;
  onMessageViewModeChange?: (mode: MessageViewMode) => void;
};

export function SessionComposerExpanded({
  composerController,
  onRetryComposerSave,
  isRunning,
  isCanceling = false,
  canSendInput = false,
  onSendInput,
  onQueueTurn,
  queueTurnBusy = false,
  onCheckTurnReceipt,
  onRetryOriginalTurn,
  submissionError,
  targetDock = null,
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
  selectedApprovalMode,
  reviewerOptions = [],
  selectedCodexReviewer = "user",
  sandboxOptions,
  selectedCodexSandboxMode,
  speedOptions = [],
  selectedCodexSpeed = "standard",
  modelOptions,
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
  onToggleSkillPicker,
  onOpenPromptTemplates = () => {},
  onAddAdditionalDirectory,
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
  onChangeReasoningEffort,
  onMessageViewModeChange = () => {},
}: SessionComposerExpandedProps) {
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
  const composerControlsDisabled = composerBlocked || composerFrozen || (isRunning && !canQueueTurn);
  const projectedComposerSendability = composerController
    ? resolveComposerSendabilityState({
        runState: isRunning ? "running" : "idle",
        canSendInput: !canQueueTurn && canSendInput && !isCanceling,
        canQueueTurn,
        busyReason: queueTurnBusy ? "Message submission is in progress." : composerSendability.busyReason,
        blockedReason: composerBlocked ? (composerSendability.primaryFeedback ?? "") : "",
        inputErrors: composerControllerState.preview.errors,
        draftText: displayedDraft,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      })
    : null;
  const resolvedComposerSendability = projectedComposerSendability ?? composerSendability;
  const displayedComposerSendability = submissionError && !resolvedComposerSendability.primaryFeedback
    ? { ...resolvedComposerSendability, primaryFeedback: submissionError, feedbackTone: "blocked" as const, shouldShowFeedback: true }
    : resolvedComposerSendability;
  const displayedIsSendDisabled = composerController
    ? isComposerDisabled || projectedComposerSendability!.isSendDisabled || composerSaveFailed || !!onCheckTurnReceipt
    : isComposerDisabled || isSendDisabled || composerSaveFailed || !!onCheckTurnReceipt;
  const displayedSendButtonTitle = composerSaveFailed
    ? "Draft could not be saved. Retry before sending."
    : projectedComposerSendability
      ? getComposerSendButtonTitle(projectedComposerSendability)
      : sendButtonTitle;
  const showBusySendState = queueTurnBusy || ((!isRunning || canSendInput || canQueueTurn) && displayedComposerSendability.isBusy === true);
  const composerDescriptionIds = [
    externalErrorDescriptionIds,
    composerSaveFailed ? "composer-save-feedback" : undefined,
    displayedComposerSendability.shouldShowFeedback && !externalErrorDescriptionIds
      ? "composer-sendability-feedback"
      : undefined,
  ].filter(Boolean).join(" ") || undefined;
  const customAgentListRef = useRef<HTMLDivElement | null>(null);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
  const keyboardShortcuts = useShortcutSettings();

  useEffect(() => {
    if (!showAttachmentControls || (isRunning && !canSendInput && !onQueueTurn) || composerBlocked || composerFrozen) {
      setIsAttachmentMenuOpen(false);
    }
  }, [canSendInput, composerBlocked, composerFrozen, isRunning, onQueueTurn, showAttachmentControls]);

  useEffect(() => {
    if (!isAgentPickerOpen) {
      return;
    }

    const nextFocusTarget =
      customAgentListRef.current?.querySelector<HTMLElement>("[aria-selected=\"true\"]") ??
      customAgentListRef.current?.querySelector<HTMLElement>("[role=\"option\"]");
    nextFocusTarget?.focus();
  }, [customAgentItems, isAgentPickerOpen]);

  const showComposerToolbar =
    showAttachmentControls ||
    showCustomAgentPicker ||
    showSkillPicker ||
    showPromptTemplateButton ||
    showAdditionalDirectoryControls ||
    showMessageViewModeControls ||
    showJumpToBottom ||
    !!targetDock ||
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
              disabled={(isRunning && !canSendInput && !onQueueTurn) || composerBlocked || composerFrozen}
              isOpen={isAttachmentMenuOpen}
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
            <div className="composer-agent-toolbar">
              <button
                className={`drawer-toggle compact secondary composer-skill-button composer-icon-button${isAgentPickerOpen ? " is-open" : ""}`}
                type="button"
                onClick={() => {
                  setIsAttachmentMenuOpen(false);
                  if (isAdditionalDirectoryListOpen) {
                    onToggleAdditionalDirectoryList();
                  }
                  onToggleAgentPicker();
                }}
                disabled={!canSelectCustomAgent || composerControlsDisabled}
                aria-expanded={isAgentPickerOpen}
                aria-haspopup="listbox"
                aria-controls={isAgentPickerOpen ? "composer-agent-picker-list" : undefined}
                aria-label="Select a Copilot custom agent"
                title={selectedCustomAgentTitle}
              >
                <ComposerIcon name="agent" />
                <span className="visually-hidden">{selectedCustomAgentLabel}</span>
              </button>
            </div>
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
              aria-haspopup="listbox"
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
                  onAdd={onAddAdditionalDirectory}
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
          {isRunning || showJumpToBottom || showMessageViewModeControls || targetDock || dockModeSwitch ? (
            <div className="composer-toolbar-view-actions">
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
                    {isCanceling ? <span className="loading-indicator-spinner" aria-hidden="true" /> : <ComposerIcon name="stop" />}
                    <span className="visually-hidden">{isCanceling ? "Canceling" : "Cancel"}</span>
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

      {showCustomAgentPicker && isAgentPickerOpen ? (
        <div
          id="composer-agent-picker-list"
          ref={customAgentListRef}
          className="composer-path-match-list composer-skill-picker-list"
          role="listbox"
          aria-label="Custom Agent options"
          aria-busy={isCustomAgentListLoading || undefined}
          aria-orientation="vertical"
          onKeyDown={(event) => {
            focusRovingItemByKey(event, { orientation: "vertical" });
          }}
        >
          {isCustomAgentListLoading ? (
            <div className="chat-skill-picker-state">
              <LoadingIndicator label="Loading custom agents" />
            </div>
          ) : customAgentItems.length > 0 ? (
            customAgentItems.map((item) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={item.isSelected}
                tabIndex={item.isSelected ? 0 : -1}
                className={`composer-path-match${item.isSelected ? " active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectCustomAgent(item.value)}
                disabled={composerFrozen}
                title={item.title}
              >
                <span className="composer-path-match-primary">{item.primaryLabel}</span>
                <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
              </button>
            ))
          ) : null}
        </div>
      ) : null}

      <div className="composer-input-row">
        <div className={`composer-box${isComposerBlockedFeedbackActive ? " blocked-feedback-active" : ""}`}>
          <textarea
            ref={composerTextareaRef}
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
            aria-invalid={displayedComposerSendability.feedbackTone === "blocked" || composerSaveFailed ? true : undefined}
          />
          {composerControllerState.saveState === "error" ? (
            <div id="composer-save-feedback" className="composer-save-feedback">
              <span>{composerControllerState.saveError ?? "Draft could not be saved."}</span>
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
            <div className="composer-save-feedback">
              <span>Turn acceptance is unknown. Your draft is preserved.</span>
              <button type="button" className="drawer-toggle compact secondary" onClick={onCheckTurnReceipt} disabled={queueTurnBusy}>Check Receipt</button>
              <button type="button" className="drawer-toggle compact secondary" onClick={onRetryOriginalTurn} disabled={queueTurnBusy}>Retry Original Turn</button>
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
                onChange={(value) => onChangeApprovalMode(value as ApprovalMode)}
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
                  disabled={isCodexReviewerControlDisabled({
                    approvalMode: selectedApprovalMode,
                    isRunning: isRunning && !canQueueTurn,
                    composerBlocked: composerBlocked || composerFrozen,
                  })}
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

          <div className="composer-setting-field composer-setting-model">
            <select
              aria-label="Model"
              title={`Model: ${modelOptions.find((option) => option.value === selectedModel)?.label ?? selectedModelFallbackLabel}`}
              value={selectedModel}
              onChange={(event) => onChangeModel(event.target.value)}
              disabled={composerControlsDisabled}
            >
              {modelOptions.length > 0 ? (
                modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
              ) : (
                <option value={selectedModel}>{selectedModelFallbackLabel}</option>
              )}
            </select>
          </div>

          <ComposerSettingSelect
            className="composer-setting-depth"
            label="Reasoning depth"
            value={selectedReasoningEffort}
            options={reasoningOptions}
            onChange={onChangeReasoningEffort}
            disabled={composerControlsDisabled}
          />

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

        <button
          className={`session-send-button composer-icon-button${showBusySendState ? " loading" : ""}`}
          type="button"
          onClick={canQueueTurn ? onQueueTurn : canSendInput ? onSendInput : onSendOrCancel}
          disabled={(isRunning && !canSendInput && !canQueueTurn) || (isCanceling && !canQueueTurn) || displayedIsSendDisabled || composerBlocked || composerFrozen || queueTurnBusy}
          aria-busy={showBusySendState || undefined}
          title={
            showBusySendState
              ? undefined
              : isRunning && !canSendInput && !canQueueTurn
              ? "Cannot send while a run is active"
              : appendShortcutLabel(
                  displayedSendButtonTitle || "Send",
                  SHORTCUT_COMMAND_IDS.composerSubmit,
                  undefined,
                  keyboardShortcuts,
                )
          }
        >
          {showBusySendState ? <span className="loading-indicator-spinner" aria-hidden="true" /> : <ComposerIcon name="send" />}
          <span className="visually-hidden">Send</span>
        </button>
      </div>
    </div>
  );
}
