import { useEffect, useMemo, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { conversationPeerKey, type ConversationThread, type ConversationThreads } from "../../../src-shared/session/conversation-threads.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

export type MainConversationFrame = {
  child?: ConversationThread;
  children: ConversationThread[];
  messageIndexes: number[];
};

export function threadPageIndexes(frame: MainConversationFrame): number[] {
  const sent = frame.child?.sentMessageIndexes;
  return sent?.length ? [...new Set([...frame.messageIndexes, ...sent])].sort((a, b) => a - b) : frame.messageIndexes;
}

const EMPTY_CHILDREN: ConversationThread[] = [];

export function useMainConversationThreads(context: TurnInputReadContext | undefined, enabled: boolean, historyRevision: string, beforeSwitch: () => void) {
  const target = context?.target;
  const owner = target?.kind === "main" && context?.ownerSessionId === target.sessionId ? conversationPeerKey(target) : "";
  const api = getWithMateApi();
  const canRead = Boolean(owner && api?.readSessionExecution && api.getConversationPage);
  const [state, setState] = useState<{ owner: string; projection?: ConversationThreads; error: string; loading: boolean }>();
  const [selected, setSelected] = useState<{ owner: string; id: string }>();
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    if (!enabled || !canRead) return;
    const changed = (id: string) => { if (id === target?.sessionId) reload(); };
    const sent = api?.onSessionSentDeliveriesChanged?.(changed);
    const turns = api?.onSessionTurnUpdated?.(changed);
    const queue = api?.onSessionTurnQueueChanged?.(changed);
    // A new child may be the only ID in the invalidation and need not have sent anything.
    const sessions = api?.subscribeSessionInvalidation?.(reload);
    return () => { sent?.(); turns?.(); queue?.(); sessions?.(); };
  }, [owner, api, enabled, canRead]);
  useEffect(() => {
    if (!enabled || !context || !canRead || !api?.readSessionExecution) return;
    let active = true;
    const update = (loading: boolean, error: string) => setState((previous) => ({
      owner, projection: previous?.owner === owner ? previous.projection : undefined, error, loading,
    }));
    update(true, "");
    void api.readSessionExecution(context.ownerSessionId, "read_conversation_threads", { target: context.target }).then((result) => {
      if (!active) return;
      if (result.ok) setState({ owner, projection: result, error: "", loading: false });
      else update(false, result.message);
    }, (error: unknown) => {
      if (active) update(false, error instanceof Error ? error.message : "Could not load conversations.");
    });
    return () => { active = false; };
  }, [owner, api, enabled, canRead, revision, historyRevision]);

  const available = state?.owner === owner ? state : undefined;
  const projection = available?.projection;
  const children = projection?.children ?? EMPTY_CHILDREN;
  const child = selected?.owner === owner ? children.find((entry) => conversationPeerKey(entry.target) === selected.id) : undefined;
  const selectedId = child ? conversationPeerKey(child.target) : "";
  const frame = useMemo(() => projection?.children.length ? {
    child, children: projection.children, messageIndexes: child?.messageIndexes ?? projection.initialMessageIndexes,
  } : undefined, [child, projection]);
  const select = (id: string) => {
    if (id === selectedId || id && !children.some((entry) => conversationPeerKey(entry.target) === id)) return;
    beforeSwitch();
    setSelected({ owner, id });
  };
  return { canRead, ready: !canRead || !!projection, children, frame, selectedId, select, retry: reload,
    loading: available?.loading ?? canRead, error: available?.error ?? "" };
}
