import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";

import type {
  GlossaryEntry,
  SessionGlossaryProjection,
} from "../../src-shared/glossary/glossary-contract.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { CloseButton } from "../ui/close-button.js";

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

function stateMessage(projection: SessionGlossaryProjection): { title: string; detail?: string; guidance?: string } | null {
  switch (projection.state.status) {
    case "missing":
      return null;
    case "invalid":
      return {
        title: "Could not load the glossary",
        detail: projection.state.issues[0]?.message ?? "Check the glossary.yaml file contents.",
        guidance: "Fix .withmate/glossary.yaml to load the glossary.",
      };
    case "unsupported":
      return {
        title: "Unsupported format",
        detail: `schemaVersion ${String(projection.state.schemaVersion ?? "unknown")}`,
        guidance: "Use a supported schemaVersion in .withmate/glossary.yaml.",
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

function GlossaryFailure({ label, detail, guidance, onRetry, busy = false }: {
  label: string;
  detail: string;
  guidance?: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const detailsId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const [expanded, setExpanded] = useState(false);
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const above = rect.top - 20;
    const below = window.innerHeight - rect.bottom - 20;
    setPosition({
      width,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      maxHeight: Math.min(280, Math.max(above, below)),
      ...(above > below
        ? { bottom: window.innerHeight - rect.top + 8, top: "auto" }
        : { top: rect.bottom + 8, bottom: "auto" }),
    });
  }, []);
  useLayoutEffect(() => {
    const dismiss = () => popoverRef.current?.hidePopover();
    const onScroll = (event: Event) => {
      const popup = popoverRef.current;
      if (popup?.matches(":popover-open") && !popup.contains(event.target as Node)) updatePosition();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [updatePosition]);
  return (
    <div className="glossary-error" role="group" aria-label={label}>
      <span className="sr-only" role="alert">{label}</span>
      <div className="glossary-error-actions">
        <button
          ref={anchorRef}
          className="artifact-toggle artifact-toggle-icon glossary-error-details"
          type="button"
          aria-label={`${label}: Details`}
          title={`${label}: Details`}
          popoverTarget={detailsId}
          aria-haspopup="dialog"
          aria-controls={detailsId}
          aria-expanded={expanded}
          onClick={updatePosition}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M12 3 2 21h20L12 3Z" />
            <path d="M12 9v5m0 3v.1" />
          </svg>
        </button>
        {onRetry ? (
          <button
            className="artifact-toggle artifact-toggle-icon"
            type="button"
            title="Retry"
            aria-label="Retry"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onRetry}
          >
            <ButtonContent busy={busy} busyLabel="Retrying">
              <span aria-hidden="true">↻</span>
            </ButtonContent>
          </button>
        ) : null}
      </div>
      {guidance ? <p className="glossary-error-guidance">{guidance}</p> : null}
      <div id={detailsId} ref={popoverRef} popover="auto" className="glossary-error-popover" role="dialog" aria-label={`${label}: Details`} style={position}
        onToggle={(event) => setExpanded(event.currentTarget.matches(":popover-open"))}>
        <CloseButton ariaLabel="Close Error Details" onClose={() => popoverRef.current?.hidePopover()} />
        <p className="glossary-error-detail">{detail}</p>
      </div>
    </div>
  );
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
          <GlossaryFailure label="Glossary Load Failed" detail={projectionError} onRetry={() => retry(onRetryProjection)} busy={projectionLoading} />
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
                  <GlossaryFailure label="Glossary Search Failed" detail={searchError} onRetry={() => retry(onRetrySearch)} busy={searchLoading} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {projectionError ? <GlossaryFailure label="Glossary Refresh Failed" detail={projectionError} onRetry={onRetryProjection} busy={projectionLoading} /> : null}
      {searchStale ? <p className="glossary-search-stale" role="status">Showing previous search results.</p> : null}

      {projection.state.status === "missing" || isNotApplicable ? null : unavailable ? (
        projection.state.status === "watch-error" && projectionError ? null : (
          <GlossaryFailure
            label={unavailable.title}
            detail={unavailable.detail ?? unavailable.title}
            guidance={unavailable.guidance}
            onRetry={projection.state.status === "watch-error" ? onRetryProjection : undefined}
            busy={projectionLoading}
          />
        )
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
