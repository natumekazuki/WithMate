import type { ApplicationSessionOperations } from "../main/index.js";
import { projectCliOperationOutput, type CliOperationProjectionResult } from "./application-response.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  type CliCommandIdentity,
  type CliRuntimeFailureOutput,
  type CliSessionOperation,
  type CliValidatedCommand,
} from "./contract.js";

type CommandFor<TOperation extends CliSessionOperation> = Extract<
  CliValidatedCommand,
  Readonly<{ identity: CliCommandIdentity<TOperation> }>
>;

export type CliSessionDispatchDependencies<TAuthorizationContext> = Readonly<{
  operations: ApplicationSessionOperations<TAuthorizationContext>;
  authorization: TAuthorizationContext;
  signal?: AbortSignal;
}>;

export type CliSessionDispatchResult =
  | CliOperationProjectionResult
  | Readonly<{
      ok: false;
      output: CliRuntimeFailureOutput;
      exitCode: typeof CLI_EXIT_CODES.runtimeFailure;
    }>;

export async function dispatchCliSessionCommand<TAuthorizationContext>(
  command: CliValidatedCommand,
  dependencies: CliSessionDispatchDependencies<TAuthorizationContext>,
): Promise<CliSessionDispatchResult> {
  try {
    const context = { authorization: dependencies.authorization } as const;
    const options = {
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    };
    let response: unknown;
    if (isCommandFor(command, "create")) {
      response = await dependencies.operations.create(
        {
          context,
          title: command.title,
          workspacePath: command.workspacePath,
          idempotencyKey: command.idempotencyKey,
          providerId: command.providerId,
          allowedAdditionalDirectories: command.allowedAdditionalDirectories,
          defaultCharacterId: command.defaultCharacterId,
          maxConcurrentChildRuns: command.maxConcurrentChildRuns,
        },
        options,
      );
    } else if (isCommandFor(command, "list")) {
      response = await dependencies.operations.list(
        {
          context,
          ...(command.workspacePath === undefined ? {} : { workspacePath: command.workspacePath }),
          ...(command.lifecycleStatus === undefined ? {} : { lifecycleStatus: command.lifecycleStatus }),
          ...(command.localRepositoryKeys === undefined ? {} : { localRepositoryKeys: command.localRepositoryKeys }),
          ...(command.query === undefined ? {} : { query: command.query }),
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit,
        },
        options,
      );
    } else if (isCommandFor(command, "rename")) {
      response = await dependencies.operations.updateTitle(
        {
          context,
          sessionId: command.sessionId,
          title: command.title,
          idempotencyKey: command.idempotencyKey,
        },
        options,
      );
    } else if (isCommandFor(command, "repositories")) {
      response = await dependencies.operations.listLocalRepositories(
        {
          context,
          ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
          limit: command.limit,
        },
        options,
      );
    } else if (isCommandFor(command, "read")) {
      response = await dependencies.operations.read({ context, sessionId: command.sessionId }, options);
    } else if (isCommandFor(command, "directories-chunk")) {
      response = await dependencies.operations.readDirectoriesChunk(
        { context, sessionId: command.sessionId, offset: command.offset, maxBytes: command.maxBytes },
        options,
      );
    } else if (isCommandFor(command, "archive")) {
      response = await dependencies.operations.archive(
        { context, sessionId: command.sessionId, idempotencyKey: command.idempotencyKey },
        options,
      );
    } else if (isCommandFor(command, "unarchive")) {
      response = await dependencies.operations.unarchive(
        { context, sessionId: command.sessionId, idempotencyKey: command.idempotencyKey },
        options,
      );
    } else if (isCommandFor(command, "close")) {
      response = await dependencies.operations.close(
        {
          context,
          sessionId: command.sessionId,
          idempotencyKey: command.idempotencyKey,
          expectedLifecycleStatus: command.expectedLifecycleStatus,
        },
        options,
      );
    } else if (isCommandFor(command, "delete")) {
      response = await dependencies.operations.delete(
        { context, sessionId: command.sessionId, idempotencyKey: command.idempotencyKey },
        options,
      );
    } else {
      throw new TypeError("Unsupported CLI Session command.");
    }
    return projectCliOperationOutput(command, response);
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

function isCommandFor<TOperation extends CliSessionOperation>(
  command: CliValidatedCommand,
  operation: TOperation,
): command is CommandFor<TOperation> {
  return command.identity.operation === operation;
}
