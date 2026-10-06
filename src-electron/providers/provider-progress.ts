import type { ProviderAgentRuntimeBindingRedactor } from "./provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { RunSessionTurnProgressChanges, RunSessionTurnProgressHandler } from "./provider-runtime.js";

export const PROVIDER_PROGRESS_MAX_PENDING = 64;
export const PROVIDER_PROGRESS_MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Tracks mutations at the provider owner; unchanged detail is not projected again. */
export class ProviderProgressMap<T extends { id: string }> extends Map<string, T> {
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly projected = new Map<string, T>();

  constructor() { super(); }

  override set(key: string, value: T): this {
    super.set(key, value);
    this.changed.add(key);
    this.removed.delete(key);
    return this;
  }

  override delete(key: string): boolean {
    if (!super.delete(key)) return false;
    this.changed.delete(key);
    this.removed.add(key);
    return true;
  }

  override clear(): void {
    for (const key of this.keys()) this.removed.add(key);
    this.changed.clear();
    super.clear();
  }

  takeProgress(redactor: ProviderAgentRuntimeBindingRedactor): {
    snapshot: T[];
    changes: { upserts: T[]; removes: string[] };
  } {
    const upserts: T[] = [];
    for (const key of this.changed) {
      const value = redactor.sanitize(this.get(key)!);
      this.projected.set(key, value);
      upserts.push(value);
    }
    const removes = [...this.removed].map((key) => this.projected.get(key)?.id ?? redactor.sanitizeText(key));
    for (const key of this.removed) this.projected.delete(key);
    this.changed.clear();
    this.removed.clear();
    return { snapshot: [...this.projected.values()], changes: { upserts, removes } };
  }
}

/** Event-emitter producers cannot await consumers; refuse overload instead of queueing snapshots. */
export class ProviderProgressDelivery {
  private readonly pending = new Set<Promise<void>>();
  private pendingBytes = 0;

  constructor(
    private readonly handler: RunSessionTurnProgressHandler | undefined,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  deliver(state: LiveSessionRunState, changes: RunSessionTurnProgressChanges): Promise<void> {
    if (!this.handler) return Promise.resolve();
    const bytes = 2 * Buffer.byteLength(JSON.stringify({
      threadId: state.threadId,
      assistantText: state.assistantText,
      errorMessage: state.errorMessage,
      usage: state.usage,
      approvalRequest: state.approvalRequest,
      elicitationRequest: state.elicitationRequest,
      changes,
    }), "utf8");
    if (this.pending.size >= PROVIDER_PROGRESS_MAX_PENDING
      || bytes > PROVIDER_PROGRESS_MAX_PENDING_BYTES - this.pendingBytes) {
      const error = new Error("Provider progress persistence capacity exceeded.");
      this.onFailure(error);
      return Promise.reject(error);
    }
    this.pendingBytes += bytes;
    let operation: Promise<void>;
    try { operation = Promise.resolve(this.handler(state, changes)); }
    catch (error) { operation = Promise.reject(error); }
    const completion = operation.then(() => new Promise<void>((resolve) => setImmediate(resolve))).catch((error) => {
      this.onFailure(error);
      throw error;
    }).finally(() => {
      this.pending.delete(completion);
      this.pendingBytes -= bytes;
    });
    this.pending.add(completion);
    void completion.catch(() => undefined);
    return completion;
  }

}
