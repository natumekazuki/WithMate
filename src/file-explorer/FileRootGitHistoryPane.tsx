import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  FileRootChangesGroup,
  type GitRootChanges,
} from "./FileRootChangesGroup.js";
import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  FileRootGitHistoryCommit,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryRepositoriesResult,
  FileRootGitHistoryRepository,
} from "./file-explorer-contract.js";

type FileRootGitHistoryApi = Pick<
  WithMateWindowApi,
  | "listFileRootGitHistoryRepositories"
  | "listFileRootGitHistoryCommits"
  | "getFileRootGitHistoryCommitDetail"
  | "getFileRootGitHistoryDiff"
>;

export type FileRootGitHistoryPaneProps = {
  api: FileRootGitHistoryApi | null;
  sessionId: string | null;
  enabled: boolean;
  rootsRevision: string;
  refreshRevision: number;
  onOpenDiff: (request: FileRootGitHistoryDiffRequest, openInWindow: boolean) => Promise<string | null>;
  onRepositoryChange?: (repositoryId: string | null) => void;
};

const HISTORY_SCOPES = [["commit", "Changed Files"]] as const satisfies readonly [FileRootGitChangeScope, string][];

type HistoryPageIdentity = {
  generation: number;
  repositoryId: string;
  cursor: string | null;
};

function directoryStateKey(rootId: string, scope: FileRootGitChangeScope, relativePath: string): string {
  return `${rootId}\u0000${scope}\u0000${relativePath}`;
}

function historyEntryKey(repositoryId: string, entry: FileRootGitChangeEntry): string {
  return `${repositoryId}:commit:${entry.relativePath}`;
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const elapsedSeconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (elapsedSeconds < 60) {
    return "just now";
  }
  if (elapsedSeconds < 60 * 60) {
    return `${Math.floor(elapsedSeconds / 60)}m ago`;
  }
  if (elapsedSeconds < 60 * 60 * 24) {
    return `${Math.floor(elapsedSeconds / (60 * 60))}h ago`;
  }
  if (elapsedSeconds < 60 * 60 * 24 * 7) {
    return `${Math.floor(elapsedSeconds / (60 * 60 * 24))}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function commitAuthor(commit: FileRootGitHistoryCommit): string {
  return commit.authorName || commit.authorEmail || "Unknown author";
}

export function FileRootGitHistoryPane({
  api,
  sessionId,
  enabled,
  rootsRevision,
  refreshRevision,
  onOpenDiff,
  onRepositoryChange,
}: FileRootGitHistoryPaneProps) {
  const generationRef = useRef(0);
  const selectedRepositoryRef = useRef<FileRootGitHistoryRepository | null>(null);
  const selectedRepositorySessionIdRef = useRef<string | null>(null);
  const pageRequestRef = useRef<HistoryPageIdentity | null>(null);
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const selectedCommitIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [repositories, setRepositories] = useState<FileRootGitHistoryRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<FileRootGitHistoryRepository | null>(null);
  const [commits, setCommits] = useState<FileRootGitHistoryCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listMessage, setListMessage] = useState("");
  const [selectedCommitId, setSelectedCommitId] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<FileRootGitHistoryCommit | null>(null);
  const [changedEntries, setChangedEntries] = useState<FileRootGitChangeEntry[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailMessage, setDetailMessage] = useState("");
  const [collapsedDirectories, setCollapsedDirectories] = useState<Record<string, boolean>>({});
  const [loadingDiffKey, setLoadingDiffKey] = useState("");
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [lastSelectedCommitId, setLastSelectedCommitId] = useState<string | null>(null);

  const isCurrentRepository = useCallback((generation: number, repository: FileRootGitHistoryRepository) => (
    generationRef.current === generation
      && selectedRepositoryRef.current?.repositoryId === repository.repositoryId
      && selectedRepositoryRef.current.rootId === repository.rootId
      && selectedRepositorySessionIdRef.current === sessionId
  ), [sessionId]);

  const loadPage = useCallback(async (
    repository: FileRootGitHistoryRepository,
    generation: number,
    requestedCursor: string | null,
    replace: boolean,
  ) => {
    if (!api || !sessionId || !enabled || !isCurrentRepository(generation, repository)) {
      return;
    }
    const currentRequest = pageRequestRef.current;
    if (
      currentRequest
      && currentRequest.generation === generation
      && currentRequest.repositoryId === repository.repositoryId
      && currentRequest.cursor === requestedCursor
    ) {
      return;
    }
    pageRequestRef.current = { generation, repositoryId: repository.repositoryId, cursor: requestedCursor };
    if (replace) {
      setLoadingCommits(true);
    } else {
      setLoadingMore(true);
    }
    try {
      const result: FileRootGitHistoryCommitsResult = await api.listFileRootGitHistoryCommits({
        sessionId,
        repositoryId: repository.repositoryId,
        rootId: repository.rootId,
        cursor: requestedCursor,
      });
      if (!isCurrentRepository(generation, repository)) {
        return;
      }
      if (result.status !== "ok") {
        setListMessage(result.message);
        return;
      }
      setCommits((current) => {
        const next = replace ? [] : [...current];
        const seen = new Set(next.map((commit) => commit.id));
        for (const commit of result.page.entries) {
          if (!seen.has(commit.id)) {
            next.push(commit);
            seen.add(commit.id);
          }
        }
        return next;
      });
      cursorRef.current = result.page.nextCursor;
      hasMoreRef.current = result.page.hasMore;
      setHasMore(result.page.hasMore);
      setListMessage("");
    } catch (error) {
      if (isCurrentRepository(generation, repository)) {
        setListMessage(error instanceof Error ? error.message : "Commit history could not be loaded.");
      }
    } finally {
      if (pageRequestRef.current?.generation === generation
        && pageRequestRef.current.repositoryId === repository.repositoryId
        && pageRequestRef.current.cursor === requestedCursor
      ) {
        pageRequestRef.current = null;
      }
      if (isCurrentRepository(generation, repository)) {
        setLoadingCommits(false);
        setLoadingMore(false);
      }
    }
  }, [api, enabled, isCurrentRepository, sessionId]);

  const chooseRepository = useCallback((repository: FileRootGitHistoryRepository | null, generation?: number) => {
    const nextGeneration = generation ?? generationRef.current + 1;
    generationRef.current = nextGeneration;
    pageRequestRef.current = null;
    selectedRepositoryRef.current = repository;
    selectedRepositorySessionIdRef.current = sessionId;
    cursorRef.current = null;
    hasMoreRef.current = false;
    selectedCommitIdRef.current = null;
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    setSelectedRepository(repository);
    setCommits([]);
    setHasMore(false);
    setSelectedCommitId(null);
    setSelectedCommit(null);
    setLastSelectedCommitId(null);
    setChangedEntries([]);
    setLoadingDetail(false);
    setDetailMessage("");
    setListMessage("");
    setCollapsedDirectories({});
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
    onRepositoryChange?.(repository?.repositoryId ?? null);
    if (repository) {
      void loadPage(repository, nextGeneration, null, true);
    }
  }, [loadPage, onRepositoryChange, sessionId]);

  const reloadRepositories = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pageRequestRef.current = null;
    detailRequestRef.current += 1;
    const previousRepositoryId = selectedRepositorySessionIdRef.current === sessionId
      ? selectedRepositoryRef.current?.repositoryId
      : null;
    selectedRepositoryRef.current = null;
    selectedRepositorySessionIdRef.current = sessionId;
    onRepositoryChange?.(null);
    setSelectedRepository(null);
    setRepositories([]);
    setCommits([]);
    setSelectedCommitId(null);
    setSelectedCommit(null);
    setChangedEntries([]);
    setListMessage("");
    setDetailMessage("");
    setLoadingRepositories(true);
    setLoadingCommits(false);
    setLoadingMore(false);
    cursorRef.current = null;
    hasMoreRef.current = false;
    setHasMore(false);
    if (!api || !sessionId || !enabled) {
      setLoadingRepositories(false);
      return;
    }
    try {
      const result: FileRootGitHistoryRepositoriesResult = await api.listFileRootGitHistoryRepositories({ sessionId });
      if (generationRef.current !== generation || selectedRepositorySessionIdRef.current !== sessionId) {
        return;
      }
      if (result.status !== "ok") {
        setListMessage(result.message);
        return;
      }
      setRepositories(result.repositories);
      const nextRepository = result.repositories.find((repository) => repository.repositoryId === previousRepositoryId)
        ?? result.repositories[0]
        ?? null;
      chooseRepository(nextRepository, generation);
    } catch (error) {
      if (generationRef.current === generation) {
        setListMessage(error instanceof Error ? error.message : "Git repositories could not be loaded.");
      }
    } finally {
      if (generationRef.current === generation) {
        setLoadingRepositories(false);
      }
    }
  }, [api, chooseRepository, enabled, onRepositoryChange, sessionId]);

  useEffect(() => {
    void reloadRepositories();
    return () => {
      generationRef.current += 1;
      pageRequestRef.current = null;
      detailRequestRef.current += 1;
    };
  }, [reloadRepositories, refreshRevision, rootsRevision]);

  const loadMore = useCallback(() => {
    const repository = selectedRepositoryRef.current;
    const requestedCursor = cursorRef.current;
    if (
      !repository
      || !hasMoreRef.current
      || requestedCursor === null
      || pageRequestRef.current
    ) {
      return;
    }
    void loadPage(repository, generationRef.current, requestedCursor, false);
  }, [loadPage]);

  useEffect(() => {
    if (selectedCommitId || !hasMore || loadingRepositories || !selectedRepository) {
      return;
    }
    const sentinel = sentinelRef.current;
    const root = listScrollRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    }, { root, rootMargin: "0px 0px 96px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loadingRepositories, selectedCommitId, selectedRepository]);

  useEffect(() => {
    if (selectedCommitId) {
      return;
    }
    const scrollElement = listScrollRef.current;
    if (!scrollElement) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      scrollElement.scrollTop = listScrollTopRef.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedCommitId]);

  const selectCommit = useCallback(async (commit: FileRootGitHistoryCommit) => {
    const repository = selectedRepositoryRef.current;
    if (!api || !sessionId || !repository) {
      return;
    }
    const generation = generationRef.current;
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    diffRequestRef.current += 1;
    selectedCommitIdRef.current = commit.id;
    setLastSelectedCommitId(commit.id);
    setSelectedCommitId(commit.id);
    setSelectedCommit(commit);
    setChangedEntries([]);
    setLoadingDetail(true);
    setDetailMessage("");
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
    try {
      const result: FileRootGitHistoryCommitDetailResult = await api.getFileRootGitHistoryCommitDetail({
        sessionId,
        repositoryId: repository.repositoryId,
        rootId: repository.rootId,
        commitId: commit.id,
      });
      if (
        generationRef.current !== generation
        || detailRequestRef.current !== requestId
        || selectedCommitIdRef.current !== commit.id
        || selectedRepositoryRef.current?.repositoryId !== repository.repositoryId
        || selectedRepositoryRef.current?.rootId !== repository.rootId
      ) {
        return;
      }
      if (result.status !== "ok") {
        setDetailMessage(result.message);
        return;
      }
      setSelectedCommit(result.commit);
      setChangedEntries(result.entries);
    } catch (error) {
      if (
        generationRef.current === generation
        && detailRequestRef.current === requestId
        && selectedCommitIdRef.current === commit.id
      ) {
        setDetailMessage(error instanceof Error ? error.message : "Commit detail could not be loaded.");
      }
    } finally {
      if (
        generationRef.current === generation
        && detailRequestRef.current === requestId
        && selectedCommitIdRef.current === commit.id
      ) {
        setLoadingDetail(false);
      }
    }
  }, [api, sessionId]);

  const backToHistory = useCallback(() => {
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    selectedCommitIdRef.current = null;
    setSelectedCommitId(null);
    setLoadingDetail(false);
    setDetailMessage("");
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
  }, []);

  const toggleDirectory = useCallback((rootId: string, scope: FileRootGitChangeScope, relativePath: string) => {
    const key = directoryStateKey(rootId, scope, relativePath);
    setCollapsedDirectories((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const openCommitDiff = useCallback(async (
    entry: FileRootGitChangeEntry | null,
    openInWindow: boolean,
  ) => {
    const repository = selectedRepositoryRef.current;
    const commit = selectedCommit;
    if (!repository || !commit || !sessionId) {
      return;
    }
    const request: FileRootGitHistoryDiffRequest = {
      sessionId,
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      commitId: commit.id,
      relativePath: entry?.relativePath ?? null,
    };
    const key = entry ? historyEntryKey(repository.repositoryId, entry) : `${repository.repositoryId}:commit:all`;
    const generation = generationRef.current;
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    setSelectedEntryPath(entry?.relativePath ?? null);
    setLoadingDiffKey(key);
    setDetailMessage("");
    try {
      const message = await onOpenDiff(request, openInWindow);
      if (
        generationRef.current !== generation
        || diffRequestRef.current !== requestId
        || selectedCommitIdRef.current !== commit.id
        || selectedRepositoryRef.current?.repositoryId !== repository.repositoryId
        || selectedRepositoryRef.current?.rootId !== repository.rootId
      ) {
        return null;
      }
      if (message) {
        setDetailMessage(message);
      }
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git commit diff could not be opened.";
      if (
        generationRef.current === generation
        && diffRequestRef.current === requestId
        && selectedCommitIdRef.current === commit.id
        && selectedRepositoryRef.current?.repositoryId === repository.repositoryId
        && selectedRepositoryRef.current?.rootId === repository.rootId
      ) {
        setDetailMessage(message);
        return message;
      }
      return null;
    } finally {
      if (generationRef.current === generation && diffRequestRef.current === requestId) {
        setLoadingDiffKey("");
      }
    }
  }, [onOpenDiff, selectedCommit, sessionId]);

  const rootChange = useMemo<GitRootChanges | null>(() => {
    const repository = selectedRepository;
    if (!repository) {
      return null;
    }
    return {
      root: {
        id: repository.repositoryId,
        kind: "workspace",
        label: repository.label,
        displayPath: repository.displayPath,
      },
      entries: changedEntries,
      message: "",
    };
  }, [changedEntries, selectedRepository]);

  const selectedEntryKey = selectedEntryPath
    ? `${selectedRepository?.repositoryId ?? ""}:commit:${selectedEntryPath}`
    : null;
  const isBusy = loadingRepositories || loadingCommits || loadingDetail || !!loadingDiffKey;

  return (
    <div className="file-history-pane" aria-busy={isBusy}>
      {repositories.length > 1 ? (
        <label className="file-history-repository-selector">
          <span>Repository</span>
          <select
            aria-label="History repository"
            value={selectedRepository?.repositoryId ?? ""}
            onChange={(event) => {
              const repository = repositories.find((candidate) => candidate.repositoryId === event.target.value) ?? null;
              chooseRepository(repository);
            }}
          >
            {repositories.map((repository) => (
              <option key={repository.repositoryId} value={repository.repositoryId}>
                {repository.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedCommitId ? (
        <div className="file-history-detail">
          <button className="file-history-back" type="button" onClick={backToHistory}>
            ← History
          </button>
          {selectedCommit ? (
            <>
              <div className="file-history-detail-header">
                <h3 title={selectedCommit.subject}>{selectedCommit.subject}</h3>
                <code>{selectedCommit.id}</code>
                <div className="file-history-commit-meta">
                  <span>{commitAuthor(selectedCommit)}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={selectedCommit.authoredAt}>{formatCommitDate(selectedCommit.authoredAt)}</time>
                </div>
                <div className="file-history-ref-badges">
                  {selectedCommit.refs.map((ref) => (
                    <span className={`file-history-ref-badge ${ref.kind}`} key={`${ref.kind}:${ref.name}`}>
                      {ref.kind === "head" ? "HEAD" : ref.name}
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="file-history-open-changes"
                type="button"
                disabled={loadingDetail || !!loadingDiffKey || !rootChange}
                onClick={() => void openCommitDiff(null, false)}
              >
                Open All Changes
              </button>
              {detailMessage ? <p className="file-history-message" role="alert">{detailMessage}</p> : null}
              {loadingDetail ? (
                <div className="workspace-changes-loading" role="status" aria-live="polite">
                  <span className="workspace-changes-spinner" aria-hidden="true" />
                  <span className="visually-hidden">Loading commit detail</span>
                </div>
              ) : rootChange ? (
                <div className="file-history-changed-files">
                  <FileRootChangesGroup
                    rootChange={rootChange}
                    groupCount={1}
                    sizing="content"
                    collapsedDirectories={collapsedDirectories}
                    loadingKey={loadingDiffKey}
                    scopes={HISTORY_SCOPES}
                    selectedEntryKey={selectedEntryKey}
                    onToggleDirectory={toggleDirectory}
                    onOpenEntry={async (_rootId, entry, _scope, openInWindow) => {
                      await openCommitDiff(entry, openInWindow);
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : loadingDetail ? (
            <div className="workspace-changes-loading" role="status" aria-live="polite">
              <span className="workspace-changes-spinner" aria-hidden="true" />
              <span className="visually-hidden">Loading commit detail</span>
            </div>
          ) : detailMessage ? <p className="file-history-message" role="alert">{detailMessage}</p> : null}
        </div>
      ) : (
        <div
          className="file-history-commit-list"
          ref={listScrollRef}
          onScroll={(event) => {
            listScrollTopRef.current = event.currentTarget.scrollTop;
          }}
          role="list"
          aria-label="Commit history"
          tabIndex={0}
        >
          {listMessage ? <p className="file-history-message" role="alert">{listMessage}</p> : null}
          {loadingRepositories || (loadingCommits && commits.length === 0) ? (
            <div className="workspace-changes-loading" role="status" aria-live="polite">
              <span className="workspace-changes-spinner" aria-hidden="true" />
              <span className="visually-hidden">Loading commit history</span>
            </div>
          ) : repositories.length === 0 && !listMessage ? (
            <p className="file-history-empty">No Git repositories.</p>
          ) : commits.length === 0 && !listMessage ? (
            <p className="file-history-empty">No commits.</p>
          ) : (
            commits.map((commit) => (
              <button
                className={`file-history-commit-row${lastSelectedCommitId === commit.id ? " is-selected" : ""}`}
                type="button"
                key={commit.id}
                onClick={() => void selectCommit(commit)}
              >
                <span className="file-history-commit-subject" title={commit.subject}>{commit.subject || "(no subject)"}</span>
                <span className="file-history-commit-secondary">
                  <code>{commit.shortHash}</code>
                  <span>{commitAuthor(commit)}</span>
                  <time dateTime={commit.authoredAt}>{formatCommitDate(commit.authoredAt)}</time>
                </span>
                {commit.refs.length > 0 ? (
                  <span className="file-history-ref-badges file-history-commit-row-ref-badges">
                    {commit.refs.map((ref) => (
                      <span className={`file-history-ref-badge ${ref.kind}`} key={`${ref.kind}:${ref.name}`}>
                        {ref.kind === "head" ? "HEAD" : ref.name}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>
            ))
          )}
          {hasMore ? (
            <div className="file-history-list-sentinel" ref={sentinelRef} aria-hidden="true">
              {loadingMore ? <span className="workspace-changes-spinner" /> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
