import type {
  ElicitationRecord,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
} from "../../src-shared/session/runtime-state.js";
import { isValidCodexElicitationContent } from "../../src-shared/session/codex-elicitation-validation.js";

/** Session の入力要求一件と、回答の送信中・期限切れ・結果確定を追跡する状態。 */
type PendingElicitationRequest = {
  request: LiveElicitationRequest;
  response: Promise<LiveElicitationResponse>;
  settle: (
    response: LiveElicitationResponse,
    status: ElicitationRecord["status"],
  ) => void;
  expire: () => void;
  sending: boolean;
  expired: boolean;
};

/** 入力要求を表示・通知し、非同期の質問回答を指定 Turn に送るための依存。 */
type SessionElicitationServiceOptions = {
  notifyQuestion?: (sessionId: string, signal: AbortSignal) => void;
  sendUserMessage?: (
    sessionId: string,
    turnId: string,
    message: string,
    answer: string,
    requestId: string,
  ) => Promise<void>;
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

/** 各欄に空白でない文字列回答を求め、質問と回答を含む送信用本文と回答だけの履歴用本文を組み立てる。 */
function questionAnswerMessage(
  request: LiveElicitationRequest,
  response: LiveElicitationResponse,
): { message: string; answer: string } {
  const answers = request.fields.map((field) => {
    const value = response.content?.[field.name];
    if (typeof value !== "string" || !value.trim())
      throw new Error("An answer is required for each question.");
    return { question: field.title, answer: value.trim() };
  });
  return {
    message: answers
      .map(
        ({ question, answer }) => `【質問】\n${question}\n【回答】\n${answer}`,
      )
      .join("\n\n"),
    answer: answers.map(({ answer }) => answer).join("\n\n"),
  };
}

/** Session 内の複数の入力要求を別々に扱い、回答の受付または期限切れまで結果を保持する。 */
export class SessionElicitationService {
  private readonly pendingRequests = new Map<
    string,
    Map<string, PendingElicitationRequest>
  >();

  /** 入力要求の表示先に加え、必要な場合は質問通知と非同期回答の送信先を受け取る。 */
  public constructor(
    private readonly options: SessionElicitationServiceOptions,
  ) {}

  /** すべての Session の入力要求を期限切れにする。送信済みの回答があれば確定まで待つ経路を維持する。 */
  public reset(): void {
    for (const sessionId of this.pendingRequests.keys())
      this.cancelSession(sessionId);
  }

  /** 指定 Session の入力要求を期限切れにし、別の Session の入力待ちは残す。 */
  public cancelSession(sessionId: string): void {
    for (const pending of this.pendingRequests.get(sessionId)?.values() ?? [])
      pending.expire();
  }

  /** 対象要求への回答を検証し、通常は直ちに確定する。メッセージ送信型は実際の受付後に確定し、失敗すれば再入力できる状態に戻す。 */
  public resolveLiveElicitation(
    sessionId: string,
    requestId: string,
    response: LiveElicitationResponse,
  ): void | Promise<void> {
    const pending = this.pendingRequests.get(sessionId)?.get(requestId);
    if (!pending || pending.expired)
      throw new Error("The input request no longer exists.");
    if (pending.sending) throw new Error("The answer is already being sent.");
    if (
      response.action !== "accept" &&
      response.action !== "decline" &&
      response.action !== "cancel"
    ) {
      throw new Error("Invalid input response.");
    }
    if (
      response.action === "accept" &&
      pending.request.provider === "codex" &&
      pending.request.kind !== "question" &&
      pending.request.mode === "form" &&
      !isValidCodexElicitationContent(pending.request.fields, response.content)
    ) {
      throw new Error(
        "Some answers do not match the form. Correct the answers and submit the same form again.",
      );
    }
    if (
      pending.request.delivery === "user-message" &&
      response.action === "accept"
    ) {
      const { turnId } = pending.request;
      if (!turnId || !this.options.sendUserMessage)
        throw new Error("Question answering is unavailable.");
      const { message, answer } = questionAnswerMessage(
        pending.request,
        response,
      );
      if (!message) throw new Error("The question has no answer fields.");
      pending.sending = true;
      return Promise.resolve()
        .then(() => {
          if (pending.expired)
            throw new Error("The input request no longer exists.");
          return this.options.sendUserMessage!(
            sessionId,
            turnId,
            message,
            answer,
            pending.request.requestId,
          );
        })
        .then(
          () => {
            pending.settle(response, "answered");
          },
          (error: unknown) => {
            pending.sending = false;
            if (pending.expired)
              pending.settle({ action: "cancel" }, "expired");
            throw error;
          },
        );
    }
    pending.settle(
      response,
      response.action === "accept"
        ? "answered"
        : response.action === "decline"
          ? "declined"
          : "canceled",
    );
  }

  /** 同じ要求への待機を共有し、新規なら実行中の表示とフォームの記録を追加する。中断済みなら入力待ちを作らない。 */
  public waitForLiveElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> {
    if (signal.aborted) return Promise.resolve({ action: "cancel" });
    const existing = this.pendingRequests
      .get(sessionId)
      ?.get(request.requestId);
    if (existing) return existing.response;

    const requests =
      this.pendingRequests.get(sessionId) ??
      new Map<string, PendingElicitationRequest>();
    this.pendingRequests.set(sessionId, requests);
    const notificationController = new AbortController();
    let resolveResponse!: (response: LiveElicitationResponse) => void;
    const response = new Promise<LiveElicitationResponse>((resolve) => {
      resolveResponse = resolve;
    });
    let settled = false;
    /** 未期限切れの要求を再表示し、指定時は対象要求の履歴状態だけを更新する。 */
    const update = (status?: ElicitationRecord["status"]) => {
      this.options.updateLiveSessionRun(sessionId, (current) => {
        const active = [...requests.values()]
          .filter((item) => !item.expired)
          .map((item) => item.request);
        return {
          ...current,
          elicitationRequest: active[0] ?? null,
          elicitationRequests: active,
          ...(status
            ? {
                elicitationRecords: current.elicitationRecords?.map((record) =>
                  record.requestId === request.requestId
                    ? { ...record, status }
                    : record,
                ),
              }
            : {}),
        };
      });
    };
    /** 要求を一度だけ取り除き、通知を停止してから履歴状態と待機結果を確定する。 */
    const settle = (
      value: LiveElicitationResponse,
      status: ElicitationRecord["status"],
    ) => {
      if (settled) return;
      settled = true;
      notificationController.abort();
      signal.removeEventListener("abort", expire);
      requests.delete(request.requestId);
      if (
        requests.size === 0 &&
        this.pendingRequests.get(sessionId) === requests
      )
        this.pendingRequests.delete(sessionId);
      update(status);
      resolveResponse(value);
    };
    /** 期限切れを先に記録して通知を停止する。送信中なら結果の確定を待ち、それ以外はキャンセルで終了する。 */
    const expire = () => {
      pending.expired = true;
      notificationController.abort();
      // 送出済みの回答の結果が確定してから、終了時の履歴を保存する。
      if (pending.sending) update("expired");
      else settle({ action: "cancel" }, "expired");
    };
    const pending: PendingElicitationRequest = {
      request,
      response,
      settle,
      expire,
      sending: false,
      expired: false,
    };
    requests.set(request.requestId, pending);
    signal.addEventListener("abort", expire, { once: true });
    this.options.updateLiveSessionRun(sessionId, (current) => {
      const range = current.assistantQuestionRanges?.find(
        (entry) => entry.itemId === request.sourceItemId,
      );
      const position = request.textPosition ?? current.assistantText.length;
      return {
        ...current,
        elicitationRequest: [...requests.values()][0]?.request ?? null,
        elicitationRequests: [...requests.values()]
          .filter((item) => !item.expired)
          .map((item) => item.request),
        ...(request.mode === "form"
          ? {
              elicitationRecords: [
                ...(current.elicitationRecords ?? []),
                {
                  requestId: request.requestId,
                  ...(request.kind ? { kind: request.kind } : {}),
                  ...(request.sourceItemId
                    ? { sourceItemId: request.sourceItemId }
                    : {}),
                  ...(range
                    ? { textRange: { start: range.start, end: range.end } }
                    : request.sourceItemId
                      ? {}
                      : { textRange: { start: position, end: position } }),
                  message: request.message,
                  fields: request.fields.map((field) => ({
                    title: field.title,
                    ...(field.description
                      ? { description: field.description }
                      : {}),
                    ...(field.type === "select" || field.type === "multi-select"
                      ? { options: field.options.map((option) => option.label) }
                      : {}),
                  })),
                  status: "pending" as const,
                },
              ],
            }
          : {}),
      };
    });
    if (request.provider === "codex" && request.kind === "question") {
      this.options.notifyQuestion?.(sessionId, notificationController.signal);
    }
    return response;
  }
}
