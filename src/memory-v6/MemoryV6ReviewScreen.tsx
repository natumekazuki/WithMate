import { useEffect, useMemo, useRef, useState } from "react";

import { useDialogA11y } from "../ui/a11y.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import type { MemoryEntryKind, MemoryForgetReason } from "../../src-shared/memory/memory-contract.js";
import type {
  MemoryV6ReviewApi,
  MemoryV6ReviewEntryDetail,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewSearchHit,
} from "../../src-shared/memory/memory-review-state.js";
import type { MemoryFileUsageResponse } from "../../src-shared/memory/memory-response-contract.js";

type MemoryV6ReviewScreenProps = {
  homePageClassName: string;
  getApi: () => MemoryV6ReviewApi | null;
};

type SearchOptions = { cursor?: string; append?: boolean };
type OperationFeedback = { message: string; error?: boolean };

const MEMORY_KIND_OPTIONS: MemoryEntryKind[] = [
  "decision",
  "constraint",
  "convention",
  "context",
  "deferred",
  "preference",
  "relationship",
  "boundary",
  "note",
];

const MEMORY_KIND_LABELS: Record<MemoryEntryKind, string> = {
  decision: "Decision",
  constraint: "Constraint",
  convention: "Convention",
  context: "Context",
  deferred: "Deferred",
  preference: "Preference",
  relationship: "Relationship",
  boundary: "Boundary",
  note: "Note",
};

const FORGET_REASON_OPTIONS: MemoryForgetReason[] = [
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
];

const FORGET_REASON_LABELS: Record<MemoryForgetReason, string> = {
  user_request: "User Request",
  incorrect: "Incorrect",
  outdated: "Outdated",
  privacy: "Privacy",
  other: "Other",
};

function ownerLabel(entry: Pick<MemoryV6ReviewSearchHit, "owner" | "scope">): string {
  return `${entry.owner.type}:${entry.owner.id} / ${entry.scope.type}:${entry.scope.id}`;
}

function formatTags(entry: Pick<MemoryV6ReviewSearchHit, "tags">): string {
  return entry.tags.map((tag) => `${tag.type}:${tag.value}`).join(" / ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

function formatPercent(usedBytes: number, quotaBytes: number): string {
  if (quotaBytes <= 0) {
    return "0%";
  }
  return `${Math.min(999, Math.round((usedBytes / quotaBytes) * 100))}%`;
}

export function MemoryV6ReviewScreen({ homePageClassName, getApi }: MemoryV6ReviewScreenProps) {
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<MemoryEntryKind | "">("");
  const [items, setItems] = useState<MemoryV6ReviewSearchHit[]>([]);
  const [fileUsage, setFileUsage] = useState<MemoryFileUsageResponse | null>(null);
  const [gcReport, setGcReport] = useState<MemoryV6ProtectedObjectGcResponse | null>(null);
  const [nextCursor, setNextCursor] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<MemoryV6ReviewEntryDetail | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [forgetReason, setForgetReason] = useState<MemoryForgetReason>("user_request");
  const [searchError, setSearchError] = useState<{ message: string; options?: SearchOptions } | null>(null);
  const [usageError, setUsageError] = useState("");
  const [entryError, setEntryError] = useState("");
  const [entryFeedback, setEntryFeedback] = useState<OperationFeedback | null>(null);
  const [gcFeedback, setGcFeedback] = useState<OperationFeedback | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [entryLoading, setEntryLoading] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [runningGc, setRunningGc] = useState<"dry-run" | "cleanup" | null>(null);
  const [confirmForgetOpen, setConfirmForgetOpen] = useState(false);
  const cancelForgetButtonRef = useRef<HTMLButtonElement | null>(null);
  const entryRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const refreshRequestIdRef = useRef(0);
  const usageRequestIdRef = useRef(0);

  const closeForgetConfirm = () => {
    if (!forgetting) {
      setConfirmForgetOpen(false);
    }
  };

  const {
    dialogRef: forgetDialogRef,
    handleDialogKeyDown: handleForgetDialogKeyDown,
  } = useDialogA11y<HTMLElement>({
    open: confirmForgetOpen,
    onClose: closeForgetConfirm,
    initialFocusRef: cancelForgetButtonRef,
  });

  const searchRequest = useMemo(() => ({
    query,
    ...(selectedKind ? { kinds: [selectedKind] } : {}),
    limit: 50,
  }), [query, selectedKind]);

  const runSearch = async (options?: SearchOptions) => {
    const requestId = ++searchRequestIdRef.current;
    const api = getApi();
    if (!api) {
      setSearchError({ message: "Memory review requires the desktop runtime.", options });
      if (options?.append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
        setLoadingMore(false);
      }
      return;
    }
    const append = options?.append === true;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadingMore(false);
      setNextCursor("");
    }
    try {
      const result = await api.searchMemoryV6Entries({
        ...searchRequest,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      });
      if (requestId !== searchRequestIdRef.current) {
        return;
      }
      setItems((currentItems) => append ? [...currentItems, ...result.items] : result.items);
      setNextCursor(result.nextCursor ?? "");
      setSearchError(null);
      if (!append && selectedEntryId && !result.items.some((item) => item.id === selectedEntryId)) {
        ++entryRequestIdRef.current;
        setEntryLoading(false);
        setSelectedEntry(null);
        setSelectedEntryId("");
        setEntryError("");
        setConfirmForgetOpen(false);
      }
    } catch (error) {
      if (requestId === searchRequestIdRef.current) {
        setSearchError({ message: error instanceof Error ? error.message : "Could not search Memory entries.", options });
      }
    } finally {
      if (requestId === searchRequestIdRef.current) {
        if (append) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    }
  };

  const loadFileUsage = async () => {
    const requestId = ++usageRequestIdRef.current;
    setUsageLoading(true);
    const api = getApi();
    if (!api) {
      setUsageError("Memory review requires the desktop runtime.");
      setUsageLoading(false);
      return;
    }
    try {
      const nextFileUsage = await api.getMemoryV6FileUsage();
      if (requestId === usageRequestIdRef.current) {
        setFileUsage(nextFileUsage);
        setUsageError("");
      }
    } catch (error) {
      if (requestId === usageRequestIdRef.current) {
        setUsageError(error instanceof Error ? error.message : "Could not load Memory file usage.");
      }
    } finally {
      if (requestId === usageRequestIdRef.current) {
        setUsageLoading(false);
      }
    }
  };

  const refreshReview = async () => {
    const requestId = ++refreshRequestIdRef.current;
    setRefreshing(true);
    try {
      await Promise.all([runSearch(), loadFileUsage()]);
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    void runSearch();
  }, [searchRequest]);

  useEffect(() => {
    void loadFileUsage();
    document.title = "Memory Review";
  }, []);

  const selectEntry = async (entryId: string) => {
    const requestId = ++entryRequestIdRef.current;
    setSelectedEntryId(entryId);
    if (entryId !== selectedEntryId) {
      setSelectedEntry(null);
      setEntryError("");
      setEntryFeedback(null);
    }
    setConfirmForgetOpen(false);
    setEntryLoading(true);
    const api = getApi();
    if (!api) {
      setEntryLoading(false);
      setEntryError("Memory review requires the desktop runtime.");
      return;
    }
    try {
      const entry = await api.getMemoryV6Entry(entryId);
      if (requestId !== entryRequestIdRef.current) {
        return;
      }
      setEntryLoading(false);
      if (!entry || entry.id !== entryId) {
        setSelectedEntry(null);
        setEntryError("Memory entry was not found or is no longer active.");
        return;
      }
      setSelectedEntry(entry);
      setEntryError("");
    } catch (error) {
      if (requestId !== entryRequestIdRef.current) {
        return;
      }
      setEntryLoading(false);
      setEntryError(error instanceof Error ? error.message : "Could not load the Memory entry.");
    }
  };

  const forgetSelectedEntry = async () => {
    if (!selectedEntryId || !selectedEntry || selectedEntry.id !== selectedEntryId || forgetting) {
      return;
    }
    const api = getApi();
    if (!api) {
      setEntryFeedback({ message: "Memory review requires the desktop runtime.", error: true });
      return;
    }
    setForgetting(true);
    setEntryFeedback(null);
    try {
      const result = await api.forgetMemoryV6Entry(selectedEntryId, forgetReason);
      ++entryRequestIdRef.current;
      setEntryLoading(false);
      setEntryError("");
      setEntryFeedback({ message: `Forget result: ${result.status}` });
      setSelectedEntry(null);
      setSelectedEntryId("");
      setConfirmForgetOpen(false);
      await refreshReview();
    } catch (error) {
      setEntryFeedback({ message: error instanceof Error ? error.message : "Could not forget the Memory entry.", error: true });
    } finally {
      setForgetting(false);
    }
  };

  const exportSelectedEntryFiles = async () => {
    if (!selectedEntryId || !selectedEntry || selectedEntry.id !== selectedEntryId || exporting) {
      return;
    }
    const api = getApi();
    if (!api) {
      setEntryFeedback({ message: "Memory review requires the desktop runtime.", error: true });
      return;
    }
    setExporting(true);
    setEntryFeedback(null);
    try {
      const result = await api.exportMemoryV6EntryFiles(selectedEntryId);
      setEntryFeedback({ message: result ? `${result.exportedCount} files exported.` : "Memory file export canceled." });
    } catch (error) {
      setEntryFeedback({ message: error instanceof Error ? error.message : "Could not export Memory files.", error: true });
    } finally {
      setExporting(false);
    }
  };

  const runProtectedObjectGc = async (dryRun: boolean) => {
    if (runningGc) {
      return;
    }
    if (!dryRun && !window.confirm("Delete pending Memory files, orphan protected object files, and stale staging files? This permanently removes files that are no longer referenced by active Memory entries.")) {
      return;
    }
    const api = getApi();
    if (!api) {
      setGcFeedback({ message: "Memory review requires the desktop runtime.", error: true });
      return;
    }
    const gcAction = dryRun ? "dry-run" : "cleanup";
    const entryRequestId = entryRequestIdRef.current;
    setRunningGc(gcAction);
    setGcFeedback(null);
    try {
      const report = await api.runMemoryV6ProtectedObjectGc({ dryRun, limit: 100 });
      setGcReport(report);
      await refreshReview();
      if (selectedEntryId && selectedEntryId === selectedEntry?.id && entryRequestId === entryRequestIdRef.current) {
        await selectEntry(selectedEntryId);
      }
      setGcFeedback({ message: dryRun ? "Memory file GC dry-run completed." : "Memory file GC cleanup completed." });
    } catch (error) {
      setGcFeedback({ message: error instanceof Error ? error.message : "Could not run Memory file GC.", error: true });
    } finally {
      setRunningGc(null);
    }
  };

  return (
    <div className={`${homePageClassName} home-page-memory-review`.trim()}>
      <main className="home-layout home-layout-settings-window memory-review-layout">
        <section className="memory-review-shell">
          <header className="memory-review-header">
            <div>
              <h1>Memory Review</h1>
            </div>
            <button
              className="launch-toggle"
              type="button"
              onClick={() => void refreshReview()}
              disabled={refreshing || loading || loadingMore}
              aria-busy={refreshing}
              aria-label={refreshing ? "Refreshing Memory review" : "Refresh Memory review"}
            >
              <ButtonContent busy={refreshing} busyLabel="Refreshing Memory review.">
                Refresh
              </ButtonContent>
            </button>
          </header>

          <div className="memory-review-toolbar">
            <label className="settings-provider-input">
              <span>Search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="settings-provider-input">
              <span>Kind</span>
              <select value={selectedKind} onChange={(event) => setSelectedKind(event.target.value as MemoryEntryKind | "")}>
                <option value="">All Kinds</option>
                {MEMORY_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{MEMORY_KIND_LABELS[kind]}</option>)}
              </select>
            </label>
          </div>

          <div className="memory-review-grid">
            <section className="memory-review-list" aria-label="Memory entries" aria-busy={loading || loadingMore || undefined}>
              {searchError ? (
                <div className="memory-review-error">
                  <p role="alert">{searchError.message}</p>
                  <button type="button" className="launch-toggle" aria-label="Retry Memory search" aria-busy={loading || loadingMore} disabled={loading || loadingMore} onClick={() => void runSearch(searchError.options)}>
                    <ButtonContent busy={loading || loadingMore} busyLabel="Loading Memory entries.">Retry</ButtonContent>
                  </button>
                </div>
              ) : loading ? (
                <LoadingIndicator inline className="settings-loading-inline" label="Loading Memory entries" />
              ) : null}
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`memory-review-item ${selectedEntryId === item.id ? "active" : ""}`.trim()}
                  type="button"
                  aria-pressed={selectedEntryId === item.id}
                  onClick={() => void selectEntry(item.id)}
                >
                  <span className="memory-review-item-title">{item.title || "(untitled)"}</span>
                  <span className="memory-review-item-preview">{item.preview}</span>
                  <span className="memory-review-item-meta">{item.kind} / {ownerLabel(item)}</span>
                  {item.tags.length > 0 ? <span className="memory-review-item-meta">{formatTags(item)}</span> : null}
                </button>
              ))}
              {nextCursor ? (
                <button
                  className="memory-review-load-more"
                  type="button"
                  onClick={() => void runSearch({ cursor: nextCursor, append: true })}
                  disabled={loading || loadingMore}
                  aria-busy={loadingMore || undefined}
                  aria-label={loadingMore ? "Loading more Memory entries" : "Load more Memory entries"}
                >
                  <ButtonContent busy={loadingMore} busyLabel="Loading more Memory entries.">
                    Load More
                  </ButtonContent>
                </button>
              ) : null}
            </section>

            <section className="memory-review-detail" aria-label="Memory entry detail" aria-busy={entryLoading}>
              <div className="memory-review-detail-content" tabIndex={0} role="region" aria-label="Memory entry content">
                {entryError ? (
                  <div className="memory-review-error">
                    <p role="alert">{entryError}</p>
                    <button type="button" className="launch-toggle" aria-label="Retry Memory entry" aria-busy={entryLoading} disabled={entryLoading} onClick={() => void selectEntry(selectedEntryId)}>
                      <ButtonContent busy={entryLoading} busyLabel="Loading Memory entry.">Retry</ButtonContent>
                    </button>
                  </div>
                ) : entryLoading ? <LoadingIndicator inline className="settings-loading-inline" label="Loading Memory entry" /> : null}
                {selectedEntry && selectedEntry.id === selectedEntryId ? (
                  <>
                    <div className="memory-review-detail-head">
                      <div>
                        <h2>{selectedEntry.title || "(untitled)"}</h2>
                        <p>{selectedEntry.kind} / {ownerLabel(selectedEntry)}</p>
                      </div>
                      <span>{selectedEntry.updatedAt}</span>
                    </div>
                    <dl className="memory-review-meta">
                      <div>
                        <dt>Source</dt>
                        <dd>{selectedEntry.source.sessionId ?? "none"} / {selectedEntry.source.providerId ?? "none"}</dd>
                      </div>
                      {selectedEntry.tags.length > 0 ? (
                        <div>
                          <dt>Tags</dt>
                          <dd>{formatTags(selectedEntry)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {selectedEntry.files && selectedEntry.files.length > 0 ? (
                      <section className="memory-review-files" aria-label="Protected files">
                        <div className="memory-review-files-head">
                          <h3>Protected Files</h3>
                          <button
                            type="button"
                            onClick={() => void exportSelectedEntryFiles()}
                            disabled={exporting || refreshing || entryLoading}
                            aria-busy={exporting || undefined}
                            aria-label={exporting ? "Exporting Memory files" : "Export Memory files"}
                          >
                            <ButtonContent busy={exporting} busyLabel="Exporting Memory files.">
                              Export Files
                            </ButtonContent>
                          </button>
                        </div>
                        <ul>
                          {selectedEntry.files.map((file, index) => (
                            <li key={`${file.role}-${file.mediaKind}-${file.displayName}-${index}`}>
                              <div>
                                <strong>{file.displayName || file.mediaKind}</strong>
                                <span>{file.role} / {file.mediaKind} / {formatBytes(file.originalBytes)}</span>
                              </div>
                              <p>{file.summary}</p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    <div className="memory-review-body">
                      <pre>{selectedEntry.body}</pre>
                    </div>
                  </>
                ) : null}
              </div>
              {entryFeedback && !confirmForgetOpen ? <p className="settings-feedback memory-review-feedback" role={entryFeedback.error ? "alert" : "status"}>{entryFeedback.message}</p> : null}
              {selectedEntry && selectedEntry.id === selectedEntryId ? (
                <div className="memory-review-forget-row">
                  <label className="settings-provider-input">
                    <span>Forget Reason</span>
                    <select value={forgetReason} onChange={(event) => setForgetReason(event.target.value as MemoryForgetReason)}>
                      {FORGET_REASON_OPTIONS.map((reason) => <option key={reason} value={reason}>{FORGET_REASON_LABELS[reason]}</option>)}
                    </select>
                  </label>
                  <button
                    className="launch-toggle danger-button"
                    type="button"
                    onClick={() => setConfirmForgetOpen(true)}
                    disabled={forgetting || entryLoading}
                    aria-busy={forgetting || undefined}
                    aria-label={forgetting ? "Forgetting Memory entry" : "Forget Memory entry"}
                  >
                    <ButtonContent busy={forgetting} busyLabel="Forgetting Memory entry.">
                      Forget Entry
                    </ButtonContent>
                  </button>
                </div>
              ) : null}
            </section>
          </div>

          <section className="memory-review-usage" aria-label="Memory file usage" aria-busy={usageLoading}>
            {usageError ? (
              <div className="memory-review-error">
                <p role="alert">{usageError}</p>
                <button type="button" className="launch-toggle" aria-label="Retry Memory file usage" aria-busy={usageLoading} disabled={usageLoading} onClick={() => void loadFileUsage()}>
                  <ButtonContent busy={usageLoading} busyLabel="Loading Memory file usage.">Retry</ButtonContent>
                </button>
              </div>
            ) : usageLoading ? <LoadingIndicator inline label="Loading Memory file usage" /> : null}
            {fileUsage ? (
              <>
                <div className="memory-review-usage-summary">
                  <div>
                    <span>Used</span>
                    <strong>{formatBytes(fileUsage.usedBytes)}</strong>
                    <small>{formatPercent(fileUsage.usedBytes, fileUsage.quotaBytes)} of {formatBytes(fileUsage.quotaBytes)}</small>
                  </div>
                  <div>
                    <span>Available</span>
                    <strong>{formatBytes(fileUsage.availableBytes)}</strong>
                    <small>{fileUsage.objectCount} active objects</small>
                  </div>
                  <div>
                    <span>Pending Delete</span>
                    <strong>{formatBytes(fileUsage.pendingDeleteBytes)}</strong>
                    <small>{fileUsage.pendingDeleteCount} objects</small>
                  </div>
                </div>
                {fileUsage.largestEntries && fileUsage.largestEntries.length > 0 ? (
                  <div className="memory-review-largest-entries">
                    <span>Largest Entries</span>
                    <div>
                      {fileUsage.largestEntries.map((entry) => (
                        <button key={entry.entryId} type="button" onClick={() => void selectEntry(entry.entryId)}>
                          <strong>{entry.title || "(untitled)"}</strong>
                          <small>{formatBytes(entry.totalFileBytes)} / {entry.fileCount} files</small>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="memory-review-gc-actions">
                  <button
                    type="button"
                    onClick={() => void runProtectedObjectGc(true)}
                    disabled={runningGc !== null || refreshing}
                    aria-busy={runningGc === "dry-run"}
                    aria-label={runningGc === "dry-run" ? "Running Memory file GC dry run" : "Run Memory file GC dry run"}
                  >
                    <ButtonContent busy={runningGc === "dry-run"} busyLabel="Running Memory file GC dry run.">
                      GC Dry Run
                    </ButtonContent>
                  </button>
                  <button
                    type="button"
                    onClick={() => void runProtectedObjectGc(false)}
                    disabled={runningGc !== null || refreshing}
                    aria-busy={runningGc === "cleanup"}
                    aria-label={runningGc === "cleanup" ? "Running Memory file GC cleanup" : "Run Memory file GC cleanup"}
                  >
                    <ButtonContent busy={runningGc === "cleanup"} busyLabel="Running Memory file GC cleanup.">
                      Run GC Cleanup
                    </ButtonContent>
                  </button>
                </div>
              </>
            ) : null}
            {gcFeedback ? <p className="settings-feedback memory-review-feedback" role={gcFeedback.error ? "alert" : "status"}>{gcFeedback.message}</p> : null}
            {gcReport ? (
              <div className="memory-review-gc-report" aria-label="Memory file GC report">
                <span>{gcReport.dryRun ? "Dry Run" : "Cleanup"}</span>
                <small>
                  Pending {gcReport.deletePending.candidates} / deleted {gcReport.deletePending.deleted} / missing {gcReport.deletePending.missing ?? 0} / failed {gcReport.deletePending.failed}
                </small>
                <small>
                  Orphan {gcReport.orphanFiles.candidates} / deleted {gcReport.orphanFiles.deleted} / failed {gcReport.orphanFiles.failed}
                </small>
                <small>
                  Staging {gcReport.stagingFiles.candidates} / deleted {gcReport.stagingFiles.deleted} / failed {gcReport.stagingFiles.failed}
                </small>
                <small>Missing active {gcReport.missingActiveObjects}</small>
              </div>
            ) : null}
          </section>
        </section>
      </main>
      {confirmForgetOpen && selectedEntry && selectedEntry.id === selectedEntryId ? (
        <div className="memory-review-modal-backdrop" role="presentation" onClick={closeForgetConfirm}>
          <section
            ref={forgetDialogRef}
            className="memory-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-review-forget-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleForgetDialogKeyDown}
          >
            <header>
              <h2 id="memory-review-forget-title">Forget Memory Entry</h2>
              <button
                className="diff-close"
                type="button"
                aria-label="Close"
                onClick={closeForgetConfirm}
                disabled={forgetting}
              >
                x
              </button>
            </header>
            <div className="memory-review-modal-body">
              <p>Remove this Memory entry from search?</p>
              <strong>{selectedEntry.title || selectedEntry.id}</strong>
              <span>{selectedEntry.kind} / {ownerLabel(selectedEntry)}</span>
              <span>Reason: {forgetReason}</span>
              {forgetReason === "privacy" ? (
                <span>For privacy requests, the title, body, preview, and tags are also deleted.</span>
              ) : null}
              {entryFeedback ? <p role={entryFeedback.error ? "alert" : "status"}>{entryFeedback.message}</p> : null}
            </div>
            <footer>
              <button
                ref={cancelForgetButtonRef}
                className="launch-toggle"
                type="button"
                onClick={closeForgetConfirm}
                disabled={forgetting}
              >
                Cancel
              </button>
              <button
                className="launch-toggle danger-button"
                type="button"
                onClick={() => void forgetSelectedEntry()}
                disabled={forgetting}
                aria-busy={forgetting || undefined}
                aria-label={forgetting ? "Forgetting Memory entry" : "Forget Memory entry"}
              >
                <ButtonContent busy={forgetting} busyLabel="Forgetting Memory entry.">
                  Forget Entry
                </ButtonContent>
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
