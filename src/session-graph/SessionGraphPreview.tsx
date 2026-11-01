import { useRef, useState, type ReactNode } from "react";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphViewState } from "../../src-shared/session-graph/session-graph-window-contract.js";
import { BackNavigationButton } from "../ui/back-navigation-button.js";
import { SessionGraphTopicView, defaultSessionGraphViewState, type SessionGraphTopicMemory } from "./SessionGraphTopicView.js";

export { defaultSessionGraphViewState, sessionGraphStatuses } from "./SessionGraphTopicView.js";
export type SessionGraphPreviewMemory = {
  topic?: SessionGraphTopicMemory;
  overview?: SessionGraphTopicMemory;
};

export function SessionGraphPreview({ api, sessionId, onOpenPath, initialState = defaultSessionGraphViewState,
  onStateChange, onOpenWindow, toolbarActions, initialMemory, onMemoryChange }: {
  api: Pick<WithMateWindowApi, "readSessionGraph" | "subscribeSessionGraph">;
  sessionId: string;
  onOpenPath(target: string): void;
  initialState?: SessionGraphViewState;
  onStateChange?(state: SessionGraphViewState): void;
  onOpenWindow?(state: SessionGraphViewState): void;
  toolbarActions?: ReactNode;
  initialMemory?: SessionGraphPreviewMemory | null;
  onMemoryChange?(memory: SessionGraphPreviewMemory): void;
}) {
  const [topicState, setTopicState] = useState(initialState);
  const overviewState = useRef<SessionGraphViewState>(initialState.topicId === null ? initialState : {
    ...defaultSessionGraphViewState, ...initialState.overview,
  });
  const memory = useRef<SessionGraphPreviewMemory>(initialMemory ?? {});
  const saveMemory = () => onMemoryChange?.(memory.current);
  const withOverview = (state: SessionGraphViewState): SessionGraphViewState => {
    const { selectedId, zoom, scrollLeft, scrollTop, expandedTopicIds } = overviewState.current;
    return { ...state, overview: { selectedId, zoom, scrollLeft, scrollTop, expandedTopicIds } };
  };
  const publish = (state: SessionGraphViewState) => onStateChange?.(withOverview(state));
  const openWindow = onOpenWindow ? (state: SessionGraphViewState) => onOpenWindow(withOverview(state)) : undefined;
  const openTopic = (topicId: string) => {
    memory.current = { overview: memory.current.overview };
    saveMemory();
    const next = { ...defaultSessionGraphViewState, topicId };
    setTopicState(next);
    publish(next);
  };
  const backToTopics = () => {
    const next = overviewState.current;
    setTopicState(next);
    publish(next);
  };
  if (topicState.topicId !== null) return <SessionGraphTopicView key={topicState.topicId}
    api={api} sessionId={sessionId} initialState={topicState} initialMemory={memory.current.topic}
    onMemoryChange={(topic) => { memory.current.topic = topic; saveMemory(); }}
    onStateChange={publish}
    onOpenPath={onOpenPath}
    onOpenWindow={openWindow}
    toolbarActions={<><BackNavigationButton label="All Topics" showLabel onBack={backToTopics} />{toolbarActions}</>} />;
  return <SessionGraphTopicView key="all-topics" allTopics api={api} sessionId={sessionId} onFocusTopic={openTopic} onOpenPath={onOpenPath}
      initialState={overviewState.current} initialMemory={memory.current.overview}
      onStateChange={(state) => { overviewState.current = state; publish(state); }}
      onOpenWindow={openWindow} toolbarActions={toolbarActions}
      onMemoryChange={(overview) => { memory.current.overview = overview; saveMemory(); }} />;
}
