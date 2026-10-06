import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { CODEX_PROJECTION_MAX_PENDING, CODEX_PROJECTION_MAX_PENDING_BYTES, type CodexProjectionCommand, type CodexProjectionRequest, type CodexProjectionResponse, type CodexProjectionStart } from "./codex-projection-protocol.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; bytes: number; timer: NodeJS.Timeout };

/** One Worker per adapter, shared by concurrent turns; raw items never cross back per delta. */
export class CodexProjectionClient {
  private worker: Worker | null = null;
  private readonly runs = new Map<string, Worker>();
  private readonly pending = new Map<number, Pending>();
  private pendingBytes = 0;
  private nextId = 0;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const source = import.meta.url.endsWith(".ts");
    const worker = new Worker(new URL(source ? "./codex-projection-worker.ts" : "./codex-projection-worker.js", import.meta.url), source ? { execArgv: ["--import", "tsx"] } : {});
    this.worker = worker;
    worker.on("message", (response: CodexProjectionResponse) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      this.pendingBytes -= pending.bytes;
      clearTimeout(pending.timer);
      if (response.error !== undefined) pending.reject(new Error(response.error));
      else pending.resolve(response.value);
    });
    worker.on("error", () => this.fail(worker, new Error("Codex projection Worker failed.")));
    worker.on("exit", () => this.fail(worker, new Error("Codex projection Worker exited.")));
    return worker;
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.pendingBytes = 0;
    void worker.terminate();
  }

  async begin(input: CodexProjectionStart): Promise<string> {
    const worker = this.ensureWorker();
    const runId = randomUUID();
    this.runs.set(runId, worker);
    try { await this.call(runId, { type: "start", input }); return runId; }
    catch (error) { await this.release(runId); throw error; }
  }

  call<T>(runId: string, command: CodexProjectionCommand, bytes = Buffer.byteLength(JSON.stringify(command), "utf8")): Promise<T> {
    const worker = this.worker;
    if (!worker || this.runs.get(runId) !== worker) return Promise.reject(new Error("Codex projection run is unavailable."));
    if (this.pending.size >= CODEX_PROJECTION_MAX_PENDING || bytes > CODEX_PROJECTION_MAX_PENDING_BYTES - this.pendingBytes) {
      return Promise.reject(new Error("Codex projection capacity exceeded."));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(worker, new Error("Codex projection Worker response timed out.")), 5_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, bytes, timer });
      this.pendingBytes += bytes;
      try { worker.postMessage({ id, runId, command } satisfies CodexProjectionRequest); }
      catch { this.fail(worker, new Error("Codex projection dispatch failed.")); }
    });
  }

  async release(runId: string): Promise<void> {
    try { if (this.worker && this.runs.get(runId) === this.worker) await this.call(runId, { type: "release" }); }
    finally {
      this.runs.delete(runId);
      if (this.runs.size === 0 && this.worker) {
        const worker = this.worker;
        this.worker = null;
        await worker.terminate();
      }
    }
  }
}
