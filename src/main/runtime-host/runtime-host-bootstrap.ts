import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { RuntimeApplication, RuntimeApplicationControl } from "../runtime-application.js";
import { createRuntimeApplicationClient } from "./runtime-application-client.js";
import { RuntimeIpcClient, RuntimeIpcClientError } from "./runtime-ipc-client.js";
import { RuntimeEndpointUnavailableError } from "./runtime-endpoint.js";
import {
  resolveRuntimeOwnerIdentity,
  type ResolveRuntimeOwnerIdentityOptions,
  type RuntimeOwnerIdentity,
} from "./runtime-owner-identity.js";

export type RuntimeHostBootstrapDependencies = Readonly<{
  resolveIdentity(options?: ResolveRuntimeOwnerIdentityOptions): Promise<RuntimeOwnerIdentity>;
  connectClient(
    identity: RuntimeOwnerIdentity,
    options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
  ): Promise<RuntimeIpcClient>;
  spawnHost(identity: RuntimeOwnerIdentity): Promise<unknown>;
}>;

export type DetachedRuntimeHostProcess = Readonly<{
  pid: number;
  exited: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  isRunning(): boolean;
  terminate(signal?: NodeJS.Signals): boolean;
}>;

export type StartRuntimeHostClientOptions = ResolveRuntimeOwnerIdentityOptions &
  RuntimeApplicationControl &
  Readonly<{ dependencies?: RuntimeHostBootstrapDependencies }>;

const defaultDependencies: RuntimeHostBootstrapDependencies = {
  resolveIdentity: resolveRuntimeOwnerIdentity,
  connectClient: RuntimeIpcClient.connect,
  spawnHost: spawnDetachedRuntimeHost,
};

export async function startRuntimeHostClient(options: StartRuntimeHostClientOptions = {}): Promise<RuntimeApplication> {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 10_000);
  const deadlineAt = Date.now() + timeoutMs;
  const dependencies = options.dependencies ?? defaultDependencies;
  if (options.signal?.aborted) throw canceled();
  const identity = await runControlled(
    dependencies.resolveIdentity(
      options.applicationDataRoot === undefined ? {} : { applicationDataRoot: options.applicationDataRoot },
    ),
    deadlineAt,
    options.signal,
  );

  try {
    return createRuntimeApplicationClient(
      await dependencies.connectClient(identity, connectionControl(deadlineAt, options.signal)),
    );
  } catch (error) {
    if (!isAbsentEndpoint(error)) throw error;
  }

  await runControlled(dependencies.spawnHost(identity), deadlineAt, options.signal);
  while (true) {
    const remaining = remainingTimeout(deadlineAt);
    try {
      const client = await dependencies.connectClient(identity, {
        timeoutMs: Math.min(remaining, 250),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return createRuntimeApplicationClient(client);
    } catch (error) {
      if (!isRetryableStartupAbsence(error) || Date.now() >= deadlineAt) throw error;
      await waitForRetry(Math.min(10, remaining), options.signal);
    }
  }
}

export async function spawnDetachedRuntimeHost(identity: RuntimeOwnerIdentity): Promise<DetachedRuntimeHostProcess> {
  const entryPath = fileURLToPath(new URL("./runtime-host-entry.js", import.meta.url));
  const applicationDataRoot = path.dirname(identity.applicationDirectory);
  const child = spawn(process.execPath, [entryPath, "--application-data-root", applicationDataRoot], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.removeListener("error", onError);
      if (child.pid === undefined) {
        reject(new Error("Runtime host process did not expose its process identity."));
        return;
      }
      child.unref();
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Runtime host process did not expose its process identity.");
  return {
    pid,
    exited,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    terminate: (signal = "SIGTERM") => child.kill(signal),
  };
}

async function runControlled<TValue>(
  operation: Promise<TValue>,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<TValue> {
  if (signal?.aborted) throw canceled();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RuntimeIpcClientError("request_timeout", "not_started", true)),
      remainingTimeout(deadlineAt),
    );
    if (signal !== undefined) {
      onAbort = () => reject(canceled());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function waitForRetry(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw canceled();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(canceled());
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function connectionControl(
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Readonly<{ timeoutMs: number; signal?: AbortSignal }> {
  return {
    timeoutMs: remainingTimeout(deadlineAt),
    ...(signal === undefined ? {} : { signal }),
  };
}

function isAbsentEndpoint(error: unknown): boolean {
  return error instanceof RuntimeEndpointUnavailableError && error.reason === "absent";
}

function isRetryableStartupAbsence(error: unknown): boolean {
  return (
    (error instanceof RuntimeEndpointUnavailableError &&
      (error.reason === "absent" || error.reason === "timeout" || error.reason === "busy")) ||
    (error instanceof RuntimeIpcClientError && error.code === "request_timeout" && error.execution === "not_started")
  );
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Runtime host bootstrap timeout is invalid.");
  return value;
}

function remainingTimeout(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function canceled(): RuntimeIpcClientError {
  return new RuntimeIpcClientError("request_canceled", "not_started", false);
}
