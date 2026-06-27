import { useEffect, useMemo, useState } from "react";

import type { MemoryEntryKind, MemoryForgetReason } from "./memory-contract.js";
import type {
  MemoryV6ReviewApi,
  MemoryV6ReviewEntryDetail,
  MemoryV6ReviewSearchHit,
} from "./memory-review-state.js";

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

export function MemoryV6ReviewScreen({ homePageClassName, getApi }: MemoryV6ReviewScreenProps) {
  const [query, setQuery] = useState("");
  const [selectedKind, setSelectedKind] = useState<MemoryEntryKind | "">("");
  const [items, setItems] = useState<MemoryV6ReviewSearchHit[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<MemoryV6ReviewEntryDetail | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState("");
  const [forgetReason, setForgetReason] = useState<MemoryForgetReason>("user_request");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const searchRequest = useMemo(() => ({
    query,
    ...(selectedKind ? { kinds: [selectedKind] } : {}),
    limit: 50,
  }), [query, selectedKind]);

  const runSearch = async () => {
    const api = getApi();
    if (!api) {
      setFeedback("Memory Review には desktop runtime が必要です。");
      return;
    }
    setLoading(true);
    try {
      const result = await api.searchMemoryV6Entries(searchRequest);
      setItems(result.items);
      setFeedback(result.items.length === 0 ? "一致する active Memory はありません。" : "");
      if (selectedEntryId && !result.items.some((item) => item.id === selectedEntryId)) {
        setSelectedEntry(null);
        setSelectedEntryId("");
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory の検索に失敗しました。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void runSearch();
  }, [searchRequest]);

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
    const privacyNote = forgetReason === "privacy"
      ? "\n\nprivacy reason では title、body、preview、tags も削除されます。"
      : "";
    if (!window.confirm(`Memory entry「${selectedEntry.title || selectedEntry.id}」を forget しますか？\n\nreason: ${forgetReason}${privacyNote}`)) {
      return;
    }
    setForgetting(true);
    try {
      const result = await api.forgetMemoryV6Entry(selectedEntryId, forgetReason);
      setFeedback(`Forget result: ${result.status}`);
      setSelectedEntry(null);
      setSelectedEntryId("");
      await runSearch();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Memory entry の forget に失敗しました。");
    } finally {
      setForgetting(false);
    }
  };

  return (
    <div className={`${homePageClassName} home-page-memory-review`.trim()}>
      <main className="home-layout home-layout-settings-window memory-review-layout">
        <section className="panel memory-review-shell">
          <header className="memory-review-header">
            <div>
              <h1>Memory Review</h1>
              <p>V6 Memory の active entry を確認し、不要な entry を検索対象から外す。</p>
            </div>
            <button className="launch-toggle" type="button" onClick={() => void runSearch()} disabled={loading}>
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
                    <button className="launch-toggle danger-button" type="button" onClick={() => void forgetSelectedEntry()} disabled={forgetting}>
                      {forgetting ? "Forgetting" : "Forget Entry"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="settings-note">左の一覧から entry を選択すると full body を確認できます。</p>
              )}
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
