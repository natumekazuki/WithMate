import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import type { LocalPrInput, LocalPrResult } from "../../src-shared/local-pr/local-pr-contract.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import { MainSessionTurnQueueFacade, SessionTurnQueuePreflightRejectedError } from "../app/main-session-turn-queue-facade.js";
import { failure } from "./local-pr-application.js";

/** 組み立てた議論を、既存の GUI Turn の受付経路と受領記録の契約に従って送信する。 */
export async function enqueueLocalPrDiscussion(
  queue: Pick<MainSessionTurnQueueFacade, "enqueueSessionTurn" | "getSessionTurnQueueReceipt">,
  input: LocalPrInput<"discuss">,
  message: string,
  readCurrentTarget: (target: SessionTarget) => Promise<Session | null>,
  assertCurrent: () => void | Promise<void>,
): Promise<LocalPrResult<"discuss">> {
  const { sessionId, incarnationId } = input.target;
  await assertCurrent();
  const session = await readCurrentTarget(input.target);
  if (!session || getSessionIncarnationId(session) !== incarnationId || session.accessMode !== "active") {
    return failure("PR_DISCUSSION_TARGET", "The selected Session is no longer available for sending.");
  }

  // 結果が不明な場合は元の要求 ID で照合する。暗黙に二つ目の Turn を開始しない。
  const receipt = async (): Promise<LocalPrResult<"discuss"> | null> => {
    const previous = await queue.getSessionTurnQueueReceipt(sessionId, input.requestId, incarnationId);
    if (!previous) return null;
    if (previous.accepted?.origin?.kind !== "gui" || previous.accepted.request.userMessage !== message.trim()) {
      return failure("PR_DISCUSSION_REQUEST_CONFLICT", "That request ID belongs to a different Session message.");
    }
    return { ok: true, data: { receiptId: previous.id } };
  };

  try {
    const known = await receipt();
    if (known) return known;
    const accepted = await queue.enqueueSessionTurn(sessionId, {
      incarnationId,
      clientRequestId: input.requestId,
      userMessage: message,
      executionOptions: captureSessionExecutionOptions(session),
      submitSource: "composer",
    }, undefined, assertCurrent);
    return { ok: true, data: { receiptId: accepted.id } };
  } catch (error) {
    if (error instanceof SessionTurnQueuePreflightRejectedError) return failure("PR_DISCUSSION_REJECTED", error.message);
    try {
      const known = await receipt();
      if (known) return known;
    } catch { /* 通信結果は引き続き不明なので、要求の識別情報を保持する。 */ }
    return failure("PR_DISCUSSION_UNKNOWN", "Session acceptance could not be confirmed. Retry the same request to check its receipt.", "unknown");
  }
}
