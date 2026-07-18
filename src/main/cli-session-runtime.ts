import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ApplicationAccessDecision,
  ApplicationAccessValidationInput,
  ApplicationAccessValidator,
  ApplicationSessionOperations,
} from "../shared/application-service-model.js";
import { createApplicationSessionOperations } from "./application-session-service.js";
import { PersistenceWorkerClient } from "./persistence-worker-client.js";

const APPLICATION_DIRECTORY_NAME = "WithMate";
const DATABASE_FILE_NAME = "withmate.sqlite3";
const localCliAuthorization = Object.freeze({ transport: "local_cli", principal: "current_os_user" } as const);

export type LocalCliAuthorization = typeof localCliAuthorization;

export type CliSessionRuntime = Readonly<{
  operations: ApplicationSessionOperations<LocalCliAuthorization>;
  authorization: LocalCliAuthorization;
  shutdown(): Promise<Readonly<{ checkpoint: "completed" | "failed" }>>;
}>;

export async function startCliSessionRuntime(): Promise<CliSessionRuntime> {
  const client = new PersistenceWorkerClient({
    databasePath: resolveWithMateDatabasePath(),
    legacyDatabasePaths: [],
  });
  await client.start();
  try {
    const operations = createApplicationSessionOperations(client, {
      access: new LocalCliAccessValidator(),
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

export function resolveWithMateDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  return path.join(
    resolveApplicationDataRoot(environment, platform, homeDirectory),
    APPLICATION_DIRECTORY_NAME,
    DATABASE_FILE_NAME,
  );
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

function resolveApplicationDataRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string {
  if (platform === "win32")
    return absoluteEnvironmentPath(environment.APPDATA) ?? path.join(homeDirectory, "AppData", "Roaming");
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support");
  return absoluteEnvironmentPath(environment.XDG_CONFIG_HOME) ?? path.join(homeDirectory, ".config");
}

function absoluteEnvironmentPath(value: string | undefined): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? path.normalize(value) : undefined;
}
