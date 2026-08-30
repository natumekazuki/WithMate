import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as properLockfile from "proper-lockfile";

import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  resolveDefaultWithMateMemoryRuntimeDirectory,
  WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_MCP_DISCOVERY_FILE_NAME,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  normalizeWithMateMemoryApiBaseUrl,
  type WithMateMemoryAdapterKind,
  type WithMateMemoryDiscoveryDocument,
  type WithMateMemoryDiscoveryPointer,
} from "../src/memory-v6/memory-discovery.js";
import {
  createWithMateMemoryRuntimeOwnerChallenge,
} from "../src/memory-v6/memory-runtime-exchange.js";
import {
  isUuid,
  getRuntimeDiscoveryLeaseState,
  normalizeRuntimeDiscoveryRegistryLimits,
  SYSTEM_RUNTIME_DISCOVERY_CLOCK,
  type RuntimeBuildChannel,
  type RuntimeDiscoveryClock,
  type RuntimeDiscoveryCredentialEnvelope,
  type RuntimeDiscoveryRegistryEntry,
  type RuntimeDiscoveryRegistryLimits,
  type RuntimeDiscoveryTimers,
} from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  publishRuntimeDiscoveryEntry,
  readRuntimeDiscoveryCredential,
  withRuntimeDiscoveryRegistryMutationLock,
  type RuntimeDiscoveryRegistryRecord,
  type RuntimeDiscoveryRegistryPublication,
  type RuntimePathSecurity,
  type RuntimePathTargetKind,
} from "../src/runtime-discovery/runtime-discovery-registry.js";
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
import { secureWindowsRuntimePath } from "./runtime-path-security.js";

export type MemoryV6RuntimeApiHandle = {
  baseUrl: string;
  dbPath: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  buildChannel: RuntimeBuildChannel;
  discoveryPublished: boolean;
  /** @deprecated Compatibility path for the legacy current-pointer projection. */
  discoveryFilePath: string;
  /** @deprecated Compatibility path for the legacy current-pointer projection. */
  mcpDiscoveryFilePath: string;
  characterContextService: CharacterContextApplicationService;
  stop(): Promise<void>;
};

export type StartMemoryV6RuntimeApiOptions = {
  userDataPath: string;
  applicationInstanceId: string;
  buildChannel: RuntimeBuildChannel;
  processStartedAt?: string;
  registryDirectoryPath?: string;
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
  runtimeDiscoveryClock?: RuntimeDiscoveryClock;
  runtimeDiscoveryTimers?: RuntimeDiscoveryTimers;
  runtimeDiscoveryLimits?: Partial<RuntimeDiscoveryRegistryLimits>;
  runtimePathSecurity?: RuntimePathSecurity;
  fetch?: typeof fetch;
  /** Test-only barrier after registry validation while the mutation lock is held. */
  beforeLegacyPointerCommit?: () => Promise<void>;
  /** Test-only observation point after legacy pointer commit and before lock release. */
  beforeLegacyPointerLockRelease?: () => Promise<void>;
  /** Test-only failure injection after both legacy generation documents are prepared. */
  beforeLegacyPairCommit?: () => Promise<void>;
  /** Test-only barrier before failed legacy projection cleanup acquires mutation locks. */
  beforeFailedLegacyProjectionCleanup?: () => Promise<void>;
  /** Test-only barrier after replacement validation while the registry lock is held. */
  beforeLegacyPointerHandoffLock?: () => Promise<void>;
  /** Test-only observation point immediately before registry entry publication. */
  beforeRuntimeRegistryPublicationCommit?: () => Promise<void>;
  /** Test-only observation point immediately before waiting for registry publication. */
  beforeRuntimeRegistryPublicationLock?: () => Promise<void>;
  /** Test-only barrier while publication rollback still owns the registry lock. */
  beforeRuntimeRegistryPublicationRollback?: () => Promise<void>;
};

export type PublishMemoryV6DiscoveryFileOptions = {
  baseUrl: string;
  apiSecret: string;
  operatorApiSecret: string;
  mcpApiSecret: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  buildChannel?: RuntimeBuildChannel;
  /** @deprecated This value has runtime-generation semantics. */
  runtimeInstanceId?: string;
  runtimeDirectoryPath?: string;
  pathSecurity?: RuntimePathSecurity;
  beforeCleanup?: () => Promise<void>;
  beforePairCommit?: () => Promise<void>;
  beforeFailedProjectionCleanup?: () => Promise<void>;
  cleanupFailedProjection?: (operation: () => Promise<void>) => Promise<void>;
  resolvePointerCommit?: () => Promise<LegacyPointerPublishDecision>;
};

type PublishedMemoryV6DiscoveryFile = {
  discoveryFilePath: string;
  mcpDiscoveryFilePath: string;
  pointerPublished: boolean;
  applicationInstanceId?: string;
  runtimeGenerationId: string;
  /** @deprecated This value has runtime-generation semantics. */
  runtimeInstanceId: string;
  cleanup(replacement?: LegacyPointerReplacement): Promise<void>;
};

type LegacyPointerReplacement = {
  runtimeGenerationId: string;
  commit: (operation: () => Promise<void>) => Promise<boolean>;
};

type ResolvedLegacyPointerReplacement = {
  replacement: RuntimeDiscoveryRegistryRecord;
  observedMemoryPublications: readonly string[];
};

type LegacyPointerPublishDecision = {
  runtimeGenerationId: string | null;
  commit: (operation: () => Promise<void>) => Promise<boolean>;
};

export const WITHMATE_MEMORY_LEGACY_GENERATION_MAX_FILES = 128;

const LEGACY_GENERATION_FILE_PATTERN = /^memory-v6-(cli|mcp)\.([0-9a-f]{64})\.json$/;
const LEGACY_POINTER_LOCK_FILE_NAME = ".memory-v6-legacy-pointer.lock";
const LEGACY_POINTER_LOCK_STALE_MS = 20_000;

export type MaintainMemoryV6LegacyDiscoveryArtifactsOptions = {
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  currentRuntimeGenerationId?: string;
  clock?: RuntimeDiscoveryClock;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  fetch?: typeof fetch;
  requiredCapacity?: number;
  maxGenerationFiles?: number;
};

export type MaintainMemoryV6LegacyDiscoveryArtifactsResult = {
  removedFileCount: number;
  remainingFileCount: number;
  capacityAvailable: boolean;
};

type LegacyGenerationArtifact = {
  adapter: WithMateMemoryAdapterKind;
  digest: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  dev: number;
  ino: number;
};

async function cleanupLegacyDiscoveryProjection(
  projection: PublishedMemoryV6DiscoveryFile | null,
  input: {
    runtimeDirectoryPath: string;
    runtimeGenerationId: string;
    security: RuntimePathSecurity;
    replacement?: LegacyPointerReplacement;
  },
): Promise<void> {
  if (projection) {
    await projection.cleanup(input.replacement);
    return;
  }
  await cleanupMemoryV6LegacyDiscoveryGeneration(input);
}

async function withLegacyPointerLock<T>(
  runtimeDirectoryPath: string,
  operation: () => Promise<T>,
  beforeRelease?: () => Promise<void>,
): Promise<T> {
  const release = await properLockfile.lock(runtimeDirectoryPath, {
    realpath: false,
    lockfilePath: path.join(runtimeDirectoryPath, LEGACY_POINTER_LOCK_FILE_NAME),
    stale: LEGACY_POINTER_LOCK_STALE_MS,
    update: LEGACY_POINTER_LOCK_STALE_MS / 4,
    retries: {
      retries: 500,
      factor: 1,
      minTimeout: 50,
      maxTimeout: 50,
    },
  });
  try {
    const result = await operation();
    await beforeRelease?.();
    return result;
  } finally {
    await release();
  }
}

async function commitLegacyPointerMutation(input: {
  runtimeDirectoryPath: string;
  expectedRuntimeGenerationId: string | null;
  commit: (operation: () => Promise<void>) => Promise<boolean>;
  operation: () => Promise<void>;
}): Promise<boolean> {
  try {
    return await input.commit(input.operation);
  } catch (error) {
    const committedRuntimeGenerationId = await readCurrentLegacyRuntimeGenerationId(
      input.runtimeDirectoryPath,
    ).catch(() => undefined);
    if (committedRuntimeGenerationId !== input.expectedRuntimeGenerationId) {
      throw error;
    }
    return true;
  }
}

async function chmodRuntimePath(filePath: string, mode: number): Promise<void> {
  await chmod(filePath, mode);
}

async function securePosixRuntimePath(
  targetPath: string,
  targetKind: RuntimePathTargetKind,
): Promise<void> {
  const expectedMode = targetKind === "directory" ? 0o700 : 0o600;
  const stats = await lstat(targetPath);
  const expectedType = targetKind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!expectedType || stats.isSymbolicLink()) {
    throw new Error(`Memory V6 runtime ${targetKind} must be a real ${targetKind}.`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new Error(`Memory V6 runtime ${targetKind} must be owned by the current OS user.`);
  }
  if ((stats.mode & 0o777) !== expectedMode) {
    await chmodRuntimePath(targetPath, expectedMode);
  }

  const verified = await lstat(targetPath);
  const verifiedType = targetKind === "directory" ? verified.isDirectory() : verified.isFile();
  if (!verifiedType || verified.isSymbolicLink()) {
    throw new Error(`Memory V6 runtime ${targetKind} changed during setup.`);
  }
  if (currentUid !== null && verified.uid !== currentUid) {
    throw new Error(`Memory V6 runtime ${targetKind} owner changed during setup.`);
  }
  if ((verified.mode & 0o777) !== expectedMode) {
    throw new Error(`Memory V6 runtime ${targetKind} permissions are too broad.`);
  }
}

async function secureRuntimePath(
  targetPath: string,
  targetKind: RuntimePathTargetKind,
): Promise<void> {
  if (process.platform === "win32") {
    await secureWindowsRuntimePath(targetPath, targetKind);
    return;
  }
  await securePosixRuntimePath(targetPath, targetKind);
}

async function ensureSecureRuntimeDirectory(
  runtimeDirectoryPath: string,
  security: RuntimePathSecurity = secureRuntimePath,
): Promise<void> {
  await mkdir(runtimeDirectoryPath, { recursive: true, mode: 0o700 });

  const stats = await lstat(runtimeDirectoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Memory V6 runtime directory must be a real directory.");
  }

  await security(runtimeDirectoryPath, "directory");
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

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function legacyGenerationDigest(runtimeGenerationId: string): string {
  const fileName = buildWithMateMemoryDiscoveryGenerationFileName("cli", runtimeGenerationId);
  const match = LEGACY_GENERATION_FILE_PATTERN.exec(fileName);
  if (!match) {
    throw new Error("Unable to derive a legacy Memory generation digest.");
  }
  return match[2];
}

async function readCurrentLegacyRuntimeGenerationId(runtimeDirectoryPath: string): Promise<string | null> {
  const pointerPath = path.join(runtimeDirectoryPath, WITHMATE_MEMORY_CLI_DISCOVERY_FILE_NAME);
  try {
    const stats = await lstat(pointerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return null;
    }
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Partial<WithMateMemoryDiscoveryPointer>;
    if (pointer.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION
      || typeof pointer.runtimeInstanceId !== "string"
      || !pointer.runtimeInstanceId) {
      return null;
    }
    return pointer.runtimeInstanceId;
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function readCurrentLegacyGenerationDigest(runtimeDirectoryPath: string): Promise<string | null> {
  const runtimeGenerationId = await readCurrentLegacyRuntimeGenerationId(runtimeDirectoryPath);
  return runtimeGenerationId ? legacyGenerationDigest(runtimeGenerationId) : null;
}

async function listLegacyGenerationArtifacts(
  runtimeDirectoryPath: string,
): Promise<LegacyGenerationArtifact[]> {
  let names: string[];
  try {
    names = await readdir(runtimeDirectoryPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
  const artifacts: LegacyGenerationArtifact[] = [];
  for (const name of names) {
    const match = LEGACY_GENERATION_FILE_PATTERN.exec(name);
    if (!match) {
      continue;
    }
    const filePath = path.join(runtimeDirectoryPath, name);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      continue;
    }
    artifacts.push({
      adapter: match[1] as WithMateMemoryAdapterKind,
      digest: match[2],
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      dev: stats.dev,
      ino: stats.ino,
    });
  }
  return artifacts;
}

async function countLegacyGenerationArtifactNames(runtimeDirectoryPath: string): Promise<number> {
  try {
    return (await readdir(runtimeDirectoryPath))
      .filter((name) => LEGACY_GENERATION_FILE_PATTERN.test(name))
      .length;
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }
    throw error;
  }
}

async function challengeLegacyMemoryGenerationArtifact(
  artifact: LegacyGenerationArtifact,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  let credential: Partial<WithMateMemoryDiscoveryDocument>;
  try {
    credential = JSON.parse(await readFile(artifact.filePath, "utf8")) as Partial<WithMateMemoryDiscoveryDocument>;
  } catch {
    return false;
  }
  const runtimeGenerationId = credential.runtimeGenerationId ?? credential.runtimeInstanceId;
  const baseUrl = typeof credential.baseUrl === "string"
    ? normalizeWithMateMemoryApiBaseUrl(credential.baseUrl)
    : null;
  if (credential.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
    || credential.adapter !== artifact.adapter
    || typeof runtimeGenerationId !== "string"
    || !runtimeGenerationId
    || legacyGenerationDigest(runtimeGenerationId) !== artifact.digest
    || typeof credential.apiSecret !== "string"
    || !credential.apiSecret
    || !baseUrl
    || (credential.applicationInstanceId !== undefined
      && (typeof credential.applicationInstanceId !== "string"
        || credential.runtimeGenerationId !== runtimeGenerationId))) {
    return false;
  }

  const nonce = randomBytes(16).toString("base64url");
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 1_000);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
      method: "GET",
      redirect: "error",
      signal: abortController.signal,
    });
    if (!response.ok) {
      return false;
    }
    const status = await response.json() as {
      applicationInstanceId?: unknown;
      runtimeGenerationId?: unknown;
      runtimeInstanceId?: unknown;
      challenge?: {
        nonce?: unknown;
        hmacSha256?: unknown;
        ownerHmacSha256?: unknown;
      };
    };
    if (status.runtimeInstanceId !== runtimeGenerationId || status.challenge?.nonce !== nonce) {
      return false;
    }
    if (credential.applicationInstanceId !== undefined) {
      if (status.applicationInstanceId !== credential.applicationInstanceId
        || status.runtimeGenerationId !== runtimeGenerationId
        || typeof status.challenge.ownerHmacSha256 !== "string") {
        return false;
      }
      return safeStringEquals(
        status.challenge.ownerHmacSha256,
        createWithMateMemoryRuntimeOwnerChallenge(
          credential.apiSecret,
          credential.applicationInstanceId,
          runtimeGenerationId,
          nonce,
        ),
      );
    }
    if (typeof status.challenge?.hmacSha256 !== "string") {
      return false;
    }
    return safeStringEquals(
      status.challenge.hmacSha256,
      createHmac("sha256", credential.apiSecret).update(nonce, "utf8").digest("base64url"),
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function removeUnchangedLegacyArtifact(artifact: LegacyGenerationArtifact): Promise<boolean> {
  try {
    const stats = await lstat(artifact.filePath);
    if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.mtimeMs !== artifact.mtimeMs
      || stats.size !== artifact.size
      || stats.dev !== artifact.dev
      || stats.ino !== artifact.ino) {
      return false;
    }
    await rm(artifact.filePath, { force: false });
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function maintainMemoryV6LegacyDiscoveryArtifacts(
  options: MaintainMemoryV6LegacyDiscoveryArtifactsOptions,
): Promise<MaintainMemoryV6LegacyDiscoveryArtifactsResult> {
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const limits = normalizeRuntimeDiscoveryRegistryLimits(options.limits);
  const fetchImpl = options.fetch ?? fetch;
  const maxGenerationFiles = options.maxGenerationFiles ?? WITHMATE_MEMORY_LEGACY_GENERATION_MAX_FILES;
  const requiredCapacity = options.requiredCapacity ?? 0;
  if (!Number.isSafeInteger(maxGenerationFiles)
    || maxGenerationFiles <= 0
    || maxGenerationFiles > WITHMATE_MEMORY_LEGACY_GENERATION_MAX_FILES
    || !Number.isSafeInteger(requiredCapacity)
    || requiredCapacity < 0
    || requiredCapacity > maxGenerationFiles) {
    throw new Error("Invalid legacy Memory generation capacity configuration.");
  }

  const protectedDigests = new Set<string>();
  if (options.currentRuntimeGenerationId) {
    protectedDigests.add(legacyGenerationDigest(options.currentRuntimeGenerationId));
  }
  const pointerDigest = await readCurrentLegacyGenerationDigest(options.runtimeDirectoryPath);
  if (pointerDigest) {
    protectedDigests.add(pointerDigest);
  }

  const registrySnapshot = await listRuntimeDiscoveryRegistryEntries(
    options.registryDirectoryPath,
    limits,
  );
  for (const record of registrySnapshot.records) {
    if (record.entry.runtimeKind !== "memory") {
      continue;
    }
    const registryRuntimeActive = getRuntimeDiscoveryLeaseState(
      record.entry,
      clock.now(),
      limits.staleThresholdMs,
    ) === "fresh" || await challengeMemoryRuntimeRegistryEntry(
      record.entry,
      record.slotDirectoryPath,
      fetchImpl,
    );
    if (registryRuntimeActive) {
      protectedDigests.add(legacyGenerationDigest(record.entry.runtimeGenerationId));
    }
  }

  const artifacts = await listLegacyGenerationArtifacts(options.runtimeDirectoryPath);
  const groups = new Map<string, LegacyGenerationArtifact[]>();
  for (const artifact of artifacts) {
    const group = groups.get(artifact.digest) ?? [];
    group.push(artifact);
    groups.set(artifact.digest, group);
  }
  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const leftNewest = Math.max(...left[1].map((artifact) => artifact.mtimeMs));
    const rightNewest = Math.max(...right[1].map((artifact) => artifact.mtimeMs));
    return leftNewest - rightNewest;
  });
  let removedFileCount = 0;
  let occupiedFileCount = await countLegacyGenerationArtifactNames(options.runtimeDirectoryPath);

  const cleanupEligibleGroups = async (minimumAgeMs: number, stopWhenCapacityAvailable: boolean): Promise<void> => {
    for (const [digest, group] of orderedGroups) {
      if (stopWhenCapacityAvailable && occupiedFileCount + requiredCapacity <= maxGenerationFiles) {
        return;
      }
      if (protectedDigests.has(digest)) {
        continue;
      }
      const newestMtimeMs = Math.max(...group.map((artifact) => artifact.mtimeMs));
      if (clock.now().getTime() - newestMtimeMs < minimumAgeMs) {
        continue;
      }
      const currentDigestBeforeDelete = await readCurrentLegacyGenerationDigest(options.runtimeDirectoryPath);
      if (currentDigestBeforeDelete === digest) {
        protectedDigests.add(digest);
        continue;
      }
      const currentRegistry = await listRuntimeDiscoveryRegistryEntries(options.registryDirectoryPath, limits);
      if (currentRegistry.records.some((record) => (
        record.entry.runtimeKind === "memory"
        && legacyGenerationDigest(record.entry.runtimeGenerationId) === digest
      ))) {
        protectedDigests.add(digest);
        continue;
      }
      let activeBeforeDelete = false;
      for (const artifact of group) {
        if (await challengeLegacyMemoryGenerationArtifact(artifact, fetchImpl)) {
          activeBeforeDelete = true;
          break;
        }
      }
      if (activeBeforeDelete) {
        protectedDigests.add(digest);
        continue;
      }
      for (const artifact of group) {
        if (await removeUnchangedLegacyArtifact(artifact)) {
          removedFileCount += 1;
        }
      }
      occupiedFileCount = await countLegacyGenerationArtifactNames(options.runtimeDirectoryPath);
    }
  };

  await cleanupEligibleGroups(limits.retentionMs, false);
  if (occupiedFileCount + requiredCapacity > maxGenerationFiles) {
    await cleanupEligibleGroups(limits.capacityCleanupGraceMs, true);
  }
  occupiedFileCount = await countLegacyGenerationArtifactNames(options.runtimeDirectoryPath);
  return {
    removedFileCount,
    remainingFileCount: occupiedFileCount,
    capacityAvailable: occupiedFileCount + requiredCapacity <= maxGenerationFiles,
  };
}

type PreparedDiscoveryProjection = {
  adapter: WithMateMemoryAdapterKind;
  generationFilePath: string;
};

async function prepareDiscoveryProjection(input: {
  adapter: WithMateMemoryAdapterKind;
  runtimeDirectoryPath: string;
  applicationInstanceId?: string;
  runtimeGenerationId: string;
  buildChannel?: RuntimeBuildChannel;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  security: RuntimePathSecurity;
}): Promise<PreparedDiscoveryProjection> {
  const generationFileName = buildWithMateMemoryDiscoveryGenerationFileName(input.adapter, input.runtimeGenerationId);
  const generationFilePath = path.join(input.runtimeDirectoryPath, generationFileName);
  const document: WithMateMemoryDiscoveryDocument = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
    adapter: input.adapter,
    baseUrl: input.baseUrl,
    apiSecret: input.apiSecret,
    adapterSecret: input.adapterSecret,
    ...(input.applicationInstanceId ? { applicationInstanceId: input.applicationInstanceId } : {}),
    runtimeGenerationId: input.runtimeGenerationId,
    ...(input.buildChannel ? { buildChannel: input.buildChannel } : {}),
    runtimeInstanceId: input.runtimeGenerationId,
    publishedAt: new Date().toISOString(),
  };
  try {
    await writeFileExclusive(generationFilePath, `${JSON.stringify(document)}\n`, 0o600);
    await input.security(generationFilePath, "file");
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
  runtimeGenerationId: string,
  security: RuntimePathSecurity,
): Promise<string> {
  const pointerTemporaryFilePath = `${pointerFilePath}.${randomUUID()}.tmp`;
  const pointer: WithMateMemoryDiscoveryPointer = {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
    runtimeInstanceId: runtimeGenerationId,
  };
  try {
    await writeFileExclusive(pointerTemporaryFilePath, `${JSON.stringify(pointer)}\n`, 0o600);
    await security(pointerTemporaryFilePath, "file");
    return pointerTemporaryFilePath;
  } catch (error) {
    await rm(pointerTemporaryFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function cleanupPreparedDiscoveryProjection(projection: PreparedDiscoveryProjection): Promise<void> {
  await rm(projection.generationFilePath, { force: true });
}

async function cleanupMemoryV6LegacyDiscoveryGeneration(input: {
  runtimeDirectoryPath: string;
  runtimeGenerationId: string;
  security: RuntimePathSecurity;
  replacement?: LegacyPointerReplacement;
  generationFilePaths?: readonly string[];
}): Promise<void> {
  const { discoveryFilePath } = resolveRuntimeDiscoveryPaths(input.runtimeDirectoryPath);
  const generationFilePaths = input.generationFilePaths ?? (["cli", "mcp"] as const).map(
    (adapter) => path.join(
      input.runtimeDirectoryPath,
      buildWithMateMemoryDiscoveryGenerationFileName(adapter, input.runtimeGenerationId),
    ),
  );
  let replacementPointerTemporaryFilePath: string | null = null;
  if (input.replacement) {
    replacementPointerTemporaryFilePath = await prepareDiscoveryPairPointer(
      discoveryFilePath,
      input.replacement.runtimeGenerationId,
      input.security,
    );
  }
  try {
    const commitCleanup = async () => {
      const currentRuntimeGenerationId = await readCurrentLegacyRuntimeGenerationId(
        input.runtimeDirectoryPath,
      );
      if (currentRuntimeGenerationId !== null
        && currentRuntimeGenerationId !== input.runtimeGenerationId) {
        return;
      }
      if (replacementPointerTemporaryFilePath) {
        await rename(replacementPointerTemporaryFilePath, discoveryFilePath);
        replacementPointerTemporaryFilePath = null;
      } else if (currentRuntimeGenerationId === input.runtimeGenerationId) {
        await rm(discoveryFilePath, { force: true });
      }
      if (await readCurrentLegacyRuntimeGenerationId(input.runtimeDirectoryPath)
        === input.runtimeGenerationId) {
        throw new Error("Legacy Memory discovery pointer cleanup did not commit.");
      }
    };
    const expectedRuntimeGenerationId = input.replacement?.runtimeGenerationId ?? null;
    if (input.replacement) {
      await commitLegacyPointerMutation({
        runtimeDirectoryPath: input.runtimeDirectoryPath,
        expectedRuntimeGenerationId,
        commit: input.replacement.commit,
        operation: commitCleanup,
      });
    } else {
      await commitLegacyPointerMutation({
        runtimeDirectoryPath: input.runtimeDirectoryPath,
        expectedRuntimeGenerationId,
        commit: async (operation) => {
          await withLegacyPointerLock(input.runtimeDirectoryPath, operation);
          return true;
        },
        operation: commitCleanup,
      });
    }
  } finally {
    if (replacementPointerTemporaryFilePath) {
      await rm(replacementPointerTemporaryFilePath, { force: true }).catch(() => undefined);
    }
  }
  if (await readCurrentLegacyRuntimeGenerationId(input.runtimeDirectoryPath)
    === input.runtimeGenerationId) {
    throw new Error("Legacy Memory discovery generation is still referenced by the current pointer.");
  }
  await Promise.all(generationFilePaths.map((filePath) => rm(filePath, { force: true })));
}

export async function publishMemoryV6DiscoveryFile(
  options: PublishMemoryV6DiscoveryFileOptions,
): Promise<PublishedMemoryV6DiscoveryFile> {
  const { runtimeDirectoryPath, discoveryFilePath, mcpDiscoveryFilePath } = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);
  const runtimeGenerationId = options.runtimeGenerationId ?? options.runtimeInstanceId ?? randomUUID();
  const security = options.pathSecurity ?? secureRuntimePath;
  await ensureSecureRuntimeDirectory(runtimeDirectoryPath, security);
  const prepared: PreparedDiscoveryProjection[] = [];
  let pointerTemporaryFilePath: string | null = null;
  let pointerPublished = false;
  try {
    prepared.push(await prepareDiscoveryProjection({
      adapter: "cli",
      runtimeDirectoryPath,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      buildChannel: options.buildChannel,
      baseUrl: options.baseUrl,
      apiSecret: options.apiSecret,
      adapterSecret: options.operatorApiSecret,
      security,
    }));
    prepared.push(await prepareDiscoveryProjection({
      adapter: "mcp",
      runtimeDirectoryPath,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      buildChannel: options.buildChannel,
      baseUrl: options.baseUrl,
      apiSecret: options.apiSecret,
      adapterSecret: options.mcpApiSecret,
      security,
    }));

    pointerTemporaryFilePath = await prepareDiscoveryPairPointer(discoveryFilePath, runtimeGenerationId, security);
    await options.beforePairCommit?.();
    if (options.resolvePointerCommit) {
      let committed = false;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        const decision = await options.resolvePointerCommit();
        committed = await commitLegacyPointerMutation({
          runtimeDirectoryPath,
          expectedRuntimeGenerationId: decision.runtimeGenerationId,
          commit: decision.commit,
          operation: async () => {
            if (decision.runtimeGenerationId === runtimeGenerationId) {
              await rename(pointerTemporaryFilePath!, discoveryFilePath);
              pointerTemporaryFilePath = null;
              pointerPublished = true;
            } else {
              await rm(discoveryFilePath, { force: true });
              pointerPublished = false;
            }
          },
        });
      }
    } else {
      await commitLegacyPointerMutation({
        runtimeDirectoryPath,
        expectedRuntimeGenerationId: runtimeGenerationId,
        commit: async (operation) => {
          await withLegacyPointerLock(runtimeDirectoryPath, operation);
          return true;
        },
        operation: async () => {
          await rename(pointerTemporaryFilePath!, discoveryFilePath);
          pointerTemporaryFilePath = null;
          pointerPublished = true;
        },
      });
    }
    if (pointerTemporaryFilePath) {
      await rm(pointerTemporaryFilePath, { force: true });
      pointerTemporaryFilePath = null;
    }
  } catch (error) {
    if (prepared.length > 0) {
      await options.beforeFailedProjectionCleanup?.();
      const cleanupPreparedPair = async () => {
        if (await readCurrentLegacyRuntimeGenerationId(runtimeDirectoryPath) === runtimeGenerationId) {
          return;
        }
        await Promise.all(prepared.map(cleanupPreparedDiscoveryProjection));
      };
      if (options.cleanupFailedProjection) {
        await options.cleanupFailedProjection(cleanupPreparedPair);
      } else {
        await withLegacyPointerLock(runtimeDirectoryPath, cleanupPreparedPair);
      }
    }
    if (pointerTemporaryFilePath) {
      await rm(pointerTemporaryFilePath, { force: true });
    }
    throw error;
  }

  const generationFilePaths = prepared.map((projection) => projection.generationFilePath);

  return {
    discoveryFilePath,
    mcpDiscoveryFilePath,
    pointerPublished,
    ...(options.applicationInstanceId ? { applicationInstanceId: options.applicationInstanceId } : {}),
    runtimeGenerationId,
    runtimeInstanceId: runtimeGenerationId,
    async cleanup(replacement?: LegacyPointerReplacement): Promise<void> {
      await options.beforeCleanup?.();
      await cleanupMemoryV6LegacyDiscoveryGeneration({
        runtimeDirectoryPath,
        runtimeGenerationId,
        security,
        ...(replacement ? { replacement } : {}),
        generationFilePaths,
      });
    },
  };
}

function buildMemoryDiscoveryDocument(input: {
  adapter: WithMateMemoryAdapterKind;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  buildChannel: RuntimeBuildChannel;
  publishedAt: string;
}): WithMateMemoryDiscoveryDocument {
  return {
    schemaVersion: WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
    adapter: input.adapter,
    baseUrl: input.baseUrl,
    apiSecret: input.apiSecret,
    adapterSecret: input.adapterSecret,
    applicationInstanceId: input.applicationInstanceId,
    runtimeGenerationId: input.runtimeGenerationId,
    buildChannel: input.buildChannel,
    // The legacy wire field is a generation identifier, not an application identity.
    runtimeInstanceId: input.runtimeGenerationId,
    publishedAt: input.publishedAt,
  };
}

function safeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function challengeMemoryRuntimeRegistryEntry(
  entry: RuntimeDiscoveryRegistryEntry,
  slotDirectoryPath: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  if (entry.runtimeKind !== "memory") {
    // An adapter must never reap another runtime kind that it cannot authenticate.
    return true;
  }

  const record = {
    slotName: path.basename(slotDirectoryPath),
    entry,
    slotDirectoryPath,
  };
  let adapterKind: WithMateMemoryAdapterKind = "cli";
  let rawCredential = await readRuntimeDiscoveryCredential(record, adapterKind);
  if (!rawCredential) {
    adapterKind = "mcp";
    rawCredential = await readRuntimeDiscoveryCredential(record, adapterKind);
  }
  if (!rawCredential) {
    return false;
  }

  let envelope: Partial<RuntimeDiscoveryCredentialEnvelope<WithMateMemoryDiscoveryDocument>>;
  try {
    envelope = JSON.parse(rawCredential) as Partial<RuntimeDiscoveryCredentialEnvelope<WithMateMemoryDiscoveryDocument>>;
  } catch {
    return false;
  }
  const credential = envelope.credential;
  if (envelope.schemaVersion !== "withmate-runtime-credential-v1"
    || envelope.applicationInstanceId !== entry.applicationInstanceId
    || envelope.runtimeKind !== "memory"
    || envelope.adapterKind !== adapterKind
    || envelope.runtimeGenerationId !== entry.runtimeGenerationId
    || !credential
    || credential.adapter !== adapterKind) {
    return false;
  }
  const baseUrl = typeof credential.baseUrl === "string"
    ? normalizeWithMateMemoryApiBaseUrl(credential.baseUrl)
    : null;
  if (!baseUrl
    || typeof credential.apiSecret !== "string"
    || credential.applicationInstanceId !== entry.applicationInstanceId
    || credential.runtimeGenerationId !== entry.runtimeGenerationId
    || credential.runtimeInstanceId !== entry.runtimeGenerationId) {
    return false;
  }

  const nonce = randomBytes(16).toString("base64url");
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 1_000);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
      method: "GET",
      redirect: "error",
      signal: abortController.signal,
    });
    if (!response.ok) {
      return false;
    }
    const status = await response.json() as {
      applicationInstanceId?: unknown;
      runtimeGenerationId?: unknown;
      challenge?: {
        nonce?: unknown;
        ownerHmacSha256?: unknown;
      };
    };
    if (status.applicationInstanceId !== entry.applicationInstanceId
      || status.runtimeGenerationId !== entry.runtimeGenerationId
      || status.challenge?.nonce !== nonce
      || typeof status.challenge.ownerHmacSha256 !== "string") {
      return false;
    }
    const expectedChallenge = createWithMateMemoryRuntimeOwnerChallenge(
      credential.apiSecret,
      entry.applicationInstanceId,
      entry.runtimeGenerationId,
      nonce,
    );
    return safeStringEquals(status.challenge.ownerHmacSha256, expectedChallenge);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function legacyArtifactMatchesRegistryRecord(
  artifact: LegacyGenerationArtifact,
  record: RuntimeDiscoveryRegistryRecord,
): Promise<boolean> {
  try {
    const document = JSON.parse(
      await readFile(artifact.filePath, "utf8"),
    ) as Partial<WithMateMemoryDiscoveryDocument>;
    const runtimeGenerationId = document.runtimeGenerationId ?? document.runtimeInstanceId;
    return document.schemaVersion === WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
      && document.adapter === artifact.adapter
      && document.applicationInstanceId === record.entry.applicationInstanceId
      && runtimeGenerationId === record.entry.runtimeGenerationId
      && document.runtimeInstanceId === record.entry.runtimeGenerationId
      && legacyGenerationDigest(record.entry.runtimeGenerationId) === artifact.digest;
  } catch {
    return false;
  }
}

function memoryPublicationSet(records: readonly RuntimeDiscoveryRegistryRecord[]): string[] {
  return records
    .filter((record) => record.entry.runtimeKind === "memory")
    .map((record) => [
      record.entry.applicationInstanceId,
      record.entry.runtimeGenerationId,
      record.entry.publicationId,
    ].join(":"))
    .sort();
}

function publicationSetsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function commitObservedMemoryPublications(input: {
  observedMemoryPublications: readonly string[];
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  operation: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  beforeLockRelease?: () => Promise<void>;
}): Promise<boolean> {
  return withRuntimeDiscoveryRegistryMutationLock(
    input.registryDirectoryPath,
    async () => {
      const snapshot = await listRuntimeDiscoveryRegistryEntries(
        input.registryDirectoryPath,
        input.limits,
      );
      if (!publicationSetsMatch(
        memoryPublicationSet(snapshot.records),
        input.observedMemoryPublications,
      )) {
        return false;
      }
      await input.beforeCommit?.();
      await withLegacyPointerLock(
        input.runtimeDirectoryPath,
        input.operation,
        input.beforeLockRelease,
      );
      return true;
    },
  );
}

async function resolveLegacyPointerPublishDecision(input: {
  applicationInstanceId: string;
  runtimeGenerationId: string;
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  clock: RuntimeDiscoveryClock;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  fetch: typeof fetch;
  beforeCommit?: () => Promise<void>;
  beforeLockRelease?: () => Promise<void>;
}): Promise<LegacyPointerPublishDecision> {
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    input.registryDirectoryPath,
    input.limits,
  );
  const memoryRecords = snapshot.records.filter((record) => record.entry.runtimeKind === "memory");
  const activeRecords: RuntimeDiscoveryRegistryRecord[] = [];
  const limits = normalizeRuntimeDiscoveryRegistryLimits(input.limits);
  for (const record of memoryRecords) {
    const fresh = getRuntimeDiscoveryLeaseState(
      record.entry,
      input.clock.now(),
      limits.staleThresholdMs,
    ) === "fresh";
    if (fresh || await challengeMemoryRuntimeRegistryEntry(
      record.entry,
      record.slotDirectoryPath,
      input.fetch,
    )) {
      activeRecords.push(record);
    }
  }
  const publishCurrent = activeRecords.length === 1
    && activeRecords[0]!.entry.applicationInstanceId === input.applicationInstanceId
    && activeRecords[0]!.entry.runtimeGenerationId === input.runtimeGenerationId;
  const observedMemoryPublications = memoryPublicationSet(snapshot.records);
  return {
    runtimeGenerationId: publishCurrent ? input.runtimeGenerationId : null,
    commit: (operation) => commitObservedMemoryPublications({
      observedMemoryPublications,
      runtimeDirectoryPath: input.runtimeDirectoryPath,
      ...(input.registryDirectoryPath ? { registryDirectoryPath: input.registryDirectoryPath } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
      operation,
      ...(input.beforeCommit ? { beforeCommit: input.beforeCommit } : {}),
      ...(input.beforeLockRelease ? { beforeLockRelease: input.beforeLockRelease } : {}),
    }),
  };
}

async function resolveLegacyPointerReplacement(input: {
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  currentRuntimeGenerationId: string;
  clock: RuntimeDiscoveryClock;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  fetch: typeof fetch;
}): Promise<ResolvedLegacyPointerReplacement | null> {
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    input.registryDirectoryPath,
    input.limits,
  );
  const artifacts = await listLegacyGenerationArtifacts(input.runtimeDirectoryPath);
  const candidates: RuntimeDiscoveryRegistryRecord[] = [];
  const limits = normalizeRuntimeDiscoveryRegistryLimits(input.limits);
  const records = snapshot.records
    .filter((record) => record.entry.runtimeKind === "memory"
      && record.entry.runtimeGenerationId !== input.currentRuntimeGenerationId)
    .sort((left, right) => {
      const applicationOrder = left.entry.applicationInstanceId.localeCompare(
        right.entry.applicationInstanceId,
      );
      return applicationOrder !== 0
        ? applicationOrder
        : left.entry.runtimeGenerationId.localeCompare(right.entry.runtimeGenerationId);
    });

  for (const record of records) {
    const digest = legacyGenerationDigest(record.entry.runtimeGenerationId);
    const pair = artifacts.filter((artifact) => artifact.digest === digest);
    if (pair.length !== 2
      || !pair.some((artifact) => artifact.adapter === "cli")
      || !pair.some((artifact) => artifact.adapter === "mcp")) {
      if (getRuntimeDiscoveryLeaseState(
        record.entry,
        input.clock.now(),
        limits.staleThresholdMs,
      ) === "fresh") {
        candidates.push(record);
      }
      continue;
    }
    let pairIsActive = true;
    for (const artifact of pair) {
      if (!await legacyArtifactMatchesRegistryRecord(artifact, record)
        || !await challengeLegacyMemoryGenerationArtifact(artifact, input.fetch)) {
        pairIsActive = false;
        break;
      }
    }
    const leaseIsFresh = getRuntimeDiscoveryLeaseState(
      record.entry,
      input.clock.now(),
      limits.staleThresholdMs,
    ) === "fresh";
    const registryChallengeSucceeded = leaseIsFresh
      ? false
      : await challengeMemoryRuntimeRegistryEntry(
        record.entry,
        record.slotDirectoryPath,
        input.fetch,
      );
    if (leaseIsFresh || registryChallengeSucceeded || pairIsActive) {
      candidates.push(record);
    }
  }

  if (candidates.length !== 1) {
    return null;
  }
  const replacement = candidates[0]!;
  const replacementPair = artifacts.filter(
    (artifact) => artifact.digest === legacyGenerationDigest(replacement.entry.runtimeGenerationId),
  );
  if (replacementPair.length !== 2) {
    return null;
  }
  for (const artifact of replacementPair) {
    if (!await legacyArtifactMatchesRegistryRecord(artifact, replacement)
      || !await challengeLegacyMemoryGenerationArtifact(artifact, input.fetch)) {
      return null;
    }
  }
  return {
    replacement,
    observedMemoryPublications: memoryPublicationSet(snapshot.records),
  };
}

async function validateLegacyPointerReplacementBeforeCommit(input: {
  resolution: ResolvedLegacyPointerReplacement;
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
}): Promise<boolean> {
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    input.registryDirectoryPath,
    input.limits,
  );
  if (!publicationSetsMatch(
    memoryPublicationSet(snapshot.records),
    input.resolution.observedMemoryPublications,
  )) {
    return false;
  }
  const current = snapshot.records.find((record) => (
    record.entry.applicationInstanceId === input.resolution.replacement.entry.applicationInstanceId
    && record.entry.runtimeKind === input.resolution.replacement.entry.runtimeKind
    && record.entry.runtimeGenerationId === input.resolution.replacement.entry.runtimeGenerationId
    && record.entry.publicationId === input.resolution.replacement.entry.publicationId
  ));
  if (!current) {
    return false;
  }
  const digest = legacyGenerationDigest(current.entry.runtimeGenerationId);
  const pair = (await listLegacyGenerationArtifacts(input.runtimeDirectoryPath))
    .filter((artifact) => artifact.digest === digest);
  if (pair.length !== 2
    || !pair.some((artifact) => artifact.adapter === "cli")
    || !pair.some((artifact) => artifact.adapter === "mcp")) {
    return false;
  }
  for (const artifact of pair) {
    if (!await legacyArtifactMatchesRegistryRecord(artifact, current)) {
      return false;
    }
  }
  return true;
}

async function commitLegacyPointerReplacement(input: {
  resolution: ResolvedLegacyPointerReplacement;
  runtimeDirectoryPath: string;
  registryDirectoryPath?: string;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  operation: () => Promise<void>;
  beforeLegacyLock?: () => Promise<void>;
}): Promise<boolean> {
  return withRuntimeDiscoveryRegistryMutationLock(
    input.registryDirectoryPath,
    async () => {
      if (!await validateLegacyPointerReplacementBeforeCommit(input)) {
        return false;
      }
      await input.beforeLegacyLock?.();
      await withLegacyPointerLock(input.runtimeDirectoryPath, input.operation);
      return true;
    },
  );
}

export async function startMemoryV6RuntimeApi(
  options: StartMemoryV6RuntimeApiOptions,
): Promise<MemoryV6RuntimeApiHandle> {
  let storage: MemoryV6Storage | null = null;
  let affectStorage: CharacterAffectStorage | null = null;
  let server: MemoryV6HttpServer | null = null;
  let registryPublication: RuntimeDiscoveryRegistryPublication | null = null;
  let legacyDiscoveryFile: PublishedMemoryV6DiscoveryFile | null = null;
  let legacyPointerBeforeRegistryPublication: string | null = null;
  const legacyPaths = resolveRuntimeDiscoveryPaths(options.runtimeDirectoryPath);
  const clock = options.runtimeDiscoveryClock
    ?? (options.now ? { now: options.now } : SYSTEM_RUNTIME_DISCOVERY_CLOCK);
  const security = options.runtimePathSecurity ?? secureRuntimePath;
  const runtimeGenerationId = randomUUID();

  if (!isUuid(options.applicationInstanceId)) {
    throw new Error("Memory V6 applicationInstanceId must be a UUID.");
  }

  try {
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
    server = createMemoryV6HttpServer({
      service,
      characterContextService,
      apiSecret,
      operatorApiSecret,
      mcpApiSecret,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      buildChannel: options.buildChannel,
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
    const publishedAt = clock.now().toISOString();
    await ensureSecureRuntimeDirectory(legacyPaths.runtimeDirectoryPath, security);
    registryPublication = await publishRuntimeDiscoveryEntry({
      ...(options.registryDirectoryPath ? { rootDirectoryPath: options.registryDirectoryPath } : {}),
      security,
      ...(options.runtimeDiscoveryLimits ? { limits: options.runtimeDiscoveryLimits } : {}),
      clock,
      ...(options.runtimeDiscoveryTimers ? { timers: options.runtimeDiscoveryTimers } : {}),
      identity: {
        applicationInstanceId: options.applicationInstanceId,
        runtimeKind: "memory",
        runtimeGenerationId,
      },
      buildChannel: options.buildChannel,
      process: {
        pid: process.pid,
        startedAt: options.processStartedAt ?? publishedAt,
      },
      credentialDocuments: [
        {
          adapterKind: "cli",
          document: {
            schemaVersion: "withmate-runtime-credential-v1",
            applicationInstanceId: options.applicationInstanceId,
            runtimeKind: "memory",
            adapterKind: "cli",
            runtimeGenerationId,
            credential: buildMemoryDiscoveryDocument({
              adapter: "cli",
              baseUrl,
              apiSecret,
              adapterSecret: operatorApiSecret,
              applicationInstanceId: options.applicationInstanceId,
              runtimeGenerationId,
              buildChannel: options.buildChannel,
              publishedAt,
            }),
          } satisfies RuntimeDiscoveryCredentialEnvelope<WithMateMemoryDiscoveryDocument>,
        },
        {
          adapterKind: "mcp",
          document: {
            schemaVersion: "withmate-runtime-credential-v1",
            applicationInstanceId: options.applicationInstanceId,
            runtimeKind: "memory",
            adapterKind: "mcp",
            runtimeGenerationId,
            credential: buildMemoryDiscoveryDocument({
              adapter: "mcp",
              baseUrl,
              apiSecret,
              adapterSecret: mcpApiSecret,
              applicationInstanceId: options.applicationInstanceId,
              runtimeGenerationId,
              buildChannel: options.buildChannel,
              publishedAt,
            }),
          } satisfies RuntimeDiscoveryCredentialEnvelope<WithMateMemoryDiscoveryDocument>,
        },
      ],
      challenge: (entry, slotDirectoryPath) => challengeMemoryRuntimeRegistryEntry(
        entry,
        slotDirectoryPath,
        options.fetch ?? fetch,
      ),
      beforePublicationCommit: () => withLegacyPointerLock(
        legacyPaths.runtimeDirectoryPath,
        async () => {
          legacyPointerBeforeRegistryPublication = await readCurrentLegacyRuntimeGenerationId(
            legacyPaths.runtimeDirectoryPath,
          );
          await rm(legacyPaths.discoveryFilePath, { force: true });
          await options.beforeRuntimeRegistryPublicationCommit?.();
        },
      ),
      beforePublicationLock: options.beforeRuntimeRegistryPublicationLock,
      afterPublicationRollback: () => withLegacyPointerLock(
        legacyPaths.runtimeDirectoryPath,
        async () => {
          await options.beforeRuntimeRegistryPublicationRollback?.();
          if (!legacyPointerBeforeRegistryPublication
            || await readCurrentLegacyRuntimeGenerationId(legacyPaths.runtimeDirectoryPath) !== null) {
            return;
          }
          let temporaryFilePath: string | null = null;
          try {
            temporaryFilePath = await prepareDiscoveryPairPointer(
              legacyPaths.discoveryFilePath,
              legacyPointerBeforeRegistryPublication,
              security,
            );
            await rename(temporaryFilePath, legacyPaths.discoveryFilePath);
            temporaryFilePath = null;
          } finally {
            if (temporaryFilePath) {
              await rm(temporaryFilePath, { force: true }).catch(() => undefined);
            }
          }
        },
      ),
      onHeartbeatError: (error) => {
        options.log?.({
          level: "warn",
          kind: "memory-v6.runtime-discovery.heartbeat-failed",
          process: "main",
          message: "Memory V6 runtime discovery heartbeat failed",
          data: {
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
        });
      },
    });
    registryPublication.startHeartbeat();

    try {
      const legacyMaintenance = await maintainMemoryV6LegacyDiscoveryArtifacts({
        runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
        ...(options.registryDirectoryPath ? { registryDirectoryPath: options.registryDirectoryPath } : {}),
        currentRuntimeGenerationId: runtimeGenerationId,
        clock,
        ...(options.runtimeDiscoveryLimits ? { limits: options.runtimeDiscoveryLimits } : {}),
        fetch: options.fetch ?? fetch,
        requiredCapacity: 2,
      });
      if (!legacyMaintenance.capacityAvailable) {
        throw new Error("Legacy Memory discovery generation capacity is unavailable.");
      }
      legacyDiscoveryFile = await publishMemoryV6DiscoveryFile({
        baseUrl,
        apiSecret,
        operatorApiSecret,
        mcpApiSecret,
        applicationInstanceId: options.applicationInstanceId,
        runtimeGenerationId,
        buildChannel: options.buildChannel,
        runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
        pathSecurity: security,
        beforePairCommit: options.beforeLegacyPairCommit,
        beforeFailedProjectionCleanup: options.beforeFailedLegacyProjectionCleanup,
        cleanupFailedProjection: (operation) => withRuntimeDiscoveryRegistryMutationLock(
          options.registryDirectoryPath,
          () => withLegacyPointerLock(legacyPaths.runtimeDirectoryPath, operation),
        ),
        resolvePointerCommit: () => resolveLegacyPointerPublishDecision({
          applicationInstanceId: options.applicationInstanceId,
          runtimeGenerationId,
          runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
          ...(options.registryDirectoryPath ? { registryDirectoryPath: options.registryDirectoryPath } : {}),
          clock,
          ...(options.runtimeDiscoveryLimits ? { limits: options.runtimeDiscoveryLimits } : {}),
          fetch: options.fetch ?? fetch,
          ...(options.beforeLegacyPointerCommit
            ? { beforeCommit: options.beforeLegacyPointerCommit }
            : {}),
          ...(options.beforeLegacyPointerLockRelease
            ? { beforeLockRelease: options.beforeLegacyPointerLockRelease }
            : {}),
        }),
      });
    } catch (error) {
      options.log?.({
        level: "warn",
        kind: "memory-v6.runtime-discovery.legacy-projection-failed",
        process: "main",
        message: "Memory V6 legacy discovery projection failed",
        data: {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
    }

    options.log?.({
      level: "info",
      kind: "memory-v6.runtime-api.started",
      process: "main",
      message: "Memory V6 runtime API started",
      data: {
        published: true,
        addressFamily: "IPv4",
        applicationInstanceId: options.applicationInstanceId,
        runtimeGenerationId,
        buildChannel: options.buildChannel,
        legacyProjectionPublished: legacyDiscoveryFile?.pointerPublished ?? false,
        createdDatabase: bootstrap.created,
      },
    });

    return {
      baseUrl,
      dbPath: bootstrap.dbPath,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      buildChannel: options.buildChannel,
      discoveryPublished: true,
      discoveryFilePath: legacyPaths.discoveryFilePath,
      mcpDiscoveryFilePath: legacyPaths.mcpDiscoveryFilePath,
      characterContextService,
      async stop(): Promise<void> {
        const cleanupErrors: unknown[] = [];
        let legacyReplacement: ResolvedLegacyPointerReplacement | null = null;
        try {
          await registryPublication?.unpublish();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          legacyReplacement = await resolveLegacyPointerReplacement({
            runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
            ...(options.registryDirectoryPath ? { registryDirectoryPath: options.registryDirectoryPath } : {}),
            currentRuntimeGenerationId: runtimeGenerationId,
            clock,
            ...(options.runtimeDiscoveryLimits ? { limits: options.runtimeDiscoveryLimits } : {}),
            fetch: options.fetch ?? fetch,
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await server?.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await registryPublication?.cleanupGeneration();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await cleanupLegacyDiscoveryProjection(
            legacyDiscoveryFile,
            {
              runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
              runtimeGenerationId,
              security,
              ...(legacyReplacement
                ? {
                  replacement: {
                    runtimeGenerationId: legacyReplacement.replacement.entry.runtimeGenerationId,
                    commit: (operation: () => Promise<void>) => commitLegacyPointerReplacement({
                      resolution: legacyReplacement!,
                      runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
                      ...(options.registryDirectoryPath
                        ? { registryDirectoryPath: options.registryDirectoryPath }
                        : {}),
                      ...(options.runtimeDiscoveryLimits
                        ? { limits: options.runtimeDiscoveryLimits }
                        : {}),
                      operation,
                      ...(options.beforeLegacyPointerHandoffLock
                        ? { beforeLegacyLock: options.beforeLegacyPointerHandoffLock }
                        : {}),
                    }),
                  },
                }
                : {}),
            },
          );
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
    await registryPublication?.unpublish().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await registryPublication?.cleanupGeneration().catch(() => undefined);
    await cleanupLegacyDiscoveryProjection(legacyDiscoveryFile, {
      runtimeDirectoryPath: legacyPaths.runtimeDirectoryPath,
      runtimeGenerationId,
      security,
    }).catch(() => undefined);
    storage?.close();
    affectStorage?.close();
    throw error;
  }
}

export { resolveDefaultWithMateMemoryDiscoveryFilePath };
