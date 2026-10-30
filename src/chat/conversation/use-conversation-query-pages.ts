import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONVERSATION_QUERY_PAGE_SIZE, type ConversationQueryCancelRequest, type ConversationQueryOutcome, type ConversationQueryRequest, type ConversationQueryPage } from "../../../src-shared/session/conversation-page.js";

type Attempt<T> = {
  identity: string;
  requestId: string;
  producerId: string;
  pages: Map<number, ConversationQueryPage<T>>;
  header?: ConversationQueryPage<T>;
  pending: Set<number>;
  active: boolean;
};

/** A displayed query owns only the current result page and its two neighbours. */
export function useConversationQueryPages<T>({ identity, enabled, ordinal, read, cancel }: {
  identity: string;
  enabled: boolean;
  ordinal: number;
  read?: (request: ConversationQueryRequest) => Promise<ConversationQueryOutcome<T>>;
  cancel?: (request: ConversationQueryCancelRequest) => Promise<void>;
}) {
  const [producerId] = useState(() => crypto.randomUUID());
  const [revision, setRevision] = useState(0);
  const [renderVersion, redraw] = useState(0);
  const attemptRef = useRef<Attempt<T> | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const offset = Math.floor(Math.max(0, ordinal) / CONVERSATION_QUERY_PAGE_SIZE) * CONVERSATION_QUERY_PAGE_SIZE;
  const desiredOffset = useRef(offset);
  desiredOffset.current = offset;
  const fetchPage = useCallback(async (attempt: Attempt<T>, start: number) => {
    if (!attempt.active || attempt.pending.size >= 3 || attempt.pending.has(start) || attempt.pages.has(start) || !readRef.current) return;
    attempt.pending.add(start);
    redraw((value) => value + 1);
    try {
      const first = attempt.header;
      const outcome = await readRef.current({ requestId: attempt.requestId, producerId: attempt.producerId, offset: start, stamp: first?.stamp });
      if (!attempt.active || attemptRef.current !== attempt) return;
      if (outcome.status !== "complete") {
        attempt.active = false;
        setFailure({ identity: attempt.identity, message: outcome.status === "invalidated" ? "Messages Changed. Retry The Query." : "Query Canceled. Retry To Continue." });
        return;
      }
      attempt.pages.set(start, outcome);
      attempt.header = { ...outcome, items: [] };
      for (const key of attempt.pages.keys()) {
        if (Math.abs(key - desiredOffset.current) > CONVERSATION_QUERY_PAGE_SIZE) attempt.pages.delete(key);
      }
    } catch (error) {
      if (attempt.active && attemptRef.current === attempt) setFailure({ identity: attempt.identity, message: error instanceof Error ? error.message : String(error) });
    } finally {
      attempt.pending.delete(start);
      if (attemptRef.current === attempt && attempt.active) redraw((value) => value + 1);
    }
  }, []);
  useEffect(() => {
    setFailure(null);
    if (!enabled || !read) { attemptRef.current = null; return; }
    const attempt: Attempt<T> = { identity, requestId: crypto.randomUUID(), producerId, pages: new Map(), pending: new Set(), active: true };
    attemptRef.current = attempt;
    void fetchPage(attempt, 0);
    return () => {
      attempt.active = false;
      void cancelRef.current?.({ requestId: attempt.requestId, producerId }).catch(() => {});
    };
  }, [identity, enabled, !!read, revision, producerId, fetchPage]);
  const attempt = enabled && attemptRef.current?.identity === identity ? attemptRef.current : null;
  const page = attempt?.header;
  const totalCount = page?.totalCount ?? 0;
  const currentFailure = failure?.identity === identity ? failure.message : "";
  useEffect(() => {
    if (!attempt?.active || !page || failure?.identity === identity) return;
    let pruned = false;
    for (const key of attempt.pages.keys()) if (Math.abs(key - offset) > CONVERSATION_QUERY_PAGE_SIZE) { attempt.pages.delete(key); pruned = true; }
    if (pruned) redraw((value) => value + 1);
    for (const start of [offset, offset - CONVERSATION_QUERY_PAGE_SIZE, offset + CONVERSATION_QUERY_PAGE_SIZE]) {
      if (start >= 0 && start < totalCount) void fetchPage(attempt, start);
    }
  }, [attempt, offset, totalCount, !!page, failure, identity, fetchPage, renderVersion]);
  return {
    items: useMemo(() => {
      if (!attempt) return [];
      const pages = [...attempt.pages.entries()].sort(([a], [b]) => a - b);
      const items: T[] = [];
      let previous: number | undefined;
      for (const [start, value] of pages) {
        if (previous !== undefined && start !== previous + CONVERSATION_QUERY_PAGE_SIZE) break;
        items.push(...value.items);
        previous = start;
      }
      return items;
    }, [attempt, renderVersion]),
    offset: attempt?.pages.size ? Math.min(...attempt.pages.keys()) : 0,
    totalCount,
    anchorOrdinal: page?.anchorOrdinal,
    messageCount: page?.messageCount,
    loading: enabled && !!read && !currentFailure && (!page || !!attempt?.pending.has(offset)),
    error: currentFailure,
    itemAt: (index: number): T | undefined => {
      const start = Math.floor(index / CONVERSATION_QUERY_PAGE_SIZE) * CONVERSATION_QUERY_PAGE_SIZE;
      return attempt?.pages.get(start)?.items[index - start];
    },
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
