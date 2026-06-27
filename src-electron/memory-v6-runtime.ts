import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  normalizeWithMateMemoryApiBaseUrl,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  resolveDefaultWithMateMemoryRuntimeDirectory,
  WITHMATE_MEMORY_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryDiscoveryDocument,
} from "../src/memory-v6/memory-discovery.js";
import type { AppLogInput } from "../src/app-log-types.js";
import { createOrVerifyV6FreshDatabase } from "./app-database-v6-bootstrap.js";
import {
  createMemoryV6HttpServer,
  type MemoryV6HttpServer,
} from "./memory-v6-http-server.js";
import type { MemoryBindingRegistry } from "./memory-binding-registry.js";
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
  bindingRegistry?: MemoryBindingRegistry;
  log?: (input: AppLogInput) => void;
};

export type PublishMemoryV6DiscoveryFileOptions = {
  baseUrl: string;
  apiSecret?: string;
  runtimeInstanceId?: string;
  runtimeDirectoryPath?: string;
};

type PublishedMemoryV6DiscoveryFile = {
  discoveryFilePath: string;
  runtimeInstanceId: string;
  cleanup(): Promise<void>;
};

type DiscoveryFileOwnership = {
  discoveryFilePath: string;
  runtimeInstanceId: string;
};

async function chmodRuntimePath(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  }
}

async function ensureSecureRuntimeDirectory(runtimeDirectoryPath: string): Promise<void> {
  await mkdir(runtimeDirectoryPath, { recursive: true, mode: 0o700 });

  const stats = await lstat(runtimeDirectoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Memory V6 runtime directory must be a real directory.");
  }

  if (process.platform === "win32") {
    await chmodRuntimePath(runtimeDirectoryPath, 0o700);
    return;
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new Error("Memory V6 runtime directory must be owned by the current OS user.");
  }

  if ((stats.mode & 0o077) !== 0) {
    await chmodRuntimePath(runtimeDirectoryPath, 0o700);
  }

  const verified = await lstat(runtimeDirectoryPath);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("Memory V6 runtime directory must remain a real directory.");
  }
  if (currentUid !== null && verified.uid !== currentUid) {
    throw new Error("Memory V6 runtime directory owner changed during setup.");
  }
  if ((verified.mode & 0o077) !== 0) {
    throw new Error("Memory V6 runtime directory permissions are too broad.");
  }
}

async function writeFileExclusive(filePath: string, content: string, mode: number): Promise<void> {
  const file = await open(filePath, "wx", mode);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}

async function readDiscoveryDocument(discoveryFilePath: string): Promise<Partial<WithMateMemoryDiscoveryDocument> | null> {
  try {
    return JSON.parse(await readFile(discoveryFilePath, "utf8")) as Partial<WithMateMemoryDiscoveryDocument>;
  } catch {
    return null;
  }
}

async function removeDiscoveryFileIfOwned(input: DiscoveryFileOwnership): Promise<void> {
  const document = await readDiscoveryDocument(input.discoveryFilePath);
  if (document?.runtimeInstanceId !== input.runtimeInstanceId) {
    return;
  }
  await rm(input.discoveryFilePath, { force: true });
}

function createRuntimeApiSecret(): string {
  return randomBytes(32).toString("base64url");
}

function createStatusChallenge(apiSecret: string, nonce: string): string {
  return createHmac("sha256", apiSecret).update(nonce, "utf8").digest("base64url");
}

function readDiscoveryApiSecret(document: Partial<WithMateMemoryDiscoveryDocument> | null): string | undefined {
  return typeof document?.apiSecret === "string" && document.apiSecret.trim().length > 0
    ? document.apiSecret
    : undefined;
}

async function isLiveDiscoveryDocument(document: Partial<WithMateMemoryDiscoveryDocument> | null): Promise<boolean> {
  if (
    !document
    || document.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
    || typeof document.baseUrl !== "string"
    || typeof document.runtimeInstanceId !== "string"
  ) {
    return false;
  }
  const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
  if (!baseUrl) {
    return false;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 500);
  try {
    const apiSecret = readDiscoveryApiSecret(document);
    if (!apiSecret) {
      return false;
    }
    const nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
      method: "GET",
      redirect: "error",
      signal: abortController.signal,
    });
    if (!response.ok) {
      return false;
    }
    const status = await response.json() as {
      runtimeInstanceId?: unknown;
      challenge?: { nonce?: unknown; hmacSha256?: unknown };
    };
    return status.runtimeInstanceId === document.runtimeInstanceId
      && status.challenge?.nonce === nonce
      && status.challenge.hmacSha256 === createStatusChallenge(apiSecret, nonce);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function removeStaleDiscoveryFile(discoveryFilePath: string): Promise<void> {
  const document = await readDiscoveryDocument(discoveryFilePath);
  if (!(await isLiveDiscoveryDocument(document))) {
    await rm(discoveryFilePath, { force: true, recursive: true });
  }
}

function resolveRuntimeDiscoveryPaths(runtimeDirectoryPath?: string): { runtimeDirectoryPath: string; discoveryFilePath: string } {
  const resolvedRuntimeDirectoryPath = runtimeDirectoryPath
    ? path.resolve(runtimeDirectoryPath)
    : resolveDefaultWithMateMemoryRuntimeDirectory();
  return {
    runtimeDirectoryPath: resolvedRuntimeDirectoryPath,
    discoveryFilePath: path.join(resolvedRuntimeDirectoryPath, WITHMATE_MEMORY_DISCOVERY_FILE_NAME),
  };
}

export async function publishMemoryV6DiscoveryFile(
  options: PublishMemoryV6DiscoveryFileOptions,
): Promise<PublishedMemoryV6DiscoveryFile> {
  const { runtimeDirectoryPath, discoveryFilePath } = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);
  const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  const temporaryFilePath = `${discoveryFilePath}.${runtimeInstanceId}.tmp`;
  const document: WithMateMemoryDiscoveryDocument = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
    baseUrl: options.baseUrl,
    ...(options.apiSecret ? { apiSecret: options.apiSecret } : {}),
    runtimeInstanceId,
    publishedAt: new Date().toISOString(),
  };

  try {
    await ensureSecureRuntimeDirectory(runtimeDirectoryPath);
    await writeFileExclusive(temporaryFilePath, `${JSON.stringify(document)}\n`, 0o600);
    await chmodRuntimePath(temporaryFilePath, 0o600);
    await rename(temporaryFilePath, discoveryFilePath);
    await chmodRuntimePath(discoveryFilePath, 0o600);
  } catch (error) {
    await rm(temporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    discoveryFilePath,
    runtimeInstanceId,
    async cleanup(): Promise<void> {
      await removeDiscoveryFileIfOwned({ discoveryFilePath, runtimeInstanceId });
    },
  };
}

export async function startMemoryV6RuntimeApi(
  options: StartMemoryV6RuntimeApiOptions,
): Promise<MemoryV6RuntimeApiHandle> {
  let storage: MemoryV6Storage | null = null;
  let server: MemoryV6HttpServer | null = null;
  let discoveryFile: PublishedMemoryV6DiscoveryFile | null = null;
  const { runtimeDirectoryPath, discoveryFilePath } = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);

  try {
    await ensureSecureRuntimeDirectory(runtimeDirectoryPath);
    await removeStaleDiscoveryFile(discoveryFilePath);

    const bootstrap = await createOrVerifyV6FreshDatabase(options.userDataPath);
    storage = new MemoryV6Storage(bootstrap.dbPath);
    const service = new MemoryV6Service({ storage });
    const apiSecret = createRuntimeApiSecret();
    const runtimeInstanceId = randomUUID();
    server = createMemoryV6HttpServer({
      service,
      resolvePrincipal: ({ bindingReference }) =>
        options.bindingRegistry?.resolvePrincipal(bindingReference) ?? null,
      apiSecret,
      runtimeInstanceId,
    });
    await server.start();

    const address = server.address();
    if (!address) {
      throw new Error("Memory V6 runtime API did not expose an HTTP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    discoveryFile = await publishMemoryV6DiscoveryFile({
      baseUrl,
      apiSecret,
      runtimeInstanceId,
      runtimeDirectoryPath,
    });

    options.log?.({
      level: "info",
      kind: "memory-v6.runtime-api.started",
      process: "main",
      message: "Memory V6 runtime API started",
      data: {
        published: true,
        addressFamily: "IPv4",
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
        options.bindingRegistry?.revokeAll();
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
