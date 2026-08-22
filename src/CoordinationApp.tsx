import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HomeSessionSummary } from "./app-state.js";
import type {
  CoordinationEvent,
  CoordinationEventState,
  CoordinationEventSummary,
} from "./coordination-event.js";
import { getWithMateApi } from "./renderer-withmate-api.js";
import { CharacterAvatar } from "./ui-utils.js";

const EVENT_PAGE_LIMIT = 50;
const SESSION_PAGE_LIMIT = 50;

type FeedFilter = "all" | "actionable" | "resolved" | "history";
type LoadState = "loading" | "loaded" | "error";

const FILTERS: Array<{ id: FeedFilter; label: string; state?: CoordinationEventState }> = [
  { id: "actionable", label: "要対応", state: "open" },
  { id: "resolved", label: "回答済み", state: "resolved" },
  { id: "all", label: "すべて" },
  { id: "history", label: "履歴", state: "recorded" },
];

const KIND_LABELS: Record<CoordinationEventSummary["kind"], string> = {
  progress: "進捗",
  decision: "判断",
  escalation: "相談",
  user_decision_required: "判断待ち",
  blocker: "ブロッカー",
  result: "結果",
  correction: "訂正",
};

const STATE_LABELS: Record<CoordinationEventSummary["state"], string> = {
  recorded: "記録済み",
  open: "要対応",
  resolved: "回答済み",
  superseded: "更新済み",
  cancelled: "取消済み",
};

function buildIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function eventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function CoordinationApp() {
  const api = getWithMateApi();
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [selectedSession, setSelectedSession] = useState<HomeSessionSummary | null>(null);
  const [events, setEvents] = useState<CoordinationEventSummary[]>([]);
  const [eventSessions, setEventSessions] = useState<Record<string, HomeSessionSummary>>({});
  const [eventCursor, setEventCursor] = useState<string | undefined>();
  const [eventLoadState, setEventLoadState] = useState<LoadState>("loading");
  const [eventLoadMore, setEventLoadMore] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CoordinationEvent | null>(null);
  const [detailLoadState, setDetailLoadState] = useState<LoadState>("loaded");
  const [mutationFeedback, setMutationFeedback] = useState("");
  const [customAnswer, setCustomAnswer] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionEntries, setSessionEntries] = useState<HomeSessionSummary[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [sessionLoadState, setSessionLoadState] = useState<LoadState>("loaded");
  const eventGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const resolutionAttempts = useRef(new Map<string, string>());
  const pickerRef = useRef<HTMLDivElement>(null);

  const activeState = FILTERS.find((entry) => entry.id === filter)?.state;

  const loadEventSessionSummaries = useCallback(async (
    items: CoordinationEventSummary[],
  ): Promise<Record<string, HomeSessionSummary>> => {
    if (!api || items.length === 0) return {};
    const sessionIds = Array.from(new Set(items.map((item) => item.actorSessionId)));
    const result = await api.listSessionSummaryPage({
      scope: "open",
      sessionIds,
      limit: sessionIds.length,
    });
    return Object.fromEntries(result.entries.map((entry) => [entry.id, entry]));
  }, [api]);

  const loadEvents = useCallback(async (mode: "replace" | "append" = "replace") => {
    if (!api) {
      setEventLoadState("error");
      return;
    }
    const generation = mode === "replace" ? ++eventGeneration.current : eventGeneration.current;
    if (mode === "replace") {
      setEventLoadState("loading");
      setSelectedEvent(null);
      setMutationFeedback("");
    } else {
      setEventLoadMore(true);
    }
    try {
      const result = await api.listCoordinationEvents({
        limit: EVENT_PAGE_LIMIT,
        ...(selectedSession ? { sessionId: selectedSession.id } : {}),
        ...(activeState ? { state: activeState } : {}),
        ...(mode === "append" && eventCursor ? { cursor: eventCursor } : {}),
      });
      const projectedSessions = await loadEventSessionSummaries(result.items);
      if (generation !== eventGeneration.current) return;
      setEvents((current) => mode === "append" ? [...current, ...result.items] : result.items);
      setEventSessions((current) => mode === "append"
        ? { ...current, ...projectedSessions }
        : projectedSessions);
      setEventCursor(result.nextCursor);
      setEventLoadState("loaded");
    } catch {
      if (generation !== eventGeneration.current) return;
      setEventLoadState("error");
    } finally {
      if (generation === eventGeneration.current) setEventLoadMore(false);
    }
  }, [activeState, api, eventCursor, loadEventSessionSummaries, selectedSession]);

  useEffect(() => {
    void loadEvents("replace");
  }, [filter, selectedSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => api?.subscribeCoordinationEventsChanged(() => {
    void loadEvents("replace");
  }), [api, loadEvents]);

  const loadSessions = useCallback(async (
    mode: "replace" | "append",
    requestedGeneration?: number,
  ) => {
    if (!api) return;
    const generation = requestedGeneration
      ?? (mode === "replace" ? ++sessionGeneration.current : sessionGeneration.current);
    setSessionLoadState("loading");
    try {
      const result = await api.listSessionSummaryPage({
        scope: "recent",
        searchText: sessionSearch,
        limit: SESSION_PAGE_LIMIT,
        ...(mode === "append" && sessionCursor ? { cursor: sessionCursor } : {}),
      });
      if (generation !== sessionGeneration.current) return;
      setSessionEntries((current) => mode === "append" ? [...current, ...result.entries] : result.entries);
      setSessionCursor(result.nextCursor);
      setSessionHasMore(result.hasMore);
      setSessionLoadState("loaded");
    } catch {
      if (generation === sessionGeneration.current) setSessionLoadState("error");
    }
  }, [api, sessionCursor, sessionSearch]);

  useEffect(() => {
    if (!pickerOpen) return;
    const generation = ++sessionGeneration.current;
    const timer = window.setTimeout(() => void loadSessions("replace", generation), 160);
    return () => window.clearTimeout(timer);
  }, [pickerOpen, sessionSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  const openDetail = async (eventId: string) => {
    if (!api) return;
    const generation = ++detailGeneration.current;
    setDetailLoadState("loading");
    setMutationFeedback("");
    setCustomAnswer("");
    try {
      const event = await api.getCoordinationEvent(eventId);
      if (generation !== detailGeneration.current) return;
      setSelectedEvent(event);
      setDetailLoadState("loaded");
    } catch {
      if (generation === detailGeneration.current) setDetailLoadState("error");
    }
  };

  const resolveEvent = async (optionId?: string) => {
    if (!api || !selectedEvent) return;
    const note = customAnswer.trim();
    const answerFingerprint = `${selectedEvent.eventId}:${optionId ? `option:${optionId}` : `note:${note}`}`;
    let idempotencyKey = resolutionAttempts.current.get(answerFingerprint);
    if (!idempotencyKey) {
      idempotencyKey = buildIdempotencyKey("coordination-window-resolve");
      resolutionAttempts.current.set(answerFingerprint, idempotencyKey);
    }
    setMutationFeedback("保存中…");
    try {
      const event = await api.resolveCoordinationEvent({
        eventId: selectedEvent.eventId,
        ...(optionId ? { optionId } : { note }),
        idempotencyKey,
      });
      resolutionAttempts.current.delete(answerFingerprint);
      setSelectedEvent(event);
      setCustomAnswer("");
      setMutationFeedback("回答を保存しました。");
      void loadEvents("replace");
    } catch (error) {
      setMutationFeedback(error instanceof Error ? error.message : "回答を保存できませんでした。");
    }
  };

  const cancelEvent = async () => {
    if (!api || !selectedEvent) return;
    setMutationFeedback("取消中…");
    try {
      const event = await api.cancelCoordinationEvent({
        eventId: selectedEvent.eventId,
        idempotencyKey: buildIdempotencyKey("coordination-window-cancel"),
      });
      setSelectedEvent(event);
      setMutationFeedback("イベントを取り消しました。");
      void loadEvents("replace");
    } catch (error) {
      setMutationFeedback(error instanceof Error ? error.message : "イベントを取り消せませんでした。");
    }
  };

  const selectedSessionLabel = selectedSession?.taskTitle ?? "すべてのSession";
  const selectedEventSession = selectedEvent ? eventSessions[selectedEvent.actorSessionId] : undefined;
  const filterLabel = FILTERS.find((entry) => entry.id === filter)?.label ?? "すべて";
  const emptyMessage = useMemo(() => selectedSession
    ? `「${selectedSession.taskTitle}」に該当するイベントはありません。`
    : "該当するイベントはありません。", [selectedSession]);

  return (
    <main className="coordination-page">
      <header className="coordination-header">
        <div>
          <p className="coordination-eyebrow">Coordination</p>
          <h1>判断と進行状況</h1>
        </div>
        <button className="coordination-home-button" type="button" onClick={() => void api?.openHomeWindow()}>Home</button>
      </header>

      <div className="coordination-toolbar">
        <div className="coordination-session-filter" ref={pickerRef}>
          <button
            className="coordination-session-trigger"
            type="button"
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            onClick={() => setPickerOpen((open) => !open)}
            title={selectedSessionLabel}
          >
            <span className="coordination-session-trigger-label">{selectedSessionLabel}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {pickerOpen ? (
            <div className="coordination-session-picker" role="dialog" aria-label="Sessionを選択">
              <label className="coordination-search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  value={sessionSearch}
                  onChange={(event) => setSessionSearch(event.target.value)}
                  placeholder="Sessionを検索"
                  aria-label="Sessionを検索"
                  autoFocus
                />
              </label>
              <div className="coordination-session-list">
                <button
                  type="button"
                  className={`coordination-session-option ${selectedSession ? "" : "selected"}`.trim()}
                  onClick={() => { setSelectedSession(null); setPickerOpen(false); }}
                >
                  <span className="coordination-all-sessions-icon" aria-hidden="true">☷</span>
                  <span>すべてのSession</span>
                </button>
                {sessionEntries.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    className={`coordination-session-option ${selectedSession?.id === session.id ? "selected" : ""}`.trim()}
                    onClick={() => { setSelectedSession(session); setPickerOpen(false); }}
                  >
                    <CharacterAvatar
                      character={{ name: session.character, iconPath: session.characterIconPath }}
                      size="tiny"
                    />
                    <span>{session.taskTitle}</span>
                  </button>
                ))}
                {sessionLoadState === "loading" ? <div className="coordination-inline-state">読み込み中…</div> : null}
                {sessionLoadState === "error" ? (
                  <button className="coordination-retry-link" type="button" onClick={() => void loadSessions("replace")}>再試行</button>
                ) : null}
                {sessionHasMore && sessionLoadState !== "loading" ? (
                  <button className="coordination-more-link" type="button" onClick={() => void loadSessions("append")}>さらに表示</button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="coordination-filter-tabs" role="tablist" aria-label="表示するイベント">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={filter === entry.id}
              className={filter === entry.id ? "active" : ""}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <section className="coordination-workspace">
        <section className="coordination-feed" aria-label={`${filterLabel}のCoordination Event`}>
          <div className="coordination-feed-heading">
            <strong>{filterLabel}</strong>
            <span>{events.length}件{eventCursor ? "+" : ""}</span>
          </div>
          {eventLoadState === "loading" ? <EventSkeleton /> : null}
          {eventLoadState === "error" ? (
            <div className="coordination-state-panel"><span>イベントを読み込めませんでした。</span><button type="button" onClick={() => void loadEvents("replace")}>再試行</button></div>
          ) : null}
          {eventLoadState === "loaded" && events.length === 0 ? <div className="coordination-empty">{emptyMessage}</div> : null}
          {events.map((event) => {
            const session = eventSessions[event.actorSessionId];
            return (
              <button
                key={event.eventId}
                type="button"
                className={`coordination-event-row ${selectedEvent?.eventId === event.eventId ? "selected" : ""}`.trim()}
                onClick={() => void openDetail(event.eventId)}
              >
                <CharacterAvatar
                  character={{ name: session?.character ?? "?", iconPath: session?.characterIconPath ?? "" }}
                  size="small"
                />
                <span className="coordination-event-copy">
                  <span className="coordination-event-meta">
                    <span className={`coordination-kind coordination-kind-${event.kind}`}>{KIND_LABELS[event.kind]}</span>
                    <span className={`coordination-state coordination-state-${event.state}`}>{STATE_LABELS[event.state]}</span>
                    <time dateTime={event.createdAt}>{eventTime(event.createdAt)}</time>
                  </span>
                  <strong>{event.summary}</strong>
                  <span className="coordination-session-title">{session?.taskTitle ?? "削除されたSession"}</span>
                </span>
              </button>
            );
          })}
          {eventCursor ? (
            <button className="coordination-load-more" type="button" disabled={eventLoadMore} onClick={() => void loadEvents("append")}>
              {eventLoadMore ? "読み込み中…" : "さらに表示"}
            </button>
          ) : null}
        </section>

        <aside className="coordination-detail" aria-label="イベント詳細">
          {detailLoadState === "loading" ? <EventSkeleton compact /> : null}
          {detailLoadState === "error" ? <div className="coordination-empty">詳細を読み込めませんでした。</div> : null}
          {detailLoadState === "loaded" && !selectedEvent ? <div className="coordination-empty">イベントを選択してください。</div> : null}
          {detailLoadState === "loaded" && selectedEvent ? (
            <div className="coordination-detail-content">
              <div className="coordination-detail-origin">
                <CharacterAvatar
                  character={{ name: selectedEventSession?.character ?? "?", iconPath: selectedEventSession?.characterIconPath ?? "" }}
                  size="small"
                />
                <button type="button" onClick={() => {
                  if (selectedEventSession) setSelectedSession(selectedEventSession);
                }}>{selectedEventSession?.taskTitle ?? "削除されたSession"}</button>
              </div>
              <div className="coordination-event-meta">
                <span className={`coordination-kind coordination-kind-${selectedEvent.kind}`}>{KIND_LABELS[selectedEvent.kind]}</span>
                <span className={`coordination-state coordination-state-${selectedEvent.state}`}>{STATE_LABELS[selectedEvent.state]}</span>
              </div>
              <h2>{selectedEvent.summary}</h2>
              {selectedEvent.payload.facts?.length ? <DetailList title="事実" values={selectedEvent.payload.facts} /> : null}
              {selectedEvent.payload.assumptions?.length ? <DetailList title="仮定" values={selectedEvent.payload.assumptions} /> : null}
              {selectedEvent.payload.impact ? <DetailText title="影響" value={selectedEvent.payload.impact} /> : null}
              {selectedEvent.payload.recommendation ? <DetailText title="推奨" value={selectedEvent.payload.recommendation} /> : null}

              {selectedEvent.kind === "user_decision_required" && selectedEvent.state === "open" ? (
                <section className="coordination-decision-panel">
                  <h3>回答</h3>
                  <div className="coordination-options">
                    {selectedEvent.options.map((option) => (
                      <button key={option.id} type="button" onClick={() => void resolveEvent(option.id)}>
                        <strong>{option.label}</strong>
                        {option.description ? <span>{option.description}</span> : null}
                      </button>
                    ))}
                  </div>
                  <label className="coordination-custom-answer">
                    <span>別の回答</span>
                    <textarea value={customAnswer} onChange={(event) => setCustomAnswer(event.target.value)} rows={4} />
                  </label>
                  <button className="coordination-primary-action" type="button" disabled={!customAnswer.trim()} onClick={() => void resolveEvent()}>
                    自由回答を送る
                  </button>
                </section>
              ) : null}
              {selectedEvent.state === "open" ? (
                <button className="coordination-cancel-action" type="button" onClick={() => void cancelEvent()}>イベントを取り消す</button>
              ) : null}
              {mutationFeedback ? <p className="coordination-feedback" role="status">{mutationFeedback}</p> : null}
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}

function DetailList({ title, values }: { title: string; values: string[] }) {
  return <section className="coordination-detail-section"><h3>{title}</h3><ul>{values.map((value) => <li key={value}>{value}</li>)}</ul></section>;
}

function DetailText({ title, value }: { title: string; value: string }) {
  return <section className="coordination-detail-section"><h3>{title}</h3><p>{value}</p></section>;
}

function EventSkeleton({ compact = false }: { compact?: boolean }) {
  return <div className={`coordination-skeleton ${compact ? "compact" : ""}`.trim()} aria-label="読み込み中"><span /><span /><span /></div>;
}
