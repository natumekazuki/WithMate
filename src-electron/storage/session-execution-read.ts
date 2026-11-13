import type { DatabaseSync } from "node:sqlite";
import type { ExecutionReadInput } from "../../src-shared/session/session-execution-read.js";
import { executionOperationRequestSchemas } from "../../src-shared/session/session-execution-read.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionHistoryResult, SessionHistoryOperation, SessionHistoryRequest } from "../../src-shared/session-history/session-history-contract.js";
import type { SessionSteerOrigin, SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import { normalizeMessage, type Message } from "../../src-shared/session/session-state.js";
import type { ComposerAttachment } from "../../src-shared/session/runtime-state.js";
import { readConversationQuerySnapshot } from "./conversation-query.js";
import { readSessionHistory } from "./session-history-read.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";

type Result = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string; effect: "none" };
type Receipt = { id: string; sequence: number; state: string; captured_json: string; accepted_json: string | null; dispatched_json: string | null; turn_id: string | null; input_turn_id: string | null; user_message_seq: number | null; updated_at: string };
type Turn = { id: number; phase: string; provider_id: string; model_id: string; reasoning_effort: string; approval_mode: string; sandbox_mode: string; user_message_seq: number | null; assistant_message_seq: number | null };
const turnColumns = "id, phase, provider_id, model_id, reasoning_effort, approval_mode, sandbox_mode, user_message_seq, assistant_message_seq";
type SavedMessage = { seq: number; role: string; body: string; text_chars?: number };
const failure = (code: string, message: string): Result => ({ ok: false, code, message, effect: "none" });
const attachments = (items: ComposerAttachment[]) => items.map(({ id, kind, displayPath, workspaceRelativePath }) => ({ id, kind, name: displayPath.split(/[\\/]/).at(-1) ?? "", reference: workspaceRelativePath ?? id }));
const captured = (json: string | null) => json === null ? null : JSON.parse(json) as SessionTurnQueueCapturedInput;
const publicInput = (value: SessionTurnQueueCapturedInput | null) => value ? { text: value.request.userMessage, attachments: attachments(value.attachments) } : null;
const comparisonInput = (value: SessionTurnQueueCapturedInput | null) => value ? JSON.stringify([value.request.userMessage, value.attachments.map(({ id, kind, absolutePath }) => [id, kind, absolutePath])]) : null;
const page = <T>(all: T[], offset = 0, limit = 32) => ({ items: all.slice(offset, offset + limit), total: all.length, offset, nextOffset: offset + limit < all.length ? offset + limit : null });

/** Synchronous snapshot on the existing DB. No execution state or output copies are owned here. */
export class SessionExecutionReadStorage {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath); ensureV6Schema(this.db);
    this.db.function("withmate_execution_utf16_length", { deterministic: true }, (value) => typeof value === "string" ? value.length : 0);
  }
  close(): void { this.db.close(); }
  execute(input: ExecutionReadInput): Result {
    assertRuntimeTurnAdmission();
    const parsed = executionOperationRequestSchemas[input.operation].safeParse(input.request);
    if (!parsed.success) return failure("EXECUTION_INVALID_REQUEST", parsed.error.message);
    const identity = (target: SessionTarget) => JSON.stringify([target.kind, target.sessionId, target.incarnationId, target.kind === "auxiliary" ? target.mainSessionId : null, target.kind === "auxiliary" ? target.mainIncarnationId : null]);
    if (identity(parsed.data.target) !== identity(input.target)) return failure("EXECUTION_TARGET_MISMATCH", "The request and resolved target do not match.");
    this.db.exec("BEGIN DEFERRED");
    try {
      const result = this.read(input.target, input.operation, parsed.data);
      assertRuntimeTurnAdmission();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private read(target: SessionTarget, operation: ExecutionReadInput["operation"], request: ExecutionReadInput["request"]): Result {
    const table = target.kind === "main" ? "session_messages_v6" : "auxiliary_session_messages";
    const owner = target.kind === "main" ? "session_id" : "auxiliary_session_id";
    const snapshot = readConversationQuerySnapshot(this.db, table, target.sessionId);
    if (!snapshot) return failure("EXECUTION_TARGET_DELETED", "The saved Session no longer exists.");
    if (snapshot.incarnationId !== target.incarnationId) return failure("EXECUTION_TARGET_REPLACED", "The Session incarnation does not match.");
    if (target.kind === "auxiliary") {
      const parent = this.db.prepare("SELECT parent_session_id FROM auxiliary_sessions WHERE id = ?").get(target.sessionId) as { parent_session_id: string };
      const main = readConversationQuerySnapshot(this.db, "session_messages_v6", target.mainSessionId);
      if (parent.parent_session_id !== target.mainSessionId || main?.incarnationId !== target.mainIncarnationId) return failure("EXECUTION_TARGET_REPLACED", "The Auxiliary parent identity does not match.");
    }
    const source = target.kind === "main" ? { kind: "main" as const, sessionId: target.sessionId, incarnationId: target.incarnationId, ownerIdentity: snapshot.ownerIdentity }
      : { kind: "auxiliary" as const, sessionId: target.sessionId, incarnationId: target.incarnationId, ownerIdentity: snapshot.ownerIdentity, parent: { sessionId: target.mainSessionId, incarnationId: target.mainIncarnationId } };
    if (operation === "list_messages" || operation === "get_message" || operation === "list_operations" || operation === "get_operation_detail") {
      const last = this.db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE ${owner} = ?`).get(target.sessionId) as { seq: number | null };
      const { target: _target, ...historyRequest } = request;
      if (last.seq === null) {
        if (operation !== "list_messages") return failure("HISTORY_NOT_SAVED", "The Session has no saved messages.");
        if ((historyRequest as { offset?: number }).offset) return failure("HISTORY_INVALID_REQUEST", "Offset is beyond the empty conversation.");
        return { ok: true, window: { fromSeq: 0, toSeq: -1 }, total: 0, offset: 0, nextOffset: null, items: [] };
      }
      return readSessionHistory(this.db, { scope: { source, fromMessageSeq: 0, throughMessageSeq: last.seq }, operation, request: historyRequest as SessionHistoryRequest });
    }
    const queueWhere = target.kind === "main" ? "session_id = ? AND auxiliary_session_id IS NULL" : "auxiliary_session_id = ?";
    const queueParams = [target.sessionId, target.incarnationId];
    const receiptColumns = "id, sequence, state, captured_json, accepted_json, dispatched_json, turn_id, input_turn_id, user_message_seq, updated_at";
    const receiptQuery = `SELECT ${receiptColumns} FROM session_turn_queue_v6 WHERE ${queueWhere} AND incarnation_id = ?`;
    const turnWhere = target.kind === "main" ? "session_id = ? AND auxiliary_session_id IS NULL" : "auxiliary_session_id = ?";
    if (operation === "list_sent_deliveries") {
      const options = request as import("zod").z.infer<typeof executionOperationRequestSchemas.list_sent_deliveries>;
      const messageSeqs = [...new Set(options.messageSeqs)];
      const liveTurnIds = options.liveTurnIds ?? [];
      if (!messageSeqs.length && !liveTurnIds.length) return { ok: true, items: [], nextCursor: null };
      const marks = (values: unknown[]) => values.map(() => "?").join(",");
      const clauses = [...(messageSeqs.length ? [`user_message_seq IN (${marks(messageSeqs)}) OR assistant_message_seq IN (${marks(messageSeqs)})`] : []), ...(liveTurnIds.length ? [`id IN (${marks(liveTurnIds)})`] : [])];
      const sourceTurns = this.db.prepare(`SELECT id, user_message_seq, assistant_message_seq FROM session_turns_v6 WHERE ${turnWhere} AND (${clauses.join(" OR ")})`)
        .all(target.sessionId, ...messageSeqs, ...messageSeqs, ...liveTurnIds) as Pick<Turn, "id" | "user_message_seq" | "assistant_message_seq">[];
      if (!sourceTurns.length) return { ok: true, items: [], nextCursor: null };
      const turnIds = sourceTurns.map((turn) => String(turn.id));
      const limit = options.limit ?? 20;
      const rows = this.db.prepare(`SELECT q.id, q.sequence, q.state, q.session_id, q.auxiliary_session_id, q.incarnation_id,
        parent.incarnation_id AS main_incarnation_id, json_extract(q.accepted_json, '$.origin') AS origin_json,
        json_extract(q.accepted_json, '$.request.userMessage') AS text,
        json_extract(q.accepted_json, '$.coordination.id') AS coordination_id,
        CASE WHEN json_type(q.accepted_json, '$.coordination')='object' THEN COALESCE(
          json_extract(json_extract(q.accepted_json, '$.request.userMessage'), '$.answer.body'),
          json_extract(json_extract(q.accepted_json, '$.request.userMessage'), '$.consultation')) END AS coordination_text
        FROM session_turn_queue_v6 q JOIN sessions_v6 parent ON parent.id=q.session_id
        LEFT JOIN auxiliary_sessions auxiliary ON auxiliary.id=q.auxiliary_session_id AND auxiliary.parent_session_id=parent.id
        WHERE json_extract(q.accepted_json, '$.origin.actorKind')=?
          AND json_extract(q.accepted_json, '$.origin.actorSessionId')=?
          AND json_extract(q.accepted_json, '$.origin.actorIncarnationId')=?
          AND json_extract(q.accepted_json, '$.origin.actorTurnId') IN (${marks(turnIds)})
          AND json_extract(q.accepted_json, '$.origin.kind')='session' AND q.sequence>?
          AND ((q.auxiliary_session_id IS NULL AND parent.incarnation_id=q.incarnation_id) OR auxiliary.created_at=q.incarnation_id)
        ORDER BY q.sequence LIMIT ?`).all(target.kind, target.sessionId, target.incarnationId, ...turnIds, options.cursor ?? 0, limit + 1) as Array<{ id: string; sequence: number; state: string; session_id: string; auxiliary_session_id: string | null; incarnation_id: string; main_incarnation_id: string; origin_json: string; text: string; coordination_id: string | null; coordination_text: string | null }>;
      return { ok: true, items: rows.slice(0, limit).map((row) => {
        const origin = JSON.parse(row.origin_json) as NonNullable<SessionTurnQueueCapturedInput["origin"]>;
        const sourceTurn = sourceTurns.find((turn) => String(turn.id) === origin.actorTurnId)!;
        const recipient = row.auxiliary_session_id ? { kind: "auxiliary", sessionId: row.auxiliary_session_id, incarnationId: row.incarnation_id, mainSessionId: row.session_id, mainIncarnationId: row.main_incarnation_id } : { kind: "main", sessionId: row.session_id, incarnationId: row.incarnation_id };
        return { receiptId: row.id, sequence: row.sequence, sourceTurnId: origin.actorTurnId, sourceMessageSeq: sourceTurn.assistant_message_seq !== null && messageSeqs.includes(sourceTurn.assistant_message_seq) ? sourceTurn.assistant_message_seq : sourceTurn.user_message_seq !== null && messageSeqs.includes(sourceTurn.user_message_seq) ? sourceTurn.user_message_seq : null, target: recipient, state: row.state, origin, text: row.text,
          ...(row.coordination_id ? { coordination: { id: row.coordination_id, text: row.coordination_text ?? "" } } : {}) };
      }), nextCursor: rows.length > limit ? rows[limit - 1].sequence : null };
    }
    const getMessage = (seq: number | null): Message | null => {
      if (seq === null) return null;
      const row = this.db.prepare(`SELECT role, body FROM ${table} WHERE ${owner} = ? AND seq = ?`).get(target.sessionId, seq) as SavedMessage | undefined;
      if (!row) return null;
      const message = normalizeMessage({ ...JSON.parse(row.body), role: row.role });
      if (!message) throw new Error("Invalid saved execution message.");
      return message;
    };
    const getTurn = (id: string | null) => id ? this.db.prepare(`SELECT ${turnColumns} FROM session_turns_v6 WHERE ${turnWhere} AND id = ?`).get(target.sessionId, id) as Turn | undefined : undefined;
    const hasAssistant = (turn: Turn) => turn.assistant_message_seq !== null && Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE ${owner} = ? AND seq = ? AND role = 'assistant'`).get(target.sessionId, turn.assistant_message_seq));
    const inputSummary = (entry: Receipt | undefined, turn: Turn | undefined) => {
      const entryOriginal = entry ? comparisonInput(captured(entry.accepted_json)) : null;
      const entryComparison = entry ? comparisonInput(captured(entry.dispatched_json ?? entry.captured_json)) : null;
      const linked = turn ? this.db.prepare(`SELECT seq, role, json_remove(body, '$.text') AS body, withmate_execution_utf16_length(json_extract(body, '$.text')) AS text_chars FROM ${table} WHERE ${owner} = ? AND role = 'user' AND json_extract(body, '$.turnInput.turnId') = ? ORDER BY seq`).all(target.sessionId, String(turn.id)) as SavedMessage[] : [];
      const records = linked.map((row) => ({ seq: row.seq, textChars: row.text_chars ?? 0, message: normalizeMessage({ ...JSON.parse(row.body), role: row.role })! }));
      const confirmed = records.filter((row) => row.message.turnInput?.state === "confirmed");
      const unresolved = records.filter((row) => row.message.turnInput?.state === "pending" || row.message.turnInput?.state === "unknown");
      const unresolvedReceipts = turn ? this.db.prepare(`${receiptQuery} AND turn_id = ? AND input_turn_id IS NOT NULL AND user_message_seq IS NULL AND state IN ('starting', 'interrupted')`).all(...queueParams, String(turn.id)) as Receipt[] : [];
      const start = turn ? this.db.prepare(`${receiptQuery} AND turn_id = ? AND input_turn_id IS NULL AND user_message_seq = ? ORDER BY sequence LIMIT 1`).get(...queueParams, String(turn.id), turn.user_message_seq) as Receipt | undefined : undefined;
      const startOriginal = start ? comparisonInput(captured(start.accepted_json)) : null;
      const startFixed = start ? comparisonInput(captured(start.dispatched_json)) : null;
      const unresolvedReferences = [...unresolved.map(({ seq, message }) => ({ seq, state: message.turnInput!.state })), ...unresolvedReceipts.map((row) => ({ seq: null, receiptId: row.id, state: row.state === "starting" ? "pending" : "unknown" }))];
      const notSent = records.filter((row) => row.message.turnInput?.state === "not-sent");
      return {
        records, confirmed, unresolvedReferences, notSent,
        summary: {
          entry: entry ? { receiptId: entry.id, inputSeq: entry.user_message_seq, kind: entry.input_turn_id === null ? "start" : "additional", stage: entry.dispatched_json !== null ? "fixed" : entry.state === "queued" ? "planned" : "not-fixed",
            comparison: entryOriginal !== null && entryComparison !== null ? entryOriginal === entryComparison ? "unchanged" : "changed" : "unknown", detail: { operation: "get_execution_input", receiptId: entry.id } } : null,
          startChanged: startOriginal !== null && startFixed !== null ? startOriginal !== startFixed : null,
          additional: { confirmedCount: confirmed.length, references: confirmed.slice(0, 100).map(({ seq }) => ({ seq })), referencesNextOffset: confirmed.length > 100 ? 101 : null, unresolved: unresolvedReferences.slice(0, 100), unresolvedCount: unresolvedReferences.length, unresolvedNextOffset: unresolvedReferences.length > 100 ? 100 : null, notSent: notSent.slice(0, 100).map(({ seq }) => ({ seq })), notSentCount: notSent.length, notSentNextOffset: notSent.length > 100 ? 100 : null, coverage: start?.accepted_json ? "recorded" : "unknown" },
        },
      };
    };
    const describeExecution = (entry: Receipt | undefined, turn: Turn | undefined) => ({
      origin: entry ? captured(entry.dispatched_json)?.origin ?? captured(entry.accepted_json)?.origin ?? null : null,
      receiptId: entry?.id ?? null, receiptState: entry?.state ?? null, turnId: turn ? String(turn.id) : entry?.turn_id ?? null,
      turnState: turn?.phase ?? null, resultState: !turn ? entry?.dispatched_json ? "unknown" : "not-started" : !hasAssistant(turn) ? turn.phase === "running" ? "running" : "not-saved" : turn.phase === "completed" ? "saved" : "partial",
      userMessageSeq: turn?.user_message_seq ?? null, assistantMessageSeq: turn?.assistant_message_seq ?? null,
      inputs: inputSummary(entry, turn).summary,
    });
    if (operation === "list_executions") {
      const options = request as { kind?: "receipts" | "turns"; offset?: number; limit?: number };
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 32;
      const total = (options.kind === "turns" ? this.db.prepare(`SELECT COUNT(*) AS count FROM session_turns_v6 WHERE ${turnWhere}`).get(target.sessionId) : this.db.prepare(`SELECT COUNT(*) AS count FROM session_turn_queue_v6 WHERE ${queueWhere} AND incarnation_id = ?`).get(...queueParams)) as { count: number };
      if (offset > total.count) return failure("EXECUTION_INVALID_REQUEST", "Offset is beyond the list.");
      const items = options.kind === "turns" ? (this.db.prepare(`SELECT ${turnColumns} FROM session_turns_v6 WHERE ${turnWhere} ORDER BY id LIMIT ? OFFSET ?`).all(target.sessionId, limit, offset) as Turn[]).map((turn) => describeExecution(undefined, turn)) : (this.db.prepare(`${receiptQuery} ORDER BY sequence LIMIT ? OFFSET ?`).all(...queueParams, limit, offset) as Receipt[]).map((receipt) => describeExecution(receipt, getTurn(receipt.turn_id)));
      return { ok: true, kind: options.kind ?? "receipts", items, offset, total: total.count, nextOffset: offset + items.length < total.count ? offset + items.length : null };
    }
    const ref = request as { receiptId?: string; turnId?: string; messageSeq?: number; offset?: number; limit?: number; maxChars?: number; seq?: number; stage?: "original" | "comparison"; expectedInput?: string; index?: number; state?: "confirmed" | "unresolved" | "not-sent" };
    let receipt = ref.receiptId ? this.db.prepare(`${receiptQuery} AND id = ?`).get(...queueParams, ref.receiptId) as Receipt | undefined : undefined;
    if (ref.receiptId && !receipt) return failure("EXECUTION_NOT_FOUND", "The receipt does not belong to this target.");
    let turn = getTurn(receipt?.turn_id ?? ref.turnId ?? null);
    if (ref.messageSeq !== undefined) {
      const message = getMessage(ref.messageSeq);
      if (!message) return failure("EXECUTION_MESSAGE_NOT_SAVED", "No message is saved at this exact sequence.");
      const matchingReceipts = this.db.prepare(`${receiptQuery} AND user_message_seq = ?`).all(...queueParams, ref.messageSeq) as Receipt[];
      if (matchingReceipts.length > 1) return failure("EXECUTION_LINK_UNAVAILABLE", "The saved message has ambiguous receipt linkage.");
      receipt = matchingReceipts[0];
      if (receipt) turn = getTurn(receipt.turn_id);
      else if (message.turnInput) turn = getTurn(message.turnInput.turnId);
      else {
        const matchingTurns = this.db.prepare(`SELECT ${turnColumns} FROM session_turns_v6 WHERE ${turnWhere} AND (user_message_seq = ? OR assistant_message_seq = ?)`).all(target.sessionId, ref.messageSeq, ref.messageSeq) as Turn[];
        if (matchingTurns.length > 1) return failure("EXECUTION_LINK_UNAVAILABLE", "The saved message has ambiguous Turn linkage.");
        turn = matchingTurns[0];
      }
      if (!turn && !receipt) return failure("EXECUTION_LINK_UNAVAILABLE", "The saved message has no recorded execution linkage.");
      if (message.role === "user" && ref.seq === undefined) ref.seq = ref.messageSeq;
    }
    if (ref.turnId && !turn) return failure("EXECUTION_NOT_FOUND", "The Turn does not belong to this target.");
    if (receipt?.turn_id && !turn) return failure("EXECUTION_LINK_UNAVAILABLE", "The receipt's exact saved Turn is unavailable.");
    if (receipt && turn && receipt.input_turn_id === null && receipt.user_message_seq !== null && receipt.user_message_seq !== turn.user_message_seq) return failure("EXECUTION_LINK_UNAVAILABLE", "The receipt's start input does not match its saved Turn.");
    const description = { ...describeExecution(receipt, turn), sourceMessageSeq: ref.messageSeq ?? null };
    const inputs = inputSummary(receipt, turn);
    const assistant = getMessage(turn?.assistant_message_seq ?? null);
    if (assistant && assistant.role !== "assistant") return failure("EXECUTION_LINK_UNAVAILABLE", "The Turn's result sequence is not an assistant message.");
    if (operation === "get_execution") {
      const input = receipt ? captured(receipt.dispatched_json ?? receipt.captured_json) : null;
      const executionSettings = input ? { source: "input", provider: input.provider, ...input.request.executionOptions }
        : turn ? { source: "turn", provider: turn.provider_id, model: turn.model_id, reasoningEffort: turn.reasoning_effort,
          approvalMode: turn.approval_mode, codexSandboxMode: turn.sandbox_mode, codexReviewer: null, codexSpeed: null, customAgentName: null } : null;
      return { ok: true, ...description, executionSettings, output: assistant ? { finality: assistant.output?.finality ?? "unknown", unitCount: assistant.output?.units.length ?? (assistant.text ? 1 : 0), textChars: assistant.text.length, artifactSaved: Boolean(assistant.artifact) } : null };
    }
    if (operation === "list_execution_inputs") {
      const all: object[] = [];
      if ((!ref.state || ref.state === "confirmed") && turn?.user_message_seq !== null && turn?.user_message_seq !== undefined) {
        const start = getMessage(turn.user_message_seq);
        if (start) all.push({ seq: turn.user_message_seq, kind: "start", textChars: start.text.length, attachments: null });
      }
      if (ref.state === "unresolved") all.push(...inputs.unresolvedReferences.map((row) => ({ ...row, kind: "additional", textChars: row.seq === null ? null : inputs.records.find((record) => record.seq === row.seq)?.textChars ?? null, attachments: null, queueId: "receiptId" in row ? row.receiptId : null,
        inputOrigin: inputs.records.find((record) => record.seq === row.seq)?.message.turnInput?.origin ?? null })));
      else all.push(...(ref.state === "not-sent" ? inputs.notSent : inputs.confirmed).map(({ seq, message, textChars }) => ({ seq, kind: "additional", textChars, state: message.turnInput!.state, queueId: message.turnInput!.queueId ?? null, attachments: attachments(message.turnInput!.attachments), inputOrigin: message.turnInput!.origin ?? null })));
      if ((ref.offset ?? 0) > all.length) return failure("EXECUTION_INVALID_REQUEST", "Offset is beyond the input list.");
      return { ok: true, ...description, ...page(all, ref.offset, ref.limit) };
    }
    if (operation === "get_execution_input") {
      let inputOrigin: SessionSteerOrigin | null = null;
      let value: { text: string; attachments: ReturnType<typeof attachments> } | null;
      const startReceipt = turn ? this.db.prepare(`${receiptQuery} AND turn_id = ? AND input_turn_id IS NULL AND user_message_seq = ? ORDER BY sequence LIMIT 1`).get(...queueParams, String(turn.id), turn.user_message_seq) as Receipt | undefined : undefined;
      const inputReceipt = ref.seq !== undefined && ref.seq === turn?.user_message_seq ? startReceipt : receipt ?? startReceipt;
      let original = inputReceipt ? publicInput(captured(inputReceipt.accepted_json)) : null;
      let comparison = inputReceipt ? publicInput(captured(inputReceipt.dispatched_json ?? inputReceipt.captured_json)) : null;
      if (ref.seq !== undefined) {
        const linked = inputs.records.find((row) => row.seq === ref.seq);
        if (linked) {
          const message = getMessage(linked.seq)!;
          inputOrigin = message.turnInput!.origin ?? null;
          comparison = { text: message.text, attachments: attachments(message.turnInput!.attachments) };
          const linkedReceipt = linked.message.turnInput!.queueId ? this.db.prepare(`${receiptQuery} AND id = ?`).get(...queueParams, linked.message.turnInput!.queueId!) as Receipt | undefined : undefined;
          original = linkedReceipt ? publicInput(captured(linkedReceipt.accepted_json)) : linked.message.turnInput!.queueId ? null : comparison;
          value = ref.stage === "original" ? original : comparison;
        }
        else if (turn?.user_message_seq === ref.seq) { const start = getMessage(ref.seq); comparison = comparison ?? (start ? { text: start.text, attachments: [] } : null); value = ref.stage === "original" ? original : comparison; }
        else return failure("EXECUTION_INPUT_NOT_FOUND", "The input is not linked to this exact Turn.");
      } else {
        if (!comparison && turn) { const message = getMessage(turn.user_message_seq); comparison = message ? { text: message.text, attachments: [] } : null; }
        value = ref.stage === "original" ? original : comparison;
      }
      if (!value) return failure("EXECUTION_INPUT_UNKNOWN", "The requested saved input is unavailable; its original is not reconstructed.");
      const token = JSON.stringify([target, inputReceipt?.id ?? null, ref.seq ?? turn?.user_message_seq ?? null, inputReceipt?.updated_at ?? null]);
      if ((ref.offset ?? 0) > 0 && !ref.expectedInput) return failure("EXECUTION_INPUT_RESTART_REQUIRED", "Continue with expectedInput from the first page.");
      if (ref.expectedInput !== undefined && ref.expectedInput !== token) return failure("EXECUTION_INPUT_RESTART_REQUIRED", "The comparison input changed; restart reading from offset zero.");
      const piece = textPage(value.text, ref.offset, ref.maxChars);
      const paired = (input: ReturnType<typeof publicInput>) => {
        if (!input) return null;
        let offset = Math.min(ref.offset ?? 0, input.text.length);
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(input.text[offset] ?? "") && /[\uD800-\uDBFF]/.test(input.text[offset - 1])) offset -= 1;
        return { ...textPage(input.text, offset, ref.maxChars), attachments: input.attachments };
      };
      return piece.ok ? { ...piece, ...description, inputOrigin, attachments: value.attachments, expectedInput: token, originalKnown: original !== null, inputPair: { original: paired(original), comparison: paired(comparison) } } : piece;
    }
    if (!assistant || !turn || turn.assistant_message_seq === null) return failure("EXECUTION_RESULT_NOT_SAVED", "This exact Turn has no saved assistant result yet.");
    const units = assistant.output?.units ?? (assistant.text ? [{ id: "saved-unclassified", start: 0, end: assistant.text.length, role: "unclassified", phase: null, completion: "unknown", final: false, evidence: null }] : []);
    if (operation === "list_execution_outputs") {
      if ((ref.offset ?? 0) > units.length) return failure("EXECUTION_INVALID_REQUEST", "Offset is beyond the output list.");
      return { ok: true, ...description, finality: assistant.output?.finality ?? "unknown", ...page(units.map((unit, index) => ({ ...unit, index, textChars: unit.end - unit.start })), ref.offset, ref.limit) };
    }
    if (operation === "get_execution_output") {
      const unit = units[ref.index!];
      if (!unit) return failure("EXECUTION_OUTPUT_NOT_FOUND", "No saved output exists at this index.");
      const piece = textPage(assistant.text.slice(unit.start, unit.end), ref.offset, ref.maxChars);
      return piece.ok ? { ...piece, ...description, unit, finality: assistant.output?.finality ?? "unknown" } : piece;
    }
    const historyOperation: SessionHistoryOperation = operation === "list_execution_operations" ? "list_operations" : "get_operation_detail";
    const { target: _target, receiptId: _receipt, turnId: _turn, messageSeq: _messageSeq, ...detailRequest } = request as Record<string, unknown>;
    const result: SessionHistoryResult = readSessionHistory(this.db, { scope: { source, fromMessageSeq: turn.assistant_message_seq, throughMessageSeq: turn.assistant_message_seq }, operation: historyOperation, request: { ...detailRequest, seq: turn.assistant_message_seq } as SessionHistoryRequest });
    return result.ok ? { ...result, ...description } : result;
  }
}

function textPage(text: string, offset = 0, maxChars = 32000): Result {
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1]))) return failure("EXECUTION_INVALID_REQUEST", "Offset is beyond text or inside a surrogate pair.");
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end = end > offset + 1 ? end - 1 : end + 1;
  return { ok: true, text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length };
}
