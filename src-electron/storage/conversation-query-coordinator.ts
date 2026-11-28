import { Worker } from "node:worker_threads";
import {
  CONVERSATION_QUERY_PAGE_SIZE,
  isConversationMessageIndexes,
  isConversationSearchAnchor,
  type ConversationSearchAnchor,
  type ConversationQueryCancelRequest,
  type ConversationQueryOutcome,
  type ConversationQueryStamp,
  type ConversationSearchRequest,
  type ConversationNavigatorRequest,
  type ConversationSearchMatch,
  type ConversationNavigatorEntry,
} from "../../src-shared/session/conversation-page.js";
import {
  CONVERSATION_QUERY_BATCH_SIZE,
  type ConversationQueryRow,
  type ConversationQuerySnapshot,
  type MessageTable,
} from "./conversation-query.js";
import type {
  ConversationProjectionInput,
  ConversationProjectionResult,
} from "./conversation-projection-worker.js";

/** ページに載る検索一致またはナビゲーター項目。 */
type Item = ConversationSearchMatch | ConversationNavigatorEntry;
/** CPU Worker が解釈する検索・ナビゲーターの条件。 */
type Query = ConversationProjectionInput["query"];
/** 会話の識別情報と保存行を、ストレージ所有者から同期的に取得する読み取り口。 */
export type ConversationQueryReader = {
  /** 現在の会話所有者と件数を取得する。対象が存在しなければ null を返す。 */
  getConversationQuerySnapshot(id: string): ConversationQuerySnapshot | null;
  /** 指定の seq より後を有界なバッチで読み、必要なら話者の出所を加える。 */
  readConversationQueryBatch(
    id: string,
    afterSeq: number,
    includeSpeakers?: boolean,
    messageIndexes?: readonly number[],
  ): ConversationQueryRow[];
};
/** 同期読み取りをストレージ側の実行順序に載せ、結果を非同期に受け取る境界。 */
export type ScheduleConversationRead = <T>(read: () => T) => Promise<T>;
/** 生成元の最新クエリ。後続ページを照合する条件と最初の読み取り時点、直近の完成ページを保持する。 */
type Producer = {
  table: MessageTable;
  id: string;
  requestId: string;
  query: Query;
  stamp?: ConversationQueryStamp;
  snapshot?: ConversationQuerySnapshot;
  invalidated: boolean;
  page?: ConversationQueryOutcome<Item>;
  anchor?: ConversationSearchAnchor;
  searchScope?: Set<number>;
  navigatorIndexes?: readonly number[];
  scopeSignature?: string;
};
/** 一ページの読み取り単位。同じページを待つ要求をまとめ、打ち切りと失効を区別する。 */
type Job = {
  producer: Producer;
  offset: number;
  schedule: ScheduleConversationRead;
  reader: ConversationQueryReader;
  /** ページの結果を、このジョブを共有する待機者に通知する。 */
  resolve(value: ConversationQueryOutcome<Item>): void;
  /** 投影や読み取りで起きた失敗を、このジョブの待機者へ伝える。 */
  reject(error: unknown): void;
  stopped?: "cancelled" | "invalidated";
  waiterCount: number;
};

/** 生成元ごとに CPU タスク一つと論理上の最新クエリ枠一つを持ち、上限付きのページ読み取りを3件扱う。 */
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

  /** 世代とテーブル別読み取り先を固定する。CPU Worker は投影要求が届くまで起動しない。 */
  constructor(
    private readonly generationId: string,
    private readonly readers: Record<MessageTable, ConversationQueryReader>,
    private readonly workerUrl = new URL(
      import.meta.url.endsWith(".ts")
        ? "./conversation-projection-worker.ts"
        : "./conversation-projection-worker.js",
      import.meta.url,
    ),
  ) {}

  /** 新しいクエリで同じ生成元の旧クエリを止める。継続ページは stamp と検索範囲が同じ場合に限って受け付ける。 */
  request(
    table: MessageTable,
    id: string,
    request: ConversationSearchRequest | ConversationNavigatorRequest,
    kind: "search" | "navigator",
    schedule: ScheduleConversationRead,
  ): Promise<ConversationQueryOutcome<Item>> {
    this.validate(request, kind);
    if (this.closed) return Promise.resolve({ status: "invalidated" });
    const query: Query =
      kind === "search"
        ? {
            kind,
            query: (request as ConversationSearchRequest).query,
            mode: (request as ConversationSearchRequest).mode,
          }
        : { kind, filter: (request as ConversationNavigatorRequest).filter };
    let producer = this.producers.get(request.producerId);
    const offset = request.offset ?? 0;
    const scopeSignature = request.messageIndexes?.join(",");
    if (request.stamp) {
      if (
        !producer ||
        producer.invalidated ||
        producer.id !== id ||
        producer.table !== table ||
        producer.requestId !== request.requestId ||
        producer.scopeSignature !== scopeSignature ||
        JSON.stringify(producer.query) !== JSON.stringify(query) ||
        !this.sameStamp(producer.stamp, request.stamp)
      ) {
        return Promise.resolve({ status: "invalidated" });
      }
    } else {
      if (producer) this.stopProducer(request.producerId, "cancelled");
      else if (this.producers.size >= 16) {
        const idle = [...this.producers.keys()].find(
          (key) =>
            !this.pending.has(key) &&
            this.active?.producer !== this.producers.get(key),
        );
        if (!idle) return Promise.resolve({ status: "cancelled" });
        this.producers.delete(idle);
      }
      producer = {
        table,
        id,
        requestId: request.requestId,
        query,
        invalidated: false,
        searchScope:
          kind === "search" && request.messageIndexes !== undefined
            ? new Set(request.messageIndexes)
            : undefined,
        navigatorIndexes:
          kind === "navigator" ? request.messageIndexes?.slice() : undefined,
        scopeSignature,
        anchor:
          kind === "search"
            ? (request as ConversationSearchRequest).anchor
            : undefined,
      };
      this.producers.set(request.producerId, producer);
    }
    const current = producer!;
    // キャッシュ済みのページも所有者との対応を再検証する。削除・再作成された場合は公開できない。
    return new Promise((resolve, reject) => {
      const jobs = this.pending.get(request.producerId) ?? [];
      const active =
        this.active?.producer === current && !this.active.stopped
          ? this.active
          : null;
      const duplicate =
        active?.offset === offset
          ? active
          : jobs.find((job) => job.offset === offset);
      if (duplicate) {
        if (duplicate.waiterCount >= 3) {
          resolve({ status: "cancelled" });
          return;
        }
        duplicate.waiterCount += 1;
        const previousResolve = duplicate.resolve;
        const previousReject = duplicate.reject;
        duplicate.resolve = (value) => {
          previousResolve(value);
          resolve(value);
        };
        duplicate.reject = (error) => {
          previousReject(error);
          reject(error);
        };
        return;
      }
      // 隣接する3ページは一つの論理的な最新クエリの一部であり、互いに置き換える別々のクエリではない。
      if (jobs.length + (active ? 1 : 0) >= 3) {
        resolve({ status: "cancelled" });
        return;
      }
      jobs.push({
        producer: current,
        offset,
        schedule,
        reader: this.readers[table],
        resolve,
        reject,
        waiterCount: 1,
      });
      this.pending.set(request.producerId, jobs);
      void this.pump();
    });
  }

  /** 生成元と要求 ID が現在のクエリに一致するときだけキャンセルする。 */
  cancel(request: ConversationQueryCancelRequest): void {
    if (
      !request ||
      typeof request.producerId !== "string" ||
      typeof request.requestId !== "string"
    )
      throw new TypeError("Conversation cancellation is invalid.");
    if (this.producers.get(request.producerId)?.requestId !== request.requestId)
      return;
    this.stopProducer(request.producerId, "cancelled");
    this.producers.delete(request.producerId);
  }

  /** 会話の更新でリビジョンを進め、対象のクエリとキャッシュ済みページを失効させる。ID 省略時はテーブル全体が対象。 */
  invalidate(table: MessageTable, id?: string): void {
    this.revision += 1;
    for (const [key, producer] of this.producers) {
      if (producer.table !== table || (id !== undefined && producer.id !== id))
        continue;
      producer.invalidated = true;
      producer.page = undefined;
      this.stopProducer(key, "invalidated");
    }
  }

  /** 新規要求の受付を終了し、残存クエリを失効させて CPU Worker の停止を待つ。 */
  async close(): Promise<void> {
    this.closed = true;
    for (const key of this.producers.keys())
      this.stopProducer(key, "invalidated");
    this.producers.clear();
    this.clearStopTimer();
    await this.terminateCpu();
  }

  /** ストレージ世代、会話所有者、内容リビジョン、要求 ID のすべてが一致するか判定する。 */
  private sameStamp(
    a: ConversationQueryStamp | undefined,
    b: ConversationQueryStamp,
  ): boolean {
    return Boolean(
      a &&
      a.generationId === b.generationId &&
      a.ownerIdentity === b.ownerIdentity &&
      a.contentRevision === b.contentRevision &&
      a.requestId === b.requestId,
    );
  }

  /** 依頼 ID、ページ位置、メッセージ範囲と用途固有の条件を検証し、不正な入力は例外にする。 */
  private validate(
    request: ConversationSearchRequest | ConversationNavigatorRequest,
    kind: "search" | "navigator",
  ): void {
    if (
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId ||
      request.requestId.length > 256 ||
      typeof request.producerId !== "string" ||
      !request.producerId ||
      request.producerId.length > 512 ||
      (request.offset !== undefined &&
        (!Number.isSafeInteger(request.offset) || request.offset < 0))
    )
      throw new TypeError("Conversation query is invalid.");
    if (
      request.messageIndexes !== undefined &&
      !isConversationMessageIndexes(request.messageIndexes)
    )
      throw new TypeError("Conversation query message indexes are invalid.");
    if (kind === "search") {
      const input = request as ConversationSearchRequest;
      if (
        typeof input.query !== "string" ||
        input.query.length > 10000 ||
        (input.mode !== "source" && input.mode !== "preview")
      )
        throw new TypeError("Conversation search is invalid.");
      if (
        input.anchor !== undefined &&
        !isConversationSearchAnchor(input.anchor)
      )
        throw new TypeError("Conversation search anchor is invalid.");
    } else if (
      !["all", "bookmarks"].includes(
        (request as ConversationNavigatorRequest).filter,
      )
    )
      throw new TypeError("Conversation navigator is invalid.");
  }

  /** 待機中と処理中のページに停止理由を返す。投影中の Worker が応答しなければ猶予後に停止する。 */
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
    if (
      active &&
      active.producer === this.producers.get(key) &&
      !active.stopped
    ) {
      active.stopped = status;
      active.resolve({ status });
      if (this.cpuReject && !this.stopTimer)
        this.stopTimer = setTimeout(() => {
          void this.terminateCpu();
        }, 250);
    }
  }

  /** 待機キューからページを一件ずつ実行し、未停止のジョブだけに結果や失敗を通知する。 */
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
    } finally {
      this.pumping = false;
    }
  }

  /** 所有者を確認してから保存行を順次投影し、全件数と要求ページを集約する。公開前に所有者と保存件数を再確認する。 */
  private async run(job: Job): Promise<ConversationQueryOutcome<Item>> {
    const producer = job.producer;
    const snapshot = await job.schedule(() =>
      job.reader.getConversationQuerySnapshot(producer.id),
    );
    if (job.stopped) return { status: job.stopped };
    if (
      !snapshot ||
      producer.invalidated ||
      (producer.snapshot &&
        producer.snapshot.ownerIdentity !== snapshot.ownerIdentity)
    )
      return { status: "invalidated" };
    if (!producer.stamp) {
      producer.stamp = {
        generationId: this.generationId,
        ownerIdentity: snapshot.ownerIdentity,
        contentRevision: this.revision,
        requestId: producer.requestId,
      };
      producer.snapshot = snapshot;
    }
    if (
      producer.page?.status === "complete" &&
      producer.page.offset === job.offset
    )
      return producer.page;
    let afterSeq = -1;
    const indexes = producer.navigatorIndexes;
    let scopeOffset = 0;
    let totalCount = 0;
    let anchorOrdinal: number | undefined;
    const items: Item[] = [];
    while (
      !job.stopped &&
      (indexes === undefined || scopeOffset < indexes.length) &&
      !(producer.query.kind === "search" && !producer.query.query.trim())
    ) {
      const window = indexes?.slice(
        scopeOffset,
        scopeOffset + CONVERSATION_QUERY_BATCH_SIZE,
      );
      const rows = await job.schedule(() =>
        job.reader.readConversationQueryBatch(
          producer.id,
          afterSeq,
          producer.query.kind === "navigator",
          window,
        ),
      );
      if (job.stopped) return { status: job.stopped };
      const last = rows.at(-1);
      // バイト数の上限でウィンドウが分割されることがある。保存行がもうないウィンドウはスキップできる。
      if (window && (!last || last.seq === window.at(-1)))
        scopeOffset += window.length;
      if (!last) {
        if (!window) break;
        continue;
      }
      afterSeq = last.seq;
      const selected = producer.searchScope
        ? rows.filter((row) => producer.searchScope!.has(row.seq))
        : rows;
      if (!selected.length) continue;
      const result = await this.project({
        cacheScope: `${snapshot.ownerIdentity}:${producer.stamp.contentRevision}`,
        provider: snapshot.provider,
        rows: selected,
        query: producer.query,
        offset: job.offset,
        countBefore: totalCount,
        anchor: producer.anchor,
      });
      if (job.stopped) return { status: job.stopped };
      totalCount += result.count;
      if (result.anchorOrdinal !== undefined)
        anchorOrdinal = result.anchorOrdinal;
      items.push(...result.items);
    }
    if (job.stopped) return { status: job.stopped };
    const final = await job.schedule(() =>
      job.reader.getConversationQuerySnapshot(producer.id),
    );
    if (job.stopped) return { status: job.stopped };
    if (
      !final ||
      producer.invalidated ||
      final.ownerIdentity !== snapshot.ownerIdentity ||
      final.messageCount !== snapshot.messageCount
    )
      return { status: "invalidated" };
    const page: ConversationQueryOutcome<Item> = {
      status: "complete",
      stamp: producer.stamp,
      incarnationId: snapshot.incarnationId,
      messageCount: snapshot.messageCount,
      totalCount,
      offset: job.offset,
      items: items.slice(0, CONVERSATION_QUERY_PAGE_SIZE),
      ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
    };
    producer.page = page;
    return page;
  }

  /** 既存の CPU Worker に一バッチを送り、投影結果を待つ。前の Worker が停止中なら終了後に起動する。 */
  private async project(
    input: ConversationProjectionInput,
  ): Promise<ConversationProjectionResult> {
    if (this.workerExit) await this.workerExit;
    if (!this.worker) {
      const created = new Worker(
        this.workerUrl,
        import.meta.url.endsWith(".ts")
          ? { execArgv: ["--import", "tsx"] }
          : {},
      );
      this.worker = created;
      // 待機中の CPU Worker の障害を、ストレージ所有者の未処理エラーにしてはならない。
      created.on("error", () => {});
      created.on("exit", () => {
        if (this.worker === created) this.worker = null;
      });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      /** 今回の投影専用のリスナーと停止用コールバックを解除する。 */
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", failure);
        worker.off("exit", exit);
        this.cpuReject = null;
      };
      /** Worker の応答から結果またはエラーを確定し、どちらもない応答は拒否する。 */
      const message = (value: {
        result?: ConversationProjectionResult;
        error?: string;
      }) => {
        cleanup();
        if (value.error) reject(new Error(value.error));
        else if (value.result) resolve(value.result);
        else reject(new Error("Conversation projection response is invalid."));
      };
      /** 投影の待機を失敗で終え、該当 Worker が現役なら停止を開始する。 */
      const failure = (error: unknown) => {
        cleanup();
        reject(error);
        if (this.worker === worker) void this.terminateCpu();
      };
      /** 投影中の Worker の終了をコード付きの失敗に変換する。 */
      const exit = (code: number) =>
        failure(new Error(`Conversation projection worker exited: ${code}`));
      this.cpuReject = failure;
      worker.once("message", message);
      worker.once("error", failure);
      worker.once("exit", exit);
      try {
        worker.postMessage(input);
      } catch (error) {
        failure(error);
      }
    });
  }

  /** 停止の猶予タイマーを解除し、次の停止要求で登録できる状態に戻す。 */
  private clearStopTimer(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }
  /** 現在の CPU Worker を切り離し、投影待ちを失敗させて終了を待つ。 */
  private async terminateCpu(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      if (this.workerExit) await this.workerExit;
      return;
    }
    this.worker = null;
    const exited = worker.terminate();
    this.workerExit = exited;
    this.cpuReject?.(new Error("Conversation projection was stopped."));
    await exited;
    if (this.workerExit === exited) this.workerExit = null;
  }
}
