import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  SessionGraphIdentity,
  SessionGraphReadResult,
  SessionGraphRecord,
  SessionGraphTopic,
} from "../../src-shared/session-graph/session-graph-contract.js";
import { CloseButton } from "../ui/close-button.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { layoutSessionGraph, sessionGraphEdgePath } from "./graph-layout.js";

const PAGE_SIZE = 40;
function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
function mergeViews(
  current: SessionGraphReadResult,
  next: SessionGraphReadResult,
): SessionGraphReadResult {
  return {
    ...next,
    items: [...current.items, ...next.items],
    relations: [
      ...new Map(
        [...current.relations, ...next.relations].map((edge) => [
          edge.id,
          edge,
        ]),
      ).values(),
    ],
    externalEndpoints: [
      ...new Map(
        [...current.externalEndpoints, ...next.externalEndpoints].map(
          (node) => [node.id, node],
        ),
      ).values(),
    ],
  };
}
export function sessionGraphStatuses(record: SessionGraphRecord): string[] {
  return [
    record.adoption,
    record.progress,
    record.result,
    record.resolution === "open" ? "unresolved" : record.resolution,
    record.validity,
  ].filter((value): value is string => value !== undefined);
}
function Identity({
  identity,
  name,
  focusable = true,
}: {
  identity?: SessionGraphIdentity;
  name?: string;
  focusable?: boolean;
}) {
  const text = identity
    ? `${identity.character?.name ?? identity.sessionTitle} · ${label(identity.role)} · ${identity.sessionTitle}`
    : (name ?? "Unknown Actor");
  return (
    <span
      className="session-graph-identity"
      role="img"
      tabIndex={focusable ? 0 : undefined}
      aria-label={text}
    >
      <CharacterAvatar
        character={{
          name: identity?.character?.name ?? name ?? "?",
          iconPath: identity?.character?.icon ?? "",
        }}
        size="tiny"
      />
      <span className="session-graph-identity-tooltip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export function SessionGraphPreview({
  api,
  sessionId,
  onClose,
  onOpenPath,
}: {
  api: Pick<WithMateWindowApi, "readSessionGraph" | "subscribeSessionGraph">;
  sessionId: string;
  onClose(): void;
  onOpenPath(target: string): void;
}) {
  const [topics, setTopics] = useState<SessionGraphTopic[]>([]);
  const [topicsMore, setTopicsMore] = useState(false);
  const [topicId, setTopicId] = useState("");
  const [view, setView] = useState<SessionGraphReadResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] =
    useState<SessionGraphRecord | null>(null);
  const [detailView, setDetailView] = useState<SessionGraphReadResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [tooltipsDismissed, setTooltipsDismissed] = useState(false);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const topicsRevision = useRef<number | undefined>(undefined);
  const topicRef = useRef(topicId);
  topicRef.current = topicId;
  const markerId = useId().replaceAll(":", "");
  const load = useCallback(
    async (more = false, moreTopics = false) => {
      const revision = ++request.current;
      setLoading(true);
      setError("");
      try {
        const topicPage = await api.readSessionGraph(sessionId, "list_topics", {
          limit: 200,
          offset: moreTopics ? topics.length : 0,
          expectedRevision: moreTopics ? topicsRevision.current : undefined,
        });
        if (request.current !== revision) return;
        if (topicPage.status !== "ok")
          throw new Error(
            "The graph changed. Retry to load its current state.",
          );
        topicsRevision.current = topicPage.revision;
        setTopics((current) => [
          ...new Map(
            [...current, ...topicPage.items].map((topic) => [topic.id, topic]),
          ).values(),
        ]);
        setTopicsMore(
          moreTopics
            ? topicPage.hasMore
            : topicPage.total > Math.max(topics.length, topicPage.items.length),
        );
        if (moreTopics) return;
        const nextTopic = topicRef.current || topicPage.items[0]?.id;
        if (!nextTopic) {
          setView(null);
          return;
        }
        if (!topicRef.current) setTopicId(nextTopic);
        let result = await api.readSessionGraph(sessionId, "get_topic_view", {
          topicId: nextTopic,
          limit: more
            ? PAGE_SIZE
            : Math.max(PAGE_SIZE, Math.min(200, view?.items.length ?? 0)),
          offset: more ? (view?.items.length ?? 0) : 0,
          expectedRevision: more ? view?.revision : undefined,
        });
        if (request.current !== revision) return;
        if (result.status !== "ok")
          throw new Error(
            "The graph changed. Retry before loading more records.",
          );
        let combined = more && view ? mergeViews(view, result) : result;
        // Revalidate every already visible page at one revision; retain the old view
        // if a concurrent write prevents a consistent refresh.
        while (
          !more &&
          combined.hasMore &&
          combined.items.length < (view?.items.length ?? 0)
        ) {
          result = await api.readSessionGraph(sessionId, "get_topic_view", {
            topicId: nextTopic,
            limit: 200,
            offset: combined.items.length,
            expectedRevision: combined.revision,
          });
          if (request.current !== revision) return;
          if (result.status !== "ok")
            throw new Error(
              "The graph changed. Retry to refresh its current state.",
            );
          if (!result.items.length) break;
          combined = mergeViews(combined, result);
        }
        setView(combined);
      } catch (cause) {
        if (request.current === revision)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request.current === revision) setLoading(false);
      }
    },
    [api, sessionId, topics.length, view],
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    return () => {
      request.current += 1;
    };
  }, [sessionId, topicId, refresh]);
  useEffect(
    () =>
      api.subscribeSessionGraph((ownerId) => {
        if (ownerId === sessionId) setRefresh((value) => value + 1);
      }),
    [api, sessionId],
  );
  const selectRecord = useCallback(
    async (id: string) => {
      const revision = ++detailRequest.current;
      setDetailLoading(true);
      setDetailError("");
      try {
        const result = await api.readSessionGraph(sessionId, "get", {
          ids: [id],
        });
        if (detailRequest.current !== revision) return;
        if (result.status !== "ok" || !result.items[0])
          throw new Error("This record is no longer available.");
        const record = result.items[0];
        setSelectedRecord(record);
        setDetailView(result);
        if (record.topicId !== topicRef.current) {
          setView(null);
          setTopicId(record.topicId);
        }
      } catch (cause) {
        if (detailRequest.current === revision)
          setDetailError(
            cause instanceof Error ? cause.message : String(cause),
          );
      } finally {
        if (detailRequest.current === revision) setDetailLoading(false);
      }
    },
    [api, sessionId],
  );
  useEffect(() => {
    if (selectedId) void selectRecord(selectedId);
    return () => {
      detailRequest.current += 1;
    };
  }, [refresh, selectedId, selectRecord]);
  const records = useMemo(() => {
    const items = view?.items ?? [];
    return selectedRecord?.topicId === topicId &&
      !items.some((item) => item.id === selectedRecord.id)
      ? [...items, selectedRecord]
      : items;
  }, [view, selectedRecord, topicId]);
  const relations = useMemo(
    () => [
      ...new Map(
        [...(view?.relations ?? []), ...(detailView?.relations ?? [])].map(
          (edge) => [edge.id, edge],
        ),
      ).values(),
    ],
    [view, detailView],
  );
  const endpoints = useMemo(
    () =>
      new Map(
        [
          ...records,
          ...(view?.externalEndpoints ?? []),
          ...(detailView?.externalEndpoints ?? []),
        ].map((record) => [record.id, record]),
      ),
    [records, view, detailView],
  );
  const related = relations.filter(
    (edge) => edge.fromId === selectedId || edge.toId === selectedId,
  );
  const focalRecords = useMemo(() => {
    if (!selectedId) return records;
    const ids = new Set([selectedId]);
    for (const edge of relations) {
      if (edge.fromId === selectedId || edge.toId === selectedId) {
        ids.add(edge.fromId);
        ids.add(edge.toId);
      }
    }
    return records.filter((record) => ids.has(record.id));
  }, [records, relations, selectedId]);
  const layout = useMemo(
    () => layoutSessionGraph(focalRecords, relations),
    [focalRecords, relations],
  );
  const clearSelection = () => {
    detailRequest.current += 1;
    setSelectedId(null);
    setSelectedRecord(null);
    setDetailView(null);
    setDetailError("");
    setDetailLoading(false);
  };
  return (
    <section
      className={`session-graph-preview${tooltipsDismissed ? " tooltips-dismissed" : ""}`}
      aria-label="Session Graph"
      onKeyDown={(event) => {
        if (event.key === "Escape") setTooltipsDismissed(true);
      }}
      onFocusCapture={() => setTooltipsDismissed(false)}
      onPointerOver={() => setTooltipsDismissed(false)}
    >
      <header className="session-graph-toolbar">
        <strong>Session Graph</strong>
        {topics.length ? (
          <select
            aria-label="Graph Topic"
            value={topicId}
            onChange={(event) => {
              clearSelection();
              setView(null);
              setTopicId(event.target.value);
            }}
          >
            {topics.map((topic) => (
              <option key={topic.id} value={topic.id}>
                {topic.title}
              </option>
            ))}
            {!topics.some((topic) => topic.id === topicId) && topicId ? (
              <option value={topicId}>
                {selectedRecord?.title ?? "Selected Topic"}
              </option>
            ) : null}
          </select>
        ) : null}
        {topicsMore ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(false, true)}
          >
            More Topics
          </button>
        ) : null}
        <CloseButton ariaLabel="Close Session Graph" onClose={onClose} />
      </header>
      <div className="session-graph-load-status" aria-busy={loading}>
        {loading ? (
          <LoadingIndicator label="Loading Session Graph" inline />
        ) : null}
        {error ? (
          <span role="alert">
            {error}{" "}
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </span>
        ) : null}
        {!loading && !error && ((!view && topics.length === 0) || view?.total === 0) ? (
          <span role="status">No Graph Records</span>
        ) : null}
        {view && view.total > 0 ? (
          <span>
            {view.items.length.toLocaleString("en-US")} /{" "}
            {view.total.toLocaleString("en-US")} Records
            {view.hasMore || view.incomplete ? " · Partial Graph" : ""}
          </span>
        ) : null}
        {view?.hasMore ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(true)}
          >
            Load More
          </button>
        ) : null}
      </div>
      <div
        className={`session-graph-workspace${selectedId ? " has-selection" : ""}`}
      >
        <div className="session-graph-column">
          <div
            className="session-graph-viewport"
            tabIndex={0}
            aria-label="Graph Canvas"
          >
            <div
              style={{
                width: layout.width * zoom,
                height: layout.height * zoom,
              }}
              className="session-graph-space"
            >
              <div
                className="session-graph-scene"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `scale(${zoom})`,
                }}
              >
                <svg
                  className="session-graph-edges"
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                >
                  <defs>
                    <marker
                      id={markerId}
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0 0 L8 4 L0 8" fill="currentColor" />
                    </marker>
                  </defs>
                  {relations.map((edge) => {
                    const from = layout.positions.get(edge.fromId);
                    const to = layout.positions.get(edge.toId);
                    if (!from || !to) return null;
                    const route = sessionGraphEdgePath(from, to, edge.fromId === edge.toId);
                    return (
                      <g
                        key={edge.id}
                        className={
                          edge.fromId === selectedId || edge.toId === selectedId
                            ? "is-connected"
                            : ""
                        }
                      >
                        <path
                          d={route.path}
                          markerEnd={`url(#${markerId})`}
                        />
                        <text x={route.labelX} y={route.labelY}>
                          {edge.label ?? label(edge.kind)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {focalRecords.map((record) => {
                  const point = layout.positions.get(record.id)!;
                  return (
                    <button
                      key={record.id}
                      type="button"
                      className={`session-graph-node${record.id === selectedId ? " is-selected" : ""}`}
                      style={{ left: point.x, top: point.y }}
                      aria-pressed={record.id === selectedId}
                      onClick={() => setSelectedId(record.id)}
                    >
                      <span
                        className="session-graph-node-title"
                        title={record.title}
                      >
                        {record.title}
                      </span>
                      <span className="session-graph-node-footer">
                        <Identity
                          focusable={false}
                          identity={record.actorSnapshot}
                          name={
                            "label" in record.actor
                              ? record.actor.label
                              : undefined
                          }
                        />
                        <span>
                          {sessionGraphStatuses(record).map(label).join(" · ")}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <footer className="session-graph-navigation">
            {selectedId ? (
              <button type="button" onClick={clearSelection}>
                Topic Overview
              </button>
            ) : null}
            {records.length ? (
              <select
                aria-label="Find Graph Record"
                value={selectedId ?? ""}
                onChange={(event) => {
                  if (event.target.value) setSelectedId(event.target.value);
                }}
              >
                <option value="">Select Record</option>
                {records.map((record) => (
                  <option value={record.id} key={record.id}>
                    {record.title}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              aria-label="Zoom Out"
              disabled={zoom <= 0.6}
              onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
            >
              −
            </button>
            <button type="button" onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom In"
              disabled={zoom >= 1.6}
              onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}
            >
              +
            </button>
          </footer>
        </div>
        {selectedId ? (
          <aside
            className="session-graph-details"
            aria-label="Record Details"
            aria-busy={detailLoading}
          >
            <div className="session-graph-detail-heading">
              <h2>
                {selectedRecord?.id === selectedId ? selectedRecord.title : ""}
              </h2>
              <CloseButton
                ariaLabel="Close Record Details"
                onClose={clearSelection}
              />
            </div>
            {detailLoading ? (
              <LoadingIndicator label="Loading Record Details" inline />
            ) : null}
            {detailError ? (
              <p role="alert">
                {detailError}{" "}
                <button
                  type="button"
                  onClick={() => void selectRecord(selectedId)}
                >
                  Retry
                </button>
              </p>
            ) : null}
            {selectedRecord?.id === selectedId ? (
              <>
                <div className="session-graph-detail-meta">
                  <Identity
                    identity={selectedRecord.actorSnapshot}
                    name={
                      "label" in selectedRecord.actor
                        ? selectedRecord.actor.label
                        : undefined
                    }
                  />
                  <span>
                    {sessionGraphStatuses(selectedRecord)
                      .map(label)
                      .join(" · ")}
                  </span>
                </div>
                <MessageRichText
                  text={selectedRecord.detail}
                  embeddedMedia="text"
                  onOpenPath={onOpenPath}
                />
                {selectedRecord.scope ? (
                  <p className="session-graph-scope">{selectedRecord.scope}</p>
                ) : null}
                {selectedRecord.target ? (
                  <dl className="session-graph-fields">
                    <dt>Revision</dt>
                    <dd>{selectedRecord.target.revision}</dd>
                    <dt>Conditions</dt>
                    <dd>{selectedRecord.target.conditions}</dd>
                    <dt>Observed At</dt>
                    <dd>{selectedRecord.target.observedAt}</dd>
                  </dl>
                ) : null}
                {selectedRecord.fields &&
                Object.keys(selectedRecord.fields).length ? (
                  <dl className="session-graph-fields">
                    {Object.entries(selectedRecord.fields).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>
                            <pre>
                              {typeof value === "string" && value !== ""
                                ? value
                                : JSON.stringify(value, null, 2)}
                            </pre>
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : null}
                <nav
                  className="session-graph-related"
                  aria-label="Related Records"
                >
                  {related.map((edge) => {
                    const id =
                      edge.fromId === selectedId ? edge.toId : edge.fromId;
                    return (
                      <button
                        key={edge.id}
                        type="button"
                        onClick={() => setSelectedId(id)}
                      >
                        {edge.fromId === selectedId ? "→" : "←"}{" "}
                        {edge.label ?? label(edge.kind)} ·{" "}
                        {endpoints.get(id)?.title ?? "Related Record"}
                      </button>
                    );
                  })}
                </nav>
                <div className="session-graph-references">
                  {selectedRecord.references.map((reference, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => onOpenPath(reference.href)}
                    >
                      {reference.label || reference.href}
                    </button>
                  ))}
                </div>
                {!("sessionId" in selectedRecord.actor) ||
                selectedRecord.actor.sessionId !==
                  selectedRecord.recordedBy.sessionId ? (
                  <div className="session-graph-recorder">
                    Recorded By{" "}
                    <Identity identity={selectedRecord.recordedBy} />
                  </div>
                ) : null}
              </>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
