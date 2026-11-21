import { useCallback, useEffect, useRef, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { CONVERSATION_PAGE_SIZE, type ConversationPage } from "../../../src-shared/session/conversation-page.js";
import { conversationPeerKey, sentCardKey, type ConversationThread } from "../../../src-shared/session/conversation-threads.js";
import type { TurnInputReadContext } from "./turn-input-details.js";
import type { SentInstruction } from "./use-sent-deliveries.js";

export type ThreadJump = { id: number; item: SentInstruction; messageIndex: number | null; page?: ConversationPage };
export type ThreadSelection = { thread: ConversationThread; jump?: ThreadJump };

export function threadPageIndexes(thread: ConversationThread): number[] {
  return [...new Set([...thread.messageIndexes, ...thread.sent.flatMap(({ messageIndex }) =>
    messageIndex === null ? [] : [messageIndex])])].sort((a, b) => a - b);
}

export function useMainConversationThreads(context: TurnInputReadContext | undefined, enabled: boolean, historyRevision: string, beforeSwitch: () => void) {
  const target = context?.target;
  const owner = target?.kind === "main" && context?.ownerSessionId === target.sessionId ? conversationPeerKey(target) : "";
  const api = getWithMateApi();
  const canRead = Boolean(owner && api?.readSessionExecution && api.getConversationPage);
  const [state, setState] = useState<{ owner: string; threads: ConversationThread[]; error: string; loading: boolean }>();
  const [selected, setSelected] = useState<{ owner: string; value: ThreadSelection }>();
  const [revision, setRevision] = useState(0);
  const jumpRevision = useRef(0);
  const contentRevision = useRef(0);
  const currentHistoryRevision = useRef(historyRevision);
  currentHistoryRevision.current = historyRevision;
  const knownPeers = useRef<ConversationThread[]>([]);
  const currentOwner = useRef("");
  currentOwner.current = enabled && canRead ? owner : "";
  const read = useCallback(async () => {
    if (!context || !api?.readSessionExecution) throw new Error("Conversation reads are unavailable.");
    const result = await api.readSessionExecution(context.ownerSessionId, "read_conversation_threads", { target: context.target });
    if (!result.ok) throw new Error(result.message);
    return result.threads;
  }, [owner, api]);
  useEffect(() => {
    if (!enabled || !canRead) return;
    const invalidate = () => { ++contentRevision.current; setRevision((value) => value + 1); };
    const changed = (id: string) => { if (id === target?.sessionId) invalidate(); };
    const sent = api?.onSessionSentDeliveriesChanged?.(changed);
    const turns = api?.onSessionTurnUpdated?.(changed);
    const queue = api?.onSessionTurnQueueChanged?.(changed);
    const sessions = api?.subscribeSessionInvalidation?.((update) => {
      if (update.scope === "all" || update.sessionIds.some((id) => id === target?.sessionId
        || knownPeers.current.some(({ target: peer }) => peer.sessionId === id || peer.kind === "auxiliary" && peer.mainSessionId === id))) invalidate();
    });
    return () => { sent?.(); turns?.(); queue?.(); sessions?.(); };
  }, [owner, api, enabled, canRead]);
  useEffect(() => {
    if (!enabled || !canRead) return;
    let active = true;
    setState((previous) => ({ owner, threads: previous?.owner === owner ? previous.threads : [], error: "", loading: true }));
    void read().then((threads) => {
      if (active) { knownPeers.current = threads; setState({ owner, threads, error: "", loading: false }); }
    }, (error: unknown) => {
      if (active) setState((previous) => ({ owner, threads: previous?.owner === owner ? previous.threads : [], error: error instanceof Error ? error.message : "Could not load conversations.", loading: false }));
    });
    return () => { active = false; };
  }, [owner, enabled, canRead, read, revision, historyRevision]);
  useEffect(() => () => { ++jumpRevision.current; }, [owner, enabled, canRead]);
  const available = state?.owner === owner ? state : undefined;
  const threads = available?.threads ?? [];
  const selectedValue = selected?.owner === owner ? selected.value : undefined;
  const selectedId = selectedValue ? conversationPeerKey(selectedValue.thread.target) : "";
  const refreshed = threads.find((thread) => conversationPeerKey(thread.target) === selectedId);
  const selection = selectedValue && { ...selectedValue, thread: refreshed ?? selectedValue.thread };
  const select = (id: string) => {
    ++jumpRevision.current;
    if (id === selectedId) return;
    const thread = threads.find((entry) => conversationPeerKey(entry.target) === id);
    beforeSwitch();
    setSelected(thread ? { owner, value: { thread } } : undefined);
  };
  const openThread = useCallback(async (item: SentInstruction): Promise<string | undefined> => {
    const id = ++jumpRevision.current;
    const current = () => jumpRevision.current === id && owner === currentOwner.current;
    const content = contentRevision.current;
    const history = currentHistoryRevision.current;
    try {
      const verified = await read();
      if (!current()) return;
      const peer = conversationPeerKey(item.target);
      const thread = verified.find((entry) => conversationPeerKey(entry.target) === peer);
      const anchor = thread?.sent.find((entry) => entry.key === sentCardKey(item) && entry.turnId === item.sourceTurnId);
      if (!thread || !anchor) return "The destination or exact sent message is no longer available.";
      const index = anchor.messageIndex;
      let page: ConversationPage | undefined;
      if (index === null) {
        const live = await api?.getLiveSessionRun?.(context!.ownerSessionId);
        if (!current()) return;
        if (live?.sessionId !== context!.ownerSessionId || live.sessionTurnId !== anchor.turnId) {
          return "The saved position of this sent message is not known.";
        }
      } else {
        const indexes = threadPageIndexes(thread);
        const start = Math.max(0, indexes.indexOf(index) - Math.floor(CONVERSATION_PAGE_SIZE / 2));
        const loaded = await api?.getConversationPage(context!.ownerSessionId, { messageIndexes: indexes.slice(start, start + CONVERSATION_PAGE_SIZE) });
        if (!current()) return;
        if (!loaded || loaded.sessionId !== context!.ownerSessionId || loaded.incarnationId !== target?.incarnationId
          || !loaded.messages.some((message) => message.historyIndex === index)) return "Could not load the saved position of this sent message.";
        page = loaded;
      }
      if (content !== contentRevision.current || history !== currentHistoryRevision.current) {
        return "The conversation changed while opening this message. Try again.";
      }
      beforeSwitch();
      knownPeers.current = verified;
      setState({ owner, threads: verified, error: "", loading: false });
      setSelected({ owner, value: { thread, jump: { id, item: { ...item, sourceMessageSeq: index }, messageIndex: index, page } } });
    } catch (error) {
      if (current()) return error instanceof Error ? error.message : "Could not open this sent message.";
    }
  }, [read, owner, api, beforeSwitch]);
  return { canRead, threads, selection, selectedId, select, openThread, retry: () => { ++contentRevision.current; setRevision((value) => value + 1); },
    loading: available?.loading ?? canRead, error: available?.error || (selectedValue && !refreshed && !available?.loading ? "This conversation is no longer available." : "") };
}
