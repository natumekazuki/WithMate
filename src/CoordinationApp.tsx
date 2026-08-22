import { useCallback, useEffect, useRef, useState } from "react";

import type { HomeSessionSummary } from "./app-state.js";
import type {
  CoordinationEvent,
  CoordinationEventAction,
  CoordinationEventState,
  CoordinationEventSummary,
} from "./coordination-event.js";
import { renderHomeSearchIcon } from "./home/home-icons.js";
import { getWithMateApi } from "./renderer-withmate-api.js";
import { CharacterAvatar } from "./ui-utils.js";

const EVENT_PAGE_LIMIT = 50;
const SESSION_PAGE_LIMIT = 50;

type FeedFilter = "all" | "actionable" | "resolved" | "history";
type LoadState = "loading" | "loaded" | "error";

const FILTERS: Array<{ id: FeedFilter; label: string; state?: CoordinationEventState }> = [
  { id: "all", label: "すべて" },
  { id: "actionable", label: "要対応", state: "open" },
  { id: "resolved", label: "回答済み", state: "resolved" },
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
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CoordinationEvent | null>(null);
  const [detailLoadState, setDetailLoadState] = useState<LoadState>("loaded");
  const [mutationFeedback, setMutationFeedback] = useState("");
  const [mutationPending, setMutationPending] = useState(false);
  const [customAnswer, setCustomAnswer] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionEntries, setSessionEntries] = useState<HomeSessionSummary[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [sessionLoadState, setSessionLoadState] = useState<LoadState>("loaded");
  const eventGeneration = useRef(0);
  const eventAppendGeneration = useRef(0);
  const eventReplacePending = useRef(false);
  const detailGeneration = useRef(0);
  const sessionGeneration = useRef(0);
  const resolutionAttempts = useRef(new Map<string, string>());
  const pickerRef = useRef<HTMLDivElement>(null);
  const sessionLoadSentinelRef = useRef<HTMLDivElement>(null);
  const eventLoadSentinelRef = useRef<HTMLDivElement>(null);

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

  const loadEvents = useCallback(async (
    mode: "replace" | "append" = "replace",
    preserveSelection = false,
  ) => {
    if (!api) {
      setEventLoadState("error");
      return;
    }
    if (mode === "append" && (eventReplacePending.current || !eventCursor)) return;
    const generation = mode === "replace" ? ++eventGeneration.current : eventGeneration.current;
    const appendGeneration = ++eventAppendGeneration.current;
    if (mode === "replace") {
      eventReplacePending.current = true;
      if (!preserveSelection) setEventLoadState("loading");
      setEventCursor(undefined);
      if (!preserveSelection) {
        detailGeneration.current += 1;
        setSelectedEventId(null);
        setSelectedEvent(null);
        setDetailLoadState("loaded");
        setMutationFeedback("");
      }
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
      if (generation !== eventGeneration.current
        || (mode === "append" && appendGeneration !== eventAppendGeneration.current)) return;
      setEvents((current) => mode === "append" ? [...current, ...result.items] : result.items);
      setEventSessions((current) => mode === "append"
        ? { ...current, ...projectedSessions }
        : projectedSessions);
      setEventCursor(result.nextCursor);
      setEventLoadState("loaded");
    } catch {
      if (generation !== eventGeneration.current
        || (mode === "append" && appendGeneration !== eventAppendGeneration.current)) return;
      if (!preserveSelection) setEventLoadState("error");
    } finally {
      if (generation === eventGeneration.current) {
        if (mode === "replace") eventReplacePending.current = false;
        setEventLoadMore(false);
      }
    }
  }, [activeState, api, eventCursor, loadEventSessionSummaries, selectedSession]);

  useEffect(() => {
    void loadEvents("replace");
  }, [filter, selectedSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSessions = useCallback(async (
    mode: "replace" | "append",
    requestedGeneration?: number,
  ) => {
    if (!api) return;
    const generation = requestedGeneration
      ?? (mode === "replace" ? ++sessionGeneration.current : sessionGeneration.current);
    setSessionLoadState("loading");
    if (mode === "replace") setSessionEntries([]);
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

  useEffect(() => {
    const sentinel = sessionLoadSentinelRef.current;
    const scrollRoot = sentinel?.parentElement;
    if (!pickerOpen
      || !sentinel
      || !scrollRoot
      || !sessionHasMore
      || sessionLoadState === "loading"
      || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadSessions("append");
    }, { root: scrollRoot, rootMargin: "0px 0px 72px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadSessions, pickerOpen, sessionHasMore, sessionLoadState]);

  useEffect(() => {
    const sentinel = eventLoadSentinelRef.current;
    const scrollRoot = sentinel?.closest(".coordination-feed");
    if (!sentinel
      || !scrollRoot
      || !eventCursor
      || eventLoadState !== "loaded"
      || eventLoadMore
      || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadEvents("append");
    }, { root: scrollRoot, rootMargin: "0px 0px 120px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [eventCursor, eventLoadMore, eventLoadState, loadEvents]);

  const openDetail = async (eventId: string, preserveCurrent = false) => {
    if (!api) return;
    const generation = ++detailGeneration.current;
    setSelectedEventId(eventId);
    if (!preserveCurrent) {
      setSelectedEvent(null);
      setDetailLoadState("loading");
      setMutationFeedback("");
      setCustomAnswer("");
    }
    try {
      const event = await api.getCoordinationEvent(eventId);
      if (generation !== detailGeneration.current) return;
      setSelectedEvent(event);
      if (!preserveCurrent) setCustomAnswer(latestTrustedResolution(event)?.note ?? "");
      setDetailLoadState("loaded");
    } catch {
      if (generation === detailGeneration.current && !preserveCurrent) setDetailLoadState("error");
    }
  };

  useEffect(() => api?.subscribeCoordinationEventsChanged(() => {
    void loadEvents("replace", true);
    if (selectedEventId) void openDetail(selectedEventId, true);
  }), [api, loadEvents, selectedEventId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyEventUpdate = (event: CoordinationEvent) => {
    setSelectedEvent(event);
    setEvents((current) => {
      if (activeState && event.state !== activeState) {
        return current.filter((item) => item.eventId !== event.eventId);
      }
      return current.map((item) => item.eventId === event.eventId ? {
        ...item,
        kind: event.kind,
        state: event.state,
        summary: event.summary,
      } : item);
    });
  };

  const openEventSession = async () => {
    if (!api || !selectedEvent) return;
    try {
      await api.openSession(selectedEvent.actorSessionId);
    } catch (error) {
      setMutationFeedback(error instanceof Error ? error.message : "Sessionを開けませんでした。");
    }
  };

  const resolveEvent = async (optionId?: string) => {
    if (!api || !selectedEvent) return;
    const note = customAnswer.trim();
    const currentResolution = latestTrustedResolution(selectedEvent);
    if ((optionId && currentResolution?.optionId === optionId)
      || (!optionId && currentResolution?.note === note)) {
      return;
    }
    const answerFingerprint = `${selectedEvent.eventId}:${optionId ? `option:${optionId}` : `note:${note}`}`;
    let idempotencyKey = resolutionAttempts.current.get(answerFingerprint);
    if (!idempotencyKey) {
      idempotencyKey = buildIdempotencyKey("coordination-window-resolve");
      resolutionAttempts.current.set(answerFingerprint, idempotencyKey);
    }
    setMutationFeedback("");
    setMutationPending(true);
    const eventId = selectedEvent.eventId;
    const detailGenerationAtStart = detailGeneration.current;
    const eventGenerationAtStart = eventGeneration.current;
    try {
      const event = await api.resolveCoordinationEvent({
        eventId,
        ...(optionId ? { optionId } : { note }),
        idempotencyKey,
      });
      resolutionAttempts.current.delete(answerFingerprint);
      if (detailGenerationAtStart !== detailGeneration.current
        || eventGenerationAtStart !== eventGeneration.current) return;
      applyEventUpdate(event);
      setCustomAnswer(latestTrustedResolution(event)?.note ?? "");
      setMutationFeedback("");
    } catch (error) {
      if (detailGenerationAtStart !== detailGeneration.current
        || eventGenerationAtStart !== eventGeneration.current) return;
      setMutationFeedback(error instanceof Error ? error.message : "回答を保存できませんでした。");
    } finally {
      setMutationPending(false);
    }
  };

  const cancelEvent = async () => {
    if (!api || !selectedEvent) return;
    if (!window.confirm(`「${selectedEvent.summary}」を取り消します。取り消すと回答できません。`)) return;
    setMutationFeedback("");
    setMutationPending(true);
    const eventId = selectedEvent.eventId;
    const detailGenerationAtStart = detailGeneration.current;
    const eventGenerationAtStart = eventGeneration.current;
    try {
      const event = await api.cancelCoordinationEvent({
        eventId,
        idempotencyKey: buildIdempotencyKey("coordination-window-cancel"),
      });
      if (detailGenerationAtStart !== detailGeneration.current
        || eventGenerationAtStart !== eventGeneration.current) return;
      applyEventUpdate(event);
      setMutationFeedback("");
    } catch (error) {
      if (detailGenerationAtStart !== detailGeneration.current
        || eventGenerationAtStart !== eventGeneration.current) return;
      setMutationFeedback(error instanceof Error ? error.message : "イベントを取り消せませんでした。");
    } finally {
      setMutationPending(false);
    }
  };

  const selectedSessionLabel = selectedSession?.taskTitle ?? "すべてのSession";
  const selectedEventSession = selectedEvent ? eventSessions[selectedEvent.actorSessionId] : undefined;
  const selectedResolution = selectedEvent ? latestTrustedResolution(selectedEvent) : undefined;
  const selectedAnswerLabel = selectedEvent && selectedResolution
    ? resolvedAnswerLabel(selectedEvent, selectedResolution)
    : "";
  const answerIsConsumed = selectedEvent?.actions.some((action) => action.type === "consumed") ?? false;
  const canAnswer = selectedEvent?.kind === "user_decision_required"
    && (selectedEvent.state === "open" || (selectedEvent.state === "resolved" && !answerIsConsumed));
  const filterLabel = FILTERS.find((entry) => entry.id === filter)?.label ?? "すべて";
  return (
    <main className="coordination-page" aria-label="Coordination">
      <div className="coordination-toolbar">
        <div className="coordination-session-filter" ref={pickerRef}>
          <button
            className="coordination-session-trigger"
            type="button"
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            disabled={mutationPending}
            onClick={() => setPickerOpen((open) => !open)}
            title={selectedSessionLabel}
          >
            <span className="coordination-session-trigger-label">{selectedSessionLabel}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {pickerOpen ? (
            <div className="coordination-session-picker" role="dialog" aria-label="Sessionを選択">
              <label className="coordination-search-field">
                <span className="coordination-search-icon" aria-hidden="true">{renderHomeSearchIcon()}</span>
                <input
                  type="search"
                  value={sessionSearch}
                  onChange={(event) => setSessionSearch(event.target.value)}
                  aria-label="Sessionを検索"
                  disabled={mutationPending}
                  autoFocus
                />
              </label>
              <div className="coordination-session-list">
                <button
                  type="button"
                  className={`coordination-session-option ${selectedSession ? "" : "selected"}`.trim()}
                  disabled={mutationPending}
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
                    disabled={mutationPending}
                    onClick={() => { setSelectedSession(session); setPickerOpen(false); }}
                  >
                    <CharacterAvatar
                      character={{ name: session.character, iconPath: session.characterIconPath }}
                      size="tiny"
                    />
                    <span>{session.taskTitle}</span>
                  </button>
                ))}
                {sessionLoadState === "error" ? (
                  <button className="coordination-retry-link" type="button" disabled={mutationPending} onClick={() => void loadSessions("replace")}>再試行</button>
                ) : null}
                {sessionHasMore ? <div ref={sessionLoadSentinelRef} className="coordination-load-sentinel" aria-hidden="true" /> : null}
                {sessionLoadState === "loading" ? <LoadingIndicator label="Sessionを読み込み中" /> : null}
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
              disabled={mutationPending}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <section className="coordination-workspace">
        <section className="coordination-feed" aria-label={`${filterLabel}のCoordination Event`}>
          {eventLoadState === "loading" ? <EventSkeleton /> : null}
          {eventLoadState === "error" ? (
            <div className="coordination-state-panel"><span>イベントを読み込めませんでした。</span><button type="button" disabled={mutationPending} onClick={() => void loadEvents("replace")}>再試行</button></div>
          ) : null}
          {events.map((event) => {
            const session = eventSessions[event.actorSessionId];
            return (
              <button
                key={event.eventId}
                type="button"
                className={`coordination-event-row ${selectedEventId === event.eventId ? "selected" : ""}`.trim()}
                disabled={mutationPending}
                onClick={() => void openDetail(event.eventId)}
              >
                <CharacterAvatar
                  character={{ name: session?.character ?? "?", iconPath: session?.characterIconPath ?? "" }}
                  size="tiny"
                />
                <span className="coordination-event-copy">
                  <strong>{event.summary}</strong>
                  <span className="coordination-session-title">{session?.taskTitle ?? "削除されたSession"}</span>
                  <span className="coordination-event-meta">
                    <span className={`coordination-kind coordination-kind-${event.kind}`}>{KIND_LABELS[event.kind]}</span>
                    <span className={`coordination-state coordination-state-${event.state}`}>{STATE_LABELS[event.state]}</span>
                    <time dateTime={event.createdAt}>{eventTime(event.createdAt)}</time>
                  </span>
                </span>
              </button>
            );
          })}
          {eventCursor ? <div ref={eventLoadSentinelRef} className="coordination-load-sentinel" aria-hidden="true" /> : null}
          {eventLoadMore ? <LoadingIndicator label="イベントを読み込み中" /> : null}
        </section>

        <aside className="coordination-detail" aria-label="イベント詳細">
          {detailLoadState === "loading" ? <EventSkeleton compact /> : null}
          {detailLoadState === "error" ? (
            <div className="coordination-state-panel">
              <span>詳細を読み込めませんでした。</span>
              {selectedEventId ? <button type="button" disabled={mutationPending} onClick={() => void openDetail(selectedEventId)}>再試行</button> : null}
            </div>
          ) : null}
          {detailLoadState === "loaded" && selectedEvent ? (
            <div className="coordination-detail-content">
              <button className="coordination-detail-origin" type="button" onClick={() => void openEventSession()}>
                <CharacterAvatar
                  character={{ name: selectedEventSession?.character ?? "?", iconPath: selectedEventSession?.characterIconPath ?? "" }}
                  size="tiny"
                />
                <span>{selectedEventSession?.taskTitle ?? "削除されたSession"}</span>
              </button>
              <div className="coordination-event-meta">
                <span className={`coordination-kind coordination-kind-${selectedEvent.kind}`}>{KIND_LABELS[selectedEvent.kind]}</span>
                <span className={`coordination-state coordination-state-${selectedEvent.state}`}>{STATE_LABELS[selectedEvent.state]}</span>
                {answerIsConsumed ? <span className="coordination-state coordination-state-consumed">使用済み</span> : null}
              </div>
              <h2>{selectedEvent.summary}</h2>
              {selectedEvent.payload.facts?.length ? <DetailList title="事実" values={selectedEvent.payload.facts} /> : null}
              {selectedEvent.payload.assumptions?.length ? <DetailList title="仮定" values={selectedEvent.payload.assumptions} /> : null}
              {selectedEvent.payload.impact ? <DetailText title="影響" value={selectedEvent.payload.impact} /> : null}
              {selectedEvent.payload.recommendation ? <DetailText title="推奨" value={selectedEvent.payload.recommendation} /> : null}

              {selectedEvent.kind === "user_decision_required" && selectedResolution && !canAnswer ? (
                <DetailText title="回答" value={selectedAnswerLabel} />
              ) : null}
              {canAnswer ? (
                <section className="coordination-decision-panel">
                  <h3>{selectedEvent.state === "resolved" ? "回答を変更" : "回答"}</h3>
                  <div className="coordination-options">
                    {selectedEvent.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={selectedResolution?.optionId === option.id ? "selected" : ""}
                        aria-pressed={selectedResolution?.optionId === option.id}
                        disabled={mutationPending}
                        onClick={() => void resolveEvent(option.id)}
                      >
                        <strong>{option.label}</strong>
                        {option.description ? <span>{option.description}</span> : null}
                      </button>
                    ))}
                  </div>
                  <label className="coordination-custom-answer">
                    <span className="sr-only">自由回答</span>
                    <textarea
                      value={customAnswer}
                      disabled={mutationPending}
                      onChange={(event) => setCustomAnswer(event.target.value)}
                      aria-label="自由回答"
                      rows={4}
                    />
                  </label>
                  <div className="coordination-detail-actions">
                    <button
                      className="coordination-primary-action"
                      type="button"
                      disabled={mutationPending || !customAnswer.trim() || selectedResolution?.note === customAnswer.trim()}
                      onClick={() => void resolveEvent()}
                    >
                      {selectedEvent.state === "resolved" ? "回答を変更" : "送信"}
                    </button>
                    {selectedEvent.state === "open" ? (
                      <button className="coordination-cancel-action" type="button" disabled={mutationPending} onClick={() => void cancelEvent()}>イベントを取り消す</button>
                    ) : null}
                  </div>
                </section>
              ) : null}
              {selectedEvent.state === "open" && !canAnswer ? (
                <div className="coordination-detail-actions">
                  <button className="coordination-primary-action" type="button" onClick={() => void openEventSession()}>Sessionを開く</button>
                  <button className="coordination-cancel-action" type="button" disabled={mutationPending} onClick={() => void cancelEvent()}>イベントを取り消す</button>
                </div>
              ) : null}
              {mutationPending ? <LoadingIndicator label="変更を保存中" /> : null}
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

function latestTrustedResolution(event: CoordinationEvent): CoordinationEventAction | undefined {
  return [...event.actions]
    .reverse()
    .find((action) => action.type === "resolved" && action.actorType === "trusted_gui");
}

function resolvedAnswerLabel(event: CoordinationEvent, resolution: CoordinationEventAction): string {
  if (resolution.optionId) {
    return event.options.find((option) => option.id === resolution.optionId)?.label ?? resolution.optionId;
  }
  return resolution.note ?? "";
}

function EventSkeleton({ compact = false }: { compact?: boolean }) {
  return <div className={`coordination-skeleton ${compact ? "compact" : ""}`.trim()} aria-label="読み込み中"><span /><span /><span /></div>;
}

function LoadingIndicator({ label }: { label: string }) {
  return (
    <div className="coordination-loading-indicator" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
