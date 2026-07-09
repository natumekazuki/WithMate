import { useEffect, useMemo, useRef, useState } from "react";

import { useDialogA11y } from "../a11y.js";
import type { MemoryEntryKind, MemoryForgetReason } from "./memory-contract.js";
import type {
  MemoryV6ReviewApi,
  MemoryV6ReviewEntryDetail,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewSearchHit,
} from "./memory-review-state.js";
import type { MemoryFileUsageResponse } from "./memory-response-contract.js";

type MemoryV6ReviewScreenProps = {
  homePageClassName: string;
  getApi: () => MemoryV6ReviewApi | null;
};

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

const FORGET_REASON_OPTIONS: MemoryForgetReason[] = [
  "user_request",
  "incorrect",
  "outdated",
  "privacy",
  "other",
];

function ownerLabel(entry: Pick<MemoryV6ReviewSearchHit, "owner" | "scope">): string {
  return `${entry.owner.type}:${entry.owner.id} / ${entry.scope.type}:${entry.scope.id}`;
}

function formatTags(entry: Pick<MemoryV6ReviewSearchHit, "tags">): string {
  if (entry.tags.length === 0) {
    return "no tags";
  }
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
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [runningGc, setRunningGc] = useState(false);
  const [confirmForgetOpen, setConfirmForgetOpen] = useState(false);
  const cancelForgetButtonRef = useRef<HTMLButtonElement | null>(null);

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

  const runSearch = async (options?: { cursor?: string; append?: boolean }) => {
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    const append = options?.append === true;
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setNextCursor("");
    }
    try {
      const result = await api.searchMemoryV6Entries({
        ...searchRequest,
        ...(options?.cursor ? { cursor: options.cursor } : {}),
      });
      setItems((currentItems) => append ? [...currentItems, ...result.items] : result.items);
      setNextCursor(result.nextCursor ?? "");
      setFeedback(!append && result.items.length === 0 ? "一致する active Memory はありません。" : "");
      if (!append && selectedEntryId && !result.items.some((item) => item.id === selectedEntryId)) {
        setSelectedEntry(null);
        setSelectedEntryId("");
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory の検索に失敗しました。");
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  };

  const loadFileUsage = async () => {
    const api = getApi();
    if (!api) {
      return;
    }
    try {
      setFileUsage(await api.getMemoryV6FileUsage());
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory file usage の読み込みに失敗しました。");
    }
  };

  const refreshReview = async () => {
    await Promise.all([runSearch(), loadFileUsage()]);
  };

  useEffect(() => {
    void refreshReview();
  }, [searchRequest]);

  useEffect(() => {
    document.title = "WithMate Memory Review";
  }, []);

  const selectEntry = async (entryId: string) => {
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    setSelectedEntryId(entryId);
    try {
      const entry = await api.getMemoryV6Entry(entryId);
      setSelectedEntry(entry);
      setFeedback(entry ? "" : "Memory entry は見つからないか、すでに inactive です。");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory entry の読み込みに失敗しました。");
    }
  };

  const forgetSelectedEntry = async () => {
    if (!selectedEntryId || !selectedEntry || forgetting) {
      return;
    }
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    setForgetting(true);
    try {
      const result = await api.forgetMemoryV6Entry(selectedEntryId, forgetReason);
      setFeedback(`Forget result: ${result.status}`);
      setSelectedEntry(null);
      setSelectedEntryId("");
      setConfirmForgetOpen(false);
      await refreshReview();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory entry の forget に失敗しました。");
    } finally {
      setForgetting(false);
    }
  };

  const exportSelectedEntryFiles = async () => {
    if (!selectedEntryId || !selectedEntry || exporting) {
      return;
    }
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    setExporting(true);
    setFeedback("");
    try {
      const result = await api.exportMemoryV6EntryFiles(selectedEntryId);
      setFeedback(result ? `${result.exportedCount} files exported.` : "Memory file export をキャンセルしました。");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory file export に失敗しました。");
    } finally {
      setExporting(false);
    }
  };

  const runProtectedObjectGc = async (dryRun: boolean) => {
    if (runningGc) {
      return;
    }
    if (!dryRun && !window.confirm("Delete pending Memory files and orphan protected object files?")) {
      return;
    }
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    setRunningGc(true);
    setFeedback("");
    try {
      const report = await api.runMemoryV6ProtectedObjectGc({ dryRun, limit: 100 });
      setGcReport(report);
      await refreshReview();
      if (selectedEntryId) {
        await selectEntry(selectedEntryId);
      }
      setFeedback(dryRun ? "Memory file GC dry-run completed." : "Memory file GC cleanup completed.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory file GC に失敗しました。");
    } finally {
      setRunningGc(false);
    }
  };

  return (
    <div className={`${homePageClassName} home-page-memory-review`.trim()}>
      <main className="home-layout home-layout-settings-window memory-review-layout">
        <section className="memory-review-shell">
          <header className="memory-review-header">
            <div>
              <h1>Memory Review</h1>
              <p>V6 Memory の active entry を確認し、不要な entry を検索対象から外す。</p>
            </div>
            <button className="launch-toggle" type="button" onClick={() => void refreshReview()} disabled={loading}>
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </header>

          <div className="memory-review-toolbar">
            <label className="settings-provider-input">
              <span>Search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="title, body, tag, owner"
              />
            </label>
            <label className="settings-provider-input">
              <span>Kind</span>
              <select value={selectedKind} onChange={(event) => setSelectedKind(event.target.value as MemoryEntryKind | "")}>
                <option value="">All kinds</option>
                {MEMORY_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
          </div>

          {feedback ? <p className="settings-feedback memory-review-feedback">{feedback}</p> : null}

          {fileUsage ? (
            <section className="memory-review-usage" aria-label="Memory file usage">
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
                  <span>Pending delete</span>
                  <strong>{formatBytes(fileUsage.pendingDeleteBytes)}</strong>
                  <small>{fileUsage.pendingDeleteCount} objects</small>
                </div>
              </div>
              {fileUsage.largestEntries && fileUsage.largestEntries.length > 0 ? (
                <div className="memory-review-largest-entries">
                  <span>Largest entries</span>
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
                <button type="button" onClick={() => void runProtectedObjectGc(true)} disabled={runningGc}>
                  {runningGc ? "Running" : "GC dry-run"}
                </button>
                <button type="button" onClick={() => void runProtectedObjectGc(false)} disabled={runningGc}>
                  Cleanup GC
                </button>
              </div>
              {gcReport ? (
                <div className="memory-review-gc-report" aria-label="Memory file GC report">
                  <span>{gcReport.dryRun ? "Dry-run" : "Cleanup"}</span>
                  <small>
                    pending {gcReport.deletePending.candidates} / deleted {gcReport.deletePending.deleted} / missing {gcReport.deletePending.missing ?? 0} / failed {gcReport.deletePending.failed}
                  </small>
                  <small>
                    orphan {gcReport.orphanFiles.candidates} / deleted {gcReport.orphanFiles.deleted} / failed {gcReport.orphanFiles.failed}
                  </small>
                  <small>
                    staging {gcReport.stagingFiles.candidates} / deleted {gcReport.stagingFiles.deleted} / failed {gcReport.stagingFiles.failed}
                  </small>
                  <small>missing active {gcReport.missingActiveObjects}</small>
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="memory-review-grid">
            <section className="memory-review-list" aria-label="Memory entries">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`memory-review-item ${selectedEntryId === item.id ? "active" : ""}`.trim()}
                  type="button"
                  onClick={() => void selectEntry(item.id)}
                >
                  <span className="memory-review-item-title">{item.title || "(untitled)"}</span>
                  <span className="memory-review-item-preview">{item.preview}</span>
                  <span className="memory-review-item-meta">{item.kind} / {ownerLabel(item)}</span>
                  <span className="memory-review-item-meta">{formatTags(item)}</span>
                </button>
              ))}
              {nextCursor ? (
                <button
                  className="memory-review-load-more"
                  type="button"
                  onClick={() => void runSearch({ cursor: nextCursor, append: true })}
                  disabled={loading || loadingMore}
                >
                  {loadingMore ? "Loading more" : "Load more"}
                </button>
              ) : null}
              {items.length === 0 && !loading ? <p className="settings-note">active Memory entry はありません。</p> : null}
            </section>

            <section className="memory-review-detail" aria-label="Memory entry detail">
              {selectedEntry ? (
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
                    <div>
                      <dt>Tags</dt>
                      <dd>{formatTags(selectedEntry)}</dd>
                    </div>
                  </dl>
                  {selectedEntry.files && selectedEntry.files.length > 0 ? (
                    <section className="memory-review-files" aria-label="Protected files">
                      <div className="memory-review-files-head">
                        <h3>Protected files</h3>
                        <button type="button" onClick={() => void exportSelectedEntryFiles()} disabled={exporting}>
                          {exporting ? "Exporting" : "Export files"}
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
                  <div className="memory-review-forget-row">
                    <label className="settings-provider-input">
                      <span>Forget reason</span>
                      <select value={forgetReason} onChange={(event) => setForgetReason(event.target.value as MemoryForgetReason)}>
                        {FORGET_REASON_OPTIONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                      </select>
                    </label>
                    <button
                      className="launch-toggle danger-button"
                      type="button"
                      onClick={() => setConfirmForgetOpen(true)}
                      disabled={forgetting}
                    >
                      {forgetting ? "Forgetting" : "Forget Entry"}
                    </button>
                  </div>
                </>
              ) : null}
            </section>
          </div>
        </section>
      </main>
      {confirmForgetOpen && selectedEntry ? (
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
              <h2 id="memory-review-forget-title">Memory entry を検索対象から除外</h2>
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
              <p>この memory entry を検索対象から除外しますか？</p>
              <strong>{selectedEntry.title || selectedEntry.id}</strong>
              <span>reason: {forgetReason}</span>
              {forgetReason === "privacy" ? (
                <span>privacy reason では title、body、preview、tags も削除されます。</span>
              ) : null}
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
              <button className="launch-toggle danger-button" type="button" onClick={() => void forgetSelectedEntry()} disabled={forgetting}>
                {forgetting ? "Forgetting" : "Forget Entry"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
