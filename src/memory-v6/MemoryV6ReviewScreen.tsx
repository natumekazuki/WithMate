import { useEffect, useMemo, useRef, useState } from "react";

import { useDialogA11y } from "../ui/a11y.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { formatTimestampLabel } from "../../src-shared/time-state.js";
import { MemoryReviewError, type MemoryReviewFailure } from "./MemoryReviewError.js";
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
type OperationFeedback = { message: string; error?: false }
  | (MemoryReviewFailure & { error: true; label: string });

const DESKTOP_RUNTIME_NOTICE = "Memory review requires the desktop runtime.";

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

type TargetIdentity = { id: string; name: string | null; state: string; disambiguation?: string };

function targetLabel(target: TargetIdentity, kind: "Character" | "Project") {
  const name = target.name || (target.state === "missing" ? `Deleted ${kind}` : `Unnamed ${kind}`);
  const supplement = target.disambiguation || (!target.name || target.state === "missing" ? target.id : "");
  return { name: `${name}${target.state === "archived" ? " (Archived)" : ""}`, supplement };
}

function targetName(target: TargetIdentity, kind: "Character" | "Project"): string {
  const { name, supplement } = targetLabel(target, kind);
  return `${name}${supplement ? ` · ${supplement}` : ""}`;
}

function TargetLabel({ target, kind }: { target: TargetIdentity; kind: "Character" | "Project" }) {
  const { name, supplement } = targetLabel(target, kind);
  return <span>{name}{supplement ? <small className="memory-review-target-supplement"> · {supplement}</small> : null}</span>;
}

function MemoryTarget({ target }: { target: MemoryV6ReviewSearchHit["target"] }) {
  return (
    <span className="memory-review-target">
      {target.character ? <span className="memory-review-target-character">
        <CharacterAvatar key={`${target.character.id}:${target.character.iconFilePath}`} size="tiny" character={{ name: target.character.name || "?", iconPath: target.character.iconFilePath || "" }} />
        <TargetLabel target={target.character} kind="Character" />
      </span> : null}
      {target.project ? <span className="memory-review-target-project">{target.character ? " / " : ""}<TargetLabel target={target.project} kind="Project" /></span> : null}
      {target.kind === "user-global" ? <span>User Common</span> : null}
    </span>
  );
}

function formatTags(entry: Pick<MemoryV6ReviewSearchHit, "tags">): string {
  return entry.tags.map((tag) => tag.value).join(" · ");
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

export function MemoryV6ReviewScreen({ homePageClassName, getApi }: MemoryV6ReviewScreenProps) {
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<MemoryEntryKind | "">("");
  const [selectedCharacter, setSelectedCharacter] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [targets, setTargets] = useState<Awaited<ReturnType<MemoryV6ReviewApi["listMemoryV6ReviewTargets"]>> | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<MemoryReviewFailure | null>(null);
  const [items, setItems] = useState<MemoryV6ReviewSearchHit[]>([]);
  const [fileUsage, setFileUsage] = useState<MemoryFileUsageResponse | null>(null);
  const [gcReport, setGcReport] = useState<MemoryV6ProtectedObjectGcResponse | null>(null);
  const [nextCursor, setNextCursor] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<MemoryV6ReviewEntryDetail | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [forgetReason, setForgetReason] = useState<MemoryForgetReason>("user_request");
  const [searchError, setSearchError] = useState<(MemoryReviewFailure & { options?: SearchOptions }) | null>(null);
  const [usageError, setUsageError] = useState<MemoryReviewFailure | null>(null);
  const [entryError, setEntryError] = useState<MemoryReviewFailure | null>(null);
  const [entryFeedback, setEntryFeedback] = useState<OperationFeedback | null>(null);
  const [gcFeedback, setGcFeedback] = useState<MemoryReviewFailure | null>(null);
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
  const exportFilesButtonRef = useRef<HTMLButtonElement | null>(null);
  const forgetButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmForgetActionsRef = useRef<HTMLElement | null>(null);
  const gcActionsRef = useRef<HTMLDivElement | null>(null);
  const entryRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const refreshRequestIdRef = useRef(0);
  const usageRequestIdRef = useRef(0);
  const targetsRequestIdRef = useRef(0);

  const changeFilters = (change: () => void) => {
    ++searchRequestIdRef.current;
    ++entryRequestIdRef.current;
    setItems([]);
    setNextCursor("");
    setSelectedEntry(null);
    setSelectedEntryId("");
    setEntryLoading(false);
    setEntryError(null);
    setEntryFeedback(null);
    setConfirmForgetOpen(false);
    setSearchError(null);
    change();
  };

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
    ...(selectedCharacter ? { characterId: selectedCharacter } : {}),
    ...(selectedProject ? { projectId: selectedProject } : {}),
    limit: 50,
  }), [query, selectedKind, selectedCharacter, selectedProject]);

  const runSearch = async (options?: SearchOptions) => {
    const requestId = ++searchRequestIdRef.current;
    const entryRequestId = entryRequestIdRef.current;
    const api = getApi();
    if (!api) {
      setSearchError({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE, options });
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
      if (!append && entryRequestId === entryRequestIdRef.current && selectedEntryId && !result.items.some((item) => item.id === selectedEntryId)) {
        ++entryRequestIdRef.current;
        setEntryLoading(false);
        setSelectedEntry(null);
        setSelectedEntryId("");
        setEntryError(null);
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
      setUsageError({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE });
      setUsageLoading(false);
      return;
    }
    try {
      const nextFileUsage = await api.getMemoryV6FileUsage();
      if (requestId === usageRequestIdRef.current) {
        setFileUsage(nextFileUsage);
        setUsageError(null);
      }
    } catch (error) {
      if (requestId === usageRequestIdRef.current) {
        setUsageError({ message: error instanceof Error ? error.message : "Could not load Memory file usage." });
      }
    } finally {
      if (requestId === usageRequestIdRef.current) {
        setUsageLoading(false);
      }
    }
  };

  const loadTargets = async () => {
    const requestId = ++targetsRequestIdRef.current;
    setTargetsLoading(true);
    const api = getApi();
    if (!api) {
      setTargetsError({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE });
      setTargetsLoading(false);
      return;
    }
    try {
      const result = await api.listMemoryV6ReviewTargets();
      if (requestId === targetsRequestIdRef.current) {
        setTargets(result);
        setTargetsError(null);
      }
    } catch (error) {
      if (requestId === targetsRequestIdRef.current) {
        setTargetsError({ message: error instanceof Error ? error.message : "Could not load Memory targets." });
      }
    } finally {
      if (requestId === targetsRequestIdRef.current) setTargetsLoading(false);
    }
  };

  const refreshReview = async () => {
    const requestId = ++refreshRequestIdRef.current;
    setRefreshing(true);
    try {
      await Promise.all([runSearch(), loadFileUsage(), loadTargets()]);
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
    void loadTargets();
    document.title = "Memory Review";
  }, []);

  const selectEntry = async (entryId: string) => {
    const requestId = ++entryRequestIdRef.current;
    setSelectedEntryId(entryId);
    if (entryId !== selectedEntryId) {
      setSelectedEntry(null);
      setEntryError(null);
      setEntryFeedback(null);
    }
    setConfirmForgetOpen(false);
    setEntryLoading(true);
    const api = getApi();
    if (!api) {
      setEntryLoading(false);
      setEntryError({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE });
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
        const notice = "Memory entry was not found or is no longer active.";
        setEntryError({ message: notice, notice });
        return;
      }
      setSelectedEntry(entry);
      setEntryError(null);
    } catch (error) {
      if (requestId !== entryRequestIdRef.current) {
        return;
      }
      setEntryLoading(false);
      setEntryError({ message: error instanceof Error ? error.message : "Could not load the Memory entry." });
    }
  };

  const forgetSelectedEntry = async () => {
    if (!selectedEntryId || !selectedEntry || selectedEntry.id !== selectedEntryId || forgetting) {
      return;
    }
    const api = getApi();
    if (!api) {
      setEntryFeedback({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE, error: true, label: "Memory Forget Error" });
      return;
    }
    setForgetting(true);
    setEntryFeedback(null);
    try {
      const result = await api.forgetMemoryV6Entry(selectedEntryId, forgetReason);
      ++entryRequestIdRef.current;
      setEntryLoading(false);
      setEntryError(null);
      setEntryFeedback({ message: result.status === "forgotten" ? "Memory forgotten." : result.status === "already_forgotten" ? "Memory was already forgotten." : "Memory was not found or is no longer active." });
      setSelectedEntry(null);
      setSelectedEntryId("");
      setConfirmForgetOpen(false);
      await refreshReview();
    } catch (error) {
      setEntryFeedback({ message: error instanceof Error ? error.message : "Could not forget the Memory entry.", notice: "Forget Failed", error: true, label: "Memory Forget Error" });
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
      setEntryFeedback({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE, error: true, label: "Memory File Export Error" });
      return;
    }
    setExporting(true);
    setEntryFeedback(null);
    const entryRequestId = entryRequestIdRef.current;
    try {
      const result = await api.exportMemoryV6EntryFiles(selectedEntryId);
      if (result && entryRequestId === entryRequestIdRef.current) setEntryFeedback({ message: `${result.exportedCount} files exported.` });
    } catch (error) {
      if (entryRequestId === entryRequestIdRef.current) setEntryFeedback({ message: error instanceof Error ? error.message : "Could not export Memory files.", notice: "File Export Failed", error: true, label: "Memory File Export Error" });
    } finally {
      setExporting(false);
    }
  };

  const runProtectedObjectGc = async (dryRun: boolean) => {
    if (runningGc) {
      return;
    }
    if (!dryRun && !window.confirm("Permanently delete files no longer referenced by active memories and temporary files left by unfinished saves?")) {
      return;
    }
    const api = getApi();
    if (!api) {
      setGcFeedback({ message: DESKTOP_RUNTIME_NOTICE, notice: DESKTOP_RUNTIME_NOTICE });
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
    } catch (error) {
      setGcFeedback({ message: error instanceof Error ? error.message : "Could not clean up Memory files.", notice: "File Cleanup Failed" });
    } finally {
      setRunningGc(null);
    }
  };

  const cleanupEligible = gcReport ? gcReport.deletePending.candidates + gcReport.orphanFiles.candidates + gcReport.stagingFiles.candidates : 0;
  const cleanupRemoved = gcReport ? gcReport.deletePending.deleted + gcReport.orphanFiles.deleted + gcReport.stagingFiles.deleted : 0;
  const cleanupFailed = gcReport ? gcReport.deletePending.failed + gcReport.orphanFiles.failed + gcReport.stagingFiles.failed : 0;

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
              disabled={refreshing || loading || loadingMore || forgetting}
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
                disabled={forgetting}
                onChange={(event) => changeFilters(() => setQuery(event.target.value))}
              />
            </label>
            <label className="settings-provider-input">
              <span>Kind</span>
              <select disabled={forgetting} value={selectedKind} onChange={(event) => changeFilters(() => setSelectedKind(event.target.value as MemoryEntryKind | ""))}>
                <option value="">All Kinds</option>
                {MEMORY_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{MEMORY_KIND_LABELS[kind]}</option>)}
              </select>
            </label>
            <label className="settings-provider-input">
              <span>Character</span>
              <select disabled={forgetting || !targets} value={selectedCharacter} onChange={(event) => changeFilters(() => setSelectedCharacter(event.target.value))}>
                <option value="">All Characters</option>
                {targets?.characters.map((character) => <option key={character.id} value={character.id}>{targetName(character, "Character")}</option>)}
              </select>
            </label>
            <label className="settings-provider-input">
              <span>Project</span>
              <select disabled={forgetting || !targets} value={selectedProject} onChange={(event) => changeFilters(() => setSelectedProject(event.target.value))}>
                <option value="">All Projects</option>
                {targets?.projects.map((project) => <option key={project.id} value={project.id}>{targetName(project, "Project")}</option>)}
              </select>
            </label>
            <div className="memory-review-target-status" aria-busy={targetsLoading}>
              {targetsError ? <MemoryReviewError label="Memory Targets Error" {...targetsError}>
                <button type="button" className="launch-toggle" aria-label="Retry Memory targets" disabled={targetsLoading} onClick={() => void loadTargets()}>
                  <ButtonContent busy={targetsLoading} busyLabel="Loading Memory targets.">Retry</ButtonContent>
                </button>
              </MemoryReviewError> : targetsLoading ? <LoadingIndicator inline label="Loading Memory targets" /> : null}
            </div>
          </div>

          <div className="memory-review-grid">
            <section className="memory-review-list" aria-label="Memory entries" aria-busy={loading || loadingMore || undefined}>
              {searchError ? (
                <MemoryReviewError label="Memory Search Error" {...searchError}>
                  <button type="button" className="launch-toggle" aria-label="Retry Memory search" aria-busy={loading || loadingMore} disabled={loading || loadingMore} onClick={() => void runSearch(searchError.options)}>
                    <ButtonContent busy={loading || loadingMore} busyLabel="Loading Memory entries.">Retry</ButtonContent>
                  </button>
                </MemoryReviewError>
              ) : loading ? (
                <LoadingIndicator inline className="settings-loading-inline" label="Loading Memory entries" />
              ) : null}
              {items.map((item) => (
                <button
                  key={item.id}
                  className={`memory-review-item ${selectedEntryId === item.id ? "active" : ""}`.trim()}
                  type="button"
                  aria-pressed={selectedEntryId === item.id}
                  disabled={forgetting}
                  onClick={() => void selectEntry(item.id)}
                >
                  <span className="memory-review-item-title">{item.title || "(untitled)"}</span>
                  <MemoryTarget target={item.target} />
                  <span className="memory-review-item-preview">{item.preview}</span>
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
                  <MemoryReviewError label="Memory Entry Error" {...entryError}>
                    <button type="button" className="launch-toggle" aria-label="Retry Memory entry" aria-busy={entryLoading} disabled={entryLoading} onClick={() => void selectEntry(selectedEntryId)}>
                      <ButtonContent busy={entryLoading} busyLabel="Loading Memory entry.">Retry</ButtonContent>
                    </button>
                  </MemoryReviewError>
                ) : entryLoading ? <LoadingIndicator inline className="settings-loading-inline" label="Loading Memory entry" /> : null}
                {selectedEntry && selectedEntry.id === selectedEntryId ? (
                  <>
                    <div className="memory-review-detail-head">
                      <div>
                        <h2>{selectedEntry.title || "(untitled)"}</h2>
                        <MemoryTarget target={selectedEntry.target} />
                      </div>
                    </div>
                    <div className="memory-review-detail-meta">
                      <span>{MEMORY_KIND_LABELS[selectedEntry.kind]}</span>
                      <time dateTime={selectedEntry.updatedAt}>Updated {formatTimestampLabel(selectedEntry.updatedAt)}</time>
                    </div>
                    <div className="memory-review-body">
                      <pre>{selectedEntry.body}</pre>
                    </div>
                    {selectedEntry.tags.length > 0 ? <p className="memory-review-tags"><span>Tags</span> {formatTags(selectedEntry)}</p> : null}
                    {selectedEntry.files && selectedEntry.files.length > 0 ? (
                      <section className="memory-review-files" aria-label="Protected files">
                        <div className="memory-review-files-head">
                          <h3>Attachments</h3>
                          <button
                            ref={exportFilesButtonRef}
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
                                <strong>{file.displayName || `${file.mediaKind.charAt(0).toUpperCase()}${file.mediaKind.slice(1)} File`}</strong>
                                <span>{formatBytes(file.originalBytes)}</span>
                              </div>
                              <p>{file.summary}</p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </>
                ) : null}
              </div>
              {entryFeedback && !confirmForgetOpen ? entryFeedback.error
                ? <MemoryReviewError {...entryFeedback} recoveryRef={entryFeedback.label === "Memory Forget Error" ? forgetButtonRef : exportFilesButtonRef} />
                : <p className="settings-feedback memory-review-feedback" role="status">{entryFeedback.message}</p>
                : null}
              {selectedEntry && selectedEntry.id === selectedEntryId ? (
                <div className="memory-review-forget-row">
                  <button
                    ref={forgetButtonRef}
                    className="launch-toggle danger-button"
                    type="button"
                    onClick={() => { setForgetReason("user_request"); setConfirmForgetOpen(true); }}
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

          <section className="memory-review-usage" aria-label="Memory file usage" aria-busy={usageLoading} tabIndex={0}>
            {usageError ? (
              <MemoryReviewError label="Memory File Usage Error" {...usageError}>
                <button type="button" className="launch-toggle" aria-label="Retry Memory file usage" aria-busy={usageLoading} disabled={usageLoading} onClick={() => void loadFileUsage()}>
                  <ButtonContent busy={usageLoading} busyLabel="Loading Memory file usage.">Retry</ButtonContent>
                </button>
              </MemoryReviewError>
            ) : usageLoading ? <LoadingIndicator inline label="Loading Memory file usage" /> : null}
            <details className="memory-review-storage-details">
              <summary>
                <span>File Storage</span>
                {fileUsage ? <span className="memory-review-storage-total">{formatBytes(fileUsage.usedBytes)} of {formatBytes(fileUsage.quotaBytes)}</span> : null}
              </summary>
              {fileUsage ? <div className="memory-review-maintenance">
                <p className="memory-review-pending">Pending Deletion <strong>{formatBytes(fileUsage.pendingDeleteBytes)}</strong> · {fileUsage.pendingDeleteCount} items</p>
                {fileUsage.largestEntries && fileUsage.largestEntries.length > 0 ? (
                  <div className="memory-review-largest-entries">
                    <span>Largest Attachments — All Memories</span>
                    <div>
                      {fileUsage.largestEntries.map((entry) => (
                        <button key={entry.entryId} type="button" disabled={forgetting} onClick={() => void selectEntry(entry.entryId)}>
                          <strong>{entry.title || "(untitled)"}</strong>
                          <small>{formatBytes(entry.totalFileBytes)} · {entry.fileCount} {entry.fileCount === 1 ? "file" : "files"}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div ref={gcActionsRef} className="memory-review-gc-actions">
                  <button
                    type="button"
                    onClick={() => void runProtectedObjectGc(true)}
                    disabled={runningGc !== null || refreshing || forgetting}
                    aria-busy={runningGc === "dry-run"}
                    aria-label={runningGc === "dry-run" ? "Previewing Memory file cleanup" : "Preview Memory file cleanup"}
                  >
                    <ButtonContent busy={runningGc === "dry-run"} busyLabel="Previewing Memory file cleanup.">
                      Preview Cleanup
                    </ButtonContent>
                  </button>
                  <button
                    type="button"
                    onClick={() => void runProtectedObjectGc(false)}
                    disabled={runningGc !== null || refreshing || forgetting}
                    aria-busy={runningGc === "cleanup"}
                    aria-label={runningGc === "cleanup" ? "Cleaning up Memory files" : "Clean up Memory files"}
                  >
                    <ButtonContent busy={runningGc === "cleanup"} busyLabel="Cleaning up Memory files.">
                      Clean Up Files
                    </ButtonContent>
                  </button>
                </div>
              </div> : null}
            </details>
            {gcFeedback ? <MemoryReviewError label="Memory File GC Error" {...gcFeedback} recoveryRef={gcActionsRef} /> : null}
            {gcReport ? (
              <div className="memory-review-gc-report" aria-label="Memory file cleanup report">
                <p role="status">{gcReport.dryRun ? `Cleanup Preview: ${cleanupEligible} items eligible for removal.` : `Cleanup: ${cleanupRemoved} items removed.`}
                  {!gcReport.dryRun && gcReport.deletePending.missing ? ` ${gcReport.deletePending.missing} items were already missing.` : ""}
                </p>
                {cleanupFailed > 0 || gcReport.warnings.length > 0 ? <MemoryReviewError label="Memory File Cleanup Warning" message={gcReport.warnings.join("\n") || "Some items could not be removed. Try the cleanup again."} notice={cleanupFailed > 0 ? `${cleanupFailed} items could not be removed.` : "File cleanup needs attention."} /> : null}
                {gcReport.missingActiveObjects > 0 ? <p className="memory-review-file-warning" role="alert">{gcReport.missingActiveObjects} files attached to active memories are missing.</p> : null}
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
              <strong>{selectedEntry.title || "(untitled)"}</strong>
              <MemoryTarget target={selectedEntry.target} />
              <label className="settings-provider-input">
                <span>Forget Reason</span>
                <select value={forgetReason} disabled={forgetting} onChange={(event) => setForgetReason(event.target.value as MemoryForgetReason)}>
                  {FORGET_REASON_OPTIONS.map((reason) => <option key={reason} value={reason}>{FORGET_REASON_LABELS[reason]}</option>)}
                </select>
              </label>
              {forgetReason === "privacy" ? (
                <span>For privacy requests, the title, body, preview, and tags are also deleted.</span>
              ) : null}
              {entryFeedback ? entryFeedback.error
                ? <MemoryReviewError {...entryFeedback} recoveryRef={confirmForgetActionsRef} />
                : <p role="status">{entryFeedback.message}</p>
                : null}
            </div>
            <footer ref={confirmForgetActionsRef}>
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
