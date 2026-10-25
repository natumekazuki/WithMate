import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import type {
  GlossaryEntry,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";

export type SessionGlossaryPaneProps = {
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  projection: SessionGlossaryProjection | null;
  projectionLoading: boolean;
  projectionError: string;
  searchQuery: string;
  searchEntries: readonly GlossaryEntry[];
  searchTotal: number;
  searchLoading: boolean;
  searchError: string;
  searchStale: boolean;
  selectedTerm: string | null;
  onSearchQueryChange: (query: string) => void;
  onLoadMoreSearchResults: () => void;
  onRetryProjection: () => void;
  onRetrySearch: () => void;
  onSelectTerm: (term: string) => void;
  onBackToList: () => void;
};

function stateMessage(projection: SessionGlossaryProjection): { title: string; detail?: string } | null {
  switch (projection.state.status) {
    case "missing":
      return null;
    case "invalid":
      return {
        title: "Could not load the glossary",
        detail: projection.state.issues[0]?.message ?? "Check the glossary.yaml file contents.",
      };
    case "unsupported":
      return {
        title: "Unsupported format",
        detail: `schemaVersion ${String(projection.state.schemaVersion ?? "unknown")}`,
      };
    case "watch-error":
      return {
        title: "Could not check for glossary updates",
        detail: projection.state.message,
      };
    case "not-applicable":
      return null;
    case "valid":
      return null;
  }
}

export function SessionGlossaryPane({
  scrollContainerRef,
  projection,
  projectionLoading,
  projectionError,
  searchQuery,
  searchEntries,
  searchTotal,
  searchLoading,
  searchError,
  searchStale,
  selectedTerm,
  onSearchQueryChange,
  onLoadMoreSearchResults,
  onRetryProjection,
  onRetrySearch,
  onSelectTerm,
  onBackToList,
}: SessionGlossaryPaneProps) {
  const savedListScrollTopRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const restoreSearchFocusRef = useRef(false);
  const retry = (action: () => void) => {
    restoreSearchFocusRef.current = recoveryRef.current?.contains(document.activeElement) ?? false;
    action();
  };
  const entries = projection?.state.status === "valid" ? projection.state.entries : [];
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.term === selectedTerm)
      ?? searchEntries.find((entry) => entry.term === selectedTerm) ?? null,
    [entries, searchEntries, selectedTerm],
  );
  const visibleEntries = searchQuery.trim() ? searchEntries : entries;
  const visibleTotal = searchQuery.trim() ? searchTotal : entries.length;

  useLayoutEffect(() => {
    if (!restoreSearchFocusRef.current || projectionError || searchError) return;
    restoreSearchFocusRef.current = false;
    if (document.activeElement === document.body) searchInputRef.current?.focus();
  }, [projectionError, searchError]);

  useLayoutEffect(() => {
    if (scrollContainerRef?.current) {
      scrollContainerRef.current.scrollTop = selectedEntry ? 0 : savedListScrollTopRef.current;
    }
  }, [scrollContainerRef, selectedEntry]);

  useLayoutEffect(() => {
    if (!selectedEntry && scrollContainerRef?.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [scrollContainerRef, searchQuery]);

  if (!projection) {
    if (projectionError) {
      return (
        <div ref={recoveryRef}>
          <LoadError className="glossary-load-error" message={`Could not load the glossary: ${projectionError}`} onRetry={() => retry(onRetryProjection)} retryBusy={projectionLoading} />
        </div>
      );
    }
    return (
      <div className="glossary-pane-loading" aria-busy="true">
        <LoadingIndicator label="Loading glossary" />
      </div>
    );
  }

  const unavailable = stateMessage(projection);
  const checkoutLabel = projection.checkout.branch
    || projection.checkout.pathLabel
    || projection.checkout.repositoryName;
  const checkoutTitle = [
    projection.checkout.repositoryName,
    projection.checkout.branch,
    projection.checkout.pathLabel,
  ].filter(Boolean).join(" / ");
  const isNotApplicable = projection.state.status === "not-applicable";
  const showList = projection.state.status === "valid" && !selectedEntry;
  return (
    <section className="glossary-pane" aria-label="Repository glossary">
      {isNotApplicable ? null : (
        <div className="glossary-pane-controls">
          <p className="glossary-pane-checkout" title={checkoutTitle}>{checkoutLabel}</p>
          {showList ? (
            <>
              <label className="glossary-search-field">
                <span className="sr-only">Search Glossary</span>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => onSearchQueryChange(event.target.value)}
                />
              </label>
              {searchError ? (
                <div ref={recoveryRef}>
                  <LoadError className="glossary-search-error" message={searchError} onRetry={() => retry(onRetrySearch)} retryBusy={searchLoading} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {projectionError ? <LoadError className="glossary-load-error" message={`Could not refresh the glossary: ${projectionError}`} onRetry={onRetryProjection} retryBusy={projectionLoading} /> : null}
      {searchStale ? <p className="glossary-search-stale" role="status">Showing previous search results.</p> : null}

      {projection.state.status === "missing" || isNotApplicable ? null : unavailable ? (
        projection.state.status === "watch-error" ? (projectionError ? null : (
          <LoadError className="glossary-load-error" message={`${unavailable.title}: ${unavailable.detail}`} onRetry={onRetryProjection} retryBusy={projectionLoading} />
        )) : <div className={`glossary-pane-status ${projection.state.status}`} role={projection.state.status === "invalid" ? "alert" : "status"}>
          <strong>{unavailable.title}</strong>
          {unavailable.detail ? <p>{unavailable.detail}</p> : null}
        </div>
      ) : selectedEntry ? (
        <article className="glossary-entry-detail">
          <BackNavigationButton label="Back To Entries" onBack={onBackToList} />
          <header>
            <h3>{selectedEntry.term}</h3>
            {selectedEntry.aliases.length > 0 ? (
              <p className="glossary-entry-aliases">{selectedEntry.aliases.join(" · ")}</p>
            ) : null}
          </header>
          <p className="glossary-entry-definition">{selectedEntry.definition}</p>
        </article>
      ) : (
        <div className="glossary-list-view">
          <div className="glossary-entry-list" aria-busy={searchLoading}>
            {visibleEntries.map((entry) => (
              <button
                key={entry.term}
                className="glossary-entry-row"
                type="button"
                onClick={() => {
                  savedListScrollTopRef.current = scrollContainerRef?.current?.scrollTop ?? 0;
                  onSelectTerm(entry.term);
                }}
              >
                <span className="glossary-entry-term">{entry.term}</span>
              </button>
            ))}
            {searchLoading && !searchError ? (
              <div className="glossary-search-loading">
                <LoadingIndicator label="Searching" />
              </div>
            ) : null}
            {visibleEntries.length < visibleTotal && !searchLoading && !searchError && !searchStale ? (
              <button className="glossary-load-more" type="button" onClick={onLoadMoreSearchResults}>
                Load More
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
