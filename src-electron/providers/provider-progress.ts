import type { ProviderAgentRuntimeBindingRedactor } from "./provider-agent-runtime-binding.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { RunSessionTurnProgressChanges, RunSessionTurnProgressHandler } from "./provider-runtime.js";

/** Updates the existing Main snapshot without retaining another collection owner. */
export function applyProviderProgressChanges<T extends { id: string }>(
  current: T[], changes: { upserts: T[]; removes: string[] },
): T[] {
  if (!changes.upserts.length && !changes.removes.length) return current;
  const items = new Map(current.map(item => [item.id, item]));
  for (const id of changes.removes) items.delete(id);
  for (const item of changes.upserts) items.set(item.id, item);
  return [...items.values()];
}

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

/** Forward required progress without retaining snapshots or sizing a duplicate payload. */
export class ProviderProgressDelivery {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly handler: RunSessionTurnProgressHandler | undefined,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  deliver(state: LiveSessionRunState, changes: RunSessionTurnProgressChanges): Promise<void> {
    if (!this.handler) return Promise.resolve();
    let operation: Promise<void>;
    try { operation = Promise.resolve(this.handler(state, changes)); }
    catch (error) { operation = Promise.reject(error); }
    const completion = operation.catch((error) => {
      this.onFailure(error);
      throw error;
    }).finally(() => { this.pending.delete(completion); });
    this.pending.add(completion);
    void completion.catch(() => undefined);
    return completion;
  }

  async drain(): Promise<void> { await Promise.all(this.pending); }
}
