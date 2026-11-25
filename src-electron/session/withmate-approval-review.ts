import type { LiveApprovalDecision, LiveApprovalRequest } from "../../src-shared/session/runtime-state.js";
import type { WithMateAutoReviewSettings } from "../../src-shared/settings/withmate-auto-review.js";
import type { SessionTarget } from "../../src-shared/session/session-management-contract.js";
import { approvalReviewDecisionSchema, type ApprovalReviewerConversation } from "../providers/approval-reviewer.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER } from "../providers/provider-agent-runtime-binding.js";

export type PendingApprovalReview = {
  decide(signal: AbortSignal, queue?: ApprovalReviewQueueContext): Promise<LiveApprovalDecision | null>;
  isCurrent(): boolean;
};

type ApprovalReviewQueueContext = {
  isCurrentHead(): boolean;
  previousStop?: Promise<void>;
  onStopping(stopped: Promise<void>): void;
};

/** An in-memory fence, not a history index. An in-flight GUI input may affect an ancestor. */
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

/** Reuse a lazy reviewer conversation within the source turn until it is interrupted. */
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
    /** Uses the reviewer conversation's signal, not the source turn's signal. */
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
        // Time out this attempt, not the source Turn. A later head still needs confirmation of stop.
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
    // A replacement may start only after this conversation (including an in-progress open) is stopped.
    this.#closing = conversation.ready.then((reviewer) => reviewer.close(), () => undefined);
    void this.#closing.catch(() => undefined);
    conversation.onStopping?.(this.#closing);
    conversation.controller.abort();
  }

  async #review(request: LiveApprovalRequest, operation: unknown, signal: AbortSignal, isCurrent: () => boolean,
    onStopping?: ApprovalReviewQueueContext["onStopping"],
  ): Promise<LiveApprovalDecision | null> {
    const prompt = JSON.stringify({ source: this.options.source, turnId: this.options.turnId,
      workspacePath: this.options.workspacePath, pendingOperation: { ...request, operation } });
    // Never review a truncated operation. The original manual approval remains available.
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
    return response.data.decision === "allow_once" ? "approve" : response.data.decision === "deny" ? "deny" : null;
  }
}
