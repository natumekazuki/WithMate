import type { CSSProperties, KeyboardEventHandler, ReactNode, RefObject, UIEventHandler } from "react";

import type {
  AuditLogEntry,
  ChangedFile,
  CharacterProfile,
  LiveApprovalRequest,
  Message,
  DiffPreviewPayload,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
  StreamEntry,
} from "./app-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import { MessageRichText } from "./MessageRichText.js";
import { approvalModeLabel, CharacterAvatar, fileKindLabel, operationTypeLabel } from "./ui-utils.js";
import {
  contextPaneTabLabel,
  sessionBackgroundActivityStatusLabel,
  type ContextPaneProjection,
  type ContextPaneTabKey,
  type LatestCommandView,
  type SessionContextTelemetryProjection,
} from "./session-ui-projection.js";

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function displayRunCheckValue(check: { label: string; value: string }): string {
  return check.label.trim().toLowerCase() === "approval" ? displayApprovalValue(check.value) : check.value;
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

function auditPhaseLabel(phase: AuditLogEntry["phase"]): string {
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

export type SessionDiffModalProps = {
  selectedDiff: DiffPreviewPayload | null;
  themeStyle: CSSProperties;
  onClose: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
};

export type SessionHeaderProps = {
  taskTitle: string;
  workspacePath: string;
  isExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
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
  workspacePath,
  isExpanded,
  isEditingTitle,
  titleDraft,
  isRunning,
  onToggleExpanded,
  onClose,
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
    <header className={`session-window-bar session-top-bar rise-1${isExpanded ? " is-expanded" : ""}`}>
      <div className="session-top-bar-row">
        <div className="session-title-shell">
          <span className="session-window-title session-title-accent">{taskTitle}</span>
        </div>
        <div className="session-window-controls">
          <button className="drawer-toggle compact secondary" type="button" onClick={onOpenAuditLog}>
            Audit Log
          </button>
          <button
            className="drawer-toggle compact secondary"
            type="button"
            onClick={onOpenTerminal}
            title={workspacePath}
          >
            Terminal
          </button>
          {!isEditingTitle ? (
            <button
              className="drawer-toggle compact secondary"
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={isExpanded}
            >
              {isExpanded ? "Hide" : "More"}
            </button>
          ) : null}
          <button className="drawer-toggle compact" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {isExpanded ? (
        <div className="session-top-bar-drawer">
          {isEditingTitle ? (
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
          ) : (
            <div className="session-top-bar-manage">
              <button className="drawer-toggle compact secondary" type="button" onClick={onStartTitleEdit} disabled={isRunning}>
                Rename
              </button>
              <button className="drawer-toggle compact danger" type="button" onClick={onDeleteSession} disabled={isRunning}>
                Delete
              </button>
            </div>
          )}
        </div>
      ) : null}
    </header>
  );
}

export function SessionDiffModal({
  selectedDiff,
  themeStyle,
  onClose,
  onOpenDiffWindow,
}: SessionDiffModalProps) {
  if (!selectedDiff) {
    return null;
  }

  return (
    <div className="diff-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        className="diff-editor panel theme-accent"
        style={themeStyle}
        onClick={(event) => event.stopPropagation()}
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
  entries: AuditLogEntry[];
  onClose: () => void;
};

export function SessionAuditLogModal({
  open,
  entries,
  onClose,
}: SessionAuditLogModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="diff-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="audit-log-panel panel" onClick={(event) => event.stopPropagation()}>
        <div className="diff-titlebar">
          <h2>Audit Log</h2>
          <div className="diff-titlebar-actions">
            <button className="diff-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="audit-log-list">
          {entries.length > 0 ? (
            entries.map((entry) => (
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

                <details className="audit-log-fold" open>
                  <summary>
                    <strong>Logical Prompt</strong>
                  </summary>
                  <section className="audit-log-section">
                    <p><strong>System</strong></p>
                    <pre>{entry.logicalPrompt.systemText || "-"}</pre>
                    <p><strong>Input</strong></p>
                    <pre>{entry.logicalPrompt.inputText || "-"}</pre>
                    <p><strong>Composed</strong></p>
                    <pre>{entry.logicalPrompt.composedText || "-"}</pre>
                  </section>
                </details>

                <details className="audit-log-fold">
                  <summary>
                    <strong>Transport Payload</strong>
                  </summary>
                  <section className="audit-log-section">
                    {entry.transportPayload ? (
                      <>
                        <p><strong>{entry.transportPayload.summary || "transport payload"}</strong></p>
                        {entry.transportPayload.fields.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            {entry.transportPayload.fields.map((field, index) => (
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
                      <p className="audit-log-empty">記録された transport payload はまだないよ。</p>
                    )}
                  </section>
                </details>

                <details className="audit-log-fold">
                  <summary>
                    <strong>Response</strong>
                  </summary>
                  <section className="audit-log-section">
                    <pre>{entry.assistantText || "-"}</pre>
                  </section>
                </details>

                <details className="audit-log-fold">
                  <summary>
                    <strong>Operations</strong>
                  </summary>
                  <section className="audit-log-section">
                    {entry.operations.length > 0 ? (
                      <ul className="audit-log-operations">
                        {entry.operations.map((operation, index) => (
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

                {entry.usage ? (
                  <details className="audit-log-fold compact">
                    <summary>
                      <strong>Usage</strong>
                    </summary>
                    <section className="audit-log-section compact">
                      <div className="audit-log-meta">
                        <span>input {entry.usage.inputTokens}</span>
                        <span>cached {entry.usage.cachedInputTokens}</span>
                        <span>output {entry.usage.outputTokens}</span>
                      </div>
                    </section>
                  </details>
                ) : null}

                {entry.errorMessage ? (
                  <details className="audit-log-fold compact">
                    <summary>
                      <strong>Error</strong>
                    </summary>
                    <section className="audit-log-section compact">
                      <pre>{entry.errorMessage}</pre>
                    </section>
                  </details>
                ) : null}

                <details className="audit-log-fold audit-log-raw">
                  <summary>
                    <strong>Raw Items</strong>
                  </summary>
                  <pre>{entry.rawItemsJson}</pre>
                </details>
              </article>
            ))
          ) : (
            <article className="empty-list-card compact">
              <p>まだ監査ログはないよ。</p>
            </article>
          )}
        </div>
      </section>
    </div>
  );
}

export type SessionContextPaneProps = {
  activeContextPaneTab: ContextPaneTabKey;
  contextPaneProjection: ContextPaneProjection;
  latestCommandView: LatestCommandView | null;
  selectedSessionLiveRunErrorMessage: string;
  isSelectedSessionRunning: boolean;
  selectedMemoryGenerationActivity: SessionBackgroundActivityState | null;
  selectedMonologueActivity: SessionBackgroundActivityState | null;
  selectedMonologueEntries: StreamEntry[];
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextTelemetry | null;
  selectedSessionContextTelemetryProjection: SessionContextTelemetryProjection;
  contextEmptyText: string;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
};

export function SessionContextPane({
  activeContextPaneTab,
  contextPaneProjection,
  latestCommandView,
  selectedSessionLiveRunErrorMessage,
  isSelectedSessionRunning,
  selectedMemoryGenerationActivity,
  selectedMonologueActivity,
  selectedMonologueEntries,
  isCopilotSession,
  selectedCopilotRemainingPercentLabel,
  selectedCopilotRemainingRequestsLabel,
  selectedCopilotQuotaResetLabel,
  selectedSessionContextTelemetry,
  selectedSessionContextTelemetryProjection,
  contextEmptyText,
  onCycleContextPaneTab,
}: SessionContextPaneProps) {
  return (
    <aside className="session-context-pane">
      <section className="command-monitor-shell" aria-label="最新 command">
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
            <div className="command-monitor-switcher-current">
              {contextPaneProjection.badgeLabel ? (
                <span className={`command-monitor-badge ${contextPaneProjection.toneClassName}`}>
                  {contextPaneProjection.badgeLabel}
                </span>
              ) : null}
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

        {activeContextPaneTab === "memory-generation" ? (
          selectedMemoryGenerationActivity ? (
            <div className="command-monitor-card">
              <div className="command-monitor-card-head">
                <div className="command-monitor-meta">
                  <span className={`live-run-step-status ${contextPaneProjection.memoryGenerationToneClassName}`}>
                    {sessionBackgroundActivityStatusLabel(selectedMemoryGenerationActivity.status)}
                  </span>
                  <span className="live-run-step-type">Background</span>
                  <span className="command-monitor-source">MEMORY</span>
                </div>
              </div>

              <div className="background-activity-summary">
                <strong>{selectedMemoryGenerationActivity.title}</strong>
                <p>{selectedMemoryGenerationActivity.summary}</p>
              </div>

              {selectedMemoryGenerationActivity.details ? (
                <details className="command-monitor-details live-run-step-details">
                  <summary>詳細</summary>
                  <pre>{selectedMemoryGenerationActivity.details}</pre>
                </details>
              ) : null}

              {selectedMemoryGenerationActivity.errorMessage ? (
                <div className="live-run-error-block" role="alert">
                  <strong>実行エラー</strong>
                  <p className="live-run-error">{selectedMemoryGenerationActivity.errorMessage}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="command-monitor-empty-shell" />
          )
        ) : null}

        {activeContextPaneTab === "monologue" ? (
          selectedMonologueActivity || selectedMonologueEntries.length > 0 ? (
            <>
              {selectedMonologueActivity ? (
                <div className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${contextPaneProjection.monologueToneClassName}`}>
                        {sessionBackgroundActivityStatusLabel(selectedMonologueActivity.status)}
                      </span>
                      <span className="live-run-step-type">Background</span>
                      <span className="command-monitor-source">MONOLOGUE</span>
                    </div>
                  </div>

                  <div className="background-activity-summary">
                    <strong>{selectedMonologueActivity.title}</strong>
                    <p>{selectedMonologueActivity.summary}</p>
                  </div>

                  {selectedMonologueActivity.details ? (
                    <details className="command-monitor-details live-run-step-details">
                      <summary>詳細</summary>
                      <pre>{selectedMonologueActivity.details}</pre>
                    </details>
                  ) : null}

                  {selectedMonologueActivity.errorMessage ? (
                    <div className="live-run-error-block" role="alert">
                      <strong>実行エラー</strong>
                      <p className="live-run-error">{selectedMonologueActivity.errorMessage}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {selectedMonologueEntries.map((entry, index) => (
                <div key={`${entry.time}-${index}`} className="command-monitor-card">
                  <div className="command-monitor-card-head">
                    <div className="command-monitor-meta">
                      <span className={`live-run-step-status ${entry.mood}`}>
                        {entry.mood}
                      </span>
                      <span className="live-run-step-type">{entry.time}</span>
                      <span className="command-monitor-source">MONOLOGUE</span>
                    </div>
                  </div>
                  <div className="background-activity-summary">
                    <p>{entry.text}</p>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <div className="command-monitor-empty-shell" />
          )
        ) : null}
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
        <div className="resume-banner-conflict" role="status" aria-live="polite">
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
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  isMessageListFollowing: boolean;
  hasMessageListUnread: boolean;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onOpenDiff: (title: string, file: ChangedFile) => void;
  onResolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => void;
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
  liveRunAssistantText,
  hasLiveRunAssistantText,
  liveRunErrorMessage,
  isMessageListFollowing,
  hasMessageListUnread,
  onMessageListScroll,
  onToggleArtifact,
  onOpenDiff,
  onResolveLiveApproval,
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
                {isAssistant ? <CharacterAvatar character={character} size="small" className="message-avatar" /> : null}
                <div className={`message-card ${message.role}${message.accent ? " accent" : ""}`}>
                  <MessageRichText text={message.text} onOpenPath={onOpenPath} />

                  {message.artifact ? (
                    <section className="artifact-shell">
                      <div className="artifact-toolbar">
                        <button className="artifact-toggle" type="button" onClick={() => onToggleArtifact(artifactKey)}>
                          {artifactExpanded ? "Hide" : "Details"}
                        </button>
                      </div>

                      {artifactExpanded ? (
                        <div className="artifact-block">
                          <div className="artifact-grid">
                            <section className="artifact-section">
                              <div className="artifact-file-list">
                                {message.artifact.changedFiles.length > 0 ? (
                                  message.artifact.changedFiles.map((file) => (
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
                                  ))
                                ) : (
                                  <article className="artifact-file-item empty-state-card">
                                    <p>{getChangedFilesEmptyText(artifactKey, artifactHasSnapshotRisk)}</p>
                                  </article>
                                )}
                              </div>
                            </section>

                            <section className="artifact-section compact">
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

                          <section className="artifact-section compact">
                            <ul className="artifact-operation-list">
                              {artifactOperations.map((operation, operationIndex) => (
                                <li key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                  <div className="artifact-operation-head">
                                    <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                  </div>
                                  {operation.type === "agent_message" ? (
                                    <div className="artifact-operation-message">
                                      <MessageRichText text={operation.summary} onOpenPath={onOpenPath} />
                                    </div>
                                  ) : (
                                    <p>{operation.summary}</p>
                                  )}
                                  {operation.details ? <pre>{operation.details}</pre> : null}
                                </li>
                              ))}
                            </ul>
                          </section>
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
              {hasLiveRunAssistantText ? <MessageRichText text={liveRunAssistantText} onOpenPath={onOpenPath} /> : null}
              {liveRunErrorMessage ? (
                <p className="pending-run-error-note" role="alert">{liveRunErrorMessage}</p>
              ) : null}
            </div>
          </article>
        ) : null}
      </div>

      {!isMessageListFollowing ? (
        <aside className={`message-follow-banner ${hasMessageListUnread ? "has-unread" : "idle"}`} aria-live="polite">
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
  );
}

export type SessionActionDockCompactRowProps = {
  draft: string;
  actionDockCompactPreview: string;
  attachmentCount: number;
  isRunning: boolean;
  isSendDisabled: boolean;
  onExpand: () => void;
  onSendOrCancel: () => void;
};

export function SessionActionDockCompactRow({
  draft,
  actionDockCompactPreview,
  attachmentCount,
  isRunning,
  isSendDisabled,
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
  approvalOptions: SessionSelectOption[];
  selectedApprovalMode: string;
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
  onChangeApprovalMode: (value: string) => void;
  onChangeModel: (value: string) => void;
  onChangeReasoningEffort: (value: string) => void;
};

export function SessionComposerExpanded({
  retryBanner,
  isRunning,
  composerBlocked,
  canSelectCustomAgent,
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
  approvalOptions,
  selectedApprovalMode,
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
  onChangeModel,
  onChangeReasoningEffort,
}: SessionComposerExpandedProps) {
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
        <div className="composer-agent-toolbar">
          <button
            className={`drawer-toggle compact secondary composer-skill-button${isAgentPickerOpen ? " is-open" : ""}`}
            type="button"
            onClick={onToggleAgentPicker}
            disabled={!canSelectCustomAgent || isRunning || composerBlocked}
            aria-expanded={isAgentPickerOpen}
            aria-haspopup="listbox"
            aria-label="Copilot custom agent を選択"
            title={selectedCustomAgentTitle}
          >
            {selectedCustomAgentLabel}
          </button>
        </div>
        <button
          className={`drawer-toggle compact secondary composer-skill-button${isSkillPickerOpen ? " is-open" : ""}`}
          type="button"
          onClick={onToggleSkillPicker}
          disabled={isRunning || composerBlocked}
          aria-expanded={isSkillPickerOpen}
          aria-haspopup="listbox"
        >
          Skill
        </button>
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

      {isAgentPickerOpen ? (
        <div
          className="composer-path-match-list composer-skill-picker-list"
          role="listbox"
          aria-label="Custom Agent 候補"
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

      {isSkillPickerOpen ? (
        <div
          className="composer-path-match-list composer-skill-picker-list"
          role={skillItems.length > 0 ? "listbox" : "status"}
          aria-label="Skill 候補"
        >
          {isSkillListLoading ? (
            <p className="composer-skill-empty">Skill を読み込み中だよ。</p>
          ) : skillItems.length > 0 ? (
            skillItems.map((item) => (
              <button
                key={item.key}
                type="button"
                role="option"
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

      <div className="composer-box">
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
          aria-describedby={composerSendability.shouldShowFeedback ? "composer-sendability-feedback" : undefined}
        />
        <button
          className={isRunning ? "danger session-send-button" : "session-send-button"}
          type="button"
          onClick={onSendOrCancel}
          disabled={!isRunning && isSendDisabled}
        >
          {isRunning ? "Cancel" : "Send"}
        </button>
        {composerSendability.shouldShowFeedback ? (
          <div
            id="composer-sendability-feedback"
            className={`composer-sendability-feedback ${composerSendability.feedbackTone ?? "helper"}`}
            role={composerSendability.feedbackTone === "blocked" ? "alert" : "status"}
            aria-live={composerSendability.feedbackTone === "blocked" ? "assertive" : "polite"}
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
        <div className="composer-path-match-list" role="listbox" aria-label="@path 候補">
          {workspacePathMatchItems.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={item.isActive}
              className={`composer-path-match${item.isActive ? " active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActivateWorkspacePathMatch(index)}
              onFocus={() => onActivateWorkspacePathMatch(index)}
              onClick={() => onSelectWorkspacePathMatch(item.path)}
              title={item.title}
            >
              <span className="composer-path-match-primary">{item.primaryLabel}</span>
              <span className="composer-path-match-secondary">{item.secondaryLabel}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="composer-settings">
        <div className="composer-setting-field composer-setting-approval">
          <span>Approval</span>
          <div className="choice-list session-approval-list" role="group" aria-label="承認モード">
            {approvalOptions.map((option) => (
              <button
                key={option.value}
                className={`choice-chip${option.value === selectedApprovalMode ? " active" : ""}`}
                type="button"
                onClick={() => onChangeApprovalMode(option.value)}
                disabled={isRunning}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="composer-setting-field">
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

        <div className="composer-setting-field">
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
