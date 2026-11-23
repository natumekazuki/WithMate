import type { DatabaseSync } from "node:sqlite";
import type { ConversationThread, ConversationThreads } from "../../src-shared/session/conversation-threads.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { mainSessionTargetSchema } from "../../src-shared/session/session-target.js";
import { sessionReplySchema } from "../../src-shared/session/session-reply.js";
import { MAIN_SESSION_CHARACTER_AND_RUN_COLUMNS } from "../session/session-storage-v6.js";

type MainTarget = Extract<SessionTarget, { kind: "main" }>;
type Origin = {
  kind: string; operation: string;
  actorKind?: string; actorSessionId?: string; actorIncarnationId?: string; actorTurnId?: string;
  targetSessionId?: string; targetIncarnationId?: string;
};
type Turn = { id: number; phase: string; user_message_seq: number | null; assistant_message_seq: number | null };
type Inbound = { turn_id: string | null; input_turn_id: string | null; user_message_seq: number | null; created_at: string; origin: string };
type Outbound = { session_id: string; incarnation_id: string; created_at: string; origin: string };

/** Project the saved Main history; creating or selecting a frame does not create a transcript. */
export function readConversationThreads(db: DatabaseSync, source: MainTarget): ConversationThreads {
  const childRows = db.prepare(`SELECT s.id, s.incarnation_id, s.title, ${MAIN_SESSION_CHARACTER_AND_RUN_COLUMNS}
    FROM sessions_v6 s JOIN sessions_v6 parent ON parent.id = s.parent_session_id
    WHERE parent.id = ? AND s.created_by_session_id = parent.id
      AND s.root_session_id = COALESCE(NULLIF(TRIM(parent.root_session_id), ''), parent.id)
      AND s.session_kind = 'default' AND s.session_role IN ('task-coordinator', 'executor')
    ORDER BY s.created_at, s.id`).all(source.sessionId) as {
      id: string; incarnation_id: string; title: string;
      character_name: unknown; character_icon_path: unknown; run_state: unknown;
    }[];
  const children = new Map(childRows.map((row): [string, ConversationThread] => [row.id, {
    target: { kind: "main", sessionId: row.id, incarnationId: row.incarnation_id.trim() || `legacy:${row.id}` },
    title: row.title,
    character: {
      name: typeof row.character_name === "string" ? row.character_name : "",
      iconPath: typeof row.character_icon_path === "string" ? row.character_icon_path : "",
    },
    isProcessing: row.run_state === "running",
    messageIndexes: [], inboundTurnIds: [], sentMessageIndexes: [],
  }]));
  const savedRows = db.prepare("SELECT seq, created_at FROM session_messages_v6 WHERE session_id = ? ORDER BY seq")
    .all(source.sessionId) as { seq: number; created_at: string }[];
  const savedMessages = savedRows.map(({ seq }) => seq);
  if (!children.size) return { initialMessageIndexes: savedMessages, children: [] };

  const savedTimestamps = new Map(savedRows.map(({ seq, created_at }) => [seq, created_at]));
  const saved = (seq: number | null) => seq !== null && savedTimestamps.has(seq) ? seq : null;
  // Only records belonging to this frame contribute; Session metadata and run state do not.
  const touch = (frame: ConversationThread, timestamp: string | undefined) => {
    const time = timestamp === undefined ? NaN : Date.parse(timestamp);
    if (Number.isFinite(time) && (frame.lastActivityAt === undefined || time > frame.lastActivityAt)) frame.lastActivityAt = time;
  };
  const turns = new Map((db.prepare("SELECT id, phase, user_message_seq, assistant_message_seq FROM session_turns_v6 WHERE session_id = ? AND auxiliary_session_id IS NULL")
    .all(source.sessionId) as Turn[]).map((turn) => [String(turn.id), turn]));
  const child = (id: string | undefined, incarnationId: string | undefined) => {
    const frame = id && children.get(id);
    return frame && frame.target.incarnationId === incarnationId ? frame : undefined;
  };
  const addSent = (frame: ConversationThread, turnId: string | undefined, timestamp: string) => {
    const turn = turnId && turns.get(turnId);
    if (!turn) return;
    const index = saved(turn.assistant_message_seq) ?? saved(turn.user_message_seq);
    if (index !== null) frame.sentMessageIndexes.push(index);
    touch(frame, timestamp);
  };
  const receivedHere = (origin: Origin) => origin.targetSessionId === source.sessionId && origin.targetIncarnationId === source.incarnationId;

  const inbound = db.prepare(`SELECT turn_id, input_turn_id, user_message_seq, created_at,
      json_extract(COALESCE(dispatched_json, accepted_json), '$.origin') AS origin
    FROM session_turn_queue_v6 WHERE session_id=? AND auxiliary_session_id IS NULL AND incarnation_id=? AND origin IS NOT NULL`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<Inbound>;
  for (const row of inbound) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.kind !== "session" || origin.operation !== "send" || origin.actorKind !== "main" || !receivedHere(origin)) continue;
    const frame = child(origin.actorSessionId, origin.actorIncarnationId);
    if (!frame) continue;
    const seq = saved(row.user_message_seq);
    touch(frame, row.created_at);
    if (seq !== null) {
      frame.messageIndexes.push(seq);
      touch(frame, savedTimestamps.get(seq));
    }
    // A queued additional input belongs to its own sender, not the Turn's ordinary response.
    const turn = row.turn_id && row.input_turn_id === null ? turns.get(row.turn_id) : undefined;
    if (turn && turn.user_message_seq === row.user_message_seq && (seq !== null || row.user_message_seq === null)) {
      frame.inboundTurnIds.push(String(turn.id));
      const response = saved(turn.assistant_message_seq);
      if (response !== null) {
        frame.messageIndexes.push(response);
        touch(frame, savedTimestamps.get(response));
      }
    }
  }

  // Preview.3 did not record the viewed frame. Follow only a saved message in
  // this exact transcript, from older to newer input so reply chains resolve once.
  const membership = new Map<number, ConversationThread | null>();
  for (const frame of children.values()) {
    for (const seq of frame.messageIndexes) {
      if (!membership.has(seq)) membership.set(seq, frame);
      else if (membership.get(seq) !== frame) membership.set(seq, null);
    }
  }
  const gui = db.prepare(`SELECT q.turn_id, q.user_message_seq, q.created_at,
      q.accepted_json -> '$.request.mainConversationFrame' AS frame,
      m.body -> '$.replyTo' AS reply
    FROM session_turn_queue_v6 q
    JOIN session_messages_v6 m ON m.session_id=q.session_id AND m.seq=q.user_message_seq AND m.role='user'
    WHERE q.session_id=? AND q.incarnation_id=? AND q.auxiliary_session_id IS NULL AND q.input_turn_id IS NULL
      AND json_extract(q.accepted_json, '$.origin.kind')='gui'
      AND json_extract(q.accepted_json, '$.origin.operation')='send'
      AND json_extract(q.accepted_json, '$.origin.targetSessionId')=q.session_id
      AND json_extract(q.accepted_json, '$.origin.targetIncarnationId')=q.incarnation_id
      AND json_extract(q.accepted_json, '$.request.submitSource')='composer'
      AND json_extract(q.accepted_json, '$.retrySource') IS NULL
    ORDER BY q.user_message_seq`).iterate(source.sessionId, source.incarnationId) as Iterable<{
      turn_id: string | null; user_message_seq: number; created_at: string; frame: string | null; reply: string | null;
    }>;
  const readAssistant = db.prepare("SELECT 1 FROM session_messages_v6 WHERE session_id=? AND seq=? AND role='assistant'");
  for (const row of gui) {
    const turn = row.turn_id && turns.get(row.turn_id);
    if (!turn || turn.user_message_seq !== row.user_message_seq || membership.has(row.user_message_seq)) continue;
    let frame: ConversationThread | undefined;
    if (row.frame !== null) {
      const target = mainSessionTargetSchema.nullable().safeParse(JSON.parse(row.frame));
      if (target.success && target.data) frame = child(target.data.sessionId, target.data.incarnationId);
    } else if (row.reply !== null) {
      const reply = sessionReplySchema.safeParse(JSON.parse(row.reply));
      if (reply.success && "seq" in reply.data) {
        const reference = reply.data;
        const final = reference.finalAnswerTurnId ? turns.get(reference.finalAnswerTurnId) : undefined;
        if (reference.target.kind === "main" && reference.target.sessionId === source.sessionId
          && reference.target.incarnationId === source.incarnationId && reference.seq < row.user_message_seq
          && (reference.finalAnswerTurnId === undefined
            || final?.phase === "completed" && final.assistant_message_seq === reference.seq
              && readAssistant.get(source.sessionId, reference.seq))) {
          frame = membership.get(reference.seq) ?? undefined;
        }
      }
    }
    if (!frame) continue;
    frame.inboundTurnIds.push(String(turn.id));
    touch(frame, row.created_at);
    for (const seq of [row.user_message_seq, saved(turn.assistant_message_seq)]) {
      if (seq === null || membership.has(seq)) continue;
      membership.set(seq, frame);
      frame.messageIndexes.push(seq);
      touch(frame, savedTimestamps.get(seq));
    }
  }

  const outbound = db.prepare(`SELECT session_id, incarnation_id, created_at, json_extract(accepted_json, '$.origin') AS origin
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
    if (frame) addSent(frame, origin.actorTurnId, row.created_at);
  }

  // A direct Steer is saved at the child, not as a source receipt or as the child's reply.
  const steer = db.prepare(`SELECT session_id, created_at, json_extract(body, '$.turnInput.origin') AS origin
    FROM session_messages_v6 WHERE role='user' AND json_extract(body, '$.turnInput.queueId') IS NULL
      AND json_extract(body, '$.turnInput.origin.kind')='session'
      AND json_extract(body, '$.turnInput.origin.operation')='steer'
      AND json_extract(body, '$.turnInput.origin.actorKind')='main'
      AND json_extract(body, '$.turnInput.origin.actorSessionId')=?
      AND json_extract(body, '$.turnInput.origin.actorIncarnationId')=?`)
    .iterate(source.sessionId, source.incarnationId) as Iterable<{ session_id: string; created_at: string; origin: string }>;
  for (const row of steer) {
    const origin: Origin = JSON.parse(row.origin);
    if (origin.targetSessionId !== row.session_id) continue;
    const frame = child(row.session_id, origin.targetIncarnationId);
    if (frame) addSent(frame, origin.actorTurnId, row.created_at);
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
