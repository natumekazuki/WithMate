import type { ApplicationRunOperations, ApplicationRunOutputOperations } from "../main/index.js";
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
  outputOperations: ApplicationRunOutputOperations<TAuthorizationContext>;
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
    } else if (isCommandFor(command, "output-counts")) {
      response = await dependencies.outputOperations.outputCounts(
        { context, sessionId: command.sessionId, runId: command.runId },
        options,
      );
    } else if (isCommandFor(command, "outputs")) {
      response = await dependencies.outputOperations.outputs(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          ...(command.category === undefined ? {} : { category: command.category }),
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit,
        },
        options,
      );
    } else if (isCommandFor(command, "output-preview")) {
      response = await dependencies.outputOperations.outputPreview(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          outputItemId: command.outputItemId,
          maxBytes: command.maxBytes,
        },
        options,
      );
    } else if (isCommandFor(command, "output-chunk")) {
      response = await dependencies.outputOperations.outputChunk(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          outputItemId: command.outputItemId,
          offset: command.offset,
          maxBytes: command.maxBytes,
        },
        options,
      );
    } else if (isCommandFor(command, "output-export")) {
      response = await dependencies.outputOperations.outputExport(
        {
          context,
          sessionId: command.sessionId,
          runId: command.runId,
          outputItemId: command.outputItemId,
          destinationGrant: {
            kind: "explicit_absolute_path",
            authority: "cli_user_selection",
            absolutePath: command.destination,
          },
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
