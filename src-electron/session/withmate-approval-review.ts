import type { LiveApprovalRequest } from "../../src-shared/session/runtime-state.js";
import type { WithMateAutoReviewSettings } from "../../src-shared/settings/withmate-auto-review.js";
import type { SessionTarget } from "../../src-shared/session/session-management-contract.js";
import {
  approvalReviewDecisionSchema,
  type ApprovalReviewDecision,
  type ApprovalReviewerConversation,
} from "../providers/approval-reviewer.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER } from "../providers/provider-agent-runtime-binding.js";

/** リクエスト単位のレビュー試行。null は有効な判定がないことを表し、承認も手動承認の要求もできない。 */
export type PendingApprovalReview = {
  /** レビューを試み、要求が失効した場合や有効な結果を得られない場合は null を返す。 */
  decide(
    signal: AbortSignal,
    queue?: ApprovalReviewQueueContext,
  ): Promise<ApprovalReviewDecision["decision"] | null>;
  /** 受付時と判定の受入直前に確認する。キューは先頭のリクエストが同一であることを確認する。 */
  isCurrent(): boolean;
};

/** レビュー対象が先頭に残っていることと、以前のレビュアーの停止を確認するためのキュー境界。 */
type ApprovalReviewQueueContext = {
  /** 同じ承認要求が現在のキュー先頭にあるかを確認する。 */
  isCurrentHead(): boolean;
  previousStop?: Promise<void>;
  /** 会話の後片付けが始まったことと、実際の停止を示す Promise をキューへ渡す。 */
  onStopping(stopped: Promise<void>): void;
};

/** 履歴の索引ではなく、メモリ内で実行中の入力を追う仕組み。処理中の GUI 入力が祖先に影響することがある。 */
export class ApprovalReviewInputFence {
  #revision = 0;
  #writes = 0;

  /** 入力の開始で既存の判定根拠を無効にし、処理が成功・失敗のどちらでも終了後に実行中の件数を戻す。 */
  async during<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#revision++;
    this.#writes++;
    try {
      return await operation();
    } finally {
      this.#writes--;
    }
  }

  /** 保存入力や関連情報の変化を知らせ、それ以前に取った判定根拠を失効させる。 */
  invalidate(): void {
    this.#revision++;
  }

  /** 現在の入力変更状態を保存し、取得時と照合時のどちらも書き込みがなく世代が一致する場合だけ有効とする。 */
  capture(): () => boolean {
    const revision = this.#revision;
    const writing = this.#writes > 0;
    return () => !writing && this.#writes === 0 && this.#revision === revision;
  }
}

/** 選択設定と起点 Turn からレビューの管理役を作る。利用できない経路なら undefined を返せる。 */
export type StartWithMateApprovalReview = (input: {
  selection: WithMateAutoReviewSettings;
  turnId: string;
  workspacePath: string;
  binding?: ProviderAgentRuntimeBindingProjection | null;
  signal: AbortSignal;
}) => WithMateApprovalReviewTurn | undefined;

/** 必要になってからレビュアーとの会話を開始し、中断されるまで起点の Turn 内で再利用する。 */
export class WithMateApprovalReviewTurn {
  readonly #lifetime = new AbortController();
  #conversation?: {
    controller: AbortController;
    ready: Promise<ApprovalReviewerConversation>;
    onStopping?: ApprovalReviewQueueContext["onStopping"];
  };
  #closing?: Promise<void>;
  #active?: AbortSignal;
  /** 起点 Turn の中断時にレビューの受付と会話を終了する。 */
  readonly #closeOnAbort = () => this.close();

  /** 起点と判断条件を保持し、すでに中断されていれば会話を開始できない状態にする。 */
  constructor(
    private readonly options: {
      source: SessionTarget;
      signal: AbortSignal;
      turnId: string;
      workspacePath: string;
      inputs: ApprovalReviewInputFence;
      /** 現在の設定が、レビューが開始された時の委任条件を引き続き満たすか確認する。 */
      policyCurrent(): boolean;
      /** 起点の Turn ではなく、レビュアーとの会話のシグナルを使う。 */
      open(signal: AbortSignal): Promise<ApprovalReviewerConversation>;
      timeoutMs?: number;
    },
  ) {
    if (options.signal.aborted) this.close();
    else
      options.signal.addEventListener("abort", this.#closeOnAbort, {
        once: true,
      });
  }

  /** 要求の判定根拠を取得し、実際に先頭へ到達したときにだけレビューを試せる保留項目を作る。 */
  pending(
    request: LiveApprovalRequest,
    nativeReview: { operation: unknown; isCurrent?: () => boolean },
  ): PendingApprovalReview {
    const inputsCurrent = this.options.inputs.capture();
    /** 保存入力・方針・ネイティブ要求のいずれにも失効がなく、起点が生きていることを確認する。 */
    const isCurrent = () =>
      inputsCurrent() &&
      this.options.policyCurrent() &&
      !this.#lifetime.signal.aborted &&
      (nativeReview.isCurrent?.() ?? true);
    return {
      isCurrent,
      /** 並行する試行を拒否し、以前の停止確認と今回の期限を守って有効な判定だけを返す。 */
      decide: async (signal, queue) => {
        /** 判定根拠の有効性に加え、キュー経由では要求が今も先頭であることを確認する。 */
        const canReview = () => isCurrent() && (queue?.isCurrentHead() ?? true);
        if (!canReview() || signal.aborted || this.#active) return null;
        const previousStop = queue?.previousStop ?? this.#closing;
        const deadline = new AbortController();
        const stop = AbortSignal.any([
          this.#lifetime.signal,
          signal,
          deadline.signal,
        ]);
        this.#active = stop;
        // タイムアウトさせるのは今回のレビュー試行だけで、起点の Turn ではない。後続の先頭リクエストも停止確認を待つ。
        const timer = setTimeout(
          () => deadline.abort(),
          this.options.timeoutMs ?? 60_000,
        );
        let onStop!: () => void;
        const stopped = new Promise<null>((resolve) => {
          onStop = () => {
            if (this.#active === stop) {
              this.#retireConversation();
              this.#active = undefined;
            }
            resolve(null);
          };
        });
        stop.addEventListener("abort", onStop, { once: true });
        try {
          /** 前の会話の停止を待ち、今回の要求が有効な場合だけレビュアーに送る。 */
          const review = async () => {
            if (previousStop) await previousStop;
            if (stop.aborted || !canReview()) return null;
            this.#closing = undefined;
            return this.#review(
              request,
              nativeReview.operation,
              stop,
              canReview,
              queue?.onStopping,
            );
          };
          const outcome = await Promise.race([review(), stopped]);
          return !stop.aborted && canReview() ? outcome : null;
        } catch {
          if (this.#active === stop) this.#retireConversation();
          return null;
        } finally {
          clearTimeout(timer);
          stop.removeEventListener("abort", onStop);
          if (this.#active === stop) this.#active = undefined;
        }
      },
    };
  }

  /** 起点からの中断監視を外し、すべてのレビューを失効させて現在の会話を閉じる。 */
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.options.signal.removeEventListener("abort", this.#closeOnAbort);
    this.#lifetime.abort();
    this.#retireConversation();
  }

  /** 現在の会話を再利用対象から外し、起動中のものも含めて停止を要求して完了を追跡する。 */
  #retireConversation(): void {
    const conversation = this.#conversation;
    if (!conversation) return;
    this.#conversation = undefined;
    // この会話がまだ開始処理中でも、停止を確認するまで代わりの会話は開始できない。
    this.#closing = conversation.ready.then(
      (reviewer) => reviewer.close(),
      () => undefined,
    );
    void this.#closing.catch(() => undefined);
    conversation.onStopping?.(this.#closing);
    conversation.controller.abort();
  }

  /** 欠落・秘匿化・サイズ超過の操作を除外したうえで会話を開くか再利用し、現在性を再確認した構造化判定だけを採用する。 */
  async #review(
    request: LiveApprovalRequest,
    operation: unknown,
    signal: AbortSignal,
    isCurrent: () => boolean,
    onStopping?: ApprovalReviewQueueContext["onStopping"],
  ): Promise<ApprovalReviewDecision["decision"] | null> {
    if (
      operation === null ||
      typeof operation !== "object" ||
      Object.keys(operation).length === 0
    )
      return null;
    const prompt = JSON.stringify({
      source: this.options.source,
      turnId: this.options.turnId,
      workspacePath: this.options.workspacePath,
      pendingOperation: { ...request, operation },
    });
    // 不完全な操作や秘匿化された操作をレビューに委ねない。
    if (
      Buffer.byteLength(prompt) > 128 * 1024 ||
      prompt.includes(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER)
    )
      return null;
    if (signal.aborted || !isCurrent()) return null;
    if (!this.#conversation) {
      const controller = new AbortController();
      this.#conversation = {
        controller,
        ready: Promise.resolve().then(() =>
          this.options.open(controller.signal),
        ),
        onStopping,
      };
    }
    const conversation = await this.#conversation.ready;
    if (signal.aborted || !isCurrent()) return null;
    const response = approvalReviewDecisionSchema.safeParse(
      await conversation.review(prompt),
    );
    if (!response.success || signal.aborted || !isCurrent()) return null;
    return response.data.decision;
  }
}
