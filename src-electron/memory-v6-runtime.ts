import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  resolveDefaultWithMateMemoryRuntimeDirectory,
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryDiscoveryDocument,
} from "../src/memory-v6/memory-discovery.js";
import type { AppLogInput } from "../src/app-log-types.js";
import { createOrVerifyV6FreshDatabase } from "./app-database-v6-bootstrap.js";
import { createMemoryV6HttpServer, type MemoryV6HttpServer } from "./memory-v6-http-server.js";
import { MemoryV6Service } from "./memory-v6-service.js";
import { MemoryV6Storage } from "./memory-v6-storage.js";

export type MemoryV6RuntimeApiHandle = {
  baseUrl: string;
  dbPath: string;
  discoveryFilePath: string;
  stop(): Promise<void>;
};

export type StartMemoryV6RuntimeApiOptions = {
  userDataPath: string;
  runtimeDirectoryPath?: string;
  log?: (input: AppLogInput) => void;
};

export type PublishMemoryV6DiscoveryFileOptions = {
  baseUrl: string;
  runtimeDirectoryPath?: string;
};

type PublishedMemoryV6DiscoveryFile = {
  discoveryFilePath: string;
  cleanup(): Promise<void>;
};

async function chmodBestEffort(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch {
    // Windows does not provide POSIX file modes. Creation location still keeps this OS-user local.
  }
}

export async function publishMemoryV6DiscoveryFile(
  options: PublishMemoryV6DiscoveryFileOptions,
): Promise<PublishedMemoryV6DiscoveryFile> {
  const runtimeDirectoryPath = options.runtimeDirectoryPath
    ? path.resolve(options.runtimeDirectoryPath)
    : resolveDefaultWithMateMemoryRuntimeDirectory();
  const discoveryFilePath = path.join(runtimeDirectoryPath, WITHMATE_MEMORY_DISCOVERY_FILE_NAME);
  const temporaryFilePath = `${discoveryFilePath}.${process.pid}.${Date.now()}.tmp`;
  const document: WithMateMemoryDiscoveryDocument = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
    baseUrl: options.baseUrl,
  };

  try {
    await mkdir(runtimeDirectoryPath, { recursive: true, mode: 0o700 });
    await chmodBestEffort(runtimeDirectoryPath, 0o700);
    await writeFile(temporaryFilePath, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmodBestEffort(temporaryFilePath, 0o600);
    await rename(temporaryFilePath, discoveryFilePath);
    await chmodBestEffort(discoveryFilePath, 0o600);
  } catch (error) {
    await rm(temporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    discoveryFilePath,
    async cleanup(): Promise<void> {
      await rm(discoveryFilePath, { force: true });
    },
  };
}

export async function startMemoryV6RuntimeApi(
  options: StartMemoryV6RuntimeApiOptions,
): Promise<MemoryV6RuntimeApiHandle> {
  let storage: MemoryV6Storage | null = null;
  let server: MemoryV6HttpServer | null = null;
  let discoveryFile: PublishedMemoryV6DiscoveryFile | null = null;

  try {
    const bootstrap = await createOrVerifyV6FreshDatabase(options.userDataPath);
    storage = new MemoryV6Storage(bootstrap.dbPath);
    const service = new MemoryV6Service({ storage });
    server = createMemoryV6HttpServer({
      service,
      resolvePrincipal: () => null,
    });
    await server.start();

    const address = server.address();
    if (!address) {
      throw new Error("Memory V6 runtime API did not expose an HTTP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    discoveryFile = await publishMemoryV6DiscoveryFile({
      baseUrl,
      runtimeDirectoryPath: options.runtimeDirectoryPath,
    });

    options.log?.({
      level: "info",
      kind: "memory-v6.runtime-api.started",
      process: "main",
      message: "Memory V6 runtime API started",
      data: {
        baseUrl,
        dbPath: bootstrap.dbPath,
        discoveryFilePath: discoveryFile.discoveryFilePath,
        createdDatabase: bootstrap.created,
      },
    });

    return {
      baseUrl,
      dbPath: bootstrap.dbPath,
      discoveryFilePath: discoveryFile.discoveryFilePath,
      async stop(): Promise<void> {
        const cleanupErrors: unknown[] = [];
        try {
          await discoveryFile?.cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await server?.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        storage?.close();

        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Memory V6 runtime API cleanup failed.");
        }
      },
    };
  } catch (error) {
    await discoveryFile?.cleanup().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    storage?.close();
    throw error;
  }
}

export { resolveDefaultWithMateMemoryDiscoveryFilePath };
