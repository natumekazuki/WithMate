import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  CodexProjectionCommand,
  CodexProjectionRequest,
  CodexProjectionResponse,
  CodexProjectionStart,
} from "./codex-projection-protocol.js";

/** Worker から識別番号付きの応答を受け取るまで保持する完了処理とタイムアウト。 */
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** アダプターごとに 1 つの Worker を並行する Turn で共有し、差分ごとに生の項目を Worker から返さない。 */
export class CodexProjectionClient {
  private worker: Worker | null = null;
  private readonly runs = new Map<string, Worker>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  /** 共有 Worker を遅延起動し、現在の Worker からの応答だけを対応する要求へ渡す。 */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(
        source
          ? "./codex-projection-worker.ts"
          : "./codex-projection-worker.js",
        import.meta.url,
      ),
      source ? { execArgv: ["--import", "tsx"] } : {},
    );
    this.worker = worker;
    worker.on("message", (response: CodexProjectionResponse) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error !== undefined)
        pending.reject(new Error(response.error));
      else pending.resolve(response.value);
    });
    worker.on("error", () =>
      this.fail(worker, new Error("Codex projection Worker failed.")),
    );
    worker.on("exit", () =>
      this.fail(worker, new Error("Codex projection Worker exited.")),
    );
    return worker;
  }

  /** 現在の Worker が停止・失敗した場合に、応答待ちをすべて拒否して Worker を終了する。 */
  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void worker.terminate();
  }

  /** 実行 ID を割り当て、Worker が開始を受理してから返す。開始に失敗した場合は割り当てを解放する。 */
  async begin(input: CodexProjectionStart): Promise<string> {
    const worker = this.ensureWorker();
    const runId = randomUUID();
    this.runs.set(runId, worker);
    try {
      await this.call(runId, { type: "start", input });
      return runId;
    } catch (error) {
      await this.release(runId);
      throw error;
    }
  }

  /** 実行 ID が現在の Worker に属するときだけ要求を送り、応答が来なければ Worker を失敗扱いにする。 */
  call<T>(runId: string, command: CodexProjectionCommand): Promise<T> {
    const worker = this.worker;
    if (!worker || this.runs.get(runId) !== worker)
      return Promise.reject(new Error("Codex projection run is unavailable."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            worker,
            new Error("Codex projection Worker response timed out."),
          ),
        5_000,
      );
      this.pending.set(id, {
        /** コマンドで決まる戻り値の型として、対応する要求の待機者に渡す。 */
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        worker.postMessage({
          id,
          runId,
          command,
        } satisfies CodexProjectionRequest);
      } catch {
        this.fail(worker, new Error("Codex projection dispatch failed."));
      }
    });
  }

  /** Worker に実行の解放を要求し、登録を取り除く。並行する登録がなくなった場合だけ共有 Worker を終了する。 */
  async release(runId: string): Promise<void> {
    try {
      const worker = this.worker;
      if (worker && this.runs.get(runId) === worker) {
        // Worker が削除を確認するか、失敗時に安全側へ閉じるまで、実行の登録を維持する。
        await this.call(runId, { type: "release" });
      }
    } finally {
      this.runs.delete(runId);
      if (this.runs.size === 0 && this.worker) {
        const worker = this.worker;
        this.worker = null;
        await worker.terminate();
      }
    }
  }
}
