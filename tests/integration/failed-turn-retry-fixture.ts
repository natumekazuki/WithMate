import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { Message } from "../../src-shared/session/session-state.js";
import type { RetryFailedSessionTurnRequest, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { executionWindowResultSchemas } from "../../src-shared/session/session-execution-read.js";

export async function installFailedTurnRetryFixture(api: WithMateWindowApi, options: { loseFirstAuxReply?: boolean } = {}) {
  const main = (await api.getSession("benchmark-main"))!;
  const aux = (await api.getAuxiliarySession("benchmark-aux-1"))!;
  main.incarnationId = "fixture-main";
  main.taskTitle = "Retry while another Turn is running";
  aux.title = "Retry fixture";
  for (const session of [main, aux]) {
    session.runState = "running";
    const messages: Message[] = [
      { role: "user", text: "A: Saved failed instruction" },
      { role: "assistant", text: "A: Partial response", runFailure: "failed" },
      { role: "user", text: "Older request with unknown execution outcome" },
      { role: "assistant", text: "Older partial response", runFailure: "interrupted" },
      { role: "user", text: "B: Active instruction" },
    ];
    session.messages = messages.map((message, historyIndex) => ({ ...message, historyIndex }));
  }
  aux.composerDraft = "Keep Auxiliary draft";
  const targets = {
    [main.id]: { kind: "main" as const, sessionId: main.id, incarnationId: main.incarnationId },
    [aux.id]: { kind: "auxiliary" as const, sessionId: aux.id, incarnationId: aux.createdAt, mainSessionId: main.id, mainIncarnationId: main.incarnationId },
  };
  const origin = (id: string) => ({ kind: "gui" as const, operation: "send" as const, targetSessionId: id, targetIncarnationId: targets[id]!.incarnationId });
  api.getConversationPage = async (id) => {
    const owner = id === main.id ? main : aux;
    return { sessionId: id, incarnationId: targets[id]!.incarnationId, startIndex: 0, totalCount: owner.messages.length, messages: owner.messages };
  };
  api.getLiveSessionRun = async (id) => targets[id] ? {
    sessionId: id, turnId: "70", threadId: "fixture-thread", assistantText: "B: Still generating",
    steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
  } : null;
  api.getLatestSessionTurn = async (id) => targets[id] ? {
    id: 70, sessionId: id, phase: "running", userMessageSeq: 4, createdAt: main.updatedAt,
    provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, approvalMode: main.approvalMode, threadId: "fixture-thread", errorMessage: "",
  } : null;
  api.readSessionExecution = async (_owner, operation, request) => {
    if (operation === "read_conversation_threads") return { ok: true, initialMessageIndexes: [0, 1, 2, 3, 4], children: [] } as never;
    if (operation === "list_issued_coordinations") return { ok: true, items: [], nextCursor: null } as never;
    if (operation === "list_sent_instruction_cards") return { ok: true, items: [], cursors: { receipts: null, steers: null } } as never;
    if (operation !== "read_turn_input_display") return { ok: false, message: "Not provided by this fixture" } as never;
    const { target, messageSeq } = request as { target: { sessionId: string }; messageSeq?: number };
    const id = target.sessionId;
    const failed = messageSeq === 1;
    const interrupted = messageSeq === 3;
    return executionWindowResultSchemas.read_turn_input_display.parse({
      ok: true, origin: origin(id), receiptId: failed ? `${id}:A` : interrupted ? `${id}:old` : null,
      receiptState: failed ? "failed" : interrupted ? "interrupted" : null, turnId: failed ? "42" : interrupted ? "51" : null,
      turnState: failed ? "failed" : interrupted ? "interrupted" : null, isFixedStart: failed || interrupted,
      senderTheme: null, retryInputUnchanged: null,
    }) as never;
  };
  const requests: { id: string; request: RetryFailedSessionTurnRequest }[] = [];
  const receiptLookups: { id: string; requestId: string }[] = [];
  const unexpected: string[] = [];
  const rejectUnexpected = (method: string) => async () => { unexpected.push(method); throw new Error(`Unexpected ${method}`); };
  api.enqueueSessionTurn = rejectUnexpected("enqueue without saved source");
  api.runSessionTurn = rejectUnexpected("direct Main start");
  api.runAuxiliarySessionTurn = rejectUnexpected("direct Auxiliary start");
  api.steerSessionTurn = rejectUnexpected("Main Steer");
  api.steerAuxiliarySessionTurn = rejectUnexpected("Auxiliary Steer");
  api.sendQueuedSessionInput = rejectUnexpected("queued Steer");
  api.cancelSessionRun = rejectUnexpected("Main Stop");
  api.cancelAuxiliarySessionRun = rejectUnexpected("Auxiliary Stop");
  const rows = new Map<string, SessionTurnQueueReceipt>();
  const listeners = new Set<Parameters<WithMateWindowApi["onSessionTurnQueueChanged"]>[0]>();
  api.onSessionTurnQueueChanged = (callback) => { listeners.add(callback); return () => listeners.delete(callback); };
  api.listSessionTurnQueue = async (id) => [...rows.values()].filter((row) => row.sessionId === id);
  api.getSessionTurnQueueReceipt = async (id, requestId) => { receiptLookups.push({ id, requestId }); return rows.get(requestId) ?? null; };
  api.retryFailedSessionTurn = async (id, request) => {
    requests.push({ id, request });
    if (id === aux.id && options.loseFirstAuxReply && requests.filter((entry) => entry.id === id).length === 1) {
      throw new Error("Simulated disconnect before the receipt could be confirmed");
    }
    const captured = {
      request: { clientRequestId: request.clientRequestId, userMessage: "A: Saved failed instruction", submitSource: "retry" as const, executionOptions: request.executionOptions },
      attachments: [], origin: origin(id), provider: main.provider, workspacePath: main.workspacePath,
      retrySource: { receiptId: request.receiptId, turnId: request.turnId, origin: origin(id), changedSinceAcceptance: false },
    };
    const receipt: SessionTurnQueueReceipt = {
      id: request.clientRequestId, requestId: request.clientRequestId, sessionId: id, incarnationId: request.target.incarnationId,
      sequence: 5, queuePosition: 5, state: "queued", captured, accepted: captured, turnId: null, inputTurnId: null,
      userMessageSeq: null, reason: null, releasedAt: null, createdAt: main.updatedAt, updatedAt: main.updatedAt,
    };
    rows.set(request.clientRequestId, receipt);
    listeners.forEach((listener) => listener(id));
    return receipt;
  };
  return { main, aux, targets, requests, receiptLookups, unexpected };
}
