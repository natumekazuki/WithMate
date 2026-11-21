import type { DatabaseSync } from "node:sqlite";
import { conversationPeerKey, sentCardKey, type ConversationThread } from "../../src-shared/session/conversation-threads.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";

type MainTarget = Extract<SessionTarget, { kind: "main" }>;
type Origin = {
  kind: string; operation: string;
  actorKind?: string; actorSessionId?: string; actorIncarnationId?: string; actorMainSessionId?: string; actorTurnId?: string;
  targetSessionId?: string; targetIncarnationId?: string;
  actorSnapshot?: { sessionTitle?: string }; targetSnapshot?: { sessionTitle?: string };
};
type Turn = { id: number; user_message_seq: number | null; assistant_message_seq: number | null };
type Receipt = { id: string; session_id: string; auxiliary_session_id: string | null; incarnation_id: string; turn_id: string | null; input_turn_id: string | null; user_message_seq: number | null; origin: string };

/** Read membership and exact card references, not another transcript or a delivery ledger. */
export function readConversationThreads(db: DatabaseSync, source: MainTarget): ConversationThread[] {
  const main = db.prepare("SELECT incarnation_id, title FROM sessions_v6 WHERE id = ?");
  const auxiliary = db.prepare("SELECT parent_session_id, created_at, title FROM auxiliary_sessions WHERE id = ?");
  const peers = new Map<string, { target: SessionTarget; title: string } | null>();
  const threads = new Map<string, ConversationThread>();
  const resolve = (kind: string | undefined, id: string | undefined, incarnation: string | undefined, parentId?: string) => {
    if (!id || !incarnation || id === source.sessionId || (kind !== "main" && kind !== "auxiliary")) return null;
    const key = JSON.stringify([kind, id, incarnation, parentId]);
    if (peers.has(key)) return peers.get(key)!;
    let peer = null;
    if (kind === "main") {
      const row = main.get(id) as { incarnation_id: string; title: string } | undefined;
      if ((row?.incarnation_id.trim() || (row ? `legacy:${id}` : null)) === incarnation) {
        peer = { target: { kind, sessionId: id, incarnationId: incarnation } as const, title: row!.title };
      }
    } else if (parentId) {
      const row = auxiliary.get(id) as { parent_session_id: string; created_at: string; title: string } | undefined;
      const parent = main.get(parentId) as { incarnation_id: string } | undefined;
      if (row?.created_at === incarnation && row.parent_session_id === parentId && parent) {
        peer = { target: { kind, sessionId: id, incarnationId: incarnation, mainSessionId: parentId, mainIncarnationId: parent.incarnation_id.trim() || `legacy:${parentId}` } as const, title: row.title };
      }
    }
    peers.set(key, peer);
    return peer;
  };
  const threadFor = (peer: NonNullable<ReturnType<typeof resolve>>, fallbackTitle?: string) => {
    const key = conversationPeerKey(peer.target);
    let thread = threads.get(key);
    if (!thread) {
      thread = { target: peer.target, title: peer.title?.trim() || fallbackTitle?.trim() || "Unknown Session", messageIndexes: [], inboundTurnIds: [], sent: [] };
      threads.set(key, thread);
    }
    return thread;
  };
  const savedSequences = new Set((db.prepare("SELECT seq FROM session_messages_v6 WHERE session_id = ?")
    .all(source.sessionId) as { seq: number }[]).map(({ seq }) => seq));
  const saved = (seq: number | null) => seq !== null && savedSequences.has(seq) ? seq : null;
  const turns = new Map((db.prepare("SELECT id, user_message_seq, assistant_message_seq FROM session_turns_v6 WHERE session_id = ? AND auxiliary_session_id IS NULL")
    .all(source.sessionId) as Turn[]).map((turn) => [String(turn.id), turn]));
  const addSent = (thread: ConversationThread, turnId: string, key: string) => {
    const turn = turns.get(turnId);
    if (turn) thread.sent.push({ key, turnId, messageIndex: saved(turn.assistant_message_seq) ?? saved(turn.user_message_seq) });
  };
  const directOrigin = (origin: Origin) => origin.kind === "session";
  const receiptColumns = "id, session_id, auxiliary_session_id, incarnation_id, turn_id, input_turn_id, user_message_seq";
  const inbound = db.prepare(`SELECT ${receiptColumns}, json_extract(COALESCE(dispatched_json, accepted_json), '$.origin') AS origin
    FROM session_turn_queue_v6 WHERE session_id=? AND auxiliary_session_id IS NULL AND incarnation_id=? AND origin IS NOT NULL
    ORDER BY sequence`).iterate(source.sessionId, source.incarnationId) as Iterable<Receipt>;
  for (const row of inbound) {
    const origin: Origin = JSON.parse(row.origin);
    if (!directOrigin(origin) || origin.operation !== "send" || origin.targetSessionId !== source.sessionId || origin.targetIncarnationId !== source.incarnationId) continue;
    const peer = resolve(origin.actorKind, origin.actorSessionId, origin.actorIncarnationId, origin.actorMainSessionId);
    if (!peer) continue;
    const thread = threadFor(peer, origin.actorSnapshot?.sessionTitle);
    const seq = saved(row.user_message_seq);
    if (seq !== null) thread.messageIndexes.push(seq);
    // Only a recorded entry associates the ordinary Turn response with this peer.
    // A queued additional input is itself visible, not evidence that the response answers it.
    const turn = row.turn_id && row.input_turn_id === null ? turns.get(row.turn_id) : undefined;
    if (turn && (seq === null ? turn.user_message_seq === null && row.user_message_seq === null : turn.user_message_seq === seq)) {
      thread.inboundTurnIds.push(String(turn.id));
      const response = saved(turn.assistant_message_seq);
      if (response !== null) thread.messageIndexes.push(response);
    }
  }
  const outbound = db.prepare(`SELECT ${receiptColumns}, json_extract(accepted_json, '$.origin') AS origin
    FROM session_turn_queue_v6
    WHERE json_extract(accepted_json, '$.origin.kind')='session'
      AND json_extract(accepted_json, '$.origin.actorKind')='main'
      AND json_extract(accepted_json, '$.origin.actorSessionId')=?
      AND json_extract(accepted_json, '$.origin.actorIncarnationId')=? ORDER BY sequence`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<Receipt>;
  for (const row of outbound) {
    const origin: Origin = JSON.parse(row.origin);
    const id = row.auxiliary_session_id ?? row.session_id;
    if (origin.operation !== "send" || origin.targetSessionId !== id || origin.targetIncarnationId !== row.incarnation_id || !origin.actorTurnId || !turns.has(origin.actorTurnId)) continue;
    const peer = resolve(row.auxiliary_session_id ? "auxiliary" : "main", id, row.incarnation_id, row.auxiliary_session_id ? row.session_id : undefined);
    if (peer) addSent(threadFor(peer, origin.targetSnapshot?.sessionTitle), origin.actorTurnId, sentCardKey({ target: peer.target, receiptId: row.id }));
  }
  const steerFilter = `role='user' AND json_extract(body, '$.turnInput.queueId') IS NULL
      AND json_extract(body, '$.turnInput.origin.kind')='session'
      AND json_extract(body, '$.turnInput.origin.operation')='steer'
      AND json_extract(body, '$.turnInput.origin.actorKind')='main'`;
  const steer = db.prepare(`SELECT session_id, seq, json_extract(body, '$.turnInput.origin') AS origin
    FROM session_messages_v6 WHERE session_id=? AND ${steerFilter}
    UNION ALL
    SELECT session_id, seq, json_extract(body, '$.turnInput.origin') AS origin
    FROM session_messages_v6 WHERE ${steerFilter} AND session_id<>?
      AND json_extract(body, '$.turnInput.origin.actorSessionId')=?
      AND json_extract(body, '$.turnInput.origin.actorIncarnationId')=?`)
    .iterate(source.sessionId, source.sessionId, source.sessionId, source.incarnationId) as Iterable<{ session_id: string; seq: number; origin: string }>;
  for (const row of steer) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.targetSessionId !== row.session_id) continue;
    if (row.session_id === source.sessionId && origin.targetIncarnationId === source.incarnationId) {
      const peer = resolve("main", origin.actorSessionId, origin.actorIncarnationId);
      if (peer) threadFor(peer, origin.actorSnapshot?.sessionTitle).messageIndexes.push(row.seq);
    } else if (origin.actorTurnId && turns.has(origin.actorTurnId)) {
      const peer = resolve("main", row.session_id, origin.targetIncarnationId);
      if (peer) addSent(threadFor(peer, origin.targetSnapshot?.sessionTitle), origin.actorTurnId, sentCardKey({ target: peer.target, messageSeq: row.seq }));
    }
  }
  return [...threads.values()].map((thread) => ({
    ...thread,
    messageIndexes: [...new Set(thread.messageIndexes)].sort((a, b) => a - b),
    inboundTurnIds: [...new Set(thread.inboundTurnIds)],
  }));
}
