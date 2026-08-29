import { Component, Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEventHandler, type CSSProperties, type Dispatch, type ErrorInfo, type KeyboardEventHandler, type ReactNode, type RefObject, type SetStateAction, type UIEventHandler } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import type {
  AuditLogDetailFragment,
  AuditLogDetailSection,
  ChangedFile,
  CharacterProfile,
  LiveApprovalRequest,
  LiveBackgroundTask,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveElicitationResponse,
  Message,
  MessageArtifact,
  DiffPreviewPayload,
  SessionContextTelemetry,
  AuditLogSummary,
} from "./app-state.js";
import { DiffViewer } from "./DiffViewer.js";
import { MessageRichText, type MessageViewMode } from "./MessageRichText.js";
import {
  approvalModeLabel,
  CharacterAvatar,
  fileKindLabel,
  liveRunStepDetailsLabel,
  liveRunStepStatusLabel,
  operationTypeLabel,
} from "./ui-utils.js";
import { focusRovingItemByKey, useDialogA11y } from "./a11y.js";
import type { ApprovalMode } from "./approval-mode.js";
import type { ChatWindowModeKind } from "./chat/chat-window-mode.js";
import type { ChatLayoutPriority } from "./chat/chat-layout-preference.js";
import type { SessionQueuedTurn, SessionTurnExecutionProjection } from "./session-turn-execution.js";
import type { RelatedSessionDetails } from "./related-session-details.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import {
  contextPaneTabLabel,
  liveRunStepToneClassName,
  sessionBackgroundActivityStatusLabel,
  type ContextPaneProjection,
  type ContextPaneTabKey,
  type LatestCommandView,
  type RunningDetailsEntry,
  type SessionContextTelemetryProjection,
} from "./session-ui-projection.js";
import type { HomeMonitorEntry } from "./home/home-session-projection.js";
import { isWorkItemActive, type RootWorkItem } from "./work-item.js";
import { getWithMateApi } from "./renderer-withmate-api.js";
import { SessionContentFindBar } from "./session-content-find-bar.js";
import { clampFindMatchIndex, findTextMatches } from "./find-text-matches.js";
import { ComposerAttachmentMenu } from "./chat/composer-attachment-menu.js";
import { resolveSelectionActionOverlayPosition } from "./chat/selection-action-overlay.js";
import {
  isMessageRenderedSearchTextNode,
  projectMessageRenderedSearchText,
} from "./message-rendered-search-text.js";
import {
  appendRenderedTextMatches,
  applyRenderedTextHighlights,
  clearRenderedTextHighlights,
  createRenderedTextSearchIndex,
  findRenderedTextMatchOffsets,
  resolveRenderedTextMatch,
  scrollRenderedTextMatchIntoView,
  type RenderedTextMatch,
} from "./file-explorer/rendered-text-search.js";

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function displayRunCheckValue(check: { label: string; value: string }): string {
  return check.label.trim().toLowerCase() === "approval" ? displayApprovalValue(check.value) : check.value;
}

function collapseSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function liveApprovalKindLabel(kind: string): string {
  switch (kind) {
    case "shell":
      return "Shell Command";
    case "write":
      return "File Change";
    case "mcp":
      return "MCP Tool";
    case "custom-tool":
      return "Custom Tool";
    case "url":
      return "URL Fetch";
    case "read":
      return "File Read";
    default:
      return kind;
  }
}

function liveElicitationModeLabel(mode: LiveElicitationRequest["mode"]): string {
  return mode === "url" ? "URL" : "Form";
}

type PendingRunIndicatorProps = {
  announcement?: string;
  text?: string;
  className?: string;
};

function PendingRunIndicator({
  announcement,
  text = "処理を実行中",
  className = "",
}: PendingRunIndicatorProps) {
  const indicatorText = text.trim() || "処理を実行中";
  const statusText = announcement?.trim() || indicatorText;

  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
      <div className={`live-run-shell-status pending-run-indicator${className ? ` ${className}` : ""}`} aria-hidden="true">
        <span className="live-run-shell-status-badge">実行中</span>
        <span className="live-run-shell-status-text">{indicatorText}</span>
        <span className="typing-dots pending-run-indicator-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
    </>
  );
}

type LiveElicitationFieldValue = string | number | boolean | string[];
type LiveElicitationContentEntry = readonly [string, LiveElicitationFieldValue];

function createLiveElicitationFieldValue(field: LiveElicitationField): LiveElicitationFieldValue {
  switch (field.type) {
    case "boolean":
      return field.defaultValue ?? false;
    case "number":
      return field.defaultValue ?? "";
    case "multi-select":
      return field.defaultValue ?? [];
    case "select":
      return field.defaultValue ?? "";
    case "text":
      return field.defaultValue ?? "";
    default:
      return "";
  }
}

function createLiveElicitationFormState(request: LiveElicitationRequest): Record<string, LiveElicitationFieldValue> {
  return Object.fromEntries(request.fields.map((field) => [field.name, createLiveElicitationFieldValue(field)]));
}

function validateLiveElicitationField(
  field: LiveElicitationField,
  value: LiveElicitationFieldValue,
): string | null {
  switch (field.type) {
    case "text": {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (field.required && !normalized) {
        return `${field.title} は必須だよ。`;
      }
      if (field.minLength !== undefined && normalized.length < field.minLength) {
        return `${field.title} は ${field.minLength} 文字以上にしてね。`;
      }
      if (field.maxLength !== undefined && normalized.length > field.maxLength) {
        return `${field.title} は ${field.maxLength} 文字以下にしてね。`;
      }
      return null;
    }
    case "select": {
      const normalized = typeof value === "string" ? value : "";
      if (field.required && !normalized) {
        return `${field.title} を選んでね。`;
      }
      return null;
    }
    case "multi-select": {
      const items = Array.isArray(value) ? value : [];
      if ((field.required || (field.minItems ?? 0) > 0) && items.length === 0) {
        return `${field.title} を少なくとも 1 つ選んでね。`;
      }
      if (field.minItems !== undefined && items.length < field.minItems) {
        return `${field.title} は ${field.minItems} 個以上選んでね。`;
      }
      if (field.maxItems !== undefined && items.length > field.maxItems) {
        return `${field.title} は ${field.maxItems} 個以下にしてね。`;
      }
      return null;
    }
    case "number": {
      if (value === "") {
        return field.required ? `${field.title} は必須だよ。` : null;
      }
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `${field.title} は数値で入力してね。`;
      }
      if (field.numberKind === "integer" && !Number.isInteger(value)) {
        return `${field.title} は整数で入力してね。`;
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return `${field.title} は ${field.minimum} 以上にしてね。`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `${field.title} は ${field.maximum} 以下にしてね。`;
      }
      return null;
    }
    case "boolean":
      return null;
    default:
      return null;
  }
}

function buildLiveElicitationResponseContent(
  request: LiveElicitationRequest,
  fieldValues: Record<string, LiveElicitationFieldValue>,
): Record<string, LiveElicitationFieldValue> {
  const entries = request.fields.flatMap<LiveElicitationContentEntry>((field) => {
    const value = fieldValues[field.name];
    if (field.type === "text" || field.type === "select") {
      if (typeof value !== "string") {
        return [];
      }
      if (!field.required && !value.trim()) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "multi-select") {
      if (!Array.isArray(value)) {
        return [];
      }
      if (!field.required && value.length === 0) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "number") {
      if (value === "" || typeof value !== "number" || Number.isNaN(value)) {
        return [];
      }
      return [[field.name, value] as const];
    }

    if (field.type === "boolean" && typeof value === "boolean") {
      return [[field.name, value] as const];
    }

    return [];
  });

  return Object.fromEntries(entries);
}

function liveElicitationTextValue(value: LiveElicitationFieldValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function liveElicitationMultiSelectValue(value: LiveElicitationFieldValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

type LiveElicitationCardProps = {
  request: LiveElicitationRequest;
  elicitationActionRequestId: string | null;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
};

function LiveElicitationCard({
  request,
  elicitationActionRequestId,
  onResolveLiveElicitation,
  onOpenPath,
}: LiveElicitationCardProps) {
  const [fieldValues, setFieldValues] = useState<Record<string, LiveElicitationFieldValue>>(
    () => createLiveElicitationFormState(request),
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  useEffect(() => {
    setFieldValues(createLiveElicitationFormState(request));
    setValidationMessage(null);
  }, [request.requestId]);

  const isSubmitting = elicitationActionRequestId === request.requestId;

  const handleSubmit = (action: LiveElicitationResponse["action"]) => {
    if (action === "accept") {
      for (const field of request.fields) {
        const validation = validateLiveElicitationField(field, fieldValues[field.name] ?? "");
        if (validation) {
          setValidationMessage(validation);
          return;
        }
      }

      setValidationMessage(null);
      const content = buildLiveElicitationResponseContent(request, fieldValues);
      onResolveLiveElicitation(request, {
        action,
        ...(Object.keys(content).length > 0 ? { content } : {}),
      });
      return;
    }

    setValidationMessage(null);
    onResolveLiveElicitation(request, { action });
  };

  return (
    <section className="live-elicitation-card" role="group" aria-label="入力要求">
      <div className="live-approval-head">
        <div className="live-approval-copy">
          <span className="live-approval-badge">入力待ち</span>
          <p className="live-approval-title">{request.message}</p>
        </div>
        <span className="live-approval-kind">{liveElicitationModeLabel(request.mode)}</span>
      </div>
      {request.source ? <p className="live-elicitation-source">{request.source}</p> : null}
      {request.mode === "url" && request.url ? (
        <div className="live-elicitation-url">
          <code>{request.url}</code>
          {onOpenPath ? (
            <button
              type="button"
              className="drawer-toggle secondary"
              onClick={() => onOpenPath(request.url!)}
              disabled={isSubmitting}
            >
              Open
            </button>
          ) : null}
        </div>
      ) : null}
      {request.mode === "form" && request.fields.length > 0 ? (
        <div className="live-elicitation-form">
          {request.fields.map((field) => (
            <label key={field.name} className="live-elicitation-field">
              <span className="live-elicitation-label">
                {field.title}
                {field.required ? <strong> *</strong> : null}
              </span>
              {field.description ? <span className="live-elicitation-description">{field.description}</span> : null}
              {field.type === "text" ? (
                field.maxLength !== undefined && field.maxLength > 120 ? (
                  <textarea
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                ) : (
                  <input
                    type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
                    value={liveElicitationTextValue(fieldValues[field.name])}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                )
              ) : null}
              {field.type === "number" ? (
                <input
                  type="number"
                  step={field.numberKind === "integer" ? "1" : "any"}
                  value={typeof fieldValues[field.name] === "number" ? String(fieldValues[field.name]) : ""}
                  onChange={(event) =>
                    setFieldValues((current) => ({
                      ...current,
                      [field.name]: event.target.value === "" ? "" : Number(event.target.value),
                    }))}
                  disabled={isSubmitting}
                />
              ) : null}
              {field.type === "boolean" ? (
                <span className="live-elicitation-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldValues[field.name] === true}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                    disabled={isSubmitting}
                  />
                  <span>有効</span>
                </span>
              ) : null}
              {field.type === "select" ? (
                <select
                  value={liveElicitationTextValue(fieldValues[field.name])}
                  onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                  disabled={isSubmitting}
                >
                  {!field.required ? <option value="">選択なし</option> : null}
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {field.type === "multi-select" ? (
                <div className="live-elicitation-options">
                  {field.options.map((option) => {
                    const selectedValues = liveElicitationMultiSelectValue(fieldValues[field.name]);
                    const checked = selectedValues.includes(option.value);
                    return (
                      <label key={option.value} className="live-elicitation-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setFieldValues((current) => {
                              const currentValues = liveElicitationMultiSelectValue(current[field.name]);
                              return {
                                ...current,
                                [field.name]: event.target.checked
                                  ? [...currentValues, option.value]
                                  : currentValues.filter((value) => value !== option.value),
                              };
                            });
                          }}
                          disabled={isSubmitting}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </label>
          ))}
        </div>
      ) : null}
      {validationMessage ? <p className="live-approval-warning" role="alert">{validationMessage}</p> : null}
      <div className="live-approval-actions">
        <button type="button" onClick={() => handleSubmit("accept")} disabled={isSubmitting}>
          {request.mode === "url" ? "完了" : "送信"}
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("decline")}
          disabled={isSubmitting}
        >
          拒否
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={() => handleSubmit("cancel")}
          disabled={isSubmitting}
        >
          閉じる
        </button>
      </div>
    </section>
  );
}

function auditPhaseLabel(phase: AuditLogSummary["phase"]): string {
  switch (phase) {
    case "running":
    case "started":
      return "RUNNING";
    case "background-running":
      return "BG RUN";
    case "completed":
      return "DONE";
    case "background-completed":
      return "BG DONE";
    case "canceled":
      return "CANCELED";
    case "background-canceled":
      return "BG CANCELED";
    case "failed":
      return "FAIL";
    case "background-failed":
      return "BG FAIL";
    default:
      return phase;
  }
}

function isBackgroundAuditPhase(phase: AuditLogSummary["phase"]): boolean {
  return phase.startsWith("background-");
}

const SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT = 168;
const SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT = 720;
const SESSION_MESSAGE_OVERSCAN = 6;
const SESSION_MESSAGE_SCROLL_END_THRESHOLD = 80;

export function shouldAdjustSessionMessageScrollPosition(input: {
  itemStart: number;
  scrollOffset: number;
}): boolean {
  return input.itemStart < input.scrollOffset;
}

type MessageArtifactFoldSection = "files" | "operation";

function messageArtifactFoldKey(artifactKey: string, section: MessageArtifactFoldSection, index?: number): string {
  return `${artifactKey}:${section}${index === undefined ? "" : `:${index}`}`;
}

export type AuditLogFoldSection = "logical" | "transport" | "response" | "operations" | "usage" | "error" | "raw";
type AuditLogLazyFoldSection = Extract<AuditLogFoldSection, AuditLogDetailSection>;
type AuditLogLogicalPromptField = "system" | "input" | "composed";
const AUDIT_LOG_OPERATION_RENDER_LIMIT = 30;
const AUDIT_LOG_AUTO_LOAD_SECTIONS: AuditLogDetailSection[] = ["logical", "transport", "response", "operations", "raw"];
const AUDIT_LOG_TEXT_PREVIEW_HEAD_CHARS = 60000;
const AUDIT_LOG_TEXT_PREVIEW_TAIL_CHARS = 60000;
const AUDIT_LOG_TEXT_PREVIEW_MAX_CHARS = AUDIT_LOG_TEXT_PREVIEW_HEAD_CHARS + AUDIT_LOG_TEXT_PREVIEW_TAIL_CHARS;
const AUDIT_LOG_LOGICAL_FIELD_PREVIEW_MAX_CHARS = 20000;

function previewAuditLogText(value: string, maxChars = AUDIT_LOG_TEXT_PREVIEW_MAX_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  return [
    value.slice(0, headChars),
    "",
    `... truncated ${value.length - maxChars} chars ...`,
    "",
    value.slice(-tailChars),
  ].join("\n");
}

function AuditLogTextPreview({ value, maxChars }: { value: string; maxChars?: number }) {
  const preview = useMemo(() => previewAuditLogText(value, maxChars), [maxChars, value]);
  return <pre>{preview}</pre>;
}

function AuditLogLogicalPromptFieldFold({
  entry,
  field,
  label,
  value,
  open,
  setOpenAuditLogFolds,
}: {
  entry: Pick<AuditLogSummary, "id" | "sessionId">;
  field: AuditLogLogicalPromptField;
  label: string;
  value: string;
  open: boolean;
  setOpenAuditLogFolds: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  return (
    <details
      className="audit-log-raw"
      open={open}
      onToggle={(event) => {
        const openFold = event.currentTarget.open;
        setOpenAuditLogFolds((current) => {
          const key = auditLogLogicalPromptFieldFoldKey(entry, field);
          if (openFold) {
            return current[key] ? current : { ...current, [key]: true };
          }
          if (!current[key]) {
            return current;
          }
          const next = { ...current };
          delete next[key];
          return next;
        });
      }}
    >
      <summary>{label} ({value.length.toLocaleString()} chars)</summary>
      {open ? (
        <AuditLogTextPreview
          value={value || "-"}
          maxChars={AUDIT_LOG_LOGICAL_FIELD_PREVIEW_MAX_CHARS}
        />
      ) : null}
    </details>
  );
}

function auditLogFoldKey(entry: Pick<AuditLogSummary, "id" | "sessionId">, section: AuditLogFoldSection): string {
  return `${entry.sessionId}:${entry.id}:${section}`;
}

function auditLogLogicalPromptFieldFoldKey(
  entry: Pick<AuditLogSummary, "id" | "sessionId">,
  field: AuditLogLogicalPromptField,
): string {
  return `${entry.sessionId}:${entry.id}:logical:${field}`;
}

function auditLogOperationDetailFoldKey(
  entry: Pick<AuditLogSummary, "id" | "sessionId">,
  operationIndex: number,
): string {
  return `${entry.sessionId}:${entry.id}:operations:${operationIndex}`;
}

export function shouldLoadAuditLogDetailForFold(section: AuditLogFoldSection): section is AuditLogLazyFoldSection {
  return section === "logical"
    || section === "transport"
    || section === "response"
    || section === "operations"
    || section === "raw";
}

export type SessionDiffModalProps = {
  selectedDiff: DiffPreviewPayload | null;
  themeStyle: CSSProperties;
  onClose: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
};

export type SessionHeaderProps = {
  taskTitle: string;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
  isReadOnly?: boolean;
  isPinned?: boolean;
  isPinPending?: boolean;
  showRenameButton?: boolean;
  showAuditLogButton?: boolean;
  showTerminalButton?: boolean;
  isTerminalDisabled?: boolean;
  showDeleteButton?: boolean;
  workspaceActions?: ReactNode;
  sessionFilesActions?: ReactNode;
  actions?: ReactNode;
  onTogglePin?: () => void;
  onOpenAuditLog: () => void;
  onOpenTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onDeleteSession: () => void;
};

export function SessionHeader({
  taskTitle,
  isEditingTitle,
  titleDraft,
  isRunning,
  isReadOnly = false,
  isPinned = false,
  isPinPending = false,
  showRenameButton = true,
  showAuditLogButton = true,
  showTerminalButton = true,
  isTerminalDisabled = false,
  showDeleteButton = true,
  workspaceActions,
  sessionFilesActions,
  actions,
  onTogglePin,
  onOpenAuditLog,
  onOpenTerminal,
  onTitleDraftChange,
  onTitleInputKeyDown,
  onSaveTitle,
  onCancelTitleEdit,
  onStartTitleEdit,
  onDeleteSession,
}: SessionHeaderProps) {
  const sessionActionsRef = useRef<HTMLDetailsElement | null>(null);
  const sessionActionsTriggerRef = useRef<HTMLElement | null>(null);
  const [isSessionActionsOpen, setIsSessionActionsOpen] = useState(false);

  useEffect(() => {
    if (!isSessionActionsOpen) {
      return;
    }

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target && !sessionActionsRef.current?.contains(event.target as Node)) {
        setIsSessionActionsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
  }, [isSessionActionsOpen]);

  const runSessionAction = (action: () => void) => {
    setIsSessionActionsOpen(false);
    action();
  };

  return (
    <header className="session-window-bar session-top-bar rise-1">
      <div className={`session-top-bar-row${isEditingTitle ? " is-editing-title" : ""}`}>
        {!isEditingTitle ? (
          <div className="session-title-shell">
            <span className="session-window-title session-title-accent">{taskTitle}</span>
          </div>
        ) : (
          <>
            <label className="session-title-editor">
              <input
                aria-label="Session title"
                value={titleDraft}
                onChange={(event) => onTitleDraftChange(event.target.value)}
                onKeyDown={onTitleInputKeyDown}
              />
            </label>
            <div className="session-title-actions">
              <button className="drawer-toggle compact" type="button" onClick={onSaveTitle}>
                Save
              </button>
              <button className="drawer-toggle compact secondary" type="button" onClick={onCancelTitleEdit}>
                Cancel
              </button>
            </div>
          </>
        )}
        {!isEditingTitle ? (
          <div className="session-window-controls">
            {workspaceActions || showTerminalButton ? (
              <div className="session-window-control-group" role="group" aria-label="Workspace actions">
                <span className="session-window-control-group-label">Workspace</span>
                {workspaceActions}
                {showTerminalButton ? (
                  <button
                    className="drawer-toggle compact secondary"
                    type="button"
                    onClick={onOpenTerminal}
                    disabled={isTerminalDisabled}
                  >
                    Terminal
                  </button>
                ) : null}
              </div>
            ) : null}
            {sessionFilesActions ? (
              <div className="session-window-control-group" role="group" aria-label="Session files actions">
                <span className="session-window-control-group-label">Session</span>
                {sessionFilesActions}
              </div>
            ) : null}
            {actions}
            {onTogglePin || showRenameButton || showAuditLogButton || showDeleteButton ? (
              <details
                ref={sessionActionsRef}
                className="session-header-more"
                open={isSessionActionsOpen}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !isSessionActionsOpen) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  setIsSessionActionsOpen(false);
                  sessionActionsTriggerRef.current?.focus();
                }}
              >
                <summary
                  ref={sessionActionsTriggerRef}
                  aria-label="Session actions"
                  aria-haspopup="menu"
                  aria-expanded={isSessionActionsOpen}
                  title="Session actions"
                  onClick={(event) => {
                    event.preventDefault();
                    setIsSessionActionsOpen((open) => !open);
                  }}
                >
                  ⋯
                </summary>
                <div className="session-header-more-menu" role="menu">
                  {onTogglePin ? (
                    <button
                      className={`session-pin-toggle${isPinned ? " is-active" : ""}`}
                      type="button"
                      role="menuitem"
                      aria-pressed={isPinned}
                      onClick={() => runSessionAction(onTogglePin)}
                      disabled={isPinPending}
                    >
                      {isPinPending ? "変更中..." : isPinned ? "ピン解除" : "ピン止め"}
                    </button>
                  ) : null}
                  {showRenameButton ? (
                    <button type="button" role="menuitem" onClick={() => runSessionAction(onStartTitleEdit)} disabled={isRunning || isReadOnly}>
                      Rename
                    </button>
                  ) : null}
                  {showAuditLogButton ? (
                    <button type="button" role="menuitem" onClick={() => runSessionAction(onOpenAuditLog)}>
                      Audit Log
                    </button>
                  ) : null}
                  {showDeleteButton ? (
                    <button className="danger" type="button" role="menuitem" onClick={() => runSessionAction(onDeleteSession)} disabled={isRunning}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function liveBackgroundTaskToneClassName(status: LiveBackgroundTask["status"]): string {
  switch (status) {
    case "running":
      return "in_progress";
    case "failed":
      return "failed";
    case "completed":
    default:
      return "completed";
  }
}

type SessionHeaderHandleProps = {
  taskTitle: string;
  onClick: () => void;
};

export function SessionHeaderHandle({ taskTitle, onClick }: SessionHeaderHandleProps) {
  return (
    <button className="session-header-handle" type="button" onClick={onClick}>
      <span className="session-window-title session-title-accent">{taskTitle}</span>
    </button>
  );
}

export const SESSION_RIGHT_PANE_ID = "session-right-pane";
export const SESSION_LEFT_PANE_ID = "session-left-pane";
export const SESSION_HEADER_DOCK_ID = "session-header-dock";
export const SESSION_ACTION_DOCK_ID = "session-action-dock";

export type SessionChatScreenProps = {
  mode: ChatWindowModeKind;
  className?: string;
  style?: CSSProperties;
  header: ReactNode;
  headerSplitter: ReactNode;
  isHeaderVisible: boolean;
  messageColumn: ReactNode;
  mainContent?: ReactNode;
  workSurfaceOverlay?: ReactNode;
  supportingSurface?: ReactNode;
  errorSurface?: ReactNode;
  recoveryActions?: ReactNode;
  actionDock: ReactNode;
  actionDockSplitter: ReactNode;
  isActionDockExpanded: boolean;
  layoutPriority: ChatLayoutPriority;
  leftPane?: ReactNode;
  leftSplitter?: ReactNode;
  rightPane: ReactNode;
  splitter: ReactNode;
  isRightPaneVisible?: boolean;
  isLeftPaneVisible?: boolean;
  layoutRef?: RefObject<HTMLDivElement | null>;
  headerDockRef?: RefObject<HTMLDivElement | null>;
  actionDockRef?: RefObject<HTMLDivElement | null>;
  workbenchRef?: RefObject<HTMLDivElement | null>;
  workbenchStyle?: CSSProperties;
  modals?: ReactNode;
};

const SelectionActionOverlayContext = createContext<HTMLDivElement | null>(null);

function SelectionActionOverlayBoundary({ children }: { children: ReactNode }) {
  const [overlayElement, setOverlayElement] = useState<HTMLDivElement | null>(null);

  return (
    <SelectionActionOverlayContext.Provider value={overlayElement}>
      {children}
      <div
        ref={setOverlayElement}
        className="session-selection-action-overlay"
      />
    </SelectionActionOverlayContext.Provider>
  );
}

export function SessionChatScreen({
  mode,
  className = "",
  style,
  header,
  headerSplitter,
  isHeaderVisible,
  messageColumn,
  mainContent,
  workSurfaceOverlay = null,
  supportingSurface = null,
  errorSurface = null,
  recoveryActions = null,
  actionDock,
  actionDockSplitter,
  isActionDockExpanded,
  layoutPriority,
  leftPane = null,
  leftSplitter = null,
  rightPane,
  splitter,
  isRightPaneVisible = true,
  isLeftPaneVisible = false,
  layoutRef,
  headerDockRef,
  actionDockRef,
  workbenchRef,
  workbenchStyle,
  modals,
}: SessionChatScreenProps) {
  const setLayoutElementRefs = useCallback((node: HTMLDivElement | null) => {
    if (layoutRef) {
      layoutRef.current = node;
    }
    if (workbenchRef) {
      workbenchRef.current = node;
    }
  }, [layoutRef, workbenchRef]);
  const layoutStyle = useMemo(() => ({ ...style, ...workbenchStyle }), [style, workbenchStyle]);

  return (
    <div
      ref={setLayoutElementRefs}
      className={`page-shell session-page session-chat-layout layout-priority-${
        layoutPriority === "side-pane-first" ? "side-pane" : "dock"
      }${isHeaderVisible ? " is-header-visible" : ""}${
        isActionDockExpanded ? " is-action-dock-expanded" : ""
      }${isLeftPaneVisible ? " is-left-pane-visible" : ""}${
        isRightPaneVisible ? " is-right-pane-visible" : ""
      }${className ? ` ${className}` : ""}`}
      style={layoutStyle}
      data-session-mode={mode}
    >
      <SelectionActionOverlayBoundary>
      <div
        id={SESSION_HEADER_DOCK_ID}
        ref={headerDockRef}
        className={`session-header-dock-slot${isHeaderVisible ? "" : " is-hidden"}`}
        aria-hidden={!isHeaderVisible}
      >
        {header}
      </div>

      {headerSplitter}

      <div
        id={SESSION_LEFT_PANE_ID}
        className={`session-left-pane-slot${isLeftPaneVisible ? "" : " is-hidden"}`}
        aria-hidden={!isLeftPaneVisible}
        inert={!isLeftPaneVisible}
      >
        {leftPane}
      </div>

      {leftSplitter}
      <section className="chat-panel session-work-surface session-message-stack rise-3">
        <div className="session-central-surface" hidden={mainContent !== undefined}>
          {messageColumn}
        </div>
        <div className="session-central-surface" hidden={mainContent === undefined}>
          {mainContent}
        </div>
        {workSurfaceOverlay}
        {supportingSurface}
        {recoveryActions ? (
          <div className="session-recovery-actions-slot">
            {recoveryActions}
          </div>
        ) : null}
        {errorSurface}
      </section>

      {splitter}
      <div
        id={SESSION_RIGHT_PANE_ID}
        className={`session-right-pane-slot${isRightPaneVisible ? "" : " is-hidden"}`}
        aria-hidden={!isRightPaneVisible}
        inert={!isRightPaneVisible}
      >
        {rightPane}
      </div>

      {actionDockSplitter}
      <div
        id={SESSION_ACTION_DOCK_ID}
        ref={actionDockRef}
        className={`session-action-dock-slot${isActionDockExpanded ? " is-expanded" : " is-compact"}`}
      >
        {actionDock}
      </div>

      {modals}
      </SelectionActionOverlayBoundary>
    </div>
  );
}

export function SessionDiffModal({
  selectedDiff,
  themeStyle,
  onClose,
  onOpenDiffWindow,
}: SessionDiffModalProps) {
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: !!selectedDiff,
    onClose,
  });

  if (!selectedDiff) {
    return null;
  }

  return (
    <div className="diff-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="diff-editor panel theme-accent"
        style={themeStyle}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="diff-titlebar">
          <h2>{selectedDiff.file.path}</h2>
          <div className="diff-titlebar-actions">
            <button className="diff-close diff-popout" type="button" onClick={() => onOpenDiffWindow(selectedDiff)}>
              Open In Window
            </button>
            <button className="diff-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <DiffViewer file={selectedDiff.file} />
      </section>
    </div>
  );
}

export type SessionAuditLogModalProps = {
  open: boolean;
  entries: AuditLogSummary[];
  sourceLabel?: string;
  details: Record<number, {
    detail: AuditLogDetailFragment | null;
    loadedSections: Partial<Record<AuditLogDetailSection, boolean>>;
    loadingSections: Partial<Record<AuditLogDetailSection, boolean>>;
    loadingStartedAtMs?: Partial<Record<AuditLogDetailSection, number>>;
    errorMessages: Partial<Record<AuditLogDetailSection, string>>;
  }>;
  operationDetails: Record<string, {
    detail: { details: string } | null;
    loading: boolean;
    errorMessage: string | null;
  }>;
  hasMore: boolean;
  loadingMore: boolean;
  total: number;
  errorMessage: string | null;
  onLoadMore: () => void;
  onLoadDetail: (entry: AuditLogSummary, section: AuditLogDetailSection) => void;
  onLoadOperationDetail: (entry: AuditLogSummary, operationIndex: number) => void;
  onClose: () => void;
};

export function SessionAuditLogModal({
  open,
  entries,
  sourceLabel,
  details,
  operationDetails,
  hasMore,
  loadingMore,
  total,
  errorMessage,
  onLoadMore,
  onLoadDetail,
  onLoadOperationDetail,
  onClose,
}: SessionAuditLogModalProps) {
  const [activeSection, setActiveSection] = useState<"main" | "background">("main");
  const [openAuditLogFolds, setOpenAuditLogFolds] = useState<Record<string, boolean>>({});
  const auditLogListRef = useRef<HTMLDivElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({ open, onClose });
  const mainEntries = useMemo(
    () => entries.filter((entry) => !isBackgroundAuditPhase(entry.phase)),
    [entries],
  );
  const backgroundEntries = useMemo(
    () => entries.filter((entry) => isBackgroundAuditPhase(entry.phase)),
    [entries],
  );
  const auditLogFoldKeyPrefixes = useMemo(
    () => new Set(entries.map((entry) => `${entry.sessionId}:${entry.id}:`)),
    [entries],
  );
  const visibleEntries = activeSection === "main" ? mainEntries : backgroundEntries;

  const isAuditLogFoldOpen = (entry: AuditLogSummary, section: AuditLogFoldSection) =>
    Boolean(openAuditLogFolds[auditLogFoldKey(entry, section)]);

  const handleAuditLogFoldToggle = (
    entry: AuditLogSummary,
    section: AuditLogFoldSection,
    openFold: boolean,
  ) => {
    setOpenAuditLogFolds((current) => {
      const key = auditLogFoldKey(entry, section);
      if (openFold) {
        if (current[key]) {
          return current;
        }
        return { ...current, [key]: true };
      }

      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });

    if (
      openFold
      && shouldLoadAuditLogDetailForFold(section)
      && !details[entry.id]?.loadedSections[section]
      && !details[entry.id]?.loadingSections[section]
    ) {
      onLoadDetail(entry, section);
    }
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const listNode = auditLogListRef.current;
    if (!listNode) {
      return;
    }

    listNode.scrollTop = 0;
  }, [activeSection, open]);

  useLayoutEffect(() => {
    if (!open) {
      setOpenAuditLogFolds({});
    }
  }, [open]);

  useEffect(() => {
    setOpenAuditLogFolds((current) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(current)) {
        const entryStillVisible = Array.from(auditLogFoldKeyPrefixes).some((prefix) => key.startsWith(prefix));
        if (entryStillVisible) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [auditLogFoldKeyPrefixes]);

  useEffect(() => {
    if (!open) {
      return;
    }

    for (const entry of visibleEntries) {
      if (!entry.detailAvailable) {
        continue;
      }

      const detailState = details[entry.id];
      for (const section of AUDIT_LOG_AUTO_LOAD_SECTIONS) {
        if (
          openAuditLogFolds[auditLogFoldKey(entry, section)]
          && !detailState?.loadedSections[section]
          && !detailState?.loadingSections[section]
        ) {
          onLoadDetail(entry, section);
        }
      }
    }
  }, [details, onLoadDetail, open, openAuditLogFolds, visibleEntries]);

  if (!open) {
    return null;
  }

  return (
    <div className="diff-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="audit-log-panel panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="diff-titlebar">
          <h2>Audit Log</h2>
        </div>

        <div className="audit-log-toolbar">
          <div className="audit-log-segmented" aria-label="監査ログ表示切り替え">
            <button
              type="button"
              className={`audit-log-segmented-button${activeSection === "main" ? " is-active" : ""}`}
              onClick={() => setActiveSection("main")}
            >
              Main
            </button>
            <button
              type="button"
              className={`audit-log-segmented-button${activeSection === "background" ? " is-active" : ""}`}
              onClick={() => setActiveSection("background")}
            >
              Background
            </button>
          </div>
          <div className="audit-log-page-status">
            <span>{entries.length} / {total}</span>
            {errorMessage ? <span className="audit-log-page-error">{errorMessage}</span> : null}
          </div>
        </div>

        <div ref={auditLogListRef} className="audit-log-list">
          {visibleEntries.length > 0 ? (
            <div className="audit-log-list-window">
              <div className="audit-log-list-window-items">
                {visibleEntries.map((entry) => {
              const detailState = details[entry.id];
              const detail = detailState?.detail ?? null;
              const operations = detail?.operations ?? entry.operations;
              const assistantText = detail?.assistantText ?? entry.assistantTextPreview;
              const interimMessages = detail?.interimMessages ?? [];
              const usage = entry.usage;
              const errorMessage = entry.errorMessage;
              const sectionLoading = (section: AuditLogDetailSection) => Boolean(detailState?.loadingSections[section]);
              const sectionError = (section: AuditLogDetailSection) => detailState?.errorMessages[section] ?? null;
              const operationDetailState = (operationIndex: number) =>
                operationDetails[auditLogOperationDetailFoldKey(entry, operationIndex)] ?? null;
              const logicalOpen = isAuditLogFoldOpen(entry, "logical");
              const transportOpen = isAuditLogFoldOpen(entry, "transport");
              const responseOpen = isAuditLogFoldOpen(entry, "response");
              const operationsOpen = isAuditLogFoldOpen(entry, "operations");
              const usageOpen = isAuditLogFoldOpen(entry, "usage");
              const errorOpen = isAuditLogFoldOpen(entry, "error");
              const rawOpen = isAuditLogFoldOpen(entry, "raw");
              const logicalSystemOpen = Boolean(openAuditLogFolds[auditLogLogicalPromptFieldFoldKey(entry, "system")]);
              const logicalInputOpen = Boolean(openAuditLogFolds[auditLogLogicalPromptFieldFoldKey(entry, "input")]);
              const logicalComposedOpen = Boolean(openAuditLogFolds[auditLogLogicalPromptFieldFoldKey(entry, "composed")]);
              const displayedOperations = entry.detailAvailable
                ? operationsOpen
                  ? operations.slice(0, AUDIT_LOG_OPERATION_RENDER_LIMIT)
                  : []
                : operations.slice(0, AUDIT_LOG_OPERATION_RENDER_LIMIT);
              const hiddenOperationCount = Math.max(0, operations.length - displayedOperations.length);

              return (
                <article key={entry.id} className={`audit-log-card ${entry.phase}`}>
                <div className="audit-log-head">
                  <span className={`file-kind ${
                    entry.phase === "completed"
                      ? "add"
                      : entry.phase === "failed"
                        ? "delete"
                        : entry.phase === "canceled"
                          ? "edit"
                          : "edit"
                  }`}>
                    {auditPhaseLabel(entry.phase)}
                  </span>
                  {sourceLabel ? <span className="audit-log-source-tag">{sourceLabel}</span> : null}
                  <span className="audit-log-time">{entry.createdAt}</span>
                </div>

                <div className="audit-log-meta">
                  <span>{entry.provider}</span>
                  <span>{entry.model}</span>
                  <span>{entry.reasoningEffort}</span>
                  <span>{displayApprovalValue(entry.approvalMode)}</span>
                </div>

                {!entry.detailAvailable ? (
                  <section className="audit-log-section audit-log-live-preview" aria-label="Live preview">
                    <p className="audit-log-empty">
                      Live preview only. Persisted audit log detail is not available yet.
                    </p>
                    {assistantText ? (
                      <pre>{previewAuditLogText(assistantText)}</pre>
                    ) : null}
                    {operations.length > 0 ? (
                      <ul className="audit-log-operations">
                        {displayedOperations.map((operation, index) => (
                          <li key={`${entry.id}-${operation.type}-${index}`}>
                            <div className="audit-log-operation-head">
                              <span>{operation.type}</span>
                              <strong>{operation.summary}</strong>
                            </div>
                            {operation.details ? <pre>{previewAuditLogText(operation.details)}</pre> : null}
                          </li>
                        ))}
                        {hiddenOperationCount > 0 ? (
                          <li className="audit-log-operation-more">
                            {hiddenOperationCount} more operations hidden for performance
                          </li>
                        ) : null}
                      </ul>
                    ) : null}
                    {usage ? (
                      <div className="audit-log-meta">
                        <span>input {usage.inputTokens}</span>
                        <span>cached {usage.cachedInputTokens}</span>
                        <span>output {usage.outputTokens}</span>
                      </div>
                    ) : null}
                    {errorMessage ? <pre>{previewAuditLogText(errorMessage)}</pre> : null}
                  </section>
                ) : (
                  <>
                <details
                  className="audit-log-fold"
                  open={logicalOpen}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "logical", event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Logical Prompt</strong>
                  </summary>
                  {logicalOpen ? <section className="audit-log-section">
                    {detail?.logicalPrompt ? (
                      <div className="audit-log-logical-fields">
                        <AuditLogLogicalPromptFieldFold
                          entry={entry}
                          field="system"
                          label="System"
                          value={detail.logicalPrompt.systemText}
                          open={logicalSystemOpen}
                          setOpenAuditLogFolds={setOpenAuditLogFolds}
                        />
                        <AuditLogLogicalPromptFieldFold
                          entry={entry}
                          field="input"
                          label="Input"
                          value={detail.logicalPrompt.inputText}
                          open={logicalInputOpen}
                          setOpenAuditLogFolds={setOpenAuditLogFolds}
                        />
                        <AuditLogLogicalPromptFieldFold
                          entry={entry}
                          field="composed"
                          label="Composed"
                          value={detail.logicalPrompt.composedText}
                          open={logicalComposedOpen}
                          setOpenAuditLogFolds={setOpenAuditLogFolds}
                        />
                      </div>
                    ) : (
                      <p className="audit-log-empty">
                        {sectionLoading("logical")
                          ? "audit log detail を読み込んでるよ。"
                          : sectionError("logical") ?? "開くと audit log detail を読み込むよ。"}
                      </p>
                    )}
                  </section> : null}
                </details>

                <details
                  className="audit-log-fold"
                  open={transportOpen}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "transport", event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Transport Payload</strong>
                  </summary>
                  {transportOpen ? <section className="audit-log-section">
                    {detail?.transportPayload ? (
                      <>
                        <p><strong>{detail.transportPayload.summary || "transport payload"}</strong></p>
                        {detail.transportPayload.fields.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            {detail.transportPayload.fields.map((field, index) => (
                              <div key={`${entry.id}-${field.label}-${index}`} className="audit-log-transport-field">
                                <p><strong>{field.label}</strong></p>
                                <pre>{previewAuditLogText(field.value || "-")}</pre>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="audit-log-empty">記録された transport payload はまだないよ。</p>
                        )}
                      </>
                    ) : (
                      <p className="audit-log-empty">
                        {sectionLoading("transport")
                          ? "audit log detail を読み込んでるよ。"
                          : sectionError("transport") ?? "記録された transport payload はまだないよ。"}
                      </p>
                    )}
                  </section> : null}
                </details>

                <details
                  className="audit-log-fold"
                  open={responseOpen}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "response", event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Response</strong>
                  </summary>
                  {responseOpen ? <section className="audit-log-section">
                    {sectionLoading("response") ? (
                      <p className="audit-log-empty">audit log detail を読み込んでるよ。</p>
                    ) : sectionError("response") ? (
                      <p className="audit-log-empty">{sectionError("response")}</p>
                    ) : (
                      <>
                        <pre>{previewAuditLogText(assistantText || "-")}</pre>
                        {interimMessages.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            <p><strong>Interim Messages</strong></p>
                            {interimMessages.map((message) => (
                              <div key={`${entry.id}-interim-${message.seq}`} className="audit-log-transport-field">
                                <p><strong>#{message.seq + 1}</strong> <span>{message.createdAt}</span></p>
                                <pre>{previewAuditLogText(message.body || "-")}</pre>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </section> : null}
                </details>

                <details
                  className="audit-log-fold"
                  open={operationsOpen}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "operations", event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Operations</strong>
                  </summary>
                  {operationsOpen ? <section className="audit-log-section">
                    {sectionLoading("operations") ? (
                      <p className="audit-log-empty">audit log detail を読み込んでるよ。</p>
                    ) : sectionError("operations") ? (
                      <p className="audit-log-empty">{sectionError("operations")}</p>
                    ) : operations.length > 0 ? (
                      <ul className="audit-log-operations">
                        {displayedOperations.map((operation, index) => (
                          <li key={`${entry.id}-${operation.type}-${index}`}>
                            <div className="audit-log-operation-head">
                              <span>{operation.type}</span>
                              <strong>{operation.summary}</strong>
                            </div>
                            {operation.detailAvailable || operation.details ? (
                              <details
                                className="audit-log-operation-detail"
                                open={Boolean(openAuditLogFolds[auditLogOperationDetailFoldKey(entry, index)])}
                                onToggle={(event) => {
                                  const key = auditLogOperationDetailFoldKey(entry, index);
                                  const openFold = event.currentTarget.open;
                                  setOpenAuditLogFolds((current) => {
                                    if (openFold) {
                                      return current[key] ? current : { ...current, [key]: true };
                                    }
                                    if (!current[key]) {
                                      return current;
                                    }
                                    const next = { ...current };
                                    delete next[key];
                                    return next;
                                  });
                                  if (openFold && !operationDetailState(index)?.detail && !operationDetailState(index)?.loading) {
                                    onLoadOperationDetail(entry, index);
                                  }
                                }}
                              >
                                <summary>Details</summary>
                                {openAuditLogFolds[auditLogOperationDetailFoldKey(entry, index)] ? (
                                  operationDetailState(index)?.loading ? (
                                    <p className="audit-log-empty">operation detail を読み込んでるよ。</p>
                                  ) : operationDetailState(index)?.errorMessage ? (
                                    <p className="audit-log-empty">{operationDetailState(index)?.errorMessage}</p>
                                  ) : (
                                    <pre>{previewAuditLogText(operationDetailState(index)?.detail?.details ?? operation.details ?? "")}</pre>
                                  )
                                ) : null}
                              </details>
                            ) : null}
                          </li>
                        ))}
                        {hiddenOperationCount > 0 ? (
                          <li className="audit-log-operation-more">
                            {hiddenOperationCount} more operations hidden for performance
                          </li>
                        ) : null}
                      </ul>
                    ) : (
                      <p className="audit-log-empty">記録された操作はまだないよ。</p>
                    )}
                  </section> : null}
                </details>

                {usage ? (
                  <details
                    className="audit-log-fold compact"
                    open={usageOpen}
                    onToggle={(event) => {
                      handleAuditLogFoldToggle(entry, "usage", event.currentTarget.open);
                    }}
                  >
                    <summary>
                      <strong>Usage</strong>
                    </summary>
                    {usageOpen ? <section className="audit-log-section compact">
                      <div className="audit-log-meta">
                        <span>input {usage.inputTokens}</span>
                        <span>cached {usage.cachedInputTokens}</span>
                        <span>output {usage.outputTokens}</span>
                      </div>
                    </section> : null}
                  </details>
                ) : null}

                {errorMessage ? (
                  <details
                    className="audit-log-fold compact"
                    open={errorOpen}
                    onToggle={(event) => {
                      handleAuditLogFoldToggle(entry, "error", event.currentTarget.open);
                    }}
                  >
                    <summary>
                      <strong>Error</strong>
                    </summary>
                    {errorOpen ? <section className="audit-log-section compact">
                      <pre>{previewAuditLogText(errorMessage)}</pre>
                    </section> : null}
                  </details>
                ) : null}

                <details
                  className="audit-log-fold audit-log-raw"
                  open={rawOpen}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "raw", event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Raw Items</strong>
                  </summary>
                  {rawOpen ? (
                    <section className="audit-log-section compact">
                      <pre>{previewAuditLogText(detail?.rawItemsJson ?? (sectionLoading("raw") ? "loading..." : sectionError("raw") ?? "[]"))}</pre>
                      {(detail?.providerMetadata?.length ?? 0) > 0 ? (
                        <pre>{previewAuditLogText(JSON.stringify(detail?.providerMetadata ?? [], null, 2))}</pre>
                      ) : null}
                    </section>
                  ) : null}
                </details>
                  </>
                )}
                </article>
              );
                })}
              </div>
            </div>
          ) : null}
        </div>
        {hasMore ? (
          <button
            type="button"
            className="audit-log-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

export type SessionContextPaneProps = {
  activeContextPaneTab: ContextPaneTabKey;
  availableContextPaneTabs: ContextPaneTabKey[];
  contextPaneProjection: ContextPaneProjection;
  latestCommandView: LatestCommandView | null;
  runningDetailsEntries: RunningDetailsEntry[];
  liveRunReasoningText: string;
  backgroundTasks: LiveBackgroundTask[];
  companionGroupMonitorEntries: HomeMonitorEntry[];
  selectedSessionLiveRunErrorMessage: string;
  isSelectedSessionRunning: boolean;
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedSessionContextTelemetryProjection: SessionContextTelemetryProjection;
  contextEmptyText: string;
  latestCommandEmptyText?: string;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  rootWorkItem?: RootWorkItem | null;
  rootWorkItemHistory?: readonly { revision: number; eventType: string; occurredAt: string; summary?: string }[];
  rootWorkItemLoading?: boolean;
  rootWorkItemErrorMessage?: string | null;
  isRootWorkItemMutationPending?: boolean;
  onReviseRootWorkItem?: (input: {
    goal: string;
    scope: string;
    completionCriteria: string;
    authority: string;
    progressSummary: string;
    blockers: string[];
    nextAction: string;
  }) => void | Promise<void>;
  onHandoffRootWorkItem?: () => void | Promise<void>;
};

type SessionPaneErrorBoundaryProps = {
  children: ReactNode;
};

type SessionPaneErrorBoundaryState = {
  errorMessage: string | null;
  resetNonce: number;
};

export class SessionPaneErrorBoundary extends Component<
  SessionPaneErrorBoundaryProps,
  SessionPaneErrorBoundaryState
> {
  state: SessionPaneErrorBoundaryState = {
    errorMessage: null,
    resetNonce: 0,
  };

  static getDerivedStateFromError(error: Error): SessionPaneErrorBoundaryState {
    return {
      errorMessage: error.message || "右ペインの描画に失敗したよ。",
      resetNonce: 0,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Session pane render failed", error, errorInfo);
    getWithMateApi()?.reportRendererLog({
      level: "error",
      kind: "renderer.render-failed",
      message: "Session pane render failed",
      url: window.location.href,
      data: {
        boundary: "session-pane",
        componentStack: errorInfo.componentStack,
      },
      error: {
        name: error.name,
        message: error.message || "Session pane render failed",
        stack: error.stack,
      },
    });
  }

  private handleRetry = () => {
    this.setState((current) => ({
      errorMessage: null,
      resetNonce: current.resetNonce + 1,
    }));
  };

  private handleReload = () => {
    getWithMateApi()?.reportRendererLog({
      level: "warn",
      kind: "renderer.reload-requested",
      message: "Session pane reload requested from error boundary",
      url: window.location.href,
      data: { boundary: "session-pane" },
    });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <aside className="session-context-pane">
          <section className="command-monitor-shell" aria-label="right pane error">
            <div className="command-monitor-content">
              <div className="command-monitor-stack">
                <div className="command-monitor-card">
                  <div className="live-run-error-block" role="alert">
                    <strong>右ペイン描画エラー</strong>
                    <p className="live-run-error">{this.state.errorMessage}</p>
                    <div className="window-error-actions pane-error-actions">
                      <button type="button" onClick={this.handleRetry}>
                        右ペインを再描画
                      </button>
                      <button className="drawer-toggle secondary" type="button" onClick={this.handleReload}>
                        Window を再読み込み
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </aside>
      );
    }

    return <Fragment key={this.state.resetNonce}>{this.props.children}</Fragment>;
  }
}

function RootWorkItemPane({
  workItem,
  history,
  onRevise,
  onHandoff,
  loading,
  errorMessage,
  mutationPending,
}: {
  workItem: RootWorkItem;
  history: readonly { revision: number; eventType: string; occurredAt: string; summary?: string }[];
  onRevise?: SessionContextPaneProps["onReviseRootWorkItem"];
  onHandoff?: SessionContextPaneProps["onHandoffRootWorkItem"];
  loading: boolean;
  errorMessage: string | null;
  mutationPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    goal: workItem.goal,
    scope: workItem.scope,
    completionCriteria: workItem.completionCriteria,
    authority: workItem.authority,
    progressSummary: workItem.progressSummary,
    blockers: workItem.blockers.join("\n"),
    nextAction: workItem.nextAction,
  });
  useEffect(() => {
    if (editing) return;
    setDraft({
      goal: workItem.goal,
      scope: workItem.scope,
      completionCriteria: workItem.completionCriteria,
      authority: workItem.authority,
      progressSummary: workItem.progressSummary,
      blockers: workItem.blockers.join("\n"),
      nextAction: workItem.nextAction,
    });
  }, [editing, workItem]);
  const update = (key: keyof typeof draft, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const canMutate = isWorkItemActive(workItem.state);
  const canHandoff = canMutate
    && workItem.progressSummary.trim().length > 0
    && workItem.nextAction.trim().length > 0;
  return (
    <div className="command-monitor-card root-work-item-pane" aria-busy={loading || mutationPending}>
      <div className="command-monitor-card-head">
        <div className="command-monitor-meta">
          <span className={`live-run-step-status ${liveRunStepToneClassName(workItem.state)}`}>{workItem.state}</span>
          <span className="live-run-step-type">Root WorkItem</span>
          <span className="command-monitor-source">REV {workItem.revision}</span>
        </div>
        {onRevise && canMutate ? (
          <button type="button" className="drawer-toggle compact secondary" onClick={() => setEditing((value) => !value)} aria-expanded={editing} disabled={mutationPending}>
            {editing ? "閉じる" : "改訂"}
          </button>
        ) : null}
        {onHandoff && canMutate ? (
          <button
            type="button"
            className="drawer-toggle compact secondary"
            onClick={() => void onHandoff()}
            disabled={mutationPending || !canHandoff}
            title={canHandoff ? undefined : "progressSummaryとnextActionを改訂してから引き継ぎを記録します。"}
          >引き継ぎ</button>
        ) : null}
      </div>
      {errorMessage ? <p className="live-run-error" role="alert">{errorMessage}</p> : null}
      {editing && canMutate ? (
        <form onSubmit={(event) => { event.preventDefault(); void onRevise?.({ ...draft, blockers: draft.blockers.split("\n").map((value) => value.trim()).filter(Boolean) }); setEditing(false); }} className="root-work-item-edit-form">
          {(["goal", "scope", "completionCriteria", "authority", "progressSummary", "blockers", "nextAction"] as const).map((key) => (
            <label key={key}>{key}<textarea value={draft[key]} onChange={(event) => update(key, event.target.value)} rows={key === "goal" ? 2 : 1} /></label>
          ))}
          <button type="submit" className="session-send-button" disabled={mutationPending}>保存</button>
        </form>
      ) : (
        <div className="root-work-item-summary">
          <h3>{workItem.goal || "Root WorkItem"}</h3>
          {workItem.progressSummary ? <p><strong>progressSummary</strong> {workItem.progressSummary}</p> : null}
          {workItem.nextAction ? <p><strong>nextAction</strong> {workItem.nextAction}</p> : null}
          {workItem.blockers.length > 0 ? <p><strong>blockers</strong> {workItem.blockers.join(", ")}</p> : null}
          {workItem.scope ? <p><strong>scope</strong> {workItem.scope}</p> : null}
          {workItem.completionCriteria ? <p><strong>completionCriteria</strong> {workItem.completionCriteria}</p> : null}
        </div>
      )}
      {history.length > 0 ? (
        <details className="command-monitor-details root-work-item-history">
          <summary>履歴 ({history.length})</summary>
          <ol>{history.map((event) => <li key={`${event.revision}-${event.eventType}`}><strong>r{event.revision}</strong> {event.eventType} <time>{event.occurredAt}</time>{event.summary ? ` — ${event.summary}` : ""}</li>)}</ol>
        </details>
      ) : null}
    </div>
  );
}

export function SessionContextPane({
  activeContextPaneTab,
  availableContextPaneTabs,
  contextPaneProjection,
  latestCommandView,
  runningDetailsEntries,
  liveRunReasoningText,
  backgroundTasks,
  companionGroupMonitorEntries,
  selectedSessionLiveRunErrorMessage,
  isSelectedSessionRunning,
  isCopilotSession,
  selectedCopilotRemainingPercentLabel,
  selectedCopilotRemainingRequestsLabel,
  selectedCopilotQuotaResetLabel,
  selectedSessionContextTelemetry,
  selectedSessionContextTelemetryProjection,
  contextEmptyText,
  latestCommandEmptyText = "",
  onCycleContextPaneTab,
  onOpenCompanionReview,
  rootWorkItem = null,
  rootWorkItemHistory = [],
  rootWorkItemLoading = false,
  rootWorkItemErrorMessage = null,
  isRootWorkItemMutationPending = false,
  onReviseRootWorkItem,
  onHandoffRootWorkItem,
}: SessionContextPaneProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const taskEntries = backgroundTasks ?? [];
  const availableTabCount = availableContextPaneTabs.length;
  const canCycleContextPaneTab = availableTabCount > 1;
  const contentScrollKey = useMemo(() => {
    switch (activeContextPaneTab) {
      case "latest-command":
        return [
          latestCommandView?.status ?? "",
          latestCommandView?.summary ?? "",
          latestCommandView?.details?.length ?? 0,
          runningDetailsEntries
            .map((entry) => `${entry.id}:${entry.type}:${entry.status}:${entry.summary}:${entry.details?.length ?? 0}`)
            .join("\u001f"),
          selectedSessionLiveRunErrorMessage,
        ].join("|");
      case "tasks":
        return taskEntries
          .map((task) => `${task.id}:${task.kind}:${task.status}:${task.title}:${task.details?.length ?? 0}:${task.updatedAt}`)
          .join("|");
      case "reasoning":
        return `${isSelectedSessionRunning ? "running" : "idle"}:${liveRunReasoningText.length}`;
      case "companion-group":
        return companionGroupMonitorEntries
          .map((entry) => `${entry.kind}:${entry.session.id}:${entry.session.taskTitle}:${entry.state.kind}:${entry.state.label}:${entry.session.updatedAt}`)
          .join("|");
      case "work-item":
        return `${rootWorkItem?.id ?? ""}:${rootWorkItem?.revision ?? 0}:${rootWorkItem?.state ?? ""}`;
      default:
        return "";
    }
  }, [
    activeContextPaneTab,
    companionGroupMonitorEntries,
    latestCommandView,
    liveRunReasoningText,
    runningDetailsEntries,
    isSelectedSessionRunning,
    taskEntries,
    selectedSessionLiveRunErrorMessage,
    rootWorkItem,
  ]);

  const renderCompanionGroupMonitorEntry = (entry: Extract<HomeMonitorEntry, { kind: "companion" }>) => {
    const { session, state } = entry;
    const companionSessionCharacterName = session.character.trim() || "Mate";
    return (
      <button
        key={session.id}
        className="companion-group-monitor-item"
        type="button"
        onClick={() => onOpenCompanionReview(session.id)}
      >
        <CharacterAvatar
          character={{
            name: companionSessionCharacterName,
            iconPath: session.characterIconPath,
          }}
          size="tiny"
        />
        <div className="companion-group-monitor-copy">
          <strong>{session.taskTitle}</strong>
          <span>{companionSessionCharacterName}</span>
        </div>
        <div className="companion-group-monitor-badges">
          <span className={`session-status companion-group-monitor-status ${state.kind}`.trim()}>{state.label}</span>
        </div>
      </button>
    );
  };

  useLayoutEffect(() => {
    const contentNode = contentRef.current;
    if (!contentNode) {
      return;
    }

    contentNode.scrollTop = activeContextPaneTab === "companion-group"
      ? 0
      : contentNode.scrollHeight;
  }, [contentScrollKey]);

  return (
    <aside className="session-context-pane session-context-pane-header-expanded">
      <section className={`command-monitor-shell ${activeContextPaneTab}`} aria-label="右ペイン">
        <div className="command-monitor-head">
          <div className="command-monitor-switcher" aria-label="右ペイン表示切り替え">
            <button
              type="button"
              className="command-monitor-switcher-button"
              onClick={() => onCycleContextPaneTab(-1)}
              disabled={!canCycleContextPaneTab}
              aria-label="前の表示へ切り替え"
            >
              ‹
            </button>
            <div className={`command-monitor-switcher-current ${contextPaneProjection.toneClassName}`}>
              <span className="command-monitor-switcher-label">
                {contextPaneTabLabel(activeContextPaneTab)}
              </span>
            </div>
            <button
              type="button"
              className="command-monitor-switcher-button"
              onClick={() => onCycleContextPaneTab(1)}
              disabled={!canCycleContextPaneTab}
              aria-label="次の表示へ切り替え"
            >
              ›
            </button>
          </div>
        </div>

        <div ref={contentRef} className="command-monitor-content">
          <div className={`command-monitor-stack ${activeContextPaneTab}`}>
            {activeContextPaneTab === "latest-command" && runningDetailsEntries.length > 0 ? (
              <div className="command-monitor-card">
                <div className="command-monitor-card-head">
                  <div className="command-monitor-meta">
                    <span className="live-run-step-type">Details</span>
                    <span className="command-monitor-source">CONFIRMED</span>
                  </div>
                </div>

                <div className="command-monitor-confirmed-list">
                  {runningDetailsEntries.map((entry) => (
                    <article key={entry.id} className="command-monitor-confirmed-item">
                      <div className="command-monitor-card-head compact">
                        <div className="command-monitor-meta">
                          <span className={`live-run-step-status ${liveRunStepToneClassName(entry.status)}`}>
                            {liveRunStepStatusLabel(entry.status)}
                          </span>
                          <span className="live-run-step-type">{operationTypeLabel(entry.type)}</span>
                        </div>
                      </div>

                      {entry.type === "command_execution" ? (
                        <div className="live-run-command-summary compact" aria-label="確定した command">
                          <span className="live-run-command-prefix" aria-hidden="true">$</span>
                          <code className="live-run-command-text">{entry.summary}</code>
                        </div>
                      ) : (
                        <p className="command-monitor-confirmed-summary">{entry.summary}</p>
                      )}

                      {entry.details ? (
                        <details className="command-monitor-details live-run-step-details">
                          <summary>{liveRunStepDetailsLabel(entry.type)}</summary>
                          <pre>{entry.details}</pre>
                        </details>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            {activeContextPaneTab === "latest-command" ? (
              latestCommandView ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${contextPaneProjection.latestCommandToneClassName}`}>{contextPaneProjection.latestCommandStatusLabel}</span>
                      <span className="live-run-step-type">Command</span>
                      <span className="command-monitor-source">{contextPaneProjection.latestCommandSourceCopy}</span>
                    </div>
                    {latestCommandView.riskLabels.length > 0 ? (
                      <div className="command-monitor-risk-list" aria-label="command risk">
                        {latestCommandView.riskLabels.map((label) => (
                          <span key={label} className={`command-monitor-risk ${label.toLowerCase()}`}>
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="live-run-command-summary" aria-label="実行コマンド">
                    <span className="live-run-command-prefix" aria-hidden="true">
                      $
                    </span>
                    <code className="live-run-command-text">{latestCommandView.summary}</code>
                  </div>

                  {latestCommandView.details ? (
                    <details className="command-monitor-details live-run-step-details">
                      <summary>command_execution の詳細</summary>
                      <pre>{latestCommandView.details}</pre>
                    </details>
                  ) : null}

                  {selectedSessionLiveRunErrorMessage && isSelectedSessionRunning ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>実行エラー</strong>
                      <p className="live-run-error">{selectedSessionLiveRunErrorMessage}</p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="command-monitor-empty-shell">
                  {latestCommandEmptyText.trim() ? (
                    <p className="provider-context-empty">{latestCommandEmptyText}</p>
                  ) : null}
                  {selectedSessionLiveRunErrorMessage ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>実行エラー</strong>
                      <p className="live-run-error">{selectedSessionLiveRunErrorMessage}</p>
                    </div>
                  ) : null}
                </div>
              )
            ) : null}

            {activeContextPaneTab === "tasks" ? (
              taskEntries.length > 0 ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className="live-run-step-type">Tasks</span>
                      <span className="command-monitor-source">COPILOT</span>
                    </div>
                  </div>

                  <div className="command-monitor-confirmed-list">
                    {taskEntries.map((task) => (
                      <article key={task.id} className="command-monitor-confirmed-item">
                        <div className="command-monitor-card-head compact">
                          <div className="command-monitor-meta">
                            <span className={`live-run-step-status ${liveBackgroundTaskToneClassName(task.status)}`}>
                              {sessionBackgroundActivityStatusLabel(task.status)}
                            </span>
                            <span className="live-run-step-type">{task.kind === "agent" ? "Agent" : "Shell"}</span>
                          </div>
                        </div>
                        <p className="command-monitor-confirmed-summary">{task.title}</p>
                        {task.details ? (
                          <details className="command-monitor-details live-run-step-details">
                            <summary>task details</summary>
                            <pre>{task.details}</pre>
                          </details>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="command-monitor-empty-shell">
                  <p className="command-monitor-empty">まだ background task はないよ。</p>
                  <p className="command-monitor-empty-subtle">Copilot の sub-agent や background shell がある時だけここへ出るよ。</p>
                </div>
              )
            ) : null}

            {activeContextPaneTab === "reasoning" ? (
              liveRunReasoningText.trim().length > 0 ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${contextPaneProjection.reasoningToneClassName}`}>
                        {isSelectedSessionRunning ? "実行中" : "保持中"}
                      </span>
                      <span className="live-run-step-type">Reasoning</span>
                      <span className="command-monitor-source">
                        {isSelectedSessionRunning ? "RUN LIVE" : "LAST RUN"}
                      </span>
                    </div>
                  </div>
                  <div className="command-monitor-details live-run-step-details live-reasoning-details">
                    <pre>{liveRunReasoningText}</pre>
                  </div>
                </div>
              ) : (
                <div className="command-monitor-empty-shell">
                  <p className="command-monitor-empty">まだ Reasoning はないよ。</p>
                </div>
              )
            ) : null}

            {activeContextPaneTab === "companion-group" ? (
              companionGroupMonitorEntries.length > 0 ? (
                <div className="command-monitor-confirmed-list">
                  {companionGroupMonitorEntries
                    .filter((entry): entry is Extract<HomeMonitorEntry, { kind: "companion" }> => entry.kind === "companion")
                    .map(renderCompanionGroupMonitorEntry)}
                </div>
              ) : (
                <div className="command-monitor-empty-shell">
                  <p className="command-monitor-empty">同じ CompanionGroup の session はないよ。</p>
                  <p className="command-monitor-empty-subtle">同じ repository の Companion がある時だけここへ出るよ。</p>
                </div>
              )
            ) : null}

            {activeContextPaneTab === "work-item" && rootWorkItem ? (
              <RootWorkItemPane
                workItem={rootWorkItem}
                history={rootWorkItemHistory}
                onRevise={onReviseRootWorkItem}
                onHandoff={onHandoffRootWorkItem}
                loading={rootWorkItemLoading}
                errorMessage={rootWorkItemErrorMessage}
                mutationPending={isRootWorkItemMutationPending}
              />
            ) : null}

          </div>
        </div>
      </section>

      {isCopilotSession ? (
        <section className="provider-usage-shell" aria-label="Copilot usage">
          <div className="provider-usage-strip">
            <div className="provider-usage-strip-copy">
              <span className="provider-usage-label">Copilot Usage</span>
              <strong>{selectedCopilotRemainingPercentLabel}</strong>
            </div>
            <span className="provider-usage-pill">
              {selectedCopilotRemainingRequestsLabel}
            </span>
          </div>

          <details className="provider-context-details">
            <summary>
              <span>Context</span>
              <span className="provider-context-summary-value">
                {selectedSessionContextTelemetryProjection.summaryLabel}
              </span>
            </summary>
            {selectedSessionContextTelemetry ? (
              <div className="provider-context-grid">
                <div className="provider-context-item">
                  <span>Current</span>
                  <strong>{selectedSessionContextTelemetryProjection.currentTokensLabel}</strong>
                </div>
                <div className="provider-context-item">
                  <span>Limit</span>
                  <strong>{selectedSessionContextTelemetryProjection.tokenLimitLabel}</strong>
                </div>
                <div className="provider-context-item">
                  <span>Messages</span>
                  <strong>{selectedSessionContextTelemetryProjection.messagesLengthLabel}</strong>
                </div>
                <div className="provider-context-item">
                  <span>System</span>
                  <strong>{selectedSessionContextTelemetryProjection.systemTokensLabel}</strong>
                </div>
                <div className="provider-context-item wide">
                  <span>Conversation</span>
                  <strong>{selectedSessionContextTelemetryProjection.conversationTokensLabel}</strong>
                </div>
                <div className="provider-context-item wide">
                  <span>Reset</span>
                  <strong>{selectedCopilotQuotaResetLabel}</strong>
                </div>
              </div>
            ) : (
              <p className="provider-context-empty">{contextEmptyText}</p>
            )}
          </details>
        </section>
      ) : null}
    </aside>
  );
}

export type SessionRetryBannerProps = {
  retryBanner: {
    kind: "interrupted" | "failed" | "canceled";
    badge: string;
    title: string;
    lastRequestText: string;
    terminalFailureNotification?: import("./session-external-runtime-contract.js").SessionRuntimeTerminalFailureNotificationProjection | null;
  } | null;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
};

export function SessionRetryBanner({
  retryBanner,
  isRetryActionDisabled,
  isRetryEditDisabled,
  isRetryDraftReplacePending,
  onResendLastMessage,
  onEditLastMessage,
  onConfirmRetryDraftReplace,
  onCancelRetryDraftReplace,
}: SessionRetryBannerProps) {
  if (!retryBanner) {
    return null;
  }

  return (
    <section
      className={`resume-banner retry-banner ${retryBanner.kind}`}
      aria-label="完了できなかった依頼の操作"
    >
      <div className="resume-banner-head">
        <div className="resume-banner-copy">
          <span className={`resume-banner-badge ${retryBanner.kind}`} title={retryBanner.title}>
            {retryBanner.badge}
            <span className="sr-only">: {retryBanner.title}</span>
          </span>
        </div>
      </div>
      {retryBanner.terminalFailureNotification ? (
        <p className="resume-banner-notification-status" role="status">
          {terminalFailureNotificationLabel(retryBanner.terminalFailureNotification)}
        </p>
      ) : null}
      <div className="resume-banner-actions">
        <button type="button" onClick={onResendLastMessage} disabled={isRetryActionDisabled}>
          再送
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={onEditLastMessage}
          disabled={isRetryEditDisabled}
        >
          編集
        </button>
      </div>
      {isRetryDraftReplacePending ? (
        <div className="resume-banner-conflict">
          <p>今の下書きは残しています。</p>
          <div className="resume-banner-conflict-actions">
            <button type="button" onClick={onConfirmRetryDraftReplace} disabled={isRetryEditDisabled}>
              前回の依頼で置き換える
            </button>
            <button className="drawer-toggle secondary" type="button" onClick={onCancelRetryDraftReplace}>
              今の下書きを続ける
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function terminalFailureNotificationLabel(
  notification: NonNullable<SessionRetryBannerProps["retryBanner"]>["terminalFailureNotification"] & {},
): string {
  const target = `通知先 ${notification.targetSessionId}`;
  switch (notification.state) {
    case "armed":
      return `${target} · 失敗時に通知`;
    case "pending":
      return `${target} · 通知待機中`;
    case "enqueued":
      return `${target} · 通知を登録済み (${notification.notificationExecutionId ?? "execution不明"})`;
    case "failed":
      return `${target} · 通知失敗 (${notification.errorCode ?? "UNKNOWN"})`;
    case "not_triggered":
      return `${target} · 通知対象外`;
  }
}

export type SessionMessageColumnProps = {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  messageKeys?: string[];
  messageGroups?: Array<{
    id: string;
    label: string;
  } | null>;
  turnExecutions?: Array<SessionTurnExecutionProjection | null>;
  originSessionDetails?: readonly SessionOriginDetails[];
  onOpenOriginSession?: (sessionId: string) => void;
  cancelingExecutionIds?: ReadonlySet<string>;
  expandedArtifacts: Record<string, boolean>;
  messageListRef: RefObject<HTMLDivElement | null>;
  isRunning: boolean;
  liveApprovalRequest: LiveApprovalRequest | null;
  approvalActionRequestId: string | null;
  liveElicitationRequest: LiveElicitationRequest | null;
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  pendingMessageText?: string;
  pendingMessageGroupId?: string | null;
  isMessageListFollowing: boolean;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail?: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: (title: string, file: ChangedFile) => void;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
  getChangedFilesEmptyText: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  onCancelQueuedTurn?: (execution: SessionQueuedTurn) => void;
  isContentActive?: boolean;
  messageViewMode?: MessageViewMode;
};

export type SessionOriginDetails = RelatedSessionDetails;

function getNonBlankSelectionText(selection: Selection): string | null {
  const text = selection.toString();
  return text.trim() ? text : null;
}

function getSelectionDetailsWithinMessageList(element: Element | null): { anchorRect: DOMRect; text: string } | null {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const commonElement =
    commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor as Element
      : commonAncestor.parentElement;
  const messageBody = commonElement?.closest("[data-message-body='true']") ?? null;
  if (
    !messageBody ||
    !element.contains(messageBody) ||
    messageBody.getAttribute("data-message-text-actions") !== "true"
  ) {
    return null;
  }

  const text = getNonBlankSelectionText(selection);
  if (text === null) {
    return null;
  }

  const rangeRect = range.getBoundingClientRect();
  if (rangeRect.width > 0 || rangeRect.height > 0) {
    return { anchorRect: rangeRect, text };
  }

  const fallbackRect = range.getClientRects()[0] ?? null;
  return fallbackRect ? { anchorRect: fallbackRect, text } : null;
}

function clampToolbarPosition(input: {
  anchorRect: DOMRect;
  boundaryRect: DOMRect;
  toolbarRect: Pick<DOMRect, "width" | "height">;
  padding?: number;
}): CSSProperties {
  const padding = input.padding ?? 8;
  const toolbarWidth = input.toolbarRect.width || 112;
  const toolbarHeight = input.toolbarRect.height || 32;
  const preferredLeft = input.anchorRect.left + (input.anchorRect.width - toolbarWidth) / 2;
  const preferredTop =
    input.anchorRect.top - toolbarHeight - padding >= input.boundaryRect.top + padding
      ? input.anchorRect.top - toolbarHeight - padding
      : input.anchorRect.bottom + padding;
  const left = Math.min(
    input.boundaryRect.right - toolbarWidth - padding,
    Math.max(input.boundaryRect.left + padding, preferredLeft),
  );
  const top = Math.min(
    input.boundaryRect.bottom - toolbarHeight - padding,
    Math.max(input.boundaryRect.top + padding, preferredTop),
  );

  return { left, top };
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

type MessageResponseActionsProps = {
  actionText: string;
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  style?: CSSProperties;
  toolbarRef?: RefObject<HTMLDivElement | null>;
};

function MessageResponseActions({
  actionText,
  onCopyMessageText,
  onQuoteMessageText,
  style,
  toolbarRef,
}: MessageResponseActionsProps) {
  return (
    <div
      ref={toolbarRef}
      className="message-response-actions"
      aria-label="Response actions"
      style={style}
    >
      {onCopyMessageText ? (
        <button
          className="message-response-action"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCopyMessageText(actionText)}
        >
          Copy
        </button>
      ) : null}
      {onQuoteMessageText ? (
        <button
          className="message-response-action"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onQuoteMessageText(actionText)}
        >
          Quote
        </button>
      ) : null}
    </div>
  );
}

export type SelectionTextActionSurfaceProps = {
  children: ReactNode;
  className?: string;
  onCopyText: (text: string) => void;
  onQuoteText?: (text: string) => void;
  selectAllText?: string;
  surfaceRef?: RefObject<HTMLDivElement | null>;
};

export function SelectionTextActionSurface({
  children,
  className = "",
  onCopyText,
  onQuoteText,
  selectAllText,
  surfaceRef: externalSurfaceRef,
}: SelectionTextActionSurfaceProps) {
  const internalSurfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = externalSurfaceRef ?? internalSurfaceRef;
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const logicalSelectAllTextRef = useRef<string | null>(null);
  const [selectionToolbar, setSelectionToolbar] = useState<{ style: CSSProperties; text: string } | null>(null);

  const updateSelectionToolbar = useCallback(() => {
    const surface = surfaceRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!surface || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionToolbar(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const commonElement = commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor as Element
      : commonAncestor.parentElement;
    const selectableBody = commonElement?.closest("[data-selection-copy-body='true']") ?? null;
    const selectedText = logicalSelectAllTextRef.current ?? getNonBlankSelectionText(selection);
    if (!selectableBody || !surface.contains(selectableBody) || selectedText === null) {
      setSelectionToolbar(null);
      return;
    }

    const anchorRect = range.getBoundingClientRect();
    const fallbackRect = range.getClientRects()[0] ?? null;
    const resolvedAnchorRect = anchorRect.width > 0 || anchorRect.height > 0 ? anchorRect : fallbackRect;
    const boundaryRect = surface.getBoundingClientRect();
    if (!resolvedAnchorRect || !rectsIntersect(resolvedAnchorRect, boundaryRect)) {
      setSelectionToolbar(null);
      return;
    }

    setSelectionToolbar({
      text: selectedText,
      style: clampToolbarPosition({
        anchorRect: resolvedAnchorRect,
        boundaryRect,
        toolbarRect: toolbarRef.current?.getBoundingClientRect() ?? {
          width: onQuoteText ? 112 : 72,
          height: 32,
        },
      }),
    });
  }, [onQuoteText, surfaceRef]);

  const clearLogicalSelectAll = useCallback((clearBrowserSelection = false) => {
    const wasLogicalSelectAll = logicalSelectAllTextRef.current !== null;
    logicalSelectAllTextRef.current = null;
    if (wasLogicalSelectAll && clearBrowserSelection && typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const target = event.target;
    if (
      event.defaultPrevented ||
      !(event.ctrlKey || event.metaKey)
      || event.key.toLocaleLowerCase() !== "a"
      || (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']"))
    ) {
      return;
    }

    const surface = surfaceRef.current;
    const selectableBody = surface?.querySelector<HTMLElement>("[data-selection-copy-body='true']") ?? null;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!surface || !selectableBody || !selection) {
      return;
    }

    const resolvedText = selectAllText
      ?? (typeof selectableBody.innerText === "string" ? selectableBody.innerText : selectableBody.textContent ?? "");
    event.preventDefault();
    surface.focus({ preventScroll: true });
    clearLogicalSelectAll();
    selection.removeAllRanges();
    if (!resolvedText.trim()) {
      setSelectionToolbar(null);
      return;
    }

    logicalSelectAllTextRef.current = resolvedText;
    const range = document.createRange();
    range.selectNodeContents(selectableBody);
    selection.addRange(range);
    updateSelectionToolbar();
  }, [clearLogicalSelectAll, selectAllText, surfaceRef, updateSelectionToolbar]);

  const handleCopy = useCallback<ClipboardEventHandler<HTMLDivElement>>((event) => {
    const logicalText = logicalSelectAllTextRef.current;
    if (logicalText === null) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", logicalText);
  }, []);

  useEffect(() => {
    clearLogicalSelectAll();
    setSelectionToolbar(null);
  }, [clearLogicalSelectAll, selectAllText]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    document.addEventListener("selectionchange", updateSelectionToolbar);
    window.addEventListener("resize", updateSelectionToolbar);
    const surface = surfaceRef.current;
    surface?.addEventListener("scroll", updateSelectionToolbar, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", updateSelectionToolbar);
      window.removeEventListener("resize", updateSelectionToolbar);
      surface?.removeEventListener("scroll", updateSelectionToolbar);
    };
  }, [updateSelectionToolbar]);

  return (
    <div
      ref={surfaceRef}
      className={className}
      tabIndex={0}
      onCopy={handleCopy}
      onPointerDownCapture={(event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest(".message-response-actions")) {
          clearLogicalSelectAll();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          clearLogicalSelectAll(true);
          setSelectionToolbar(null);
        }
      }}
    >
      <div data-selection-copy-body="true">{children}</div>
      {selectionToolbar ? (
        <MessageResponseActions
          actionText={selectionToolbar.text}
          onCopyMessageText={onCopyText}
          onQuoteMessageText={onQuoteText}
          style={selectionToolbar.style}
          toolbarRef={toolbarRef}
        />
      ) : null}
    </div>
  );
}

export function SessionMessageColumn({
  sessionId,
  character,
  messages,
  messageKeys,
  messageGroups,
  turnExecutions,
  originSessionDetails = [],
  onOpenOriginSession,
  cancelingExecutionIds = new Set<string>(),
  expandedArtifacts,
  messageListRef,
  isRunning,
  liveApprovalRequest,
  approvalActionRequestId,
  liveElicitationRequest,
  elicitationActionRequestId,
  hasLiveRunAssistantText,
  liveRunErrorMessage,
  pendingMessageText = "",
  pendingMessageGroupId = null,
  isMessageListFollowing,
  onMessageListScroll,
  onToggleArtifact,
  onLoadArtifactDetail,
  onOpenDiff,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onOpenPath,
  getChangedFilesEmptyText,
  onCopyMessageText,
  onQuoteMessageText,
  onCancelQueuedTurn,
  isContentActive = true,
  messageViewMode = "preview",
}: SessionMessageColumnProps) {
  const selectionActionOverlay = useContext(SelectionActionOverlayContext);
  const [openArtifactFolds, setOpenArtifactFolds] = useState<Record<string, boolean>>({});
  const [loadedArtifactDetails, setLoadedArtifactDetails] = useState<Record<string, MessageArtifact>>({});
  const [loadingArtifactDetails, setLoadingArtifactDetails] = useState<Record<string, boolean>>({});
  const [selectionToolbar, setSelectionToolbar] = useState<{ style: CSSProperties; text: string } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [currentFindMatch, setCurrentFindMatch] = useState(0);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);
  const previousMessageViewModeRef = useRef(messageViewMode);
  const getMessageKey = useCallback(
    (index: number) => messageKeys?.[index] ?? `${sessionId}-${index}`,
    [messageKeys, sessionId],
  );
  const messageVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize: () => SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT,
    getItemKey: getMessageKey,
    overscan: SESSION_MESSAGE_OVERSCAN,
    anchorTo: isMessageListFollowing ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: SESSION_MESSAGE_SCROLL_END_THRESHOLD,
    initialRect: { width: 0, height: SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT },
    initialOffset: Math.max(
      0,
      messages.length * SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT - SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT,
    ),
    directDomUpdates: true,
    directDomUpdatesMode: "position",
  });
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    shouldAdjustSessionMessageScrollPosition({
      itemStart: item.start,
      scrollOffset: instance.scrollOffset ?? 0,
    })
  );
  const virtualMessages = messageVirtualizer.getVirtualItems();
  const hasPendingMessageText =
    !hasLiveRunAssistantText &&
    liveApprovalRequest === null &&
    liveElicitationRequest === null &&
    !liveRunErrorMessage.trim() &&
    pendingMessageText.trim().length > 0;
  const canUsePendingMessageTextActions = !!(onCopyMessageText || onQuoteMessageText);
  const hasFindQuery = findQuery.trim().length > 0;
  const messageRenderedSearchTexts = useMemo(
    () => (hasFindQuery
      ? messages.map((message) => (
          messageViewMode === "source"
            ? message.text
            : projectMessageRenderedSearchText(message.text)
        ))
      : []),
    [hasFindQuery, messageViewMode, messages],
  );
  const pendingRenderedSearchText = useMemo(
    () => (hasFindQuery && isRunning && hasPendingMessageText
      ? messageViewMode === "source"
        ? pendingMessageText
        : projectMessageRenderedSearchText(pendingMessageText)
      : ""),
    [hasFindQuery, hasPendingMessageText, isRunning, messageViewMode, pendingMessageText],
  );
  const hasPendingInlineContent =
    liveApprovalRequest !== null ||
    liveElicitationRequest !== null ||
    liveRunErrorMessage.trim().length > 0 ||
    hasPendingMessageText;
  const pendingMessageGroupEndIndex = useMemo(
    () => {
      if (!hasPendingInlineContent || pendingMessageGroupId === null) {
        return -1;
      }

      return messageGroups?.findIndex((messageGroup, index) => (
        messageGroup?.id === pendingMessageGroupId &&
        messageGroups[index + 1]?.id !== messageGroup.id
      )) ?? -1;
    },
    [hasPendingInlineContent, messageGroups, pendingMessageGroupId],
  );
  const firstQueuedTurnIndex = turnExecutions?.findIndex((execution) => execution?.state === "queued") ?? -1;
  const messageFindMatches = useMemo(() => {
    const matches: Array<
      | { kind: "message"; messageIndex: number; occurrenceIndex: number }
      | { kind: "pending"; occurrenceIndex: number }
    > = [];
    const pendingMatches = findTextMatches(pendingRenderedSearchText, findQuery);
    const appendPendingMatches = () => {
      pendingMatches.forEach((_, occurrenceIndex) => {
        matches.push({ kind: "pending", occurrenceIndex });
      });
    };
    messageRenderedSearchTexts.forEach((text, messageIndex) => {
      if (pendingMessageGroupEndIndex < 0 && messageIndex === firstQueuedTurnIndex) {
        appendPendingMatches();
      }
      findTextMatches(text, findQuery).forEach((_, occurrenceIndex) => {
        matches.push({ kind: "message", messageIndex, occurrenceIndex });
      });
      if (messageIndex === pendingMessageGroupEndIndex) {
        appendPendingMatches();
      }
    });
    if (pendingMessageGroupEndIndex < 0 && firstQueuedTurnIndex < 0) {
      appendPendingMatches();
    }
    return matches;
  }, [findQuery, firstQueuedTurnIndex, messageRenderedSearchTexts, pendingMessageGroupEndIndex, pendingRenderedSearchText]);
  const activeCurrentFindMatch = clampFindMatchIndex(currentFindMatch, messageFindMatches.length);
  const canRenderGroupedPendingInlineContent =
    pendingMessageGroupEndIndex >= 0 &&
    virtualMessages.some((virtualMessage) => virtualMessage.index === pendingMessageGroupEndIndex);
  const canRenderPendingBeforeQueuedTurn =
    pendingMessageGroupEndIndex < 0 &&
    firstQueuedTurnIndex >= 0 &&
    virtualMessages.some((virtualMessage) => virtualMessage.index === firstQueuedTurnIndex);
  const getFindMatchScrollIndex = useCallback((match: (typeof messageFindMatches)[number] | undefined) => {
    if (!match) {
      return null;
    }
    if (match.kind === "message") {
      return match.messageIndex;
    }
    if (pendingMessageGroupEndIndex >= 0) {
      return pendingMessageGroupEndIndex;
    }
    if (firstQueuedTurnIndex >= 0) {
      return firstQueuedTurnIndex;
    }
    return messages.length > 0 ? messages.length - 1 : null;
  }, [firstQueuedTurnIndex, messages.length, pendingMessageGroupEndIndex]);
  const firstFindScrollIndex = getFindMatchScrollIndex(messageFindMatches[0]);

  useEffect(() => {
    if (previousMessageViewModeRef.current === messageViewMode) {
      return;
    }
    previousMessageViewModeRef.current = messageViewMode;
    setSelectionToolbar(null);
  }, [messageViewMode]);

  const handleMessageListScroll: UIEventHandler<HTMLDivElement> = (event) => {
    onMessageListScroll(event);
  };

  const updateSelectionToolbar = useCallback(() => {
    const messageListElement = messageListRef.current;
    const selectionDetails = getSelectionDetailsWithinMessageList(messageListElement);
    const sourceRect = messageListElement?.getBoundingClientRect() ?? null;
    const overlayRect = selectionActionOverlay?.getBoundingClientRect() ?? null;
    const actionDockRect = document.getElementById(SESSION_ACTION_DOCK_ID)?.getBoundingClientRect() ?? null;
    const toolbarRect =
      selectionToolbarRef.current?.getBoundingClientRect() ??
      { width: 112, height: 32 };
    if (
      !selectionDetails ||
      !sourceRect ||
      !overlayRect ||
      !rectsIntersect(selectionDetails.anchorRect, sourceRect)
    ) {
      setSelectionToolbar(null);
      return;
    }

    const style = resolveSelectionActionOverlayPosition({
      actionDockRect,
      anchorRect: selectionDetails.anchorRect,
      overlayRect,
      sourceRect,
      toolbarRect,
    });
    if (!style) {
      setSelectionToolbar(null);
      return;
    }

    setSelectionToolbar({
      style,
      text: selectionDetails.text,
    });
  }, [messageListRef, selectionActionOverlay]);

  useLayoutEffect(() => {
    if (selectionToolbar) {
      updateSelectionToolbar();
    }
  }, [selectionToolbar?.text, updateSelectionToolbar]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    document.addEventListener("selectionchange", updateSelectionToolbar);
    window.addEventListener("resize", updateSelectionToolbar);
    const messageListElement = messageListRef.current;
    messageListElement?.addEventListener("scroll", updateSelectionToolbar, {
      capture: true,
      passive: true,
    });
    const actionDockElement = document.getElementById(SESSION_ACTION_DOCK_ID);
    const resizeObserver = typeof window.ResizeObserver === "undefined"
      ? null
      : new window.ResizeObserver(updateSelectionToolbar);
    if (messageListElement) {
      resizeObserver?.observe(messageListElement);
    }
    if (selectionActionOverlay) {
      resizeObserver?.observe(selectionActionOverlay);
    }
    if (actionDockElement) {
      resizeObserver?.observe(actionDockElement);
    }
    const mutationObserver = messageListElement && typeof window.MutationObserver !== "undefined"
      ? new window.MutationObserver(updateSelectionToolbar)
      : null;
    if (messageListElement) {
      mutationObserver?.observe(messageListElement, {
        attributeFilter: ["data-index", "style"],
        attributes: true,
        childList: true,
        subtree: true,
      });
    }

    return () => {
      document.removeEventListener("selectionchange", updateSelectionToolbar);
      window.removeEventListener("resize", updateSelectionToolbar);
      messageListElement?.removeEventListener("scroll", updateSelectionToolbar, { capture: true });
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [messageListRef, selectionActionOverlay, updateSelectionToolbar]);

  useEffect(() => {
    setCurrentFindMatch(0);
  }, [findQuery, sessionId]);

  useEffect(() => {
    setCurrentFindMatch((current) => clampFindMatchIndex(current, messageFindMatches.length));
  }, [messageFindMatches.length]);

  useEffect(() => {
    if (firstFindScrollIndex !== null) {
      messageVirtualizer.scrollToIndex(firstFindScrollIndex, { align: "center" });
    }
  }, [findQuery, firstFindScrollIndex, messageVirtualizer, sessionId]);

  useEffect(() => {
    if (!isContentActive) {
      return;
    }
    const handleFindShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      } else if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        setFindOpen(false);
      }
    };
    window.addEventListener("keydown", handleFindShortcut);
    return () => window.removeEventListener("keydown", handleFindShortcut);
  }, [findOpen, isContentActive]);

  const navigateFindMatch = useCallback((direction: 1 | -1) => {
    if (messageFindMatches.length === 0) {
      return;
    }
    setCurrentFindMatch((current) => {
      const next = (
        clampFindMatchIndex(current, messageFindMatches.length)
        + direction
        + messageFindMatches.length
      ) % messageFindMatches.length;
      const scrollIndex = getFindMatchScrollIndex(messageFindMatches[next]);
      if (scrollIndex !== null) {
        messageVirtualizer.scrollToIndex(scrollIndex, { align: "center" });
      }
      return next;
    });
  }, [getFindMatchScrollIndex, messageFindMatches, messageVirtualizer]);

  const visibleMessageSignature = virtualMessages.map((message) => message.index).join(",");
  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    if (!isContentActive || !findOpen || !findQuery.trim() || !messageListElement) {
      return;
    }
    const ownerDocument = messageListElement.ownerDocument;
    const current = messageFindMatches[activeCurrentFindMatch] ?? null;
    const applyHighlights = () => {
      const resolvedMatches: RenderedTextMatch[] = [];
      let resolvedCurrentMatch: RenderedTextMatch | null = null;
      const appendPendingHighlights = (container: ParentNode) => {
        const pendingRichText = container.querySelector<HTMLElement>(
          "[data-pending-message-body=\"true\"] > .rich-text",
        );
        if (!pendingRichText) {
          return false;
        }
        const index = createRenderedTextSearchIndex(pendingRichText, isMessageRenderedSearchTextNode);
        const matches = findRenderedTextMatchOffsets(index, findQuery);
        appendRenderedTextMatches(resolvedMatches, index, matches);
        if (current?.kind === "pending") {
          resolvedCurrentMatch = resolveRenderedTextMatch(index, matches, current.occurrenceIndex);
        }
        return true;
      };
      let pendingHighlightsAppended = false;
      for (const row of messageListElement.querySelectorAll<HTMLElement>(".session-message-virtual-row")) {
        const messageIndex = Number(row.dataset.index);
        const richText = row.querySelector<HTMLElement>("[data-message-body=\"true\"] > .rich-text");
        if (!Number.isInteger(messageIndex) || !richText) {
          continue;
        }
        const index = createRenderedTextSearchIndex(richText, isMessageRenderedSearchTextNode);
        const matches = findRenderedTextMatchOffsets(index, findQuery);
        appendRenderedTextMatches(resolvedMatches, index, matches);
        if (current?.kind === "message" && current.messageIndex === messageIndex) {
          resolvedCurrentMatch = resolveRenderedTextMatch(index, matches, current.occurrenceIndex);
        }
        if (messageIndex === pendingMessageGroupEndIndex) {
          pendingHighlightsAppended = appendPendingHighlights(row);
        }
      }
      if (!pendingHighlightsAppended) {
        appendPendingHighlights(messageListElement);
      }
      applyRenderedTextHighlights(ownerDocument, resolvedMatches, resolvedCurrentMatch);
      scrollRenderedTextMatchIntoView(resolvedCurrentMatch);
    };
    applyHighlights();
    const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
    const observer = MutationObserverConstructor ? new MutationObserverConstructor(applyHighlights) : null;
    observer?.observe(messageListElement, { childList: true, characterData: true, subtree: true });
    return () => {
      observer?.disconnect();
      clearRenderedTextHighlights(ownerDocument);
    };
  }, [
    activeCurrentFindMatch,
    findOpen,
    findQuery,
    isContentActive,
    messageFindMatches,
    messageListRef,
    pendingMessageGroupEndIndex,
    visibleMessageSignature,
  ]);

  const isArtifactFoldOpen = (artifactKey: string, section: MessageArtifactFoldSection, index?: number) =>
    Boolean(openArtifactFolds[messageArtifactFoldKey(artifactKey, section, index)]);

  const loadArtifactDetail = useCallback((artifactKey: string, messageIndex: number, artifact: MessageArtifact | undefined) => {
    if (!artifact?.detailAvailable || !onLoadArtifactDetail || loadedArtifactDetails[artifactKey] || loadingArtifactDetails[artifactKey]) {
      return;
    }

    setLoadingArtifactDetails((current) => ({ ...current, [artifactKey]: true }));
    void onLoadArtifactDetail(messageIndex)
      .then((detail) => {
        if (!detail) {
          return;
        }
        setLoadedArtifactDetails((current) => ({ ...current, [artifactKey]: detail }));
      })
      .finally(() => {
        setLoadingArtifactDetails((current) => {
          if (!current[artifactKey]) {
            return current;
          }
          const next = { ...current };
          delete next[artifactKey];
          return next;
        });
      });
  }, [loadedArtifactDetails, loadingArtifactDetails, onLoadArtifactDetail]);

  const handleArtifactFoldToggle = (
    artifactKey: string,
    section: MessageArtifactFoldSection,
    openFold: boolean,
    index?: number,
  ) => {
    setOpenArtifactFolds((current) => {
      const key = messageArtifactFoldKey(artifactKey, section, index);
      if (openFold) {
        return current[key] ? current : { ...current, [key]: true };
      }

      if (!current[key]) {
        return current;
      }

      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const renderPendingRow = (className = "") => (
    <article className={`message-row assistant pending-row${className ? ` ${className}` : ""}`}>
      <div className="message-avatar-stack">
        <CharacterAvatar character={character} size="small" className="message-avatar" />
      </div>
      <div className="message-character-name">{character.name}</div>
      <div className="message-card assistant pending-message-card">
        {liveApprovalRequest ? (
          <section className="live-approval-card" role="group" aria-label="承認要求">
            <div className="live-approval-head">
              <div className="live-approval-copy">
                <span className="live-approval-badge">承認待ち</span>
                <p className="live-approval-title">{liveApprovalRequest.title}</p>
              </div>
              <span className="live-approval-kind">{liveApprovalKindLabel(liveApprovalRequest.kind)}</span>
            </div>
            <pre className="live-approval-summary">{liveApprovalRequest.summary}</pre>
            {liveApprovalRequest.warning ? (
              <p className="live-approval-warning" role="alert">{liveApprovalRequest.warning}</p>
            ) : null}
            {liveApprovalRequest.details ? (
              <details className="live-approval-details">
                <summary>Details</summary>
                <pre>{liveApprovalRequest.details}</pre>
              </details>
            ) : null}
            <div className="live-approval-actions">
              <button
                type="button"
                onClick={() => onResolveLiveApproval(liveApprovalRequest, "approve")}
                disabled={approvalActionRequestId === liveApprovalRequest.requestId}
              >
                今回だけ許可
              </button>
              <button
                className="drawer-toggle secondary"
                type="button"
                onClick={() => onResolveLiveApproval(liveApprovalRequest, "deny")}
                disabled={approvalActionRequestId === liveApprovalRequest.requestId}
              >
                拒否
              </button>
            </div>
          </section>
        ) : null}
        {liveElicitationRequest ? (
          <LiveElicitationCard
            request={liveElicitationRequest}
            elicitationActionRequestId={elicitationActionRequestId}
            onResolveLiveElicitation={onResolveLiveElicitation}
            onOpenPath={onOpenPath}
          />
        ) : null}
        {hasPendingMessageText ? (
          <div
            data-message-body="true"
            data-message-text-actions={canUsePendingMessageTextActions ? "true" : undefined}
            data-pending-message-body="true"
          >
            <MessageRichText
              text={pendingMessageText}
              forceFullRender={findOpen && hasFindQuery}
              displayMode={messageViewMode}
              onOpenPath={onOpenPath}
            />
          </div>
        ) : null}
        {liveRunErrorMessage ? (
          <p className="pending-run-error-note" role="alert">{liveRunErrorMessage}</p>
        ) : null}
      </div>
    </article>
  );

  return (
    <div className="session-message-column">
      <SessionContentFindBar
        open={findOpen}
        query={findQuery}
        currentMatch={activeCurrentFindMatch}
        matchCount={messageFindMatches.length}
        onQueryChange={setFindQuery}
        onPrevious={() => navigateFindMatch(-1)}
        onNext={() => navigateFindMatch(1)}
        onClose={() => setFindOpen(false)}
      />
      <div className="session-message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
        {messages.length > 0 || isRunning ? (
          <div className="session-message-list-window">
            <div
              ref={messageVirtualizer.containerRef}
              className="session-message-list-window-items"
              style={{ position: "relative" }}
            >
          {virtualMessages.map((virtualMessage) => {
            const absoluteIndex = virtualMessage.index;
            const message = messages[absoluteIndex];
            if (!message) {
              return null;
            }
            const messageKey = getMessageKey(absoluteIndex);
            const messageGroup = messageGroups?.[absoluteIndex] ?? null;
            const turnExecution = turnExecutions?.[absoluteIndex] ?? null;
            const queuedTurn = turnExecution?.state === "queued" ? turnExecution : null;
            const outboundTurn = turnExecution?.state === "accepted" ? turnExecution : null;
            const sessionInitiator = turnExecution?.initiator?.kind === "session"
              ? turnExecution.initiator
              : null;
            const turnInitiator = outboundTurn
              ? null
              : sessionInitiator
              ? {
                name: sessionInitiator.character.name,
                iconPath: sessionInitiator.character.iconFilePath,
              }
              : turnExecution?.initiator === null
                ? { name: "外部", iconPath: "" }
                : null;
            const previousMessageGroup = absoluteIndex > 0 ? messageGroups?.[absoluteIndex - 1] ?? null : null;
            const nextMessageGroup = messageGroups?.[absoluteIndex + 1] ?? null;
            const isMessageGroupStart = !!messageGroup && previousMessageGroup?.id !== messageGroup.id;
            const isMessageGroupEnd = !!messageGroup && nextMessageGroup?.id !== messageGroup.id;
            const doesMessageGroupContinue = !!messageGroup && nextMessageGroup?.id === messageGroup.id;
            const shouldRenderGroupedPending =
              isRunning &&
              canRenderGroupedPendingInlineContent &&
              isMessageGroupEnd &&
              messageGroup?.id === pendingMessageGroupId;
            const shouldCloseMessageGroup = isMessageGroupEnd && !shouldRenderGroupedPending;
            const artifactKey = messageKey;
            const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
            const isAssistant = message.role === "assistant";
            const isAgentMessage = isAssistant || outboundTurn !== null;
            const messageCharacter = outboundTurn ? character : turnInitiator ?? (isAssistant ? character : null);
            const isExternalOrigin = turnInitiator !== null;
            const displayedRole = outboundTurn
              ? "assistant session-outbound"
              : isExternalOrigin ? "session-origin" : isAssistant ? "assistant" : message.role;
            const originDetailsKey = `${artifactKey}-origin-session`;
            const originDetailsExpanded = expandedArtifacts[originDetailsKey] ?? false;
            const relatedSessionId = sessionInitiator?.sessionId
              ?? outboundTurn?.relatedSession.sessionId
              ?? null;
            const currentRelatedSession = sessionInitiator
              ? originSessionDetails.find((details) => details.sessionId === sessionInitiator.sessionId) ?? null
              : outboundTurn
                ? originSessionDetails.find((details) => details.sessionId === outboundTurn.relatedSession.sessionId) ?? null
              : null;
            const currentRelatedSessionTitle = currentRelatedSession?.status === "found"
              || (currentRelatedSession?.status === "error" && currentRelatedSession.taskTitle)
              ? currentRelatedSession.taskTitle
              : null;
            const relatedSessionTitle = currentRelatedSessionTitle
              ?? outboundTurn?.relatedSession.titleSnapshot
              ?? relatedSessionId;
            const canOpenRelatedSession = !!(
              relatedSessionId
              && currentRelatedSessionTitle
              && onOpenOriginSession
            );
            const relatedSessionRouteLabel = canOpenRelatedSession
              ? `${messageCharacter?.name}の${relatedSessionTitle}を別Windowで開く`
              : outboundTurn && currentRelatedSession?.status === "missing"
                ? `${messageCharacter?.name}の${relatedSessionTitle}は削除済みのため開けません`
                : outboundTurn && (!currentRelatedSession || currentRelatedSession.status === "loading")
                  ? `${messageCharacter?.name}の${relatedSessionTitle}の存在を確認中のため開けません`
                  : outboundTurn && currentRelatedSession?.status === "error"
                    ? `${messageCharacter?.name}の${relatedSessionTitle}の情報取得に失敗したため開けません`
                    : `${messageCharacter?.name}の${relatedSessionTitle}は現在開けません`;
            const relatedSessionMessageLabel = outboundTurn
              ? `${character.name}が${outboundTurn.relatedSession.titleSnapshot}へ送ったメッセージ`
              : sessionInitiator
                ? `${sessionInitiator.character.name}から届いたメッセージ`
                : undefined;
            const artifact = loadedArtifactDetails[artifactKey] ?? message.artifact;
            const artifactLoading = loadingArtifactDetails[artifactKey] ?? false;
            const artifactHasSnapshotRisk =
              artifact?.runChecks.some((check) => check.label.startsWith("snapshot ")) ?? false;
            const artifactOperations =
              artifact?.operationTimeline ??
              artifact?.activitySummary.map((item) => ({
                type: "summary",
                summary: item,
                details: undefined,
              })) ??
              [];
            const canUseMessageTextActions = isAgentMessage && (onCopyMessageText || onQuoteMessageText);

            return (
              <div
                key={`${message.role}-${messageKey}`}
                ref={messageVirtualizer.measureElement}
                className={`session-message-virtual-row${
                  doesMessageGroupContinue ? " auxiliary-message-group-continues" : ""
                }${absoluteIndex === messages.length - 1 ? " session-message-virtual-row-end" : ""}`}
                data-index={absoluteIndex}
              >
                {absoluteIndex === firstQueuedTurnIndex && canRenderPendingBeforeQueuedTurn
                  ? renderPendingRow()
                  : null}
                {isMessageGroupStart && messageGroup ? (
                  <div
                    className="auxiliary-message-group-label"
                    role="separator"
                    aria-label={messageGroup.label}
                  >
                    <span>{messageGroup.label}</span>
                  </div>
                ) : null}
              <article
                className={`message-row ${displayedRole}${message.accent ? " accent" : ""}${
                  messageGroup ? " auxiliary-message-group-item" : ""
                }${isMessageGroupStart ? " auxiliary-message-group-start" : ""}${
                  shouldCloseMessageGroup ? " auxiliary-message-group-end" : ""
                }`}
                aria-label={relatedSessionMessageLabel}
              >
                {messageCharacter || relatedSessionId ? (
                  <div className="message-avatar-stack">
                    {messageCharacter ? (
                      <CharacterAvatar character={messageCharacter} size="small" className="message-avatar" />
                    ) : null}
                    {artifact && messageCharacter ? (
                      <button
                        className="artifact-toggle artifact-toggle-icon"
                        type="button"
                        onClick={() => {
                          if (!artifactExpanded) {
                            loadArtifactDetail(artifactKey, absoluteIndex, artifact);
                          }
                          onToggleArtifact(artifactKey);
                        }}
                        aria-expanded={artifactExpanded}
                        aria-controls={`artifact-panel-${artifactKey}`}
                        aria-label={artifactExpanded ? "Details を閉じる" : "Details を開く"}
                        title={artifactExpanded ? "Hide Details" : "Details"}
                      >
                        {artifactExpanded ? "−" : "i"}
                      </button>
                    ) : null}
                    {relatedSessionId ? (
                      <button
                        className="artifact-toggle artifact-toggle-icon"
                        type="button"
                        onClick={() => onToggleArtifact(originDetailsKey)}
                        aria-expanded={originDetailsExpanded}
                        aria-controls={`origin-session-panel-${turnExecution?.executionId}`}
                        aria-label={outboundTurn
                          ? `${outboundTurn.relatedSession.titleSnapshot}への送信先Session情報を${originDetailsExpanded ? "閉じる" : "開く"}`
                          : originDetailsExpanded ? "呼出元Session情報を閉じる" : "呼出元Session情報を開く"}
                        title="Session情報"
                      >
                        {originDetailsExpanded ? "−" : "i"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {messageCharacter || outboundTurn ? (
                  <div className="message-character-name">{messageCharacter?.name}</div>
                ) : null}
                <div className={`message-card ${displayedRole}${message.accent ? " accent" : ""}${artifact ? " has-artifact" : ""}`}>
                  {relatedSessionId && relatedSessionTitle && messageCharacter ? (
                    <button
                      className="related-session-route"
                      type="button"
                      onClick={() => {
                        if (relatedSessionId && currentRelatedSessionTitle && onOpenOriginSession) {
                          onOpenOriginSession(relatedSessionId);
                        }
                      }}
                      disabled={!canOpenRelatedSession}
                      aria-label={relatedSessionRouteLabel}
                    >
                      {outboundTurn ? (
                        <>
                          <span aria-hidden="true">@</span>
                          <span className="related-session-character">{messageCharacter.name}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      ) : null}
                      <span className="related-session-title">{relatedSessionTitle}</span>
                    </button>
                  ) : null}
                  {artifact && !isAgentMessage ? (
                    <button
                      className="artifact-toggle artifact-toggle-icon"
                      type="button"
                      onClick={() => {
                        if (!artifactExpanded) {
                          loadArtifactDetail(artifactKey, absoluteIndex, artifact);
                        }
                        onToggleArtifact(artifactKey);
                      }}
                      aria-expanded={artifactExpanded}
                      aria-controls={`artifact-panel-${artifactKey}`}
                      aria-label={artifactExpanded ? "Details を閉じる" : "Details を開く"}
                      title={artifactExpanded ? "Hide Details" : "Details"}
                    >
                      {artifactExpanded ? "−" : "i"}
                    </button>
                  ) : null}
                  <div
                    data-message-body="true"
                    data-message-text-actions={canUseMessageTextActions ? "true" : undefined}
                  >
                    <MessageRichText
                      text={message.text}
                      forceFullRender={findOpen && hasFindQuery}
                      displayMode={messageViewMode}
                      onOpenPath={onOpenPath}
                    />
                  </div>

                  {relatedSessionId && originDetailsExpanded ? (
                    <section
                      id={`origin-session-panel-${turnExecution?.executionId}`}
                      className="origin-session-details"
                      aria-label={outboundTurn
                        ? `${outboundTurn.relatedSession.titleSnapshot}への送信先Session情報`
                        : "呼出元Session情報"}
                    >
                      <dl>
                        <div>
                          <dt>Session ID</dt>
                          <dd><code>{relatedSessionId}</code></dd>
                        </div>
                        {currentRelatedSession?.status === "found"
                        || (currentRelatedSession?.status === "error" && currentRelatedSession.taskTitle) ? (
                          <div>
                            <dt>タイトル</dt>
                            <dd>{currentRelatedSession.taskTitle}</dd>
                          </div>
                        ) : null}
                        {outboundTurn && currentRelatedSession?.status === "missing" ? (
                          <div>
                            <dt>タイトル</dt>
                            <dd>{outboundTurn.relatedSession.titleSnapshot}</dd>
                          </div>
                        ) : null}
                        {outboundTurn && (!currentRelatedSession
                          || currentRelatedSession.status === "loading"
                          || (currentRelatedSession.status === "error" && !currentRelatedSession.taskTitle)) ? (
                          <div>
                            <dt>タイトル</dt>
                            <dd>{outboundTurn.relatedSession.titleSnapshot}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </section>
                  ) : null}

                  {queuedTurn ? (
                    <div className="queued-turn-status" role="status" aria-label={`待機中 ${queuedTurn.queuePosition}番目`}>
                      <span>{`待機中 ${queuedTurn.queuePosition}`}</span>
                      {queuedTurn.canCancel && onCancelQueuedTurn ? (
                        <button
                          className="drawer-toggle compact secondary queued-turn-cancel-button"
                          type="button"
                          onClick={() => onCancelQueuedTurn(queuedTurn)}
                          disabled={cancelingExecutionIds.has(queuedTurn.executionId)}
                          aria-label={`待機中 ${queuedTurn.queuePosition}番目のTurnをキャンセル`}
                        >
                          キャンセル
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {artifact ? (
                    <section className="artifact-shell">
                      {artifactExpanded ? (
                        <div id={`artifact-panel-${artifactKey}`} className="artifact-block">
                          <div className="artifact-grid">
                            <section className="artifact-section">
                              {artifactLoading ? (
                                  <div className="artifact-file-item empty-state-card">
                                    <p>Details を読み込んでいます...</p>
                                  </div>
                                ) : artifact.changedFiles.length > 0 ? (
                                  <details
                                    className="artifact-fold artifact-files-fold"
                                    open={isArtifactFoldOpen(artifactKey, "files")}
                                    onToggle={(event) => {
                                      handleArtifactFoldToggle(artifactKey, "files", event.currentTarget.open);
                                    }}
                                  >
                                    <summary className="artifact-fold-summary">
                                      <span className="artifact-fold-summary-copy">
                                        <strong>Changed Files</strong>
                                        <span>{artifact.changedFiles.length} files</span>
                                      </span>
                                    </summary>
                                    <div className="artifact-fold-body artifact-file-list">
                                      {artifact.changedFiles.map((file) => (
                                        <article key={`${file.kind}-${file.path}`} className="artifact-file-item">
                                          <div className="artifact-file-meta">
                                            <span className={`file-kind ${file.kind}`}>{fileKindLabel(file.kind)}</span>
                                            <code>{file.path}</code>
                                          </div>
                                          <p>{file.summary}</p>
                                          {file.diffRows.length > 0 ? (
                                            <button
                                              className="diff-button"
                                              type="button"
                                              onClick={() => onOpenDiff(artifact.title, file)}
                                            >
                                              Open Diff
                                            </button>
                                          ) : null}
                                        </article>
                                      ))}
                                    </div>
                                  </details>
                                ) : (
                                  <details
                                    className="artifact-fold artifact-files-fold"
                                    open={isArtifactFoldOpen(artifactKey, "files")}
                                    onToggle={(event) => {
                                      handleArtifactFoldToggle(artifactKey, "files", event.currentTarget.open);
                                    }}
                                  >
                                    <summary className="artifact-fold-summary">
                                      <span className="artifact-fold-summary-copy">
                                        <strong>Changed Files</strong>
                                        <span>0 files</span>
                                      </span>
                                    </summary>
                                    <div className="artifact-fold-body artifact-file-list">
                                      <article className="artifact-file-item empty-state-card">
                                        <p>{getChangedFilesEmptyText(artifactKey, artifactHasSnapshotRisk)}</p>
                                      </article>
                                    </div>
                                  </details>
                                )}
                            </section>

                            <section className="artifact-section compact">
                              <div className="artifact-section-header">
                                <strong>Run Checks</strong>
                              </div>
                              <div className="check-list">
                                {artifact.runChecks.map((check) => (
                                  <div key={check.label} className="check-item">
                                    <span>{check.label}</span>
                                    <strong>{displayRunCheckValue(check)}</strong>
                                  </div>
                                ))}
                              </div>
                            </section>
                          </div>

                          {artifactOperations.length > 0 ? (
                            <section className="artifact-section compact">
                              <div className="artifact-section-header">
                                <strong>Operations</strong>
                              </div>
                              <ul className="artifact-operation-list">
                                {artifactOperations.map((operation, operationIndex) => {
                                  const operationSummary = collapseSummaryText(operation.summary) || operationTypeLabel(operation.type);
                                  return (
                                    <li key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                      <details
                                        className="artifact-operation-fold"
                                        open={isArtifactFoldOpen(artifactKey, "operation", operationIndex)}
                                        onToggle={(event) => {
                                          handleArtifactFoldToggle(artifactKey, "operation", event.currentTarget.open, operationIndex);
                                        }}
                                      >
                                        <summary className="artifact-operation-summary" title={operationSummary}>
                                          <div className="artifact-operation-head">
                                            <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                            <span className="artifact-operation-summary-text">{operationSummary}</span>
                                          </div>
                                        </summary>
                                        <div className="artifact-operation-body">
                                          {operation.type === "agent_message" ? (
                                            <div className="artifact-operation-message">
                                              <MessageRichText text={operation.summary} onOpenPath={onOpenPath} />
                                            </div>
                                          ) : (
                                            <p>{operation.summary}</p>
                                          )}
                                          {operation.details ? <pre>{operation.details}</pre> : null}
                                        </div>
                                      </details>
                                    </li>
                                  );
                                })}
                              </ul>
                            </section>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                </div>
                </article>
                {shouldRenderGroupedPending ? renderPendingRow("auxiliary-message-group-item auxiliary-message-group-end") : null}
              </div>
            );
          })}
            </div>
            {isRunning && hasPendingInlineContent && !canRenderGroupedPendingInlineContent && !canRenderPendingBeforeQueuedTurn
              ? renderPendingRow()
              : null}
            <div className="message-list-bottom-anchor" aria-hidden="true" />
          </div>
        ) : null}
        {selectionToolbar && selectionActionOverlay ? createPortal(
          <MessageResponseActions
            actionText={selectionToolbar.text}
            onCopyMessageText={onCopyMessageText}
            onQuoteMessageText={onQuoteMessageText}
            style={selectionToolbar.style}
            toolbarRef={selectionToolbarRef}
          />,
          selectionActionOverlay,
        ) : null}
      </div>
    </div>
  );
}

export type SessionActionDockCompactRowProps = {
  attachmentCount: number;
  isRunning: boolean;
  pendingRunIndicatorAnnouncement?: string;
  pendingRunIndicatorText?: string;
  modeLabel?: string;
  chatNotice?: string;
  showJumpToBottom: boolean;
  showMessageViewModeControls?: boolean;
  messageViewMode?: MessageViewMode;
  cancelButtonTitle?: string;
  onExpand: () => void;
  onJumpToBottom: () => void;
  onCancel: () => void;
  onMessageViewModeChange?: (mode: MessageViewMode) => void;
};

export function SessionActionDockCompactRow({
  attachmentCount,
  isRunning,
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  modeLabel,
  chatNotice,
  showJumpToBottom,
  showMessageViewModeControls = false,
  messageViewMode = "preview",
  cancelButtonTitle,
  onExpand,
  onJumpToBottom,
  onCancel,
  onMessageViewModeChange = () => {},
}: SessionActionDockCompactRowProps) {
  return (
    <div className={`session-action-dock-compact-row${isRunning ? " running" : ""}${modeLabel ? " has-mode-label" : ""}`}>
      {modeLabel ? <span className="action-dock-mode-badge">{modeLabel}</span> : null}
      {isRunning ? (
        <button
          className="session-action-dock-compact-progress session-action-dock-compact-progress-button"
          type="button"
          onClick={onExpand}
          aria-label="ActionDock を展開"
          title="ActionDock を展開"
        >
          <PendingRunIndicator
            announcement={pendingRunIndicatorAnnouncement}
            text={pendingRunIndicatorText}
          />
        </button>
      ) : (
        <button
          className="session-action-dock-compact-meta session-action-dock-compact-expand-button"
          type="button"
          onClick={onExpand}
          aria-label="ActionDock を展開"
          title="ActionDock を展開"
        >
          {chatNotice ? <span className="session-action-dock-compact-badge attention">{chatNotice}</span> : null}
          {attachmentCount > 0 ? (
            <span className="session-action-dock-compact-badge">{`添付 ${attachmentCount}`}</span>
          ) : null}
        </button>
      )}
      <div className="session-action-dock-compact-actions">
        {isRunning && chatNotice ? (
          <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
        ) : null}
        {showJumpToBottom ? (
          <button
            className="drawer-toggle compact secondary message-jump-bottom-button"
            type="button"
            onClick={onJumpToBottom}
          >
            末尾へ移動
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
        {isRunning ? (
          <button
            className="danger session-send-button"
            type="button"
            onClick={onCancel}
            title={cancelButtonTitle}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

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

type SessionAttachmentItem = {
  key: string;
  kind: string;
  kindLabel: string;
  locationLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  removeTargets: string[];
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
  isRunning: boolean;
  allowSendWhileRunning?: boolean;
  pendingRunIndicatorAnnouncement?: string;
  pendingRunIndicatorText?: string;
  modeLabel?: string;
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
  attachmentItems: SessionAttachmentItem[];
  draft: string;
  placeholder?: string;
  composerTextareaLabel?: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  skillButtonRef?: RefObject<HTMLButtonElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerSendabilityView;
  externalErrorDescriptionIds?: string;
  sendButtonTitle?: string;
  sendButtonLabel?: string;
  sendButtonIcon?: string;
  isComposerBlockedFeedbackActive: boolean;
  approvalOptions: Array<{ value: ApprovalMode; label: string }>;
  selectedApprovalMode: ApprovalMode;
  sandboxOptions: Array<{ value: CodexSandboxMode; label: string }>;
  selectedCodexSandboxMode: CodexSandboxMode;
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
  onRemoveAttachment: (targets: string[]) => void;
  onDraftChange: (value: string, selectionStart: number) => void;
  onDraftFocus: () => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onCancelRun?: () => void;
  onChangeApprovalMode: (value: ApprovalMode) => void;
  onChangeCodexSandboxMode: (value: CodexSandboxMode) => void;
  onChangeModel: (value: string) => void;
  onChangeReasoningEffort: (value: string) => void;
  onMessageViewModeChange?: (mode: MessageViewMode) => void;
};

export function SessionComposerExpanded({
  isRunning,
  allowSendWhileRunning = false,
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  modeLabel,
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
  attachmentItems,
  draft,
  placeholder,
  composerTextareaLabel,
  composerTextareaRef,
  skillButtonRef,
  isComposerDisabled,
  isSendDisabled,
  composerSendability,
  externalErrorDescriptionIds,
  sendButtonTitle,
  sendButtonLabel = "Send",
  sendButtonIcon,
  isComposerBlockedFeedbackActive,
  approvalOptions,
  selectedApprovalMode,
  sandboxOptions,
  selectedCodexSandboxMode,
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
  onRemoveAttachment,
  onDraftChange,
  onDraftFocus,
  onDraftKeyDown,
  onDraftPaste,
  onDraftSelect,
  onDraftCompositionStart,
  onDraftCompositionEnd,
  onSendOrCancel,
  onCancelRun = onSendOrCancel,
  onChangeApprovalMode,
  onChangeCodexSandboxMode,
  onChangeModel,
  onChangeReasoningEffort,
  onMessageViewModeChange = () => {},
}: SessionComposerExpandedProps) {
  const customAgentListRef = useRef<HTMLDivElement | null>(null);
  const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);

  useEffect(() => {
    if (!showAttachmentControls || isRunning || composerBlocked) {
      setIsAttachmentMenuOpen(false);
    }
  }, [composerBlocked, isRunning, showAttachmentControls]);

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
    !!modeLabel ||
    !!chatNotice ||
    isRunning;

  return (
    <div className="composer">
      {showComposerToolbar ? (
        <div className="composer-attachments-toolbar">
          {modeLabel ? <span className="action-dock-mode-badge">{modeLabel}</span> : null}
          {chatNotice ? (
            <span className="session-action-dock-compact-badge attention">{chatNotice}</span>
          ) : null}
          {showAttachmentControls ? (
            <ComposerAttachmentMenu
              disabled={isRunning || composerBlocked}
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
              disabled={isRunning || composerBlocked}
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
                disabled={!canSelectCustomAgent || isRunning || composerBlocked}
                aria-expanded={isAgentPickerOpen}
                aria-haspopup="listbox"
                aria-controls={isAgentPickerOpen ? "composer-agent-picker-list" : undefined}
                aria-label="Copilot custom agent を選択"
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
              disabled={isRunning || composerBlocked}
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
                disabled={isRunning || composerBlocked}
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
                disabled={additionalDirectoryCount === 0}
                aria-expanded={isAdditionalDirectoryListOpen}
              >
                {`Dirs ${additionalDirectoryCount}`}
              </button>
            </div>
          ) : null}
          {isRunning ? (
            <div className="composer-toolbar-progress">
              <PendingRunIndicator
                announcement={pendingRunIndicatorAnnouncement}
                text={pendingRunIndicatorText}
              />
            </div>
          ) : null}
          {isRunning ? (
              <button
                className="drawer-toggle compact danger composer-toolbar-cancel-button"
                type="button"
                onClick={onCancelRun}
                title="実行中のTurnをキャンセル"
                aria-label="実行中のTurnをキャンセル"
              >
                Cancel
              </button>
          ) : null}
          {showJumpToBottom || showMessageViewModeControls ? (
            <div className="composer-toolbar-view-actions">
              {showJumpToBottom ? (
                <button
                  className="drawer-toggle compact secondary message-jump-bottom-button"
                  type="button"
                  onClick={onJumpToBottom}
                >
                  末尾へ移動
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
          aria-label="Custom Agent 候補"
          aria-orientation="vertical"
          onKeyDown={(event) => {
            focusRovingItemByKey(event, { orientation: "vertical" });
          }}
        >
          {isCustomAgentListLoading ? (
            <p className="composer-skill-empty">Custom Agent を読み込み中だよ。</p>
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
                title={item.title}
              >
                <span className="composer-path-match-primary">{item.primaryLabel}</span>
                <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
              </button>
            ))
          ) : (
            <p className="composer-skill-empty">
              使える custom agent がまだないよ。`~/.copilot/agents` か workspace の `.github/agents` を確認してね。
            </p>
          )}
        </div>
      ) : null}

      {attachmentItems.length > 0 ? (
        <div className="composer-attachment-list">
          {attachmentItems.map((item) => (
            <div
              key={item.key}
              className={`composer-attachment-chip ${item.kind}`}
              title={item.title}
            >
              <span className="composer-attachment-kind">{item.kindLabel}</span>
              <span className="composer-attachment-copy">
                <span className="composer-attachment-primary">{item.primaryLabel}</span>
                <span className="composer-attachment-meta">
                  <span className="composer-attachment-location">{item.locationLabel}</span>
                  <span className="composer-attachment-secondary">{item.secondaryLabel}</span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(item.removeTargets)}
                disabled={isRunning || composerBlocked}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-input-row">
        <div className={`composer-box${isRunning ? " running" : ""}${isRunning && allowSendWhileRunning ? " accepts-running-input" : ""}${isComposerBlockedFeedbackActive ? " blocked-feedback-active" : ""}`}>
          <textarea
            ref={composerTextareaRef}
            value={draft}
            placeholder={placeholder}
            aria-label={composerTextareaLabel}
            onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onFocus={onDraftFocus}
            onKeyDown={onDraftKeyDown}
            onPaste={onDraftPaste}
            onSelect={(event) => onDraftSelect(event.currentTarget.selectionStart ?? 0)}
            onCompositionStart={onDraftCompositionStart}
            onCompositionEnd={onDraftCompositionEnd}
            disabled={isComposerDisabled}
            aria-busy={composerSendability.isBusy || undefined}
            aria-describedby={externalErrorDescriptionIds || (
              composerSendability.shouldShowFeedback ? "composer-sendability-feedback" : undefined
            )}
            aria-invalid={composerSendability.feedbackTone === "blocked" ? true : undefined}
          />
          {composerSendability.isBusy && composerSendability.busyReason ? (
            <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {composerSendability.busyReason}
            </span>
          ) : null}
          {composerSendability.shouldShowFeedback && !externalErrorDescriptionIds ? (
            <div
              id="composer-sendability-feedback"
              className={`composer-sendability-feedback ${composerSendability.feedbackTone ?? "helper"}`}
            >
              {composerSendability.primaryFeedback ? <p>{composerSendability.primaryFeedback}</p> : null}
              {composerSendability.secondaryFeedback.length > 0 ? (
                <ul>
                  {composerSendability.secondaryFeedback.map((feedback) => (
                    <li key={feedback}>{feedback}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className={`composer-control-row${isRunning ? " running" : ""}${isRunning && allowSendWhileRunning ? " allow-send-while-running" : ""}`}>
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
              aria-label="推論の深さ"
            >
              {reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isRunning && !allowSendWhileRunning ? null : (
          <button
            className="session-send-button"
            type="button"
            onClick={onSendOrCancel}
            disabled={isSendDisabled}
            title={sendButtonTitle}
            aria-label={sendButtonIcon ? sendButtonLabel : undefined}
          >
            {sendButtonIcon ? <span aria-hidden="true">{sendButtonIcon}</span> : sendButtonLabel}
          </button>
        )}
      </div>
    </div>
  );
}
