import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

/** 保存済みの本文と、その次の書き込みの照合に使う会話の識別情報・永続化リビジョン。 */
export type AuxiliaryDraftPersistenceRecord = AuxiliaryDraftRecord;

/** 保存を採用した場合は次回の照合に使うレコードを、採用しなかった場合は結果区分を返す。 */
export type AuxiliaryDraftPersistenceSaveResult =
  | { outcome: "saved"; record: AuxiliaryDraftPersistenceRecord }
  | { outcome: "stale" | "not-found" | "rejected" };

/** 所有者が使用する読み書きの境界、更新時刻の取得元、編集をまとめる待機時間。 */
export type AuxiliaryDraftPersistenceOwnerOptions = {
  load: () => Promise<AuxiliaryDraftPersistenceRecord | null>;
  save: (
    input: AuxiliaryDraftPersistenceRecord,
  ) => Promise<AuxiliaryDraftPersistenceSaveResult>;
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

  /** 下書き保存の依存処理を受け取り、待機時間を省略した場合は 200 ミリ秒にする。 */
  constructor(options: AuxiliaryDraftPersistenceOwnerOptions) {
    this.options = options;
    this.debounceMs = options.debounceMs ?? 200;
  }

  /** 最新の編集を保存待ちにし、送信失敗からの復元では元のレコードを照合に使う。 */
  enqueue(
    text: string,
    restoredFrom?: AuxiliaryDraftPersistenceRecord,
  ): Promise<void> {
    this.pending = text;
    this.pendingDirty = true;
    this.pendingRecovery = restoredFrom ?? null;
    if (restoredFrom) this.record = null;
    if (this.operation) return this.operation;
    this.operation = this.run();
    void this.operation.catch(() => undefined);
    return this.operation;
  }

  /** 待機時間を切り上げ、保留中の編集を保存し終わるまで待つ。前回の失敗で残った編集も再試行する。 */
  async flush(): Promise<void> {
    if (!this.pendingDirty && !this.operation) return;
    if (!this.operation && this.pendingDirty) {
      if (this.pending === null)
        throw new Error("Auxiliary draft pending value is unavailable.");
      this.enqueue(this.pending, this.pendingRecovery ?? undefined);
    }
    this.releaseDebounce?.();
    await this.operation;
  }

  /** 未保存の編集が残っているか、保存処理がまだ終わっていないかを返す。 */
  get hasPending(): boolean {
    return this.pendingDirty || this.operation !== null;
  }

  /** 最後に取得または保存したレコードの複製を返し、未取得なら null を返す。 */
  get durableRecord(): AuxiliaryDraftPersistenceRecord | null {
    return this.record ? { ...this.record } : null;
  }

  /** キャッシュが空の場合だけ永続化先から現在の下書きを取得する。 */
  async ensureLoaded(): Promise<AuxiliaryDraftPersistenceRecord | null> {
    if (!this.record) this.record = await this.options.load();
    return this.durableRecord;
  }

  /** 保存待ちがない場合だけ永続化先を読み直し、保存処理中の照合元は上書きしない。 */
  async reload(): Promise<AuxiliaryDraftPersistenceRecord | null> {
    if (this.hasPending) return this.durableRecord;
    this.record = await this.options.load();
    return this.durableRecord;
  }

  /** 保存が済んだ版を Turn に渡す。キャッシュを無効にし、Turn 終了を待たずに次の編集を受け付ける。 */
  dispatchTurn<T>(consume: () => Promise<T>): Promise<T> {
    if (this.consumption || this.hasPending)
      throw new Error("Auxiliary draft is still being saved.");
    // Turn の呼び出しが完了するのは入力受付時ではなく、Turn の終了時。
    // 後続の編集では、その終了を待たずに消費後の永続化済みリビジョンを読み取る必要がある。
    this.record = null;
    return consume();
  }

  /** 入力の消費中は後続編集の保存を待機させ、消費または復元後の版を読み直してから再開する。 */
  async withDraftConsumption<T>(consume: () => Promise<T>): Promise<T> {
    if (this.consumption || this.hasPending)
      throw new Error("Auxiliary draft is still being saved.");
    let release!: () => void;
    this.consumption = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await consume();
    } finally {
      // 下書きを消費するときも失敗から復元するときも、永続化済みリビジョンが進む。
      // 通常の CAS がそのリビジョンを使えるようになるまで、編集はキューで待機させる。
      this.record = null;
      try {
        this.record = await this.options.load();
      } catch {
        /* キューにある保存処理か次回の読み取りが、永続化の失敗を報告する。 */
      }
      this.consumption = null;
      release();
    }
  }

  /** 待機時間の後、保留中の本文を順に保存する。失敗時はキャッシュを破棄し、未保存の編集を再試行用に残す。 */
  private async run(): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        /** タイマーの満了と強制保存のどちらからでも待機を解除し、解除用参照を片付ける。 */
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
        if (text === null)
          throw new Error("Auxiliary draft pending value is unavailable.");
        if (!this.record) this.record = await this.options.load();
        if (!this.record)
          throw new Error("Auxiliary draft record was not found.");
        if (
          recovery &&
          (this.record.incarnation !== recovery.incarnation ||
            this.record.auxiliarySessionId !== recovery.auxiliarySessionId ||
            this.record.parentSessionId !== recovery.parentSessionId ||
            (this.record.text !== text &&
              (this.record.text !== "" ||
                this.record.durableRevision !== recovery.durableRevision + 1)))
        ) {
          throw new Error("Auxiliary draft changed after the failed send.");
        }
        // Main が取得済みの下書きを復元している場合がある。未復元なら
        // 消費時のリビジョンにだけ書き戻し、それより新しい永続化済みの編集は上書きしない。
        const result =
          recovery && this.record.text === text
            ? { outcome: "saved" as const, record: this.record }
            : await this.options.save({
                ...this.record,
                text,
                updatedAt: this.options.now(),
              });
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
