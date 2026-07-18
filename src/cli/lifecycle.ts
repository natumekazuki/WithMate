import type { ApplicationSessionOperations } from "../main/index.js";
import { serializeCliStructuredOutput } from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliCommandIdentity,
  type CliLifecycleFailureOutput,
  type CliOperationOutput,
  type CliRuntimeFailureOutput,
  type CliSessionOperation,
} from "./contract.js";
import type { CliInvocationResult } from "./invocation.js";
import { renderCliParseResult } from "./invocation.js";
import { parseCliArgv } from "./parser.js";
import { dispatchCliSessionCommand } from "./session-dispatch.js";

export type CliOperationRuntime<TAuthorizationContext> = Readonly<{
  operations: ApplicationSessionOperations<TAuthorizationContext>;
  authorization: TAuthorizationContext;
  shutdown(): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export type CliLifecycleDependencies<TAuthorizationContext> = Readonly<{
  version: string;
  startRuntime(): Promise<CliOperationRuntime<TAuthorizationContext>>;
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
  let removeInterrupt: (() => void) | undefined;
  let runtime: CliOperationRuntime<TAuthorizationContext>;
  try {
    removeInterrupt = dependencies.registerInterrupt?.(() => abortController.abort());
    runtime = await dependencies.startRuntime();
  } catch {
    removeInterrupt?.();
    return structuredResult(runtimeFailure(parsed.command.identity, "bootstrap_failed"));
  }

  const operationResult = await dispatchCliSessionCommand(parsed.command, {
    operations: runtime.operations,
    authorization: runtime.authorization,
    signal: abortController.signal,
  });
  let shutdownFailed = false;
  try {
    const shutdown = await runtime.shutdown();
    shutdownFailed = shutdown.checkpoint !== "completed";
  } catch {
    shutdownFailed = true;
  } finally {
    removeInterrupt?.();
  }

  if (shutdownFailed) {
    if (operationResult.output.kind === "operation") {
      return structuredResult(lifecycleFailure(operationResult.output));
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

function structuredResult(output: CliRuntimeFailureOutput | CliLifecycleFailureOutput): CliInvocationResult {
  return {
    stdout: serializeCliStructuredOutput(output),
    stderr: "",
    exitCode: CLI_EXIT_CODES.runtimeFailure,
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

function lifecycleFailure<TOperation extends CliSessionOperation>(
  operationOutput: CliOperationOutput<TOperation>,
): CliLifecycleFailureOutput<TOperation> {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "lifecycle_failure",
    command: operationOutput.command,
    applicationResponse: operationOutput.applicationResponse,
    error: {
      kind: "runtime",
      code: "shutdown_failed",
      stage: "shutdown",
      message: "Application runtime did not shut down cleanly.",
    },
  } as CliLifecycleFailureOutput<TOperation>;
}
