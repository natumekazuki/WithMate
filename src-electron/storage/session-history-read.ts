import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_HISTORY_DEFAULT_LIST_LIMIT,
  SESSION_HISTORY_DEFAULT_OPERATION_LIST_LIMIT,
  SESSION_HISTORY_DEFAULT_ROW_LIMIT,
  SESSION_HISTORY_DEFAULT_TEXT_LIMIT,
  SESSION_HISTORY_PREVIEW_CHARS,
  type SessionHistoryErrorCode,
  type SessionHistoryReadInput,
  type SessionHistoryReadScope,
  type SessionHistoryRequest,
  type SessionHistoryResult,
} from "../../src-shared/session-history/session-history-contract.js";
import { normalizeMessage, type Message, type MessageArtifact } from "../../src-shared/session/session-state.js";

type Source = SessionHistoryReadScope["source"];
type Window = SessionHistoryReadScope["window"];
type Layout = { table: string; owner: string };
type MessageRow = { seq: number; role: string; body: string; artifact_body?: string | null };
type TurnRow = {
  id: number; phase: string; provider_id: string; model_id: string;
  user_message_seq: number | null; assistant_message_seq: number | null; error_summary: string;
};

function failure(code: SessionHistoryErrorCode, message: string): SessionHistoryResult {
  return { ok: false, code, message, effect: "none" };
}

function incarnationOf(id: string, value: string | null | undefined): string {
  return value?.trim() || `legacy:${id}`;
}

function checkSource(db: DatabaseSync, source: Source): SessionHistoryResult | null {
  if (source.kind === "main") {
    const row = db.prepare("SELECT incarnation_id FROM sessions_v6 WHERE id = ?").get(source.sessionId) as { incarnation_id: string | null } | undefined;
    if (!row) return failure("HISTORY_SOURCE_DELETED", "The source Session no longer exists.");
    return incarnationOf(source.sessionId, row.incarnation_id) === source.incarnationId ? null
      : failure("HISTORY_SOURCE_REPLACED", "The source Session was recreated after the history scope was fixed.");
  }
  const row = db.prepare(`SELECT a.created_at, a.parent_session_id, p.incarnation_id AS parent_incarnation
    FROM auxiliary_sessions a LEFT JOIN sessions_v6 p ON p.id = a.parent_session_id WHERE a.id = ?`).get(source.sessionId) as
    { created_at: string; parent_session_id: string; parent_incarnation: string | null } | undefined;
  if (!row || (row.parent_session_id === source.parentSessionId && row.parent_incarnation === null)) {
    return failure("HISTORY_SOURCE_DELETED", "The source Auxiliary Session or its parent no longer exists.");
  }
  return row.created_at === source.createdAt && row.parent_session_id === source.parentSessionId
    && incarnationOf(row.parent_session_id, row.parent_incarnation) === source.parentIncarnationId ? null
    : failure("HISTORY_SOURCE_REPLACED", "The source Auxiliary Session was recreated after the history scope was fixed.");
}

function decodeMessage(row: MessageRow, sessionId: string): Message {
  const message = normalizeMessage({ ...JSON.parse(row.body), role: row.role });
  if (!message) throw new Error(`Invalid history message: ${sessionId}:${row.seq}`);
  return message;
}

/** Turn linkage is the exact user/assistant sequence recorded on the turn; no other message is attributed to a turn. */
function readTurns(db: DatabaseSync, layout: Layout, sessionId: string, fromSeq: number, toSeq: number) {
  const rows = db.prepare(`SELECT id, phase, provider_id, model_id, user_message_seq, assistant_message_seq, error_summary
    FROM session_turns_v6 WHERE ${layout.owner} = ?
      AND (user_message_seq BETWEEN ? AND ? OR assistant_message_seq BETWEEN ? AND ?) ORDER BY id`)
    .all(sessionId, fromSeq, toSeq, fromSeq, toSeq) as TurnRow[];
  const bySeq = new Map<number, ReturnType<typeof toTurn>>();
  for (const row of rows) {
    if (row.user_message_seq !== null) bySeq.set(row.user_message_seq, toTurn(row));
    if (row.assistant_message_seq !== null) bySeq.set(row.assistant_message_seq, toTurn(row));
  }
  return bySeq;
}

function toTurn(row: TurnRow) {
  return {
    id: row.id, phase: row.phase, provider: row.provider_id, model: row.model_id,
    ...(row.phase === "failed" && row.error_summary ? { errorMessage: row.error_summary } : {}),
  };
}

function sliceText(text: string, offset: number, max: number) {
  let end = Math.min(text.length, offset + max);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && end > offset + 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}

function loadArtifact(row: MessageRow, sessionId: string): { artifact: MessageArtifact; detailSaved: boolean } | null {
  if (row.artifact_body !== null && row.artifact_body !== undefined) {
    const artifact = normalizeMessage({ role: "assistant", text: "", artifact: JSON.parse(row.artifact_body) })?.artifact;
    if (!artifact) throw new Error(`Invalid history artifact: ${sessionId}:${row.seq}`);
    return { artifact, detailSaved: true };
  }
  const summary = decodeMessage(row, sessionId).artifact;
  return summary ? { artifact: summary, detailSaved: false } : null;
}

function pageOf<T>(all: readonly T[], offset: number, limit: number): { offset: number; nextOffset: number | null; total: number; items: T[] } | null {
  if (offset > all.length) return null;
  const end = Math.min(all.length, offset + limit);
  return { offset, nextOffset: end < all.length ? end : null, total: all.length, items: all.slice(offset, end) };
}

export function readSessionHistory(db: DatabaseSync, input: SessionHistoryReadInput): SessionHistoryResult {
  const { source, window } = input.scope;
  const layout: Layout = source.kind === "main"
    ? { table: "session_messages_v6", owner: "session_id" } : { table: "auxiliary_session_messages", owner: "auxiliary_session_id" };
  const sourceFailure = checkSource(db, source);
  if (sourceFailure) return sourceFailure;
  const last = db.prepare(`SELECT MAX(seq) AS seq FROM ${layout.table} WHERE ${layout.owner} = ?`).get(source.sessionId) as { seq: number | null };
  if (last.seq === null || last.seq < window.toSeq) {
    return failure("HISTORY_RANGE_UNAVAILABLE", "The saved conversation is shorter than the permitted history range.");
  }
  if (input.operation === "list_messages") return listMessages(db, layout, source.sessionId, window, input.request as SessionHistoryRequest<"list_messages">);
  const request = input.request as { seq: number };
  if (request.seq < window.fromSeq || request.seq > window.toSeq) {
    return failure("HISTORY_OUT_OF_RANGE", "The requested message is outside the permitted history range.");
  }
  const row = db.prepare(`SELECT seq, role, body, artifact_body FROM ${layout.table} WHERE ${layout.owner} = ? AND seq = ?`).get(source.sessionId, request.seq) as MessageRow | undefined;
  if (!row) return failure("HISTORY_NOT_SAVED", "No message is saved at the requested position.");
  if (input.operation === "get_message") return getMessage(db, layout, source.sessionId, row, input.request as SessionHistoryRequest<"get_message">);
  const artifact = loadArtifact(row, source.sessionId);
  if (!artifact) return failure("HISTORY_NOT_SAVED", "The message has no saved operation record.");
  return input.operation === "list_operations"
    ? listOperations(request.seq, artifact, input.request as SessionHistoryRequest<"list_operations">)
    : getOperationDetail(request.seq, artifact, input.request as SessionHistoryRequest<"get_operation_detail">);
}

function listMessages(db: DatabaseSync, layout: Layout, sessionId: string, window: Window, request: SessionHistoryRequest<"list_messages">): SessionHistoryResult {
  const offset = request.offset ?? 0;
  const limit = request.limit ?? SESSION_HISTORY_DEFAULT_LIST_LIMIT;
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM ${layout.table} WHERE ${layout.owner} = ? AND seq BETWEEN ? AND ?`)
    .get(sessionId, window.fromSeq, window.toSeq) as { count: number }).count;
  if (offset > total) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the permitted history range.");
  const rows = db.prepare(`SELECT seq, role, body FROM ${layout.table} WHERE ${layout.owner} = ? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT ? OFFSET ?`)
    .all(sessionId, window.fromSeq, window.toSeq, limit, offset) as MessageRow[];
  const turns = readTurns(db, layout, sessionId, window.fromSeq, window.toSeq);
  const items = rows.map((row) => {
    const message = decodeMessage(row, sessionId);
    const preview = sliceText(message.text, 0, SESSION_HISTORY_PREVIEW_CHARS);
    return {
      seq: row.seq, role: message.role, turn: turns.get(row.seq) ?? null,
      textChars: preview.totalChars, textPreview: preview.text, textPreviewTruncated: preview.nextOffset !== null,
      artifact: message.artifact ? {
        operationCount: message.artifact.operationTimeline?.length ?? 0,
        changedFileCount: message.artifact.changedFiles.length, runCheckCount: message.artifact.runChecks.length,
      } : null,
      ...(message.isBookmarked ? { bookmarked: true } : {}),
    };
  });
  return {
    ok: true, window, total, offset, nextOffset: offset + items.length < total ? offset + items.length : null, items,
  };
}

function getMessage(db: DatabaseSync, layout: Layout, sessionId: string, row: MessageRow, request: SessionHistoryRequest<"get_message">): SessionHistoryResult {
  const message = decodeMessage(row, sessionId);
  const offset = request.offset ?? 0;
  if (offset > message.text.length) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the message text.");
  return {
    ok: true, seq: row.seq, role: message.role, turn: readTurns(db, layout, sessionId, row.seq, row.seq).get(row.seq) ?? null,
    ...sliceText(message.text, offset, request.maxChars ?? SESSION_HISTORY_DEFAULT_TEXT_LIMIT),
    ...(message.elicitationRecords?.length ? { elicitationRecords: message.elicitationRecords } : {}),
  };
}

function listOperations(seq: number, saved: { artifact: MessageArtifact; detailSaved: boolean }, request: SessionHistoryRequest<"list_operations">): SessionHistoryResult {
  const { artifact } = saved;
  const operations = artifact.operationTimeline ?? [];
  const section = request.section ?? "operations";
  const all: readonly object[] = section === "operations"
    ? operations.map((operation, index) => ({
      index, ...(operation.id !== undefined ? { id: operation.id } : {}), type: operation.type, summary: operation.summary,
      ...(operation.status !== undefined ? { status: operation.status } : {}),
      ...(operation.exitCode !== undefined ? { exitCode: operation.exitCode } : {}),
      ...(operation.error ? { error: operation.error } : {}),
      ...(operation.truncated !== undefined ? { truncated: operation.truncated } : {}),
      detailSaved: operation.details !== undefined,
    }))
    : section === "changed_files"
      ? artifact.changedFiles.map((file, index) => ({ index, kind: file.kind, path: file.path, summary: file.summary, diffRowCount: file.diffRows.length }))
      : artifact.runChecks.map((check, index) => ({ index, label: check.label, value: check.value }));
  const page = pageOf(all, request.offset ?? 0, request.limit ?? SESSION_HISTORY_DEFAULT_OPERATION_LIST_LIMIT);
  if (!page) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the listed section.");
  return {
    ok: true, seq, section, artifactDetailSaved: saved.detailSaved,
    counts: { operations: operations.length, changedFiles: artifact.changedFiles.length, runChecks: artifact.runChecks.length }, ...page,
  };
}

function getOperationDetail(seq: number, saved: { artifact: MessageArtifact; detailSaved: boolean }, request: SessionHistoryRequest<"get_operation_detail">): SessionHistoryResult {
  const offset = request.offset ?? 0;
  if (request.kind === "operation") {
    if (request.maxRows !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows applies to changed_file only.");
    const operation = saved.artifact.operationTimeline?.[request.index];
    if (!operation) return failure("HISTORY_NOT_SAVED", "No operation is saved at the requested index.");
    if (operation.details === undefined) return failure("HISTORY_NOT_SAVED", "No detail is saved for the operation.");
    if (offset > operation.details.length) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the operation detail.");
    return {
      ok: true, seq, kind: "operation", index: request.index, type: operation.type,
      ...sliceText(operation.details, offset, request.maxChars ?? SESSION_HISTORY_DEFAULT_TEXT_LIMIT),
      truncatedAtSave: operation.truncated === true,
    };
  }
  if (request.maxChars !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxChars applies to operation only.");
  const file = saved.artifact.changedFiles[request.index];
  if (!file) return failure("HISTORY_NOT_SAVED", "No changed file is saved at the requested index.");
  if (!saved.detailSaved) return failure("HISTORY_NOT_SAVED", "The diff of the changed file is not saved.");
  const page = pageOf(file.diffRows, offset, request.maxRows ?? SESSION_HISTORY_DEFAULT_ROW_LIMIT);
  if (!page) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the diff rows.");
  return { ok: true, seq, kind: "changed_file", index: request.index, path: file.path, changeKind: file.kind, rows: page.items,
    offset: page.offset, nextOffset: page.nextOffset, totalRows: page.total };
}
