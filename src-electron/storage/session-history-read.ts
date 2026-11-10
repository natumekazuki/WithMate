import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_HISTORY_DEFAULT_LIST_LIMIT,
  SESSION_HISTORY_DEFAULT_OPERATION_LIST_LIMIT,
  SESSION_HISTORY_DEFAULT_ROW_LIMIT,
  SESSION_HISTORY_DEFAULT_TEXT_LIMIT,
  SESSION_HISTORY_PREVIEW_CHARS,
  type SessionHistoryErrorCode,
  type SessionHistoryReadInput,
  type SessionHistoryRequest,
  type SessionHistoryResult,
} from "../../src-shared/session-history/session-history-contract.js";
import { normalizeMessage, type Message, type MessageArtifact } from "../../src-shared/session/session-state.js";
import { matchesSessionHistorySource, type SessionHistoryReadScope } from "../../src-shared/session/session-history-read-scope.js";
import { readConversationQuerySnapshot } from "./conversation-query.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";

type Source = SessionHistoryReadScope["source"];
type Window = { fromSeq: number; toSeq: number };
type Layout = { table: string; owner: string };
type MessageRow = { seq: number; role: string; body: string; artifact_body?: string | null };
type TurnRow = {
  id: number; phase: string; provider_id: string; model_id: string;
  user_message_seq: number | null; assistant_message_seq: number | null; error_summary: string;
};

function failure(code: SessionHistoryErrorCode, message: string): SessionHistoryResult {
  return { ok: false, code, message, effect: "none" };
}

export function checkSessionHistorySource(db: DatabaseSync, source: Source): SessionHistoryResult | null {
  const table = source.kind === "main" ? "session_messages_v6" : "auxiliary_session_messages";
  const snapshot = readConversationQuerySnapshot(db, table, source.sessionId);
  if (!snapshot) return failure("HISTORY_SOURCE_DELETED", "The source Session or its parent no longer exists.");
  if (source.kind === "auxiliary") {
    const owner = db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id = ?").get(source.sessionId) as { parent_session_id: string };
    if (owner.parent_session_id !== source.parent.sessionId) return failure("HISTORY_SOURCE_REPLACED", "The source parent does not match the captured parent.");
    const parent = readConversationQuerySnapshot(db, "session_messages_v6", source.parent.sessionId);
    if (!parent) return failure("HISTORY_SOURCE_DELETED", "The source parent no longer exists.");
    if (parent.incarnationId !== source.parent.incarnationId) return failure("HISTORY_SOURCE_REPLACED", "The source parent was recreated.");
  }
  return matchesSessionHistorySource(source, snapshot) ? null
    : failure("HISTORY_SOURCE_REPLACED", "The source Session was recreated after the history scope was fixed.");
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

function splitsSurrogatePair(text: string, offset: number): boolean {
  const unit = text.charCodeAt(offset);
  const before = text.charCodeAt(offset - 1);
  return offset > 0 && unit >= 0xdc00 && unit <= 0xdfff && before >= 0xd800 && before <= 0xdbff;
}

/** A page never ends inside a surrogate pair; a budget of one code unit at a pair returns the whole pair so paging progresses. */
function sliceText(text: string, offset: number, max: number) {
  let end = Math.min(text.length, offset + max);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end = end > offset + 1 ? end - 1 : end + 1;
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
  assertRuntimeTurnAdmission();
  const result = readCurrentHistory(db, input);
  assertRuntimeTurnAdmission();
  return result;
}

function readCurrentHistory(db: DatabaseSync, input: SessionHistoryReadInput): SessionHistoryResult {
  const { source, fromMessageSeq, throughMessageSeq } = input.scope;
  const window = { fromSeq: fromMessageSeq, toSeq: throughMessageSeq };
  const layout: Layout = source.kind === "main"
    ? { table: "session_messages_v6", owner: "session_id" } : { table: "auxiliary_session_messages", owner: "auxiliary_session_id" };
  const sourceFailure = checkSessionHistorySource(db, source);
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
  const detail = input.request as SessionHistoryRequest<"get_operation_detail">;
  if (input.operation === "get_operation_detail" && detail.kind === "elicitation") return getElicitation(decodeMessage(row, source.sessionId), detail);
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
  if (splitsSurrogatePair(message.text, offset)) return failure("HISTORY_INVALID_REQUEST", "offset is inside a surrogate pair.");
  return {
    ok: true, seq: row.seq, role: message.role, turn: readTurns(db, layout, sessionId, row.seq, row.seq).get(row.seq) ?? null,
    ...sliceText(message.text, offset, request.maxChars ?? SESSION_HISTORY_DEFAULT_TEXT_LIMIT),
    ...(message.elicitationRecords?.length ? { elicitationRecordCount: message.elicitationRecords.length } : {}),
  };
}

const LIST_TEXT_PREVIEW_CHARS = 200;

/** List rows carry bounded previews; the full saved text is read with get_operation_detail `field`. */
function listText(name: string, text: string): Record<string, unknown> {
  const preview = sliceText(text, 0, LIST_TEXT_PREVIEW_CHARS);
  return preview.nextOffset === null ? { [name]: text } : { [name]: preview.text, [`${name}Truncated`]: true, [`${name}Chars`]: text.length };
}

function listOperations(seq: number, saved: { artifact: MessageArtifact; detailSaved: boolean }, request: SessionHistoryRequest<"list_operations">): SessionHistoryResult {
  const { artifact } = saved;
  const operations = artifact.operationTimeline ?? [];
  const section = request.section ?? "operations";
  const all: readonly object[] = section === "operations"
    ? operations.map((operation, index) => ({
      index, ...(operation.id !== undefined ? { id: operation.id } : {}), type: operation.type, ...listText("summary", operation.summary),
      ...(operation.status !== undefined ? { status: operation.status } : {}),
      ...(operation.exitCode !== undefined ? { exitCode: operation.exitCode } : {}),
      ...(operation.error ? { error: { ...listText("message", operation.error.message), ...(operation.error.code !== undefined ? { code: operation.error.code } : {}) } } : {}),
      ...(operation.truncated !== undefined ? { truncated: operation.truncated } : {}),
      detailSaved: operation.details !== undefined,
    }))
    : section === "changed_files"
      ? artifact.changedFiles.map((file, index) => ({ index, kind: file.kind, ...listText("path", file.path), ...listText("summary", file.summary), diffRowCount: file.diffRows.length }))
      : artifact.runChecks.map((check, index) => ({ index, ...listText("label", check.label), ...listText("value", check.value) }));
  const page = pageOf(all, request.offset ?? 0, request.limit ?? SESSION_HISTORY_DEFAULT_OPERATION_LIST_LIMIT);
  if (!page) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the listed section.");
  return {
    ok: true, seq, section, artifactDetailSaved: saved.detailSaved,
    counts: { operations: operations.length, changedFiles: artifact.changedFiles.length, runChecks: artifact.runChecks.length }, ...page,
  };
}

function getElicitation(message: Message, request: SessionHistoryRequest<"get_operation_detail">): SessionHistoryResult {
  if (request.maxRows !== undefined || request.row !== undefined || request.field !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows, row and field do not apply to elicitation.");
  const record = message.elicitationRecords?.[request.index];
  if (!record) return failure("HISTORY_NOT_SAVED", "No elicitation record is saved at the requested index.");
  return textDetail(request.seq, "elicitation", request, JSON.stringify(record));
}

function textDetail(seq: number, kind: string, request: SessionHistoryRequest<"get_operation_detail">, text: string, extra: Record<string, unknown> = {}): SessionHistoryResult {
  const offset = request.offset ?? 0;
  if (offset > text.length) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the detail text.");
  if (splitsSurrogatePair(text, offset)) return failure("HISTORY_INVALID_REQUEST", "offset is inside a surrogate pair.");
  return { ok: true, seq, kind, index: request.index, ...extra, ...sliceText(text, offset, request.maxChars ?? SESSION_HISTORY_DEFAULT_TEXT_LIMIT) };
}

function getOperationDetail(seq: number, saved: { artifact: MessageArtifact; detailSaved: boolean }, request: SessionHistoryRequest<"get_operation_detail">): SessionHistoryResult {
  const offset = request.offset ?? 0;
  if (request.kind === "operation") {
    if (request.maxRows !== undefined || request.row !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows and row apply to changed_file only.");
    const operation = saved.artifact.operationTimeline?.[request.index];
    if (!operation) return failure("HISTORY_NOT_SAVED", "No operation is saved at the requested index.");
    const field = request.field ?? "details";
    const text = field === "details" ? operation.details : field === "summary" ? operation.summary : field === "error" ? operation.error?.message : undefined;
    if (text === undefined) return failure(field === "details" || field === "error" ? "HISTORY_NOT_SAVED" : "HISTORY_INVALID_REQUEST",
      field === "details" || field === "error" ? `No ${field} is saved for the operation.` : "field does not apply to an operation.");
    // truncatedAtSave is reported only when the producer recorded it; an unrecorded flag is not "false".
    return textDetail(seq, "operation", request, text, { type: operation.type, field,
      ...(field === "details" && operation.truncated !== undefined ? { truncatedAtSave: operation.truncated } : {}) });
  }
  if (request.kind === "run_check") {
    if (request.maxRows !== undefined || request.row !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows and row apply to changed_file only.");
    const check = saved.artifact.runChecks[request.index];
    if (!check) return failure("HISTORY_NOT_SAVED", "No run check is saved at the requested index.");
    const field = request.field ?? "value";
    if (field !== "label" && field !== "value") return failure("HISTORY_INVALID_REQUEST", "field does not apply to a run check.");
    return textDetail(seq, "run_check", request, check[field], { field });
  }
  const file = saved.artifact.changedFiles[request.index];
  if (!file) return failure("HISTORY_NOT_SAVED", "No changed file is saved at the requested index.");
  if (request.field !== undefined) {
    if (request.field !== "path" && request.field !== "summary") return failure("HISTORY_INVALID_REQUEST", "field does not apply to a changed file.");
    if (request.maxRows !== undefined || request.row !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows and row do not apply with field.");
    return textDetail(seq, "changed_file", request, file[request.field], { field: request.field });
  }
  if (!saved.detailSaved) return failure("HISTORY_NOT_SAVED", "The diff of the changed file is not saved.");
  const budget = request.maxChars ?? SESSION_HISTORY_DEFAULT_TEXT_LIMIT;
  if (request.row !== undefined) {
    if (request.maxRows !== undefined) return failure("HISTORY_INVALID_REQUEST", "maxRows does not apply when row is given.");
    const row = file.diffRows[request.row];
    if (!row) return failure("HISTORY_NOT_SAVED", "No diff row is saved at the requested row.");
    return textDetail(seq, "changed_file", request, JSON.stringify(row), { path: file.path, row: request.row });
  }
  if (offset > file.diffRows.length) return failure("HISTORY_INVALID_REQUEST", "offset is beyond the diff rows.");
  const maxRows = request.maxRows ?? SESSION_HISTORY_DEFAULT_ROW_LIMIT;
  const rows: unknown[] = [];
  let chars = 0;
  let end = offset;
  while (end < file.diffRows.length && rows.length < maxRows) {
    const length = JSON.stringify(file.diffRows[end]).length;
    if (rows.length && chars + length > budget) break;
    // A row larger than the budget is not inlined; it is read with `row` in pieces.
    rows.push(length > budget ? { row: end, oversized: true, chars: length } : file.diffRows[end]);
    chars += Math.min(length, budget);
    end += 1;
  }
  return { ok: true, seq, kind: "changed_file", index: request.index, path: file.path, changeKind: file.kind, rows,
    offset, nextOffset: end < file.diffRows.length ? end : null, totalRows: file.diffRows.length };
}
