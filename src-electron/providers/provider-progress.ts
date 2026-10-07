import type { ProviderAgentRuntimeBindingRedactor } from "./provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { RunSessionTurnProgressChanges, RunSessionTurnProgressHandler } from "./provider-runtime.js";

/** Tracks mutations at the provider owner; unchanged detail is not projected again. */
export class ProviderProgressMap<T extends { id: string }> extends Map<string, T> {
  private readonly changed = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly projected = new Map<string, T>();
  private redactor: ProviderAgentRuntimeBindingRedactor | undefined;

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

  takeProgress(redactor: ProviderAgentRuntimeBindingRedactor, includeSnapshot = true): {
    snapshot: T[];
    changes: { upserts: T[]; removes: string[] };
  } {
    if (this.redactor !== redactor) {
      for (const key of this.keys()) this.changed.add(key);
      this.redactor = redactor;
    }
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
    return { snapshot: includeSnapshot ? [...this.projected.values()] : [], changes: { upserts, removes } };
  }
}

/** Delivers live state without a persistence queue. */
export class ProviderProgressDelivery {
  constructor(
    private readonly handler: RunSessionTurnProgressHandler | undefined,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  async deliver(state: LiveSessionRunState, changes: RunSessionTurnProgressChanges): Promise<void> {
    try { await this.handler?.(state, changes); }
    catch (error) { this.onFailure(error); throw error; }
  }
}
