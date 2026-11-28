import type { LiveApprovalRequest } from "../../src-shared/session/runtime-state.js";
import type { WithMateAutoReviewSettings } from "../../src-shared/settings/withmate-auto-review.js";
import type { SessionTarget } from "../../src-shared/session/session-management-contract.js";
import { approvalReviewDecisionSchema, type ApprovalReviewDecision, type ApprovalReviewerConversation } from "../providers/approval-reviewer.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER } from "../providers/provider-agent-runtime-binding.js";

/** リクエスト単位のレビュー試行。null は有効な判定がないことを表し、承認も手動承認の要求もできない。 */
export type PendingApprovalReview = {
  decide(signal: AbortSignal, queue?: ApprovalReviewQueueContext): Promise<ApprovalReviewDecision["decision"] | null>;
  /** 受付時と判定の受入直前に確認する。キューは先頭のリクエストが同一であることを確認する。 */
  isCurrent(): boolean;
};

type ApprovalReviewQueueContext = {
  isCurrentHead(): boolean;
  previousStop?: Promise<void>;
  onStopping(stopped: Promise<void>): void;
};

/** 履歴の索引ではなく、メモリ内で実行中の入力を追う仕組み。処理中の GUI 入力が祖先に影響することがある。 */
export class ApprovalReviewInputFence {
  #revision = 0;
  #writes = 0;

  async during<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#revision++;
    this.#writes++;
    try { return await operation(); }
    finally { this.#writes--; }
  }

  invalidate(): void { this.#revision++; }

  capture(): () => boolean {
    const revision = this.#revision;
    const writing = this.#writes > 0;
    return () => !writing && this.#writes === 0 && this.#revision === revision;
  }
}

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
  readonly #closeOnAbort = () => this.close();

  constructor(private readonly options: {
    source: SessionTarget;
    signal: AbortSignal;
    turnId: string;
    workspacePath: string;
    inputs: ApprovalReviewInputFence;
    policyCurrent(): boolean;
    /** 起点の Turn ではなく、レビュアーとの会話のシグナルを使う。 */
    open(signal: AbortSignal): Promise<ApprovalReviewerConversation>;
    timeoutMs?: number;
  }) {
    if (options.signal.aborted) this.close();
    else options.signal.addEventListener("abort", this.#closeOnAbort, { once: true });
  }

  pending(request: LiveApprovalRequest, nativeReview: { operation: unknown; isCurrent?: () => boolean }): PendingApprovalReview {
    const inputsCurrent = this.options.inputs.capture();
    const isCurrent = () => inputsCurrent() && this.options.policyCurrent()
      && !this.#lifetime.signal.aborted && (nativeReview.isCurrent?.() ?? true);
    return {
      isCurrent,
      decide: async (signal, queue) => {
        const canReview = () => isCurrent() && (queue?.isCurrentHead() ?? true);
        if (!canReview() || signal.aborted || this.#active) return null;
        const previousStop = queue?.previousStop ?? this.#closing;
        const deadline = new AbortController();
        const stop = AbortSignal.any([this.#lifetime.signal, signal, deadline.signal]);
        this.#active = stop;
        // タイムアウトさせるのは今回のレビュー試行だけで、起点の Turn ではない。後続の先頭リクエストも停止確認を待つ。
        const timer = setTimeout(() => deadline.abort(), this.options.timeoutMs ?? 60_000);
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
          const review = async () => {
            if (previousStop) await previousStop;
            if (stop.aborted || !canReview()) return null;
            this.#closing = undefined;
            return this.#review(request, nativeReview.operation, stop, canReview, queue?.onStopping);
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

  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.options.signal.removeEventListener("abort", this.#closeOnAbort);
    this.#lifetime.abort();
    this.#retireConversation();
  }

  #retireConversation(): void {
    const conversation = this.#conversation;
    if (!conversation) return;
    this.#conversation = undefined;
    // この会話がまだ開始処理中でも、停止を確認するまで代わりの会話は開始できない。
    this.#closing = conversation.ready.then((reviewer) => reviewer.close(), () => undefined);
    void this.#closing.catch(() => undefined);
    conversation.onStopping?.(this.#closing);
    conversation.controller.abort();
  }

  async #review(request: LiveApprovalRequest, operation: unknown, signal: AbortSignal, isCurrent: () => boolean,
    onStopping?: ApprovalReviewQueueContext["onStopping"],
  ): Promise<ApprovalReviewDecision["decision"] | null> {
    if (operation === null || typeof operation !== "object" || Object.keys(operation).length === 0) return null;
    const prompt = JSON.stringify({ source: this.options.source, turnId: this.options.turnId,
      workspacePath: this.options.workspacePath, pendingOperation: { ...request, operation } });
    // 不完全な操作や秘匿化された操作をレビューに委ねない。
    if (Buffer.byteLength(prompt) > 128 * 1024 || prompt.includes(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER)) return null;
    if (signal.aborted || !isCurrent()) return null;
    if (!this.#conversation) {
      const controller = new AbortController();
      this.#conversation = { controller, ready: Promise.resolve().then(() => this.options.open(controller.signal)), onStopping };
    }
    const conversation = await this.#conversation.ready;
    if (signal.aborted || !isCurrent()) return null;
    const response = approvalReviewDecisionSchema.safeParse(await conversation.review(prompt));
    if (!response.success || signal.aborted || !isCurrent()) return null;
    return response.data.decision;
  }
}
