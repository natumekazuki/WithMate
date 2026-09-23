import { Component, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import type { LiveBackgroundTask, SessionContextTelemetry } from "../../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../../src-shared/character/character-state.js";

import { CharacterAvatar, liveRunStepDetailsLabel, liveRunStepStatusLabel, operationTypeLabel } from "../../ui/ui-utils.js";

import {
  contextPaneTabLabel,
  liveRunStepToneClassName,
  sessionBackgroundActivityStatusLabel,
  type ContextPaneProjection,
  type ContextPaneTabKey,
  type LatestCommandView,
  type RunningDetailsEntry,
  type SessionContextTelemetryProjection,
} from "../runtime/session-ui-projection.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";

import { SessionSwitcher, type SessionSwitcherOption } from "../../chat/session-switcher.js";

import type { MessageNavigatorEntry } from "../conversation/session-message-collapse.js";
import {
  SessionGlossaryPane,
  type SessionGlossaryPaneProps,
} from "../../glossary/SessionGlossaryPane.js";

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

export type SessionContextPaneProps = {
  activeContextPaneTab: ContextPaneTabKey;
  availableContextPaneTabs: ContextPaneTabKey[];
  contextPaneProjection: ContextPaneProjection;
  latestCommandView: LatestCommandView | null;
  runningDetailsEntries: RunningDetailsEntry[];
  liveRunReasoningText: string;
  backgroundTasks: LiveBackgroundTask[];
  selectedSessionLiveRunErrorMessage: string;
  isSelectedSessionRunning: boolean;
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedSessionContextTelemetryProjection: SessionContextTelemetryProjection;
  messageNavigatorEntries?: readonly MessageNavigatorEntry[];
  messageNavigatorSessionId?: string;
  messageNavigatorCharacter?: CharacterProfile;
  glossaryPaneProps?: SessionGlossaryPaneProps;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
  onSelectContextPaneTab?: (tab: ContextPaneTabKey) => void;
  onJumpToMessage?: (key: string) => void;
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
      errorMessage: error.message || "Could not render the right pane.",
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
                    <strong>Right Pane Error</strong>
                    <p className="live-run-error">{this.state.errorMessage}</p>
                    <div className="window-error-actions pane-error-actions">
                      <button type="button" onClick={this.handleRetry}>
                        Retry Right Pane
                      </button>
                      <button className="drawer-toggle secondary" type="button" onClick={this.handleReload}>
                        Reload Window
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

export function SessionContextPane({
  activeContextPaneTab,
  availableContextPaneTabs,
  contextPaneProjection,
  latestCommandView,
  runningDetailsEntries,
  liveRunReasoningText,
  backgroundTasks,
  selectedSessionLiveRunErrorMessage,
  isSelectedSessionRunning,
  isCopilotSession,
  selectedCopilotRemainingPercentLabel,
  selectedCopilotRemainingRequestsLabel,
  selectedCopilotQuotaResetLabel,
  selectedSessionContextTelemetry,
  selectedSessionContextTelemetryProjection,
  messageNavigatorEntries = [],
  messageNavigatorSessionId,
  messageNavigatorCharacter,
  glossaryPaneProps,
  onCycleContextPaneTab,
  onSelectContextPaneTab,
  onJumpToMessage,
}: SessionContextPaneProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messageNavigatorButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [messageNavigatorFocusIndex, setMessageNavigatorFocusIndex] = useState(0);
  const [messageNavigatorFilter, setMessageNavigatorFilter] = useState<"all" | "bookmarks">("all");
  const taskEntries = backgroundTasks ?? [];
  const messageNavigatorBookmarksEnabled = messageNavigatorSessionId !== undefined;
  const visibleMessageNavigatorEntries = useMemo(
    () => messageNavigatorBookmarksEnabled && messageNavigatorFilter === "bookmarks"
      ? messageNavigatorEntries.filter((entry) => entry.isBookmarked)
      : messageNavigatorEntries,
    [messageNavigatorBookmarksEnabled, messageNavigatorEntries, messageNavigatorFilter],
  );
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
      case "messages":
        return visibleMessageNavigatorEntries
          .map((entry) => `${entry.key}:${entry.preview}:${entry.isCollapsed ? "collapsed" : "expanded"}:${entry.isBookmarked ? "bookmarked" : "unbookmarked"}`)
          .join("|");
      case "glossary":
        return "glossary";
      default:
        return "";
    }
  }, [
    activeContextPaneTab,
    latestCommandView,
    liveRunReasoningText,
    runningDetailsEntries,
    isSelectedSessionRunning,
    messageNavigatorEntries,
    visibleMessageNavigatorEntries,
    taskEntries,
    selectedSessionLiveRunErrorMessage,
  ]);

  useEffect(() => {
    setMessageNavigatorFocusIndex((current) => visibleMessageNavigatorEntries.length === 0
      ? 0
      : Math.min(current, visibleMessageNavigatorEntries.length - 1));
  }, [visibleMessageNavigatorEntries.length]);

  useEffect(() => {
    setMessageNavigatorFilter("all");
    setMessageNavigatorFocusIndex(0);
  }, [messageNavigatorSessionId]);

  const handleMessageNavigatorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (visibleMessageNavigatorEntries.length === 0) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (index + direction + visibleMessageNavigatorEntries.length) % visibleMessageNavigatorEntries.length;
      const nextEntry = visibleMessageNavigatorEntries[nextIndex];
      setMessageNavigatorFocusIndex(nextIndex);
      nextEntry && messageNavigatorButtonRefs.current[nextEntry.key]?.focus();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const entry = visibleMessageNavigatorEntries[index];
      if (entry) {
        onJumpToMessage?.(entry.key);
      }
    }
  }, [onJumpToMessage, visibleMessageNavigatorEntries]);

  const messageNavigatorCharacterName = messageNavigatorCharacter?.name.trim() || "Character";
  const messageNavigatorSpeakerLabel = (entry: MessageNavigatorEntry): string => {
    if (entry.role === "user") {
      return "Your message";
    }
    return entry.sourceKind === "auxiliary"
      ? `${messageNavigatorCharacterName}（Auxiliary）`
      : messageNavigatorCharacterName;
  };

  const renderMessageNavigatorSpeaker = (entry: MessageNavigatorEntry) => {
    if (entry.role === "user") {
      return <span className="messages-navigator-speaker-glyph user" aria-hidden="true">↗</span>;
    }
    if (entry.sourceKind === "session" && messageNavigatorCharacter) {
      return <CharacterAvatar character={messageNavigatorCharacter} size="tiny" />;
    }
    return (
      <span className={`messages-navigator-speaker-glyph assistant${entry.accent ? " accent" : ""}`} aria-hidden="true">
        ✦
      </span>
    );
  };

  useLayoutEffect(() => {
    const contentNode = contentRef.current;
    if (!contentNode) {
      return;
    }

    contentNode.scrollTop = activeContextPaneTab === "messages"
      || activeContextPaneTab === "glossary"
      ? 0
      : contentNode.scrollHeight;
  }, [contentScrollKey]);

  return (
    <aside className="session-context-pane session-context-pane-header-expanded">
      <section className={`command-monitor-shell ${activeContextPaneTab}${messageNavigatorBookmarksEnabled ? " has-message-filter-toolbar" : ""}`} aria-label="Right pane">
        <div className="command-monitor-head">
          <SessionSwitcher
            ariaLabel="Right pane view"
            options={availableContextPaneTabs.map((tab): SessionSwitcherOption => ({
              id: tab,
              label: contextPaneTabLabel(tab),
            }))}
            selectedId={activeContextPaneTab}
            onMove={onCycleContextPaneTab}
            onSelect={(tab) => onSelectContextPaneTab?.(tab as ContextPaneTabKey)}
          />
        </div>

        <div ref={contentRef} className="command-monitor-content">
          {activeContextPaneTab === "messages" && messageNavigatorBookmarksEnabled ? (
            <div className="messages-navigator-filter-toolbar" role="group" aria-label="Messages filter">
              <button
                className={`messages-navigator-filter${messageNavigatorFilter === "all" ? " is-active" : ""}`}
                type="button"
                aria-pressed={messageNavigatorFilter === "all"}
                onClick={() => setMessageNavigatorFilter("all")}
              >
                All
              </button>
              <button
                className={`messages-navigator-filter${messageNavigatorFilter === "bookmarks" ? " is-active" : ""}`}
                type="button"
                aria-pressed={messageNavigatorFilter === "bookmarks"}
                onClick={() => setMessageNavigatorFilter("bookmarks")}
              >
                Bookmark
              </button>
            </div>
          ) : null}
          <div className={`command-monitor-stack ${activeContextPaneTab}`}>
            {activeContextPaneTab === "latest-command" && runningDetailsEntries.length > 0 ? (
              <div className="command-monitor-card">
                <div className="command-monitor-card-head">
                  <div className="command-monitor-meta">
                    <span className="live-run-step-type">Details</span>
                    <span className="command-monitor-source">Confirmed</span>
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
                        <div className="live-run-command-summary compact" aria-label="Confirmed command">
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
                      <div className="command-monitor-risk-list" aria-label="Command risk">
                        {latestCommandView.riskLabels.map((label) => (
                          <span key={label} className={`command-monitor-risk ${label.toLowerCase()}`}>
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="live-run-command-summary" aria-label="Executed command">
                    <span className="live-run-command-prefix" aria-hidden="true">
                      $
                    </span>
                    <code className="live-run-command-text">{latestCommandView.summary}</code>
                  </div>

                  {latestCommandView.details ? (
                    <details className="command-monitor-details live-run-step-details">
                      <summary>Command Details</summary>
                      <pre>{latestCommandView.details}</pre>
                    </details>
                  ) : null}

                  {selectedSessionLiveRunErrorMessage && isSelectedSessionRunning ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>Run Error</strong>
                      <p className="live-run-error">{selectedSessionLiveRunErrorMessage}</p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="command-monitor-empty-shell">
                  {selectedSessionLiveRunErrorMessage ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>Run Error</strong>
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
                      <span className="command-monitor-source">Copilot</span>
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
                            <summary>Task Details</summary>
                            <pre>{task.details}</pre>
                          </details>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : <div className="command-monitor-empty-shell" />
            ) : null}

            {activeContextPaneTab === "reasoning" ? (
              liveRunReasoningText.trim().length > 0 ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${contextPaneProjection.reasoningToneClassName}`}>
                        {isSelectedSessionRunning ? "Running" : "Retained"}
                      </span>
                      <span className="live-run-step-type">Reasoning</span>
                      <span className="command-monitor-source">
                        {isSelectedSessionRunning ? "Live Run" : "Last Run"}
                      </span>
                    </div>
                  </div>
                  <div className="command-monitor-details live-run-step-details live-reasoning-details">
                    <pre>{liveRunReasoningText}</pre>
                  </div>
                </div>
              ) : (
                <div className="command-monitor-empty-shell" />
              )
            ) : null}

            {activeContextPaneTab === "messages" ? (
              <div className="messages-navigator">
                <div className="messages-navigator-list" role="list" aria-label="Messages">
                  {visibleMessageNavigatorEntries.length > 0 ? visibleMessageNavigatorEntries.map((entry, index) => {
                    const speakerLabel = messageNavigatorSpeakerLabel(entry);
                    const bookmarkStateLabel = entry.isBookmarked ? ", Bookmark saved" : "";
                    return (
                      <button
                        key={entry.key}
                        ref={(node) => {
                          messageNavigatorButtonRefs.current[entry.key] = node;
                        }}
                        className={`messages-navigator-row${entry.isCollapsed ? " is-collapsed" : ""}`}
                        type="button"
                        tabIndex={index === messageNavigatorFocusIndex ? 0 : -1}
                        aria-label={`${speakerLabel}${bookmarkStateLabel}: ${entry.preview}`}
                        title={`${speakerLabel}${bookmarkStateLabel}: ${entry.preview}`}
                        onFocus={() => setMessageNavigatorFocusIndex(index)}
                        onKeyDown={(event) => handleMessageNavigatorKeyDown(event, index)}
                        onClick={() => onJumpToMessage?.(entry.key)}
                      >
                        <span className={`messages-navigator-speaker${entry.accent ? " accent" : ""}`}>
                          {renderMessageNavigatorSpeaker(entry)}
                        </span>
                        <span className="messages-navigator-copy">
                          <span className="messages-navigator-preview">{entry.preview}</span>
                          {entry.isCollapsed ? (
                            <span className="messages-navigator-state" aria-label="Collapsed">Collapsed</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  }) : messageNavigatorBookmarksEnabled && messageNavigatorFilter === "bookmarks" ? null : (
                    <div className="command-monitor-empty-shell" />
                  )}
                </div>
              </div>
            ) : null}

            {activeContextPaneTab === "glossary" && glossaryPaneProps ? (
              <SessionGlossaryPane {...glossaryPaneProps} scrollContainerRef={contentRef} />
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
            ) : null}
          </details>
        </section>
      ) : null}
    </aside>
  );
}
