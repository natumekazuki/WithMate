import { Worker } from "node:worker_threads";
import {
  CONVERSATION_QUERY_PAGE_SIZE,
  isConversationSearchAnchor, type ConversationSearchAnchor,
  type ConversationQueryCancelRequest, type ConversationQueryOutcome, type ConversationQueryStamp,
  type ConversationSearchRequest, type ConversationNavigatorRequest,
  type ConversationSearchMatch, type ConversationNavigatorEntry,
} from "../../src-shared/session/conversation-page.js";
import type { ConversationQueryRow, ConversationQuerySnapshot, MessageTable } from "./conversation-query.js";
import type { ConversationProjectionInput, ConversationProjectionResult } from "./conversation-projection-worker.js";

type Item = ConversationSearchMatch | ConversationNavigatorEntry;
type Query = ConversationProjectionInput["query"];
export type ConversationQueryReader = {
  getConversationQuerySnapshot(id: string): ConversationQuerySnapshot | null;
  readConversationQueryBatch(id: string, afterSeq: number): ConversationQueryRow[];
};
export type ScheduleConversationRead = <T>(read: () => T) => Promise<T>;
type Producer = {
  table: MessageTable; id: string; requestId: string; query: Query;
  stamp?: ConversationQueryStamp; snapshot?: ConversationQuerySnapshot;
  invalidated: boolean; page?: ConversationQueryOutcome<Item>;
  anchor?: ConversationSearchAnchor;
};
type Job = {
  producer: Producer; offset: number; schedule: ScheduleConversationRead; reader: ConversationQueryReader;
  resolve(value: ConversationQueryOutcome<Item>): void; reject(error: unknown): void;
  stopped?: "cancelled" | "invalidated";
  waiterCount: number;
};

/** One CPU task and one logical latest slot per producer, with three bounded page reads. */
export class ConversationQueryCoordinator {
  private readonly producers = new Map<string, Producer>();
  private readonly pending = new Map<string, Job[]>();
  private active: Job | null = null;
  private worker: Worker | null = null;
  private workerExit: Promise<unknown> | null = null;
  private cpuReject: ((error: unknown) => void) | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private revision = 0;
  private pumping = false;

  constructor(private readonly generationId: string, private readonly readers: Record<MessageTable, ConversationQueryReader>,
    private readonly workerUrl = new URL(import.meta.url.endsWith(".ts") ? "./conversation-projection-worker.ts" : "./conversation-projection-worker.js", import.meta.url)) {}

  request(table: MessageTable, id: string, request: ConversationSearchRequest | ConversationNavigatorRequest,
    kind: "search" | "navigator", schedule: ScheduleConversationRead): Promise<ConversationQueryOutcome<Item>> {
    this.validate(request, kind);
    if (this.closed) return Promise.resolve({ status: "invalidated" });
    const query: Query = kind === "search"
      ? { kind, query: (request as ConversationSearchRequest).query, mode: (request as ConversationSearchRequest).mode }
      : { kind, filter: (request as ConversationNavigatorRequest).filter };
    let producer = this.producers.get(request.producerId);
    const offset = request.offset ?? 0;
    if (request.stamp) {
      if (!producer || producer.invalidated || producer.id !== id || producer.table !== table || producer.requestId !== request.requestId
        || JSON.stringify(producer.query) !== JSON.stringify(query) || !this.sameStamp(producer.stamp, request.stamp)) {
        return Promise.resolve({ status: "invalidated" });
      }
    } else {
      if (producer) this.stopProducer(request.producerId, "cancelled");
      else if (this.producers.size >= 16) {
        const idle = [...this.producers.keys()].find((key) => !this.pending.has(key) && this.active?.producer !== this.producers.get(key));
        if (!idle) return Promise.resolve({ status: "cancelled" });
        this.producers.delete(idle);
      }
      producer = { table, id, requestId: request.requestId, query, invalidated: false,
        anchor: kind === "search" ? (request as ConversationSearchRequest).anchor : undefined };
      this.producers.set(request.producerId, producer);
    }
    const current = producer!;
    // A cached page is validated against its owner again; deletion/recreation cannot publish it.
    return new Promise((resolve, reject) => {
      const jobs = this.pending.get(request.producerId) ?? [];
      const active = this.active?.producer === current && !this.active.stopped ? this.active : null;
      const duplicate = active?.offset === offset ? active : jobs.find((job) => job.offset === offset);
      if (duplicate) {
        if (duplicate.waiterCount >= 3) { resolve({ status: "cancelled" }); return; }
        duplicate.waiterCount += 1;
        const previousResolve = duplicate.resolve;
        const previousReject = duplicate.reject;
        duplicate.resolve = (value) => { previousResolve(value); resolve(value); };
        duplicate.reject = (error) => { previousReject(error); reject(error); };
        return;
      }
      // Three neighboring pages belong to one logical latest query, not three replacements.
      if (jobs.length + (active ? 1 : 0) >= 3) { resolve({ status: "cancelled" }); return; }
      jobs.push({ producer: current, offset, schedule, reader: this.readers[table], resolve, reject, waiterCount: 1 });
      this.pending.set(request.producerId, jobs);
      void this.pump();
    });
  }

  cancel(request: ConversationQueryCancelRequest): void {
    if (!request || typeof request.producerId !== "string" || typeof request.requestId !== "string") throw new TypeError("Conversation cancellation is invalid.");
    if (this.producers.get(request.producerId)?.requestId !== request.requestId) return;
    this.stopProducer(request.producerId, "cancelled");
    this.producers.delete(request.producerId);
  }

  invalidate(table: MessageTable, id?: string): void {
    this.revision += 1;
    for (const [key, producer] of this.producers) {
      if (producer.table !== table || (id !== undefined && producer.id !== id)) continue;
      producer.invalidated = true;
      producer.page = undefined;
      this.stopProducer(key, "invalidated");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const key of this.producers.keys()) this.stopProducer(key, "invalidated");
    this.producers.clear();
    this.clearStopTimer();
    await this.terminateCpu();
  }

  private sameStamp(a: ConversationQueryStamp | undefined, b: ConversationQueryStamp): boolean {
    return Boolean(a && a.generationId === b.generationId && a.ownerIdentity === b.ownerIdentity
      && a.contentRevision === b.contentRevision && a.requestId === b.requestId);
  }

  private validate(request: ConversationSearchRequest | ConversationNavigatorRequest, kind: "search" | "navigator"): void {
    if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 256
      || typeof request.producerId !== "string" || !request.producerId || request.producerId.length > 512
      || (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))) throw new TypeError("Conversation query is invalid.");
    if (kind === "search") {
      const input = request as ConversationSearchRequest;
      if (typeof input.query !== "string" || input.query.length > 10000 || (input.mode !== "source" && input.mode !== "preview")) throw new TypeError("Conversation search is invalid.");
      if (input.anchor !== undefined && !isConversationSearchAnchor(input.anchor)) throw new TypeError("Conversation search anchor is invalid.");
    } else if (!["all", "bookmarks"].includes((request as ConversationNavigatorRequest).filter)) throw new TypeError("Conversation navigator is invalid.");
  }

  private stopProducer(key: string, status: "cancelled" | "invalidated"): void {
    const pending = this.pending.get(key);
    if (pending) {
      for (const job of pending) {
        job.stopped = status;
        job.resolve({ status });
      }
      this.pending.delete(key);
    }
    const active = this.active;
    if (active && active.producer === this.producers.get(key) && !active.stopped) {
      active.stopped = status;
      active.resolve({ status });
      if (this.cpuReject && !this.stopTimer) this.stopTimer = setTimeout(() => { void this.terminateCpu(); }, 250);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.pending.size) {
        const [key, jobs] = this.pending.entries().next().value!;
        const job = jobs.shift()!;
        this.pending.delete(key);
        if (jobs.length) this.pending.set(key, jobs);
        this.active = job;
        try {
          const result = await this.run(job);
          if (!job.stopped) job.resolve(result);
        } catch (error) {
          if (!job.stopped) job.reject(error);
        } finally {
          this.active = null;
          this.clearStopTimer();
          if (this.workerExit) await this.workerExit;
        }
      }
    } finally { this.pumping = false; }
  }

  private async run(job: Job): Promise<ConversationQueryOutcome<Item>> {
    const producer = job.producer;
    const snapshot = await job.schedule(() => job.reader.getConversationQuerySnapshot(producer.id));
    if (job.stopped) return { status: job.stopped };
    if (!snapshot || producer.invalidated || (producer.snapshot && producer.snapshot.ownerIdentity !== snapshot.ownerIdentity)) return { status: "invalidated" };
    if (!producer.stamp) {
      producer.stamp = { generationId: this.generationId, ownerIdentity: snapshot.ownerIdentity, contentRevision: this.revision, requestId: producer.requestId };
      producer.snapshot = snapshot;
    }
    if (producer.page?.status === "complete" && producer.page.offset === job.offset) return producer.page;
    let afterSeq = -1;
    let totalCount = 0;
    let anchorOrdinal: number | undefined;
    const items: Item[] = [];
    while (!job.stopped && !(producer.query.kind === "search" && !producer.query.query.trim())) {
      const rows = await job.schedule(() => job.reader.readConversationQueryBatch(producer.id, afterSeq));
      if (job.stopped) return { status: job.stopped };
      if (!rows.length) break;
      const result = await this.project({ cacheScope: `${snapshot.ownerIdentity}:${producer.stamp.contentRevision}`,
        provider: snapshot.provider, rows, query: producer.query, offset: job.offset, countBefore: totalCount, anchor: producer.anchor });
      if (job.stopped) return { status: job.stopped };
      totalCount += result.count;
      if (result.anchorOrdinal !== undefined) anchorOrdinal = result.anchorOrdinal;
      items.push(...result.items);
      afterSeq = rows.at(-1)!.seq;
    }
    if (job.stopped) return { status: job.stopped };
    const final = await job.schedule(() => job.reader.getConversationQuerySnapshot(producer.id));
    if (job.stopped) return { status: job.stopped };
    if (!final || producer.invalidated || final.ownerIdentity !== snapshot.ownerIdentity || final.messageCount !== snapshot.messageCount) return { status: "invalidated" };
    const page: ConversationQueryOutcome<Item> = { status: "complete", stamp: producer.stamp, incarnationId: snapshot.incarnationId,
      messageCount: snapshot.messageCount, totalCount, offset: job.offset, items: items.slice(0, CONVERSATION_QUERY_PAGE_SIZE),
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }) };
    producer.page = page;
    return page;
  }

  private async project(input: ConversationProjectionInput): Promise<ConversationProjectionResult> {
    if (this.workerExit) await this.workerExit;
    if (!this.worker) {
      const created = new Worker(this.workerUrl, import.meta.url.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {});
      this.worker = created;
      // An idle CPU worker fault must not become an unhandled Storage owner error.
      created.on("error", () => {});
      created.on("exit", () => { if (this.worker === created) this.worker = null; });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const cleanup = () => { worker.off("message", message); worker.off("error", failure); worker.off("exit", exit); this.cpuReject = null; };
      const message = (value: { result?: ConversationProjectionResult; error?: string }) => {
        cleanup();
        if (value.error) reject(new Error(value.error));
        else if (value.result) resolve(value.result);
        else reject(new Error("Conversation projection response is invalid."));
      };
      const failure = (error: unknown) => {
        cleanup();
        reject(error);
        if (this.worker === worker) void this.terminateCpu();
      };
      const exit = (code: number) => failure(new Error(`Conversation projection worker exited: ${code}`));
      this.cpuReject = failure;
      worker.once("message", message);
      worker.once("error", failure);
      worker.once("exit", exit);
      try { worker.postMessage(input); } catch (error) { failure(error); }
    });
  }

  private clearStopTimer(): void { if (this.stopTimer) clearTimeout(this.stopTimer); this.stopTimer = null; }
  private async terminateCpu(): Promise<void> {
    const worker = this.worker;
    if (!worker) { if (this.workerExit) await this.workerExit; return; }
    this.worker = null;
    const exited = worker.terminate();
    this.workerExit = exited;
    this.cpuReject?.(new Error("Conversation projection was stopped."));
    await exited;
    if (this.workerExit === exited) this.workerExit = null;
  }
}
