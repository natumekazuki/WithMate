import { useLayoutEffect, useMemo, useRef } from "react";

import type {
  GlossaryEntry,
  SessionGlossaryProjection,
} from "../glossary-contract.js";

export type SessionGlossaryPaneProps = {
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

function stateMessage(projection: SessionGlossaryProjection): { title: string; detail: string } | null {
  switch (projection.state.status) {
    case "missing":
      return {
        title: "用語集ファイルがありません",
        detail: ".withmate/glossary.yaml が作成されると、ここへ用語が表示されます。",
      };
    case "invalid":
      return {
        title: "用語集を読み込めません",
        detail: projection.state.issues[0]?.message ?? "glossary.yaml の内容を確認してください。",
      };
    case "unsupported":
      return {
        title: "未対応のschemaです",
        detail: `schemaVersion ${String(projection.state.schemaVersion ?? "unknown")} はこのWithMateで開けません。`,
      };
    case "watch-error":
      return {
        title: "用語集の更新を確認できません",
        detail: projection.state.message,
      };
    case "valid":
      return null;
  }
}

export function SessionGlossaryPane({
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
  const listRef = useRef<HTMLDivElement | null>(null);
  const savedListScrollTopRef = useRef(0);
  const entries = projection?.state.status === "valid" ? projection.state.entries : [];
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.term === selectedTerm) ?? null,
    [entries, selectedTerm],
  );
  const visibleEntries = searchQuery.trim() ? searchEntries : entries;
  const visibleTotal = searchQuery.trim() ? searchTotal : entries.length;

  useLayoutEffect(() => {
    if (!selectedEntry && listRef.current) {
      listRef.current.scrollTop = savedListScrollTopRef.current;
    }
  }, [selectedEntry]);

  if (!projection) {
    return <p className="glossary-pane-status">用語集を読み込んでいます…</p>;
  }

  const unavailable = stateMessage(projection);
  return (
    <section className="glossary-pane" aria-label="Repository Glossary">
      <header className="glossary-pane-checkout">
        <strong>{projection.checkout.repositoryName}</strong>
        <span>{projection.checkout.branch}</span>
        <small>{projection.checkout.pathLabel}</small>
      </header>

      {unavailable ? (
        <div className={`glossary-pane-status ${projection.state.status}`} role={projection.state.status === "invalid" ? "alert" : undefined}>
          <strong>{unavailable.title}</strong>
          <p>{unavailable.detail}</p>
        </div>
      ) : selectedEntry ? (
        <article className="glossary-entry-detail">
          <button className="glossary-back-button" type="button" onClick={onBackToList}>
            ← 一覧へ戻る
          </button>
          <header>
            <h3>{selectedEntry.term}</h3>
            {selectedEntry.aliases.length > 0 ? (
              <p className="glossary-entry-aliases">Aliases: {selectedEntry.aliases.join(", ")}</p>
            ) : null}
          </header>
          <p className="glossary-entry-definition">{selectedEntry.definition}</p>
        </article>
      ) : (
        <div className="glossary-list-view">
          <label className="glossary-search-field">
            <span className="sr-only">用語集を検索</span>
            <input
              type="search"
              value={searchQuery}
              placeholder="用語、alias、説明を検索"
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
          </label>

          {searchError ? <p className="glossary-search-error" role="alert">{searchError}</p> : null}
          <div ref={listRef} className="glossary-entry-list" aria-busy={searchLoading}>
            {visibleEntries.map((entry) => (
              <button
                key={entry.term}
                className="glossary-entry-row"
                type="button"
                onClick={() => {
                  savedListScrollTopRef.current = listRef.current?.scrollTop ?? 0;
                  onSelectTerm(entry.term);
                }}
              >
                <strong>{entry.term}</strong>
                {entry.aliases.length > 0 ? <span>{entry.aliases.join(", ")}</span> : null}
              </button>
            ))}
            {!searchLoading && visibleEntries.length === 0 ? (
              <p className="glossary-pane-status">一致する用語はありません。</p>
            ) : null}
            {searchLoading ? <p className="glossary-pane-status">検索しています…</p> : null}
            {visibleEntries.length < visibleTotal && !searchLoading ? (
              <button className="glossary-load-more" type="button" onClick={onLoadMoreSearchResults}>
                さらに読み込む
              </button>
            ) : null}
          </div>
          <p className="glossary-list-count">{visibleEntries.length} / {visibleTotal} terms</p>
        </div>
      )}
    </section>
  );
}
