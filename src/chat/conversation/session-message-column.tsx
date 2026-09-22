import { SelectionActionOverlayContext } from "./selection-action-overlay-context.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEventHandler, type CSSProperties, type ReactNode, type RefObject, type UIEventHandler } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { ChangedFile, LiveApprovalRequest, LiveElicitationField, LiveElicitationRequest, LiveElicitationResponse } from "../../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../../src-shared/character/character-state.js";
import type { Message, MessageArtifact } from "../../../src-shared/session/session-state.js";

import { MessageRichText, type MessageViewMode } from "../../ui/markdown/MessageRichText.js";
import type { GlossaryAnnotationMatcher } from "../../glossary/glossary-annotation-projection.js";
import { approvalModeLabel, CharacterAvatar, operationTypeLabel } from "../../ui/ui-utils.js";

import { SessionContentFindBar } from "./session-content-find-bar.js";
import { clampFindMatchIndex, findTextMatches } from "../../ui/find-text-matches.js";

import { resolveSelectionActionOverlayPosition } from "../../chat/selection-action-overlay.js";

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
} from "../../file-explorer/rendered-text-search.js";
import { SHORTCUT_COMMAND_IDS, useShortcutCommandHandler, useShortcutScope } from "../../settings/shortcut-registry.js";
import type { MessageCollapseTarget, MessageJumpRequest } from "./session-message-collapse.js";

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

const SESSION_MESSAGE_ESTIMATED_ROW_HEIGHT = 168;
const SESSION_MESSAGE_FALLBACK_VIEWPORT_HEIGHT = 720;
const SESSION_MESSAGE_OVERSCAN = 6;
const SESSION_MESSAGE_SCROLL_END_THRESHOLD = 80;
const SESSION_ACTION_DOCK_ID = "session-action-dock";

export function shouldAdjustSessionMessageScrollPosition(input: { itemStart: number; scrollOffset: number }): boolean {
  return input.itemStart < input.scrollOffset;
}

type MessageArtifactFoldSection = "operation" | "operations";
function messageArtifactFoldKey(artifactKey: string, section: MessageArtifactFoldSection, index?: number): string {
  return `${artifactKey}:${section}${index === undefined ? "" : `:${index}`}`;
}
export type SessionMessageColumnProps = {
  sessionId: string;
  character: CharacterProfile;
  messages: Message[];
  messageKeys?: string[];
  messageCollapseTargets?: readonly MessageCollapseTarget[];
  collapsedMessageKeys?: ReadonlySet<string>;
  messageJumpRequest?: MessageJumpRequest | null;
  messageGroups?: Array<{
    id: string;
    label: string;
  } | null>;
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
  onJumpToBottom?: () => void;
  onToggleMessageCollapse?: (key: string) => void;
  onToggleAllMessageCollapse?: () => void;
  onToggleMessageBookmark?: (target: MessageCollapseTarget) => void;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail?: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: (title: string, file: ChangedFile) => void;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
  onResolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => void;
  onOpenPath?: (target: string) => void;
  getChangedFilesEmptyText: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  isContentActive?: boolean;
  messageViewMode?: MessageViewMode;
  glossaryAnnotationMatcher?: GlossaryAnnotationMatcher;
  onActivateGlossaryEntry?: (canonicalTerm: string) => void;
};

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

  const handleSelectAllShortcut = useCallback((): boolean => {
    const surface = surfaceRef.current;
    const selectableBody = surface?.querySelector<HTMLElement>("[data-selection-copy-body='true']") ?? null;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!surface || !selectableBody || !selection) {
      return false;
    }

    const resolvedText = selectAllText
      ?? (typeof selectableBody.innerText === "string" ? selectableBody.innerText : selectableBody.textContent ?? "");
    surface.focus({ preventScroll: true });
    clearLogicalSelectAll();
    selection.removeAllRanges();
    if (!resolvedText.trim()) {
      setSelectionToolbar(null);
      return true;
    }

    logicalSelectAllTextRef.current = resolvedText;
    const range = document.createRange();
    range.selectNodeContents(selectableBody);
    selection.addRange(range);
    updateSelectionToolbar();
    return true;
  }, [clearLogicalSelectAll, selectAllText, surfaceRef, updateSelectionToolbar]);

  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.filePreviewSelectAll, handleSelectAllShortcut);

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
  messageCollapseTargets = [],
  collapsedMessageKeys = new Set(),
  messageJumpRequest = null,
  messageGroups,
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
  onJumpToBottom,
  onToggleMessageCollapse,
  onToggleAllMessageCollapse,
  onToggleMessageBookmark,
  onToggleArtifact,
  onLoadArtifactDetail,
  onResolveLiveApproval,
  onResolveLiveElicitation,
  onOpenPath,
  onCopyMessageText,
  onQuoteMessageText,
  isContentActive = true,
  messageViewMode = "preview",
  glossaryAnnotationMatcher,
  onActivateGlossaryEntry,
}: SessionMessageColumnProps) {
  const selectionActionOverlay = useContext(SelectionActionOverlayContext);
  const [openArtifactFolds, setOpenArtifactFolds] = useState<Record<string, boolean>>({});
  const [loadedArtifactDetails, setLoadedArtifactDetails] = useState<Record<string, MessageArtifact>>({});
  const [loadingArtifactDetails, setLoadingArtifactDetails] = useState<Record<string, boolean>>({});
  const [selectionToolbar, setSelectionToolbar] = useState<{ style: CSSProperties; text: string } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [currentFindMatch, setCurrentFindMatch] = useState(0);
  const [messageJumpHighlightKey, setMessageJumpHighlightKey] = useState<string | null>(null);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);
  const previousMessageViewModeRef = useRef(messageViewMode);
  const handledMessageJumpRequestIdRef = useRef<number | null>(null);
  const markdownLinkFileContext = useMemo(() => ({ sessionId }), [sessionId]);
  const messageCollapseTargetByKey = useMemo(
    () => new Map(messageCollapseTargets.map((target) => [target.key, target])),
    [messageCollapseTargets],
  );

  useShortcutScope("message-list", isContentActive);
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageFind,
    () => {
      setFindOpen(true);
      return true;
    },
    isContentActive,
  );
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageCloseFind,
    () => {
      if (!findOpen) {
        return false;
      }
      setFindOpen(false);
      return true;
    },
    isContentActive,
  );
  useShortcutCommandHandler(
    SHORTCUT_COMMAND_IDS.messageToggleCollapse,
    () => {
      const targetCount = messageCollapseTargets.length;
      const callbackAvailable = Boolean(onToggleAllMessageCollapse);
      const accepted = targetCount > 0 && callbackAvailable;
      if (!accepted || !onToggleAllMessageCollapse) {
        return false;
      }
      onToggleAllMessageCollapse();
      return true;
    },
    isContentActive,
  );

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
    useFlushSync: false,
  });
  messageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    shouldAdjustSessionMessageScrollPosition({
      itemStart: item.start,
      scrollOffset: instance.scrollOffset ?? 0,
    })
  );
  const virtualMessages = messageVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!messageJumpRequest || messageJumpRequest.sessionId !== sessionId) {
      return;
    }
    if (handledMessageJumpRequestIdRef.current === messageJumpRequest.requestId) {
      return;
    }
    const messageIndex = messageKeys?.indexOf(messageJumpRequest.key) ?? -1;
    if (messageIndex < 0) {
      return;
    }

    handledMessageJumpRequestIdRef.current = messageJumpRequest.requestId;
    messageVirtualizer.scrollToIndex(messageIndex, { align: "start" });
    setMessageJumpHighlightKey(messageJumpRequest.key);
  }, [messageJumpRequest, messageKeys, messageVirtualizer, sessionId]);

  useEffect(() => {
    if (!messageJumpHighlightKey || typeof window === "undefined") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setMessageJumpHighlightKey((current) => current === messageJumpHighlightKey ? null : current);
    }, 1200);
    return () => window.clearTimeout(timeoutId);
  }, [messageJumpHighlightKey]);

  useEffect(() => {
    setMessageJumpHighlightKey(null);
    handledMessageJumpRequestIdRef.current = null;
  }, [sessionId]);
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
      findTextMatches(text, findQuery).forEach((_, occurrenceIndex) => {
        matches.push({ kind: "message", messageIndex, occurrenceIndex });
      });
      if (messageIndex === pendingMessageGroupEndIndex) {
        appendPendingMatches();
      }
    });
    if (pendingMessageGroupEndIndex < 0) {
      appendPendingMatches();
    }
    return matches;
  }, [findQuery, messageRenderedSearchTexts, pendingMessageGroupEndIndex, pendingRenderedSearchText]);
  const findMatchMessageIndexes = useMemo(
    () => new Set(
      messageFindMatches
        .filter((match): match is Extract<typeof match, { kind: "message" }> => match.kind === "message")
        .map((match) => match.messageIndex),
    ),
    [messageFindMatches],
  );
  const activeCurrentFindMatch = clampFindMatchIndex(currentFindMatch, messageFindMatches.length);
  const canRenderGroupedPendingInlineContent =
    pendingMessageGroupEndIndex >= 0 &&
    virtualMessages.some((virtualMessage) => virtualMessage.index === pendingMessageGroupEndIndex);
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
    return messages.length > 0 ? messages.length - 1 : null;
  }, [messages.length, pendingMessageGroupEndIndex]);
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

  const visibleMessageSignature = virtualMessages.map((message) => {
    const key = getMessageKey(message.index);
    const target = messageCollapseTargetByKey.get(key);
    const isCollapsed = !!target && collapsedMessageKeys.has(key);
    const isTemporarilyExpanded = findOpen && hasFindQuery && findMatchMessageIndexes.has(message.index);
    return `${message.index}:${isCollapsed && !isTemporarilyExpanded ? "collapsed" : "expanded"}`;
  }).join(",");
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
    messageCollapseTargetByKey,
    collapsedMessageKeys,
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
      <CharacterAvatar character={character} size="small" className="message-avatar" />
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
              markdownLinkFileContext={markdownLinkFileContext}
              glossaryAnnotationMatcher={glossaryAnnotationMatcher}
              glossaryAnnotationScopeKey={`${sessionId}:pending:${pendingMessageGroupId ?? "main"}`}
              onActivateGlossaryEntry={onActivateGlossaryEntry}
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
      {onJumpToBottom ? (
        <button
          className="message-list-jump-bottom-button"
          type="button"
          onClick={onJumpToBottom}
          aria-label="末尾へ移動"
          title="末尾へ移動"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 2v9M3.5 7.5 8 12l4.5-4.5M3 14h10" />
          </svg>
        </button>
      ) : null}
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
            const artifact = loadedArtifactDetails[artifactKey] ?? message.artifact;
            const artifactLoading = loadingArtifactDetails[artifactKey] ?? false;
            const artifactOperations =
              artifact?.operationTimeline ??
              artifact?.activitySummary.map((item) => ({
                type: "summary",
                summary: item,
                details: undefined,
              })) ??
              [];
            const artifactOperationsOpen = isArtifactFoldOpen(artifactKey, "operations");
            const canUseMessageTextActions = isAssistant && (onCopyMessageText || onQuoteMessageText);
            const messageCollapseTarget = messageCollapseTargetByKey.get(messageKey);
            const isMessageCollapsed = !!messageCollapseTarget && collapsedMessageKeys.has(messageKey);
            const isFindMatch = findMatchMessageIndexes.has(absoluteIndex);
            const shouldRenderFullMessage = !isMessageCollapsed || (findOpen && hasFindQuery && isFindMatch);
            const messageBodyId = `message-body-${messageKey.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
            const messageCollapseLabel = isMessageCollapsed ? "メッセージを展開" : "メッセージを縮小";
            const isMessageBookmarked = messageCollapseTarget?.isBookmarked === true;
            const messageBookmarkLabel = isMessageBookmarked ? "Remove bookmark" : "Add bookmark";

            return (
              <div
                key={`${message.role}-${messageKey}`}
                ref={messageVirtualizer.measureElement}
                className={`session-message-virtual-row${
                  doesMessageGroupContinue ? " auxiliary-message-group-continues" : ""
                }${absoluteIndex === messages.length - 1 ? " session-message-virtual-row-end" : ""}${
                  messageJumpHighlightKey === messageKey ? " message-jump-highlight" : ""
                }`}
                data-index={absoluteIndex}
              >
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
                className={`message-row ${message.role}${message.accent ? " accent" : ""}${
                  messageGroup ? " auxiliary-message-group-item" : ""
                }${isMessageGroupStart ? " auxiliary-message-group-start" : ""}${
                  shouldCloseMessageGroup ? " auxiliary-message-group-end" : ""
                }`}
              >
                {isAssistant ? (
                  <div className="message-avatar-stack">
                    <CharacterAvatar character={character} size="small" className="message-avatar" />
                    {artifact ? (
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
                  </div>
                ) : null}
                <div className={`message-card ${message.role}${message.accent ? " accent" : ""}${artifact ? " has-artifact" : ""}${isMessageCollapsed ? " is-collapsed" : ""}${isMessageCollapsed && shouldRenderFullMessage ? " is-find-temporary-expanded" : ""}`}>
                  <div className="message-card-content">
                    {artifact && !isAssistant ? (
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
                    <div className={`message-text-wrapper${messageCollapseTarget && (onToggleMessageCollapse || onToggleMessageBookmark) ? " has-message-collapse-control" : ""}`}>
                      {messageCollapseTarget && (onToggleMessageCollapse || onToggleMessageBookmark) ? (
                        <div className="message-collapse-control">
                          {onToggleMessageCollapse ? (
                            <button
                              className="message-collapse-toggle"
                              type="button"
                              onClick={() => onToggleMessageCollapse(messageKey)}
                              aria-expanded={!isMessageCollapsed}
                              aria-controls={messageBodyId}
                              aria-label={`${messageCollapseLabel}: ${messageCollapseTarget.preview}`}
                              title={messageCollapseLabel}
                            >
                              <span aria-hidden="true">{isMessageCollapsed ? "+" : "−"}</span>
                              <span className="visually-hidden">{messageCollapseLabel}</span>
                            </button>
                          ) : null}
                          {onToggleMessageBookmark ? (
                            <button
                              className={`message-bookmark-toggle${isMessageBookmarked ? " is-bookmarked" : ""}`}
                              type="button"
                              aria-pressed={isMessageBookmarked}
                              aria-label={messageBookmarkLabel}
                              title={messageBookmarkLabel}
                              onClick={() => void onToggleMessageBookmark(messageCollapseTarget)}
                            >
                              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                                <path d="M4 2.25h8a.75.75 0 0 1 .75.75v10.2l-4.75-2.55-4.75 2.55V3a.75.75 0 0 1 .75-.75Z" />
                              </svg>
                              <span className="visually-hidden">{messageBookmarkLabel}</span>
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      <div
                        id={messageBodyId}
                        data-message-body="true"
                        data-message-text-actions={canUseMessageTextActions ? "true" : undefined}
                      >
                        {shouldRenderFullMessage ? (
                          <MessageRichText
                            text={message.text}
                            forceFullRender={findOpen && hasFindQuery}
                            displayMode={messageViewMode}
                            onOpenPath={onOpenPath}
                            markdownLinkFileContext={markdownLinkFileContext}
                            glossaryAnnotationMatcher={glossaryAnnotationMatcher}
                            glossaryAnnotationScopeKey={messageKey}
                            onActivateGlossaryEntry={onActivateGlossaryEntry}
                          />
                        ) : (
                          <p className="message-collapsed-preview">{messageCollapseTarget?.preview}</p>
                        )}
                      </div>
                    </div>

                    {artifact ? (
                      <section className="artifact-shell">
                      {artifactExpanded ? (
                        <div id={`artifact-panel-${artifactKey}`} className="artifact-block">
                          {artifactLoading ? (
                            <div className="artifact-detail-loading" role="status">
                              Details を読み込んでいます...
                            </div>
                          ) : null}
                          <div className="artifact-grid artifact-grid-single">
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
                              <details
                                className="artifact-fold artifact-operations-fold"
                                open={artifactOperationsOpen}
                                onToggle={(event) => {
                                  handleArtifactFoldToggle(artifactKey, "operations", event.currentTarget.open);
                                }}
                              >
                                <summary
                                  className="artifact-fold-summary artifact-operations-summary"
                                  aria-controls={`artifact-operations-panel-${artifactKey}`}
                                  aria-expanded={artifactOperationsOpen}
                                >
                                  <span className="artifact-fold-summary-copy">
                                    <strong>Operations</strong>
                                    <span>{artifactOperations.length} {artifactOperations.length === 1 ? "operation" : "operations"}</span>
                                  </span>
                                </summary>
                                <div id={`artifact-operations-panel-${artifactKey}`} className="artifact-fold-body artifact-operations-body">
                                  {artifactOperations.map((operation, operationIndex) => {
                                    const operationSummary = collapseSummaryText(operation.summary) || operationTypeLabel(operation.type);
                                    const operationOpen = isArtifactFoldOpen(artifactKey, "operation", operationIndex);
                                    const operationPanelId = `artifact-operation-panel-${artifactKey}-${operationIndex}`;
                                    return (
                                      <article key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                        <details
                                          className="artifact-operation-fold"
                                          open={operationOpen}
                                          onToggle={(event) => {
                                            handleArtifactFoldToggle(artifactKey, "operation", event.currentTarget.open, operationIndex);
                                          }}
                                        >
                                          <summary
                                            className="artifact-operation-summary"
                                            title={operationSummary}
                                            aria-controls={operationPanelId}
                                            aria-expanded={operationOpen}
                                          >
                                            <div className="artifact-operation-head">
                                              <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                              <span className="artifact-operation-summary-text">{operationSummary}</span>
                                            </div>
                                          </summary>
                                          <div id={operationPanelId} className="artifact-operation-body">
                                            {operation.type === "agent_message" ? (
                                              <div className="artifact-operation-message">
                                                <MessageRichText
                                                  text={operation.summary}
                                                  onOpenPath={onOpenPath}
                                                  markdownLinkFileContext={markdownLinkFileContext}
                                                />
                                              </div>
                                            ) : (
                                              <p>{operation.summary}</p>
                                            )}
                                            {operation.details ? <pre>{operation.details}</pre> : null}
                                          </div>
                                        </details>
                                      </article>
                                    );
                                  })}
                                </div>
                              </details>
                            </section>
                          ) : null}
                        </div>
                      ) : null}
                      </section>
                    ) : null}
                  </div>
                </div>
                </article>
                {shouldRenderGroupedPending ? renderPendingRow("auxiliary-message-group-item auxiliary-message-group-end") : null}
              </div>
            );
          })}
            </div>
            {isRunning && hasPendingInlineContent && !canRenderGroupedPendingInlineContent ? renderPendingRow() : null}
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
