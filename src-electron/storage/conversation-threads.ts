import type { DatabaseSync } from "node:sqlite";
import type { ConversationThread, ConversationThreads } from "../../src-shared/session/conversation-threads.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";

type MainTarget = Extract<SessionTarget, { kind: "main" }>;
type Origin = {
  kind: string; operation: string;
  actorKind?: string; actorSessionId?: string; actorIncarnationId?: string; actorTurnId?: string;
  targetSessionId?: string; targetIncarnationId?: string;
};
type Turn = { id: number; user_message_seq: number | null; assistant_message_seq: number | null };
type Inbound = { turn_id: string | null; input_turn_id: string | null; user_message_seq: number | null; origin: string };
type Outbound = { session_id: string; incarnation_id: string; origin: string };

/** Project the saved Main history; creating or selecting a frame does not create a transcript. */
export function readConversationThreads(db: DatabaseSync, source: MainTarget): ConversationThreads {
  const childRows = db.prepare(`SELECT child.id, child.incarnation_id, child.title
    FROM sessions_v6 child JOIN sessions_v6 parent ON parent.id = child.parent_session_id
    WHERE parent.id = ? AND child.created_by_session_id = parent.id
      AND child.root_session_id = COALESCE(NULLIF(TRIM(parent.root_session_id), ''), parent.id)
      AND child.session_kind = 'default' AND child.session_role IN ('task-coordinator', 'executor')
    ORDER BY child.created_at, child.id`).all(source.sessionId) as { id: string; incarnation_id: string; title: string }[];
  const children = new Map(childRows.map((row): [string, ConversationThread] => [row.id, {
    target: { kind: "main", sessionId: row.id, incarnationId: row.incarnation_id.trim() || `legacy:${row.id}` },
    title: row.title, messageIndexes: [], inboundTurnIds: [], sentMessageIndexes: [],
  }]));
  const savedMessages = (db.prepare("SELECT seq FROM session_messages_v6 WHERE session_id = ? ORDER BY seq")
    .all(source.sessionId) as { seq: number }[]).map(({ seq }) => seq);
  if (!children.size) return { initialMessageIndexes: savedMessages, children: [] };

  const savedSequences = new Set(savedMessages);
  const saved = (seq: number | null) => seq !== null && savedSequences.has(seq) ? seq : null;
  const turns = new Map((db.prepare("SELECT id, user_message_seq, assistant_message_seq FROM session_turns_v6 WHERE session_id = ? AND auxiliary_session_id IS NULL")
    .all(source.sessionId) as Turn[]).map((turn) => [String(turn.id), turn]));
  const child = (id: string | undefined, incarnationId: string | undefined) => {
    const frame = id && children.get(id);
    return frame && frame.target.incarnationId === incarnationId ? frame : undefined;
  };
  const addSent = (frame: ConversationThread, turnId: string | undefined) => {
    const turn = turnId && turns.get(turnId);
    if (!turn) return;
    const index = saved(turn.assistant_message_seq) ?? saved(turn.user_message_seq);
    if (index !== null) frame.sentMessageIndexes.push(index);
  };
  const receivedHere = (origin: Origin) => origin.targetSessionId === source.sessionId && origin.targetIncarnationId === source.incarnationId;

  const inbound = db.prepare(`SELECT turn_id, input_turn_id, user_message_seq,
      json_extract(COALESCE(dispatched_json, accepted_json), '$.origin') AS origin
    FROM session_turn_queue_v6 WHERE session_id=? AND auxiliary_session_id IS NULL AND incarnation_id=? AND origin IS NOT NULL`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<Inbound>;
  for (const row of inbound) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.kind !== "session" || origin.operation !== "send" || origin.actorKind !== "main" || !receivedHere(origin)) continue;
    const frame = child(origin.actorSessionId, origin.actorIncarnationId);
    if (!frame) continue;
    const seq = saved(row.user_message_seq);
    if (seq !== null) frame.messageIndexes.push(seq);
    // A queued additional input belongs to its own sender, not the Turn's ordinary response.
    const turn = row.turn_id && row.input_turn_id === null ? turns.get(row.turn_id) : undefined;
    if (turn && turn.user_message_seq === row.user_message_seq && (seq !== null || row.user_message_seq === null)) {
      frame.inboundTurnIds.push(String(turn.id));
      const response = saved(turn.assistant_message_seq);
      if (response !== null) frame.messageIndexes.push(response);
    }
  }

  const outbound = db.prepare(`SELECT session_id, incarnation_id, json_extract(accepted_json, '$.origin') AS origin
    FROM session_turn_queue_v6
    WHERE auxiliary_session_id IS NULL AND json_extract(accepted_json, '$.origin.kind')='session'
      AND json_extract(accepted_json, '$.origin.actorKind')='main'
      AND json_extract(accepted_json, '$.origin.actorSessionId')=?
      AND json_extract(accepted_json, '$.origin.actorIncarnationId')=?`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<Outbound>;
  for (const row of outbound) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.operation !== "send" || origin.targetSessionId !== row.session_id || origin.targetIncarnationId !== row.incarnation_id) continue;
    const frame = child(row.session_id, row.incarnation_id);
    if (frame) addSent(frame, origin.actorTurnId);
  }

  // A direct Steer is saved at the child, not as a source receipt or as the child's reply.
  const steer = db.prepare(`SELECT session_id, json_extract(body, '$.turnInput.origin') AS origin
    FROM session_messages_v6 WHERE role='user' AND json_extract(body, '$.turnInput.queueId') IS NULL
      AND json_extract(body, '$.turnInput.origin.kind')='session'
      AND json_extract(body, '$.turnInput.origin.operation')='steer'
      AND json_extract(body, '$.turnInput.origin.actorKind')='main'
      AND json_extract(body, '$.turnInput.origin.actorSessionId')=?
      AND json_extract(body, '$.turnInput.origin.actorIncarnationId')=?`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<{ session_id: string; origin: string }>;
  for (const row of steer) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.targetSessionId !== row.session_id) continue;
    const frame = child(row.session_id, origin.targetIncarnationId);
    if (frame) addSent(frame, origin.actorTurnId);
  }

  const assigned = new Set([...children.values()].flatMap((frame) => frame.messageIndexes));
  const indexes = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  return {
    initialMessageIndexes: savedMessages.filter((seq) => !assigned.has(seq)),
    children: [...children.values()].map((frame) => ({
      ...frame,
      messageIndexes: indexes(frame.messageIndexes),
      inboundTurnIds: [...new Set(frame.inboundTurnIds)],
      sentMessageIndexes: indexes(frame.sentMessageIndexes),
    })),
  };
}
