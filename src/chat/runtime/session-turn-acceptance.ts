import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import type {
  RetryFailedSessionTurnRequest,
  SessionTurnQueueAcceptanceResult,
  SessionTurnQueueReceipt,
} from "../../../src-shared/session/session-turn-queue.js";
import type {
  ComposerControllerRegistry,
  ComposerOwner,
} from "../composer-controller.js";
import type { AuxiliaryDraftPersistenceOwner } from "../auxiliary-draft-persistence-owner.js";
import { SessionTurnSubmissions } from "./session-turn-submissions.js";

/** 受付処理とその照会、提供される場合は失敗ターンの再送を行う窓口。 */
type AcceptanceApi = Pick<
  WithMateWindowApi,
  "enqueueSessionTurn" | "getSessionTurnQueueReceipt"
> &
  Partial<Pick<WithMateWindowApi, "retryFailedSessionTurn">>;
/** 送信時の要求と、受付後に同じ版の下書きだけを消せるように保持する所有情報。 */
type Capture = {
  request: RunSessionTurnRequest & { incarnationId: string };
  owner: ComposerOwner;
  revision: number;
  clearDraft: boolean;
  auxiliaryDraftOwner?: AuxiliaryDraftPersistenceOwner;
};
/** 通常送信と失敗ターン再送を分けて保持する、最初の受付要求。 */
type Submission =
  | { kind: "send"; capture: Capture }
  | { kind: "resend"; request: RetryFailedSessionTurnRequest };
/** 受付応答の待機中または成否不明の要求と、先に受信した受付イベント。 */
type Acceptance = Submission & {
  phase: "pending" | "unknown";
  observedReceipt?: SessionTurnQueueReceipt;
};
/** 成否不明の再送を復旧しようとして拒否された理由を、そのセッション世代に保持する。 */
type ResendRecoveryRejection = {
  phase: "rejected";
  incarnationId: string;
  reason: string;
};

/** 受付または拒否が判明するまで、最初に取得した入力を保持する。 */
export class SessionTurnAcceptance {
  readonly submissions = new SessionTurnSubmissions();
  private readonly requests = new Map<
    string,
    Acceptance | ResendRecoveryRejection
  >();

  /** 対象の受付が未確定で、後続の送信より先に確認が必要かを返す。 */
  hasUncertain(sessionId: string, incarnationId?: string): boolean {
    return this.find(sessionId, incarnationId)?.phase === "unknown";
  }

  /** 対象のセッション世代に記録された再送の復旧拒否理由を返す。 */
  resendRecoveryError(sessionId: string, incarnationId: string): string {
    const entry = this.find(sessionId, incarnationId);
    return entry?.phase === "rejected" ? entry.reason : "";
  }

  /** 期待した受付イベントを保持し、成否不明状態だった場合はその場で確定する。 */
  observeReceipt(
    receipt: SessionTurnQueueReceipt,
    registry: ComposerControllerRegistry,
  ): boolean {
    const entry = this.find(receipt.sessionId, receipt.incarnationId);
    if (
      !entry ||
      entry.phase === "rejected" ||
      !this.matchesReceipt(receipt.sessionId, entry, receipt)
    )
      return false;
    entry.observedReceipt = receipt;
    if (entry.phase !== "unknown") return false;
    this.settle(receipt.sessionId, entry, receipt, registry);
    return true;
  }

  /** セッションの追跡情報を取得し、世代が指定された場合は一致する情報だけを返す。 */
  private find(sessionId: string, incarnationId?: string) {
    const entry = this.requests.get(sessionId);
    return entry &&
      (incarnationId === undefined ||
        (entry.phase === "rejected"
          ? entry.incarnationId
          : this.incarnation(entry)) === incarnationId)
      ? entry
      : undefined;
  }

  /** 送信種別に応じた項目から要求先のセッション世代を取り出す。 */
  private incarnation(submission: Submission) {
    return submission.kind === "send"
      ? submission.capture.request.incarnationId
      : submission.request.target.incarnationId;
  }

  /** 再送窓口が利用できる場合に失敗ターンを再送し、最初の受付要求として追跡する。 */
  async submitFailedRetry(
    api: AcceptanceApi,
    sessionId: string,
    request: RetryFailedSessionTurnRequest,
  ): Promise<SessionTurnQueueReceipt> {
    if (!api.retryFailedSessionTurn)
      throw new Error("Failed Turn retry is unavailable.");
    return this.submitOriginal(api, sessionId, { kind: "resend", request });
  }

  /** 取得済みの入力を通常送信として登録し、受付の確定まで下書きを保持する。 */
  async submit(
    api: AcceptanceApi,
    sessionId: string,
    capture: Capture,
    registry: ComposerControllerRegistry,
  ): Promise<SessionTurnQueueReceipt> {
    return this.submitOriginal(
      api,
      sessionId,
      { kind: "send", capture },
      registry,
    );
  }

  /** 同じ世代の未確定受付を重ねず、応答が失われた場合は照会と先着イベントから確定を試みる。 */
  private async submitOriginal(
    api: AcceptanceApi,
    sessionId: string,
    submission: Submission,
    registry?: ComposerControllerRegistry,
  ) {
    const existing = this.find(sessionId, this.incarnation(submission));
    if (existing?.phase === "unknown")
      throw new Error(
        "A previous turn's acceptance is unknown. Check Receipt before sending another turn.",
      );
    if (existing?.phase === "pending")
      throw new Error("Another submission is in progress.");
    const entry: Acceptance = { ...submission, phase: "pending" };
    this.requests.set(sessionId, entry);
    let result;
    try {
      result = await this.enqueue(api, sessionId, submission);
      if (result.state !== "rejected")
        this.validateReceipt(sessionId, submission, result);
    } catch (error) {
      let receipt;
      try {
        receipt = await this.lookup(api, sessionId, submission);
      } catch {
        /* 応答が途切れたキュー投入が確定していなかったことは、不在や確認失敗だけでは証明できない。 */
      }
      const accepted = receipt ?? entry.observedReceipt;
      if (accepted) return this.settle(sessionId, entry, accepted, registry);
      entry.phase = "unknown";
      throw new Error(
        "Turn acceptance could not be confirmed. Your draft is preserved. Check Receipt or retry the original turn.",
        { cause: error },
      );
    }
    return this.settle(
      sessionId,
      entry,
      result.state === "rejected" ? (entry.observedReceipt ?? result) : result,
      registry,
    );
  }

  /** 成否不明の要求を再送せず照会し、確認できた受付だけを確定する。 */
  async check(
    api: AcceptanceApi,
    sessionId: string,
    registry: ComposerControllerRegistry,
    incarnationId?: string,
  ): Promise<SessionTurnQueueReceipt | null> {
    const submission = this.find(sessionId, incarnationId);
    if (submission?.phase !== "unknown") return null;
    const receipt =
      (await this.lookup(api, sessionId, submission).catch((error) => {
        if (submission.observedReceipt) return submission.observedReceipt;
        throw error;
      })) ?? submission.observedReceipt;
    return receipt
      ? this.settle(sessionId, submission, receipt, registry)
      : null;
  }

  /** 成否不明の要求を同じ識別子と内容で再試行し、拒否時も既存受付を照会してから結論を確定する。 */
  async retry(
    api: AcceptanceApi,
    sessionId: string,
    registry: ComposerControllerRegistry,
    incarnationId?: string,
  ): Promise<SessionTurnQueueReceipt | null> {
    const submission = this.find(sessionId, incarnationId);
    if (submission?.phase !== "unknown") return null;
    let result: SessionTurnQueueAcceptanceResult;
    try {
      if (submission.kind === "send")
        await submission.capture.auxiliaryDraftOwner?.flush();
      if (submission.observedReceipt) return submission.observedReceipt;
      result = await this.enqueue(api, sessionId, submission);
      if (result.state === "rejected") {
        // 同じ ID での再試行の事前検査は受付ロック内で行うが、識別情報の競合によっても拒否される。
        // 取得済みの入力を解放する前に、別の受付情報がないことを確認する。
        result =
          (await this.lookup(api, sessionId, submission)) ??
          submission.observedReceipt ??
          result;
      } else {
        this.validateReceipt(sessionId, submission, result);
      }
    } catch (error) {
      if (submission.observedReceipt) return submission.observedReceipt;
      throw error;
    }
    return this.settle(sessionId, submission, result, registry, true);
  }

  /** 最初の要求IDで受付を読み、見つかった受付が元の要求と一致することを確認する。 */
  private async lookup(
    api: AcceptanceApi,
    sessionId: string,
    submission: Submission,
  ) {
    const requestId =
      submission.kind === "send"
        ? submission.capture.request.clientRequestId!
        : submission.request.clientRequestId;
    const receipt = await api.getSessionTurnQueueReceipt(sessionId, requestId);
    if (receipt) this.validateReceipt(sessionId, submission, receipt);
    return receipt;
  }

  /** 要求と一致しない受付を確定結果として扱わないよう例外にする。 */
  private validateReceipt(
    sessionId: string,
    submission: Submission,
    receipt: SessionTurnQueueReceipt,
  ) {
    if (!this.matchesReceipt(sessionId, submission, receipt))
      throw new Error("Queue receipt does not match the submitted request.");
  }

  /** セッション世代と要求IDに加え、送信元と元の入力または失敗ターンの出所を照合する。 */
  private matchesReceipt(
    sessionId: string,
    submission: Submission,
    receipt: SessionTurnQueueReceipt,
  ) {
    const requestId =
      submission.kind === "send"
        ? submission.capture.request.clientRequestId
        : submission.request.clientRequestId;
    if (
      receipt.sessionId !== sessionId ||
      receipt.requestId !== requestId ||
      receipt.incarnationId !== this.incarnation(submission) ||
      (receipt.accepted?.origin && receipt.accepted.origin.kind !== "gui")
    )
      return false;
    if (submission.kind === "resend") {
      const source = receipt.accepted?.retrySource;
      return (
        source?.receiptId === submission.request.receiptId &&
        source.turnId === submission.request.turnId
      );
    }
    if (!receipt.accepted) return true;
    const original = submission.capture.request;
    const accepted = receipt.accepted.request;
    return (
      !receipt.accepted.retrySource &&
      accepted.userMessage === original.userMessage.trim() &&
      accepted.submitSource === original.submitSource &&
      accepted.mainConversationFrame?.sessionId ===
        original.mainConversationFrame?.sessionId &&
      accepted.mainConversationFrame?.incarnationId ===
        original.mainConversationFrame?.incarnationId &&
      accepted.auxiliaryDraftIncarnation ===
        original.auxiliaryDraftIncarnation &&
      accepted.auxiliaryDraftDurableRevision ===
        original.auxiliaryDraftDurableRevision
    );
  }

  /** 現在追跡する要求の表示を確定し、通常送信の下書きは受付成功かつ指定の版が残る場合だけ消す。 */
  private settle(
    sessionId: string,
    submission: Acceptance,
    result: SessionTurnQueueAcceptanceResult,
    registry?: ComposerControllerRegistry,
    recovering = false,
  ) {
    const isCurrent = this.requests.get(sessionId) === submission;
    if (isCurrent) this.requests.delete(sessionId);
    if (result.state === "rejected") {
      if (isCurrent) {
        if (submission.kind === "send")
          this.submissions.fail(
            submission.capture.request.clientRequestId!,
            result.reason,
          );
        else if (recovering)
          this.requests.set(sessionId, {
            phase: "rejected",
            incarnationId: this.incarnation(submission),
            reason: result.reason,
          });
      }
      throw new Error(result.reason);
    }
    if (isCurrent && submission.kind === "send") {
      const { owner, revision, clearDraft } = submission.capture;
      this.submissions.accept(result);
      if (clearDraft) registry?.clearIfRevision(owner, revision);
    }
    return result;
  }

  /** 再送は専用窓口へ、通常送信は必要に応じて補助下書きの消費処理を通して渡す。 */
  private enqueue(
    api: AcceptanceApi,
    sessionId: string,
    submission: Submission,
  ) {
    if (submission.kind === "resend") {
      if (!api.retryFailedSessionTurn)
        throw new Error("Failed Turn retry is unavailable.");
      return api.retryFailedSessionTurn(sessionId, submission.request);
    }
    const captured = submission.capture;
    /** 当初取得した通常送信の要求をそのままキューへ渡す。 */
    const enqueue = () => api.enqueueSessionTurn(sessionId, captured.request);
    return captured.auxiliaryDraftOwner
      ? captured.auxiliaryDraftOwner.withDraftConsumption(enqueue)
      : enqueue();
  }
}
