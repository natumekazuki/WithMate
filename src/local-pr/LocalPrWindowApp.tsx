import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithRef } from "react";
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
import { parseUnifiedDiff } from "../file-explorer/unified-diff.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { ErrorDetailsButton } from "../ui/error-details.js";
import "./local-pr.css";

type Mode = "full" | "previous";
type Tab = "overview" | "changes" | "checks";
type Failure = { message: string; effect: "none" | "unknown" };

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
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
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

  /** Both the full list and the compact selector open the same PR at its latest version. */
  function selectPr(id: string) {
    setCreating(false);
    setSelected(id);
    setVersion(null);
    setAnchorComment(null);
    setTab("overview");
  }

  return (
    <div className="page-shell session-page local-pr-app">
      <aside className="local-pr-list" aria-label="Pull Requests">
        <header className="local-pr-list-toolbar">
          <h1>Pull Requests</h1>
          <div className="session-file-preview-actions">
            <button className="local-pr-primary"
              onClick={() => {
                setCreating(true);
                setSelected(null);
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
        {!!list.data?.entries.length && (
          <div className="local-pr-compact-list">
            <select aria-label="Select Pull Request" value={selected ?? ""} onChange={(event) => selectPr(event.target.value)}>
              <option disabled value="">Select Pull Request</option>
              {list.data.entries.map((item) => (
                <option key={item.id} value={item.id}>{item.title} · {prStateLabels[item.state]} · v{item.latestVersion} · {item.targetBranch}</option>
              ))}
            </select>
          </div>
        )}
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
              <small>
                {item.sourceBranch ?? "Detached Head"} →{" "}
                {item.targetBranch}
              </small>
            </button>
          ))}
        </div>
        <div className="local-pr-list-feedback">
          <ReadState state={list} retry={refresh} />
        </div>
      </aside>
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
                      <code>{pr.sourceBranch ?? "Detached Head"} → {pr.targetBranch}</code>
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
                {tab === "overview" && (
                  <Overview
                    key={pr.id}
                    api={api}
                    pr={pr}
                    version={currentVersion.version}
                    revision={revision}
                    run={run}
                    discuss={discuss}
                    pendingDiscussion={uncertainDiscussions[pr.id]}
                    busy={busy || detail.loading || !!detail.error}
                    openAnchor={(comment) => {
                      setAnchorComment(comment);
                      setVersion(comment.version);
                      setTab("changes");
                    }}
                  />
                )}
                {tab === "changes" && (
                  <Changes
                    key={`${pr.id}:${currentVersion.version}`}
                    api={api}
                    pr={pr}
                    version={currentVersion.version}
                    revision={revision}
                    refresh={refresh}
                    run={run}
                    busy={busy}
                    initialComment={
                      anchorComment?.version === currentVersion.version
                        ? anchorComment
                        : null
                    }
                  />
                )}
                {tab === "checks" && (
                  <Checks
                    key={`${pr.id}:${currentVersion.version}`}
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
        ) : null}
        <div className="local-pr-main-feedback">
          {failure && (
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
}: {
  api: LocalPrWindowApi;
  pr: LocalPrDetail;
  version: number;
  revision: number;
  refresh: () => void;
  run: Run;
  busy: boolean;
  initialComment: LocalPrComment | null;
}) {
  const [mode, setMode] = useState<Mode>(
    initialComment?.anchor?.mode ?? "full",
  );
  const [selectedPath, setPath] = useState(initialComment?.anchor?.path ?? "");
  const [side, setSide] = useState<"before" | "after">(
    initialComment?.anchor?.side ?? "after",
  );
  const [scope, setScope] = useState<"file" | "lines">(
    initialComment?.anchor?.startLine === null ? "file" : "lines",
  );
  const [start, setStart] = useState(
    initialComment?.anchor?.startLine?.toString() ?? "",
  );
  const [end, setEnd] = useState(
    initialComment?.anchor?.endLine?.toString() ?? "",
  );
  const [body, setBody] = useState("");
  const filesLoad = useCallback(
    () => api.execute("pr_diff", { prId: pr.id, version, mode }),
    [api, pr.id, version, mode],
  );
  const files = useRead(`${pr.id}:${version}:${mode}`, filesLoad, revision);
  const path = selectedPath || files.data?.files[0]?.path || "";
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
    () => (patch.data?.patch ? parseUnifiedDiff(patch.data.patch).rows : []),
    [patch.data],
  );
  const codeRef = useRef<HTMLDivElement>(null);
  const anchorMoved = useRef(false);
  const virtualRows = useVirtualizer({
    count: rows.length,
    getScrollElement: () => codeRef.current,
    estimateSize: (index) => (rows[index]?.kind === "modify" ? 38 : 19),
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
  const startNumber = Number(start);
  const endNumber = Number(end);
  const validRange =
    Number.isSafeInteger(startNumber) &&
    startNumber > 0 &&
    Number.isSafeInteger(endNumber) &&
    endNumber >= startNumber;
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
        {files.data && (
          <code className="local-pr-revision-range">
              {files.data.beforeCommit.slice(0, 12)} →{" "}
              {files.data.afterCommit.slice(0, 12)}
          </code>
        )}
      </header>
      <aside className="local-pr-files" aria-label="Changed Files">
        <ReadState state={files} retry={refresh} />
        {files.data?.files.map((file) => (
          <button
            key={file.path}
            className="local-pr-file"
            aria-current={path === file.path ? "true" : undefined}
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
            <h3>{path}</h3>
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
                  const anchor = initialComment?.anchor;
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
                      <span>{row.leftNumber ?? ""}</span>
                      <span>{row.rightNumber ?? ""}</span>
                      <pre>
                        {row.kind === "modify"
                          ? `− ${row.leftText ?? ""}\n+ ${row.rightText ?? ""}`
                          : `${row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "} ${row.rightText ?? row.leftText ?? ""}`}
                      </pre>
                    </div>
                  );
                })}
              </div>
              {patch.data && patch.data.patch === null && (
                <p>Patch unavailable for this file.</p>
              )}
            </div>
            <section className="local-pr-draft">
              <h4>Draft Comment · v{version}</h4>
              <div className="local-pr-actions">
                <label>
                  Side{" "}
                  <select
                    value={side}
                    onChange={(e) =>
                      setSide(e.target.value as "before" | "after")
                    }
                  >
                    <option value="before">Before</option>
                    <option value="after">After</option>
                  </select>
                </label>
                <label>
                  Scope{" "}
                  <select
                    value={scope}
                    onChange={(e) =>
                      setScope(e.target.value as "file" | "lines")
                    }
                  >
                    <option value="file">Whole File</option>
                    <option value="lines">Lines</option>
                  </select>
                </label>
                {scope === "lines" && (
                  <>
                    <label>
                      Start Line{" "}
                      <input
                        type="number"
                        min="1"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label>
                      End Line{" "}
                      <input
                        type="number"
                        min="1"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
              <label>
                Comment
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <ActionButton className="local-pr-primary"
                disabled={
                  busy || !body.trim() || (scope === "lines" && !validRange)
                }
                onAction={() =>
                  run("save_draft", {
                    prId: pr.id,
                    version,
                    body,
                    anchor: {
                      mode,
                      path,
                      side,
                      startLine: scope === "file" ? null : startNumber,
                      endLine: scope === "file" ? null : endNumber,
                    },
                  }).then((result) => {
                    if (result) setBody("");
                  })
                }
              >
                Save Draft
              </ActionButton>
            </section>
            {pr.comments
              .filter(
                (c) =>
                  c.version === version &&
                  c.anchor?.path === path &&
                  c.anchor.mode === mode,
              )
              .map((comment) => (
                <article className="local-pr-comment" key={comment.id}>
                  <strong>
                    {comment.draft ? "Draft" : "Comment"} ·{" "}
                    {comment.anchor ? sideLabels[comment.anchor.side] : ""}{" "}
                    {comment.anchor?.startLine === null
                      ? "Whole File"
                      : `${comment.anchor?.startLine}–${comment.anchor?.endLine}`}
                  </strong>
                  <p>{comment.body}</p>
                </article>
              ))}
          </>
        ) : null}
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
      <label>
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
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
  discuss,
  pendingDiscussion,
  busy,
  openAnchor,
}: {
  api: LocalPrWindowApi;
  pr: LocalPrDetail;
  version: number;
  revision: number;
  run: Run;
  discuss: (input: LocalPrInput<"discuss">) => Promise<boolean>;
  pendingDiscussion?: LocalPrInput<"discuss">;
  busy: boolean;
  openAnchor: (comment: LocalPrComment) => void;
}) {
  const [body, setBody] = useState("");
  const [reply, setReply] = useState<LocalPrComment | null>(null);
  const [editing, setEditing] = useState<LocalPrComment | null>(null);
  const [selectedComments, setSelectedComments] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<SessionTarget | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
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
  const choicesLoad = useCallback(
    () => api.execute("session_choices", { query }),
    [api, query],
  );
  const choices = useRead(`sessions:${query}`, choicesLoad, branchRevision);
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
  return (
    <div className="local-pr-scroll">
      <div className="local-pr-overview-grid">
        <section className="local-pr-submission">
          <h3>Submission</h3>
          {selectedVersion && (
            <dl className="local-pr-commit-list">
              <dt>Head</dt>
              <dd>
                <code>{selectedVersion.headCommit}</code>
              </dd>
              <dt>Target</dt>
              <dd>
                <code>{selectedVersion.targetCommit}</code>
              </dd>
              <dt>Merge Base</dt>
              <dd>
                <code>{selectedVersion.mergeBaseCommit}</code>
              </dd>
            </dl>
          )}
          <p className="local-pr-submission-status">
            <span className="local-pr-status" data-state={isApproved ? "approved" : undefined}>
              {isApproved ? `Approved v${pr.approval?.version}` : "Not Approved"}
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
          {pr.state === "open" && (
            <div className="local-pr-submit-version">
              <h3>Submit Version</h3>
              <ReadState
                state={branches}
                retry={() => setBranchRevision((n) => n + 1)}
              />
              <dl className="local-pr-commit-list">
                <dt>Source Head</dt>
                <dd><code>{source?.commit ?? "Unavailable"}</code></dd>
                <dt>Target</dt>
                <dd><code>{target?.commit ?? "Unavailable"}</code></dd>
              </dl>
              <div className="local-pr-actions">
                <ActionButton
                  disabled={
                    busy ||
                    branches.loading ||
                    !!branches.error ||
                    !latest ||
                    !target ||
                    !source
                  }
                  onAction={() =>
                    latest && target && source
                    ? run("pr_submit", {
                      prId: pr.id,
                      expectedVersion: latest.version,
                      headCommit: source.commit,
                      expectedTargetCommit: target.commit,
                    }) : undefined
                  }
                >
                  Submit Source Head
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
                      }) : undefined
                    }
                  >
                    Re-submit Reviewed Head for New Target
                  </ActionButton>
                )}
              </div>
            </div>
          )}
        </section>
        <section className="local-pr-conversation">
          {pr.description && <p className="local-pr-description">{pr.description}</p>}
          <h3>Conversation</h3>
          {pr.comments.map((comment) => (
            <article
              className="local-pr-comment"
              id={`local-pr-comment-${comment.id}`}
              key={comment.id}
            >
              <div className="local-pr-comment-head">
                <strong>
                  {comment.author.kind === "user"
                    ? "You"
                    : comment.author.sessionId}
                </strong>
                <span>
                  v{comment.version}
                  {comment.draft ? " · Draft" : ""}
                </span>
              </div>
              {comment.replyTo && (
                <small>
                  <a href={`#local-pr-comment-${comment.replyTo}`}>
                    View Parent Comment
                  </a>
                </small>
              )}
              {comment.anchor && (
                <button
                  className="local-pr-anchor"
                  onClick={() => openAnchor(comment)}
                >
                  {comment.anchor.path} ·{" "}
                  {comparisonLabels[comment.anchor.mode]} ·{" "}
                  {sideLabels[comment.anchor.side]}{" "}
                  {comment.anchor.startLine === null
                    ? "Whole File"
                    : `${comment.anchor.startLine}–${comment.anchor.endLine}`}
                </button>
              )}
              <p>{comment.body}</p>
              <div className="local-pr-actions">
                <button
                  onClick={() => {
                    setReply(comment);
                    setEditing(null);
                  }}
                >
                  Reply
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedComments.includes(comment.id)}
                    disabled={
                      !selectedComments.includes(comment.id) &&
                      selectedComments.length >= 50
                    }
                    onChange={(e) =>
                      setSelectedComments((ids) =>
                        e.target.checked
                          ? [...ids, comment.id]
                          : ids.filter((id) => id !== comment.id),
                      )
                    }
                  />{" "}
                  Select for Session
                </label>
                {comment.draft && (
                  <>
                    <button
                      onClick={() => {
                        setEditing(comment);
                        setReply(null);
                        setBody(comment.body);
                      }}
                    >
                      Edit
                    </button>
                    <ActionButton
                      disabled={busy}
                      onAction={() =>
                        run("publish_drafts", {
                          prId: pr.id,
                          commentIds: [comment.id],
                        })
                      }
                    >
                      Publish
                    </ActionButton>
                    <ActionButton
                      disabled={busy}
                      onAction={() =>
                        run("discard_draft", {
                          prId: pr.id,
                          commentId: comment.id,
                        })
                      }
                    >
                      Discard
                    </ActionButton>
                  </>
                )}
              </div>
            </article>
          ))}
          {selectedComments.some((id) =>
            pr.comments.some((comment) => comment.id === id && comment.draft),
          ) && (
            <ActionButton
              disabled={busy}
              onAction={() =>
                run("publish_drafts", {
                  prId: pr.id,
                  commentIds: selectedComments.filter((id) =>
                    pr.comments.some(
                      (comment) => comment.id === id && comment.draft,
                    ),
                  ),
                })
              }
            >
              Publish Selected Drafts
            </ActionButton>
          )}
          {editing ? (
            <>
              <label>
                Edit Draft
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <ActionButton className="local-pr-primary"
                disabled={busy || !body.trim()}
                onAction={() =>
                  run("save_draft", {
                    prId: pr.id,
                    version: editing.version,
                    body,
                    commentId: editing.id,
                    ...(editing.anchor ? { anchor: editing.anchor } : {}),
                    ...(editing.replyTo ? { replyTo: editing.replyTo } : {}),
                  }).then((result) => {
                    if (result) {
                      setBody("");
                      setEditing(null);
                    }
                  })
                }
              >
                Save Draft
              </ActionButton>{" "}
              <button
                onClick={() => {
                  setEditing(null);
                  setBody("");
                }}
              >
                Cancel Edit
              </button>
            </>
          ) : (
            <>
              <label>
                {reply
                  ? `Reply to v${reply.version}`
                  : `Comment on v${version}`}
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <div className="local-pr-actions">
                <ActionButton className="local-pr-primary"
                  disabled={busy || !body.trim()}
                  onAction={() =>
                    run("pr_comment", {
                      prId: pr.id,
                      version: reply?.version ?? version,
                      body,
                      ...(reply ? { replyTo: reply.id } : {}),
                    }).then((result) => {
                      if (result) {
                        setBody("");
                        setReply(null);
                      }
                    })
                  }
                >
                  Post Comment
                </ActionButton>
                {reply && (
                  <button onClick={() => setReply(null)}>Cancel Reply</button>
                )}
              </div>
            </>
          )}
          <details className="local-pr-discuss" open={pendingDiscussion || selectedComments.length ? true : undefined}>
            <summary>Discuss in Session</summary>
            <label>
              Find Session
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setChoice(null);
                }}
              />
            </label>
            <ReadState
              state={choices}
              retry={() => setBranchRevision((n) => n + 1)}
            />
            <label>
              Session
              <select
                value={choice ? JSON.stringify(choice) : ""}
                onChange={(e) =>
                  setChoice(
                    e.target.value
                      ? (JSON.parse(e.target.value) as SessionTarget)
                      : null,
                  )
                }
              >
                <option value="">Select Session</option>
                {choices.data?.sessions.map((item) => (
                  <option
                    key={JSON.stringify(item.target)}
                    value={JSON.stringify(item.target)}
                  >
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {choices.data?.hasMore && (
              <p>Refine the search to find more Sessions.</p>
            )}
            <label>
              Message
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <p>{selectedComments.length} Comments Selected</p>
            {pendingDiscussion && (
              <p role="alert">
                Delivery is unknown. Retry the same request before sending another
                message.
              </p>
            )}
            <ActionButton className="local-pr-primary"
              disabled={
                busy || (!pendingDiscussion && (!choice || !message.trim()))
              }
              onAction={() => {
                const input =
                  pendingDiscussion ??
                  (choice
                    ? {
                        prId: pr.id,
                        version,
                        target: choice,
                        commentIds: selectedComments,
                        message,
                        requestId,
                      }
                    : null);
                if (input)
                  return discuss(input).then((success) => {
                    if (success) {
                      setMessage("");
                      setSelectedComments([]);
                      setRequestId(crypto.randomUUID());
                    } else if (!pendingDiscussion)
                      setRequestId(crypto.randomUUID());
                  });
              }}
            >
              {pendingDiscussion ? "Retry Same Request" : "Send to Session"}
            </ActionButton>
          </details>
        </section>
      </div>
    </div>
  );
}
