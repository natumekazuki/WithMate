import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import {
  spawnOwnedProviderProcess,
  OwnedProviderProcessAcquisitionError,
  type OwnedProviderProcessCleanupOwner,
} from "../owned-process.js";

export const OPENCODE_VERSION = "2.1.4";
export const OPENCODE_SERVE_ARGUMENTS = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"] as const;
export type OpenCodeTransportOptions = {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  databasePath: string;
  background?: boolean;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
};

// Main owns these runtimes. Serialize native database bootstrap, not turns or HTTP requests.
const databases = new Map<string, { tail: Promise<void>; version: string; active: number }>();

export class OpenCodeTransport {
  #owner?: OwnedProviderProcessCleanupOwner;
  #exit?: Promise<void>;
  #start?: Promise<OpenCodeClient>;
  #close?: Promise<void>;
  #closing = false;
  #resolveClosed!: () => void;
  #closed = new Promise<void>(resolve => { this.#resolveClosed = resolve; });
  #releaseDatabase?: () => void;
  #options: OpenCodeTransportOptions;
  #spawn: typeof spawnOwnedProviderProcess;
  #password?: string;

  constructor(options: OpenCodeTransportOptions, dependencies: { spawnOwnedProcess?: typeof spawnOwnedProviderProcess } = {}) {
    if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.databasePath) || !path.isAbsolute(options.cwd)) {
      throw new TypeError("OpenCode executable, database and workspace paths must be absolute.");
    }
    for (const duration of [options.startupTimeoutMs, options.closeTimeoutMs]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > 2_147_483_647)) {
        throw new RangeError("OpenCode timeouts must be positive Node timer durations.");
      }
    }
    this.#options = { ...options, env: { ...(options.env ?? process.env) } };
    this.#spawn = dependencies.spawnOwnedProcess ?? spawnOwnedProviderProcess;
  }

  start(signal?: AbortSignal): Promise<OpenCodeClient> {
    if (this.#start) return this.#start;
    if (this.#closing) return Promise.reject(new Error("OpenCode transport is closed."));
    this.#start = this.#launch(signal);
    return this.#start;
  }

  get secrets(): readonly string[] {
    return this.#password ? [this.#password, Buffer.from(`opencode:${this.#password}`).toString("base64")] : [];
  }

  async #launch(signal?: AbortSignal): Promise<OpenCodeClient> {
    const key = path.resolve(this.#options.databasePath);
    const database = databases.get(key) ?? { tail: Promise.resolve(), version: OPENCODE_VERSION, active: 0 };
    if (database.active && database.version !== OPENCODE_VERSION) throw new Error("OpenCode database is open with a different CLI version.");
    databases.set(key, database);
    const previous = database.tail;
    let unlock!: () => void;
    database.tail = new Promise<void>(resolve => { unlock = resolve; });
    try {
      await bounded(previous, this.#options.startupTimeoutMs ?? 10_000, signal);
      if (this.#closing || signal?.aborted) throw abortError();
      database.version = OPENCODE_VERSION;
      await mkdir(path.dirname(key), { recursive: true });
      const password = randomBytes(32).toString("base64url");
      this.#password = password;
      const env: NodeJS.ProcessEnv = { ...this.#options.env, OPENCODE_DB: key, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password };
      if (this.#options.background) {
        delete env.OPENCODE_CONFIG;
        delete env.OPENCODE_CONFIG_CONTENT;
        env.OPENCODE_CONFIG_DIR = path.join(path.dirname(key), "background-config");
        env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";
        env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
        await mkdir(env.OPENCODE_CONFIG_DIR!, { recursive: true });
      }
      if (this.#closing || signal?.aborted) throw abortError();
      const owner = this.#spawn({ executable: this.#options.executable, arguments: OPENCODE_SERVE_ARGUMENTS, cwd: this.#options.cwd, env });
      this.#retainOwner(owner);
      database.active++;
      this.#releaseDatabase = () => { database.active--; };
      const child = owner.child;
      child.stderr.resume();
      const announcement = new Promise<string>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout });
        lines.once("line", line => {
          lines.close();
          child.stdout.resume();
          try { resolve(parseOpenCodeServerUrl(JSON.parse(line))); }
          catch { reject(new Error("OpenCode startup announcement is invalid.")); }
        });
        child.once("error", () => reject(new Error("OpenCode process failed to start.")));
        child.once("exit", () => reject(new Error("OpenCode process exited before startup completed.")));
      });
      const client = await bounded((async () => {
        const [, baseUrl] = await Promise.all([owner.ready, announcement]);
        const client = OpenCode.make({ baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
        const info = await client.server.info({ signal });
        if (info.version !== OPENCODE_VERSION) throw new Error("OpenCode CLI version does not match the bundled client.");
        return client;
      })(), this.#options.startupTimeoutMs ?? 10_000, signal);
      if (this.#closing || signal?.aborted) throw abortError();
      return client;
    } catch (error) {
      if (error instanceof OwnedProviderProcessAcquisitionError) this.#retainOwner(error.owner);
      await this.close();
      throw error;
    } finally {
      // A cancelled waiter must not allow the next opener to overtake the current bootstrap.
      void previous.then(() => this.#closing ? this.#closed.then(unlock) : unlock());
    }
  }

  #retainOwner(owner: OwnedProviderProcessCleanupOwner): void {
    this.#owner = owner;
    const child = owner.child;
    child?.on("error", () => {});
    child?.stdin.on("error", () => {});
    child?.stdout.on("error", () => {});
    child?.stderr.on("error", () => {});
    this.#exit = child ? new Promise<void>(resolve => { child.once("close", resolve); }) : Promise.resolve();
    child?.once("close", () => { void this.close().catch(() => {}); });
  }

  // This promise is not the bounded close attempt: it confirms ownership release and actual exit.
  whenClosed(): Promise<void> { return this.#closed; }

  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    const attempt = this.#cleanup();
    this.#close = attempt;
    void attempt.catch(() => { if (this.#owner && this.#close === attempt) this.#close = undefined; });
    return attempt;
  }

  async #cleanup(): Promise<void> {
    const owner = this.#owner;
    const errors: unknown[] = [];
    const timeout = this.#options.closeTimeoutMs ?? 5_000;
    if (owner?.child) {
      owner.child.stdin.end();
      // Give stdio mode a bounded opportunity to shut down normally, then terminate the entire owned scope.
      await Promise.race([this.#exit, new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(250, timeout)); timer.unref(); })]);
    }
    try { owner?.terminate(); } catch (error) { errors.push(error); }
    try { owner?.release(); this.#owner = undefined; } catch (error) { errors.push(error); }
    for (const stream of [owner?.child?.stdin, owner?.child?.stdout, owner?.child?.stderr]) stream?.destroy();
    if (!errors.length) {
      void (this.#exit ?? Promise.resolve()).then(() => {
        this.#releaseDatabase?.();
        this.#releaseDatabase = undefined;
        this.#resolveClosed();
      });
    }
    try { await bounded(this.#exit ?? Promise.resolve(), timeout); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "OpenCode process cleanup failed.");
  }
}

export function parseOpenCodeServerUrl(value: unknown): string {
  if (!value || typeof value !== "object" || !("url" in value) || typeof value.url !== "string") throw new Error("Invalid startup JSON.");
  const url = new URL(value.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OpenCode must listen on the requested loopback interface.");
  }
  return url.origin;
}

function abortError(): Error { const error = new Error("OpenCode startup aborted."); error.name = "AbortError"; return error; }
async function bounded<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("OpenCode process operation timed out.")), timeoutMs);
      onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}
