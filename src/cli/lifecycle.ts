import type { ApplicationRunOperations, ApplicationSessionOperations } from "../main/index.js";
import { serializeCliStructuredOutput } from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliAnyOperationOutput,
  type CliCommandIdentity,
  type CliLifecycleFailureOutput,
  type CliRuntimeFailureOutput,
  type CliValidatedRunCommand,
  type CliValidatedSessionCommand,
} from "./contract.js";
import type { CliInvocationResult } from "./invocation.js";
import { renderCliParseResult } from "./invocation.js";
import { parseCliArgv } from "./parser.js";
import { dispatchCliRunCommand } from "./run-dispatch.js";
import { dispatchCliSessionCommand } from "./session-dispatch.js";

export type CliLifecycleControl = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export type CliOperationRuntime<TAuthorizationContext> = Readonly<{
  operations: ApplicationSessionOperations<TAuthorizationContext>;
  runOperations: ApplicationRunOperations<TAuthorizationContext>;
  authorization: TAuthorizationContext;
  shutdown(control?: CliLifecycleControl): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export type CliLifecycleDependencies<TAuthorizationContext> = Readonly<{
  version: string;
  startRuntime(control?: CliLifecycleControl): Promise<CliOperationRuntime<TAuthorizationContext>>;
  registerInterrupt?(abort: () => void): () => void;
}>;

export async function runCliLifecycle<TAuthorizationContext>(
  argv: readonly string[],
  dependencies: CliLifecycleDependencies<TAuthorizationContext>,
): Promise<CliInvocationResult> {
  const parsed = parseCliArgv(argv);
  if (parsed.kind !== "command") {
    const rendered = renderCliParseResult(parsed, dependencies.version);
    if (rendered === undefined) throw new TypeError("CLI parse result could not be rendered.");
    return rendered;
  }

  const abortController = new AbortController();
  const deadlineAt = parsed.command.timeoutMs === undefined ? undefined : Date.now() + parsed.command.timeoutMs;
  let removeInterrupt: (() => void) | undefined;
  let runtime: CliOperationRuntime<TAuthorizationContext>;
  let startupPromise: Promise<CliOperationRuntime<TAuthorizationContext>> | undefined;
  try {
    removeInterrupt = dependencies.registerInterrupt?.(() => abortController.abort());
    startupPromise = dependencies.startRuntime(lifecycleControl(deadlineAt, abortController.signal));
    runtime = await waitForStage(startupPromise, deadlineAt, abortController.signal);
  } catch (error) {
    removeInterrupt?.();
    const interruption = lifecycleStageInterruption(error, deadlineAt, abortController.signal);
    if (interruption !== undefined && startupPromise !== undefined) {
      void startupPromise.then((lateRuntime) => lateRuntime.shutdown({ timeoutMs: 1 })).catch(() => undefined);
      return structuredResult(
        runtimeInterruptionFailure(parsed.command.identity, "bootstrap", interruption),
        interruptionExitCode(interruption),
      );
    }
    return structuredResult(runtimeFailure(parsed.command.identity, "bootstrap_failed"));
  }

  let operationResult;
  let shutdownFailure: "shutdown_failed" | "lifecycle_timeout" | "lifecycle_canceled" | undefined;
  try {
    const operationControl = operationTimeout(deadlineAt);
    operationResult =
      parsed.command.identity.namespace === "session"
        ? await dispatchCliSessionCommand(parsed.command as CliValidatedSessionCommand, {
            operations: runtime.operations,
            authorization: runtime.authorization,
            signal: abortController.signal,
            ...operationControl,
          })
        : await dispatchCliRunCommand(parsed.command as CliValidatedRunCommand, {
            operations: runtime.runOperations,
            authorization: runtime.authorization,
            signal: abortController.signal,
            ...operationControl,
          });
  } catch {
    operationResult = {
      ok: false as const,
      output: operationRuntimeFailure(parsed.command.identity),
      exitCode: CLI_EXIT_CODES.runtimeFailure,
    };
  } finally {
    const shutdownSignal = abortController.signal;
    try {
      const shutdown = await waitForStage(
        runtime.shutdown(lifecycleControl(deadlineAt, shutdownSignal)),
        deadlineAt,
        shutdownSignal,
      );
      if (shutdown.checkpoint !== "completed") shutdownFailure = "shutdown_failed";
    } catch (error) {
      const interruption = lifecycleStageInterruption(error, deadlineAt, shutdownSignal);
      shutdownFailure = interruption === undefined ? "shutdown_failed" : `lifecycle_${interruption}`;
    } finally {
      removeInterrupt?.();
    }
  }

  if (shutdownFailure !== undefined) {
    const exitCode =
      shutdownFailure === "lifecycle_timeout"
        ? CLI_EXIT_CODES.timeout
        : shutdownFailure === "lifecycle_canceled"
          ? CLI_EXIT_CODES.canceled
          : CLI_EXIT_CODES.runtimeFailure;
    if (operationResult.output.kind === "operation") {
      return structuredResult(lifecycleFailure(operationResult.output, shutdownFailure), exitCode);
    }
    if (shutdownFailure === "lifecycle_timeout" || shutdownFailure === "lifecycle_canceled") {
      return structuredResult(
        runtimeInterruptionFailure(
          parsed.command.identity,
          "shutdown",
          shutdownFailure === "lifecycle_timeout" ? "timeout" : "canceled",
        ),
        exitCode,
      );
    }
    return structuredResult(runtimeFailure(parsed.command.identity, "shutdown_failed"));
  }

  return {
    stdout: serializeCliStructuredOutput(operationResult.output),
    stderr: "",
    exitCode: operationResult.exitCode,
  };
}

export function registerProcessSigint(abort: () => void): () => void {
  const handler = () => abort();
  process.once("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

function structuredResult(
  output: CliRuntimeFailureOutput | CliLifecycleFailureOutput,
  exitCode: CliInvocationResult["exitCode"] = CLI_EXIT_CODES.runtimeFailure,
): CliInvocationResult {
  return {
    stdout: serializeCliStructuredOutput(output),
    stderr: "",
    exitCode,
  };
}

function runtimeFailure(
  command: CliCommandIdentity | null,
  code: "bootstrap_failed" | "shutdown_failed",
): CliRuntimeFailureOutput {
  if (code === "bootstrap_failed") {
    return {
      schemaVersion: CLI_SCHEMA_VERSION,
      kind: "runtime_failure",
      command,
      error: {
        kind: "runtime",
        code,
        stage: "bootstrap",
        message: "Application runtime could not be started.",
      },
    };
  }
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "runtime_failure",
    command,
    error: {
      kind: "runtime",
      code,
      stage: "shutdown",
      message: "Application runtime did not shut down cleanly.",
    },
  };
}

function operationRuntimeFailure(command: CliCommandIdentity): CliRuntimeFailureOutput {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "runtime_failure",
    command,
    error: {
      kind: "runtime",
      code: "internal_failure",
      stage: "operation",
      message: "Application operation failed unexpectedly.",
    },
  };
}

function runtimeInterruptionFailure(
  command: CliCommandIdentity,
  stage: "bootstrap" | "shutdown",
  interruption: "timeout" | "canceled",
): CliRuntimeFailureOutput {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "runtime_failure",
    command,
    error: {
      kind: "runtime",
      code: interruption === "timeout" ? "lifecycle_timeout" : "lifecycle_canceled",
      stage,
      message: interruption === "timeout" ? "CLI lifecycle timed out." : "CLI lifecycle was canceled.",
    },
  };
}

function lifecycleFailure(
  operationOutput: CliAnyOperationOutput,
  code: "shutdown_failed" | "lifecycle_timeout" | "lifecycle_canceled",
): CliLifecycleFailureOutput {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "lifecycle_failure",
    command: operationOutput.command,
    applicationResponse: operationOutput.applicationResponse,
    error: {
      kind: "runtime",
      code,
      stage: "shutdown",
      message:
        code === "lifecycle_timeout"
          ? "CLI lifecycle timed out during shutdown."
          : code === "lifecycle_canceled"
            ? "CLI lifecycle was canceled during shutdown."
            : "Application runtime did not shut down cleanly.",
    },
  } as CliLifecycleFailureOutput;
}

function lifecycleControl(deadlineAt: number | undefined, signal: AbortSignal | undefined): CliLifecycleControl {
  return {
    ...(deadlineAt === undefined ? {} : { timeoutMs: Math.max(1, deadlineAt - Date.now()) }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function operationTimeout(deadlineAt: number | undefined): Readonly<{ timeoutMs?: number }> {
  return deadlineAt === undefined ? {} : { timeoutMs: Math.max(1, deadlineAt - Date.now()) };
}

function lifecycleInterruption(
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): "timeout" | "canceled" | undefined {
  if (signal?.aborted) return "canceled";
  return deadlineAt !== undefined && Date.now() >= deadlineAt ? "timeout" : undefined;
}

function lifecycleStageInterruption(
  error: unknown,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): "timeout" | "canceled" | undefined {
  return error instanceof CliLifecycleInterruptionError
    ? error.interruption
    : lifecycleInterruption(deadlineAt, signal);
}

function interruptionExitCode(interruption: "timeout" | "canceled") {
  return interruption === "timeout" ? CLI_EXIT_CODES.timeout : CLI_EXIT_CODES.canceled;
}

async function waitForStage<TValue>(
  operation: Promise<TValue>,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<TValue> {
  const interruption = lifecycleInterruption(deadlineAt, signal);
  if (interruption !== undefined) {
    void operation.catch(() => undefined);
    throw new CliLifecycleInterruptionError(interruption);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (deadlineAt !== undefined) {
      timer = setTimeout(
        () => reject(new CliLifecycleInterruptionError("timeout")),
        Math.max(0, deadlineAt - Date.now()),
      );
    }
    if (signal !== undefined) {
      onAbort = () => reject(new CliLifecycleInterruptionError("canceled"));
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

class CliLifecycleInterruptionError extends Error {
  constructor(readonly interruption: "timeout" | "canceled") {
    super(`CLI lifecycle ${interruption}.`);
    this.name = "CliLifecycleInterruptionError";
  }
}
