import { SelectionActionOverlayBoundary } from "../conversation/selection-action-overlay-context.js";
import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

import type { LiveBackgroundTask } from "../../../src-shared/session/runtime-state.js";

import type { ChatWindowModeKind } from "../../chat/chat-window-mode.js";

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
                      {isPinPending ? "Updating..." : isPinned ? "Unpin" : "Pin"}
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
  auxiliaryHeader?: ReactNode;
  auxiliaryMessageColumn?: ReactNode;
  auxiliarySplitter?: ReactNode;
  isAuxiliaryVisible?: boolean;
  auxiliaryWidthRatio?: number;
  concurrentTarget?: "main" | "auxiliary";
  mainContent?: ReactNode;
  workSurfaceOverlay?: ReactNode;
  supportingSurface?: ReactNode;
  errorSurface?: ReactNode;
  recoveryActions?: ReactNode;
  actionDock: ReactNode;
  actionDockSplitter: ReactNode;
  isActionDockExpanded: boolean;
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

export function SessionChatScreen({
  mode,
  className = "",
  style,
  header,
  headerSplitter,
  isHeaderVisible,
  messageColumn,
  auxiliaryHeader = null,
  auxiliaryMessageColumn = null,
  auxiliarySplitter = null,
  isAuxiliaryVisible = false,
  auxiliaryWidthRatio = 0.5,
  concurrentTarget = "main",
  mainContent,
  workSurfaceOverlay = null,
  supportingSurface = null,
  errorSurface = null,
  recoveryActions = null,
  actionDock,
  actionDockSplitter,
  isActionDockExpanded,
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
  const ownLayoutRef = useRef<HTMLDivElement | null>(null);
  const centralRef = useRef<HTMLElement | null>(null);
  const previousActionDockExpandedRef = useRef(isActionDockExpanded);
  const [isActionDockTransitioning, setIsActionDockTransitioning] = useState(false);
  const [isCentralCollapsed, setIsCentralCollapsed] = useState(false);
  const setLayoutElementRefs = useCallback((node: HTMLDivElement | null) => {
    ownLayoutRef.current = node;
    if (layoutRef) {
      layoutRef.current = node;
    }
    if (workbenchRef) {
      workbenchRef.current = node;
    }
  }, [layoutRef, workbenchRef]);
  const layoutStyle = useMemo(() => ({ ...style, ...workbenchStyle }), [style, workbenchStyle]);
  useLayoutEffect(() => {
    if (previousActionDockExpandedRef.current === isActionDockExpanded) {
      return;
    }

    previousActionDockExpandedRef.current = isActionDockExpanded;
    const layout = ownLayoutRef.current;
    const motionDuration = layout?.ownerDocument.defaultView
      ?.getComputedStyle(layout)
      .getPropertyValue("--session-dock-motion-duration")
      .trim() ?? "0ms";
    const motionDurationMs = motionDuration.endsWith("ms")
      ? Number.parseFloat(motionDuration)
      : motionDuration.endsWith("s")
        ? Number.parseFloat(motionDuration) * 1000
        : Number.parseFloat(motionDuration);
    setIsActionDockTransitioning(Number.isFinite(motionDurationMs) && motionDurationMs > 0);
  }, [isActionDockExpanded]);
  const handleLayoutTransitionEnd = useCallback((event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") {
      return;
    }
    setIsActionDockTransitioning(false);
  }, []);
  useLayoutEffect(() => {
    const layout = ownLayoutRef.current;
    const central = centralRef.current;
    if (!layout || !central) return;
    const measure = () => {
      const view = layout.ownerDocument.defaultView!;
      const css = view.getComputedStyle(layout);
      const pixel = (value: string) => Number.parseFloat(value) || 0;
      const height = layout.clientHeight - pixel(css.paddingTop) - pixel(css.paddingBottom);
      const narrow = view.innerWidth < 1400;
      const sideHeight = narrow
        ? pixel(css.getPropertyValue("--session-left-pane-track-width"))
          + pixel(css.getPropertyValue("--session-right-pane-track-width")) : 0;
      const remaining = height - sideHeight
        - pixel(css.getPropertyValue("--session-header-dock-row-height"))
        - pixel(css.getPropertyValue("--session-dock-splitter-size")) * (narrow ? 4 : 2)
        - pixel(css.getPropertyValue("--session-action-dock-height"));
      const minimum = pixel(view.getComputedStyle(central).getPropertyValue("--session-region-min-height"));
      setIsCentralCollapsed(isActionDockExpanded && remaining < minimum);
    };
    measure();
    const Observer = layout.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer ? new Observer(measure) : null;
    observer?.observe(layout);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [layoutStyle, isActionDockExpanded, isHeaderVisible, isLeftPaneVisible, isRightPaneVisible]);
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const [columnSizes, setColumnSizes] = useState({ width: 0, main: 0, auxiliary: 0, splitter: 0 });
  useLayoutEffect(() => {
    const columns = columnsRef.current;
    if (!columns || !isAuxiliaryVisible) return;
    const measure = () => {
      const minimum = (selector: string) => {
        const element = columns.querySelector<HTMLElement>(selector);
        return element ? Number.parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue("--session-region-min-width")) || 0 : 0;
      };
      const next = {
        width: columns.getBoundingClientRect().width,
        main: minimum(".session-concurrent-chat-main"),
        auxiliary: minimum(".session-concurrent-chat-auxiliary"),
        splitter: Number.parseFloat(columns.ownerDocument.defaultView!.getComputedStyle(columns).getPropertyValue("--session-dock-splitter-size")) || 0,
      };
      setColumnSizes((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    measure();
    const Observer = columns.ownerDocument.defaultView?.ResizeObserver;
    const observer = Observer ? new Observer(measure) : null;
    observer?.observe(columns);
    return () => observer?.disconnect();
  }, [isAuxiliaryVisible, mainContent !== undefined]);
  const singleChat = auxiliaryWidthRatio > 0 && auxiliaryWidthRatio < 1 && columnSizes.width > 0
    && columnSizes.width < columnSizes.main + columnSizes.auxiliary + columnSizes.splitter;
  const contentWidth = columnSizes.width - columnSizes.splitter;
  const effectiveRatio = auxiliaryWidthRatio <= 0 ? 0 : auxiliaryWidthRatio >= 1 ? 1
    : contentWidth > 0 && !singleChat
      ? Math.max(columnSizes.auxiliary / contentWidth, Math.min(1 - columnSizes.main / contentWidth, auxiliaryWidthRatio))
      : auxiliaryWidthRatio;
  const hasAuxiliaryHeader = auxiliaryWidthRatio > 0 && auxiliaryHeader != null;

  return (
    <div
      ref={setLayoutElementRefs}
      className={`page-shell session-page session-chat-layout${isHeaderVisible ? " is-header-visible" : ""}${
        isActionDockExpanded ? " is-action-dock-expanded" : ""
      }${isActionDockTransitioning ? " is-action-dock-transitioning" : ""}${
        isLeftPaneVisible ? " is-left-pane-visible" : ""
      }${
        isRightPaneVisible ? " is-right-pane-visible" : ""
      }${isCentralCollapsed ? " is-central-collapsed" : ""}${className ? ` ${className}` : ""}`}
      style={layoutStyle}
      data-session-mode={mode}
      onTransitionEnd={handleLayoutTransitionEnd}
      onTransitionCancel={handleLayoutTransitionEnd}
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
      <section
        ref={centralRef}
        aria-hidden={isCentralCollapsed}
        inert={isCentralCollapsed}
        className="chat-panel session-work-surface session-message-stack rise-3"
        style={isAuxiliaryVisible && mainContent === undefined && columnSizes.main > 0
          ? { "--session-region-min-width": `${(auxiliaryWidthRatio <= 0 ? columnSizes.main : auxiliaryWidthRatio >= 1 ? columnSizes.auxiliary : columnSizes.main + columnSizes.auxiliary) + columnSizes.splitter}px` } as CSSProperties
          : undefined}
      >
        <div
          className={`session-central-surface${isAuxiliaryVisible ? ` has-concurrent-chats concurrent-target-${concurrentTarget}` : ""}`}
          style={isAuxiliaryVisible ? { "--auxiliary-width-ratio": auxiliaryWidthRatio } as CSSProperties : undefined}
          hidden={mainContent !== undefined}
        >
          {isAuxiliaryVisible ? (
            <div
              ref={columnsRef}
              className={`session-concurrent-chat-columns${singleChat ? " is-single-chat" : ""}`}
              style={{ gridTemplateColumns: `minmax(0, ${Math.max(0, 1 - effectiveRatio)}fr) var(--session-dock-splitter-size) minmax(0, ${Math.max(0, effectiveRatio)}fr)` }}
            >
              <div className={`session-concurrent-chat-column session-concurrent-chat-main${auxiliaryWidthRatio >= 1 ? " is-zero-width" : ""}`} inert={!singleChat && auxiliaryWidthRatio >= 1} aria-hidden={!singleChat && auxiliaryWidthRatio >= 1}>{messageColumn}</div>
              {auxiliarySplitter}
              <div
                className={`session-concurrent-chat-column session-concurrent-chat-auxiliary${auxiliaryWidthRatio <= 0 ? " is-zero-width" : ""}${hasAuxiliaryHeader ? " has-header" : ""}`}
                inert={!singleChat && auxiliaryWidthRatio <= 0 && !hasAuxiliaryHeader}
                aria-hidden={!singleChat && auxiliaryWidthRatio <= 0 && !hasAuxiliaryHeader}
              >
                {auxiliaryHeader}
                <div
                  className="session-concurrent-chat-message-content"
                  inert={!singleChat && auxiliaryWidthRatio <= 0 && hasAuxiliaryHeader}
                  aria-hidden={!singleChat && auxiliaryWidthRatio <= 0 && hasAuxiliaryHeader}
                >
                  {auxiliaryMessageColumn}
                </div>
              </div>
            </div>
          ) : messageColumn}
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
