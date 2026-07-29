import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import type {
  ApplicationAccessDecision,
  ApplicationAccessValidationInput,
  ApplicationAccessValidator,
  ApplicationSessionOperations,
} from "../shared/application-service-model.js";
import type {
  ApplicationRunAccessValidationInput,
  ApplicationRunAccessValidator,
  ApplicationRunOperations,
} from "../shared/application-run-model.js";
import type {
  ApplicationRunOutputAccessValidationInput,
  ApplicationRunOutputAccessValidator,
  ApplicationRunOutputOperations,
} from "../shared/application-run-output-model.js";
import type {
  ApplicationSessionMessageAccessValidationInput,
  ApplicationSessionMessageAccessValidator,
  ApplicationSessionMessageOperations,
} from "../shared/application-session-message-model.js";
import type {
  ApplicationSessionRunAccessValidationInput,
  ApplicationSessionRunAccessValidator,
  ApplicationSessionRunOperations,
} from "../shared/application-session-run-model.js";
import { resolveWithMateApplicationDirectory } from "./application-data-path.js";
import { createApplicationRunDispatchService } from "./application-run-dispatch-service.js";
import { createApplicationRunEventService } from "./application-run-event-service.js";
import { createApplicationRunOperations } from "./application-run-service.js";
import { createApplicationRunOutputOperations } from "./application-run-output-service.js";
import {
  ApplicationRunRuntimeShutdownPendingError,
  createApplicationRunRuntimeService,
} from "./application-run-runtime-service.js";
import { createApplicationSessionOperations } from "./application-session-service.js";
import { createApplicationSessionMessageOperations } from "./application-session-message-service.js";
import { createApplicationSessionRunOperations } from "./application-session-run-service.js";
import { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { LocalSessionFilesCleanup } from "./session-files-cleanup.js";
import { CodexApplicationRunRuntimeFactory } from "./runtime-codex-provider.js";
import type { RuntimeOwnerIdentity } from "./runtime-host/runtime-owner-identity.js";

const localRuntimeAuthorization = Object.freeze({
  transport: "local_cli",
  principal: "current_os_user",
} as const);

export type LocalRuntimeAuthorization = typeof localRuntimeAuthorization;

export type RuntimeApplicationControl = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export type RuntimeApplication = Readonly<{
  operations: ApplicationSessionOperations<LocalRuntimeAuthorization>;
  messageOperations: ApplicationSessionMessageOperations<LocalRuntimeAuthorization>;
  sessionRunOperations: ApplicationSessionRunOperations<LocalRuntimeAuthorization>;
  runOperations: ApplicationRunOperations<LocalRuntimeAuthorization>;
  runOutputOperations: ApplicationRunOutputOperations<LocalRuntimeAuthorization>;
  authorization: LocalRuntimeAuthorization;
  shutdown(control?: RuntimeApplicationControl): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export type OwnedRuntimeApplication = RuntimeApplication &
  Readonly<{
    fatalError: Promise<Error>;
  }>;

export class RuntimeApplicationShutdownPendingError extends Error {
  constructor(options: ErrorOptions = {}) {
    super("Runtime Application persistence closure is still pending.", options);
    this.name = "RuntimeApplicationShutdownPendingError";
  }
}

export async function startRuntimeApplication(
  identity: RuntimeOwnerIdentity,
  control: RuntimeApplicationControl = {},
): Promise<OwnedRuntimeApplication> {
  const timeoutMs = control.timeoutMs === undefined ? undefined : positiveTimeout(control.timeoutMs);
  const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const applicationDataRoot = path.dirname(identity.applicationDirectory);
  if (!sameHostPath(resolveWithMateApplicationDirectory(applicationDataRoot), identity.applicationDirectory)) {
    throw new Error("Runtime application storage paths do not share the canonical owner identity.");
  }

  const sessionFiles = await runControlled(
    LocalSessionFilesCleanup.bindToApplicationDataRoot(applicationDataRoot),
    deadlineAt,
    control.signal,
  );
  const client = new PersistenceWorkerClient({
    databasePath: identity.databasePath,
    legacyDatabasePaths: [],
    ...(deadlineAt === undefined ? {} : { startupTimeoutMs: remainingTimeout(deadlineAt) }),
  });
  await client.start({ ...(control.signal === undefined ? {} : { signal: control.signal }) });
  try {
    await runControlled(sessionFiles.assertStorageOwner(), deadlineAt, control.signal);
    const access = new LocalRuntimeAccessValidator();
    const runEvents = createApplicationRunEventService(client);
    const runDispatch = createApplicationRunDispatchService(client, runEvents);
    const runRuntime = createApplicationRunRuntimeService(client, new CodexApplicationRunRuntimeFactory(), {
      dispatchReady: runDispatch,
      events: runEvents,
    });
    let shutdownPromise: Promise<Readonly<{ checkpoint: "completed" | "failed" }>> | undefined;
    return {
      operations: createApplicationSessionOperations(client, { access, sessionFiles, snapshotAuthorization }),
      messageOperations: createApplicationSessionMessageOperations(client, { access, snapshotAuthorization }),
      sessionRunOperations: createApplicationSessionRunOperations(client, { access, snapshotAuthorization }),
      runOperations: createApplicationRunOperations(client, {
        access,
        snapshotAuthorization,
        handoff: runRuntime,
        liveActivity: runEvents,
      }),
      runOutputOperations: createApplicationRunOutputOperations(client, { access, snapshotAuthorization }),
      authorization: localRuntimeAuthorization,
      fatalError: client.fatalError,
      shutdown(shutdownControl = {}) {
        if (shutdownPromise === undefined) {
          const attempt = (async () => {
            try {
              await runRuntime.shutdown();
            } catch (error) {
              if (error instanceof ApplicationRunRuntimeShutdownPendingError) {
                throw new RuntimeApplicationShutdownPendingError({ cause: error });
              }
              throw error;
            }
            return client.shutdown(shutdownControl.timeoutMs ?? 10_000, shutdownControl.signal);
          })().catch((error: unknown) => {
            if (shutdownPromise === attempt) shutdownPromise = undefined;
            throw error;
          });
          shutdownPromise = attempt;
        }
        return shutdownPromise;
      },
    };
  } catch (error) {
    await client.shutdown(remainingTimeout(deadlineAt), control.signal).catch(() => undefined);
    throw error;
  }
}

async function runControlled<TValue>(
  operation: Promise<TValue>,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<TValue> {
  if (signal?.aborted) throw runtimeStartupCanceled();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (deadlineAt !== undefined) {
      timer = setTimeout(
        () => reject(new Error("Runtime Application startup timed out.")),
        remainingTimeout(deadlineAt),
      );
    }
    if (signal !== undefined) {
      onAbort = () => reject(runtimeStartupCanceled());
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

function remainingTimeout(deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? 10_000 : Math.max(1, deadlineAt - Date.now());
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Runtime Application timeout is invalid.");
  return value;
}

class LocalRuntimeAccessValidator
  implements
    ApplicationAccessValidator<LocalRuntimeAuthorization>,
    ApplicationRunAccessValidator<LocalRuntimeAuthorization>,
    ApplicationRunOutputAccessValidator<LocalRuntimeAuthorization>,
    ApplicationSessionMessageAccessValidator<LocalRuntimeAuthorization>,
    ApplicationSessionRunAccessValidator<LocalRuntimeAuthorization>
{
  async validateWorkspace(
    input: Extract<ApplicationAccessValidationInput<LocalRuntimeAuthorization>, Readonly<{ operation: "create" }>>,
  ): Promise<ApplicationAccessDecision> {
    if (!isLocalRuntimeAuthorization(input.context.authorization)) return authorizationInvalid();
    for (const directory of [input.target.workspacePath, ...input.target.allowedAdditionalDirectories]) {
      let stats: Stats;
      try {
        stats = await fs.stat(directory);
      } catch {
        return {
          allowed: false,
          error: {
            code: "workspace_unavailable",
            message: "Workspace directory is unavailable.",
            retryable: true,
          },
        };
      }
      if (!stats.isDirectory()) {
        return {
          allowed: false,
          error: {
            code: "workspace_invalid",
            message: "Workspace path must identify a directory.",
            retryable: false,
          },
        };
      }
    }
    return { allowed: true };
  }

  async authorize(
    input:
      | ApplicationAccessValidationInput<LocalRuntimeAuthorization>
      | ApplicationRunAccessValidationInput<LocalRuntimeAuthorization>
      | ApplicationRunOutputAccessValidationInput<LocalRuntimeAuthorization>
      | ApplicationSessionMessageAccessValidationInput<LocalRuntimeAuthorization>
      | ApplicationSessionRunAccessValidationInput<LocalRuntimeAuthorization>,
  ): Promise<ApplicationAccessDecision> {
    return isLocalRuntimeAuthorization(input.context.authorization) ? { allowed: true } : authorizationInvalid();
  }
}

function snapshotAuthorization(value: unknown): LocalRuntimeAuthorization {
  if (!isLocalRuntimeAuthorization(value)) throw new TypeError("Runtime authorization context is invalid.");
  return { transport: "local_cli", principal: "current_os_user" };
}

function isLocalRuntimeAuthorization(value: unknown): value is LocalRuntimeAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(candidate).length === 2 &&
    candidate.transport === "local_cli" &&
    candidate.principal === "current_os_user"
  );
}

function authorizationInvalid(): ApplicationAccessDecision {
  return {
    allowed: false,
    error: {
      code: "authorization_invalid",
      message: "Runtime authorization context is invalid.",
      retryable: false,
    },
  };
}

function sameHostPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function runtimeStartupCanceled(): Error {
  const error = new Error("Runtime Application startup was canceled.");
  error.name = "AbortError";
  return error;
}
