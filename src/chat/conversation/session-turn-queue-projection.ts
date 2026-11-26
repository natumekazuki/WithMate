import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import { getMessageHistoryIndex } from "../../../src-shared/session/conversation-page.js";
import type { Message } from "../../../src-shared/session/session-state.js";
import { coordinationDeliveryText } from "../../../src-shared/coordination/coordination-delivery.js";
import type { MessageListProjection } from "../auxiliary/auxiliary-session-message-projection.js";
import type { SessionTurnSubmission } from "../runtime/session-turn-submissions.js";
import { getQueuedSourceWaitState } from "./queued-source-wait.js";

export function isFailedTurnReceipt(receipt: SessionTurnQueueReceipt): boolean {
  return receipt.state === "failed" || receipt.state === "interrupted";
}

export function turnReceiptFailureReason(receipt: SessionTurnQueueReceipt): string {
  return receipt.reason ?? (receipt.state === "interrupted" && receipt.inputTurnId
    ? "Input acceptance could not be confirmed." : "");
}

export function savedQueuedInputSeqs(messages: readonly Message[]): ReadonlyMap<string, number> {
  return new Map(messages.flatMap((message, index) => message.role === "user" && message.turnInput?.queueId
    ? [[message.turnInput.queueId, getMessageHistoryIndex(message, index)] as const] : []));
}

export function projectSessionTurnQueue(history: MessageListProjection, receipts: readonly SessionTurnQueueReceipt[], owner: { sessionId: string; incarnationId: string }, options?: {
  submissions: readonly SessionTurnSubmission[];
  hasActiveRun: boolean;
  sessionQueue?: { receipts: readonly SessionTurnQueueReceipt[]; hasActiveRun: boolean };
  bindingRequestId?: string;
  responseKeys?: ReadonlyMap<string, string>;
}) {
  const isOwned = (receipt: SessionTurnQueueReceipt) => receipt.sessionId === owner.sessionId && receipt.incarnationId === owner.incarnationId;
  const owned = receipts.filter(isOwned)
    .sort((left, right) => left.queuePosition - right.queuePosition);
  const metadata = new Map<string, SessionTurnQueueReceipt>();
  const projection: MessageListProjection = { messages: [...history.messages], keys: [...history.keys], sources: [...history.sources], groups: [...history.groups] };
  const tail: SessionTurnQueueReceipt[] = [];
  const waiting: SessionTurnQueueReceipt[] = [];
  const addInput = (receipt: SessionTurnQueueReceipt, index: number) => {
    const key = `turn-submission-${receipt.incarnationId}-${receipt.requestId}`;
    const input = receipt.dispatched ?? receipt.accepted ?? receipt.captured;
    projection.messages.splice(index, 0, { role: "user", text: coordinationDeliveryText(input), ...(input.request.replyTo ? { replyTo: input.request.replyTo } : {}) });
    projection.keys.splice(index, 0, key);
    projection.sources.splice(index, 0, { kind: "turn-queue", receipt });
    projection.groups.splice(index, 0, null);
    metadata.set(key, receipt);
  };
  const sessionQueue = options?.sessionQueue?.receipts.filter(isOwned) ?? owned;
  const sessionBusy = (options?.sessionQueue?.hasActiveRun ?? options?.hasActiveRun) || sessionQueue.some((receipt) =>
    receipt.state === "starting" || receipt.state === "running");
  // Select the next dispatchable receipt before restricting the presentation to a frame.
  const queueHead = options && !sessionBusy ? sessionQueue.reduce<SessionTurnQueueReceipt | undefined>((head, receipt) =>
    receipt.state === "queued" && getQueuedSourceWaitState(receipt) === null
      && (!head || receipt.queuePosition < head.queuePosition || receipt.queuePosition === head.queuePosition && receipt.sequence < head.sequence)
      ? receipt : head, undefined) : undefined;
  const activeReceipt = options ? owned.find((receipt) => !receipt.inputTurnId && (receipt.state === "starting" || receipt.state === "running"))
    // Retain the existing local request surface while its live start and receipt are joined.
    ?? owned.find((receipt) => receipt.state === "queued" && receipt.requestId === options.bindingRequestId)
    ?? (!options.hasActiveRun ? owned.find((receipt) => !receipt.inputTurnId && receipt.state === "completed" && receipt.userMessageSeq !== null
        && options.submissions.some((submission) => submission.requestId === receipt.requestId)
        && !history.sources.some((source, index) => (source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId)
          && source.messageIndex > receipt.userMessageSeq! && history.messages[index].role === "assistant"))
      : undefined) ?? owned.find((receipt) => receipt.id === queueHead?.id) : undefined;
  for (const receipt of owned) {
    const key = `turn-submission-${receipt.incarnationId}-${receipt.requestId}`;
    const savedIndex = projection.sources.findIndex((source, index) => (source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId)
      && projection.messages[index].role === "user"
      && (receipt.userMessageSeq !== null ? source.messageIndex === receipt.userMessageSeq : projection.messages[index].turnInput?.queueId === receipt.id));
    if (savedIndex >= 0) {
      projection.keys[savedIndex] = key;
      if (receipt.captured.coordination) projection.messages[savedIndex] = { ...projection.messages[savedIndex], text: coordinationDeliveryText(receipt.dispatched ?? receipt.captured) };
      if (receipt.state !== "completed" && receipt.state !== "canceled") metadata.set(key, receipt);
      continue;
    }
    const firstSaved = projection.sources.find((source) => source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId);
    if (receipt.userMessageSeq !== null && (firstSaved?.kind === "session" || firstSaved?.kind === "auxiliary") && receipt.userMessageSeq < firstSaved.messageIndex) continue;
    if (receipt.state === "queued" && receipt !== activeReceipt && options) {
      waiting.push(receipt);
      continue;
    }
    if (receipt.state === "queued" && receipt !== activeReceipt || (isFailedTurnReceipt(receipt) && receipt.userMessageSeq === null)) {
      tail.push(receipt);
      continue;
    }
    if (receipt.state === "canceled" && receipt.userMessageSeq === null) continue;
    // A terminal notification must not drop the accepted prompt before its saved row arrives.
    const followingIndex = projection.sources.findIndex((source, index) => {
      if (source.kind === "live-assistant") {
        const seq = projection.messages[index].historyIndex;
        if (receipt.userMessageSeq !== null && seq !== undefined) return seq > receipt.userMessageSeq;
        return receipt.state !== "queued" && (!receipt.turnId || !source.withMateTurnId || source.withMateTurnId === receipt.turnId);
      }
      if (receipt.userMessageSeq === null) return false;
      if (source.kind === "turn-queue") return source.receipt.userMessageSeq !== null && source.receipt.userMessageSeq > receipt.userMessageSeq;
      return (source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId)
        && getMessageHistoryIndex(projection.messages[index], source.messageIndex) > receipt.userMessageSeq;
    });
    addInput(receipt, followingIndex < 0 ? projection.messages.length : followingIndex);
  }
  // Keep an earlier, failed reservation before the next response, even if it never acquired a saved user row.
  const activeUserIndex = activeReceipt
    ? projection.keys.indexOf(`turn-submission-${activeReceipt.incarnationId}-${activeReceipt.requestId}`) : -1;
  if (activeUserIndex >= 0 && activeReceipt) {
    let index = activeUserIndex;
    for (let tailIndex = 0; tailIndex < tail.length;) {
      const receipt = tail[tailIndex];
      if (!isFailedTurnReceipt(receipt) || receipt.queuePosition >= activeReceipt.queuePosition) {
        tailIndex++;
        continue;
      }
      addInput(receipt, index);
      tail.splice(tailIndex, 1);
      index++;
    }
  }
  // Keep the terminal notification visible while its canonical response is being loaded.
  for (const [key, receipt] of metadata) {
    if (!isFailedTurnReceipt(receipt)) continue;
    const userIndex = projection.keys.indexOf(key);
    if (receipt.inputTurnId && projection.messages[userIndex]?.turnInput?.state === "confirmed") continue;
    const nextPrompt = projection.messages.findIndex((message, index) => index > userIndex && message.role === "user"
      && !message.turnInput && !metadata.get(projection.keys[index])?.inputTurnId);
    const belongsToResponse = (index: number) => !receipt.inputTurnId && index > userIndex && (nextPrompt < 0 || index < nextPrompt);
    if (projection.sources.some((source, index) => belongsToResponse(index) && projection.messages[index].role === "assistant"
      && (source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId))) continue;
    // A later live response can arrive before its saved prompt or receipt.
    const liveIndex = projection.sources.findIndex((source) => !receipt.inputTurnId && source.kind === "live-assistant"
      && source.sessionId === receipt.sessionId && receipt.turnId !== null && source.withMateTurnId === receipt.turnId);
    if (liveIndex >= 0) {
      projection.messages[liveIndex] = { ...projection.messages[liveIndex], runFailure: turnReceiptFailureReason(receipt) };
      continue;
    }
    let responseIndex = userIndex + 1;
    while (!receipt.inputTurnId && (projection.messages[responseIndex]?.turnInput || metadata.get(projection.keys[responseIndex])?.inputTurnId)) responseIndex++;
    projection.messages.splice(responseIndex, 0, { role: "assistant", text: "", runFailure: turnReceiptFailureReason(receipt) });
    const responseKey = !receipt.inputTurnId ? options?.responseKeys?.get(receipt.requestId) : undefined;
    projection.keys.splice(responseIndex, 0, responseKey ?? `${key}-failure`);
    projection.sources.splice(responseIndex, 0, { kind: "turn-queue", receipt });
    projection.groups.splice(responseIndex, 0, projection.groups[userIndex]);
  }
  // A following turn may already be running while this terminal turn's canonical body is in flight.
  for (const receipt of owned) {
    const responseKey = options?.responseKeys?.get(receipt.requestId);
    if (!responseKey || (receipt.state !== "completed" && receipt.state !== "canceled") || receipt.inputTurnId || receipt.userMessageSeq === null) continue;
    const userIndex = projection.keys.indexOf(`turn-submission-${receipt.incarnationId}-${receipt.requestId}`);
    if (userIndex < 0) continue;
    const nextUserIndex = projection.keys.findIndex((key, index) => index > userIndex
      && owned.some((next) => !next.inputTurnId && key === `turn-submission-${next.incarnationId}-${next.requestId}`));
    const responseIndex = projection.messages.findIndex((message, index) => {
      const source = projection.sources[index];
      return index > userIndex && (nextUserIndex < 0 || index < nextUserIndex) && message.role === "assistant"
        && (source.kind !== "live-assistant" || source.withMateTurnId === receipt.turnId);
    });
    if (responseIndex >= 0) continue;
    let pendingIndex = userIndex + 1;
    while (receipt.turnId && projection.messages[pendingIndex]?.role === "user") {
      const queuedInput = metadata.get(projection.keys[pendingIndex]);
      const turnId = projection.messages[pendingIndex].turnInput?.turnId ?? (queuedInput?.inputTurnId ? queuedInput.turnId : null);
      if (turnId !== receipt.turnId) break;
      pendingIndex++;
    }
    projection.messages.splice(pendingIndex, 0, { role: "assistant", text: "" });
    projection.keys.splice(pendingIndex, 0, responseKey);
    projection.sources.splice(pendingIndex, 0, { kind: "turn-queue", receipt });
    projection.groups.splice(pendingIndex, 0, projection.groups[userIndex]);
    metadata.set(responseKey, receipt);
  }
  const localTail: SessionTurnSubmission[] = [];
  let pendingSubmission: SessionTurnSubmission | undefined;
  for (const submission of options?.submissions ?? []) {
    if (submission.sessionId !== owner.sessionId || submission.incarnationId !== owner.incarnationId
      || (!submission.receipt && !submission.error)
      || owned.some((receipt) => receipt.requestId === submission.requestId)) continue;
    if (submission.queuedBehindRun || sessionBusy || queueHead || activeReceipt || pendingSubmission) {
      localTail.push(submission);
      continue;
    }
    pendingSubmission = submission;
    const liveIndex = projection.sources.findIndex((source) => source.kind === "live-assistant");
    const index = liveIndex < 0 ? projection.messages.length : liveIndex;
    projection.messages.splice(index, 0, { role: "user", text: submission.userMessage });
    projection.keys.splice(index, 0, `turn-submission-${submission.incarnationId}-${submission.requestId}`);
    projection.sources.splice(index, 0, { kind: "turn-submission", requestId: submission.requestId });
    projection.groups.splice(index, 0, null);
  }
  // Reservations stay the same virtual row when they become the active input.
  const waitingStart = waiting.length ? projection.messages.length : undefined;
  for (const receipt of waiting) addInput(receipt, projection.messages.length);
  return { projection, metadata, tail, localTail, pendingSubmission, activeReceipt, waitingStart };
}
