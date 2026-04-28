import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type KeyboardEventHandler, type ReactNode, type RefObject, type UIEventHandler } from "react";

import type {
  AuditLogDetail,
  ChangedFile,
  CharacterProfile,
  LiveApprovalRequest,
  LiveBackgroundTask,
  LiveElicitationField,
  LiveElicitationRequest,
  LiveElicitationResponse,
  Message,
  DiffPreviewPayload,
  SessionContextTelemetry,
  AuditLogSummary,
} from "./app-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import { MessageRichText } from "./MessageRichText.js";
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
import type { CharacterUpdateMemoryExtract } from "./character-update-state.js";
import { calculateVirtualListWindow } from "./virtual-list.js";

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

function createLiveElicitationFieldValue(field: LiveElicitationField): string | number | boolean | string[] {
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

function createLiveElicitationFormState(request: LiveElicitationRequest): Record<string, string | number | boolean | string[]> {
  return Object.fromEntries(request.fields.map((field) => [field.name, createLiveElicitationFieldValue(field)]));
}

function validateLiveElicitationField(
  field: LiveElicitationField,
  value: string | number | boolean | string[],
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
  fieldValues: Record<string, string | number | boolean | string[]>,
): Record<string, string | number | boolean | string[]> {
  const entries = request.fields.flatMap((field) => {
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
  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean | string[]>>(
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
                    value={typeof fieldValues[field.name] === "string" ? fieldValues[field.name] : ""}
                    onChange={(event) => setFieldValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    disabled={isSubmitting}
                  />
                ) : (
                  <input
                    type={field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text"}
                    value={typeof fieldValues[field.name] === "string" ? fieldValues[field.name] : ""}
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
                  value={typeof fieldValues[field.name] === "string" ? fieldValues[field.name] : ""}
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
                    const selectedValues = Array.isArray(fieldValues[field.name]) ? fieldValues[field.name] : [];
                    const checked = selectedValues.includes(option.value);
                    return (
                      <label key={option.value} className="live-elicitation-option">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setFieldValues((current) => {
                              const currentValues = Array.isArray(current[field.name]) ? current[field.name] : [];
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

const AUDIT_LOG_ESTIMATED_ROW_HEIGHT = 360;
const AUDIT_LOG_OVERSCAN = 4;
const AUDIT_LOG_FALLBACK_VIEWPORT_HEIGHT = 720;

type AuditLogFoldSection = "logical" | "transport" | "response" | "operations" | "usage" | "error" | "raw";

function auditLogFoldKey(entry: Pick<AuditLogSummary, "id" | "sessionId">, section: AuditLogFoldSection): string {
  return `${entry.sessionId}:${entry.id}:${section}`;
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
  showTerminalButton?: boolean;
  onToggleExpanded: () => void;
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
  showTerminalButton = true,
  onToggleExpanded,
  onOpenAuditLog,
  onOpenTerminal,
  onTitleDraftChange,
  onTitleInputKeyDown,
  onSaveTitle,
  onCancelTitleEdit,
  onStartTitleEdit,
  onDeleteSession,
}: SessionHeaderProps) {
  return (
    <header className="session-window-bar session-top-bar rise-1">
      <div className="session-top-bar-row">
        {!isEditingTitle ? (
          <button className="session-title-shell session-title-shell-toggle" type="button" onClick={onToggleExpanded}>
            <span className="session-window-title session-title-accent">{taskTitle}</span>
          </button>
        ) : (
          <label className="session-title-editor">
            <input value={titleDraft} onChange={(event) => onTitleDraftChange(event.target.value)} onKeyDown={onTitleInputKeyDown} />
            <div className="session-title-actions">
              <button className="drawer-toggle compact" type="button" onClick={onSaveTitle}>
                Save
              </button>
              <button className="drawer-toggle compact secondary" type="button" onClick={onCancelTitleEdit}>
                Cancel
              </button>
            </div>
          </label>
        )}
        <div className="session-window-controls">
          {!isEditingTitle ? (
            <button className="drawer-toggle compact secondary" type="button" onClick={onStartTitleEdit} disabled={isRunning}>
              Rename
            </button>
          ) : null}
          <button className="drawer-toggle compact secondary" type="button" onClick={onOpenAuditLog}>
            Audit Log
          </button>
          {showTerminalButton ? (
            <button className="drawer-toggle compact secondary" type="button" onClick={onOpenTerminal}>
              Terminal
            </button>
          ) : null}
          <button className="drawer-toggle compact danger" type="button" onClick={onDeleteSession} disabled={isRunning}>
            Delete
          </button>
        </div>
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

        <DiffViewerSubbar file={selectedDiff.file} />
        <DiffViewer file={selectedDiff.file} />
      </section>
    </div>
  );
}

export type SessionAuditLogModalProps = {
  open: boolean;
  entries: AuditLogSummary[];
  details: Record<number, {
    detail: AuditLogDetail | null;
    loading: boolean;
    errorMessage: string | null;
  }>;
  hasMore: boolean;
  loadingMore: boolean;
  total: number;
  errorMessage: string | null;
  onLoadMore: () => void;
  onLoadDetail: (entry: AuditLogSummary) => void;
  onClose: () => void;
};

export function SessionAuditLogModal({
  open,
  entries,
  details,
  hasMore,
  loadingMore,
  total,
  errorMessage,
  onLoadMore,
  onLoadDetail,
  onClose,
}: SessionAuditLogModalProps) {
  const [activeSection, setActiveSection] = useState<"main" | "background">("main");
  const [openAuditLogFolds, setOpenAuditLogFolds] = useState<Record<string, boolean>>({});
  const auditLogListRef = useRef<HTMLDivElement | null>(null);
  const [auditLogListViewport, setAuditLogListViewport] = useState({ scrollTop: 0, viewportHeight: 0 });
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
  const virtualWindow = useMemo(
    () => calculateVirtualListWindow({
      itemCount: visibleEntries.length,
      scrollTop: auditLogListViewport.scrollTop,
      viewportHeight: auditLogListViewport.viewportHeight || AUDIT_LOG_FALLBACK_VIEWPORT_HEIGHT,
      estimatedItemHeight: AUDIT_LOG_ESTIMATED_ROW_HEIGHT,
      overscan: AUDIT_LOG_OVERSCAN,
    }),
    [auditLogListViewport.scrollTop, auditLogListViewport.viewportHeight, visibleEntries.length],
  );
  const renderedEntries = useMemo(
    () => visibleEntries.slice(virtualWindow.startIndex, virtualWindow.endIndex),
    [visibleEntries, virtualWindow.endIndex, virtualWindow.startIndex],
  );

  const handleAuditLogListScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const currentTarget = event.currentTarget;
    setAuditLogListViewport({
      scrollTop: currentTarget.scrollTop,
      viewportHeight: currentTarget.clientHeight,
    });
  };

  const isAuditLogFoldOpen = (entry: AuditLogSummary, section: AuditLogFoldSection) =>
    Boolean(openAuditLogFolds[auditLogFoldKey(entry, section)]);

  const handleAuditLogFoldToggle = (
    entry: AuditLogSummary,
    section: AuditLogFoldSection,
    shouldLoadDetail: boolean,
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

    if (openFold && shouldLoadDetail && !details[entry.id]?.detail && !details[entry.id]?.loading) {
      onLoadDetail(entry);
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
    setAuditLogListViewport({
      scrollTop: 0,
      viewportHeight: listNode.clientHeight,
    });
  }, [activeSection, open]);

  useLayoutEffect(() => {
    if (!open) {
      setOpenAuditLogFolds({});
      return;
    }

    const listNode = auditLogListRef.current;
    if (!listNode || visibleEntries.length === 0) {
      return;
    }

    const maxScrollTop = Math.max(0, visibleEntries.length * AUDIT_LOG_ESTIMATED_ROW_HEIGHT - listNode.clientHeight);
    if (auditLogListViewport.scrollTop <= maxScrollTop) {
      return;
    }

    listNode.scrollTop = maxScrollTop;
    setAuditLogListViewport({
      scrollTop: maxScrollTop,
      viewportHeight: listNode.clientHeight,
    });
  }, [auditLogListViewport.scrollTop, open, visibleEntries.length]);

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
          <div className="diff-titlebar-actions">
            <button className="diff-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

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

        <div ref={auditLogListRef} className="audit-log-list" onScroll={handleAuditLogListScroll}>
          {visibleEntries.length > 0 ? (
            <div
              className="audit-log-list-window"
              style={{ "--audit-log-total-height": `${virtualWindow.totalHeight}px` } as CSSProperties}
            >
              <div className="audit-log-list-spacer" style={{ height: virtualWindow.paddingTop }} aria-hidden="true" />
              <div className="audit-log-list-window-items">
                {renderedEntries.map((entry) => {
              const detailState = details[entry.id];
              const detail = detailState?.detail ?? null;
              const operations = detail?.operations ?? entry.operations;
              const assistantText = detail?.assistantText ?? entry.assistantTextPreview;
              const usage = detail?.usage ?? entry.usage;
              const errorMessage = detail?.errorMessage ?? entry.errorMessage;

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
                  <span className="audit-log-time">{entry.createdAt}</span>
                </div>

                <div className="audit-log-meta">
                  <span>{entry.provider}</span>
                  <span>{entry.model}</span>
                  <span>{entry.reasoningEffort}</span>
                  <span>{displayApprovalValue(entry.approvalMode)}</span>
                </div>

                <details
                  className="audit-log-fold"
                  open={isAuditLogFoldOpen(entry, "logical")}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "logical", true, event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Logical Prompt</strong>
                  </summary>
                  <section className="audit-log-section">
                    {detail ? (
                      <>
                        <p><strong>System</strong></p>
                        <pre>{detail.logicalPrompt.systemText || "-"}</pre>
                        <p><strong>Input</strong></p>
                        <pre>{detail.logicalPrompt.inputText || "-"}</pre>
                        <p><strong>Composed</strong></p>
                        <pre>{detail.logicalPrompt.composedText || "-"}</pre>
                      </>
                    ) : (
                      <p className="audit-log-empty">
                        {detailState?.loading
                          ? "audit log detail を読み込んでるよ。"
                          : detailState?.errorMessage ?? "開くと audit log detail を読み込むよ。"}
                      </p>
                    )}
                  </section>
                </details>

                <details
                  className="audit-log-fold"
                  open={isAuditLogFoldOpen(entry, "transport")}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "transport", true, event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Transport Payload</strong>
                  </summary>
                  <section className="audit-log-section">
                    {detail?.transportPayload ? (
                      <>
                        <p><strong>{detail.transportPayload.summary || "transport payload"}</strong></p>
                        {detail.transportPayload.fields.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            {detail.transportPayload.fields.map((field, index) => (
                              <div key={`${entry.id}-${field.label}-${index}`} className="audit-log-transport-field">
                                <p><strong>{field.label}</strong></p>
                                <pre>{field.value || "-"}</pre>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="audit-log-empty">記録された transport payload はまだないよ。</p>
                        )}
                      </>
                    ) : (
                      <p className="audit-log-empty">
                        {detailState?.loading
                          ? "audit log detail を読み込んでるよ。"
                          : detailState?.errorMessage ?? "記録された transport payload はまだないよ。"}
                      </p>
                    )}
                  </section>
                </details>

                <details
                  className="audit-log-fold"
                  open={isAuditLogFoldOpen(entry, "response")}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "response", true, event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Response</strong>
                  </summary>
                  <section className="audit-log-section">
                    <pre>{assistantText || "-"}</pre>
                  </section>
                </details>

                <details
                  className="audit-log-fold"
                  open={isAuditLogFoldOpen(entry, "operations")}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "operations", false, event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Operations</strong>
                  </summary>
                  <section className="audit-log-section">
                    {operations.length > 0 ? (
                      <ul className="audit-log-operations">
                        {operations.map((operation, index) => (
                          <li key={`${entry.id}-${operation.type}-${index}`}>
                            <div className="audit-log-operation-head">
                              <span>{operation.type}</span>
                              <strong>{operation.summary}</strong>
                            </div>
                            {operation.details ? <pre>{operation.details}</pre> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="audit-log-empty">記録された操作はまだないよ。</p>
                    )}
                  </section>
                </details>

                {usage ? (
                  <details
                    className="audit-log-fold compact"
                    open={isAuditLogFoldOpen(entry, "usage")}
                    onToggle={(event) => {
                      handleAuditLogFoldToggle(entry, "usage", false, event.currentTarget.open);
                    }}
                  >
                    <summary>
                      <strong>Usage</strong>
                    </summary>
                    <section className="audit-log-section compact">
                      <div className="audit-log-meta">
                        <span>input {usage.inputTokens}</span>
                        <span>cached {usage.cachedInputTokens}</span>
                        <span>output {usage.outputTokens}</span>
                      </div>
                    </section>
                  </details>
                ) : null}

                {errorMessage ? (
                  <details
                    className="audit-log-fold compact"
                    open={isAuditLogFoldOpen(entry, "error")}
                    onToggle={(event) => {
                      handleAuditLogFoldToggle(entry, "error", false, event.currentTarget.open);
                    }}
                  >
                    <summary>
                      <strong>Error</strong>
                    </summary>
                    <section className="audit-log-section compact">
                      <pre>{errorMessage}</pre>
                    </section>
                  </details>
                ) : null}

                <details
                  className="audit-log-fold audit-log-raw"
                  open={isAuditLogFoldOpen(entry, "raw")}
                  onToggle={(event) => {
                    handleAuditLogFoldToggle(entry, "raw", true, event.currentTarget.open);
                  }}
                >
                  <summary>
                    <strong>Raw Items</strong>
                  </summary>
                  <pre>{detail?.rawItemsJson ?? (detailState?.loading ? "loading..." : "[]")}</pre>
                </details>
                </article>
              );
                })}
              </div>
              <div className="audit-log-list-spacer" style={{ height: virtualWindow.paddingBottom }} aria-hidden="true" />
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
  taskTitle: string;
  isHeaderExpanded: boolean;
  activeContextPaneTab: ContextPaneTabKey;
  contextPaneProjection: ContextPaneProjection;
  latestCommandView: LatestCommandView | null;
  runningDetailsEntries: RunningDetailsEntry[];
  backgroundTasks: LiveBackgroundTask[];
  selectedSessionLiveRunErrorMessage: string;
  isSelectedSessionRunning: boolean;
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedSessionContextTelemetryProjection: SessionContextTelemetryProjection;
  contextEmptyText: string;
  onToggleHeaderExpanded: () => void;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
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
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Session pane render failed", error, errorInfo);
  }

  private handleRetry = () => {
    this.setState((current) => ({
      errorMessage: null,
      resetNonce: current.resetNonce + 1,
    }));
  };

  private handleReload = () => {
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

export type CharacterUpdateContextPaneProps = {
  taskTitle: string;
  isHeaderExpanded: boolean;
  activePaneTab: "latest-command" | "memory-extract";
  latestCommandView: LatestCommandView | null;
  runningDetailsEntries: RunningDetailsEntry[];
  selectedSessionLiveRunErrorMessage: string;
  memoryExtract: CharacterUpdateMemoryExtract | null;
  isLoadingMemoryExtract: boolean;
  onToggleHeaderExpanded: () => void;
  onSelectPaneTab: (tab: "latest-command" | "memory-extract") => void;
  onRefreshMemoryExtract: () => void;
  onCopyMemoryExtract: () => void;
};

export function SessionContextPane({
  taskTitle,
  isHeaderExpanded,
  activeContextPaneTab,
  contextPaneProjection,
  latestCommandView,
  runningDetailsEntries,
  backgroundTasks,
  selectedSessionLiveRunErrorMessage,
  isSelectedSessionRunning,
  isCopilotSession,
  selectedCopilotRemainingPercentLabel,
  selectedCopilotRemainingRequestsLabel,
  selectedCopilotQuotaResetLabel,
  selectedSessionContextTelemetry,
  selectedSessionContextTelemetryProjection,
  contextEmptyText,
  onToggleHeaderExpanded,
  onCycleContextPaneTab,
}: SessionContextPaneProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const taskEntries = backgroundTasks ?? [];
  const contentScrollKey = useMemo(() => {
    switch (activeContextPaneTab) {
      case "latest-command":
        return [
          latestCommandView?.status ?? "",
          latestCommandView?.summary ?? "",
          latestCommandView?.details ?? "",
          runningDetailsEntries
            .map((entry) => `${entry.id}:${entry.type}:${entry.status}:${entry.summary}:${entry.details ?? ""}`)
            .join("\u001f"),
          selectedSessionLiveRunErrorMessage,
        ].join("|");
      case "tasks":
        return taskEntries
          .map((task) => `${task.id}:${task.kind}:${task.status}:${task.title}:${task.details ?? ""}:${task.updatedAt}`)
          .join("|");
      default:
        return "";
    }
  }, [
    activeContextPaneTab,
    latestCommandView,
    runningDetailsEntries,
    taskEntries,
    selectedSessionLiveRunErrorMessage,
  ]);

  useLayoutEffect(() => {
    const contentNode = contentRef.current;
    if (!contentNode) {
      return;
    }

    contentNode.scrollTop = contentNode.scrollHeight;
  }, [contentScrollKey]);

  return (
    <aside className={`session-context-pane${isHeaderExpanded ? " session-context-pane-header-expanded" : ""}`}>
      {!isHeaderExpanded ? <SessionHeaderHandle taskTitle={taskTitle} onClick={onToggleHeaderExpanded} /> : null}
      <section className="command-monitor-shell" aria-label="右ペイン">
        <div className="command-monitor-head">
          <div className="command-monitor-switcher" aria-label="右ペイン表示切り替え">
            <button
              type="button"
              className="command-monitor-switcher-button"
              onClick={() => onCycleContextPaneTab(-1)}
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
              aria-label="次の表示へ切り替え"
            >
              ›
            </button>
          </div>
        </div>

        <div ref={contentRef} className="command-monitor-content">
          <div className="command-monitor-stack">
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

          </div>
        </div>
      </section>

      {isCopilotSession ? (
        <section className="provider-usage-shell" aria-label="Copilot usage">
          <div className="provider-usage-strip">
            <div className="provider-usage-strip-copy">
              <span className="provider-usage-label">Premium Requests</span>
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

export function CharacterUpdateContextPane({
  taskTitle,
  isHeaderExpanded,
  activePaneTab,
  latestCommandView,
  runningDetailsEntries,
  selectedSessionLiveRunErrorMessage,
  memoryExtract,
  isLoadingMemoryExtract,
  onToggleHeaderExpanded,
  onSelectPaneTab,
  onRefreshMemoryExtract,
  onCopyMemoryExtract,
}: CharacterUpdateContextPaneProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const contentScrollKey = useMemo(() => {
    if (activePaneTab === "latest-command") {
      return [
        latestCommandView?.status ?? "",
        latestCommandView?.summary ?? "",
        latestCommandView?.details ?? "",
        runningDetailsEntries
          .map((entry) => `${entry.id}:${entry.type}:${entry.status}:${entry.summary}:${entry.details ?? ""}`)
          .join("\u001f"),
        selectedSessionLiveRunErrorMessage,
      ].join("|");
    }

    return [
      memoryExtract?.generatedAt ?? "",
      memoryExtract?.entryCount ?? 0,
      memoryExtract?.text ?? "",
      isLoadingMemoryExtract ? "loading" : "idle",
    ].join("|");
  }, [activePaneTab, isLoadingMemoryExtract, latestCommandView, memoryExtract, runningDetailsEntries, selectedSessionLiveRunErrorMessage]);

  useLayoutEffect(() => {
    const contentNode = contentRef.current;
    if (!contentNode) {
      return;
    }

    contentNode.scrollTop = contentNode.scrollHeight;
  }, [contentScrollKey]);

  return (
    <aside className={`session-context-pane${isHeaderExpanded ? " session-context-pane-header-expanded" : ""}`}>
      {!isHeaderExpanded ? <SessionHeaderHandle taskTitle={taskTitle} onClick={onToggleHeaderExpanded} /> : null}
      <section className="command-monitor-shell" aria-label="character update monitor">
        <div className="command-monitor-head">
          <div className="audit-log-segmented session-context-segmented" aria-label="右ペイン表示切り替え">
            <button
              type="button"
              className={`audit-log-segmented-button${activePaneTab === "latest-command" ? " is-active" : ""}`}
              onClick={() => onSelectPaneTab("latest-command")}
            >
              LatestCommand
            </button>
            <button
              type="button"
              className={`audit-log-segmented-button${activePaneTab === "memory-extract" ? " is-active" : ""}`}
              onClick={() => onSelectPaneTab("memory-extract")}
            >
              MemoryExtract
            </button>
          </div>
        </div>

        <div ref={contentRef} className="command-monitor-content">
          <div className="command-monitor-stack">
            {activePaneTab === "latest-command" && runningDetailsEntries.length > 0 ? (
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

            {activePaneTab === "latest-command" ? (
              latestCommandView ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${liveRunStepToneClassName(latestCommandView.status)}`}>
                        {liveRunStepStatusLabel(latestCommandView.status)}
                      </span>
                      <span className="live-run-step-type">Command</span>
                      <span className="command-monitor-source">
                        {latestCommandView.sourceLabel === "live" ? "RUN LIVE" : "LAST RUN"}
                      </span>
                    </div>
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

                  {selectedSessionLiveRunErrorMessage ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>実行エラー</strong>
                      <p className="live-run-error">{selectedSessionLiveRunErrorMessage}</p>
                    </div>
                  ) : null}
                </div>
              ) : null
            ) : (
              <div className="command-monitor-card character-update-extract-card">
                <div className="character-update-extract-head">
                  <div className="command-monitor-meta">
                    <strong>Memory Extract</strong>
                    <span className="command-monitor-source">{memoryExtract?.entryCount ?? 0}</span>
                  </div>
                  <div className="character-update-extract-actions">
                    <button className="launch-toggle compact" type="button" onClick={onRefreshMemoryExtract} disabled={isLoadingMemoryExtract}>
                      {isLoadingMemoryExtract ? "Extracting..." : "Refresh"}
                    </button>
                    <button className="launch-toggle compact" type="button" onClick={onCopyMemoryExtract} disabled={!memoryExtract?.text}>
                      Copy
                    </button>
                  </div>
                </div>
                <textarea
                  className="character-update-extract"
                  value={memoryExtract?.text ?? ""}
                  readOnly
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        </div>
      </section>
    </aside>
  );
}

export type SessionRetryBannerProps = {
  retryBanner: {
    kind: "interrupted" | "failed" | "canceled";
    badge: string;
    title: string;
    stopSummary: string;
    lastRequestText: string;
  } | null;
  isRetryDetailsOpen: boolean;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onToggleDetails: () => void;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  onOpenPath: (path: string) => void;
};

export function SessionRetryBanner({
  retryBanner,
  isRetryDetailsOpen,
  isRetryActionDisabled,
  isRetryEditDisabled,
  isRetryDraftReplacePending,
  onToggleDetails,
  onResendLastMessage,
  onEditLastMessage,
  onConfirmRetryDraftReplace,
  onCancelRetryDraftReplace,
  onOpenPath,
}: SessionRetryBannerProps) {
  if (!retryBanner) {
    return null;
  }

  return (
    <div className={`resume-banner retry-banner ${retryBanner.kind}`}>
      <div className="resume-banner-head">
        <div className="resume-banner-copy">
          <span className={`resume-banner-badge ${retryBanner.kind}`}>{retryBanner.badge}</span>
          <p className="resume-banner-title">{retryBanner.title}</p>
        </div>
        <button
          className="artifact-toggle resume-banner-details-toggle"
          type="button"
          onClick={onToggleDetails}
          aria-expanded={isRetryDetailsOpen}
        >
          {isRetryDetailsOpen ? "Hide" : "Details"}
        </button>
      </div>
      <div className="resume-banner-actions">
        <button type="button" onClick={onResendLastMessage} disabled={isRetryActionDisabled}>
          同じ依頼を再送
        </button>
        <button
          className="drawer-toggle secondary"
          type="button"
          onClick={onEditLastMessage}
          disabled={isRetryEditDisabled}
        >
          編集して再送
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
      {isRetryDetailsOpen ? (
        <div className="resume-banner-details">
          <p className="resume-banner-summary">
            <strong>停止地点</strong>
            <span>{retryBanner.stopSummary}</span>
          </p>
          <div className="resume-banner-request">
            <span>前回の依頼</span>
            <MessageRichText text={retryBanner.lastRequestText} onOpenPath={onOpenPath} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type SessionMessageColumnProps = {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  expandedArtifacts: Record<string, boolean>;
  messageListRef: RefObject<HTMLDivElement | null>;
  isRunning: boolean;
  pendingRunIndicatorAnnouncement: string;
  pendingRunIndicatorText: string;
  liveApprovalRequest: LiveApprovalRequest | null;
  approvalActionRequestId: string | null;
  liveElicitationRequest: LiveElicitationRequest | null;
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  isMessageListFollowing: boolean;
  hasMessageListUnread: boolean;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onOpenDiff: (title: string, file: ChangedFile) => void;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onJumpToBottom: () => void;
  onOpenPath?: (target: string) => void;
  getChangedFilesEmptyText: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
};

export function SessionMessageColumn({
  sessionId,
  character,
  messages,
  expandedArtifacts,
  messageListRef,
  isRunning,
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  liveApprovalRequest,
  approvalActionRequestId,
  liveElicitationRequest,
  elicitationActionRequestId,
  liveRunAssistantText,
  hasLiveRunAssistantText,
  liveRunErrorMessage,
  isMessageListFollowing,
  hasMessageListUnread,
  onMessageListScroll,
  onToggleArtifact,
  onOpenDiff,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onJumpToBottom,
  onOpenPath,
  getChangedFilesEmptyText,
}: SessionMessageColumnProps) {
  return (
    <div className="session-message-column">
      <div className="message-list" ref={messageListRef} onScroll={onMessageListScroll}>
        {messages.length > 0 ? (
          messages.map((message, index) => {
            const artifactKey = `${sessionId}-${index}`;
            const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
            const isAssistant = message.role === "assistant";
            const artifactHasSnapshotRisk =
              message.artifact?.runChecks.some((check) => check.label.startsWith("snapshot ")) ?? false;
            const artifactOperations =
              message.artifact?.operationTimeline ??
              message.artifact?.activitySummary.map((item) => ({
                type: "summary",
                summary: item,
                details: undefined,
              })) ??
              [];

            return (
              <article
                key={`${message.role}-${index}`}
                className={`message-row ${message.role}${message.accent ? " accent" : ""}`}
              >
                {isAssistant ? (
                  <div className="message-avatar-stack">
                    <CharacterAvatar character={character} size="small" className="message-avatar" />
                    {message.artifact ? (
                      <button
                        className="artifact-toggle artifact-toggle-icon"
                        type="button"
                        onClick={() => onToggleArtifact(artifactKey)}
                        aria-expanded={artifactExpanded}
                        aria-controls={`artifact-panel-${artifactKey}`}
                        aria-label={artifactExpanded ? "Details を閉じる" : "Details を開く"}
                        title={artifactExpanded ? "Hide Details" : "Details"}
                      >
                        {artifactExpanded ? "−" : "i"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className={`message-card ${message.role}${message.accent ? " accent" : ""}${message.artifact ? " has-artifact" : ""}`}>
                  {message.artifact && !isAssistant ? (
                    <button
                      className="artifact-toggle artifact-toggle-icon"
                      type="button"
                      onClick={() => onToggleArtifact(artifactKey)}
                      aria-expanded={artifactExpanded}
                      aria-controls={`artifact-panel-${artifactKey}`}
                      aria-label={artifactExpanded ? "Details を閉じる" : "Details を開く"}
                      title={artifactExpanded ? "Hide Details" : "Details"}
                    >
                      {artifactExpanded ? "−" : "i"}
                    </button>
                  ) : null}
                  <MessageRichText text={message.text} onOpenPath={onOpenPath} />

                  {message.artifact ? (
                    <section className="artifact-shell">
                      {artifactExpanded ? (
                        <div id={`artifact-panel-${artifactKey}`} className="artifact-block">
                          <div className="artifact-grid">
                            <section className="artifact-section">
                              {message.artifact.changedFiles.length > 0 ? (
                                  <details className="artifact-fold artifact-files-fold">
                                    <summary className="artifact-fold-summary">
                                      <span className="artifact-fold-summary-copy">
                                        <strong>Changed Files</strong>
                                        <span>{message.artifact.changedFiles.length} files</span>
                                      </span>
                                    </summary>
                                    <div className="artifact-fold-body artifact-file-list">
                                      {message.artifact.changedFiles.map((file) => (
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
                                              onClick={() => onOpenDiff(message.artifact!.title, file)}
                                            >
                                              Open Diff
                                            </button>
                                          ) : null}
                                        </article>
                                      ))}
                                    </div>
                                  </details>
                                ) : (
                                  <details className="artifact-fold artifact-files-fold">
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
                                {message.artifact.runChecks.map((check) => (
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
                                      <details className="artifact-operation-fold">
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
            );
          })
        ) : null}

        {isRunning ? (
          <article className="message-row assistant pending-row">
            <CharacterAvatar character={character} size="small" className="message-avatar" />
            <div className="message-card assistant pending-message-card">
              <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                {pendingRunIndicatorAnnouncement}
              </span>
              <div className="live-run-shell-status pending-run-indicator" aria-hidden="true">
                <span className="live-run-shell-status-badge">実行中</span>
                <span className="live-run-shell-status-text">{pendingRunIndicatorText}</span>
                <span className="typing-dots pending-run-indicator-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
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
              {hasLiveRunAssistantText ? <MessageRichText text={liveRunAssistantText} onOpenPath={onOpenPath} /> : null}
              {liveRunErrorMessage ? (
                <p className="pending-run-error-note" role="alert">{liveRunErrorMessage}</p>
              ) : null}
            </div>
          </article>
        ) : null}
        {!isMessageListFollowing ? (
          <aside className={`message-follow-banner sticky ${hasMessageListUnread ? "has-unread" : "idle"}`}>
            <div className="message-follow-banner-copy">
              <span className="message-follow-banner-badge">{hasMessageListUnread ? "新着あり" : "読み返し中"}</span>
              <p>{hasMessageListUnread ? "追従を止めている間に新しい表示が来たよ。" : "今は読み返し位置を維持しているよ。"}</p>
            </div>
            <button type="button" className="message-follow-banner-button" onClick={onJumpToBottom}>
              末尾へ移動
            </button>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export type SessionActionDockCompactRowProps = {
  draft: string;
  actionDockCompactPreview: string;
  attachmentCount: number;
  isRunning: boolean;
  isSendDisabled: boolean;
  sendButtonTitle?: string;
  onExpand: () => void;
  onSendOrCancel: () => void;
};

export function SessionActionDockCompactRow({
  draft,
  actionDockCompactPreview,
  attachmentCount,
  isRunning,
  isSendDisabled,
  sendButtonTitle,
  onExpand,
  onSendOrCancel,
}: SessionActionDockCompactRowProps) {
  return (
    <div className="session-action-dock-compact-row">
      <button
        className="session-action-dock-compact-preview"
        type="button"
        onClick={onExpand}
        title={draft.trim() ? draft : "下書きなし"}
      >
        <span className="session-action-dock-compact-label">Draft</span>
        <span className={`session-action-dock-compact-text${draft.trim() ? " has-draft" : ""}`}>
          {actionDockCompactPreview}
        </span>
      </button>
      <div className="session-action-dock-compact-meta" aria-label="draft summary">
        {attachmentCount > 0 ? (
          <span className="session-action-dock-compact-badge">{`添付 ${attachmentCount}`}</span>
        ) : null}
        {isRunning ? (
          <span className="session-action-dock-compact-badge running">RUN</span>
        ) : null}
      </div>
      <div className="session-action-dock-compact-actions">
        <button
          className={isRunning ? "danger session-send-button" : "session-send-button"}
          type="button"
          onClick={onSendOrCancel}
          disabled={!isRunning && isSendDisabled}
          title={sendButtonTitle}
        >
          {isRunning ? "Cancel" : "Send"}
        </button>
      </div>
    </div>
  );
}

type SessionSelectOption = {
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

type SessionSkillItem = {
  key: string;
  skillId: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
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

type SessionAdditionalDirectoryItem = {
  key: string;
  path: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  canRemove: boolean;
};

type SessionWorkspacePathMatchItem = {
  key: string;
  path: string;
  kind: "file" | "folder";
  kindLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
  isActive: boolean;
};

type SessionComposerSendabilityView = {
  primaryFeedback: string;
  secondaryFeedback: string[];
  feedbackTone: "blocked" | "helper" | null;
  shouldShowFeedback: boolean;
};

export type SessionComposerExpandedProps = {
  retryBanner: ReactNode;
  isRunning: boolean;
  composerBlocked: boolean;
  canSelectCustomAgent: boolean;
  showCustomAgentPicker?: boolean;
  showSkillPicker?: boolean;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
  isAdditionalDirectoryListOpen: boolean;
  selectedCustomAgentLabel: string;
  selectedCustomAgentTitle: string;
  additionalDirectoryCount: number;
  canCollapseActionDock: boolean;
  isCustomAgentListLoading: boolean;
  isSkillListLoading: boolean;
  customAgentItems: SessionCustomAgentItem[];
  skillItems: SessionSkillItem[];
  attachmentItems: SessionAttachmentItem[];
  additionalDirectoryItems: SessionAdditionalDirectoryItem[];
  workspacePathMatchItems: SessionWorkspacePathMatchItem[];
  draft: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerSendabilityView;
  sendButtonTitle?: string;
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
  onToggleAgentPicker: () => void;
  onToggleSkillPicker: () => void;
  onAddAdditionalDirectory: () => void;
  onToggleAdditionalDirectoryList: () => void;
  onCollapse: () => void;
  onSelectCustomAgent: (value: string | null) => void;
  onSelectSkill: (skillId: string) => void;
  onRemoveAttachment: (targets: string[]) => void;
  onRemoveAdditionalDirectory: (path: string) => void;
  onDraftChange: (value: string, selectionStart: number) => void;
  onDraftFocus: () => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onSelectWorkspacePathMatch: (path: string) => void;
  onActivateWorkspacePathMatch: (index: number) => void;
  onChangeApprovalMode: (value: ApprovalMode) => void;
  onChangeCodexSandboxMode: (value: CodexSandboxMode) => void;
  onChangeModel: (value: string) => void;
  onChangeReasoningEffort: (value: string) => void;
};

export function SessionComposerExpanded({
  retryBanner,
  isRunning,
  composerBlocked,
  canSelectCustomAgent,
  showCustomAgentPicker = true,
  showSkillPicker = true,
  isAgentPickerOpen,
  isSkillPickerOpen,
  isAdditionalDirectoryListOpen,
  selectedCustomAgentLabel,
  selectedCustomAgentTitle,
  additionalDirectoryCount,
  canCollapseActionDock,
  isCustomAgentListLoading,
  isSkillListLoading,
  customAgentItems,
  skillItems,
  attachmentItems,
  additionalDirectoryItems,
  workspacePathMatchItems,
  draft,
  composerTextareaRef,
  isComposerDisabled,
  isSendDisabled,
  composerSendability,
  sendButtonTitle,
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
  onToggleAgentPicker,
  onToggleSkillPicker,
  onAddAdditionalDirectory,
  onToggleAdditionalDirectoryList,
  onCollapse,
  onSelectCustomAgent,
  onSelectSkill,
  onRemoveAttachment,
  onRemoveAdditionalDirectory,
  onDraftChange,
  onDraftFocus,
  onDraftKeyDown,
  onDraftSelect,
  onDraftCompositionStart,
  onDraftCompositionEnd,
  onSendOrCancel,
  onSelectWorkspacePathMatch,
  onActivateWorkspacePathMatch,
  onChangeApprovalMode,
  onChangeCodexSandboxMode,
  onChangeModel,
  onChangeReasoningEffort,
}: SessionComposerExpandedProps) {
  const customAgentListRef = useRef<HTMLDivElement | null>(null);
  const skillListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isAgentPickerOpen) {
      return;
    }

    const nextFocusTarget =
      customAgentListRef.current?.querySelector<HTMLElement>("[aria-selected=\"true\"]") ??
      customAgentListRef.current?.querySelector<HTMLElement>("[role=\"option\"]");
    nextFocusTarget?.focus();
  }, [customAgentItems, isAgentPickerOpen]);

  useEffect(() => {
    if (!isSkillPickerOpen) {
      return;
    }

    const nextFocusTarget = skillListRef.current?.querySelector<HTMLElement>("[role=\"option\"]");
    nextFocusTarget?.focus();
  }, [isSkillPickerOpen, skillItems]);

  const activeWorkspacePathMatchIndex = workspacePathMatchItems.findIndex((item) => item.isActive);
  const activeWorkspacePathMatchId =
    activeWorkspacePathMatchIndex >= 0 ? `composer-workspace-path-match-${activeWorkspacePathMatchIndex}` : undefined;

  return (
    <div className="composer">
      {retryBanner}
      <div className="composer-attachments-toolbar">
        <div className="composer-attachment-button-group" role="group" aria-label="添付">
          <button className="drawer-toggle compact secondary" type="button" onClick={onPickFile} disabled={isRunning || composerBlocked}>
            File
          </button>
          <button className="drawer-toggle compact secondary" type="button" onClick={onPickFolder} disabled={isRunning || composerBlocked}>
            Folder
          </button>
          <button className="drawer-toggle compact secondary" type="button" onClick={onPickImage} disabled={isRunning || composerBlocked}>
            Image
          </button>
        </div>
        {showCustomAgentPicker ? (
          <div className="composer-agent-toolbar">
            <button
              className={`drawer-toggle compact secondary composer-skill-button${isAgentPickerOpen ? " is-open" : ""}`}
              type="button"
              onClick={onToggleAgentPicker}
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
            className={`drawer-toggle compact secondary composer-skill-button${isSkillPickerOpen ? " is-open" : ""}`}
            type="button"
            onClick={onToggleSkillPicker}
            disabled={isRunning || composerBlocked}
            aria-expanded={isSkillPickerOpen}
            aria-haspopup="listbox"
            aria-controls={isSkillPickerOpen ? "composer-skill-picker-list" : undefined}
          >
            Skill
          </button>
        ) : null}
        <div className="composer-additional-directory-toolbar">
          <button
            className="drawer-toggle compact secondary composer-skill-button"
            type="button"
            onClick={onAddAdditionalDirectory}
            disabled={isRunning || composerBlocked}
          >
            Add Directory
          </button>
          <button
            className={`drawer-toggle compact secondary composer-skill-button${isAdditionalDirectoryListOpen ? " is-open" : ""}`}
            type="button"
            onClick={onToggleAdditionalDirectoryList}
            disabled={additionalDirectoryCount === 0}
            aria-expanded={isAdditionalDirectoryListOpen}
          >
            {`Dirs ${additionalDirectoryCount}`}
          </button>
        </div>
        {canCollapseActionDock ? (
          <button className="drawer-toggle compact secondary composer-hide-button" type="button" onClick={onCollapse}>
            Hide
          </button>
        ) : null}
      </div>

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

      {showSkillPicker && isSkillPickerOpen ? (
        <div
          id="composer-skill-picker-list"
          ref={skillListRef}
          className="composer-path-match-list composer-skill-picker-list"
          role={skillItems.length > 0 ? "listbox" : "status"}
          aria-label="Skill 候補"
          aria-orientation={skillItems.length > 0 ? "vertical" : undefined}
          onKeyDown={(event) => {
            if (skillItems.length > 0) {
              focusRovingItemByKey(event, { orientation: "vertical" });
            }
          }}
        >
          {isSkillListLoading ? (
            <p className="composer-skill-empty">Skill を読み込み中だよ。</p>
          ) : skillItems.length > 0 ? (
            skillItems.map((item) => (
              <button
                key={item.key}
                type="button"
                role="option"
                tabIndex={item === skillItems[0] ? 0 : -1}
                className="composer-path-match"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelectSkill(item.skillId)}
                title={item.title}
              >
                <span className="composer-path-match-primary">{item.primaryLabel}</span>
                <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
              </button>
            ))
          ) : (
            <p className="composer-skill-empty">
              使える skill がまだないよ。Home の Settings で Skill Root を設定するか、workspace 配下に
              `SKILL.md` を配置してね。
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
              <button type="button" onClick={() => onRemoveAttachment(item.removeTargets)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isAdditionalDirectoryListOpen && additionalDirectoryItems.length > 0 ? (
        <div className="composer-additional-directory-list">
          {additionalDirectoryItems.map((item) => (
            <div
              key={item.key}
              className="composer-additional-directory-chip"
              title={item.title}
            >
              <span className="composer-additional-directory-copy">
                <span className="composer-additional-directory-primary">{item.primaryLabel}</span>
                <span className="composer-additional-directory-secondary">{item.secondaryLabel}</span>
              </span>
              {item.canRemove ? (
                <button
                  type="button"
                  className="composer-additional-directory-remove"
                  onClick={() => onRemoveAdditionalDirectory(item.path)}
                  disabled={isRunning}
                  aria-label={`${item.primaryLabel} を削除`}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className={`composer-box${isComposerBlockedFeedbackActive ? " blocked-feedback-active" : ""}`}>
        <textarea
          ref={composerTextareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
          onFocus={onDraftFocus}
          onKeyDown={onDraftKeyDown}
          onSelect={(event) => onDraftSelect(event.currentTarget.selectionStart ?? 0)}
          onCompositionStart={onDraftCompositionStart}
          onCompositionEnd={onDraftCompositionEnd}
          disabled={isComposerDisabled}
          aria-autocomplete="list"
          aria-expanded={workspacePathMatchItems.length > 0}
          aria-controls={workspacePathMatchItems.length > 0 ? "composer-workspace-path-match-list" : undefined}
          aria-activedescendant={activeWorkspacePathMatchId}
          aria-describedby={composerSendability.shouldShowFeedback ? "composer-sendability-feedback" : undefined}
          aria-invalid={composerSendability.feedbackTone === "blocked" ? true : undefined}
        />
        <button
          className={isRunning ? "danger session-send-button" : "session-send-button"}
          type="button"
          onClick={onSendOrCancel}
          disabled={!isRunning && isSendDisabled}
          title={sendButtonTitle}
        >
          {isRunning ? "Cancel" : "Send"}
        </button>
        {composerSendability.shouldShowFeedback ? (
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

      {workspacePathMatchItems.length > 0 ? (
        <div
          id="composer-workspace-path-match-list"
          className="composer-path-match-list"
          role="listbox"
          aria-label="@path 候補"
          aria-orientation="vertical"
        >
          {workspacePathMatchItems.map((item, index) => (
            <button
              key={item.key}
              id={`composer-workspace-path-match-${index}`}
              type="button"
              role="option"
              aria-selected={item.isActive}
              tabIndex={-1}
              className={`composer-path-match ${item.kind}${item.isActive ? " active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActivateWorkspacePathMatch(index)}
              onFocus={() => onActivateWorkspacePathMatch(index)}
              onClick={() => onSelectWorkspacePathMatch(item.path)}
              title={item.title}
            >
              <span className="composer-path-match-heading">
                <span className="composer-path-match-kind">{item.kindLabel}</span>
                <span className="composer-path-match-primary">{item.primaryLabel}</span>
              </span>
              <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer-settings">
        <div className="composer-setting-field composer-setting-approval">
          <span>Approval</span>
          <select
            value={selectedApprovalMode}
            onChange={(event) => onChangeApprovalMode(event.target.value as ApprovalMode)}
            disabled={isRunning}
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
              disabled={isRunning}
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

        <div className="composer-setting-field composer-setting-model">
          <span>Model</span>
          <select
            value={selectedModel}
            onChange={(event) => onChangeModel(event.target.value)}
            disabled={isRunning}
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
            disabled={isRunning}
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
    </div>
  );
}
