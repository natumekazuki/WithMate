import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  spawnOwnedProviderProcess as spawnOwnedCodexProcess,
  OwnedProviderProcessAcquisitionError as OwnedCodexProcessAcquisitionError,
  type OwnedProviderProcessCleanupOwner as OwnedCodexProcessCleanupOwner,
} from "../owned-process.js";

/** Codex App Server を標準入出力で起動するときの既定引数。 */
export const CODEX_APP_SERVER_ARGUMENTS = [
  "app-server",
  "--listen",
  "stdio://",
] as const;
/** 一件の RPC に適用する任意の中断条件と待機時間の上書き。 */
export type CodexRequestOptions = { signal?: AbortSignal; timeoutMs?: number };
/** App Server のエラー応答で受け取る数値コード・説明・任意の追加データ。 */
export type CodexWireError = { code: number; message: string; data?: unknown };
/** 送出先から届いた通知と、元の ID で一度だけ応答できるサーバー要求を区別する。 */
export type CodexProtocolEvent =
  | { kind: "notification"; method: string; params: unknown }
  | {
      kind: "serverRequest";
      id: string | number;
      method: string;
      params: unknown;
      /** サーバー要求へメソッド固有の成功値を返す。 */
      respond(result: unknown): Promise<void>;
      /** サーバー要求を処理できない場合にエラー応答を返す。 */
      reject(error: CodexWireError): Promise<void>;
    };
/** プロセスの起動条件・クライアント識別情報と、初期化・要求・終了それぞれの待機上限。 */
export type CodexAppServerTransportOptions = {
  executable: string;
  arguments?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo: { name: string; title?: string; version: string };
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
};

/** ネイティブ RPC の失敗を、コードと任意の追加データを失わずに呼び出し元へ伝える。 */
export class CodexAppServerRpcError extends Error {
  /** 応答で受け取ったコードと追加データを保持し、トランスポートの切断と区別する。 */
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

/** 一件の RPC または次のイベントを待つ呼び出し元と、待機終了時の処理。 */
type Pending = {
  /** 受信した結果を待機者へ渡す。 */
  resolve(value: unknown): void;
  /** RPC エラー、切断やキャンセルを待機者へ伝える。 */
  reject(error: Error): void;
  /** 要求のタイマーや中断監視を終了する。 */
  cleanup(): void;
};

/** 管理下の App Server の起動・終了と、改行区切りの RPC・通知の送受信を管理する。 */
export class CodexAppServerTransport {
  #state: "idle" | "starting" | "ready" | "closing" | "closed" | "failed" =
    "idle";
  #child?: ChildProcessWithoutNullStreams;
  #owner?: OwnedCodexProcessCleanupOwner;
  #startPromise?: Promise<unknown>;
  #closePromise?: Promise<void>;
  #exitPromise?: Promise<void>;
  #resolveClosed!: () => void;
  #closedPromise = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  #terminalError?: Error;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #events: (CodexProtocolEvent | undefined)[] = [];
  #eventHead = 0;
  #waiters: Pending[] = [];
  #serverRequests = new Set<string>();
  #options: CodexAppServerTransportOptions;
  #spawnOwnedProcess: typeof spawnOwnedCodexProcess;

  /** 必要な実行ファイル名・クライアント情報とタイマー範囲を検証し、起動時に使う入力をコピーする。 */
  constructor(
    options: CodexAppServerTransportOptions,
    dependencies: { spawnOwnedProcess?: typeof spawnOwnedCodexProcess } = {},
  ) {
    if (
      !options.executable ||
      !options.clientInfo.name ||
      !options.clientInfo.version
    ) {
      throw new TypeError("Codex executable and clientInfo are required.");
    }
    for (const duration of [
      options.startupTimeoutMs,
      options.requestTimeoutMs,
      options.closeTimeoutMs,
    ]) {
      if (
        duration !== undefined &&
        (!Number.isSafeInteger(duration) ||
          duration < 1 ||
          duration > 2_147_483_647)
      ) {
        throw new RangeError(
          "Codex timeouts must be positive Node timer durations.",
        );
      }
    }
    this.#options = {
      ...options,
      clientInfo: { ...options.clientInfo },
      arguments: [...(options.arguments ?? CODEX_APP_SERVER_ARGUMENTS)],
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
    };
    this.#spawnOwnedProcess =
      dependencies.spawnOwnedProcess ?? spawnOwnedCodexProcess;
  }

  /** トランスポートの現在のライフサイクル状態を返す。 */
  get state() {
    return this.#state;
  }

  /** 初期化の最初の試行を共有する。未開始でも idle でない場合や事前中断は拒否する。 */
  start(signal?: AbortSignal): Promise<unknown> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "idle")
      return Promise.reject(new Error("Codex transport is not idle."));
    if (signal?.aborted) return Promise.reject(abortError());
    this.#state = "starting";
    this.#startPromise = this.#start(signal);
    return this.#startPromise;
  }

  /** 管理下の子を起動し、初期化の応答と通知の送出が成立してから ready にする。失敗時は取得済みの子を片付ける。 */
  async #start(signal?: AbortSignal): Promise<unknown> {
    try {
      const owner = this.#spawnOwnedProcess({
        executable: this.#options.executable,
        arguments: this.#options.arguments!,
        cwd: this.#options.cwd,
        env: this.#options.env,
      });
      this.#owner = owner;
      const child = owner.child;
      this.#child = child;
      this.#exitPromise = new Promise((resolve) => {
        child.once("close", () => resolve());
      });
      this.#attach(child);
      await withTimeout(
        owner.ready,
        this.#options.startupTimeoutMs ?? 10_000,
        signal,
      );
      const result = await this.#request(
        "initialize",
        {
          clientInfo: this.#options.clientInfo,
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: true,
          },
        },
        { signal, timeoutMs: this.#options.startupTimeoutMs ?? 10_000 },
      );
      if (
        !isObject(result) ||
        typeof result.userAgent !== "string" ||
        typeof result.codexHome !== "string" ||
        !path.isAbsolute(result.codexHome) ||
        typeof result.platformFamily !== "string" ||
        typeof result.platformOs !== "string"
      ) {
        throw new Error("Codex initialize response is invalid.");
      }
      await this.#write({ method: "initialized" });
      if (this.#terminalError) throw this.#terminalError;
      this.#state = "ready";
      return result;
    } catch (error) {
      if (error instanceof OwnedCodexProcessAcquisitionError) {
        this.#owner = error.owner;
        this.#child = error.owner.child;
        this.#child?.on("error", () => {});
        if (this.#child) {
          this.#exitPromise = new Promise((resolve) => {
            this.#child!.once("close", () => resolve());
          });
        }
      }
      const failure = asError(error);
      this.#fail(failure);
      await this.close();
      throw failure;
    }
  }

  /** 初期化済みの接続だけに RPC を送り、サーバーの成功結果を呼び出し元の型で返す。 */
  request<T>(
    method: string,
    params?: unknown,
    options: CodexRequestOptions = {},
  ): Promise<T> {
    if (this.#state !== "ready")
      return Promise.reject(
        this.#terminalError ?? new Error("Codex transport is not ready."),
      );
    return this.#request(method, params, options) as Promise<T>;
  }

  /** 要求 ID ごとに待機を登録してから送信し、応答・タイムアウト・中断・書き込み失敗を一度だけ処理する。 */
  #request(
    method: string,
    params: unknown,
    options: CodexRequestOptions,
  ): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const timeoutMs =
      options.timeoutMs ?? this.#options.requestTimeoutMs ?? 30_000;
    if (
      !method ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 2_147_483_647
    ) {
      return Promise.reject(
        new TypeError("Invalid Codex request method or timeout."),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      /** 同じ要求がまだ待機中の場合だけ取り除き、監視を解除して失敗を伝える。 */
      const settle = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const timer = setTimeout(
        () => settle(new Error(`Codex request timed out: ${method}`)),
        timeoutMs,
      );
      /** この要求の中断を、接続全体の失敗と区別して待機者へ伝える。 */
      const onAbort = () => settle(abortError());
      this.#pending.set(id, {
        resolve,
        reject,
        /** 要求完了後に不要になったタイマーと中断監視を解除する。 */
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      void this.#write({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }).catch(settle);
    });
  }

  /** 受信済みイベントを FIFO で返し、空なら次を待つ。受信済みの分を返し終えてから終了エラーを伝える。 */
  nextEvent(): Promise<CodexProtocolEvent> {
    const queued = this.#events[this.#eventHead];
    if (queued) {
      this.#events[this.#eventHead++] = undefined;
      if (this.#eventHead === this.#events.length) {
        this.#events = [];
        this.#eventHead = 0;
      } else if (
        this.#eventHead >= 1024 &&
        this.#eventHead >= this.#events.length / 2
      ) {
        this.#events = this.#events.slice(this.#eventHead);
        this.#eventHead = 0;
      }
      return Promise.resolve(queued);
    }
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#state !== "ready" && this.#state !== "starting")
      return Promise.reject(new Error("Codex transport is closed."));
    return new Promise((resolve, reject) =>
      this.#waiters.push({
        /** 受信キューの次のイベントを、待っている呼び出し元へ渡す。 */
        resolve: (value) => resolve(value as CodexProtocolEvent),
        reject,
        /** イベント待ちには個別タイマーや中断監視を付けない。 */
        cleanup() {},
      }),
    );
  }

  /** 標準出力を UTF-8 の改行区切り JSON として処理し、不正フレームや予期しない切断をトランスポートの失敗にする。 */
  #attach(child: ChildProcessWithoutNullStreams): void {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let line = "";
    let partialFrame = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (
        this.#terminalError ||
        this.#state === "closing" ||
        this.#state === "closed"
      )
        return;
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          partialFrame ||= segment.length > 0;
          line += decoder.decode(segment, { stream: true });
          if (newline < 0) break;
          line += decoder.decode();
          this.#accept(JSON.parse(line));
          line = "";
          partialFrame = false;
          offset = newline + 1;
        }
      } catch (error) {
        this.#fail(
          new Error("Codex stdout protocol failure.", { cause: error }),
        );
      }
    });
    child.stdout.on("end", () => {
      if (this.#state === "closing" || this.#state === "closed") return;
      this.#fail(
        new Error(
          partialFrame
            ? "Codex stdout ended with a partial frame."
            : "Codex stdout disconnected.",
        ),
      );
    });
    child.stdout.on("error", (error) => this.#fail(error));
    child.stdin.on("error", (error) => this.#fail(error));
    child.stderr.on("error", (error) => this.#fail(error));
    // 診断出力は読み捨て、任意の CLI 出力や認証情報は保持しない。
    child.stderr.resume();
    child.on("error", (error) => this.#fail(error));
    child.on("exit", (code, signal) => {
      if (this.#state !== "closing" && this.#state !== "closed")
        this.#fail(new Error(`Codex process exited (${code ?? signal}).`));
    });
    child.on("close", (code, signal) => {
      if (this.#state !== "closing" && this.#state !== "closed")
        this.#fail(new Error(`Codex process exited (${code ?? signal}).`));
    });
  }

  /** 受信した値を応答・通知・サーバー要求に分類し、送信元の型付き ID と対応させる。 */
  #accept(value: unknown): void {
    if (!isObject(value)) throw new Error("Invalid Codex envelope.");
    const hasId = Object.hasOwn(value, "id");
    if (hasId && !isId(value.id)) throw new Error("Invalid Codex request ID.");
    if (typeof value.method === "string" && value.method.length > 0) {
      if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))
        throw new Error("Invalid Codex request envelope.");
      let event: CodexProtocolEvent;
      if (hasId) {
        const id = value.id as string | number;
        const key = `${typeof id}:${id}`;
        if (this.#serverRequests.has(key))
          throw new Error("Duplicate Codex server request.");
        this.#serverRequests.add(key);
        let responded = false;
        /** 同じサーバー要求に一度だけ応答する。書き込む前に応答済みとし、失敗時の重複応答も防ぐ。 */
        const respond = async (response: object) => {
          if (responded || !this.#serverRequests.has(key))
            throw new Error("Codex server request is already resolved.");
          responded = true;
          this.#serverRequests.delete(key);
          await this.#write({ id, ...response });
        };
        event = {
          kind: "serverRequest",
          id,
          method: value.method,
          params: value.params,
          /** 成功値を結果フィールドに載せ、元のサーバー要求に返す。 */
          respond: (result) => respond({ result }),
          /** 失敗をエラーフィールドに載せ、同じ一回限りの応答経路を使う。 */
          reject: (error) => respond({ error }),
        };
      } else
        event = {
          kind: "notification",
          method: value.method,
          params: value.params,
        };
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(event);
      else this.#events.push(event);
      return;
    }
    if (
      !hasId ||
      Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
    )
      throw new Error("Invalid Codex response envelope.");
    if (
      Object.hasOwn(value, "error") &&
      (!isObject(value.error) ||
        !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== "string")
    ) {
      throw new Error("Invalid Codex RPC error.");
    }
    // ローカルで中断またはタイムアウトしたリクエストへの遅延応答を、新しいリクエストとして扱わない。
    const pending =
      typeof value.id === "number" ? this.#pending.get(value.id) : undefined;
    if (!pending) return;
    this.#pending.delete(value.id as number);
    pending.cleanup();
    if (isObject(value.error))
      pending.reject(
        new CodexAppServerRpcError(
          value.error.code as number,
          value.error.message as string,
          value.error.data,
        ),
      );
    else pending.resolve(value.result);
  }

  /** メッセージ一件を改行区切り JSON で送る。閉じた接続には書かず、書き込みに失敗したら接続の失敗として扱う。 */
  #write(value: object): Promise<void> {
    if (
      this.#terminalError ||
      !this.#child ||
      this.#state === "closing" ||
      this.#state === "closed"
    ) {
      return Promise.reject(
        this.#terminalError ?? new Error("Codex transport is closed."),
      );
    }
    let frame: string;
    try {
      frame = `${JSON.stringify(value)}\n`;
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return new Promise((resolve, reject) => {
      this.#child!.stdin.write(frame, (error) => {
        if (error) {
          this.#fail(error);
          reject(error);
        } else resolve();
      });
    });
  }

  /** 最初のトランスポートエラーを保存し、待機している要求を拒否して後片付けを始める。 */
  #fail(error: Error): void {
    if (
      this.#terminalError ||
      this.#state === "closing" ||
      this.#state === "closed"
    )
      return;
    this.#state = "failed";
    this.#terminalError = error;
    this.#settlePending(error);
    // 後片付けの失敗は close() から返し、成功を示すプロトコルイベントには変換しない。
    void this.close().catch(() => {});
  }

  /** 保留 RPC とイベント取得を拒否し、サーバー要求への応答権も失効させる。 */
  #settlePending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters = [];
    this.#serverRequests.clear();
  }

  // 待機時間に上限のある close() と異なり、管理下のプロセスの後片付けを確認してから完了する。
  /** 時間制限付きの停止試行とは別に、管理範囲の解放と子の実際の終了が確認できるまで待つ。 */
  whenClosed(): Promise<void> {
    return this.#closedPromise;
  }

  /** 新しい要求を止めて管理下のプロセスを片付ける。進行中の試行を共有し、所有が残る場合に限り失敗後の再試行を許す。 */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closing";
    this.#settlePending(
      this.#terminalError ?? new Error("Codex transport closed."),
    );
    const attempt = this.#close();
    this.#closePromise = attempt;
    void attempt.catch(() => {
      // 保持している所有ハンドルでのみ安全に再試行できる。管理を終えた PID を使って停止しない。
      if (this.#owner && this.#closePromise === attempt)
        this.#closePromise = undefined;
    });
    return this.#closePromise;
  }

  /** 管理範囲の停止・解放と入出力破棄をそれぞれ試し、終了待ちの失敗もまとめて報告する。 */
  async #close(): Promise<void> {
    const child = this.#child;
    const failures: Error[] = [];
    try {
      this.#owner?.terminate();
    } catch (error) {
      failures.push(asError(error));
    }
    try {
      this.#owner?.release();
      this.#owner = undefined;
    } catch (error) {
      failures.push(asError(error));
    }
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
      try {
        stream?.destroy();
      } catch (error) {
        failures.push(asError(error));
      }
    }
    if (!failures.length) {
      // 時間制限付きの close() がタイムアウトしても、後から届く子プロセスの close イベントで後片付けを確認できる。
      void (this.#exitPromise ?? Promise.resolve()).then(() =>
        this.#resolveClosed(),
      );
    }
    try {
      if (this.#exitPromise)
        await withTimeout(
          this.#exitPromise,
          this.#options.closeTimeoutMs ?? 5_000,
        );
    } catch (error) {
      failures.push(asError(error));
    }
    if (failures.length) {
      this.#state = "failed";
      const failure = new AggregateError(
        failures,
        "Codex process cleanup failed.",
      );
      this.#terminalError ??= failure;
      throw failure;
    }
    this.#state = "closed";
  }
}

/** プロトコルの名前付きフィールドを読める、配列と null 以外のオブジェクトかを確認する。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 文字列または安全な整数だけを RPC の ID として受け付ける。 */
function isId(value: unknown): value is string | number {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
/** 投げられた Error を維持し、それ以外の値をエラーとして伝えられる形にする。 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
/** 要求の中断を他のトランスポートエラーと区別できる例外を作る。 */
function abortError(): Error {
  const error = new Error("Codex request aborted.");
  error.name = "AbortError";
  return error;
}
/** 元の処理を停止せず、待機だけをタイムアウトまたは中断で終え、登録した監視を解除する。 */
async function withTimeout(
  operation: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codex process cleanup timed out.")),
          timeoutMs,
        );
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
