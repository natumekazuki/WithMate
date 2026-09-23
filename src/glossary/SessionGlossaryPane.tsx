import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import type {
  GlossaryEntry,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";

export type SessionGlossaryPaneProps = {
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  projection: SessionGlossaryProjection | null;
  searchQuery: string;
  searchEntries: readonly GlossaryEntry[];
  searchTotal: number;
  searchLoading: boolean;
  searchError: string;
  selectedTerm: string | null;
  onSearchQueryChange: (query: string) => void;
  onLoadMoreSearchResults: () => void;
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
  searchQuery,
  searchEntries,
  searchTotal,
  searchLoading,
  searchError,
  selectedTerm,
  onSearchQueryChange,
  onLoadMoreSearchResults,
  onSelectTerm,
  onBackToList,
}: SessionGlossaryPaneProps) {
  const savedListScrollTopRef = useRef(0);
  const entries = projection?.state.status === "valid" ? projection.state.entries : [];
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.term === selectedTerm) ?? null,
    [entries, selectedTerm],
  );
  const visibleEntries = searchQuery.trim() ? searchEntries : entries;
  const visibleTotal = searchQuery.trim() ? searchTotal : entries.length;

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
    return (
      <div className="glossary-pane-loading" role="status" aria-label="Loading glossary">
        <span className="glossary-pane-spinner" aria-hidden="true" />
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
                  type="search"
                  value={searchQuery}
                  onChange={(event) => onSearchQueryChange(event.target.value)}
                />
              </label>
              {searchError ? <p className="glossary-search-error" role="alert">{searchError}</p> : null}
            </>
          ) : null}
        </div>
      )}

      {projection.state.status === "missing" || isNotApplicable ? null : unavailable ? (
        <div className={`glossary-pane-status ${projection.state.status}`} role={projection.state.status === "invalid" ? "alert" : "status"}>
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
            {searchLoading ? (
              <div className="glossary-search-loading" role="status" aria-label="Searching">
                <span className="glossary-pane-spinner" aria-hidden="true" />
              </div>
            ) : null}
            {visibleEntries.length < visibleTotal && !searchLoading ? (
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
