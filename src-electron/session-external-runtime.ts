import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  SESSION_RUNTIME_DISCOVERY_FILE_NAME,
  SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
  SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  buildSessionRuntimeDiscoveryGenerationFileName,
  resolveDefaultSessionRuntimeDirectory,
  type SessionRuntimeDiscoveryDocument,
  type SessionRuntimeDiscoveryPointer,
} from "../src/session-runtime-discovery.js";
import type { SessionRuntimeAdapterKind } from "../src/session-external-runtime-contract.js";
import {
  createSessionRuntimeHttpServer,
  type SessionRuntimeHttpHandler,
  type SessionRuntimeHttpServer,
} from "./session-runtime-http-server.js";

export type StartSessionExternalRuntimeOptions = {
  handle: SessionRuntimeHttpHandler;
  runtimeDirectoryPath?: string;
};

export type SessionExternalRuntimeHandle = {
  baseUrl: string;
  discoveryFilePath: string;
  runtimeInstanceId: string;
  stop(): Promise<void>;
};

export type PublishSessionRuntimeDiscoveryOptions = {
  baseUrl: string;
  apiSecret: string;
  cliSecret: string;
  mcpSecret: string;
  runtimeInstanceId?: string;
  runtimeDirectoryPath?: string;
  beforeCommit?: () => Promise<void>;
};

export async function startSessionExternalRuntime(
  options: StartSessionExternalRuntimeOptions,
): Promise<SessionExternalRuntimeHandle> {
  const apiSecret = createSecret();
  const cliSecret = createSecret();
  const mcpSecret = createSecret();
  const runtimeInstanceId = randomUUID();
  let server: SessionRuntimeHttpServer | null = null;
  let publication: Awaited<ReturnType<typeof publishSessionRuntimeDiscovery>> | null = null;
  try {
    server = createSessionRuntimeHttpServer({
      apiSecret,
      cliSecret,
      mcpSecret,
      runtimeInstanceId,
      handle: options.handle,
    });
    await server.start();
    const address = server.address();
    if (!address) {
      throw new Error("Session runtime did not expose an HTTP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    publication = await publishSessionRuntimeDiscovery({
      baseUrl,
      apiSecret,
      cliSecret,
      mcpSecret,
      runtimeInstanceId,
      ...(options.runtimeDirectoryPath ? { runtimeDirectoryPath: options.runtimeDirectoryPath } : {}),
    });
    return {
      baseUrl,
      discoveryFilePath: publication.discoveryFilePath,
      runtimeInstanceId,
      async stop(): Promise<void> {
        const errors: unknown[] = [];
        await publication?.cleanup().catch((error) => errors.push(error));
        await server?.stop().catch((error) => errors.push(error));
        if (errors.length > 0) {
          throw new AggregateError(errors, "Session runtime cleanup failed.");
        }
      },
    };
  } catch (error) {
    await publication?.cleanup().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    throw error;
  }
}

export async function publishSessionRuntimeDiscovery(options: PublishSessionRuntimeDiscoveryOptions): Promise<{
  discoveryFilePath: string;
  runtimeInstanceId: string;
  cleanup(): Promise<void>;
}> {
  const runtimeDirectoryPath = path.resolve(options.runtimeDirectoryPath ?? resolveDefaultSessionRuntimeDirectory());
  const discoveryFilePath = path.join(runtimeDirectoryPath, SESSION_RUNTIME_DISCOVERY_FILE_NAME);
  const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  await ensureSecureRuntimeDirectory(runtimeDirectoryPath);
  const generationFilePaths: string[] = [];
  let pointerTemporaryFilePath: string | null = null;
  try {
    for (const adapter of ["cli", "mcp"] as const) {
      const generationFilePath = path.join(
        runtimeDirectoryPath,
        buildSessionRuntimeDiscoveryGenerationFileName(adapter, runtimeInstanceId),
      );
      const document: SessionRuntimeDiscoveryDocument = {
        schemaVersion: SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
        adapter,
        baseUrl: options.baseUrl,
        apiSecret: options.apiSecret,
        adapterSecret: adapter === "cli" ? options.cliSecret : options.mcpSecret,
        runtimeInstanceId,
        publishedAt: new Date().toISOString(),
      };
      await writeExclusive(generationFilePath, `${JSON.stringify(document)}\n`);
      generationFilePaths.push(generationFilePath);
    }
    pointerTemporaryFilePath = `${discoveryFilePath}.${runtimeInstanceId}.tmp`;
    const pointer: SessionRuntimeDiscoveryPointer = {
      schemaVersion: SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
      runtimeInstanceId,
    };
    await writeExclusive(pointerTemporaryFilePath, `${JSON.stringify(pointer)}\n`);
    await options.beforeCommit?.();
    await rename(pointerTemporaryFilePath, discoveryFilePath);
    pointerTemporaryFilePath = null;
  } catch (error) {
    await Promise.all([
      ...generationFilePaths.map((filePath) => rm(filePath, { force: true })),
      ...(pointerTemporaryFilePath ? [rm(pointerTemporaryFilePath, { force: true })] : []),
    ]);
    throw error;
  }
  return {
    discoveryFilePath,
    runtimeInstanceId,
    async cleanup(): Promise<void> {
      await Promise.all(generationFilePaths.map((filePath) => rm(filePath, { force: true })));
    },
  };
}

export function resolveSessionRuntimeGenerationFilePath(
  discoveryFilePath: string,
  adapter: SessionRuntimeAdapterKind,
  runtimeInstanceId: string,
): string {
  return path.join(path.dirname(discoveryFilePath), buildSessionRuntimeDiscoveryGenerationFileName(adapter, runtimeInstanceId));
}

async function ensureSecureRuntimeDirectory(runtimeDirectoryPath: string): Promise<void> {
  await mkdir(runtimeDirectoryPath, { recursive: true, mode: 0o700 });
  const stats = await lstat(runtimeDirectoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Session runtime directory must be a real directory.");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new Error("Session runtime directory must be owned by the current user.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await chmod(runtimeDirectoryPath, 0o700);
  }
  const verified = await lstat(runtimeDirectoryPath);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("Session runtime directory must remain a real directory.");
  }
  if (currentUid !== null && verified.uid !== currentUid) {
    throw new Error("Session runtime directory owner changed during setup.");
  }
  if (process.platform !== "win32" && (verified.mode & 0o077) !== 0) {
    throw new Error("Session runtime directory permissions are too broad.");
  }
}

async function writeExclusive(filePath: string, content: string): Promise<void> {
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}

function createSecret(): string {
  return randomBytes(32).toString("base64url");
}
