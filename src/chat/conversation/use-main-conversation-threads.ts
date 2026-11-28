import { useEffect, useMemo, useRef, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { conversationPeerKey, type ConversationThread, type ConversationThreads } from "../../../src-shared/session/conversation-threads.js";
import type { MainSessionTarget } from "../../../src-shared/session/session-target.js";
import type { TurnInputReadContext } from "./turn-input-details.js";

export type MainConversationFrame = {
  child?: ConversationThread;
  children: ConversationThread[];
  messageIndexes: number[];
};

export type MainConversationView = {
  main: MainSessionTarget;
  id: string;
  child: MainSessionTarget | null;
  projection?: ConversationThreads;
};

export function threadPageIndexes(frame: MainConversationFrame): number[] {
  const sent = frame.child?.sentMessageIndexes;
  return sent?.length ? [...new Set([...frame.messageIndexes, ...sent])].sort((a, b) => a - b) : frame.messageIndexes;
}

const EMPTY_CHILDREN: ConversationThread[] = [];
// 相手の ID には直列化した Session の対象情報を使い、予約済みのビュー ID とは区別する。
export const ALL_MAIN_THREADS_ID = "all-main-threads";

export function useMainConversationThreads(context: TurnInputReadContext | undefined, enabled: boolean, historyRevision: string, beforeSwitch: () => void) {
  const target = context?.target;
  const owner = target?.kind === "main" && context?.ownerSessionId === target.sessionId ? conversationPeerKey(target) : "";
  const api = getWithMateApi();
  const canRead = Boolean(owner && api?.readSessionExecution && api.getConversationPage);
  const [state, setState] = useState<{ owner: string; projection?: ConversationThreads; error: string; loading: boolean }>();
  const [selected, setSelected] = useState<{ owner: string; id: string }>();
  const requestRead = useRef<() => void>(undefined);
  useEffect(() => {
    if (!enabled || !canRead || !api || target?.kind !== "main") return;
    let active = true;
    let childSessionIds = new Set<string>();
    let changedDuringRead: Set<string> | undefined;
    let readAgain = false;
    const update = (loading: boolean, error: string) => setState((previous) => ({
      owner, projection: previous?.owner === owner ? previous.projection : undefined, error, loading,
    }));

    const read = async () => {
      if (!active) return;
      if (changedDuringRead) {
        readAgain = true;
        return;
      }
      update(true, "");
      do {
        readAgain = false;
        const changedIds = changedDuringRead = new Set<string>();
        try {
          const result = await api.readSessionExecution(target.sessionId, "read_conversation_threads", { target });
          if (!active) return;
          if (result.ok) {
            childSessionIds = new Set(result.children.map(({ target: child }) => child.sessionId));
            // スナップショット取得後、ここで子の ID が分かる前に、その子の状態が変わる場合がある。
            readAgain ||= result.children.some(({ target: child }) => changedIds.has(child.sessionId));
            if (!readAgain) setState({ owner, projection: result, error: "", loading: false });
          } else if (!readAgain) {
            update(false, result.message);
          }
        } catch (error) {
          if (!active) return;
          if (!readAgain) update(false, error instanceof Error ? error.message : "Could not load conversations.");
        }
      } while (readAgain);
      changedDuringRead = undefined;
    };
    const reload = () => { void read(); };
    const changed = (id: string) => { if (id === target.sessionId) reload(); };
    const affectsProjection = (id: string) => id === target.sessionId || childSessionIds.has(id);
    const changedPeer = (id: string) => {
      if (affectsProjection(id)) reload();
      else changedDuringRead?.add(id);
    };
    const sent = api.onSessionSentDeliveriesChanged?.(changed);
    const turns = api.onSessionTurnUpdated?.(changedPeer);
    const queue = api.onSessionTurnQueueChanged?.(changed);
    // 新しい直接の子を公開すると、ここでその子の ID が分かる前に親の投影が無効になる。
    const sessions = api.subscribeSessionInvalidation?.((event) => {
      if (event.scope === "all" || event.sessionIds.some(affectsProjection)) reload();
      else for (const id of event.sessionIds) changedDuringRead?.add(id);
    });
    requestRead.current = reload;
    return () => {
      active = false;
      requestRead.current = undefined;
      sent?.(); turns?.(); queue?.(); sessions?.();
    };
  }, [owner, api, enabled, canRead]);
  // 履歴が変わったら現在の読み取り結果を無効にするが、購読は張り直さない。
  useEffect(() => { requestRead.current?.(); }, [owner, api, enabled, canRead, historyRevision]);

  const available = state?.owner === owner ? state : undefined;
  const projection = available?.projection;
  const children = useMemo(() => projection?.children.slice().sort((left, right) =>
    Number(right.hasUnreadResult === true) - Number(left.hasUnreadResult === true)
    || (right.lastActivityAt ?? Number.MIN_SAFE_INTEGER) - (left.lastActivityAt ?? Number.MIN_SAFE_INTEGER)
  ) ?? EMPTY_CHILDREN, [projection]);
  const requestedId = selected?.owner === owner ? selected.id : canRead ? ALL_MAIN_THREADS_ID : "";
  const showAllThreads = requestedId === ALL_MAIN_THREADS_ID;
  const child = children.find((entry) => conversationPeerKey(entry.target) === requestedId);
  const selectedId = showAllThreads ? ALL_MAIN_THREADS_ID : child ? conversationPeerKey(child.target) : "";
  const frame = useMemo(() => !showAllThreads && projection?.children.length ? {
    child, children: projection.children, messageIndexes: child?.messageIndexes ?? projection.initialMessageIndexes,
  } : undefined, [child, projection, showAllThreads]);
  const select = (id: string) => {
    if (id === selectedId || id && id !== ALL_MAIN_THREADS_ID && !children.some((entry) => conversationPeerKey(entry.target) === id)) return;
    beforeSwitch();
    setSelected({ owner, id });
  };
  return { canRead, ready: !canRead || !!projection, projection: available?.error ? undefined : projection, children, frame, selectedId, showAllThreads, select, retry: () => requestRead.current?.(),
    loading: available?.loading ?? canRead, error: available?.error ?? "" };
}
