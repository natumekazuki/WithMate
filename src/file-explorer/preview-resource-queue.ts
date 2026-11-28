/** プレビューのリソースを準備する処理。世代が変わっていないかを呼び出し中に確認できる。 */
export type PreviewResourceTask = (
  isCurrent: () => boolean,
) => Promise<string | null>;

/** 投入時の世代と、処理結果を投入元へ返すためのコールバックを保持する待機項目。 */
type PreviewResourceQueueEntry = {
  generation: number;
  task: PreviewResourceTask;
  resolve: (value: string | null) => void;
  reject: (reason: unknown) => void;
};

/** 準備処理を同時実行数以内で進め、無効になった世代の待機項目は実行しない。 */
export class PreviewResourceQueue {
  private readonly concurrency: number;

  private activeCount = 0;

  private generation = 0;

  private readonly pending: PreviewResourceQueueEntry[] = [];

  /** キューの同時実行数を固定し、正の整数でない上限は受け付けない。 */
  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        "Preview resource concurrency must be a positive integer.",
      );
    }
    this.concurrency = concurrency;
  }

  /** 現世代で処理を予約し、結果・未実行の null・処理失敗のいずれかを返す。 */
  run(task: PreviewResourceTask): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        generation: this.generation,
        task,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  /** 待機中の処理を null で解決し、開始済みの処理には世代の変更を観測できるようにする。 */
  invalidate(): void {
    this.generation += 1;
    const staleEntries = this.pending.splice(0);
    for (const entry of staleEntries) {
      entry.resolve(null);
    }
  }

  /** 空き枠に現世代の待機処理を順に入れ、成功・失敗のどちらでも枠を空けて次を進める。 */
  private drain(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) {
        return;
      }
      if (entry.generation !== this.generation) {
        entry.resolve(null);
        continue;
      }

      this.activeCount += 1;
      /** 処理の開始後も、予約時の世代がまだ有効かを判定する。 */
      const isCurrent = () => entry.generation === this.generation;
      void Promise.resolve()
        .then(() => entry.task(isCurrent))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.drain();
        });
    }
  }
}
