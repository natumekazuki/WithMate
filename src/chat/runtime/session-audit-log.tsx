import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { AuditLogDetailFragment, AuditLogDetailSection, AuditLogSummary } from "../../../src-shared/session/runtime-state.js";

import { useDialogA11y } from "../../ui/a11y.js";

function displayApprovalValue(value: string): string { return value.trim() || "-"; }

function auditPhaseLabel(phase: AuditLogSummary["phase"]): string {
  switch (phase) {
    case "running":
    case "started":
      return "Running";
    case "background-running":
      return "BackgroundRunning";
    case "completed":
      return "Completed";
    case "background-completed":
      return "BackgroundCompleted";
    case "canceled":
      return "Canceled";
    case "background-canceled":
      return "BackgroundCanceled";
    case "failed":
      return "Failed";
    case "background-failed":
      return "BackgroundFailed";
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

type MessageArtifactFoldSection = "operation" | "operations";

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

function AuditLogLoadingIndicator({ label }: { label: string }) {
  return (
    <span className="settings-loading-inline" role="status" aria-label={label}>
      <span className="settings-action-spinner" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
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
      <summary>{label} ({value.length.toLocaleString("en-US")} chars)</summary>
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
  refreshing?: boolean;
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
  refreshing = false,
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
    <div
      className="diff-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-audit-log-title"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        className="audit-log-panel panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="diff-titlebar">
          <h2 id="session-audit-log-title">AuditLog</h2>
        </div>

        <div className="audit-log-toolbar">
          <div className="audit-log-segmented" aria-label="Audit log view">
            <button
              type="button"
              className={`audit-log-segmented-button${activeSection === "main" ? " is-active" : ""}`}
              aria-pressed={activeSection === "main"}
              onClick={() => setActiveSection("main")}
            >
              Main
            </button>
            <button
              type="button"
              className={`audit-log-segmented-button${activeSection === "background" ? " is-active" : ""}`}
              aria-pressed={activeSection === "background"}
              onClick={() => setActiveSection("background")}
            >
              Background
            </button>
          </div>
          <div className="audit-log-page-status">
            <span>{entries.length} / {total}</span>
            {refreshing ? (
              <span className="audit-log-page-status-refreshing settings-loading-inline" role="status" aria-label="Refreshing audit log">
                <span className="settings-action-spinner" aria-hidden="true" />
                <span className="visually-hidden">Refreshing audit log.</span>
              </span>
            ) : null}
            {errorMessage ? <span className="audit-log-page-error" role="alert">{errorMessage}</span> : null}
          </div>
        </div>

        <div ref={auditLogListRef} className="audit-log-list" aria-busy={refreshing || loadingMore || undefined}>
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
                        <span>Input {usage.inputTokens}</span>
                        <span>Cached {usage.cachedInputTokens}</span>
                        <span>Output {usage.outputTokens}</span>
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
                    <strong>LogicalPrompt</strong>
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
                          ? <AuditLogLoadingIndicator label="Loading audit log details." />
                          : sectionError("logical") ?? "Open to load audit log details."}
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
                    <strong>TransportPayload</strong>
                  </summary>
                  {transportOpen ? <section className="audit-log-section">
                    {detail?.transportPayload ? (
                      <>
                        <p><strong>{detail.transportPayload.summary || "TransportPayload"}</strong></p>
                        {detail.transportPayload.fields.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            {detail.transportPayload.fields.map((field, index) => (
                              <div key={`${entry.id}-${field.label}-${index}`} className="audit-log-transport-field">
                                <p><strong>{field.label}</strong></p>
                                <pre>{previewAuditLogText(field.value || "-")}</pre>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      sectionLoading("transport") ? (
                        <AuditLogLoadingIndicator label="Loading audit log details." />
                      ) : sectionError("transport") ?? null
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
                      <AuditLogLoadingIndicator label="Loading audit log details." />
                    ) : sectionError("response") ? (
                      <p className="audit-log-empty">{sectionError("response")}</p>
                    ) : (
                      <>
                        <pre>{previewAuditLogText(assistantText || "-")}</pre>
                        {interimMessages.length > 0 ? (
                          <div className="audit-log-transport-fields">
                            <p><strong>InterimMessages</strong></p>
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
                      <AuditLogLoadingIndicator label="Loading audit log details." />
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
                                    <AuditLogLoadingIndicator label="Loading operation details." />
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
                    ) : null}
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
                        <span>Input {usage.inputTokens}</span>
                        <span>Cached {usage.cachedInputTokens}</span>
                        <span>Output {usage.outputTokens}</span>
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
                    <strong>RawItems</strong>
                  </summary>
                  {rawOpen ? (
                    <section className="audit-log-section compact">
                      {detail?.rawItemsJson !== undefined ? (
                        <AuditLogTextPreview value={detail.rawItemsJson} />
                      ) : sectionLoading("raw") ? (
                        <AuditLogLoadingIndicator label="Loading raw audit log items." />
                      ) : (
                        <AuditLogTextPreview value={sectionError("raw") ?? "[]"} />
                      )}
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
            aria-busy={loadingMore}
            aria-label={loadingMore ? "Loading more audit log entries" : "Load more audit log entries"}
          >
            {loadingMore ? (
              <>
                <span className="settings-action-spinner" aria-hidden="true" />
                <span>LoadMore</span>
                <span className="visually-hidden">Loading more audit log entries.</span>
              </>
            ) : "LoadMore"}
          </button>
        ) : null}
      </section>
    </div>
  );
}
