import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  FileRootChangesGroup,
  type GitRootChanges,
} from "./FileRootChangesGroup.js";
import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
  FileRootGitHistoryAvailableRef,
  FileRootGitHistoryCommit,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryComparison,
  FileRootGitHistoryComparisonDiffRequest,
  FileRootGitHistoryComparisonMode,
  FileRootGitHistoryComparisonResult,
  FileRootGitHistoryComparisonSelector,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryRef,
  FileRootGitHistoryRepositoriesResult,
  FileRootGitHistoryRepository,
} from "./file-explorer-contract.js";

type FileRootGitHistoryApi = Pick<
  WithMateWindowApi,
  | "listFileRootGitHistoryRepositories"
  | "listFileRootGitHistoryCommits"
  | "getFileRootGitHistoryCommitDetail"
  | "getFileRootGitHistoryDiff"
  | "getFileRootGitHistoryComparison"
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

const HISTORY_REF_MARKERS = {
  head: "H",
  branch: "B",
  tag: "T",
} as const satisfies Record<FileRootGitHistoryRef["kind"], string>;

const HISTORY_REF_KIND_LABELS = {
  head: "HEAD",
  branch: "Branch",
  tag: "Tag",
} as const satisfies Record<FileRootGitHistoryRef["kind"], string>;

const HISTORY_COMPARISON_MODE_LABELS: Record<FileRootGitHistoryComparisonMode, string> = {
  direct: "Direct comparison",
  branch: "Branch changes",
};

const HISTORY_AVAILABLE_REF_KIND_LABELS: Record<FileRootGitHistoryAvailableRef["kind"], string> = {
  branch: "Branch",
  remote: "Remote",
  tag: "Tag",
};

type HistoryComparisonDraft = {
  base: FileRootGitHistoryComparisonSelector | null;
  target: FileRootGitHistoryComparisonSelector | null;
  mode: FileRootGitHistoryComparisonMode;
};

type HistoryComparisonOpenOptions = {
  base?: FileRootGitHistoryComparisonSelector | null;
  target?: FileRootGitHistoryComparisonSelector;
  mode?: FileRootGitHistoryComparisonMode;
};

type HistoryPageIdentity = {
  generation: number;
  repositoryId: string;
  branch: string;
  cursor: string | null;
};

function directoryStateKey(rootId: string, scope: FileRootGitChangeScope, relativePath: string): string {
  return `${rootId}\u0000${scope}\u0000${relativePath}`;
}

function historyEntryKey(repositoryId: string, entry: FileRootGitChangeEntry): string {
  return `${repositoryId}:commit:${entry.relativePath}`;
}

function historyComparisonEntryKey(repositoryId: string, entry: FileRootGitChangeEntry): string {
  return historyEntryKey(repositoryId, entry);
}

function selectorLabel(selector: FileRootGitHistoryComparisonSelector | null): string {
  if (!selector) {
    return "Select a ref";
  }
  if (selector.kind === "head") {
    return "HEAD";
  }
  if (selector.kind === "commit") {
    return `Commit ${selector.objectId.slice(0, 7)}`;
  }
  return selector.name;
}

function selectorKey(selector: FileRootGitHistoryComparisonSelector | null): string {
  if (!selector) {
    return "";
  }
  return selector.kind === "commit" ? `commit:${selector.objectId}` : `${selector.kind}:${selector.kind === "head" ? "HEAD" : selector.name}`;
}

function branchSelector(branch: string | null): FileRootGitHistoryComparisonSelector {
  return branch === null ? { kind: "head" } : { kind: "branch", name: branch };
}

function defaultComparisonBase(
  repository: FileRootGitHistoryRepository,
  target: FileRootGitHistoryComparisonSelector,
): FileRootGitHistoryComparisonSelector | null {
  const refs = repository.refs.filter((ref) => ref.kind === "branch");
  const available = refs.filter((ref) => !(target.kind === "branch" && ref.name === target.name));
  const preferred = available.find((ref) => ref.name === "main" || ref.name === "master") ?? available[0];
  return preferred ? { kind: preferred.kind, name: preferred.name } : null;
}

function focusHistoryComparisonOption(list: HTMLElement | null, index: number): void {
  list?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus();
}

function HistoryComparisonRefPicker({
  label,
  value,
  refs,
  onChange,
  isOpen,
  onToggle,
  onClose,
  disabled = false,
}: {
  label: string;
  value: FileRootGitHistoryComparisonSelector | null;
  refs: FileRootGitHistoryAvailableRef[];
  onChange: (value: FileRootGitHistoryComparisonSelector) => void;
  isOpen: boolean;
  onToggle: () => void;
  onClose: (restoreFocus?: boolean) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();
  const valueId = useId();
  const menuId = useId();
  const queryText = query.trim().toLowerCase();
  const filteredRefs = useMemo(() => refs.filter((ref) => (
    !queryText || ref.name.toLowerCase().includes(queryText)
  )), [queryText, refs]);
  const commitCandidate = /^[0-9a-f]{7,64}$/i.test(query.trim())
    ? query.trim().toLowerCase()
    : null;

  const close = useCallback((restoreFocus = true) => {
    onClose(restoreFocus);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) {
        onClose(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, isOpen, onClose]);

  const choose = (next: FileRootGitHistoryComparisonSelector) => {
    onChange(next);
    close();
  };

  const handleOptionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const optionElements = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const currentIndex = optionElements.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (optionElements.length === 0) {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      focusHistoryComparisonOption(optionsRef.current, (currentIndex + direction + optionElements.length) % optionElements.length);
      return;
    }
    if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      optionElements[currentIndex]?.click();
    }
  };

  return (
    <div className="file-history-comparison-picker">
      <span className="file-history-comparison-picker-label" id={labelId}>{label}</span>
      <div className="file-history-comparison-picker-control" ref={controlRef}>
        <button
          ref={triggerRef}
          className="file-history-comparison-picker-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={menuId}
          aria-labelledby={`${labelId} ${valueId}`}
          disabled={disabled}
          onClick={() => (isOpen ? close() : onToggle())}
        >
          <span id={valueId}>{selectorLabel(value)}</span>
        </button>
        {isOpen ? (
          <div
            className="file-history-comparison-picker-menu"
            id={menuId}
            role="dialog"
            aria-labelledby={labelId}
          >
            <input
              autoFocus
              aria-label={`${label} search`}
              type="search"
              placeholder="Search refs or enter commit SHA"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusHistoryComparisonOption(optionsRef.current, 0);
                }
              }}
            />
            <div
              ref={optionsRef}
              className="file-history-comparison-picker-options"
              role="listbox"
              aria-label={`${label} refs`}
              onKeyDown={handleOptionsKeyDown}
            >
              {(!queryText || "head".includes(queryText)) ? (
                <button
                  className="file-history-comparison-picker-option"
                  type="button"
                  role="option"
                  aria-selected={value?.kind === "head"}
                  onClick={() => choose({ kind: "head" })}
                >
                  <strong>HEAD</strong>
                  <span>Current checked-out commit</span>
                </button>
              ) : null}
              {commitCandidate ? (
                <button
                  className="file-history-comparison-picker-option"
                  type="button"
                  role="option"
                  aria-selected={value?.kind === "commit" && value.objectId === commitCandidate}
                  onClick={() => choose({ kind: "commit", objectId: commitCandidate })}
                >
                  <strong>Commit {commitCandidate.slice(0, 7)}</strong>
                  <span>Resolve typed commit SHA</span>
                </button>
              ) : null}
              {filteredRefs.map((ref) => (
                <button
                  className="file-history-comparison-picker-option"
                  type="button"
                  role="option"
                  aria-selected={value?.kind === ref.kind && value.name === ref.name}
                  key={`${ref.kind}:${ref.name}`}
                  onClick={() => choose({ kind: ref.kind, name: ref.name })}
                >
                  <strong>{ref.name}</strong>
                  <span>{HISTORY_AVAILABLE_REF_KIND_LABELS[ref.kind]}</span>
                </button>
              ))}
              {filteredRefs.length === 0 && !commitCandidate && queryText !== "head" ? (
                <span className="file-history-comparison-picker-empty">No matching refs.</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
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

function HistoryRefBadge({ historyRef }: { historyRef: FileRootGitHistoryRef }) {
  const label = historyRef.kind === "head" ? "HEAD" : historyRef.name;
  const accessibleLabel = historyRef.kind === "head"
    ? "HEAD"
    : `${HISTORY_REF_KIND_LABELS[historyRef.kind]}: ${label}`;

  return (
    <span
      className={`file-history-ref-badge file-history-ref-badge--${historyRef.kind}`}
      data-ref-kind={historyRef.kind}
      aria-label={accessibleLabel}
    >
      <span className="file-history-ref-badge-marker" aria-hidden="true">
        {HISTORY_REF_MARKERS[historyRef.kind]}
      </span>
      <span className="file-history-ref-badge-label">{label}</span>
    </span>
  );
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
  const selectedBranchRef = useRef<string | null>(null);
  const lastRootsRevisionRef = useRef(rootsRevision);
  const pageRequestRef = useRef<HistoryPageIdentity | null>(null);
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const selectedCommitIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const comparisonRequestRef = useRef(0);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [repositories, setRepositories] = useState<FileRootGitHistoryRepository[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<FileRootGitHistoryRepository | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
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
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonDraft, setComparisonDraft] = useState<HistoryComparisonDraft>({
    base: null,
    target: null,
    mode: "branch",
  });
  const [comparison, setComparison] = useState<FileRootGitHistoryComparison | null>(null);
  const [comparisonEntries, setComparisonEntries] = useState<FileRootGitChangeEntry[]>([]);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonMessage, setComparisonMessage] = useState("");
  const [comparisonFilter, setComparisonFilter] = useState("");
  const [comparisonReturnToDetail, setComparisonReturnToDetail] = useState(false);
  const [openComparisonPicker, setOpenComparisonPicker] = useState<"base" | "target" | null>(null);
  const closeComparisonPicker = useCallback(() => {
    setOpenComparisonPicker(null);
  }, []);

  const isCurrentRepository = useCallback((generation: number, repository: FileRootGitHistoryRepository) => (
    generationRef.current === generation
      && selectedRepositoryRef.current?.repositoryId === repository.repositoryId
      && selectedRepositoryRef.current.rootId === repository.rootId
      && selectedRepositorySessionIdRef.current === sessionId
  ), [sessionId]);

  const loadPage = useCallback(async (
    repository: FileRootGitHistoryRepository,
    branch: string,
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
      && currentRequest.branch === branch
      && currentRequest.cursor === requestedCursor
    ) {
      return;
    }
    pageRequestRef.current = { generation, repositoryId: repository.repositoryId, branch, cursor: requestedCursor };
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
        branch,
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
        && pageRequestRef.current.branch === branch
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

  const chooseRepository = useCallback((
    repository: FileRootGitHistoryRepository | null,
    generation?: number,
    branch: string | null = repository?.currentBranch ?? null,
    preserveComparisonDraft = false,
  ) => {
    const nextGeneration = generation ?? generationRef.current + 1;
    generationRef.current = nextGeneration;
    pageRequestRef.current = null;
    selectedRepositoryRef.current = repository;
    selectedRepositorySessionIdRef.current = sessionId;
    selectedBranchRef.current = branch;
    cursorRef.current = null;
    hasMoreRef.current = false;
    selectedCommitIdRef.current = null;
    detailRequestRef.current += 1;
    diffRequestRef.current += 1;
    comparisonRequestRef.current += 1;
    setSelectedRepository(repository);
    setSelectedBranch(branch);
    setCommits([]);
    setHasMore(false);
    setSelectedCommitId(null);
    setSelectedCommit(null);
    setLastSelectedCommitId(null);
    setChangedEntries([]);
    setLoadingDetail(false);
    setDetailMessage("");
    setListMessage("");
    setLoadingCommits(false);
    setLoadingMore(false);
    setCollapsedDirectories({});
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
    setComparisonOpen(false);
    setComparison(null);
    setComparisonEntries([]);
    setComparisonLoading(false);
    setComparisonMessage("");
    setComparisonFilter("");
    setComparisonReturnToDetail(false);
    setOpenComparisonPicker(null);
    if (!preserveComparisonDraft) {
      setComparisonDraft({ base: null, target: null, mode: "branch" });
    }
    onRepositoryChange?.(repository?.repositoryId ?? null);
    if (!repository) {
      return;
    }
    if (branch === null) {
      setListMessage(repository.branches.length > 0
        ? "Git HEAD is detached. Select a branch to view its history."
        : "The Git repository has no committed branches.");
      return;
    }
    void loadPage(repository, branch, nextGeneration, null, true);
  }, [loadPage, onRepositoryChange, sessionId]);

  const chooseBranch = useCallback((branch: string | null) => {
    const repository = selectedRepositoryRef.current;
    if (!repository) {
      return;
    }
    chooseRepository(repository, undefined, branch, true);
  }, [chooseRepository]);

  const reloadRepositories = useCallback(async (preserveSelection: boolean) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pageRequestRef.current = null;
    detailRequestRef.current += 1;
    const previousRepository = selectedRepositorySessionIdRef.current === sessionId
      ? selectedRepositoryRef.current
      : null;
    const previousRepositoryId = previousRepository?.repositoryId ?? null;
    const previousRootId = previousRepository?.rootId ?? null;
    const previousBranch = previousRepository ? selectedBranchRef.current : null;
    selectedRepositoryRef.current = null;
    selectedRepositorySessionIdRef.current = sessionId;
    selectedBranchRef.current = null;
    onRepositoryChange?.(null);
    setSelectedRepository(null);
    setSelectedBranch(null);
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
      const nextRepository = preserveSelection
        ? result.repositories.find((repository) => repository.repositoryId === previousRepositoryId
          && repository.rootId === previousRootId)
        : null;
      const resolvedRepository = nextRepository ?? result.repositories[0] ?? null;
      const nextBranch = preserveSelection
        && resolvedRepository?.repositoryId === previousRepositoryId
        && resolvedRepository.rootId === previousRootId
        ? previousBranch
        : resolvedRepository?.currentBranch ?? null;
      chooseRepository(resolvedRepository, generation, nextBranch);
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
    const preserveSelection = lastRootsRevisionRef.current === rootsRevision;
    lastRootsRevisionRef.current = rootsRevision;
    void reloadRepositories(preserveSelection);
    return () => {
      generationRef.current += 1;
      pageRequestRef.current = null;
      detailRequestRef.current += 1;
      comparisonRequestRef.current += 1;
    };
  }, [reloadRepositories, refreshRevision, rootsRevision]);

  const loadMore = useCallback(() => {
    const repository = selectedRepositoryRef.current;
    const branch = selectedBranchRef.current;
    const requestedCursor = cursorRef.current;
    if (
      !repository
      || !branch
      || !hasMoreRef.current
      || requestedCursor === null
      || pageRequestRef.current
    ) {
      return;
    }
    void loadPage(repository, branch, generationRef.current, requestedCursor, false);
  }, [loadPage]);

  useEffect(() => {
    if (selectedCommitId || comparisonOpen || !hasMore || loadingRepositories || !selectedRepository) {
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
  }, [comparisonOpen, hasMore, loadMore, loadingRepositories, selectedCommitId, selectedRepository]);

  useEffect(() => {
    if (selectedCommitId || comparisonOpen) {
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
  }, [comparisonOpen, selectedCommitId]);

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

  const openComparison = useCallback((
    returnToDetail: boolean,
    options: HistoryComparisonOpenOptions = {},
  ) => {
    const repository = selectedRepositoryRef.current;
    if (!repository || !api) {
      return;
    }
    const target = options.target ?? branchSelector(selectedBranchRef.current);
    const preservedBase = comparisonDraft.base;
    const nextBase = "base" in options
      ? options.base ?? null
      : preservedBase && selectorKey(preservedBase) !== selectorKey(target)
        ? preservedBase
        : defaultComparisonBase(repository, target);
    const mode = options.mode ?? comparisonDraft.mode;
    setComparisonDraft({ base: nextBase, target, mode });
    comparisonRequestRef.current += 1;
    diffRequestRef.current += 1;
    setComparisonOpen(true);
    setComparison(null);
    setComparisonEntries([]);
    setComparisonLoading(false);
    setComparisonMessage("");
    setComparisonFilter("");
    setComparisonReturnToDetail(returnToDetail);
    setOpenComparisonPicker(null);
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
  }, [api, comparisonDraft.base, comparisonDraft.mode]);

  const backFromComparison = useCallback(() => {
    comparisonRequestRef.current += 1;
    diffRequestRef.current += 1;
    setComparisonOpen(false);
    setComparison(null);
    setComparisonEntries([]);
    setComparisonLoading(false);
    setComparisonMessage("");
    setComparisonFilter("");
    setComparisonReturnToDetail(false);
    setOpenComparisonPicker(null);
    setLoadingDiffKey("");
    setSelectedEntryPath(null);
  }, []);

  const applyComparison = useCallback(async () => {
    const repository = selectedRepositoryRef.current;
    if (!api || !sessionId || !repository) {
      return;
    }
    if (!comparisonDraft.base || !comparisonDraft.target) {
      setComparisonMessage("Select both a base and a target ref.");
      return;
    }
    const requestId = comparisonRequestRef.current + 1;
    comparisonRequestRef.current = requestId;
    const generation = generationRef.current;
    setComparisonLoading(true);
    setComparison(null);
    setComparisonEntries([]);
    setComparisonMessage("");
    try {
      const result: FileRootGitHistoryComparisonResult = await api.getFileRootGitHistoryComparison({
        sessionId,
        repositoryId: repository.repositoryId,
        rootId: repository.rootId,
        base: comparisonDraft.base,
        target: comparisonDraft.target,
        mode: comparisonDraft.mode,
      });
      if (
        generationRef.current !== generation
        || comparisonRequestRef.current !== requestId
        || !comparisonOpen
        || selectedRepositoryRef.current?.repositoryId !== repository.repositoryId
        || selectedRepositoryRef.current?.rootId !== repository.rootId
      ) {
        return;
      }
      if (result.status !== "ok") {
        setComparisonMessage(result.message);
        return;
      }
      setComparison(result.comparison);
      setComparisonEntries(result.entries);
      setComparisonFilter("");
    } catch (error) {
      if (
        generationRef.current === generation
        && comparisonRequestRef.current === requestId
        && comparisonOpen
      ) {
        setComparisonMessage(error instanceof Error ? error.message : "Git comparison could not be loaded.");
      }
    } finally {
      if (comparisonRequestRef.current === requestId) {
        setComparisonLoading(false);
      }
    }
  }, [api, comparisonDraft, comparisonOpen, sessionId]);

  const openComparisonDiff = useCallback(async (
    entry: FileRootGitChangeEntry | null,
    openInWindow: boolean,
  ) => {
    const repository = selectedRepositoryRef.current;
    const comparisonSnapshot = comparison;
    if (!repository || !comparisonSnapshot || !sessionId) {
      return;
    }
    const request: FileRootGitHistoryComparisonDiffRequest = {
      sessionId,
      repositoryId: repository.repositoryId,
      rootId: repository.rootId,
      comparison: comparisonSnapshot,
      relativePath: entry?.relativePath ?? null,
    };
    const key = entry
      ? historyComparisonEntryKey(repository.repositoryId, entry)
      : `${repository.repositoryId}:comparison:${comparisonSnapshot.baseCommitId}:${comparisonSnapshot.targetCommitId}:all`;
    const generation = generationRef.current;
    const requestId = diffRequestRef.current + 1;
    diffRequestRef.current = requestId;
    const comparisonRequestId = comparisonRequestRef.current;
    setSelectedEntryPath(entry?.relativePath ?? null);
    setLoadingDiffKey(key);
    setComparisonMessage("");
    try {
      const message = await onOpenDiff(request, openInWindow);
      if (
        generationRef.current !== generation
        || diffRequestRef.current !== requestId
        || comparisonRequestRef.current !== comparisonRequestId
        || !comparisonOpen
        || comparison?.baseCommitId !== comparisonSnapshot.baseCommitId
        || comparison?.targetCommitId !== comparisonSnapshot.targetCommitId
        || selectedRepositoryRef.current?.repositoryId !== repository.repositoryId
        || selectedRepositoryRef.current?.rootId !== repository.rootId
      ) {
        return null;
      }
      if (message) {
        setComparisonMessage(message);
      }
      return message;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git comparison diff could not be opened.";
      if (
        generationRef.current === generation
        && diffRequestRef.current === requestId
        && comparisonRequestRef.current === comparisonRequestId
        && comparisonOpen
      ) {
        setComparisonMessage(message);
        return message;
      }
      return null;
    } finally {
      if (generationRef.current === generation && diffRequestRef.current === requestId) {
        setLoadingDiffKey("");
      }
    }
  }, [comparison, comparisonOpen, onOpenDiff, sessionId]);

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
      status: changedEntries.length > 0 ? "success" : "empty",
      entries: changedEntries,
      message: "",
    };
  }, [changedEntries, selectedRepository]);

  const filteredComparisonEntries = useMemo(() => {
    const query = comparisonFilter.trim().toLowerCase();
    if (!query) {
      return comparisonEntries;
    }
    return comparisonEntries.filter((entry) => (
      entry.relativePath.toLowerCase().includes(query)
      || entry.previousRelativePath?.toLowerCase().includes(query)
    ));
  }, [comparisonEntries, comparisonFilter]);

  const comparisonRootChange = useMemo<GitRootChanges | null>(() => {
    const repository = selectedRepository;
    if (!repository || !comparison) {
      return null;
    }
    return {
      root: {
        id: repository.repositoryId,
        kind: "workspace",
        label: repository.label,
        displayPath: repository.displayPath,
      },
      status: filteredComparisonEntries.length > 0 ? "success" : "empty",
      entries: filteredComparisonEntries,
      message: "",
    };
  }, [comparison, filteredComparisonEntries, selectedRepository]);

  const selectedBranchAvailable = selectedRepository
    && selectedBranch !== null
    && selectedRepository.branches.includes(selectedBranch);
  const selectedEntryKey = selectedEntryPath
    ? comparisonOpen && comparison
      ? historyComparisonEntryKey(selectedRepository?.repositoryId ?? "", {
          relativePath: selectedEntryPath,
          previousRelativePath: null,
          kinds: {},
          scopes: ["commit"],
        })
      : `${selectedRepository?.repositoryId ?? ""}:commit:${selectedEntryPath}`
    : null;
  const canCompare = Boolean(api);
  const isBusy = loadingRepositories || loadingCommits || loadingDetail || comparisonLoading || !!loadingDiffKey;

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
      {selectedRepository && (
        selectedRepository.branches.length > 0
        || selectedBranch !== null
        || selectedRepository.refs.length > 0
      ) ? (
        <div className="file-history-history-toolbar">
          <label className="file-history-repository-selector">
            <span>Branch</span>
            <select
              aria-label="History branch"
              value={selectedBranch ?? ""}
              onChange={(event) => chooseBranch(event.target.value || null)}
            >
              {selectedBranch === null ? (
                <option value="" disabled>Detached HEAD — select a branch</option>
              ) : !selectedBranchAvailable ? (
                <option value={selectedBranch} disabled>{selectedBranch} (no longer available)</option>
              ) : null}
              {selectedRepository.branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}{branch === selectedRepository.currentBranch ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          {canCompare ? (
            <button
              className="file-history-compare-trigger"
              type="button"
              onClick={() => openComparison(false, { mode: "branch" })}
            >
              Compare
            </button>
          ) : null}
        </div>
      ) : null}

      {comparisonOpen ? (
        <div className="file-history-comparison" aria-busy={comparisonLoading || undefined}>
          <button className="file-history-back" type="button" onClick={backFromComparison}>
            ← {comparisonReturnToDetail ? "Commit details" : "History"}
          </button>
          <div className="file-history-comparison-form">
            <div className="file-history-comparison-form-heading">
              <h3>Compare</h3>
            </div>
            {selectedRepository ? (
              <>
                <HistoryComparisonRefPicker
                  label="Base"
                  value={comparisonDraft.base}
                  refs={selectedRepository.refs}
                  disabled={comparisonLoading}
                  isOpen={openComparisonPicker === "base"}
                  onToggle={() => setOpenComparisonPicker((current) => current === "base" ? null : "base")}
                  onClose={closeComparisonPicker}
                  onChange={(base) => setComparisonDraft((current) => ({ ...current, base }))}
                />
                <HistoryComparisonRefPicker
                  label="Target"
                  value={comparisonDraft.target}
                  refs={selectedRepository.refs}
                  disabled={comparisonLoading}
                  isOpen={openComparisonPicker === "target"}
                  onToggle={() => setOpenComparisonPicker((current) => current === "target" ? null : "target")}
                  onClose={closeComparisonPicker}
                  onChange={(target) => setComparisonDraft((current) => ({ ...current, target }))}
                />
                <label className="file-history-comparison-mode">
                  <span>Mode</span>
                  <select
                    aria-label="Comparison mode"
                    value={comparisonDraft.mode}
                    disabled={comparisonLoading}
                    onChange={(event) => setComparisonDraft((current) => ({
                      ...current,
                      mode: event.target.value as FileRootGitHistoryComparisonMode,
                    }))}
                  >
                    {(Object.keys(HISTORY_COMPARISON_MODE_LABELS) as FileRootGitHistoryComparisonMode[]).map((mode) => (
                      <option key={mode} value={mode}>{HISTORY_COMPARISON_MODE_LABELS[mode]}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="file-history-open-changes file-history-comparison-submit"
                  type="button"
                  disabled={comparisonLoading || !comparisonDraft.base || !comparisonDraft.target}
                  onClick={() => void applyComparison()}
                >
                  Compare
                </button>
              </>
            ) : null}
          </div>
          {comparisonMessage ? <p className="file-history-message" role="alert">{comparisonMessage}</p> : null}
          {comparisonLoading ? (
            <div className="workspace-changes-loading" role="status" aria-live="polite">
              <span className="workspace-changes-spinner" aria-hidden="true" />
              <span className="visually-hidden">Loading Git comparison</span>
            </div>
          ) : comparison && comparisonRootChange ? (
            <>
              <div
                className="file-history-comparison-result-header"
                data-base-commit-id={comparison.baseCommitId}
                data-target-commit-id={comparison.targetCommitId}
              >
                <div>
                  <strong>
                    {filteredComparisonEntries.length === comparisonEntries.length
                      ? `${comparisonEntries.length} changed files`
                      : `${filteredComparisonEntries.length} matching files`}
                  </strong>
                  <span>{HISTORY_COMPARISON_MODE_LABELS[comparison.mode]}</span>
                </div>
                <div className="file-history-comparison-oids" title={`${comparison.baseCommitId} → ${comparison.targetCommitId}`}>
                  <code>{comparison.baseCommitId}</code>
                  <span aria-hidden="true">→</span>
                  <code>{comparison.targetCommitId}</code>
                </div>
                {comparison.mergeBaseCommitId ? (
                  <span className="file-history-comparison-merge-base">
                    merge-base <code>{comparison.mergeBaseCommitId}</code>
                  </span>
                ) : null}
                <label className="file-history-comparison-filter">
                  <span>Filter</span>
                  <input
                    aria-label="Filter changed files"
                    type="search"
                    placeholder="Filter changed files"
                    value={comparisonFilter}
                    onChange={(event) => setComparisonFilter(event.target.value)}
                  />
                </label>
                <div className="file-history-comparison-result-actions">
                  <button
                    className="file-history-open-changes"
                    type="button"
                    disabled={!!loadingDiffKey}
                    onClick={(event) => void openComparisonDiff(null, event.ctrlKey || event.metaKey)}
                  >
                    Open All Changes
                  </button>
                </div>
              </div>
              <div className="file-history-changed-files">
                <FileRootChangesGroup
                  rootChange={comparisonRootChange}
                  groupCount={1}
                  sizing="content"
                  collapsedDirectories={collapsedDirectories}
                  loadingKey={loadingDiffKey}
                  scopes={HISTORY_SCOPES}
                  selectedEntryKey={selectedEntryKey}
                  onToggleDirectory={toggleDirectory}
                  onOpenEntry={async (_rootId, entry, _scope, openInWindow) => {
                    await openComparisonDiff(entry, openInWindow);
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
      ) : selectedCommitId ? (
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
                    <HistoryRefBadge historyRef={ref} key={`${ref.kind}:${ref.name}`} />
                  ))}
                </div>
              </div>
              <div className="file-history-detail-actions">
                <button
                  className="file-history-open-changes"
                  type="button"
                  disabled={loadingDetail || !!loadingDiffKey || !rootChange}
                  onClick={() => void openCommitDiff(null, false)}
                >
                  Open All Changes
                </button>
                {canCompare ? (
                  <button
                    className="file-history-open-changes"
                    type="button"
                    disabled={loadingDetail || !!loadingDiffKey || !selectedCommit}
                    onClick={() => openComparison(true, {
                      base: selectedCommit ? { kind: "commit", objectId: selectedCommit.id } : null,
                      mode: "direct",
                    })}
                  >
                    Compare
                  </button>
                ) : null}
              </div>
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
              <div className="file-history-commit-row-wrapper" key={commit.id}>
                <button
                  className={`file-history-commit-row${lastSelectedCommitId === commit.id ? " is-selected" : ""}`}
                  type="button"
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
                        <HistoryRefBadge historyRef={ref} key={`${ref.kind}:${ref.name}`} />
                      ))}
                    </span>
                  ) : null}
                </button>
                {canCompare ? (
                  <button
                    className="file-history-commit-compare"
                    type="button"
                    aria-label={`Compare ${commit.shortHash}`}
                    title={`Compare ${commit.shortHash}`}
                    onClick={() => openComparison(false, {
                      base: { kind: "commit", objectId: commit.id },
                      mode: "direct",
                    })}
                  >
                    <span aria-hidden="true">↔</span>
                  </button>
                ) : null}
              </div>
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
