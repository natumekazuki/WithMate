import type { LiveApprovalDecision, LiveApprovalRequest } from "../../src-shared/session/runtime-state.js";
import type { WithMateAutoReviewSettings } from "../../src-shared/settings/withmate-auto-review.js";
import type { SessionTarget } from "../../src-shared/session/session-management-contract.js";
import { approvalReviewDecisionSchema, type ApprovalReviewerConversation } from "../providers/approval-reviewer.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER } from "../providers/provider-agent-runtime-binding.js";

export type PendingApprovalReview = {
  decide(signal: AbortSignal): Promise<LiveApprovalDecision | null>;
  isCurrent(): boolean;
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

/** One lazy reviewer conversation per source turn; decisions are never cached. */
export class WithMateApprovalReviewTurn {
  readonly #lifetime = new AbortController();
  #conversation?: ApprovalReviewerConversation;
  #busy = false;
  readonly #closeOnAbort = () => this.close();

  constructor(private readonly options: {
    source: SessionTarget;
    signal: AbortSignal;
    turnId: string;
    workspacePath: string;
    inputs: ApprovalReviewInputFence;
    policyCurrent(): boolean;
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
      decide: async (signal) => {
        if (!isCurrent() || signal.aborted || this.#busy) return null;
        this.#busy = true;
        const timing = new AbortController();
        const stop = AbortSignal.any([this.#lifetime.signal, timing.signal]);
        const timer = setTimeout(() => timing.abort(), this.options.timeoutMs ?? 60_000);
        let onStop!: () => void;
        const stopped = new Promise<null>((resolve) => { onStop = () => resolve(null); });
        stop.addEventListener("abort", onStop, { once: true });
        try {
          const outcome = await Promise.race([this.#review(request, nativeReview.operation, stop, () => isCurrent() && !signal.aborted), stopped]);
          if (stop.aborted) this.close();
          return isCurrent() && !signal.aborted ? outcome : null;
        } catch {
          this.close();
          return null;
        } finally {
          clearTimeout(timer);
          stop.removeEventListener("abort", onStop);
          this.#busy = false;
        }
      },
    };
  }

  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.options.signal.removeEventListener("abort", this.#closeOnAbort);
    this.#lifetime.abort();
    try { this.#conversation?.close(); }
    catch { /* Keep source approval independent of reviewer cleanup. */ }
  }

  async #review(request: LiveApprovalRequest, operation: unknown, signal: AbortSignal, isCurrent: () => boolean): Promise<LiveApprovalDecision | null> {
    const prompt = JSON.stringify({ source: this.options.source, turnId: this.options.turnId,
      workspacePath: this.options.workspacePath, pendingOperation: { ...request, operation } });
    // Never review a truncated operation. The original manual approval remains available.
    if (Buffer.byteLength(prompt) > 128 * 1024 || prompt.includes(PROVIDER_AGENT_RUNTIME_BINDING_REDACTED_MARKER)) return null;
    if (!this.#conversation) {
      const conversation = await this.options.open(this.#lifetime.signal);
      if (signal.aborted || this.#lifetime.signal.aborted) {
        conversation.close();
        return null;
      }
      this.#conversation = conversation;
    }
    if (!isCurrent()) return null;
    const response = approvalReviewDecisionSchema.safeParse(await this.#conversation.review(prompt));
    if (!response.success || !isCurrent()) return null;
    return response.data.decision === "allow_once" ? "approve" : response.data.decision === "deny" ? "deny" : null;
  }
}
