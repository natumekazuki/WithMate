import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

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

/** 一つの所有者が永続化を直列化し、未保存の値は最新のものだけを保持する。 */
export class AuxiliaryDraftPersistenceOwner {
  private readonly options: AuxiliaryDraftPersistenceOwnerOptions;
  private readonly debounceMs: number;
  private record: AuxiliaryDraftPersistenceRecord | null = null;
  private pending: string | null = null;
  private pendingDirty = false;
  private pendingRecovery: AuxiliaryDraftPersistenceRecord | null = null;
  private operation: Promise<void> | null = null;
  private releaseDebounce: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private consumption: Promise<void> | null = null;

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
    this.releaseDebounce?.();
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

  dispatchTurn<T>(consume: () => Promise<T>): Promise<T> {
    if (this.consumption || this.hasPending) throw new Error("Auxiliary draft is still being saved.");
    // Turn の呼び出しが完了するのは入力受付時ではなく、Turn の終了時。
    // 後続の編集では、その終了を待たずに消費後の永続化済みリビジョンを読み取る必要がある。
    this.record = null;
    return consume();
  }

  async withDraftConsumption<T>(consume: () => Promise<T>): Promise<T> {
    if (this.consumption || this.hasPending) throw new Error("Auxiliary draft is still being saved.");
    let release!: () => void;
    this.consumption = new Promise<void>((resolve) => { release = resolve; });
    try {
      return await consume();
    } finally {
      // 下書きを消費するときも失敗から復元するときも、永続化済みリビジョンが進む。
      // 通常の CAS がそのリビジョンを使えるようになるまで、編集はキューで待機させる。
      this.record = null;
      try { this.record = await this.options.load(); } catch { /* キューにある保存処理か次回の読み取りが、永続化の失敗を報告する。 */ }
      this.consumption = null;
      release();
    }
  }

  private async run(): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        const release = () => {
          if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          this.releaseDebounce = null;
          resolve();
        };
        this.releaseDebounce = release;
        this.debounceTimer = setTimeout(release, this.debounceMs);
      });
      while (this.pendingDirty) {
        if (this.consumption) await this.consumption;
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
        // Main が取得済みの下書きを復元している場合がある。未復元なら
        // 消費時のリビジョンにだけ書き戻し、それより新しい永続化済みの編集は上書きしない。
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
