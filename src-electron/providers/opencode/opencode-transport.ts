import { randomBytes } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import {
  OPENCODE_VERSION,
  resolveOpenCodeEnvironment,
  type OpenCodeEnvironment,
} from "./opencode-environment.js";
import {
  spawnOwnedProviderProcess,
  OwnedProviderProcessAcquisitionError,
  type OwnedProviderProcessCleanupOwner,
} from "../owned-process.js";

export { OPENCODE_VERSION } from "./opencode-environment.js";
/** 標準入出力で起動通知を受け取り、IPv4 ループバックの空きポートで待ち受けるための引数。 */
export const OPENCODE_SERVE_ARGUMENTS = [
  "serve",
  "--stdio",
  "--hostname",
  "127.0.0.1",
  "--port",
  "0",
] as const;
/** 実行環境とデータベースの場所、および起動と後片付けに別々に適用する待機上限。 */
export type OpenCodeTransportOptions = {
  executable?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
};

// これらのランタイムは Main が管理する。直列化するのはネイティブデータベースの初期化であり、Turn や HTTP リクエストではない。
const databases = new Map<
  string,
  { tail: Promise<void>; version: string; active: number }
>();

/** 管理下の OpenCode プロセスを起動し、認証付きのローカル接続と実際のプロセス終了を管理する。 */
export class OpenCodeTransport {
  #owner?: OwnedProviderProcessCleanupOwner;
  #exit?: Promise<void>;
  #start?: Promise<OpenCodeClient>;
  #close?: Promise<void>;
  #closing = false;
  #resolveClosed!: () => void;
  #closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  #releaseDatabase?: () => void;
  #options: OpenCodeTransportOptions;
  #spawn: typeof spawnOwnedProviderProcess;
  #resolveEnvironment: typeof resolveOpenCodeEnvironment;
  #password?: string;

  /** 絶対パスと有効なタイマー範囲を確認し、環境のスナップショットと起動依存を保持する。 */
  constructor(
    options: OpenCodeTransportOptions,
    dependencies: {
      spawnOwnedProcess?: typeof spawnOwnedProviderProcess;
      resolveEnvironment?: typeof resolveOpenCodeEnvironment;
    } = {},
  ) {
    if (
      (options.executable !== undefined &&
        !path.isAbsolute(options.executable)) ||
      (options.databasePath !== undefined &&
        !path.isAbsolute(options.databasePath)) ||
      !path.isAbsolute(options.cwd)
    ) {
      throw new TypeError(
        "OpenCode executable, database and workspace paths must be absolute.",
      );
    }
    for (const duration of [options.startupTimeoutMs, options.closeTimeoutMs]) {
      if (
        duration !== undefined &&
        (!Number.isSafeInteger(duration) ||
          duration < 1 ||
          duration > 2_147_483_647)
      ) {
        throw new RangeError(
          "OpenCode timeouts must be positive Node timer durations.",
        );
      }
    }
    this.#options = { ...options, env: { ...(options.env ?? process.env) } };
    this.#spawn = dependencies.spawnOwnedProcess ?? spawnOwnedProviderProcess;
    this.#resolveEnvironment =
      dependencies.resolveEnvironment ?? resolveOpenCodeEnvironment;
  }

  /** 初回の起動処理を保持して重複する呼び出しで共有する。未起動のまま閉じた場合は起動を拒否する。 */
  start(signal?: AbortSignal): Promise<OpenCodeClient> {
    if (this.#start) return this.#start;
    if (this.#closing)
      return Promise.reject(new Error("OpenCode transport is closed."));
    this.#start = this.#launch(signal);
    return this.#start;
  }

  /** ログなどから除去するため、発行済みパスワードとその Basic 認証用表現を返す。 */
  get secrets(): readonly string[] {
    return this.#password
      ? [
          this.#password,
          Buffer.from(`opencode:${this.#password}`).toString("base64"),
        ]
      : [];
  }

  /** 同じデータベースの初期化を順番に行い、管理プロセスの起動と通知を確認してから認証付きのクライアントを返す。 */
  async #launch(signal?: AbortSignal): Promise<OpenCodeClient> {
    let environment: OpenCodeEnvironment;
    try {
      const env = { ...this.#options.env };
      if (this.#options.databasePath !== undefined)
        env.OPENCODE_DB = this.#options.databasePath;
      environment = await this.#resolveEnvironment({
        cwd: this.#options.cwd,
        executable: this.#options.executable,
        env,
        signal,
      });
      if (this.#closing || signal?.aborted) throw abortError();
    } catch (error) {
      await this.close();
      throw error;
    }
    const key = path.resolve(environment.databasePath);
    const database = databases.get(key) ?? {
      tail: Promise.resolve(),
      version: OPENCODE_VERSION,
      active: 0,
    };
    if (database.active && database.version !== OPENCODE_VERSION)
      throw new Error(
        "OpenCode database is open with a different CLI version.",
      );
    databases.set(key, database);
    const previous = database.tail;
    let unlock!: () => void;
    database.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    try {
      await bounded(previous, this.#options.startupTimeoutMs ?? 10_000, signal);
      if (this.#closing || signal?.aborted) throw abortError();
      database.version = OPENCODE_VERSION;
      const password = randomBytes(32).toString("base64url");
      this.#password = password;
      const env: NodeJS.ProcessEnv = {
        ...environment.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_SERVER_PASSWORD: password,
      };
      if (this.#closing || signal?.aborted) throw abortError();
      const owner = this.#spawn({
        executable: environment.executable,
        arguments: OPENCODE_SERVE_ARGUMENTS,
        cwd: this.#options.cwd,
        env,
      });
      this.#retainOwner(owner);
      database.active++;
      this.#releaseDatabase = () => {
        database.active--;
      };
      const child = owner.child;
      child.stderr.resume();
      const announcement = new Promise<string>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout });
        lines.once("line", (line) => {
          lines.close();
          child.stdout.resume();
          try {
            resolve(parseOpenCodeServerUrl(JSON.parse(line)));
          } catch {
            reject(new Error("OpenCode startup announcement is invalid."));
          }
        });
        child.once("error", () =>
          reject(new Error("OpenCode process failed to start.")),
        );
        child.once("exit", () =>
          reject(
            new Error("OpenCode process exited before startup completed."),
          ),
        );
      });
      const client = await bounded(
        (async () => {
          const [, baseUrl] = await Promise.all([owner.ready, announcement]);
          const client = OpenCode.make({
            baseUrl,
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
            },
          });
          const info = await client.server.info({ signal });
          if (info.version !== OPENCODE_VERSION)
            throw new Error(
              "OpenCode CLI version does not match the bundled client.",
            );
          return client;
        })(),
        this.#options.startupTimeoutMs ?? 10_000,
        signal,
      );
      if (this.#closing || signal?.aborted) throw abortError();
      return client;
    } catch (error) {
      if (error instanceof OwnedProviderProcessAcquisitionError)
        this.#retainOwner(error.owner);
      await this.close();
      throw error;
    } finally {
      // 待機がキャンセルされても、次の開始処理が現在の初期化を追い越さないようにする。
      void previous.then(() =>
        this.#closing ? this.#closed.then(unlock) : unlock(),
      );
    }
  }

  /** 取得した所有者を保持し、存在する子は close が届くまで終了扱いにしない。 */
  #retainOwner(owner: OwnedProviderProcessCleanupOwner): void {
    this.#owner = owner;
    const child = owner.child;
    child?.on("error", () => {});
    child?.stdin.on("error", () => {});
    child?.stdout.on("error", () => {});
    child?.stderr.on("error", () => {});
    this.#exit = child
      ? new Promise<void>((resolve) => {
          child.once("close", resolve);
        })
      : Promise.resolve();
    child?.once("close", () => {
      void this.close().catch(() => {});
    });
  }

  // この Promise は時間制限付きの close 試行とは異なり、所有権の解放と実際の終了を確認する。
  /** 管理範囲を解放し、子が実際に終了したことまで確認できたときに解決する。 */
  whenClosed(): Promise<void> {
    return this.#closed;
  }

  /** 後片付けを開始し、進行中の試行は共有する。失敗後に所有者が残っていれば再試行を許す。 */
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    const attempt = this.#cleanup();
    this.#close = attempt;
    void attempt.catch(() => {
      if (this.#owner && this.#close === attempt) this.#close = undefined;
    });
    return attempt;
  }

  /** 入出力を終了させてから管理スコープを停止・解放する。停止確認が取れるまでデータベースの使用記録を残す。 */
  async #cleanup(): Promise<void> {
    const owner = this.#owner;
    const errors: unknown[] = [];
    const timeout = this.#options.closeTimeoutMs ?? 5_000;
    if (owner?.child) {
      owner.child.stdin.end();
      // stdio モードには時間を限って通常終了する機会を与え、その後に管理下のスコープ全体を停止する。
      await Promise.race([
        this.#exit,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(250, timeout));
          timer.unref();
        }),
      ]);
    }
    try {
      owner?.terminate();
    } catch (error) {
      errors.push(error);
    }
    try {
      owner?.release();
      this.#owner = undefined;
    } catch (error) {
      errors.push(error);
    }
    for (const stream of [
      owner?.child?.stdin,
      owner?.child?.stdout,
      owner?.child?.stderr,
    ])
      stream?.destroy();
    if (!errors.length) {
      void (this.#exit ?? Promise.resolve()).then(() => {
        this.#releaseDatabase?.();
        this.#releaseDatabase = undefined;
        this.#resolveClosed();
      });
    }
    try {
      await bounded(this.#exit ?? Promise.resolve(), timeout);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "OpenCode process cleanup failed.");
  }
}

/** 起動通知を検証し、認証情報や追加パス等を含まない IPv4 ループバックの HTTP オリジンだけを返す。 */
export function parseOpenCodeServerUrl(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    throw new Error("Invalid startup JSON.");
  const url = new URL(value.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OpenCode must listen on the requested loopback interface.",
    );
  }
  return url.origin;
}

/** 起動が通常の失敗ではなく中断で終わったことを識別できる例外を作る。 */
function abortError(): Error {
  const error = new Error("OpenCode startup aborted.");
  error.name = "AbortError";
  return error;
}
/** 操作の待機を時間制限または中断で打ち切り、確定後に監視を解除する。元の操作はこの関数では停止しない。 */
async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenCode process operation timed out.")),
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
