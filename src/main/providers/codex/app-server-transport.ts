import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CodexDiagnosticCollector, type CodexDiagnosticSnapshot } from "./diagnostics.js";
import { CodexJsonlDecoder } from "./jsonl-decoder.js";
import { spawnOwnedCodexProcess, type OwnedCodexProcess } from "./owned-process.js";
import { observeEmitterErrors, replaceWithLateErrorGuard } from "./process-error-boundary.js";
import {
  CodexProtocolSession,
  snapshotCodexClientInfo,
  type CodexClientInfo,
  type CodexConnectionInfo,
  type CodexProtocolEvent,
  type CodexRequestOptions,
} from "./protocol-session.js";
import { CodexStdioWireWriter, encodeCodexWireMessage } from "./stdio-wire-writer.js";
import { MAX_NODE_TIMER_DELAY_MS, isValidNodeTimerDelay } from "./timer-duration.js";
import {
  CodexTransportError,
  CodexWireWriteError,
  connectionFailure,
  requestNotSent,
  responseUnknown,
  type CodexConnectionFailureCode,
} from "./transport-error.js";
import { CODEX_TRANSPORT_LIMITS, validateCodexTransportLimits, type CodexTransportLimits } from "./transport-limits.js";

export const CODEX_APP_SERVER_ARGUMENTS = Object.freeze(["app-server", "--stdio"] as const);

export type CodexAppServerTransportState = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

export type CodexAppServerTransportOptions = Readonly<{
  executable: string;
  arguments?: readonly string[];
  clientInfo: CodexClientInfo;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  limits?: CodexTransportLimits;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}>;

type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

export class CodexAppServerTransport {
  readonly options: CodexAppServerTransportOptions;
  readonly #limits: CodexTransportLimits;
  readonly #startupTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #diagnostics: CodexDiagnosticCollector;
  #state: CodexAppServerTransportState = "idle";
  #ownedProcess: OwnedCodexProcess | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #writer: CodexStdioWireWriter | undefined;
  #decoder: CodexJsonlDecoder | undefined;
  #session: CodexProtocolSession | undefined;
  #startPromise: Promise<CodexConnectionInfo> | undefined;
  #closePromise: Promise<void> | undefined;
  #exitPromise: Promise<ProcessExit> | undefined;
  #expectedExit = false;
  #spawnObserved = false;
  #terminationPromise: Promise<CodexTransportError | undefined> | undefined;
  #terminalError: CodexTransportError | undefined;

  constructor(options: CodexAppServerTransportOptions) {
    const executable = options.executable;
    const configuredArguments = options.arguments;
    const configuredClientInfo = options.clientInfo;
    const configuredCwd = options.cwd;
    const configuredEnv = options.env;
    const configuredLimits = options.limits;
    const configuredStartupTimeoutMs = options.startupTimeoutMs;
    const configuredCloseTimeoutMs = options.closeTimeoutMs;
    const arguments_ = snapshotExecutableArguments(
      configuredArguments === undefined ? CODEX_APP_SERVER_ARGUMENTS : configuredArguments,
    );
    assertExecutable(executable);
    const clientInfo = snapshotCodexClientInfo(configuredClientInfo);
    this.#limits = validateCodexTransportLimits(configuredLimits ?? CODEX_TRANSPORT_LIMITS);
    assertInitializationFrameFits(clientInfo, this.#limits);
    this.#startupTimeoutMs = validateDuration(configuredStartupTimeoutMs ?? 10_000, "startupTimeoutMs");
    this.#closeTimeoutMs = validateDuration(configuredCloseTimeoutMs ?? 5_000, "closeTimeoutMs");
    this.#diagnostics = new CodexDiagnosticCollector(this.#limits.maxStderrBytes);
    this.options = Object.freeze({
      executable,
      arguments: arguments_,
      clientInfo,
      ...(configuredCwd === undefined ? {} : { cwd: configuredCwd }),
      ...(configuredEnv === undefined ? {} : { env: Object.freeze({ ...configuredEnv }) }),
      ...(configuredLimits === undefined ? {} : { limits: this.#limits }),
      ...(configuredStartupTimeoutMs === undefined ? {} : { startupTimeoutMs: this.#startupTimeoutMs }),
      ...(configuredCloseTimeoutMs === undefined ? {} : { closeTimeoutMs: this.#closeTimeoutMs }),
    });
  }

  get state(): CodexAppServerTransportState {
    return this.#state;
  }

  get connectionInfo(): CodexConnectionInfo | undefined {
    return this.#session?.connectionInfo;
  }

  get pendingRequestCount(): number {
    return this.#session?.pendingRequestCount ?? 0;
  }

  get queuedWriteBytes(): number {
    return this.#writer?.queuedBytes ?? 0;
  }

  diagnostics(): CodexDiagnosticSnapshot {
    return this.#diagnostics.snapshot();
  }

  start(signal?: AbortSignal): Promise<CodexConnectionInfo> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#state !== "idle") return Promise.reject(requestNotSent("not_ready"));
    if (signal?.aborted) {
      this.#state = "failed";
      return Promise.reject(requestNotSent("aborted"));
    }
    this.#state = "starting";
    this.#startPromise = this.#start(signal);
    return this.#startPromise;
  }

  request<TResult>(method: string, params?: unknown, options?: CodexRequestOptions): Promise<TResult> {
    if (this.#state !== "ready" || this.#session === undefined) {
      return Promise.reject(requestNotSent(this.#state === "closing" ? "closing" : "not_ready"));
    }
    return this.#session.request<TResult>(method, params, options);
  }

  nextEvent(): Promise<CodexProtocolEvent> {
    if (this.#session === undefined) return Promise.reject(requestNotSent("not_ready"));
    return this.#session.nextEvent();
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #start(signal: AbortSignal | undefined): Promise<CodexConnectionInfo> {
    const startupDeadline = Date.now() + this.#startupTimeoutMs;
    let spawnReady: Promise<void>;
    try {
      const ownedProcess = spawnOwnedCodexProcess({
        executable: this.options.executable,
        arguments: this.options.arguments ?? CODEX_APP_SERVER_ARGUMENTS,
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(this.options.env === undefined ? {} : { env: this.options.env }),
      });
      const child = ownedProcess.child;
      this.#ownedProcess = ownedProcess;
      this.#child = child;
      this.#exitPromise = new Promise<ProcessExit>((resolve) => {
        child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      spawnReady = ownedProcess.ready.then(
        () => {
          this.#spawnObserved = true;
        },
        () => {
          throw connectionFailure("spawn_failed");
        },
      );
      this.#attachProcess(child);
    } catch {
      this.#state = "failed";
      this.#terminalError = connectionFailure("spawn_failed");
      if (this.#child !== undefined) {
        const terminationFailure = await this.#ensureTermination();
        if (terminationFailure !== undefined) throw terminationFailure;
      }
      throw this.#terminalError;
    }

    try {
      await raceWithDeadline(spawnReady, remainingDuration(startupDeadline), signal, connectionFailure("spawn_failed"));
      if (this.#state === "closing") throw responseUnknown("connection_lost");
      if (this.#state === "failed") throw connectionFailure("process_exited");
      const connectionInfo = await this.#session!.start({
        timeoutMs: remainingDuration(startupDeadline),
        ...(signal === undefined ? {} : { signal }),
      });
      if (this.#state !== "starting") throw responseUnknown("connection_lost");
      this.#state = "ready";
      return connectionInfo;
    } catch (error) {
      if (this.#state !== "closing" && this.#state !== "closed") this.#state = "failed";
      await this.#ensureTermination();
      throw this.#terminalError ?? normalizeStartError(error);
    }
  }

  #attachProcess(child: ChildProcessWithoutNullStreams): void {
    const decoder = new CodexJsonlDecoder(this.#limits.maxLineBytes);
    let stdoutFinalized = false;
    let finalizeStdout: (() => void) | undefined;
    const stdoutDrain = new Promise<void>((resolve) => {
      finalizeStdout = () => {
        if (stdoutFinalized) return;
        stdoutFinalized = true;
        resolve();
      };
    });
    const writer = new CodexStdioWireWriter(
      child.stdin,
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          void this.#classifyUnexpectedExit(stdoutDrain);
          return;
        }
        this.#handleFailure("stdin_failed");
      },
      this.#limits,
    );
    const session = new CodexProtocolSession({
      clientInfo: this.options.clientInfo,
      writer,
      limits: this.#limits,
      defaultRequestTimeoutMs: this.#startupTimeoutMs,
    });
    this.#decoder = decoder;
    this.#writer = writer;
    this.#session = session;

    child.stdout.on("data", (chunk: Buffer) => {
      if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
      try {
        decoder.push(chunk, (envelope) => session.accept(envelope));
        if (session.state === "failed") this.#handleFailure("protocol_failed");
      } catch {
        this.#handleFailure("protocol_failed");
      }
    });
    child.stdout.on("error", () => {
      finalizeStdout?.();
      this.#handleFailure("stdout_failed");
    });
    child.stdout.on("end", () => {
      if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") {
        finalizeStdout?.();
        return;
      }
      try {
        decoder.finish();
      } catch {
        finalizeStdout?.();
        this.#handleFailure("protocol_failed");
        return;
      }
      finalizeStdout?.();
      void this.#classifyClosedStdout();
    });
    child.stdout.on("close", () => {
      if (stdoutFinalized) return;
      finalizeStdout?.();
      this.#handleFailure("stdout_failed");
    });
    child.stderr.on("data", (chunk: Buffer) => this.#diagnostics.observeStderr(chunk));
    observeEmitterErrors(child.stderr, () => this.#handleFailure("stderr_failed"));
    child.on("error", () => this.#handleFailure(this.#spawnObserved ? "process_exited" : "spawn_failed"));
    child.on("exit", () => {
      if (!this.#expectedExit && this.#state !== "closing" && this.#state !== "closed" && this.#state !== "failed") {
        void this.#classifyUnexpectedExit(stdoutDrain);
      }
    });
  }

  async #classifyClosedStdout(): Promise<void> {
    const exitPromise = this.#exitPromise;
    const exited = exitPromise !== undefined && (await settlesWithin(exitPromise, this.#closeTimeoutMs));
    if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
    this.#handleFailure(exited ? "process_exited" : "stdout_failed");
  }

  async #classifyUnexpectedExit(stdoutDrain: Promise<void>): Promise<void> {
    await settlesWithin(stdoutDrain, this.#closeTimeoutMs);
    if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
    this.#handleFailure("process_exited");
  }

  #handleFailure(code: CodexConnectionFailureCode): void {
    if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
    this.#state = "failed";
    this.#terminalError = connectionFailure(code);
    this.#session?.fail(code);
    void this.#ensureTermination();
  }

  #ensureTermination(): Promise<CodexTransportError | undefined> {
    this.#terminationPromise ??= (async () => {
      try {
        await this.#terminateOwnedChild();
        this.#releaseOwnedProcess();
        return undefined;
      } catch {
        try {
          this.#releaseOwnedProcess();
        } catch {
          // The public failure remains bounded even when native handle release also fails.
        }
        const failure = connectionFailure("close_failed");
        this.#terminalError = failure;
        return failure;
      }
    })();
    return this.#terminationPromise;
  }

  #releaseOwnedProcess(): void {
    const child = this.#child;
    if (child === undefined) return;
    const ownedProcess = this.#ownedProcess;
    this.#ownedProcess = undefined;
    this.#child = undefined;
    this.#writer = undefined;
    this.#decoder = undefined;
    this.#exitPromise = undefined;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    replaceWithLateErrorGuard(child.stdin);
    replaceWithLateErrorGuard(child.stdout);
    replaceWithLateErrorGuard(child.stderr);
    replaceWithLateErrorGuard(child);
    try {
      ownedProcess?.release();
    } finally {
      this.#session?.releaseTransportResources();
    }
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "idle") {
      this.#state = "closed";
      return;
    }
    if (this.#state === "failed") {
      const terminationFailure = await this.#ensureTermination();
      if (terminationFailure !== undefined) throw terminationFailure;
      return;
    }

    this.#state = "closing";
    this.#expectedExit = true;
    this.#session?.prepareClose();
    this.#writer?.shutdown();
    await Promise.resolve();
    this.#session?.beginClose();
    try {
      const terminationFailure = await this.#ensureTermination();
      if (terminationFailure !== undefined) throw terminationFailure;
      this.#session?.completeClose();
      this.#state = "closed";
    } catch {
      this.#session?.fail("close_failed");
      this.#state = "failed";
      throw connectionFailure("close_failed");
    }
  }

  async #terminateOwnedChild(): Promise<void> {
    const ownedProcess = this.#ownedProcess;
    const child = this.#child;
    const exitPromise = this.#exitPromise;
    if (ownedProcess === undefined || child === undefined || exitPromise === undefined) return;
    this.#expectedExit = true;
    this.#writer?.shutdown();
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#terminateOwnedProcess(ownedProcess);
      return;
    }
    if (await settlesWithin(exitPromise, this.#closeTimeoutMs)) {
      this.#terminateOwnedProcess(ownedProcess);
      return;
    }
    this.#terminateOwnedProcess(ownedProcess);
    if (!(await settlesWithin(exitPromise, this.#closeTimeoutMs))) throw connectionFailure("close_failed");
  }

  #terminateOwnedProcess(ownedProcess: OwnedCodexProcess): void {
    try {
      ownedProcess.terminate();
    } catch {
      throw connectionFailure("close_failed");
    }
  }
}

function assertExecutable(executable: string): void {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new TypeError("Codex executable is required.");
  }
}

function snapshotExecutableArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("Codex executable arguments must be a dense array of strings.");
  const snapshot: string[] = [];
  const length = value.length;
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("Codex executable arguments must be a dense array of strings.");
    }
    const argument: unknown = value[index];
    if (typeof argument !== "string") {
      throw new TypeError("Codex executable arguments must be a dense array of strings.");
    }
    snapshot.push(argument);
  }
  return Object.freeze(snapshot);
}

function assertInitializationFrameFits(clientInfo: CodexClientInfo, limits: CodexTransportLimits): void {
  const frame = encodeCodexWireMessage(
    {
      id: 1,
      method: "initialize",
      params: { clientInfo, capabilities: null },
    },
    limits.maxLineBytes,
  );
  if (frame instanceof CodexWireWriteError || frame.byteLength > limits.maxQueuedWriteBytes) {
    throw new RangeError("Codex transport limits cannot carry the initialization frame.");
  }
}

function validateDuration(value: number, name: string): number {
  if (!isValidNodeTimerDelay(value)) {
    throw new RangeError(`${name} must be between 1 and ${MAX_NODE_TIMER_DELAY_MS}.`);
  }
  return value;
}

function remainingDuration(deadline: number): number {
  return Math.min(MAX_NODE_TIMER_DELAY_MS, Math.max(1, deadline - Date.now()));
}

function normalizeStartError(error: unknown): CodexTransportError {
  return error instanceof CodexTransportError ? error : connectionFailure("spawn_failed");
}

async function raceWithDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutError: CodexTransportError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
    timer.unref?.();
    if (signal !== undefined) {
      onAbort = () => reject(requestNotSent("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
