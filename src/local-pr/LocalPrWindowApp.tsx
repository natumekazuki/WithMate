import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type ReactNode } from "react";
import { ChatDockSplitter } from "../chat/chat-window.js";
import { ComposerIcon } from "../chat/composer/composer-icon.js";
import { commentThreads, isSameSession, unifiedReviewRows } from "./local-pr-review.js";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  LocalPrComment,
  LocalPrData,
  LocalPrDetail,
  LocalPrInput,
  LocalPrOperation,
  LocalPrWindowApi,
} from "../../src-shared/local-pr/local-pr-contract.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { ErrorDetailsButton } from "../ui/error-details.js";
import { LocalPrDescription, LocalPrDescriptionEditor } from "./LocalPrDescription.js";
import "./local-pr.css";

type Mode = "full" | "previous";
type Tab = "overview" | "changes" | "checks";
type Failure = { message: string; effect: "none" | "unknown" };
type OpenReview = { commentIds: string[]; version: number };

const prStateLabels: Record<LocalPrDetail["state"], string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};
const fileKindLabels: Record<
  LocalPrData<"pr_diff">["files"][number]["kind"],
  string
> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type-Changed",
};
const ciDefinitionLabels: Record<
  LocalPrData<"pr_ci_validate">["state"],
  string
> = {
  not_configured: "Not Configured",
  invalid: "Invalid",
  valid: "Valid",
};
const ciRunLabels: Record<
  LocalPrData<"pr_ci_list">["runs"][number]["state"],
  string
> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  canceled: "Canceled",
  interrupted: "Interrupted",
};
const comparisonLabels: Record<Mode, string> = {
  full: "Full",
  previous: "Previous",
};
const sideLabels = { before: "Before", after: "After" } as const;
const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Formats saved timestamps for display without altering their underlying values. */
function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function branchName(ref: string | null): string {
  return ref?.replace(/^refs\/heads\//, "") ?? "Detached Head";
}

/** Reads retain the last successful value on refresh errors, but never across a changed key. */
function useRead<T>(
  key: string,
  load: () => Promise<{ ok: true; data: T } | ({ ok: false } & Failure)>,
  revision: number,
) {
  const [state, setState] = useState<{
    key: string;
    revision: number;
    data: T | null;
    error: Failure | null;
    loading: boolean;
  }>({ key, revision, data: null, error: null, loading: true });
  useEffect(() => {
    let active = true;
    setState((old) => ({
      key,
      revision,
      data: old.key === key ? old.data : null,
      error: null,
      loading: true,
    }));
    void load()
      .then((result) => {
        if (!active) return;
        setState((old) =>
          result.ok
            ? { key, revision, data: result.data, error: null, loading: false }
            : {
                key,
                revision,
                data: old.key === key ? old.data : null,
                error: result,
                loading: false,
              },
        );
      })
      .catch((error: unknown) => {
        if (active)
          setState((old) => ({
            key,
            revision,
            data: old.key === key ? old.data : null,
            error: { message: String(error), effect: "unknown" },
            loading: false,
          }));
      });
    return () => {
      active = false;
    };
  }, [key, load, revision]);
  return state.key === key
    ? { ...state, loading: state.loading || state.revision !== revision }
    : { key, revision, data: null, error: null, loading: true };
}

/** Displays a read failure independently of previously loaded content. */
function ReadState({
  state,
  retry,
  loadingLabel = "Loading Pull Request Data",
}: {
  state: { data?: unknown; loading: boolean; error: Failure | null };
  retry: () => void;
  loadingLabel?: string;
}) {
  return (
    <>
      {state.loading && state.data == null && (
        <LoadingIndicator inline label={loadingLabel} />
      )}
      {state.error && (
        <div className="local-pr-read-error" role="alert">
          <ErrorDetailsButton message={state.error.message} label="Read Error Details" />
          <button onClick={retry}>Retry</button>
        </div>
      )}
    </>
  );
}

/** Keeps the action label's dimensions and identifies the button that started the mutation. */
function ActionButton({
  children, disabled, onAction, ...props
}: Omit<ComponentPropsWithRef<"button">, "onClick" | "aria-busy"> & {
  onAction: () => Promise<unknown> | undefined;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button {...props} type="button" disabled={disabled || pending} aria-busy={pending}
      onClick={() => {
        const result = onAction();
        if (result) {
          setPending(true);
          void result.finally(() => setPending(false));
        }
      }}
    >
      <ButtonContent busy={pending}>{children}</ButtonContent>
    </button>
  );
}

/** Dedicated PR workspace; the owning window supplies its repository-bound API. */
export default function LocalPrWindowApp({ api }: { api: LocalPrWindowApi }) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [anchorComment, setAnchorComment] = useState<LocalPrComment | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [listExpanded, setListExpanded] = useState(true);
  const [listWidth, setListWidth] = useState(272);
  const listDragStart = useRef(272);
  const workspace = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<OpenReview | null>(null);
  const [delivery, setDelivery] = useState<{ prId: string; title: string } | null>(null);
  const [uncertainDiscussions, setUncertainDiscussions] = useState<
    Record<string, LocalPrInput<"discuss">>
  >({});
  const listLoad = useCallback(async () => {
    const entries: LocalPrData<"pr_list">["entries"] = [];
    let offset = 0;
    for (;;) {
      const page = await api.execute("pr_list", { offset, limit: 100 });
      if (!page.ok) return page;
      entries.push(...page.data.entries);
      if (!page.data.hasMore)
        return { ok: true as const, data: { entries, hasMore: false } };
      if (page.data.entries.length === 0)
        throw new Error("PR list did not advance.");
      offset += page.data.entries.length;
    }
  }, [api]);
  const list = useRead("list", listLoad, revision);
  const detailLoad = useCallback(
    () =>
      selected
        ? api.execute("pr_get", { prId: selected })
        : Promise.resolve({ ok: true as const, data: null }),
    [api, selected],
  );
  const detail = useRead(selected ?? "none", detailLoad, revision);
  const pr = detail.data;
  const pendingReview = pr ? uncertainDiscussions[pr.id] : undefined;
  const agentNamesLoad = useCallback(() => selected
    ? api.execute("session_choices", {})
    : Promise.resolve({ ok: true as const, data: { sessions: [], hasMore: false } }), [api, selected]);
  const agentNames = useRead(selected ?? "none", agentNamesLoad, revision);
  const nameAgent = (target: SessionTarget) =>
    agentNames.data?.sessions.find((item) => isSameSession(item.target, target))?.title ?? "Agent";
  const currentVersion =
    pr?.versions.find((item) => item.version === version) ??
    pr?.versions.find((item) => item.version === pr.latestVersion) ??
    null;
  useEffect(() => api.subscribeChanged(refresh), [api, refresh]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  /** Mutations always re-read the authoritative state, including unknown outcomes. */
  const run = useCallback(
    async <T extends LocalPrOperation>(
      operation: T,
      input: LocalPrInput<T>,
    ): Promise<LocalPrData<T> | null> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await api.execute(operation, input);
        if (!result.ok) {
          setFailure(result);
          return null;
        }
        return result.data;
      } catch (error) {
        setFailure({ message: String(error), effect: "unknown" });
        return null;
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [api, refresh],
  );
  const discuss = useCallback(
    async (input: LocalPrInput<"discuss">) => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await api.execute("discuss", input);
        if (!result.ok) {
          setFailure(result);
          if (result.effect === "unknown")
            setUncertainDiscussions((items) => ({
              ...items,
              [input.prId]: input,
            }));
          else
            setUncertainDiscussions((items) => {
              const next = { ...items };
              delete next[input.prId];
              return next;
            });
          return false;
        }
        setUncertainDiscussions((items) => {
          const next = { ...items };
          delete next[input.prId];
          return next;
        });
        return true;
      } catch (error) {
        setFailure({ message: String(error), effect: "unknown" });
        setUncertainDiscussions((items) => ({ ...items, [input.prId]: input }));
        return false;
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [api, refresh],
  );

  /** Opening a PR selects its latest version without changing the list's visibility. */
  function selectPr(id: string) {
    setCreating(false);
    setSelected(id);
    setVersion(null);
    setAnchorComment(null);
    setReview(null);
    setTab("overview");
  }

  function startReview(commentIds: string[], reviewVersion: number) {
    setFailure(null);
    setReview({ commentIds: pendingReview?.commentIds ?? commentIds, version: pendingReview?.version ?? reviewVersion });
  }

  return (
    <div ref={workspace} className={`page-shell session-page local-pr-app${listExpanded ? "" : " is-list-collapsed"}`}
      style={{ "--local-pr-list-width": `${listWidth}px` } as CSSProperties}>
      <aside id="local-pr-list" className="local-pr-list" aria-label="Pull Requests" hidden={!listExpanded}>
        <header className="local-pr-list-toolbar">
          <h1>Pull Requests</h1>
          <div className="session-file-preview-actions">
            <button className="local-pr-primary"
              onClick={() => {
                setCreating(true);
                setSelected(null);
                setReview(null);
                setTab("overview");
              }}
            >
              New PR
            </button>
            <button aria-label="Reload Pull Requests" title="Reload Pull Requests"
            aria-busy={list.loading || detail.loading}
            disabled={list.loading || detail.loading}
            onClick={refresh}
          >
            <ButtonContent
              busy={list.loading || detail.loading}
              busyLabel="Refreshing Pull Requests"
            >
              ↻
            </ButtonContent>
            </button>
          </div>
        </header>
        <div className="local-pr-list-items">
          {list.data?.entries.map((item) => (
            <button
              className="local-pr-list-item"
              aria-current={selected === item.id ? "true" : undefined}
              key={item.id}
              onClick={() => selectPr(item.id)}
            >
              <strong>{item.title}</strong>
              <span>
                {prStateLabels[item.state]} · v{item.latestVersion}
              </span>
            </button>
          ))}
        </div>
        <div className="local-pr-list-feedback">
          <ReadState state={list} retry={refresh} />
        </div>
      </aside>
      <ChatDockSplitter edge="left" className="local-pr-list-splitter"
        isPanelExpanded={listExpanded} ariaControls="local-pr-list"
        ariaLabel={listExpanded ? "Collapse Pull Request List" : "Expand Pull Request List"}
        title={listExpanded ? "Collapse Pull Request List" : "Expand Pull Request List"}
        onTogglePanel={() => setListExpanded((expanded) => !expanded)}
        onPointerDown={() => { listDragStart.current = listWidth; }}
        onDrag={(_event, delta) => {
          if (listExpanded) setListWidth(Math.max(160, Math.min(listDragStart.current + delta.x, (workspace.current?.clientWidth ?? 512) - 240)));
        }}
        onKeyDown={(event) => {
          if (!listExpanded || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
          event.preventDefault();
          setListWidth((width) => Math.max(160, Math.min(width + (event.key === "ArrowRight" ? 16 : -16), (workspace.current?.clientWidth ?? 512) - 240)));
        }}
      />
      <main className="local-pr-main">
        {creating ? (
          <CreatePr
            api={api}
            run={run}
            busy={busy}
            onCreated={(id) => {
              setCreating(false);
              setSelected(id);
              setVersion(null);
              setAnchorComment(null);
              setTab("overview");
            }}
          />
        ) : selected ? (
          <>
            {pr && currentVersion && (
              <>
                <header className="local-pr-header">
                  <div className="local-pr-heading">
                    <h2>{pr.title}</h2>
                    <p className="local-pr-pr-meta">
                      <span className="local-pr-status" data-state={pr.state}>{prStateLabels[pr.state]}</span>
                      <span title={`${pr.sourceBranch ?? "Detached Head"} → ${pr.targetBranch}`}>
                        <code>{branchName(pr.sourceBranch)} → {branchName(pr.targetBranch)}</code>
                      </span>
                    </p>
                  </div>
                  <label>
                    Version{" "}
                    <select
                      value={currentVersion.version}
                      onChange={(event) => {
                        setAnchorComment(null);
                        setVersion(Number(event.target.value));
                      }}
                    >
                      {pr.versions.map((item) => (
                        <option key={item.version} value={item.version}>
                          v{item.version}
                          {item.version === pr.latestVersion ? " (Latest)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </header>
                <nav className="local-pr-tabs session-file-preview-segmented" aria-label="PR Sections">
                  {(["overview", "changes", "checks"] as const).map((name) => (
                    <button
                      key={name}
                      className={tab === name ? "is-active" : undefined}
                      aria-current={tab === name ? "page" : undefined}
                      onClick={() => {
                        if (name !== tab) setAnchorComment(null);
                        setTab(name);
                      }}
                    >
                      {name[0].toUpperCase() + name.slice(1)}
                    </button>
                  ))}
                </nav>
                {delivery?.prId === pr.id && (
                  <div className="local-pr-delivery" role="status">
                    <span>Review queued for {delivery.title}.</span>
                    <button onClick={() => setDelivery(null)}>Dismiss</button>
                  </div>
                )}
                {pendingReview && !review && (
                  <div className="local-pr-delivery" role="status">
                    <span>Review delivery not confirmed.</span>
                    <button disabled={busy} onClick={() => startReview(pendingReview.commentIds, pendingReview.version)}>Review Pending Send</button>
                  </div>
                )}
                {review && (
                  <SendReview
                    key={`review:${pr.id}:${review.version}`}
                    api={api}
                    pr={pr}
                    selection={review}
                    pending={pendingReview}
                    failure={failure}
                    busy={busy || detail.loading || !!detail.error}
                    nameAgent={nameAgent}
                    send={discuss}
                    onCancel={() => setReview(null)}
                    onSent={(title) => {
                      setReview(null);
                      setDelivery({ prId: pr.id, title });
                    }}
                  />
                )}
                {tab === "overview" && (
                  <Overview
                    key={`overview:${pr.id}`}
                    api={api}
                    pr={pr}
                    version={currentVersion.version}
                    revision={revision}
                    run={run}
                    busy={busy || detail.loading || !!detail.error}
                    openReview={startReview}
                    nameAgent={nameAgent}
                    onSubmitted={() => setVersion(null)}
                    openAnchor={(comment) => {
                      setAnchorComment(comment);
                      setVersion(comment.version);
                      setTab("changes");
                    }}
                  />
                )}
                {tab === "changes" && (
                  <Changes
                    key={`changes:${pr.id}:${currentVersion.version}`}
                    api={api}
                    pr={pr}
                    version={currentVersion.version}
                    revision={revision}
                    refresh={refresh}
                    run={run}
                    busy={busy || detail.loading || !!detail.error}
                    openReview={(commentIds) => startReview(commentIds, currentVersion.version)}
                    nameAgent={nameAgent}
                    initialComment={
                      anchorComment?.version === currentVersion.version
                        ? anchorComment
                        : null
                    }
                  />
                )}
                {tab === "checks" && (
                  <Checks
                    key={`checks:${pr.id}:${currentVersion.version}`}
                    api={api}
                    prId={pr.id}
                    version={currentVersion.version}
                    revision={revision}
                    refresh={refresh}
                    run={run}
                    busy={busy}
                  />
                )}
              </>
            )}
          </>
        ) : list.data && (
          <div className="local-pr-scroll local-pr-empty" />
        )}
        <div className="local-pr-main-feedback">
          {failure && !review && (
            <div className="app-notification error local-pr-error" role="alert">
              {failure.message}
              {failure.effect === "unknown" &&
                " The result is unknown; refresh before retrying."}{" "}
              <button onClick={() => setFailure(null)}>Dismiss</button>
            </div>
          )}
          {!creating && selected && (
            <ReadState state={detail} retry={refresh} />
          )}
        </div>
      </main>
    </div>
  );
}

/** Presents a fixed comparison and creates versioned, side-specific draft anchors. */
function Changes({
  api,
  pr,
  version,
  revision,
  refresh,
  run,
  busy,
  initialComment,
  openReview,
  nameAgent,
}: {
  api: LocalPrWindowApi;
  pr: LocalPrDetail;
  version: number;
  revision: number;
  refresh: () => void;
  run: Run;
  busy: boolean;
  initialComment: LocalPrComment | null;
  openReview: (ids: string[]) => void;
  nameAgent: (target: SessionTarget) => string;
}) {
  const [mode, setMode] = useState<Mode>(
    initialComment?.anchor?.mode ?? "full",
  );
  const [selectedPath, setPath] = useState(initialComment?.anchor?.path ?? "");
  const [draftAnchor, setDraftAnchor] = useState<NonNullable<LocalPrComment["anchor"]> | null>(null);
  const [rangeOrigin, setRangeOrigin] = useState<number | null>(null);
  const [rangeError, setRangeError] = useState(false);
  const [body, setBody] = useState("");
  const filesLoad = useCallback(
    () => api.execute("pr_diff", { prId: pr.id, version, mode }),
    [api, pr.id, version, mode],
  );
  const files = useRead(`${pr.id}:${version}:${mode}`, filesLoad, revision);
  const path = selectedPath || files.data?.files[0]?.path || "";
  const selectedFile = files.data?.files.find((file) => file.path === path);
  const patchLoad = useCallback(
    () =>
      path
        ? api.execute("pr_diff", { prId: pr.id, version, mode, path })
        : Promise.resolve({ ok: true as const, data: null }),
    [api, pr.id, version, mode, path],
  );
  const patch = useRead(
    `${pr.id}:${version}:${mode}:${path}`,
    patchLoad,
    revision,
  );
  const rows = useMemo(
    () => (patch.data?.patch ? unifiedReviewRows(patch.data.patch) : []),
    [patch.data],
  );
  const lineNumbers = useMemo(() => {
    const before = new Set<number>();
    const after = new Set<number>();
    for (const row of rows) {
      if ("text" in row) continue;
      if (row.leftNumber != null) before.add(row.leftNumber);
      if (row.rightNumber != null) after.add(row.rightNumber);
    }
    return { before, after };
  }, [rows]);
  const codeRef = useRef<HTMLDivElement>(null);
  const anchorMoved = useRef(false);
  const virtualRows = useVirtualizer({
    count: rows.length,
    getScrollElement: () => codeRef.current,
    estimateSize: () => 19,
    overscan: 20,
  });
  useEffect(() => {
    if (
      anchorMoved.current ||
      !patch.data ||
      !initialComment?.anchor ||
      initialComment.anchor.path !== path ||
      initialComment.anchor.mode !== mode
    )
      return;
    const anchor = initialComment.anchor;
    if (anchor.startLine !== null) {
      const index = rows.findIndex(
        (row) =>
          !("text" in row) &&
          (anchor.side === "before" ? row.leftNumber : row.rightNumber) ===
            anchor.startLine,
      );
      if (index >= 0) virtualRows.scrollToIndex(index, { align: "center" });
    }
    codeRef.current?.focus();
    anchorMoved.current = true;
  }, [rows, initialComment, mode, path, patch.data, virtualRows]);
  const fileComments = pr.comments.filter((comment) => comment.version === version
    && comment.anchor?.path === path && comment.anchor.mode === mode);
  const drafts = pr.comments.filter((comment) => comment.version === version && comment.draft);
  const authorComments = new Map<string, number>();
  for (const comment of fileComments) {
    const anchor = comment.anchor;
    if (!anchor || anchor.startLine === null) continue;
    const key = `${anchor.side}:${anchor.startLine}`;
    authorComments.set(key, (authorComments.get(key) ?? 0) + 1);
  }

  function selectLine(side: "before" | "after", line: number, extend: boolean) {
    const first = extend && draftAnchor?.path === path && draftAnchor.mode === mode && draftAnchor.side === side
      ? rangeOrigin ?? line : line;
    const startLine = Math.min(first, line);
    const endLine = Math.max(first, line);
    for (let number = startLine; number <= endLine; number += 1) {
      if (!lineNumbers[side].has(number)) {
        setRangeError(true);
        return;
      }
    }
    setRangeError(false);
    setRangeOrigin(first);
    setDraftAnchor({ mode, path, side, startLine, endLine });
  }
  return (
    <div className="local-pr-changes local-pr-reader">
      <header className="local-pr-reader-toolbar">
        <div className="session-file-preview-segmented" role="group" aria-label="Diff Comparison">
          <button
            className={mode === "full" ? "is-active" : undefined}
            aria-pressed={mode === "full"}
            onClick={() => {
              setMode("full");
              setPath("");
            }}
          >
            Full Diff
          </button>
          <button
            className={mode === "previous" ? "is-active" : undefined}
            disabled={version === 1}
            aria-pressed={mode === "previous"}
            onClick={() => {
              setMode("previous");
              setPath("");
            }}
          >
            Since Previous
          </button>
        </div>
        <div className="local-pr-actions local-pr-diff-actions">
          {files.data && <code className="local-pr-revision-range">
              {files.data.beforeCommit.slice(0, 12)} →{" "}
              {files.data.afterCommit.slice(0, 12)}
          </code>}
          <button className={drafts.length ? "local-pr-primary" : undefined} disabled={busy} onClick={() => openReview(drafts.slice(0, 50).map((comment) => comment.id))}>
            {drafts.length ? `Send Review (${drafts.length})` : "Send to Agent"}
          </button>
        </div>
      </header>
      <aside className="local-pr-files" aria-label="Changed Files">
        <ReadState state={files} retry={refresh} />
        {files.data?.files.map((file) => (
          <button
            key={file.path}
            className="local-pr-file"
            aria-current={path === file.path ? "true" : undefined}
            title={file.path}
            onClick={() => setPath(file.path)}
          >
            <span>{file.path}</span>
            <small>
              {fileKindLabels[file.kind]}
              {file.previousPath ? ` · ${file.previousPath}` : ""}
            </small>
          </button>
        ))}
      </aside>
      <section className="local-pr-diff local-pr-reader-content">
        {path ? (
          <>
            <div className="local-pr-file-toolbar">
              <h3>{path}</h3>
              <button disabled={busy || !selectedFile} onClick={() => {
                setRangeError(false);
                setDraftAnchor({ mode, path, side: selectedFile?.kind === "deleted" ? "before" : "after", startLine: null, endLine: null });
              }}>Comment on File</button>
            </div>
            <ReadState state={patch} retry={refresh} />
            <div
              ref={codeRef}
              className="local-pr-code"
              style={{
                height: `min(55vh, ${Math.max(80, virtualRows.getTotalSize())}px)`,
              }}
              tabIndex={0}
              aria-label={`Diff for ${path}`}
            >
              <div
                className="local-pr-code-body"
                style={{ height: virtualRows.getTotalSize() }}
              >
                {virtualRows.getVirtualItems().map((item) => {
                  const row = rows[item.index];
                  if ("text" in row)
                    return (
                      <div
                        key={item.key}
                        data-index={item.index}
                        ref={virtualRows.measureElement}
                        className={`local-pr-code-row local-pr-row-${row.kind}`}
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        <span className="local-pr-code-metadata">
                          {row.text}
                        </span>
                      </div>
                    );
                  const anchor = draftAnchor ?? initialComment?.anchor;
                  const line =
                    anchor?.side === "before"
                      ? row.leftNumber
                      : row.rightNumber;
                  const matched =
                    anchor &&
                    anchor.startLine !== null &&
                    anchor.endLine !== null &&
                    anchor.path === path &&
                    anchor.mode === mode &&
                    line !== undefined &&
                    line >= anchor.startLine &&
                    line <= anchor.endLine;
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualRows.measureElement}
                      data-anchor-start={
                        matched && line === anchor?.startLine
                          ? "true"
                          : undefined
                      }
                      className={`local-pr-code-row local-pr-row-${row.kind}${matched ? " local-pr-row-anchor" : ""}`}
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      {(["before", "after"] as const).map((side) => {
                        const number = side === "before" ? row.leftNumber : row.rightNumber;
                        if (number == null) return <span key={side} />;
                        const notes = authorComments.get(`${side}:${number}`) ?? 0;
                        const label = `Comment on ${side} line ${number}`;
                        return <button
                          type="button"
                          className="local-pr-line-number"
                          key={side}
                          aria-label={label}
                          title={`${label} (Shift to extend selection)`}
                          data-has-comment={notes ? "true" : undefined}
                            aria-pressed={draftAnchor?.path === path && draftAnchor.mode === mode
                              && draftAnchor.side === side && matched === true}
                            disabled={busy}
                          onClick={(event) => selectLine(side, number, event.shiftKey)}
                        >{number}</button>;
                      })}
                      <pre>
                        {`${row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "} ${row.rightText ?? row.leftText ?? ""}`}
                      </pre>
                    </div>
                  );
                })}
              </div>
              {patch.data && patch.data.patch === null && (
                <p>Patch unavailable for this file.</p>
              )}
            </div>
            {draftAnchor && <section className="local-pr-draft">
              <h4>New Comment · v{version}</h4>
              <p className="local-pr-anchor-label">{formatAnchor(draftAnchor)}</p>
              {rangeError && <p role="status" className="local-pr-warning">Select a range without gaps in the diff.</p>}
              <label>
                Comment
                <textarea
                  value={body}
                  disabled={busy}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <div className="local-pr-actions">
                <ActionButton className="local-pr-primary"
                  disabled={busy || !body.trim() || rangeError}
                  onAction={() =>
                    run("save_draft", { prId: pr.id, version, body, anchor: draftAnchor }).then((result) => {
                      if (result) {
                        setBody("");
                        setDraftAnchor(null);
                      }
                    })
                  }
                >Save Draft</ActionButton>
                <button disabled={busy} onClick={() => { setDraftAnchor(null); setRangeError(false); setBody(""); }}>Cancel</button>
              </div>
            </section>}
            <Conversation
              pr={pr}
              version={version}
              threads={commentThreads(pr.comments).filter(({ comment }) => fileComments.some((entry) => entry.id === comment.id))}
              run={run}
              busy={busy}
              openReview={(ids) => openReview(ids)}
              nameAgent={nameAgent}
            />
          </>
        ) : files.data ? <p>No changed files.</p> : null}
      </section>
    </div>
  );
}

/** Reads CI definitions, runs and logs for the selected immutable version. */
function Checks({
  api,
  prId,
  version,
  revision,
  refresh,
  run,
  busy,
}: {
  api: LocalPrWindowApi;
  prId: string;
  version: number;
  revision: number;
  refresh: () => void;
  run: Run;
  busy: boolean;
}) {
  const [selectedRunId, setRunId] = useState<string | null>(null);
  const definitionLoad = useCallback(
    () => api.execute("pr_ci_validate", { prId, version }),
    [api, prId, version],
  );
  const runsLoad = useCallback(
    () => api.execute("pr_ci_list", { prId, version }),
    [api, prId, version],
  );
  const definition = useRead(
    `${prId}:${version}:definition`,
    definitionLoad,
    revision,
  );
  const runs = useRead(`${prId}:${version}:runs`, runsLoad, revision);
  const runId = selectedRunId ?? runs.data?.runs[0]?.id;
  const loadLog = useCallback(async () => {
    if (!runId) return { ok: true as const, data: "" };
    let offset = 0;
    let content = "";
    for (;;) {
      const result = await api.execute("pr_ci_log", { prId, version, runId, offset });
      if (!result.ok) return result;
      content += result.data.log;
      if (!result.data.hasMore) return { ok: true as const, data: content };
      if (result.data.nextOffset <= offset) throw new Error("Log cursor did not advance.");
      offset = result.data.nextOffset;
    }
  }, [api, prId, version, runId]);
  const log = useRead(runId ?? "none", loadLog, revision);
  const chosen = runs.data?.runs.find((item) => item.id === runId);
  return (
    <div className="local-pr-checks local-pr-reader">
      <header className="local-pr-reader-toolbar local-pr-checks-toolbar">
        <ReadState state={definition} retry={refresh} />
        {definition.data && (
          <>
            <div className="local-pr-check-definition">
              <strong>Definition: {ciDefinitionLabels[definition.data.state]}</strong>
              <code>{definition.data.headCommit}</code>
              {definition.data.error && <p role="alert">{definition.data.error}</p>}
            </div>
            <details className="local-pr-definition-file">
              <summary>.withmate/ci.yml</summary>
              <pre>{definition.data.source ?? "Not Configured"}</pre>
            </details>
            <ActionButton className="local-pr-primary"
              disabled={busy || definition.data.state !== "valid"}
              onAction={() => run("pr_ci_start", { prId, version })}
            >
              Run Checks
            </ActionButton>
          </>
        )}
      </header>
      <aside className="local-pr-files" aria-label="Check Runs">
        <h4>Runs</h4>
        <ReadState state={runs} retry={refresh} />
        {runs.data?.runs.map((item) => (
          <button
            key={item.id}
            className="local-pr-file"
            aria-current={runId === item.id ? "true" : undefined}
            onClick={() => setRunId(item.id)}
          >
            <strong>{ciRunLabels[item.state]}</strong>
            <small>
              {formatDateTime(item.startedAt)} · v{item.version}
            </small>
          </button>
        ))}
        {runs.data && runs.data.runs.length === 0 && <p>Not Run</p>}
      </aside>
      <section className="local-pr-log local-pr-reader-content">
        {chosen ? (
          <>
            <header className="local-pr-log-heading">
              <h3 className="local-pr-status" data-state={chosen.state}>{ciRunLabels[chosen.state]}</h3>
              <div className="local-pr-actions">
                <ActionButton
                  disabled={busy || chosen.state !== "running"}
                  onAction={() =>
                    run("pr_ci_cancel", { prId, version, runId: chosen.id })
                  }
                >
                  Cancel Run
                </ActionButton>
                <ActionButton
                  disabled={busy || chosen.state === "running"}
                  onAction={() =>
                    run("pr_ci_rerun", { prId, version, runId: chosen.id })
                  }
                >
                  Rerun
                </ActionButton>
              </div>
            </header>
            <dl className="local-pr-commit-list">
              <dt>Head</dt><dd><code>{chosen.headCommit}</code></dd>
              <dt>Target</dt><dd><code>{chosen.targetCommit}</code></dd>
            </dl>
            {chosen.error && <p role="alert">{chosen.error}</p>}
            <ReadState state={log} retry={refresh} loadingLabel="Loading CI Log" />
            <pre tabIndex={0} aria-label="CI Log" aria-busy={log.loading}>
              {log.data}
            </pre>
          </>
        ) : null}
      </section>
    </div>
  );
}

type Run = <T extends LocalPrOperation>(
  operation: T,
  input: LocalPrInput<T>,
) => Promise<LocalPrData<T> | null>;

/** Creates a PR from explicit branch tips without changing the working tree. */
function CreatePr({
  api,
  run,
  busy,
  onCreated,
}: {
  api: LocalPrWindowApi;
  run: Run;
  busy: boolean;
  onCreated: (id: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const branchesLoad = useCallback(() => api.execute("pr_branches", {}), [api]);
  const branches = useRead("branches", branchesLoad, retry);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const sourceRef = branches.data?.branches.find(
    (branch) => branch.ref === source,
  );
  const targetRef = branches.data?.branches.find(
    (branch) => branch.ref === target,
  );
  return (
    <section className="local-pr-form">
      <h2>New Pull Request</h2>
      <ReadState state={branches} retry={() => setRetry((n) => n + 1)} />
      <label>
        Title
        <input
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <LocalPrDescriptionEditor api={api} text={description} onChange={setDescription} disabled={busy} />
      <label>
        Source Branch
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Select Branch</option>
          {branches.data?.branches.map((b) => (
            <option key={b.ref} value={b.ref}>
              {b.ref}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target Branch
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Select Branch</option>
          {branches.data?.branches.map((b) => (
            <option key={b.ref} value={b.ref}>
              {b.ref}
            </option>
          ))}
        </select>
      </label>
      <ActionButton className="local-pr-primary"
        disabled={busy || !title.trim() || !sourceRef || !targetRef}
        onAction={() => sourceRef && targetRef
          ? run("pr_create", {
              title,
              description,
              headCommit: sourceRef.commit,
              sourceBranch: sourceRef.ref,
              targetBranch: targetRef.ref,
              expectedTargetCommit: targetRef.commit,
            }).then((result) => {
              if (result) onCreated(result.id);
            }) : undefined}
      >
        Create PR
      </ActionButton>
    </section>
  );
}

/** The overview keeps comments and actions tied to their recorded versions. */
function Overview({
  api,
  pr,
  version,
  revision,
  run,
  busy,
  openReview,
  openAnchor,
  nameAgent,
  onSubmitted,
}: {
  api: LocalPrWindowApi;
  pr: LocalPrDetail;
  version: number;
  revision: number;
  run: Run;
  busy: boolean;
  openReview: (ids: string[], version: number) => void;
  openAnchor: (comment: LocalPrComment) => void;
  nameAgent: (target: SessionTarget) => string;
  onSubmitted: () => void;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const triggerButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirmClose) confirmationButton.current?.focus();
  }, [confirmClose]);
  const [branchRevision, setBranchRevision] = useState(0);
  const branchesLoad = useCallback(() => api.execute("pr_branches", {}), [api]);
  const branches = useRead(
    "overview-branches",
    branchesLoad,
    branchRevision + revision,
  );
  const latest = pr.versions.find((v) => v.version === pr.latestVersion);
  const selectedVersion = pr.versions.find((v) => v.version === version);
  const source = branches.data?.branches.find((b) => b.ref === pr.sourceBranch);
  const target = branches.data?.branches.find((b) => b.ref === pr.targetBranch);
  const approvalTarget = latest && {
    prId: pr.id,
    version: latest.version,
    headCommit: latest.headCommit,
    targetCommit: latest.targetCommit,
  };
  const isApproved =
    !!approvalTarget &&
    pr.approval?.version === approvalTarget.version &&
    pr.approval.headCommit === approvalTarget.headCommit &&
    pr.approval.targetCommit === approvalTarget.targetCommit;
  const targetChanged =
    pr.state === "open" &&
    !!latest &&
    pr.currentTargetCommit !== null &&
    latest.targetCommit !== pr.currentTargetCommit;
  const sourceChanged = !!source && !!latest && source.commit !== latest.headCommit;
  return (
    <div className="local-pr-scroll">
      <div className="local-pr-overview-grid">
        <div className="local-pr-overview-content">
          <section aria-labelledby="local-pr-description-title">
            <div className="local-pr-section-heading">
              <h3 id="local-pr-description-title">Description</h3>
            </div>
            {pr.description.trim()
              ? <LocalPrDescription api={api} text={pr.description} revision={revision} />
              : null}
          </section>
          <Conversation
            pr={pr}
            version={version}
            threads={commentThreads(pr.comments)}
            run={run}
            busy={busy}
            openReview={openReview}
            openAnchor={openAnchor}
            nameAgent={nameAgent}
            general
          />
        </div>
        <aside className="local-pr-submission" aria-label="Review and Merge">
          <p className="local-pr-submission-status">
            <span className="local-pr-status" data-state={isApproved ? "approved" : undefined}>
              {isApproved ? `Approved v${pr.approval?.version}` : `v${version} · ${version === pr.latestVersion ? "Not Approved" : "Previous Submission"}`}
            </span>
            {targetChanged && <span className="local-pr-warning">Target Branch Has Changed</span>}
          </p>
          {pr.state === "open" && pr.currentTargetCommit === null && <p>Current Target Unavailable</p>}
          {pr.state === "open" && (
            <div className="local-pr-actions local-pr-review-actions">
              <ActionButton className={!isApproved ? "local-pr-primary" : undefined}
                disabled={
                  busy ||
                  !approvalTarget ||
                  version !== pr.latestVersion ||
                  targetChanged ||
                  pr.currentTargetCommit === null
                }
                onAction={() =>
                  approvalTarget ? run("approve", approvalTarget) : undefined
                }
              >
                Approve
              </ActionButton>
              <ActionButton className={isApproved ? "local-pr-primary" : undefined}
                disabled={
                  busy ||
                  !approvalTarget ||
                  !isApproved ||
                  version !== pr.latestVersion ||
                  pr.currentTargetCommit === null ||
                  targetChanged
                }
                onAction={() => approvalTarget ? run("pr_merge", approvalTarget) : undefined}
              >
                Merge
              </ActionButton>
            </div>
          )}
          {pr.state === "open" && (
            <details className="local-pr-more-actions" open={confirmClose || undefined}>
              <summary>More Actions</summary>
              <div className="local-pr-actions">
              <ActionButton
                disabled={busy || !isApproved || !approvalTarget}
                onAction={() =>
                  approvalTarget ? run("revoke", approvalTarget) : undefined
                }
              >
                Revoke Approval
              </ActionButton>
              <button
                disabled={busy}
                onClick={(event) => {
                  triggerButton.current = event.currentTarget;
                  setConfirmClose(true);
                }}
              >
                Close PR
              </button>
              </div>
            </details>
          )}
          {confirmClose && pr.state === "open" && (
            <div
              className="local-pr-confirm"
              role="group"
              aria-label="Confirm Action"
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  setConfirmClose(false);
                  triggerButton.current?.focus();
                }
              }}
            >
              <p>Close {pr.title} without merging?</p>
              <ActionButton
                ref={confirmationButton}
                disabled={busy}
                onAction={() =>
                  run("pr_close", {
                    prId: pr.id,
                    version: pr.latestVersion,
                  }).then((result) => {
                    if (result) {
                      setConfirmClose(false);
                      triggerButton.current?.focus();
                    }
                  })
                }
              >
                Confirm Close
              </ActionButton>{" "}
              <button
                disabled={busy}
                onClick={() => {
                  setConfirmClose(false);
                  triggerButton.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {pr.state === "open" && (sourceChanged || targetChanged) && (
            <div className="local-pr-submit-version">
              <h3>Submit Version</h3>
              {sourceChanged && <p>New commits on the source branch.</p>}
              <div className="local-pr-actions">
                <ActionButton
                  disabled={
                    busy ||
                    branches.loading ||
                    !!branches.error ||
                    !latest ||
                    !target ||
                    !source || !sourceChanged
                  }
                  onAction={() =>
                    latest && target && source
                    ? run("pr_submit", {
                      prId: pr.id,
                      expectedVersion: latest.version,
                      headCommit: source.commit,
                      expectedTargetCommit: target.commit,
                    }).then((saved) => { if (saved) onSubmitted(); }) : undefined
                  }
                >
                  Submit New Version
                </ActionButton>
                {targetChanged && (
                  <ActionButton
                    disabled={
                      busy ||
                      branches.loading ||
                      !!branches.error ||
                      !latest ||
                      !target ||
                      target.commit !== pr.currentTargetCommit
                    }
                    onAction={() =>
                      latest && target
                      ? run("pr_submit", {
                        prId: pr.id,
                        expectedVersion: latest.version,
                        headCommit: latest.headCommit,
                        expectedTargetCommit: target.commit,
                      }).then((saved) => { if (saved) onSubmitted(); }) : undefined
                    }
                  >
                    Re-submit Reviewed Head for New Target
                  </ActionButton>
                )}
              </div>
            </div>
          )}
          {pr.state === "open" && <ReadState state={branches} retry={() => setBranchRevision((n) => n + 1)} />}
          {selectedVersion && (
            <details className="local-pr-version-details">
              <summary>Submission Details</summary>
              <dl className="local-pr-commit-list">
                <dt>Submitted</dt><dd>{formatDateTime(selectedVersion.submittedAt)}</dd>
                <dt>Head</dt><dd><code>{selectedVersion.headCommit}</code></dd>
                <dt>Target</dt><dd><code>{selectedVersion.targetCommit}</code></dd>
                <dt>Merge Base</dt><dd><code>{selectedVersion.mergeBaseCommit}</code></dd>
              </dl>
            </details>
          )}
        </aside>
      </div>
    </div>
  );
}

function formatAnchor(anchor: NonNullable<LocalPrComment["anchor"]>): string {
  const lines = anchor.startLine === null ? "Whole File"
    : anchor.startLine === anchor.endLine ? `Line ${anchor.startLine}`
    : `Lines ${anchor.startLine}–${anchor.endLine}`;
  return anchor.startLine === null ? `${anchor.path} · ${lines}`
    : `${anchor.path} · ${sideLabels[anchor.side]} · ${lines}`;
}

type CommentEditor = { kind: "new" } | { kind: "reply" | "edit"; comment: LocalPrComment };

function Conversation({ pr, version, threads, run, busy, openReview, openAnchor, general = false, nameAgent }: {
  pr: LocalPrDetail;
  version: number;
  threads: ReturnType<typeof commentThreads>;
  run: Run;
  busy: boolean;
  openReview: (ids: string[], version: number) => void;
  openAnchor?: (comment: LocalPrComment) => void;
  general?: boolean;
  nameAgent?: (target: SessionTarget) => string;
}) {
  const [editor, setEditor] = useState<CommentEditor | null>(null);
  const [body, setBody] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const editorComment = editor?.kind === "reply" || editor?.kind === "edit" ? editor.comment : null;
  const editorInThread = !!editorComment && threads.some(({ comment, replies }) =>
    comment.id === editorComment.id || replies.some((reply) => reply.id === editorComment.id));
  useEffect(() => { if (editor) field.current?.focus(); }, [editor, editorInThread]);

  function begin(next: CommentEditor) {
    setBody(next.kind === "edit" ? next.comment.body : "");
    setEditor(next);
  }
  function dismiss() { setEditor(null); setBody(""); }
  function compose(): ReactNode {
    if (!editor) return null;
    const item = editor.kind === "new" ? null : editor.comment;
    const edit = editor.kind === "edit" && item;
    return (
      <div className="local-pr-comment-composer">
        {item?.anchor && !editorInThread && <p className="local-pr-anchor-label">{formatAnchor(item.anchor)}</p>}
        <label>
          {edit ? "Edit Draft" : item ? `Reply · v${item.version}` : `New Comment · v${version}`}
          <textarea ref={field} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} />
        </label>
        <div className="local-pr-actions">
          <ActionButton className="local-pr-primary" disabled={busy || !body.trim()} onAction={() => {
            const result = edit ? run("save_draft", {
              prId: pr.id, version: edit.version, body, commentId: edit.id,
              ...(edit.anchor ? { anchor: edit.anchor } : {}),
              ...(edit.replyTo ? { replyTo: edit.replyTo } : {}),
            }) : run("pr_comment", {
              prId: pr.id, version: item?.version ?? version, body, ...(item ? { replyTo: item.id } : {}),
            });
            return result.then((saved) => { if (saved) dismiss(); });
          }}>{edit ? "Save Draft" : item ? "Post Reply" : "Post Comment"}</ActionButton>
          <button disabled={busy} onClick={dismiss}>Cancel</button>
        </div>
      </div>
    );
  }

  function commentBody(comment: LocalPrComment, root?: LocalPrComment) {
    const author = comment.author;
    return (
      <article className="local-pr-comment" key={comment.id} id={`local-pr-comment-${comment.id}`}>
        <div className="local-pr-comment-head">
          <strong title={author.kind !== "user" ? author.sessionId : undefined}>
            {author.kind === "user" ? "You" : (nameAgent?.(author) ?? "Agent")}
          </strong>
          <span>v{comment.version}{comment.draft ? " · Draft" : ""}</span>
        </div>
        {root && comment.replyTo && comment.replyTo !== root.id && (
          <small><a href={`#local-pr-comment-${comment.replyTo}`}>View Parent Comment</a></small>
        )}
        {comment.anchor && (openAnchor
          ? <button className="local-pr-anchor" title={comparisonLabels[comment.anchor.mode]} onClick={() => openAnchor(comment)}>{formatAnchor(comment.anchor)}</button>
          : <p className="local-pr-anchor-label">{formatAnchor(comment.anchor)}</p>)}
        <p>{comment.body}</p>
        <div className="local-pr-comment-actions">
          {!comment.draft && <button disabled={busy || !!editor} onClick={() => begin({ kind: "reply", comment })}>Reply</button>}
          <button className="local-pr-comment-send" aria-label="Send Comment to Agent" title="Send Comment to Agent"
            disabled={busy} onClick={() => openReview([comment.id], comment.version)}><ComposerIcon name="send" /></button>
          {comment.draft && (
            <details className="local-pr-draft-menu">
              <summary>Draft Actions</summary>
              <div className="local-pr-actions">
                <button disabled={busy || !!editor} onClick={() => begin({ kind: "edit", comment })}>Edit</button>
                <ActionButton disabled={busy} onAction={() => run("publish_drafts", { prId: pr.id, commentIds: [comment.id] })}>Publish</ActionButton>
                <ActionButton disabled={busy} onAction={() => run("discard_draft", { prId: pr.id, commentId: comment.id })}>Discard</ActionButton>
              </div>
            </details>
          )}
        </div>
        {editor?.kind !== "new" && editor?.comment.id === comment.id ? compose() : null}
      </article>
    );
  }

  if (!general && threads.length === 0 && !editor) return null;
  return (
    <section className="local-pr-conversation" aria-label={general ? "Conversation" : "File Conversation"}>
      <div className="local-pr-section-heading">
        <h3>{general ? "Conversation" : "File Conversation"}</h3>
        {general && (
          <div className="local-pr-actions">
            <button disabled={busy || !!editor} onClick={() => begin({ kind: "new" })}>Comment</button>
            <button disabled={busy} onClick={() => openReview([], version)}>Send to Agent</button>
          </div>
        )}
      </div>
      {editor && !editorInThread && compose()}
      {threads.map(({ comment, replies }) => (
        <div className="local-pr-thread" key={comment.id}>
          {commentBody(comment)}
          {replies.length > 0 && <div className="local-pr-replies">{replies.map((reply) => commentBody(reply, comment))}</div>}
        </div>
      ))}
    </section>
  );
}

/** A send is separate from posting a comment, and never guesses its recipient. */
function SendReview({ api, pr, selection, pending, failure, busy, nameAgent, send, onCancel, onSent }: {
  api: LocalPrWindowApi;
  pr: LocalPrDetail;
  selection: OpenReview;
  pending?: LocalPrInput<"discuss">;
  failure: Failure | null;
  busy: boolean;
  nameAgent: (target: SessionTarget) => string;
  send: (input: LocalPrInput<"discuss">) => Promise<boolean>;
  onCancel: () => void;
  onSent: (title: string) => void;
}) {
  const [preferences, setPreferences] = useState<{ selection: OpenReview; ids: string[] } | null>(null);
  const selected = pending?.commentIds ?? (preferences?.selection === selection ? preferences.ids : selection.commentIds);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<{ target: SessionTarget; title: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const choicesLoad = useCallback(() => api.execute("session_choices", { query }), [api, query]);
  const choices = useRead(`sessions:${query}`, choicesLoad, retry);
  const candidate = pr.versions.find((item) => item.version === selection.version)?.submittedBy;
  const pendingChoice = pending && choices.data?.sessions.find((item) => isSameSession(item.target, pending.target));
  const recipient = pending ? pendingChoice : choice;
  const comments = [...pr.comments].sort((a, b) => b.version - a.version);
  const panel = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = panel.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog className="local-pr-send-review" aria-labelledby="local-pr-send-heading" ref={panel} onCancel={(event) => {
      event.preventDefault();
      if (!busy) onCancel();
    }}>
      <div className="local-pr-section-heading">
        <h3 id="local-pr-send-heading">Send Review · v{selection.version}</h3>
        <button disabled={busy} onClick={onCancel}>{pending ? "Close" : "Cancel"}</button>
      </div>
      <div className="local-pr-review-recipient">
        <label>Find Session <input value={query} maxLength={300} disabled={!!pending || busy} onChange={(event) => { setQuery(event.target.value); setChoice(null); }} /></label>
        <label>Send to Session
          <select value={recipient ? JSON.stringify(recipient.target) : ""} disabled={!!pending || busy || choices.loading || !!choices.error} onChange={(event) => {
            setChoice(choices.data?.sessions.find((item) => JSON.stringify(item.target) === event.target.value) ?? null);
          }}>
            <option value="">{pending ? pending.target.sessionId : "Select Session"}</option>
            {choices.data?.sessions.map((item) => (
              <option key={JSON.stringify(item.target)} value={JSON.stringify(item.target)}>
                {item.title}{candidate && isSameSession(candidate, item.target) ? " · Submitted This Version" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReadState state={choices} retry={() => setRetry((n) => n + 1)} />
      {choices.data?.hasMore && <p>Refine the search to find more Sessions.</p>}
      {comments.length > 0 && <details className="local-pr-review-selection" open={!!selection.commentIds.length || !!pending || undefined}>
        <summary>{selected.length} {selected.length === 1 ? "Comment" : "Comments"} Selected</summary>
        <div className="local-pr-selected-comments">
          {comments.map((comment) => <label key={comment.id} title={comment.body}>
            <input type="checkbox" checked={selected.includes(comment.id)} disabled={!!pending || busy || (!selected.includes(comment.id) && selected.length >= 50)} onChange={(event) => {
              setPreferences({
                selection,
                ids: event.target.checked ? [...selected, comment.id] : selected.filter((id) => id !== comment.id),
              });
            }} />
            <span>
              <small>v{comment.version}{comment.anchor ? ` · ${formatAnchor(comment.anchor)}` : ""}</small>
              <span>{comment.body}</span>
            </span>
            {comment.draft && <small>Draft</small>}
          </label>)}
        </div>
      </details>}
      <label>Message
        <textarea disabled={!!pending || busy} value={pending?.message ?? message} maxLength={20000} onChange={(event) => setMessage(event.target.value)} />
      </label>
      {(pending || failure) && <div className="app-notification error" role="alert">
        {failure && <p>{failure.message}</p>}
        {pending && <p>Delivery is unknown. Retry the same request before sending another message.</p>}
      </div>}
      <ActionButton className="local-pr-primary"
        disabled={busy || (!pending && (!choice || !message.trim() || choices.loading || !!choices.error))}
        onAction={() => {
          const input = pending ?? (choice ? { prId: pr.id, version: selection.version, target: choice.target, commentIds: selected, message, requestId: crypto.randomUUID() } : null);
          if (input) return send(input).then((success) => { if (success) onSent(recipient?.title ?? choice?.title ?? nameAgent(input.target)); });
        }}
      >{pending ? "Retry Same Request" : "Send Review"}</ActionButton>
    </dialog>
  );
}
