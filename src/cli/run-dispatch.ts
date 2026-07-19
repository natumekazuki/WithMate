import type { ApplicationRunOperations } from "../main/index.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliCommandIdentity,
  type CliRunOperation,
  type CliRuntimeFailureOutput,
  type CliValidatedRunCommand,
} from "./contract.js";
import { projectCliRunOperationOutput, type CliRunOperationProjectionResult } from "./run-output.js";

type CommandFor<TOperation extends CliRunOperation> = Extract<
  CliValidatedRunCommand,
  Readonly<{ identity: CliCommandIdentity<TOperation> }>
>;

export type CliRunDispatchDependencies<TAuthorizationContext> = Readonly<{
  operations: ApplicationRunOperations<TAuthorizationContext>;
  authorization: TAuthorizationContext;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type CliRunDispatchResult =
  | CliRunOperationProjectionResult
  | Readonly<{
      ok: false;
      output: CliRuntimeFailureOutput;
      exitCode: typeof CLI_EXIT_CODES.runtimeFailure;
    }>;

export async function dispatchCliRunCommand<TAuthorizationContext>(
  command: CliValidatedRunCommand,
  dependencies: CliRunDispatchDependencies<TAuthorizationContext>,
): Promise<CliRunDispatchResult> {
  try {
    const context = { authorization: dependencies.authorization } as const;
    const timeoutMs = dependencies.timeoutMs ?? command.timeoutMs;
    const options = {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    };
    let response: unknown;
    if (isCommandFor(command, "status")) {
      response = await dependencies.operations.status(
        { context, sessionId: command.sessionId, runId: command.runId },
        options,
      );
    } else if (isCommandFor(command, "events")) {
      response = await dependencies.operations.events(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit,
        },
        options,
      );
    } else if (isCommandFor(command, "follow")) {
      response = await dependencies.operations.follow(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit,
          waitMs: command.waitMs,
          pollMs: command.pollMs,
        },
        options,
      );
    } else {
      throw new TypeError("Unsupported CLI Run command.");
    }
    return projectCliRunOperationOutput(command, response);
  } catch {
    return {
      ok: false,
      output: {
        schemaVersion: CLI_SCHEMA_VERSION,
        kind: "runtime_failure",
        command: command.identity,
        error: {
          kind: "runtime",
          code: "internal_failure",
          stage: "operation",
          message: "Application operation failed unexpectedly.",
        },
      },
      exitCode: CLI_EXIT_CODES.runtimeFailure,
    };
  }
}

function isCommandFor<TOperation extends CliRunOperation>(
  command: CliValidatedRunCommand,
  operation: TOperation,
): command is CommandFor<TOperation> {
  return command.identity.operation === operation;
}
