import type {
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveSessionRunState,
} from "../../src-shared/session/runtime-state.js";
import {
  reportApprovalDecisionSource,
  type ApprovalDecisionSource,
  type ApprovalDecisionSourceObserver,
} from "../providers/provider-runtime.js";
import type { PendingApprovalReview } from "./withmate-approval-review.js";

/** 承認キューの一項目。重複した待機者が同じ判定を共有し、手動表示・レビュー・中断の状態を保持する。 */
type PendingApprovalRequest = {
  request: LiveApprovalRequest;
  decision: Promise<LiveApprovalDecision>;
  signals: Set<AbortSignal>;
  handleAbort: () => void;
  lifetime: AbortController;
  /** undefined は従来の手動承認経路を表し、null はレビュー経路が選ばれたが利用できないことを表す。 */
  review?: PendingApprovalReview | null;
  manual?: "published" | "legacy-unpublished";
  observers: Set<ApprovalDecisionSourceObserver>;
  finish: (
    decision: LiveApprovalDecision,
    source: ApprovalDecisionSource,
  ) => void;
};

/** 承認要求を現在の実行状態へ反映し、表示できた要求を利用者に通知するための依存。 */
type SessionApprovalServiceOptions = {
  notifyApproval?: (
    sessionId: string,
    requestId: string,
    signal: AbortSignal,
  ) => void;
  updateLiveSessionRun: (
    sessionId: string,
    recipe: (current: LiveSessionRunState) => LiveSessionRunState,
  ) => LiveSessionRunState | null;
};

/** Session ごとに承認を受付順に進め、レビューの停止確認と現在の先頭要求を別々に追跡する。 */
export class SessionApprovalService {
  private readonly pendingRequests = new Map<
    string,
    PendingApprovalRequest[]
  >();
  private readonly stoppingReviews = new Map<string, Promise<void>>();

  /** 承認の表示・通知先を設定する。先頭要求や停止待ちは Session 別に管理する。 */
  public constructor(private readonly options: SessionApprovalServiceOptions) {}

  /** すべての Session の待機中承認を拒否で終了する。進行中のレビュアーには停止を通知する。 */
  public reset(): void {
    for (const sessionId of this.pendingRequests.keys())
      this.cancelSession(sessionId);
  }

  /** 指定 Session のキューを取り除き、全要求を拒否する。表示中だった先頭の要求も片付ける。 */
  public cancelSession(sessionId: string): void {
    const queue = this.pendingRequests.get(sessionId);
    if (!queue) return;
    this.pendingRequests.delete(sessionId);
    for (const pending of queue) pending.finish("deny", "blocked");
    if (queue[0]?.manual === "published")
      this.clearPublishedRequest(sessionId, queue[0].request.requestId);
  }

  /** 手動で判断できる現在の先頭要求にだけ応答を適用する。古い ID や審査中の要求は拒否する。 */
  public resolveLiveApproval(
    sessionId: string,
    requestId: string,
    decision: LiveApprovalDecision,
  ): void {
    const pendingRequest = this.pendingRequests.get(sessionId)?.[0];
    if (
      !pendingRequest ||
      pendingRequest.request.requestId !== requestId ||
      !pendingRequest.manual ||
      !this.isCurrentHead(sessionId, pendingRequest)
    ) {
      throw new Error("The approval request no longer exists.");
    }

    this.settle(
      sessionId,
      pendingRequest,
      decision,
      pendingRequest.manual === "published" ? "manual" : "blocked",
    );
  }

  /** 同じ要求 ID には待機結果を共有し、それ以外は順に処理する。中断済みの要求は拒否で確定する。 */
  public waitForLiveApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
    review?: PendingApprovalReview | null,
    onDecisionSource?: ApprovalDecisionSourceObserver,
  ): Promise<LiveApprovalDecision> {
    const queue = this.pendingRequests.get(sessionId) ?? [];
    const existing = queue.find(
      (pending) => pending.request.requestId === request.requestId,
    );
    if (existing && onDecisionSource) existing.observers.add(onDecisionSource);
    if (signal.aborted) {
      if (existing) {
        this.settle(sessionId, existing, "deny", "blocked");
        return existing.decision;
      }
      reportApprovalDecisionSource(onDecisionSource, "blocked");
      return Promise.resolve("deny");
    }

    if (existing) {
      existing.signals.add(signal);
      signal.addEventListener("abort", existing.handleAbort, { once: true });
      return existing.decision;
    }

    let resolveDecision!: (decision: LiveApprovalDecision) => void;
    const decision = new Promise<LiveApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const pending: PendingApprovalRequest = {
      request,
      decision,
      signals: new Set([signal]),
      /** この要求の待機者が中断したら、共有判定をブロックによる拒否として確定する。 */
      handleAbort: () => this.settle(sessionId, pending, "deny", "blocked"),
      lifetime: new AbortController(),
      review,
      observers: new Set(onDecisionSource ? [onDecisionSource] : []),
      /** 監視と中断処理を解放してから待機者へ結果を渡し、判定を使う前にその出所も通知する。 */
      finish: (value, source) => {
        for (const trackedSignal of pending.signals)
          trackedSignal.removeEventListener("abort", pending.handleAbort);
        pending.signals.clear();
        pending.lifetime.abort();
        if (pending.observers.size) {
          // キューの状態遷移後、判定結果を使う処理が再開する前に、判定元を通知する。
          queueMicrotask(() => {
            for (const observer of pending.observers)
              reportApprovalDecisionSource(observer, source);
            pending.observers.clear();
          });
        }
        resolveDecision(value);
      },
    };
    queue.push(pending);
    this.pendingRequests.set(sessionId, queue);
    signal.addEventListener("abort", pending.handleAbort, { once: true });
    if (queue.length === 1) {
      this.advanceHead(sessionId, queue);
    }
    return decision;
  }

  /** 先頭要求をレビューし、現在も有効な判定だけを扱う。利用不能・失敗では拒否し、ask_user の場合だけ手動へ進める。 */
  private async reviewHead(
    sessionId: string,
    pending: PendingApprovalRequest,
    review: PendingApprovalReview,
  ): Promise<void> {
    const signal = pending.lifetime.signal;
    /** レビュー対象が同じ Session の現在の先頭要求かを、非同期の処理をまたいで確かめる。 */
    const isCurrentHead = () => this.isCurrentHead(sessionId, pending);
    /** キューでの現在性と、レビュアー側の判定条件がともに有効かを確認する。 */
    const isCurrent = () => isCurrentHead() && review.isCurrent();
    // 先頭の要求を手動で解決できない状態のまま、レビュアーの起動を遅らせる。
    await Promise.resolve();
    let verdict: Awaited<ReturnType<PendingApprovalReview["decide"]>> = null;
    try {
      if (isCurrent()) {
        const value = await review.decide(signal, {
          isCurrentHead,
          previousStop: this.stoppingReviews.get(sessionId),
          /** 停止の完了を Session 単位で保持し、同じ停止待ちが成功した場合だけ記録を外す。 */
          onStopping: (stopped) => {
            // 起点の Turn とその承認キューがなくなっても、停止確認まで次のレビューを始めない制約を維持する。
            this.stoppingReviews.set(sessionId, stopped);
            void stopped.then(
              () => {
                if (this.stoppingReviews.get(sessionId) === stopped)
                  this.stoppingReviews.delete(sessionId);
              },
              () => {
                /* close に失敗しても、停止を確認したことにはならない。 */
              },
            );
          },
        });
        if (isCurrent()) verdict = value;
      }
    } catch {
      // レビューが利用できないか失敗した場合、そのレビューに判定する権限はない。
    }
    if (!isCurrentHead()) return;
    if (verdict === "allow_once" || verdict === "deny") {
      this.settle(
        sessionId,
        pending,
        verdict === "allow_once" ? "approve" : "deny",
        "reviewer",
      );
    } else if (verdict === "ask_user") {
      this.publishManualHead(sessionId, pending);
    } else {
      this.settle(sessionId, pending, "deny", "blocked");
    }
  }

  /** 指定要求だけをキューから取り除いて確定する。先頭を処理した場合にだけ次の要求へ進む。 */
  private settle(
    sessionId: string,
    pending: PendingApprovalRequest,
    decision: LiveApprovalDecision,
    source: ApprovalDecisionSource,
  ): void {
    const queue = this.pendingRequests.get(sessionId);
    const index = queue?.indexOf(pending) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    pending.finish(decision, source);
    if (index === 0)
      this.advanceHead(
        sessionId,
        queue,
        pending.manual === "published" ? pending.request.requestId : undefined,
      );
  }

  /** 中断済み・経路利用不能の先頭を拒否し、次に有効な要求をレビューまたは手動経路へ渡す。 */
  private advanceHead(
    sessionId: string,
    queue: PendingApprovalRequest[],
    previousRequestId?: string,
  ): void {
    // Turn の共有シグナルは、個々のリスナーが動く前にすでに中断されている。
    while (
      queue[0] &&
      (queue[0].review === null ||
        [...queue[0].signals].some((signal) => signal.aborted))
    ) {
      queue.shift()!.finish("deny", "blocked");
    }
    const pending = queue[0];
    if (!pending) {
      this.pendingRequests.delete(sessionId);
      this.clearPublishedRequest(sessionId, previousRequestId);
      return;
    }
    if (pending.review) {
      this.clearPublishedRequest(sessionId, previousRequestId);
      void this.reviewHead(sessionId, pending, pending.review);
    } else {
      this.publishManualHead(sessionId, pending);
    }
  }

  /** 同じ待機項目が先頭にあり、項目とすべての待機者のシグナルが中断されていないことを確認する。 */
  private isCurrentHead(
    sessionId: string,
    pending: PendingApprovalRequest,
  ): boolean {
    return (
      this.pendingRequests.get(sessionId)?.[0] === pending &&
      !pending.lifetime.signal.aborted &&
      ![...pending.signals].some((signal) => signal.aborted)
    );
  }

  /** 有効な先頭要求を表示し、同じ要求が実際に反映された場合に限り通知する。 */
  private publishManualHead(
    sessionId: string,
    pending: PendingApprovalRequest,
  ): void {
    if (!this.isCurrentHead(sessionId, pending)) return;
    let published: LiveSessionRunState | null;
    try {
      published = this.options.updateLiveSessionRun(sessionId, (current) => ({
        ...current,
        approvalRequest: pending.request,
      }));
    } catch (error) {
      if (!pending.review) throw error;
      this.settle(sessionId, pending, "deny", "blocked");
      return;
    }
    if (!this.isCurrentHead(sessionId, pending)) return;
    if (published?.approvalRequest?.requestId !== pending.request.requestId) {
      if (pending.review) this.settle(sessionId, pending, "deny", "blocked");
      else pending.manual = "legacy-unpublished";
      return;
    }
    pending.manual = "published";
    try {
      this.options.notifyApproval?.(
        sessionId,
        pending.request.requestId,
        pending.lifetime.signal,
      );
    } catch {
      // ユーザーへの通知が、保留中の承認判定を中断してはならない。
    }
  }

  /** 現在表示中の ID が指定と一致する場合だけ承認表示を消し、後続の表示は残す。 */
  private clearPublishedRequest(sessionId: string, requestId?: string): void {
    if (requestId === undefined) return;
    this.options.updateLiveSessionRun(sessionId, (current) =>
      current.approvalRequest?.requestId === requestId
        ? { ...current, approvalRequest: null }
        : current,
    );
  }
}
