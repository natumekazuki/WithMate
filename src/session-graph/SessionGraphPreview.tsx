import { useRef, useState, type ReactNode } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import { SessionGraphTopicView, defaultSessionGraphViewState, type SessionGraphTopicMemory } from "./SessionGraphTopicView.js";
import { SessionGraphOverview, defaultSessionGraphOverviewState, type SessionGraphOverviewMemory, type SessionGraphOverviewState } from "./SessionGraphOverview.js";

export { defaultSessionGraphViewState, sessionGraphStatuses } from "./SessionGraphTopicView.js";
export type SessionGraphPreviewMemory = {
  topic?: SessionGraphTopicMemory;
  overview?: SessionGraphOverviewMemory;
};

export function SessionGraphPreview({ api, sessionId, onClose, onOpenPath, initialState = defaultSessionGraphViewState,
  onStateChange, onOpenWindow, toolbarActions, initialMemory, onMemoryChange }: {
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
  const [topicState, setTopicState] = useState(initialState);
  const overviewState = useRef<SessionGraphOverviewState>(initialState.overview ?? {
    ...defaultSessionGraphOverviewState,
    ...(initialState.topicId === null ? { zoom: initialState.zoom, scrollLeft: initialState.scrollLeft, scrollTop: initialState.scrollTop } : {}),
  });
  const memory = useRef<SessionGraphPreviewMemory>(initialMemory ?? {});
  const saveMemory = () => onMemoryChange?.(memory.current);
  const publish = (state: SessionGraphViewState) => onStateChange?.({ ...state, overview: overviewState.current });
  const openTopic = (topicId: string, recordId?: string) => {
    memory.current = { overview: memory.current.overview };
    saveMemory();
    const next = { ...defaultSessionGraphViewState, topicId, selectedId: recordId ?? null };
    setTopicState(next);
    publish(next);
  };
  const backToTopics = () => {
    const { zoom, scrollLeft, scrollTop } = overviewState.current;
    const next = { ...defaultSessionGraphViewState, zoom, scrollLeft, scrollTop };
    setTopicState(next);
    publish(next);
  };
  if (topicState.topicId !== null) return <SessionGraphTopicView key={topicState.topicId}
    api={api} sessionId={sessionId} initialState={topicState} initialMemory={memory.current.topic}
    onMemoryChange={(topic) => { memory.current.topic = topic; saveMemory(); }}
    onStateChange={publish}
    onOpenPath={onOpenPath} onClose={onClose}
    onOpenWindow={onOpenWindow ? (state) => onOpenWindow({ ...state, overview: overviewState.current }) : undefined}
    toolbarActions={<><BackNavigationButton label="All Topics" showLabel onBack={backToTopics} />{toolbarActions}</>} />;
  return <section className="session-graph-preview" aria-label="Session Graph">
    <header className="session-graph-toolbar">
      {onClose ? <BackNavigationButton label="Back To Chat" onBack={onClose} /> : null}
      <strong>All Topics</strong>
      {toolbarActions}
    </header>
    <SessionGraphOverview api={api} sessionId={sessionId} onOpenTopic={openTopic}
      initialState={overviewState.current} initialMemory={memory.current.overview}
      onStateChange={(state) => { overviewState.current = state; publish({ ...defaultSessionGraphViewState, zoom: state.zoom, scrollLeft: state.scrollLeft, scrollTop: state.scrollTop }); }}
      onMemoryChange={(overview) => { memory.current.overview = overview; saveMemory(); }} />
  </section>;
}
