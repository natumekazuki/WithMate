import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphPage, SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphOverviewCategory, SessionGraphOverviewGroup, SessionGraphOverviewResult, SessionGraphRecordSummary, SessionGraphTopicRelation, SessionGraphTopicRelationsResult } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { ButtonContent } from "../ui/button-content.js";
import { CloseButton } from "../ui/close-button.js";
import { useCtrlWheelZoom, type ImageZoom } from "../ui/image-viewport.js";
import { useViewportPan } from "../ui/viewport-pan.js";
import { layoutSessionGraph, sessionGraphRoutePath, type SessionGraphLayout, type SessionGraphLabelSize } from "./graph-layout.js";
import { sessionGraphRecency } from "./graph-recency.js";
import { SessionGraphIdentityView } from "./SessionGraphIdentity.js";

export type SessionGraphOverviewState = { selectedTopicId: string | null; zoom: number; scrollLeft: number; scrollTop: number };
export const defaultSessionGraphOverviewState: SessionGraphOverviewState = { selectedTopicId: null, zoom: 1, scrollLeft: 0, scrollTop: 0 };
export type SessionGraphOverviewMemory = { overview: SessionGraphOverviewResult | null; layout?: SessionGraphLayout };
const categories: Array<[SessionGraphOverviewCategory, string]> = [["requirements", "Requirements"], ["constraints", "Constraints"], ["decisions", "Decisions"], ["activities", "Activities"], ["observations", "Observations"], ["issues", "Issues"]];
const titleCase = (value: string) => value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
const states = (group: SessionGraphOverviewGroup) => Object.entries(group.states).map(([key, count]) => `${key.split(":").map(titleCase).join(": ")} ${count}`).join(" · ");
const relationId = (relation: SessionGraphTopicRelation) => JSON.stringify([relation.fromTopicId, relation.toTopicId, relation.kind]);
const relationLabel = (relation: SessionGraphTopicRelation) => `${titleCase(relation.kind)} · ${relation.count} Record ${relation.count === 1 ? "Relation" : "Relations"}`;

function RecordGroup({ api, sessionId, revision, topicId, category, group, actorSessionId, onOpenRecord, onRefresh }: {
  api: Pick<WithMateWindowApi, "readSessionGraph">; sessionId: string; revision: number; topicId: string;
  category: SessionGraphOverviewCategory; group: SessionGraphOverviewGroup; actorSessionId?: string;
  onOpenRecord(id: string): void; onRefresh(): void;
}) {
  const [page, setPage] = useState<SessionGraphPage<SessionGraphRecordSummary> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => { request.current += 1; setPage(null); setError(""); setBusy(false); return () => { request.current += 1; }; }, [revision, topicId, category, actorSessionId]);
  const currentPage = page?.revision === revision ? page : null;
  const records = currentPage?.items ?? group.records;
  const more = currentPage ? currentPage.hasMore : records.length < group.count;
  async function load() {
    const token = ++request.current;
    setBusy(true); setError("");
    try {
      const result = await api.readSessionGraph(sessionId, "topic_records", { topicId, category, actorSessionId, expectedRevision: revision, offset: currentPage?.items.length ?? 0, limit: 40 });
      if (token !== request.current) return;
      if (result.status !== "ok") { onRefresh(); throw new Error("Graph Changed. Refresh The Overview And Retry."); }
      if (!result.hasMore && (currentPage?.items.length ?? 0) + result.items.length !== result.total) throw new Error("Some Records Are Unconfirmed. Retry.");
      setPage({ ...result, items: [...(currentPage?.items ?? []), ...result.items] });
    } catch (reason) { if (token === request.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (token === request.current) setBusy(false); }
  }
  return <><p className="topic-overview-states">{states(group)}</p><ul className="topic-overview-records">
    {records.map((record) => <li key={record.id}><button type="button" onClick={() => onOpenRecord(record.id)}>{record.title}</button>
      <small>{[record.adoption, record.progress, record.result, record.resolution, record.validity].filter(Boolean).map((value) => titleCase(value!)).join(" · ")}</small></li>)}
  </ul>{more ? <button type="button" disabled={busy} aria-busy={busy} onClick={() => void load()}><ButtonContent busy={busy}>Load More Records</ButtonContent></button> : null}
  {error ? <p role="alert">{error}</p> : null}</>;
}

export function SessionGraphOverview({ api, sessionId, onOpenTopic, initialState = defaultSessionGraphOverviewState, onStateChange, initialMemory, onMemoryChange }: {
  api: Pick<WithMateWindowApi, "readSessionGraph" | "subscribeSessionGraph">; sessionId: string;
  onOpenTopic(topicId: string, recordId?: string): void; initialState?: SessionGraphOverviewState;
  onStateChange?(state: SessionGraphOverviewState): void; initialMemory?: SessionGraphOverviewMemory | null;
  onMemoryChange?(memory: SessionGraphOverviewMemory): void;
}) {
  const [overview, setOverview] = useState(initialMemory?.overview ?? null);
  const [selection, setSelection] = useState(initialState.selectedTopicId);
  const [zoom, setZoom] = useState(initialState.zoom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [relation, setRelation] = useState<SessionGraphTopicRelation | null>(null);
  const [tooltipsDismissed, setTooltipsDismissed] = useState(false);
  const [relationPage, setRelationPage] = useState<SessionGraphTopicRelationsResult | null>(null);
  const [relationBusy, setRelationBusy] = useState(false);
  const [relationError, setRelationError] = useState("");
  useEffect(() => {
    const dismissTooltips = (event: KeyboardEvent) => { if (event.key === "Escape") setTooltipsDismissed(true); };
    window.addEventListener("keydown", dismissTooltips);
    return () => window.removeEventListener("keydown", dismissTooltips);
  }, []);
  const workspace = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const pendingDetailFocus = useRef(false);
  const pendingRestoreFocus = useRef(false);
  const relationReturn = useRef<{ topicId: string; relationId: string; trigger: HTMLElement | null } | null>(null);
  const measureLabels = useRef(new Map<string, HTMLSpanElement>());
  const [sizes, setSizes] = useState(new Map<string, SessionGraphLabelSize>());
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const previousLayout = useRef(initialMemory?.layout);
  const overviewRef = useRef(overview);
  const loadToken = useRef(0);
  const relationToken = useRef(0);
  const suppressClick = useRef(false);
  const restored = useRef(false);
  const markerId = useId().replace(/:/g, "");
  const pan = useViewportPan(sessionId, { captureOnMove: true });
  const setWheelZoom = useCallback<Dispatch<SetStateAction<ImageZoom>>>((update) => setZoom((value) => {
    const next = typeof update === "function" ? update(value * 100) : update;
    return next === "fit" ? value : next / 100;
  }), []);
  useCtrlWheelZoom(viewport, 100, setWheelZoom);
  const publish = useCallback(() => {
    if (!restored.current) return;
    onStateChange?.({ selectedTopicId: selection, zoom, scrollLeft: viewport.current?.scrollLeft ?? initialState.scrollLeft, scrollTop: viewport.current?.scrollTop ?? initialState.scrollTop });
  }, [onStateChange, selection, zoom, initialState.scrollLeft, initialState.scrollTop]);
  useEffect(publish, [publish]);
  const refresh = useCallback(async () => {
    const token = ++loadToken.current;
    setBusy(true); setError("");
    try {
      let combined: SessionGraphOverviewResult | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const first = await api.readSessionGraph(sessionId, "overview", { limit: 200 });
        if (first.status !== "ok") continue;
        combined = first;
        while (combined?.hasMore) {
          const next: Awaited<ReturnType<typeof api.readSessionGraph<"overview">>> = await api.readSessionGraph(sessionId, "overview", { limit: 200, offset: combined.items.length, expectedRevision: combined.revision });
          if (next.status !== "ok") { combined = null; break; }
          if (next.items.length === 0) throw new Error("Topic Retrieval Is Incomplete. Retry.");
          combined = { ...next, items: [...combined.items, ...next.items] };
        }
        if (combined) break;
      }
      if (!combined || combined.items.length !== combined.total) throw new Error("The Overview Is Unconfirmed. Retry.");
      combined = { ...combined, offset: 0, incomplete: false };
      if (token !== loadToken.current) return;
      const order = new Map((overviewRef.current?.items ?? []).map((item, index) => [item.id, index]));
      combined.items.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
      overviewRef.current = combined; setOverview(combined);
    } catch (reason) { if (token === loadToken.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (token === loadToken.current) setBusy(false); }
  }, [api, sessionId]);
  useEffect(() => {
    void refresh();
    const unsubscribe = api.subscribeSessionGraph(() => void refresh());
    return () => { unsubscribe(); loadToken.current += 1; relationToken.current += 1; };
  }, [api, refresh]);
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const measure = () => setDimensions((current) => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  const edges = useMemo<SessionGraphRelation[]>(() => (overview?.topicRelations ?? []).map((edge) => ({ id: relationId(edge), fromId: edge.fromTopicId, toId: edge.toTopicId, kind: edge.kind, label: relationLabel(edge) })), [overview]);
  useLayoutEffect(() => {
    const measure = () => {
      const next = new Map<string, SessionGraphLabelSize>();
      for (const [id, element] of measureLabels.current) { const rect = element.getBoundingClientRect(); next.set(id, { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }); }
      setSizes((current) => current.size === next.size && [...next].every(([id, size]) => current.get(id)?.width === size.width && current.get(id)?.height === size.height) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); for (const element of measureLabels.current.values()) observer.observe(element); return () => observer.disconnect();
  }, [edges]);
  const layoutReady = !!overview && dimensions.width > 0 && dimensions.height > 0 && edges.every((edge) => sizes.has(edge.id));
  const layout = useMemo(() => !layoutReady && previousLayout.current ? previousLayout.current
    : layoutSessionGraph(overview?.items ?? [], edges, dimensions.width, dimensions.height, sizes, previousLayout.current), [overview, edges, dimensions, sizes, layoutReady]);
  useLayoutEffect(() => { if (layoutReady) previousLayout.current = layout; }, [layout, layoutReady]);
  useEffect(() => { if (layoutReady && restored.current) onMemoryChange?.({ overview, layout }); }, [overview, layout, layoutReady, onMemoryChange]);
  useLayoutEffect(() => {
    if (!layoutReady || restored.current || !viewport.current) return;
    viewport.current.scrollLeft = initialState.scrollLeft; viewport.current.scrollTop = initialState.scrollTop; restored.current = true;
    publish();
  }, [layoutReady, layout, initialState.scrollLeft, initialState.scrollTop, publish]);
  const selected = overview?.items.find((topic) => topic.id === selection);
  const selectTopic = (id: string, trigger: HTMLElement) => { relationReturn.current = null; detailTrigger.current = trigger; pendingDetailFocus.current = true; relationToken.current += 1; setSelection(id); setRelation(null); };
  const dismiss = () => { relationToken.current += 1; pendingRestoreFocus.current = true; setSelection(relation && relationReturn.current ? relationReturn.current.topicId : null); setRelation(null); };
  const openRelation = (edge: SessionGraphTopicRelation, trigger: HTMLElement) => { relationReturn.current = trigger.closest("aside") && selection ? { topicId: selection, relationId: relationId(edge), trigger: detailTrigger.current } : null; detailTrigger.current = trigger; pendingDetailFocus.current = true; void loadRelations(edge); };
  useLayoutEffect(() => {
    if (pendingDetailFocus.current && detailHeading.current) { pendingDetailFocus.current = false; detailHeading.current.focus({ preventScroll: true }); }
    if (pendingRestoreFocus.current) {
      pendingRestoreFocus.current = false;
      const origin = detailTrigger.current?.isConnected ? detailTrigger.current : [...(workspace.current?.querySelectorAll<HTMLButtonElement>("[data-topic-relation]") ?? [])].find((button) => button.dataset.topicRelation === relationReturn.current?.relationId);
      origin?.focus({ preventScroll: true });
      if (relationReturn.current) detailTrigger.current = relationReturn.current.trigger;
      relationReturn.current = null;
    }
  });
  async function loadRelations(edge: SessionGraphTopicRelation, append = false) {
    if (!overview) return;
    append = append && relationPage?.revision === overview.revision;
    const token = ++relationToken.current;
    setRelation(edge); setRelationBusy(true); setRelationError("");
    if (!append && (!relation || relationId(relation) !== relationId(edge))) setRelationPage(null);
    try {
      const result = await api.readSessionGraph(sessionId, "topic_relations", { fromTopicId: edge.fromTopicId, toTopicId: edge.toTopicId, kind: edge.kind, limit: 40, offset: append ? relationPage?.items.length ?? 0 : 0, expectedRevision: overview.revision });
      if (token !== relationToken.current) return;
      if (result.status !== "ok") { void refresh(); throw new Error("Graph Changed. Select The Relation Again."); }
      if (!result.hasMore && (append ? relationPage?.items.length ?? 0 : 0) + result.items.length !== result.total) throw new Error("Some Relations Are Unconfirmed. Retry.");
      setRelationPage({ ...result, items: [...(append ? relationPage?.items ?? [] : []), ...result.items], endpoints: [...(append ? relationPage?.endpoints ?? [] : []), ...result.endpoints] });
    } catch (reason) { if (token === relationToken.current) setRelationError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (token === relationToken.current) setRelationBusy(false); }
  }
  useEffect(() => {
    relationToken.current += 1;
    if (!relation || !overview) return;
    const current = overview.topicRelations.find((edge) => relationId(edge) === relationId(relation));
    if (current) void loadRelations(current);
    else { setRelation(null); setRelationPage(null); setRelationBusy(false); setRelationError(""); }
  }, [overview?.revision]);
  const topicName = (id: string) => overview?.items.find((topic) => topic.id === id)?.title ?? "Topic";
  const currentRelationPage = relationPage?.revision === overview?.revision ? relationPage : null;
  const narrow = dimensions.width > 0 && dimensions.width < 680;
  return <section className={`session-graph-preview topic-overview${tooltipsDismissed ? " tooltips-dismissed" : ""}`} aria-label="Topic Overview"
    onFocusCapture={() => { if (tooltipsDismissed) setTooltipsDismissed(false); }} onPointerOver={() => { if (tooltipsDismissed) setTooltipsDismissed(false); }}>
    <header className="topic-overview-header"><strong>Overview</strong><select aria-label="Select Topic" value={selection ?? ""} onChange={(event) => event.target.value ? selectTopic(event.target.value, event.currentTarget) : dismiss()}><option value="">All Topics</option>{overview?.items.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></header>
    <div className="session-graph-load-status" aria-busy={busy}>{busy ? <LoadingIndicator label="Loading Topic Overview" inline /> : null}{error ? <span role="alert">{error} <button type="button" onClick={() => void refresh()}>Retry</button></span> : null}</div>
    <div className="session-graph-label-measure" aria-hidden="true">{edges.map((edge) => <span key={edge.id} className="session-graph-edge-label" ref={(element) => { if (element) measureLabels.current.set(edge.id, element); else measureLabels.current.delete(edge.id); }}>{edge.label}</span>)}</div>
    <div ref={workspace} className={`session-graph-workspace${selected || relation ? " has-selection" : ""}${narrow ? " is-narrow" : ""}`}>
      <div className="session-graph-column" inert={narrow && !!(selected || relation)}>
        <div ref={viewport} className={`session-graph-viewport${pan.isPanning ? " is-panning" : ""}`} tabIndex={0} aria-label="Topic Graph Canvas" onScroll={publish}
          onPointerDown={(event) => { suppressClick.current = false; pan.startPan(event); }} onPointerMove={(event) => { if (pan.movePan(event)) suppressClick.current = true; }} onPointerUp={pan.stopPan} onPointerCancel={pan.stopPan} onLostPointerCapture={pan.handlePanCaptureLoss}
          onClickCapture={(event) => { if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
          <div className="session-graph-space" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="session-graph-scene" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
            <svg className="session-graph-edges" width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="currentColor" /></marker></defs>{edges.map((edge) => { const route = layout.edgeRoutes.get(edge.id); return route ? <g key={edge.id} className={edge.fromId === selection || edge.toId === selection ? "is-connected" : ""}>{route.segments.map((segment, index) => <path key={index} d={sessionGraphRoutePath(segment)} markerEnd={index === route.segments.length - 1 ? `url(#${markerId})` : undefined} />)}</g> : null; })}</svg>
            {(overview?.topicRelations ?? []).map((edge) => { const route = layout.edgeRoutes.get(relationId(edge)); return route ? <button key={relationId(edge)} className="session-graph-edge-label topic-overview-relation" style={{ left: route.labelX, top: route.labelY }} onClick={(event) => openRelation(edge, event.currentTarget)} aria-label={`${topicName(edge.fromTopicId)} → ${topicName(edge.toTopicId)}: ${relationLabel(edge)}`}>{relationLabel(edge)}</button> : null; })}
            {overview?.items.map((topic) => { const position = layout.positions.get(topic.id); const recency = sessionGraphRecency(topic.latestRecordUpdatedAt, overview.recency); return <button type="button" key={topic.id} ref={(element) => { if (element) nodes.current.set(topic.id, element); else nodes.current.delete(topic.id); }} className={`topic-overview-card session-graph-recency-surface${selection === topic.id ? " is-selected" : ""}`} data-latest={recency.latest} aria-pressed={selection === topic.id} aria-label={`${topic.title}; ${topic.recordCount} Records${topic.latestRecordUpdatedAt ? `; Updated ${new Date(topic.latestRecordUpdatedAt).toLocaleString("en-US")}` : ""}`} style={{ left: position?.x, top: position?.y, "--session-graph-recency": recency.background } as CSSProperties} onClick={(event) => selectTopic(topic.id, event.currentTarget)}>
              <strong title={topic.title}>{topic.title}</strong><span>{topic.recordCount} Records</span><small>{[topic.activities.count ? states(topic.activities) : "", topic.issues.count ? states(topic.issues) : "", topic.decisions.states["adoption:accepted"] ? `Accepted ${topic.decisions.states["adoption:accepted"]}` : ""].filter(Boolean).join(" · ")}</small><span className="topic-overview-actors">{topic.actors.map(({ identity }) => <SessionGraphIdentityView key={identity.sessionId} identity={identity} focusable={false} />)}</span>
            </button>; })}
          </div></div>
        </div>
        <footer className="topic-overview-footer"><div><button type="button" aria-label="Zoom Out" onClick={() => setZoom((value) => Math.max(.1, Math.round((value - .1) * 100) / 100))}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label="Zoom In" onClick={() => setZoom((value) => Math.min(8, Math.round((value + .1) * 100) / 100))}>+</button></div><span>{overview?.items.length ?? "—"} Topics</span></footer>
      </div>
      {selected || relation ? <aside className="session-graph-details topic-overview-detail" aria-label={relation ? "Record Relation Details" : "Topic Summary"} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}>
        <CloseButton onClose={dismiss} ariaLabel="Close Topic Summary" />
        {relation ? <><h2 ref={detailHeading} tabIndex={-1}>Record Relations</h2><p>{topicName(relation.fromTopicId)} → {topicName(relation.toTopicId)}</p><p>{titleCase(relation.kind)} · {relation.count}</p><p className="topic-overview-states">Relations Between Specific Records, Not Whole Topics</p><ul className="topic-overview-records">{currentRelationPage?.items.map((edge) => <li key={edge.id}>{[edge.fromId, edge.toId].map((id, index) => { const endpoint = currentRelationPage.endpoints.find((item) => item.id === id); return <span key={`${index}:${id}`}>{index ? " → " : ""}{endpoint ? <button type="button" onClick={() => onOpenTopic(endpoint.topicId, endpoint.id)}>{endpoint.title}</button> : id}</span>; })}<small>{edge.label ?? titleCase(edge.kind)}</small></li>)}</ul>{relationBusy ? <LoadingIndicator label="Loading Record Relations" inline /> : null}{relationError ? <p role="alert">{relationError}</p> : null}{!currentRelationPage && !relationBusy ? <p role="status">Record Relations Are Unconfirmed</p> : null}{currentRelationPage?.hasMore || !currentRelationPage || relationError ? <button type="button" disabled={relationBusy} onClick={() => void loadRelations(relation, !!currentRelationPage)}>Load More Relations</button> : null}</> : selected && overview ? <><h2 ref={detailHeading} tabIndex={-1}>{selected.title}</h2><button type="button" onClick={() => onOpenTopic(selected.id)}>Open Topic</button>{selected.latestRecordUpdatedAt ? <p className="topic-overview-states">Updated {new Date(selected.latestRecordUpdatedAt).toLocaleString("en-US")}</p> : null}
          {categories.filter(([category]) => selected[category].count > 0).map(([category, label]) => <section key={category}><h3>{label} <small>{selected[category].count}</small></h3><RecordGroup key={selected.id} api={api} sessionId={sessionId} revision={overview.revision} topicId={selected.id} category={category} group={selected[category]} onOpenRecord={(id) => onOpenTopic(selected.id, id)} onRefresh={() => void refresh()} /></section>)}
          {selected.actors.length ? <section><h3>Work By Actor</h3>{selected.actors.map(({ identity, activities }) => <section key={identity.sessionId}><SessionGraphIdentityView identity={identity} /><RecordGroup api={api} sessionId={sessionId} revision={overview.revision} topicId={selected.id} category="activities" actorSessionId={identity.sessionId} group={activities} onOpenRecord={(id) => onOpenTopic(selected.id, id)} onRefresh={() => void refresh()} /></section>)}</section> : null}
          {(overview.topicRelations.filter((edge) => edge.fromTopicId === selected.id || edge.toTopicId === selected.id).length > 0) ? <section><h3>Record Relations Across Topics</h3>{overview.topicRelations.filter((edge) => edge.fromTopicId === selected.id || edge.toTopicId === selected.id).map((edge) => <button type="button" className="topic-overview-related" data-topic-relation={relationId(edge)} key={relationId(edge)} onClick={(event) => openRelation(edge, event.currentTarget)}>{topicName(edge.fromTopicId)} → {topicName(edge.toTopicId)}<small>{relationLabel(edge)}</small></button>)}</section> : null}
        </> : null}
      </aside> : null}
    </div>
  </section>;
}
