import type { AuxiliaryDraftRecord } from "../auxiliary-draft-contract.js";

export type AuxiliaryDraftPersistenceRecord = AuxiliaryDraftRecord;

export type AuxiliaryDraftPersistenceSaveResult =
  | { outcome: "saved"; record: AuxiliaryDraftPersistenceRecord }
  | { outcome: "stale" | "not-found" | "rejected" };

export type AuxiliaryDraftPersistenceOwnerOptions = {
  load: () => Promise<AuxiliaryDraftPersistenceRecord | null>;
  save: (input: AuxiliaryDraftPersistenceRecord) => Promise<AuxiliaryDraftPersistenceSaveResult>;
  now: () => string;
  debounceMs?: number;
};

/** One owner serializes persistence and retains only the newest unsaved value. */
export class AuxiliaryDraftPersistenceOwner {
  private readonly options: AuxiliaryDraftPersistenceOwnerOptions;
  private readonly debounceMs: number;
  private record: AuxiliaryDraftPersistenceRecord | null = null;
  private pending: string | null = null;
  private pendingDirty = false;
  private pendingRecovery: AuxiliaryDraftPersistenceRecord | null = null;
  private operation: Promise<void> | null = null;

  constructor(options: AuxiliaryDraftPersistenceOwnerOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 200;
  }

  enqueue(text: string, restoredFrom?: AuxiliaryDraftPersistenceRecord): Promise<void> {
    this.pending = text;
    this.pendingDirty = true;
    this.pendingRecovery = restoredFrom ?? null;
    if (restoredFrom) this.record = null;
    if (this.operation) return this.operation;
    this.operation = this.run();
    void this.operation.catch(() => undefined);
    return this.operation;
  }

  async flush(): Promise<void> {
    if (!this.pendingDirty && !this.operation) return;
    if (!this.operation && this.pendingDirty) {
      if (this.pending === null) throw new Error("Auxiliary draft pending value is unavailable.");
      this.enqueue(this.pending, this.pendingRecovery ?? undefined);
    }
    await this.operation;
  }

  get hasPending(): boolean {
    return this.pendingDirty || this.operation !== null;
  }

  get durableRecord(): AuxiliaryDraftPersistenceRecord | null {
    return this.record ? { ...this.record } : null;
  }

  async ensureLoaded(): Promise<AuxiliaryDraftPersistenceRecord | null> {
    if (!this.record) this.record = await this.options.load();
    return this.durableRecord;
  }

  async reload(): Promise<AuxiliaryDraftPersistenceRecord | null> {
    if (this.hasPending) return this.durableRecord;
    this.record = await this.options.load();
    return this.durableRecord;
  }

  private async run(): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, this.debounceMs));
      while (this.pendingDirty) {
        const text = this.pending;
        const recovery = this.pendingRecovery;
        if (text === null) throw new Error("Auxiliary draft pending value is unavailable.");
        if (!this.record) this.record = await this.options.load();
        if (!this.record) throw new Error("Auxiliary draft record was not found.");
        if (recovery && (
          this.record.incarnation !== recovery.incarnation
          || this.record.auxiliarySessionId !== recovery.auxiliarySessionId
          || this.record.parentSessionId !== recovery.parentSessionId
          || (this.record.text !== text && (
            this.record.text !== "" || this.record.durableRevision !== recovery.durableRevision + 1
          ))
        )) {
          throw new Error("Auxiliary draft changed after the failed send.");
        }
        // Main may already have restored the captured draft. Otherwise only fill
        // the exact consume revision; never overwrite a later durable edit.
        const result = recovery && this.record.text === text
          ? { outcome: "saved" as const, record: this.record }
          : await this.options.save({ ...this.record, text, updatedAt: this.options.now() });
        if (result.outcome !== "saved") {
          throw new Error(`Auxiliary draft save ${result.outcome}.`);
        }
        this.record = result.record;
        if (this.pending === text) {
          this.pendingDirty = false;
          this.pending = null;
          this.pendingRecovery = null;
        }
      }
    } catch (error) {
      this.record = null;
      throw error;
    } finally {
      this.operation = null;
    }
  }
}
