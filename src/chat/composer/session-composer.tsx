import { useEffect, useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

import { type MessageViewMode } from "../../ui/markdown/MessageRichText.js";

import { focusRovingItemByKey } from "../../ui/a11y.js";
import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";

import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import { isCodexReviewerControlDisabled, type CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";

import { useShortcutSettings } from "../../settings/shortcut-settings-context.js";

import { ComposerAttachmentMenu } from "../../chat/composer-attachment-menu.js";
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
  targetDock?: ReactNode;
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
  approvalOptions: Array<{ value: ApprovalMode; label: string }>;
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
  onAddAdditionalDirectory: () => void;
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
  targetDock = null,
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
  const projectedComposerSendability = composerController
    ? resolveComposerSendabilityState({
        runState: isRunning ? "running" : "idle",
        busyReason: composerSendability.busyReason,
        blockedReason: composerBlocked ? (composerSendability.primaryFeedback ?? "") : "",
        inputErrors: composerControllerState.preview.errors,
        draftText: displayedDraft,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      })
    : null;
  const displayedComposerSendability = projectedComposerSendability ?? composerSendability;
  const displayedIsSendDisabled = composerController
    ? isComposerDisabled || projectedComposerSendability!.isSendDisabled || composerSaveFailed
    : isSendDisabled;
  const displayedSendButtonTitle = composerSaveFailed
    ? "Draft could not be saved. Retry before sending."
    : projectedComposerSendability
      ? getComposerSendButtonTitle(projectedComposerSendability)
      : sendButtonTitle;
  const showBusySendState = !isRunning && displayedComposerSendability.isBusy === true;
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
    if (!showAttachmentControls || isRunning || composerBlocked || composerFrozen) {
      setIsAttachmentMenuOpen(false);
    }
  }, [composerBlocked, composerFrozen, isRunning, showAttachmentControls]);

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
              disabled={isRunning || composerBlocked || composerFrozen}
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
              className={`drawer-toggle compact secondary composer-skill-button${isPromptTemplateWorkspaceOpen ? " is-open" : ""}`}
              type="button"
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
              disabled={isRunning || composerBlocked || composerFrozen}
            >
              Template
            </button>
          ) : null}
          {showCustomAgentPicker ? (
            <div className="composer-agent-toolbar">
              <button
                className={`drawer-toggle compact secondary composer-skill-button${isAgentPickerOpen ? " is-open" : ""}`}
                type="button"
                onClick={() => {
                  setIsAttachmentMenuOpen(false);
                  if (isAdditionalDirectoryListOpen) {
                    onToggleAdditionalDirectoryList();
                  }
                  onToggleAgentPicker();
                }}
                disabled={!canSelectCustomAgent || isRunning || composerBlocked || composerFrozen}
                aria-expanded={isAgentPickerOpen}
                aria-haspopup="listbox"
                aria-controls={isAgentPickerOpen ? "composer-agent-picker-list" : undefined}
                aria-label="Select a Copilot custom agent"
                title={selectedCustomAgentTitle}
              >
                {selectedCustomAgentLabel}
              </button>
            </div>
          ) : null}
          {showSkillPicker ? (
            <button
              ref={skillButtonRef}
              className={`drawer-toggle compact secondary composer-skill-button${isSkillPickerOpen ? " is-open" : ""}`}
              type="button"
              onClick={() => {
                setIsAttachmentMenuOpen(false);
                if (isAdditionalDirectoryListOpen) {
                  onToggleAdditionalDirectoryList();
                }
                onToggleSkillPicker();
              }}
              disabled={isRunning || composerBlocked || composerFrozen}
              aria-expanded={isSkillPickerOpen}
              aria-haspopup="listbox"
              aria-controls={isSkillPickerOpen ? "composer-skill-picker-list" : undefined}
            >
              Skill
            </button>
          ) : null}
          {showAdditionalDirectoryControls ? (
            <div className="composer-additional-directory-toolbar">
              <button
                className="drawer-toggle compact secondary composer-skill-button"
                type="button"
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
                disabled={isRunning || composerBlocked || composerFrozen}
              >
                Add Directory
              </button>
              <button
                className={`drawer-toggle compact secondary composer-skill-button${isAdditionalDirectoryListOpen ? " is-open" : ""}`}
                type="button"
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
                {`Dirs${additionalDirectoryCount}`}
              </button>
            </div>
          ) : null}
          {isRunning || showJumpToBottom || showMessageViewModeControls || targetDock ? (
            <div className="composer-toolbar-view-actions">
              <div
                className={`session-action-dock-cancel-slot${isRunning ? " is-active" : ""}`}
                aria-hidden={isRunning ? undefined : true}
              >
                {isRunning ? (
                  <button
                    className="danger session-send-button"
                    type="button"
                    onClick={onSendOrCancel}
                    title={sendButtonTitle}
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
              {targetDock ? <div className="composer-target-dock-slot">{targetDock}</div> : null}
              {showJumpToBottom ? (
                <button
                  className="drawer-toggle compact secondary message-jump-bottom-button"
                  type="button"
                  onClick={onJumpToBottom}
                >
                  Jump To Latest
                </button>
              ) : null}
              {showMessageViewModeControls ? (
                <div className="composer-message-view-mode" role="group" aria-label="Message display mode">
                  <button
                    className="composer-message-view-mode-button"
                    type="button"
                    aria-pressed={messageViewMode === "preview"}
                    onClick={() => onMessageViewModeChange("preview")}
                  >
                    Preview
                  </button>
                  <button
                    className="composer-message-view-mode-button"
                    type="button"
                    aria-pressed={messageViewMode === "source"}
                    onClick={() => onMessageViewModeChange("source")}
                  >
                    Source
                  </button>
                </div>
              ) : null}
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
            <div className="chat-skill-picker-state" role="status" aria-label="Loading custom agents">
              <span className="chat-skill-picker-spinner" aria-hidden="true" />
              <span className="visually-hidden">Loading Custom Agents</span>
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
        <div className={`composer-box${isRunning ? " running" : ""}${isComposerBlockedFeedbackActive ? " blocked-feedback-active" : ""}`}>
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
              <div className="composer-setting-field composer-setting-approval">
                <span>Approval</span>
                <select
                  value={selectedApprovalMode}
                  onChange={(event) => onChangeApprovalMode(event.target.value as ApprovalMode)}
                  disabled={isRunning || composerBlocked}
                  aria-label="Approval"
                >
                  {approvalOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {reviewerOptions.length > 0 ? (
                <div className="composer-setting-field composer-setting-reviewer">
                  <span>Reviewer</span>
                  <select
                    value={selectedCodexReviewer}
                    onChange={(event) => onChangeCodexReviewer(event.target.value as CodexReviewer)}
                    disabled={isCodexReviewerControlDisabled({
                      approvalMode: selectedApprovalMode,
                      isRunning,
                      composerBlocked,
                    })}
                    aria-label="Reviewer"
                  >
                    {reviewerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {sandboxOptions.length > 0 ? (
                <div className="composer-setting-field composer-setting-sandbox">
                  <span>Sandbox</span>
                  <select
                    value={selectedCodexSandboxMode}
                    onChange={(event) => onChangeCodexSandboxMode(event.target.value as CodexSandboxMode)}
                    disabled={isRunning || composerBlocked}
                    aria-label="Sandbox"
                  >
                    {sandboxOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="composer-setting-field composer-setting-model">
            <span>Model</span>
            <select
              value={selectedModel}
              onChange={(event) => onChangeModel(event.target.value)}
              disabled={isRunning || composerBlocked}
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

          <div className="composer-setting-field composer-setting-depth">
            <span>Depth</span>
            <select
              value={selectedReasoningEffort}
              onChange={(event) => onChangeReasoningEffort(event.target.value)}
              disabled={isRunning || composerBlocked}
              aria-label="Reasoning depth"
            >
              {reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {speedOptions.length > 0 ? (
            <div className="composer-setting-field composer-setting-speed">
              <span>Speed</span>
              <select
                value={selectedCodexSpeed}
                onChange={(event) => onChangeCodexSpeed(event.target.value as CodexSpeed)}
                disabled={isRunning || composerBlocked}
                aria-label="Speed"
              >
                {speedOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <button
          className={`session-send-button${showBusySendState ? " loading" : ""}`}
          type="button"
          onClick={onSendOrCancel}
          disabled={isRunning || displayedIsSendDisabled || composerFrozen}
          aria-busy={showBusySendState || undefined}
          title={
            showBusySendState
              ? undefined
              : isRunning
              ? "Cannot send while a run is active"
              : appendShortcutLabel(
                  displayedSendButtonTitle,
                  SHORTCUT_COMMAND_IDS.composerSubmit,
                  undefined,
                  keyboardShortcuts,
                )
          }
        >
          {showBusySendState ? <span className="concurrent-chat-loading-spinner" aria-hidden="true" /> : null}
          <span>Send</span>
        </button>
      </div>
    </div>
  );
}
