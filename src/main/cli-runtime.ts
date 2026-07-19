import fs from "node:fs/promises";
import type { Stats } from "node:fs";

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
import { resolveApplicationDataRoot, resolveWithMateDatabasePathFromRoot } from "./application-data-path.js";
import { createApplicationRunOperations } from "./application-run-service.js";
import { createApplicationSessionOperations } from "./application-session-service.js";
import { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { LocalSessionFilesCleanup } from "./session-files-cleanup.js";

const localCliAuthorization = Object.freeze({ transport: "local_cli", principal: "current_os_user" } as const);

export { resolveWithMateDatabasePath } from "./application-data-path.js";

export type LocalCliAuthorization = typeof localCliAuthorization;

export type CliRuntimeControl = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export type CliRuntime = Readonly<{
  operations: ApplicationSessionOperations<LocalCliAuthorization>;
  runOperations: ApplicationRunOperations<LocalCliAuthorization>;
  authorization: LocalCliAuthorization;
  shutdown(control?: CliRuntimeControl): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export async function startCliRuntime(control: CliRuntimeControl = {}): Promise<CliRuntime> {
  const deadlineAt = control.timeoutMs === undefined ? undefined : Date.now() + control.timeoutMs;
  const applicationDataRoot = resolveApplicationDataRoot();
  const databasePath = resolveWithMateDatabasePathFromRoot(applicationDataRoot);
  const sessionFiles = await runControlled(
    LocalSessionFilesCleanup.bindToApplicationDataRoot(applicationDataRoot),
    deadlineAt,
    control.signal,
  );
  const client = new PersistenceWorkerClient({
    databasePath,
    legacyDatabasePaths: [],
    ...(deadlineAt === undefined ? {} : { startupTimeoutMs: remainingTimeout(deadlineAt) }),
  });
  await client.start({ ...(control.signal === undefined ? {} : { signal: control.signal }) });
  try {
    await runControlled(sessionFiles.assertStorageOwner(), deadlineAt, control.signal);
    const access = new LocalCliAccessValidator();
    return {
      operations: createApplicationSessionOperations(client, { access, sessionFiles, snapshotAuthorization }),
      runOperations: createApplicationRunOperations(client, { access, snapshotAuthorization }),
      authorization: localCliAuthorization,
      shutdown: (shutdownControl = {}) => client.shutdown(shutdownControl.timeoutMs ?? 10_000, shutdownControl.signal),
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
  if (signal?.aborted) throw new Error("CLI runtime startup was canceled.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (deadlineAt !== undefined) {
      timer = setTimeout(() => reject(new Error("CLI runtime startup timed out.")), remainingTimeout(deadlineAt));
    }
    if (signal !== undefined) {
      onAbort = () => reject(new Error("CLI runtime startup was canceled."));
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

class LocalCliAccessValidator
  implements ApplicationAccessValidator<LocalCliAuthorization>, ApplicationRunAccessValidator<LocalCliAuthorization>
{
  async validateWorkspace(
    input: Extract<ApplicationAccessValidationInput<LocalCliAuthorization>, Readonly<{ operation: "create" }>>,
  ): Promise<ApplicationAccessDecision> {
    if (!isLocalCliAuthorization(input.context.authorization)) return authorizationInvalid();
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
      | ApplicationAccessValidationInput<LocalCliAuthorization>
      | ApplicationRunAccessValidationInput<LocalCliAuthorization>,
  ): Promise<ApplicationAccessDecision> {
    return isLocalCliAuthorization(input.context.authorization) ? { allowed: true } : authorizationInvalid();
  }
}

function snapshotAuthorization(value: unknown): LocalCliAuthorization {
  if (!isLocalCliAuthorization(value)) throw new TypeError("CLI authorization context is invalid.");
  return { transport: "local_cli", principal: "current_os_user" };
}

function isLocalCliAuthorization(value: unknown): value is LocalCliAuthorization {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.transport === "local_cli" && candidate.principal === "current_os_user";
}

function authorizationInvalid(): ApplicationAccessDecision {
  return {
    allowed: false,
    error: {
      code: "authorization_invalid",
      message: "CLI authorization context is invalid.",
      retryable: false,
    },
  };
}
