import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  resolveDefaultWithMateMemoryRuntimeDirectory,
  WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_MCP_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryAdapterKind,
  type WithMateMemoryDiscoveryDocument,
  type WithMateMemoryDiscoveryPointer,
} from "../src/memory-v6/memory-discovery.js";
import type { AppLogInput } from "../src/app-log-types.js";
import { createOrVerifyV6FreshDatabase } from "./app-database-v6-bootstrap.js";
import {
  createMemoryV6HttpServer,
  type MemoryV6HttpServer,
  type AgentRuntimeActorSession,
  type AgentRuntimeExtensionRequest,
  type AgentRuntimeExtensionResponse,
} from "./memory-v6-http-server.js";
import type { AgentRuntimeBindingRegistry } from "./agent-runtime-binding.js";
import { createMemoryV6ProjectResolver } from "./memory-v6-project-resolver.js";
import {
  inspectMemoryProtectedObjectInputFile,
  prepareMemoryProtectedObjectFile,
} from "./memory-protected-object-importer.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "./memory-protected-object-exporter.js";
import { MemoryProtectedObjectKeyStore, type MemoryProtectedObjectKeyProtector } from "./memory-protected-object-key-store.js";
import { MemoryProtectedObjectStore } from "./memory-protected-object-store.js";
import { MemoryV6Service } from "./memory-v6-service.js";
import { MemoryV6Storage } from "./memory-v6-storage.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import { CharacterAffectStorage } from "./character-affect-storage.js";
import { createCharacterAffectServiceWithMemory } from "./character-affect-memory-adapter.js";
import { CharacterContextApplicationService } from "./character-context-application-service.js";

export type MemoryV6RuntimeApiHandle = {
  baseUrl: string;
  dbPath: string;
  discoveryFilePath: string;
  mcpDiscoveryFilePath: string;
  characterContextService: CharacterContextApplicationService;
  stop(): Promise<void>;
};

export type StartMemoryV6RuntimeApiOptions = {
  userDataPath: string;
  runtimeDirectoryPath?: string;
  listCharacters?: () => readonly CharacterCatalogEntry[];
  resolveCharacterById?: (id: string) => { id: string; name: string } | null;
  resolveCharacterRuntimeSnapshot?: (characterId: string) => CharacterRuntimeSnapshot | null;
  getMemoryFileQuotaBytes?: () => number;
  protectedObjectKeyProtector?: MemoryProtectedObjectKeyProtector;
  now?: () => Date;
  log?: (input: AppLogInput) => void;
  agentRuntimeBindingRegistry?: Pick<AgentRuntimeBindingRegistry, "resolve">;
  resolveActorSession?: (
    sessionId: string,
  ) => Promise<AgentRuntimeActorSession | null> | AgentRuntimeActorSession | null;
  routeAgentRuntimeExtension?: (
    request: AgentRuntimeExtensionRequest,
  ) => Promise<AgentRuntimeExtensionResponse | null> | AgentRuntimeExtensionResponse | null;
};

export type PublishMemoryV6DiscoveryFileOptions = {
  baseUrl: string;
  apiSecret: string;
  operatorApiSecret: string;
  mcpApiSecret: string;
  runtimeInstanceId?: string;
  runtimeDirectoryPath?: string;
  beforeCleanup?: () => Promise<void>;
  beforePairCommit?: () => Promise<void>;
};

type PublishedMemoryV6DiscoveryFile = {
  discoveryFilePath: string;
  mcpDiscoveryFilePath: string;
  runtimeInstanceId: string;
  cleanup(): Promise<void>;
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

function createRuntimeApiSecret(): string {
  return randomBytes(32).toString("base64url");
}

function resolveRuntimeDiscoveryPaths(runtimeDirectoryPath?: string): {
  runtimeDirectoryPath: string;
  discoveryFilePath: string;
  mcpDiscoveryFilePath: string;
} {
  const resolvedRuntimeDirectoryPath = runtimeDirectoryPath
    ? path.resolve(runtimeDirectoryPath)
    : resolveDefaultWithMateMemoryRuntimeDirectory();
  return {
    runtimeDirectoryPath: resolvedRuntimeDirectoryPath,
    discoveryFilePath: path.join(resolvedRuntimeDirectoryPath, WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME),
    mcpDiscoveryFilePath: path.join(resolvedRuntimeDirectoryPath, WITHMATE_MEMORY_MCP_DISCOVERY_FILE_NAME),
  };
}

type PreparedDiscoveryProjection = {
  adapter: WithMateMemoryAdapterKind;
  generationFilePath: string;
};

async function prepareDiscoveryProjection(input: {
  adapter: WithMateMemoryAdapterKind;
  runtimeDirectoryPath: string;
  runtimeInstanceId: string;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
}): Promise<PreparedDiscoveryProjection> {
  const generationFileName = buildWithMateMemoryDiscoveryGenerationFileName(input.adapter, input.runtimeInstanceId);
  const generationFilePath = path.join(input.runtimeDirectoryPath, generationFileName);
  const document: WithMateMemoryDiscoveryDocument = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
    adapter: input.adapter,
    baseUrl: input.baseUrl,
    apiSecret: input.apiSecret,
    adapterSecret: input.adapterSecret,
    runtimeInstanceId: input.runtimeInstanceId,
    publishedAt: new Date().toISOString(),
  };
  try {
    await writeFileExclusive(generationFilePath, `${JSON.stringify(document)}\n`, 0o600);
    await chmodRuntimePath(generationFilePath, 0o600);
    return {
      adapter: input.adapter,
      generationFilePath,
    };
  } catch (error) {
    await rm(generationFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function prepareDiscoveryPairPointer(
  pointerFilePath: string,
  runtimeInstanceId: string,
): Promise<string> {
  const pointerTemporaryFilePath = `${pointerFilePath}.${runtimeInstanceId}.tmp`;
  const pointer: WithMateMemoryDiscoveryPointer = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
    runtimeInstanceId,
  };
  try {
    await writeFileExclusive(pointerTemporaryFilePath, `${JSON.stringify(pointer)}\n`, 0o600);
    await chmodRuntimePath(pointerTemporaryFilePath, 0o600);
    return pointerTemporaryFilePath;
  } catch (error) {
    await rm(pointerTemporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function cleanupPreparedDiscoveryProjection(projection: PreparedDiscoveryProjection): Promise<void> {
  await rm(projection.generationFilePath, { force: true });
}

export async function publishMemoryV6DiscoveryFile(
  options: PublishMemoryV6DiscoveryFileOptions,
): Promise<PublishedMemoryV6DiscoveryFile> {
  const { runtimeDirectoryPath, discoveryFilePath, mcpDiscoveryFilePath } = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);
  const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
  await ensureSecureRuntimeDirectory(runtimeDirectoryPath);
  const prepared: PreparedDiscoveryProjection[] = [];
  let pointerTemporaryFilePath: string | null = null;
  try {
    prepared.push(await prepareDiscoveryProjection({
      adapter: "cli",
      runtimeDirectoryPath,
      runtimeInstanceId,
      baseUrl: options.baseUrl,
      apiSecret: options.apiSecret,
      adapterSecret: options.operatorApiSecret,
    }));
    prepared.push(await prepareDiscoveryProjection({
      adapter: "mcp",
      runtimeDirectoryPath,
      runtimeInstanceId,
      baseUrl: options.baseUrl,
      apiSecret: options.apiSecret,
      adapterSecret: options.mcpApiSecret,
    }));

    pointerTemporaryFilePath = await prepareDiscoveryPairPointer(discoveryFilePath, runtimeInstanceId);
    await options.beforePairCommit?.();
    await rename(pointerTemporaryFilePath, discoveryFilePath);
    pointerTemporaryFilePath = null;
  } catch (error) {
    await Promise.all([
      ...prepared.map(cleanupPreparedDiscoveryProjection),
      ...(pointerTemporaryFilePath ? [rm(pointerTemporaryFilePath, { force: true })] : []),
    ]);
    throw error;
  }

  const generationFilePaths = prepared.map((projection) => projection.generationFilePath);

  return {
    discoveryFilePath,
    mcpDiscoveryFilePath,
    runtimeInstanceId,
    async cleanup(): Promise<void> {
      await options.beforeCleanup?.();
      await Promise.all(generationFilePaths.map((filePath) => rm(filePath, { force: true })));
    },
  };
}

export async function startMemoryV6RuntimeApi(
  options: StartMemoryV6RuntimeApiOptions,
): Promise<MemoryV6RuntimeApiHandle> {
  let storage: MemoryV6Storage | null = null;
  let affectStorage: CharacterAffectStorage | null = null;
  let server: MemoryV6HttpServer | null = null;
  let discoveryFile: PublishedMemoryV6DiscoveryFile | null = null;
  const { runtimeDirectoryPath } = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);

  try {
    await ensureSecureRuntimeDirectory(runtimeDirectoryPath);

    const bootstrap = await createOrVerifyV6FreshDatabase(options.userDataPath);
    storage = new MemoryV6Storage(bootstrap.dbPath);
    const projectResolver = createMemoryV6ProjectResolver(bootstrap.dbPath);
    const protectedObjectStore = MemoryProtectedObjectStore.fromUserDataPath(options.userDataPath);
    const protectedObjectKeyStore = options.protectedObjectKeyProtector
      ? MemoryProtectedObjectKeyStore.fromUserDataPath(options.userDataPath, options.protectedObjectKeyProtector)
      : null;
    const service = new MemoryV6Service({
      storage,
      ...projectResolver,
      ...(options.listCharacters ? { listCharacters: options.listCharacters } : {}),
      ...(options.resolveCharacterById ? { resolveCharacterById: options.resolveCharacterById } : options.listCharacters ? {
        resolveCharacterById: (id) => {
          const character = options.listCharacters?.().find((candidate) => candidate.id === id);
          return character ? { id: character.id, name: character.name } : null;
        },
      } : {}),
      ...(options.getMemoryFileQuotaBytes ? { getMemoryFileQuotaBytes: options.getMemoryFileQuotaBytes } : {}),
      ...(protectedObjectKeyStore ? {
        protectedObjectImporter: {
          inspect: inspectMemoryProtectedObjectInputFile,
          prepare: (input) => prepareMemoryProtectedObjectFile({
            keyStore: protectedObjectKeyStore,
            objectStore: protectedObjectStore,
          }, input),
          discardPrepared: async ({ objectId }) => {
            await protectedObjectStore.deleteObject(objectId);
          },
        },
        protectedObjectExporter: {
          exportFile: (input) => exportMemoryProtectedObjectFile({
            keyStore: protectedObjectKeyStore,
            objectStore: protectedObjectStore,
          }, input),
          exportFiles: (input) => exportMemoryProtectedObjectFiles({
            keyStore: protectedObjectKeyStore,
            objectStore: protectedObjectStore,
          }, input),
        },
      } : {}),
    });
    affectStorage = new CharacterAffectStorage(bootstrap.dbPath, {
      ...(options.now ? { now: options.now } : {}),
    });
    const affectService = createCharacterAffectServiceWithMemory({
      affectStorage,
      memoryStorage: storage,
      evaluator: { async evaluate() { return []; } },
    });
    const characterContextService = new CharacterContextApplicationService({
      memoryService: service,
      affectService,
      resolveCharacterRuntimeSnapshot: (characterId) =>
        options.resolveCharacterRuntimeSnapshot?.(characterId) ?? null,
      onUnexpectedError: (diagnostic) => {
        options.log?.({
          level: "warn",
          kind: "character-context.application.unexpected-failure",
          process: "main",
          message: diagnostic.safeMessage,
          data: {
            operation: diagnostic.operation,
            transport: diagnostic.transport,
            stage: diagnostic.stage,
            errorName: diagnostic.errorName,
            durationMs: diagnostic.durationMs,
            queryLength: diagnostic.queryLength,
            searchTermCount: diagnostic.searchTermCount,
          },
        });
      },
    });
    const apiSecret = createRuntimeApiSecret();
    const operatorApiSecret = createRuntimeApiSecret();
    const mcpApiSecret = createRuntimeApiSecret();
    const runtimeInstanceId = randomUUID();
    server = createMemoryV6HttpServer({
      service,
      characterContextService,
      apiSecret,
      operatorApiSecret,
      mcpApiSecret,
      runtimeInstanceId,
      agentRuntimeBindingRegistry: options.agentRuntimeBindingRegistry,
      resolveActorSession: options.resolveActorSession,
      routeAgentRuntimeExtension: options.routeAgentRuntimeExtension,
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
      operatorApiSecret,
      mcpApiSecret,
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
      mcpDiscoveryFilePath: discoveryFile.mcpDiscoveryFilePath,
      characterContextService,
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
        affectStorage?.close();

        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Memory V6 runtime API cleanup failed.");
        }
      },
    };
  } catch (error) {
    await discoveryFile?.cleanup().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    storage?.close();
    affectStorage?.close();
    throw error;
  }
}

export { resolveDefaultWithMateMemoryDiscoveryFilePath };
