import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
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
import { SESSION_GRAPH_RELATION_LIMIT } from "../../src-shared/session-graph/session-graph-contract.js";
import { CloseButton } from "../ui/close-button.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import type { ReactNode, MouseEvent, Dispatch, SetStateAction } from "react";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX, IMAGE_ZOOM_STEP, useCtrlWheelZoom, type ImageZoom } from "../ui/image-viewport.js";
import { useViewportPan } from "../ui/viewport-pan.js";
import { MessageRichText } from "../ui/markdown/MessageRichText.js";
import { layoutSessionGraph, sessionGraphCapacity, sessionGraphEdgePath } from "./graph-layout.js";
import { projectSessionGraph, type GraphOverviewNode } from "./graph-overview.js";

const PAGE_SIZE = 40;
export const defaultSessionGraphViewState: SessionGraphViewState = {
  topicId: null, selectedId: null, zoom: 1, scrollLeft: 0, scrollTop: 0,
};
type GraphScope = { ids: string[]; parentState: SessionGraphViewState; triggerId: string };
export type SessionGraphPreviewMemory = {
  topics: SessionGraphTopic[];
  topicsMore: boolean;
  view: SessionGraphReadResult | null;
  selectedRecord: SessionGraphRecord | null;
  detailView: SessionGraphReadResult | null;
  backStack: Array<{ state: SessionGraphViewState; title: string; scopes: GraphScope[]; view: SessionGraphReadResult | null }>;
  scopes: GraphScope[];
};
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
    offset: 0,
    incomplete: next.hasMore ||
      current.incomplete && current.relations.length >= SESSION_GRAPH_RELATION_LIMIT ||
      next.incomplete && next.relations.length >= SESSION_GRAPH_RELATION_LIMIT,
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
      className={`session-graph-identity${!identity ? " is-label" : ""}`}
      role="img"
      tabIndex={focusable ? 0 : undefined}
      aria-label={text}
    >
      {identity ? <CharacterAvatar
        character={{
          name: identity?.character?.name ?? name ?? "?",
          iconPath: identity?.character?.icon ?? "",
        }}
        size="small"
      /> : <>
        <svg className="session-graph-actor-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="7" r="4" />
          <path d="M4 21v-3a8 8 0 0 1 16 0v3" />
        </svg>
        <span className="session-graph-actor-name">{text}</span>
      </>}
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
  initialState = defaultSessionGraphViewState,
  onStateChange,
  onOpenWindow,
  toolbarActions,
  initialMemory,
  onMemoryChange,
}: {
  api: Pick<WithMateWindowApi, "readSessionGraph" | "subscribeSessionGraph">;
  sessionId: string;
  onClose?(): void;
  onOpenPath(target: string): void;
  initialState?: SessionGraphViewState;
  onStateChange?(state: SessionGraphViewState): void;
  onOpenWindow?(state: SessionGraphViewState): void;
  toolbarActions?: ReactNode;
  initialMemory?: SessionGraphPreviewMemory | null;
  onMemoryChange?(memory: SessionGraphPreviewMemory): void;
}) {
  const [topics, setTopics] = useState<SessionGraphTopic[]>(initialMemory?.topics ?? []);
  const [topicsMore, setTopicsMore] = useState(initialMemory?.topicsMore ?? false);
  const [topicId, setTopicId] = useState(initialState.topicId ?? "");
  const [view, setView] = useState<SessionGraphReadResult | null>(initialMemory?.view ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(initialState.selectedId);
  const [selectedRecord, setSelectedRecord] =
    useState<SessionGraphRecord | null>(initialMemory?.selectedRecord ?? null);
  const [detailView, setDetailView] = useState<SessionGraphReadResult | null>(
    initialMemory?.detailView ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [zoom, setZoom] = useState(initialState.zoom);
  const [backStack, setBackStack] = useState<SessionGraphPreviewMemory["backStack"]>(initialMemory?.backStack ?? []);
  const [scopes, setScopes] = useState<GraphScope[]>(initialMemory?.scopes ?? []);
  const viewportRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const topicSelectRef = useRef<HTMLSelectElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const loadedCountRef = useRef<HTMLSpanElement>(null);
  const focusLoadedCount = useRef(false);
  const nodesRef = useRef(new Map<string, HTMLButtonElement>());
  const pendingScroll = useRef<SessionGraphViewState | null>(initialState);
  const focusDetail = useRef(false);
  const restoreNodeFocus = useRef<string | null>(null);
  const focusSelector = useRef(true);
  const [narrow, setNarrow] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const [windowTarget, setWindowTarget] = useState<{ id: string; title: string } | null>(null);
  const windowTargetTrigger = useRef<HTMLElement | null>(null);
  const windowMenuRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef(initialState);
  const pan = useViewportPan(`${sessionId}:${topicId}:${selectedId ?? ""}`);
  const suppressPanClick = useRef(false);
  const setViewportZoom = useCallback<Dispatch<SetStateAction<ImageZoom>>>((action) => {
    setZoom((current) => {
      const next = typeof action === "function" ? action(Math.round(current * 100)) : action;
      return next === "fit" ? 1 : next / 100;
    });
  }, []);
  useCtrlWheelZoom(viewportRef, 100, setViewportZoom);
  const snapshot = (): SessionGraphViewState => ({ topicId: topicId || null, selectedId, zoom,
    scrollLeft: viewportRef.current?.scrollLeft ?? stateRef.current.scrollLeft,
    scrollTop: viewportRef.current?.scrollTop ?? stateRef.current.scrollTop });
  const publishState = () => { stateRef.current = snapshot(); onStateChange?.(stateRef.current); };
  useEffect(() => {
    const host = workspaceRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 760));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (windowTarget) windowMenuRef.current?.focus(); }, [windowTarget]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportSize((current) => current?.width === viewport.clientWidth && current.height === viewport.clientHeight
      ? current : { width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
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
      const restoreLoadFocus = more && document.activeElement === loadMoreRef.current;
      setLoading(true);
      setLoadingMore(more);
      setLoadMoreError("");
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
        if (restoreLoadFocus && !combined.hasMore &&
          (document.activeElement === loadMoreRef.current || document.activeElement === document.body)) focusLoadedCount.current = true;
        setView(combined);
      } catch (cause) {
        if (request.current === revision)
          (more ? setLoadMoreError : setError)(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (request.current === revision) {
          setLoading(false);
          setLoadingMore(false);
        }
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
          setScopes([]);
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
  const projection = useMemo(() => projectSessionGraph(
    focalRecords, relations,
    selectedId || (view?.incomplete && relations.length >= SESSION_GRAPH_RELATION_LIMIT)
      ? Number.POSITIVE_INFINITY : sessionGraphCapacity(viewportSize?.width ?? 0, viewportSize?.height ?? 0),
    selectedId ? null : scopes.at(-1)?.ids ?? null,
  ), [focalRecords, relations, selectedId, viewportSize, scopes, view?.incomplete]);
  const layout = useMemo(
    () => layoutSessionGraph(projection.nodes, projection.edges, viewportSize?.width ?? 0),
    [projection, viewportSize],
  );
  const edgeRoutes = projection.edges.flatMap((edge) => {
    const from = layout.positions.get(edge.fromId);
    const to = layout.positions.get(edge.toId);
    return from && to
      ? [{ edge, route: sessionGraphEdgePath(from, to, edge.fromId === edge.toId) }]
      : [];
  });
  const clearSelection = (restoreFocus = true) => {
    restoreNodeFocus.current = restoreFocus ? selectedId : null;
    detailRequest.current += 1;
    setSelectedId(null);
    setSelectedRecord(null);
    setDetailView(null);
    setDetailError("");
    setDetailLoading(false);
    setBackStack([]);
  };
  useLayoutEffect(() => {
    if (view && viewportSize !== null && pendingScroll.current && viewportRef.current) {
      viewportRef.current.scrollLeft = pendingScroll.current.scrollLeft;
      viewportRef.current.scrollTop = pendingScroll.current.scrollTop;
      pendingScroll.current = null;
    }
    publishState();
    if (focusLoadedCount.current) {
      focusLoadedCount.current = false;
      loadedCountRef.current?.focus({ preventScroll: true });
    }
    if (!selectedId && restoreNodeFocus.current) {
      const target = projection.nodes.find((node) => node.id === restoreNodeFocus.current || node.records.some((record) => record.id === restoreNodeFocus.current));
      (nodesRef.current.get(target?.id ?? "") ?? viewportRef.current)?.focus();
      restoreNodeFocus.current = null;
    }
    if (focusSelector.current && topics.length) {
      topicSelectRef.current?.focus();
      focusSelector.current = false;
    }
    if (focusDetail.current && selectedId && !detailLoading && selectedRecord?.id === selectedId) {
      headingRef.current?.focus();
      focusDetail.current = false;
    }
  }, [topicId, selectedId, zoom, view, topics.length, detailLoading, selectedRecord, viewportSize, scopes, projection]);
  useLayoutEffect(() => {
    onMemoryChange?.({ topics, topicsMore, view, selectedRecord, detailView, backStack, scopes });
  }, [topics, topicsMore, view, selectedRecord, detailView, backStack, scopes, onMemoryChange]);
  const chooseRecord = (id: string, related = false, event?: MouseEvent) => {
    if (event && (event.ctrlKey || event.metaKey) && onOpenWindow) {
      onOpenWindow({ ...snapshot(), selectedId: id });
      return;
    }
    setBackStack((current) => related && selectedId
      ? [...current, { state: snapshot(), title: selectedRecord?.title ?? "Record", scopes, view }] : []);
    focusDetail.current = true;
    setSelectedId(id);
  };
  const showRecordMenu = (id: string, title: string, trigger: HTMLElement) => {
    if (!onOpenWindow) return;
    windowTargetTrigger.current = trigger;
    setWindowTarget({ id, title });
  };
  const closeRecordMenu = () => { setWindowTarget(null); windowTargetTrigger.current?.focus(); };
  const expandGroup = (node: GraphOverviewNode) => {
    setScopes((current) => [...current, {
      ids: node.records.map((record) => record.id),
      parentState: snapshot(), triggerId: node.id,
    }]);
    pendingScroll.current = { ...snapshot(), scrollLeft: 0, scrollTop: 0 };
    viewportRef.current?.focus();
  };
  const loadMoreLabel = `Load ${Math.min(PAGE_SIZE, Math.max(0, (view?.total ?? 0) - (view?.items.length ?? 0))).toLocaleString("en-US")} More`;
  return (
    <section
      className={`session-graph-preview${tooltipsDismissed ? " tooltips-dismissed" : ""}`}
      aria-label="Session Graph"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (windowTarget) { event.stopPropagation(); closeRecordMenu(); }
          else if (selectedId && event.currentTarget.querySelector(".session-graph-details")?.contains(event.target as Node)) {
            event.stopPropagation(); clearSelection();
          } else setTooltipsDismissed(true);
        }
      }}
      onFocusCapture={() => setTooltipsDismissed(false)}
      onPointerOver={() => setTooltipsDismissed(false)}
    >
      <header className="session-graph-toolbar">
        {onClose ? <BackNavigationButton label="Back To Chat" onBack={onClose} /> : null}
        {topics.length ? (
          <select
            ref={topicSelectRef}
            aria-label="Graph Topic"
            value={topicId}
            onChange={(event) => {
              clearSelection(false);
              setScopes([]);
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
        {scopes.length && !selectedId ? <div className="session-graph-scope-navigation" role="group" aria-label="Graph Range Navigation">
          <BackNavigationButton label={scopes.length === 1 ? "Back To Overview" : "Back To Previous Range"} showLabel onBack={() => {
            const previous = scopes.at(-1)!;
            pendingScroll.current = previous.parentState;
            restoreNodeFocus.current = previous.triggerId;
            setZoom(previous.parentState.zoom);
            setScopes((current) => current.slice(0, -1));
          }} />
          {scopes.length > 1 ? <button type="button" onClick={() => {
            pendingScroll.current = scopes[0].parentState;
            restoreNodeFocus.current = scopes[0].triggerId;
            setZoom(scopes[0].parentState.zoom);
            setScopes([]);
          }}>Overview</button> : null}
        </div> : null}
        {topicsMore ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(false, true)}
          >
            More Topics
          </button>
        ) : null}
        {toolbarActions}
      </header>
      <div className="session-graph-load-status" aria-busy={loading && !loadingMore}>
        {loading && !loadingMore ? (
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
      </div>
      <div
        ref={workspaceRef}
        className={`session-graph-workspace${selectedId ? " has-selection" : ""}${narrow ? " is-narrow" : ""}`}
      >
        <div className="session-graph-column" inert={narrow && !!selectedId} aria-hidden={narrow && !!selectedId || undefined}>
          <div
            ref={viewportRef}
            onScroll={publishState}
            className={`session-graph-viewport${pan.isPanning ? " is-panning" : ""}`}
            onPointerDown={(event) => {
              pan.startPan(event);
              suppressPanClick.current = event.defaultPrevented;
            }}
            onPointerMove={pan.movePan}
            onPointerUp={pan.stopPan}
            onPointerCancel={(event) => { pan.stopPan(event); suppressPanClick.current = false; }}
            onLostPointerCapture={pan.handlePanCaptureLoss}
            onClickCapture={(event) => {
              const suppress = suppressPanClick.current;
              suppressPanClick.current = false;
              if (suppress && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
            }}
            title="Ctrl + left-drag to pan"
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
                  {edgeRoutes.map(({ edge, route }) => {
                    return (
                      <g
                        key={edge.id}
                        className={`${edge.fromId === `record:${selectedId}` || edge.toId === `record:${selectedId}` ? "is-connected" : ""}${edge.grouped ? " is-grouped" : ""}`}
                      >
                        <path
                          d={route.path}
                          markerEnd={`url(#${markerId})`}
                        />
                      </g>
                    );
                  })}
                  {edgeRoutes.map(({ edge, route }) => (
                    <text key={edge.id} x={route.labelX} y={route.labelY}>
                      {edge.label ?? label(edge.kind)}
                    </text>
                  ))}
                </svg>
                {projection.nodes.map((node) => {
                  const point = layout.positions.get(node.id)!;
                  const record = node.records[0];
                  if (node.records.length > 1) return <button
                    key={node.id} type="button"
                    ref={(element) => { if (element) nodesRef.current.set(node.id, element); else nodesRef.current.delete(node.id); }}
                    className="session-graph-node session-graph-group"
                    style={{ left: point.x, top: point.y }}
                    aria-label={`Expand ${node.records.length} Records: ${record.title} — ${node.records.at(-1)!.title}`}
                    onClick={() => expandGroup(node)}
                  >
                    <strong>{node.records.length} Records</strong>
                    <span className="session-graph-group-range">{record.title}<br />… {node.records.at(-1)!.title}</span>
                    <span className="session-graph-group-action">Expand Path →</span>
                  </button>;
                  return (
                    <button
                      ref={(element) => { if (element) nodesRef.current.set(node.id, element); else nodesRef.current.delete(node.id); }}
                      key={node.id}
                      type="button"
                      className={`session-graph-node${record.id === selectedId ? " is-selected" : ""}`}
                      style={{ left: point.x, top: point.y }}
                      aria-pressed={record.id === selectedId}
                      onClick={(event) => chooseRecord(record.id, false, event)}
                      onContextMenu={(event) => { if (onOpenWindow) { event.preventDefault(); showRecordMenu(record.id, record.title, event.currentTarget); } }}
                      onKeyDown={(event) => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); showRecordMenu(record.id, record.title, event.currentTarget); } }}
                    >
                      <span
                        className="session-graph-node-title"
                        title={record.title}
                      >
                        {record.title}
                      </span>
                      <Identity
                          focusable={false}
                          identity={record.actorSnapshot}
                          name={
                            "label" in record.actor
                              ? record.actor.label
                              : undefined
                          }
                      />
                        <span className="session-graph-node-status">
                          {sessionGraphStatuses(record).map(label).join(" · ")}
                        </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <footer className="session-graph-navigation">
            <div className="session-graph-zoom" role="group" aria-label="Graph Zoom">
              <button
                type="button"
                aria-label="Zoom Out"
                disabled={zoom * 100 <= IMAGE_ZOOM_MIN}
                onClick={() => setZoom((value) => Math.max(IMAGE_ZOOM_MIN, Math.round(value * 100) - IMAGE_ZOOM_STEP) / 100)}
              >
                −
              </button>
              <button type="button" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="Zoom In"
                disabled={zoom * 100 >= IMAGE_ZOOM_MAX}
                onClick={() => setZoom((value) => Math.min(IMAGE_ZOOM_MAX, Math.round(value * 100) + IMAGE_ZOOM_STEP) / 100)}
              >
                +
              </button>
            </div>
            {view ? <div className="session-graph-records">
              <div className="session-graph-record-status">
                <span ref={loadedCountRef} tabIndex={-1}>
                  {view.items.length.toLocaleString("en-US")} / {view.total.toLocaleString("en-US")} Records Loaded
                </span>
                {view.incomplete && view.relations.length >= SESSION_GRAPH_RELATION_LIMIT ? <span>Some Relations May Be Missing</span> : null}
              </div>
              <div className="session-graph-load-action">
                <span className="session-graph-load-reserve" aria-hidden="true"><ButtonContent busy={false}>Load 40 More</ButtonContent></span>
                {view.hasMore ? <button
                  ref={loadMoreRef}
                  type="button"
                  className="session-graph-load-more"
                  disabled={loading}
                  aria-label={loadMoreLabel}
                  aria-busy={loadingMore}
                  aria-describedby={loadMoreError ? `${markerId}-load-error` : undefined}
                  onClick={() => void load(true)}
                >
                  <ButtonContent busy={loadingMore} busyLabel="Loading More Records">{loadMoreLabel}</ButtonContent>
                </button> : null}
              </div>
              {loadMoreError ? <div id={`${markerId}-load-error`} className="session-graph-load-error" role="alert" tabIndex={0}>{loadMoreError}</div> : null}
            </div> : null}
          </footer>
        </div>
        {selectedId ? (
          <aside
            className="session-graph-details"
            aria-label="Record Details"
            aria-busy={detailLoading}
          >
            <div className="session-graph-detail-heading">
              <h2 ref={headingRef} tabIndex={-1}>
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
                {backStack.length ? <button type="button" className="session-graph-back-link" onClick={() => {
                  const previous = backStack[backStack.length - 1];
                  setBackStack((current) => current.slice(0, -1));
                  setScopes(previous.scopes);
                  pendingScroll.current = previous.state;
                  if (previous.state.topicId !== topicId) setView(previous.view);
                  setTopicId(previous.state.topicId ?? "");
                  setSelectedId(previous.state.selectedId);
                  setZoom(previous.state.zoom);
                  focusDetail.current = true;
                }}>Back To {backStack[backStack.length - 1].title}</button> : null}
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
                        onClick={(event) => chooseRecord(id, true, event)}
                        onContextMenu={(event) => { if (onOpenWindow) { event.preventDefault(); showRecordMenu(id, endpoints.get(id)?.title ?? "Related Record", event.currentTarget); } }}
                        onKeyDown={(event) => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); showRecordMenu(id, endpoints.get(id)?.title ?? "Related Record", event.currentTarget); } }}
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
      {windowTarget ? <div className="session-graph-record-menu" role="dialog" aria-label={windowTarget.title}>
        <button ref={windowMenuRef} type="button" onClick={() => { onOpenWindow?.({ ...snapshot(), selectedId: windowTarget.id }); closeRecordMenu(); }}>Open In New Window</button>
        <CloseButton ariaLabel="Close Record Menu" onClose={closeRecordMenu} />
      </div> : null}
    </section>
  );
}
