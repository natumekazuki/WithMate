import fs from "node:fs/promises";
import type { Stats } from "node:fs";

import type {
  ApplicationAccessDecision,
  ApplicationAccessValidationInput,
  ApplicationAccessValidator,
  ApplicationSessionOperations,
} from "../shared/application-service-model.js";
import { createApplicationSessionOperations } from "./application-session-service.js";
import { resolveApplicationDataRoot, resolveWithMateDatabasePathFromRoot } from "./application-data-path.js";
import { PersistenceWorkerClient } from "./persistence-worker-client.js";
import { LocalSessionFilesCleanup } from "./session-files-cleanup.js";

const localCliAuthorization = Object.freeze({ transport: "local_cli", principal: "current_os_user" } as const);

export { resolveWithMateDatabasePath } from "./application-data-path.js";

export type LocalCliAuthorization = typeof localCliAuthorization;

export type CliSessionRuntime = Readonly<{
  operations: ApplicationSessionOperations<LocalCliAuthorization>;
  authorization: LocalCliAuthorization;
  shutdown(): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export async function startCliSessionRuntime(): Promise<CliSessionRuntime> {
  const applicationDataRoot = resolveApplicationDataRoot();
  const databasePath = resolveWithMateDatabasePathFromRoot(applicationDataRoot);
  const sessionFiles = await LocalSessionFilesCleanup.bindToApplicationDataRoot(applicationDataRoot);
  const client = new PersistenceWorkerClient({
    databasePath,
    legacyDatabasePaths: [],
  });
  await client.start();
  try {
    await sessionFiles.assertStorageOwner();
    const operations = createApplicationSessionOperations(client, {
      access: new LocalCliAccessValidator(),
      sessionFiles,
      snapshotAuthorization,
    });
    return {
      operations,
      authorization: localCliAuthorization,
      shutdown: () => client.shutdown(),
    };
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    throw error;
  }
}

class LocalCliAccessValidator implements ApplicationAccessValidator<LocalCliAuthorization> {
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

  async authorize(input: ApplicationAccessValidationInput<LocalCliAuthorization>): Promise<ApplicationAccessDecision> {
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
