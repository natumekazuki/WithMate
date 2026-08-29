import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  buildRuntimeDiscoveryCredentialFileName,
  buildRuntimeDiscoverySlotName,
  normalizeRuntimeDiscoveryRegistryLimits,
  parseRuntimeDiscoveryRegistryEntry,
  resolveDefaultRuntimeDiscoveryRegistryRoot,
  RUNTIME_DISCOVERY_ENTRY_FILE_NAME,
  RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
  RuntimeDiscoveryClock,
  RuntimeDiscoveryIdentity,
  RuntimeDiscoveryRegistryEntry,
  RuntimeDiscoveryRegistryError,
  RuntimeDiscoveryRegistryLimits,
  RuntimeDiscoveryTimerHandle,
  RuntimeDiscoveryTimers,
  RuntimeBuildChannel,
  SYSTEM_RUNTIME_DISCOVERY_CLOCK,
  SYSTEM_RUNTIME_DISCOVERY_TIMERS,
  isSameRuntimeDiscoveryIdentity,
} from "./runtime-discovery-contract.js";

const ACTIVE_DIRECTORY_NAME = "active";
const STAGING_DIRECTORY_NAME = "staging";
const RETIRED_DIRECTORY_NAME = "retired";
const STAGING_NAME_PATTERN = /^stage-[0-9a-f-]{36}$/;
const RETIRED_NAME_PATTERN = /^retired-[0-9a-f-]{36}$/;

export type RuntimePathTargetKind = "directory" | "file";
export type RuntimePathSecurity = (
  targetPath: string,
  targetKind: RuntimePathTargetKind,
) => Promise<void>;

export type RuntimeDiscoveryCredentialDocument = {
  adapterKind: string;
  document: unknown;
};

export type RuntimeDiscoveryRegistryRecord = {
  slotName: string;
  entry: RuntimeDiscoveryRegistryEntry;
  slotDirectoryPath: string;
};

export type RuntimeDiscoveryRegistryListIssue = {
  slotName: string;
  code:
    | "unsafe_slot"
    | "invalid_entry"
    | "missing_credential"
    | "unsafe_credential";
};

export type RuntimeDiscoveryRegistrySnapshot = {
  records: RuntimeDiscoveryRegistryRecord[];
  issues: RuntimeDiscoveryRegistryListIssue[];
};

export type RuntimeDiscoveryRegistryChallenge = (
  entry: RuntimeDiscoveryRegistryEntry,
  slotDirectoryPath: string,
) => Promise<boolean>;

export type RuntimeDiscoveryRegistryLayoutOptions = {
  rootDirectoryPath?: string;
  security: RuntimePathSecurity;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  clock?: RuntimeDiscoveryClock;
};

export type PublishRuntimeDiscoveryEntryOptions =
  RuntimeDiscoveryRegistryLayoutOptions & {
    identity: RuntimeDiscoveryIdentity;
    buildChannel: RuntimeBuildChannel;
    process: {
      pid: number;
      startedAt: string;
    };
    credentialDocuments: RuntimeDiscoveryCredentialDocument[];
    challenge: RuntimeDiscoveryRegistryChallenge;
    timers?: RuntimeDiscoveryTimers;
    onHeartbeatError?: (error: unknown) => void;
  };

type RegistryLayout = {
  rootDirectoryPath: string;
  activeDirectoryPath: string;
  stagingDirectoryPath: string;
  retiredDirectoryPath: string;
};

type SerializedRuntimeDiscoveryCredentialDocument = {
  adapterKind: string;
  credentialFileName: string;
  contents: string;
};

export type RuntimeDiscoveryRegistryMaintenanceResult = {
  retiredEntries: number;
  removedStagingArtifacts: number;
  removedRetiredArtifacts: number;
};

export type RuntimeDiscoveryRegistryPublication = {
  readonly entry: RuntimeDiscoveryRegistryEntry;
  readonly slotName: string;
  startHeartbeat(): void;
  refreshHeartbeat(): Promise<boolean>;
  stopHeartbeat(): Promise<void>;
  unpublish(): Promise<boolean>;
  cleanupGeneration(): Promise<boolean>;
};

function normalizeRootDirectoryPath(rootDirectoryPath?: string): string {
  return path.resolve(
    rootDirectoryPath ?? resolveDefaultRuntimeDiscoveryRegistryRoot(),
  );
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

async function lstatSafe(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isMissingError(error)) {
      return null;
    }
    throw error;
  }
}

async function applyPathSecurity(
  targetPath: string,
  targetKind: RuntimePathTargetKind,
  security: RuntimePathSecurity,
): Promise<void> {
  try {
    await security(targetPath, targetKind);
  } catch (error) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry path security validation failed.",
      { cause: error },
    );
  }
}

async function secureDirectory(
  directoryPath: string,
  security: RuntimePathSecurity,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const createdStats = await lstat(directoryPath);
  if (!createdStats.isDirectory() || createdStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry directory is unsafe.",
    );
  }
  await applyPathSecurity(directoryPath, "directory", security);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry directory is unsafe.",
    );
  }
}

async function ensureRegistryLayout(
  options: RuntimeDiscoveryRegistryLayoutOptions,
): Promise<RegistryLayout> {
  const rootDirectoryPath = normalizeRootDirectoryPath(
    options.rootDirectoryPath,
  );
  const activeDirectoryPath = path.join(
    rootDirectoryPath,
    ACTIVE_DIRECTORY_NAME,
  );
  const stagingDirectoryPath = path.join(
    rootDirectoryPath,
    STAGING_DIRECTORY_NAME,
  );
  const retiredDirectoryPath = path.join(
    rootDirectoryPath,
    RETIRED_DIRECTORY_NAME,
  );
  await secureDirectory(rootDirectoryPath, options.security);
  await secureDirectory(activeDirectoryPath, options.security);
  await secureDirectory(stagingDirectoryPath, options.security);
  await secureDirectory(retiredDirectoryPath, options.security);
  return {
    rootDirectoryPath,
    activeDirectoryPath,
    stagingDirectoryPath,
    retiredDirectoryPath,
  };
}

function serializeEntry(entry: RuntimeDiscoveryRegistryEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

async function readEntryFile(
  entryFilePath: string,
): Promise<RuntimeDiscoveryRegistryEntry> {
  const stats = await lstat(entryFilePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry file is unsafe.",
    );
  }
  const contents = await readFile(entryFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_invalid_entry",
      "Runtime registry entry is not valid JSON.",
      { cause: error },
    );
  }
  return parseRuntimeDiscoveryRegistryEntry(parsed);
}

async function readRecordFromSlot(
  activeDirectoryPath: string,
  slotName: string,
): Promise<{
  record: RuntimeDiscoveryRegistryRecord | null;
  issue?: RuntimeDiscoveryRegistryListIssue;
}> {
  const slotDirectoryPath = path.join(activeDirectoryPath, slotName);
  const slotStats = await lstatSafe(slotDirectoryPath);
  if (!slotStats) {
    return { record: null };
  }
  if (!slotStats.isDirectory() || slotStats.isSymbolicLink()) {
    return { record: null, issue: { slotName, code: "unsafe_slot" } };
  }
  try {
    const entry = await readEntryFile(
      path.join(slotDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
    );
    for (const adapter of entry.adapters) {
      if (
        adapter.credentialFileName !==
        buildRuntimeDiscoveryCredentialFileName(entry, adapter.adapterKind)
      ) {
        return { record: null, issue: { slotName, code: "invalid_entry" } };
      }
      const credentialPath = path.join(
        slotDirectoryPath,
        adapter.credentialFileName,
      );
      const credentialStats = await lstatSafe(credentialPath);
      if (!credentialStats) {
        return {
          record: null,
          issue: { slotName, code: "missing_credential" },
        };
      }
      if (!credentialStats.isFile() || credentialStats.isSymbolicLink()) {
        return { record: null, issue: { slotName, code: "unsafe_credential" } };
      }
    }
    return {
      record: { slotName, entry, slotDirectoryPath },
    };
  } catch {
    return { record: null, issue: { slotName, code: "invalid_entry" } };
  }
}

export async function listRuntimeDiscoveryRegistryEntries(
  rootDirectoryPath?: string,
  limitsOverride: Partial<RuntimeDiscoveryRegistryLimits> = {},
): Promise<RuntimeDiscoveryRegistrySnapshot> {
  const limits = normalizeRuntimeDiscoveryRegistryLimits(limitsOverride);
  const activeDirectoryPath = path.join(
    normalizeRootDirectoryPath(rootDirectoryPath),
    ACTIVE_DIRECTORY_NAME,
  );
  const activeStats = await lstatSafe(activeDirectoryPath);
  if (!activeStats) {
    return { records: [], issues: [] };
  }
  if (!activeStats.isDirectory() || activeStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry active directory is unsafe.",
    );
  }
  const records: RuntimeDiscoveryRegistryRecord[] = [];
  const issues: RuntimeDiscoveryRegistryListIssue[] = [];
  for (let index = 0; index < limits.maxEntries; index += 1) {
    const result = await readRecordFromSlot(
      activeDirectoryPath,
      buildRuntimeDiscoverySlotName(index),
    );
    if (result.record) {
      records.push(result.record);
    }
    if (result.issue) {
      issues.push(result.issue);
    }
  }
  return { records, issues };
}

export async function readRuntimeDiscoveryCredential(
  record: RuntimeDiscoveryRegistryRecord,
  adapterKind: string,
): Promise<string | null> {
  const reference = record.entry.adapters.find(
    (adapter) => adapter.adapterKind === adapterKind,
  );
  if (!reference) {
    return null;
  }
  const credentialPath = path.join(
    record.slotDirectoryPath,
    reference.credentialFileName,
  );
  const stats = await lstatSafe(credentialPath);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    return null;
  }
  return readFile(credentialPath, "utf8");
}

async function writeExclusiveSecureFile(
  targetPath: string,
  contents: string | Uint8Array,
  security: RuntimePathSecurity,
): Promise<void> {
  const handle = await open(targetPath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const writtenStats = await lstat(targetPath);
  if (!writtenStats.isFile() || writtenStats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry file is unsafe.",
    );
  }
  await applyPathSecurity(targetPath, "file", security);
  const stats = await lstat(targetPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_security",
      "Runtime registry file is unsafe.",
    );
  }
  const readBack = await readFile(targetPath);
  const expected =
    typeof contents === "string"
      ? Buffer.from(contents, "utf8")
      : Buffer.from(contents);
  if (!readBack.equals(expected)) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_io",
      "Runtime registry file read-back failed.",
    );
  }
}

async function replaceEntryAtomically(
  slotDirectoryPath: string,
  entry: RuntimeDiscoveryRegistryEntry,
  security: RuntimePathSecurity,
): Promise<void> {
  const temporaryFilePath = path.join(
    slotDirectoryPath,
    `entry-${randomUUID()}.tmp`,
  );
  try {
    await writeExclusiveSecureFile(
      temporaryFilePath,
      serializeEntry(entry),
      security,
    );
    await rename(
      temporaryFilePath,
      path.join(slotDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
    );
  } finally {
    await rm(temporaryFilePath, { force: true }).catch(() => undefined);
  }
}

function elapsedSince(timestamp: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(timestamp));
}

async function readUnchangedRecord(
  record: RuntimeDiscoveryRegistryRecord,
): Promise<RuntimeDiscoveryRegistryRecord | null> {
  const result = await readRecordFromSlot(
    path.dirname(record.slotDirectoryPath),
    record.slotName,
  );
  if (
    !result.record ||
    !isSameRuntimeDiscoveryIdentity(result.record.entry, record.entry) ||
    result.record.entry.publicationId !== record.entry.publicationId ||
    result.record.entry.lease.heartbeatAt !== record.entry.lease.heartbeatAt
  ) {
    return null;
  }
  return result.record;
}

async function retireUnchangedRecord(
  record: RuntimeDiscoveryRegistryRecord,
  retiredDirectoryPath: string,
): Promise<string | null> {
  const unchanged = await readUnchangedRecord(record);
  if (!unchanged) {
    return null;
  }
  const destinationPath = path.join(
    retiredDirectoryPath,
    `retired-${randomUUID()}`,
  );
  try {
    await rename(unchanged.slotDirectoryPath, destinationPath);
    return destinationPath;
  } catch (error) {
    if (isMissingError(error) || isAlreadyExistsError(error)) {
      return null;
    }
    throw error;
  }
}

async function removeAgedArtifacts(
  directoryPath: string,
  namePattern: RegExp,
  minimumAgeMs: number,
  now: Date,
  maximumRemovals: number,
): Promise<number> {
  const names = await readdir(directoryPath);
  let removed = 0;
  for (const name of names) {
    if (!namePattern.test(name)) {
      continue;
    }
    if (removed >= maximumRemovals) {
      break;
    }
    const artifactPath = path.join(directoryPath, name);
    const stats = await lstatSafe(artifactPath);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    if (now.getTime() - stats.mtimeMs < minimumAgeMs) {
      continue;
    }
    try {
      await rm(artifactPath, { recursive: true, force: false });
      removed += 1;
    } catch (error) {
      if (!isMissingError(error)) {
        throw error;
      }
    }
  }
  return removed;
}

export async function maintainRuntimeDiscoveryRegistry(
  options: RuntimeDiscoveryRegistryLayoutOptions & {
    challenge: RuntimeDiscoveryRegistryChallenge;
    capacityPressure?: boolean;
  },
): Promise<RuntimeDiscoveryRegistryMaintenanceResult> {
  const layout = await ensureRegistryLayout(options);
  const limits = normalizeRuntimeDiscoveryRegistryLimits(options.limits);
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const now = clock.now();
  const minimumEntryAge = options.capacityPressure
    ? limits.staleThresholdMs + limits.capacityCleanupGraceMs
    : limits.retentionMs;
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    layout.rootDirectoryPath,
    limits,
  );
  let retiredEntries = 0;
  for (const record of snapshot.records) {
    if (elapsedSince(record.entry.lease.heartbeatAt, now) <= minimumEntryAge) {
      continue;
    }
    let challengeSucceeded = false;
    try {
      challengeSucceeded = await options.challenge(
        record.entry,
        record.slotDirectoryPath,
      );
    } catch {
      challengeSucceeded = false;
    }
    if (challengeSucceeded) {
      continue;
    }
    const retiredPath = await retireUnchangedRecord(
      record,
      layout.retiredDirectoryPath,
    );
    if (retiredPath) {
      retiredEntries += 1;
      await rm(retiredPath, { recursive: true, force: false });
    }
  }
  const removedStagingArtifacts = await removeAgedArtifacts(
    layout.stagingDirectoryPath,
    STAGING_NAME_PATTERN,
    limits.capacityCleanupGraceMs,
    now,
    limits.maxEntries,
  );
  const removedRetiredArtifacts = await removeAgedArtifacts(
    layout.retiredDirectoryPath,
    RETIRED_NAME_PATTERN,
    limits.retentionMs,
    now,
    limits.maxEntries,
  );
  return { retiredEntries, removedStagingArtifacts, removedRetiredArtifacts };
}

function serializeCredentialDocuments(
  identity: RuntimeDiscoveryIdentity,
  credentialDocuments: RuntimeDiscoveryCredentialDocument[],
): SerializedRuntimeDiscoveryCredentialDocument[] {
  if (credentialDocuments.length === 0) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      "At least one runtime credential document is required.",
    );
  }
  const adapterKinds = new Set<string>();
  return credentialDocuments.map(({ adapterKind, document }) => {
    if (adapterKinds.has(adapterKind)) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential adapter kinds must be unique.",
      );
    }
    adapterKinds.add(adapterKind);
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(document);
    } catch (error) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential document is not JSON serializable.",
        { cause: error },
      );
    }
    if (serialized === undefined) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "Runtime credential document is not JSON serializable.",
      );
    }
    return {
      adapterKind,
      credentialFileName: buildRuntimeDiscoveryCredentialFileName(
        identity,
        adapterKind,
      ),
      contents: `${serialized}\n`,
    };
  });
}

function buildEntry(
  options: PublishRuntimeDiscoveryEntryOptions,
  clock: RuntimeDiscoveryClock,
  publicationId: string,
  credentialDocuments: SerializedRuntimeDiscoveryCredentialDocument[],
): RuntimeDiscoveryRegistryEntry {
  const timestamp = clock.now().toISOString();
  return parseRuntimeDiscoveryRegistryEntry({
    schemaVersion: RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
    ...options.identity,
    buildChannel: options.buildChannel,
    process: options.process,
    publicationId,
    publishedAt: timestamp,
    lease: { heartbeatAt: timestamp },
    adapters: credentialDocuments.map(
      ({ adapterKind, credentialFileName }) => ({
        adapterKind,
        credentialFileName,
      }),
    ),
  });
}

async function credentialsMatch(
  record: RuntimeDiscoveryRegistryRecord,
  credentialDocuments: SerializedRuntimeDiscoveryCredentialDocument[],
): Promise<boolean> {
  if (record.entry.adapters.length !== credentialDocuments.length) {
    return false;
  }
  for (const document of credentialDocuments) {
    const current = await readRuntimeDiscoveryCredential(
      record,
      document.adapterKind,
    );
    if (current !== document.contents) {
      return false;
    }
  }
  return true;
}

async function findExactRecord(
  rootDirectoryPath: string,
  identity: RuntimeDiscoveryIdentity,
  limits: RuntimeDiscoveryRegistryLimits,
): Promise<RuntimeDiscoveryRegistryRecord | null> {
  const snapshot = await listRuntimeDiscoveryRegistryEntries(
    rootDirectoryPath,
    limits,
  );
  return (
    snapshot.records.find((record) =>
      isSameRuntimeDiscoveryIdentity(record.entry, identity),
    ) ?? null
  );
}

function createPublicationHandle(args: {
  layout: RegistryLayout;
  record: RuntimeDiscoveryRegistryRecord;
  security: RuntimePathSecurity;
  clock: RuntimeDiscoveryClock;
  timers: RuntimeDiscoveryTimers;
  limits: RuntimeDiscoveryRegistryLimits;
  onHeartbeatError?: (error: unknown) => void;
}): RuntimeDiscoveryRegistryPublication {
  let currentEntry = args.record.entry;
  let heartbeatHandle: RuntimeDiscoveryTimerHandle | null = null;
  let serializedOperation = Promise.resolve<void>(undefined);
  let retiredDirectoryPath: string | null = null;
  let unpublished = false;

  const isOwnedEntry = (entry: RuntimeDiscoveryRegistryEntry): boolean =>
    isSameRuntimeDiscoveryIdentity(entry, currentEntry) &&
    entry.publicationId === currentEntry.publicationId;

  const runSerialized = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = serializedOperation;
    let release: (() => void) | undefined;
    serializedOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  };

  const refreshHeartbeat = async (): Promise<boolean> =>
    runSerialized(async () => {
      if (unpublished) {
        return false;
      }
      const readBack = await readRecordFromSlot(
        args.layout.activeDirectoryPath,
        args.record.slotName,
      );
      if (!readBack.record || !isOwnedEntry(readBack.record.entry)) {
        return false;
      }
      const nextEntry = {
        ...readBack.record.entry,
        lease: { heartbeatAt: args.clock.now().toISOString() },
      };
      await replaceEntryAtomically(
        readBack.record.slotDirectoryPath,
        nextEntry,
        args.security,
      );
      currentEntry = nextEntry;
      return true;
    });

  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeatHandle) {
      args.timers.clearInterval(heartbeatHandle);
      heartbeatHandle = null;
    }
    await serializedOperation;
  };

  const unpublish = async (): Promise<boolean> => {
    await stopHeartbeat();
    return runSerialized(async () => {
      if (unpublished) {
        return false;
      }
      const readBack = await readRecordFromSlot(
        args.layout.activeDirectoryPath,
        args.record.slotName,
      );
      if (!readBack.record || !isOwnedEntry(readBack.record.entry)) {
        unpublished = true;
        return false;
      }
      const destinationPath = path.join(
        args.layout.retiredDirectoryPath,
        `retired-${randomUUID()}`,
      );
      try {
        await rename(readBack.record.slotDirectoryPath, destinationPath);
        retiredDirectoryPath = destinationPath;
        unpublished = true;
        return true;
      } catch (error) {
        if (isMissingError(error)) {
          unpublished = true;
          return false;
        }
        if (isAlreadyExistsError(error)) {
          return false;
        }
        throw error;
      }
    });
  };

  const cleanupGeneration = async (): Promise<boolean> =>
    runSerialized(async () => {
      if (!retiredDirectoryPath) {
        return false;
      }
      try {
        const entry = await readEntryFile(
          path.join(retiredDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
        );
        if (!isOwnedEntry(entry)) {
          return false;
        }
        await rm(retiredDirectoryPath, { recursive: true, force: false });
        retiredDirectoryPath = null;
        return true;
      } catch (error) {
        if (isMissingError(error)) {
          retiredDirectoryPath = null;
          return false;
        }
        throw error;
      }
    });

  return {
    get entry() {
      return currentEntry;
    },
    slotName: args.record.slotName,
    startHeartbeat() {
      if (heartbeatHandle || unpublished) {
        return;
      }
      heartbeatHandle = args.timers.setInterval(() => {
        void refreshHeartbeat().catch((error) =>
          args.onHeartbeatError?.(error),
        );
      }, args.limits.heartbeatMs);
    },
    refreshHeartbeat,
    stopHeartbeat,
    unpublish,
    cleanupGeneration,
  };
}

export async function publishRuntimeDiscoveryEntry(
  options: PublishRuntimeDiscoveryEntryOptions,
): Promise<RuntimeDiscoveryRegistryPublication> {
  const limits = normalizeRuntimeDiscoveryRegistryLimits(options.limits);
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const timers = options.timers ?? SYSTEM_RUNTIME_DISCOVERY_TIMERS;
  const layout = await ensureRegistryLayout(options);
  const credentialDocuments = serializeCredentialDocuments(
    options.identity,
    options.credentialDocuments,
  );
  const publicationId = randomUUID();
  const entry = buildEntry(options, clock, publicationId, credentialDocuments);

  const existing = await findExactRecord(
    layout.rootDirectoryPath,
    options.identity,
    limits,
  );
  if (existing) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_conflict",
      "The runtime identity tuple is already owned by another publication.",
    );
  }

  await maintainRuntimeDiscoveryRegistry({
    ...options,
    capacityPressure: false,
  });
  let snapshot = await listRuntimeDiscoveryRegistryEntries(
    layout.rootDirectoryPath,
    limits,
  );
  let occupiedSlots = new Set(
    snapshot.records.map((record) => record.slotName),
  );
  for (const issue of snapshot.issues) {
    occupiedSlots.add(issue.slotName);
  }
  if (occupiedSlots.size >= limits.maxEntries) {
    await maintainRuntimeDiscoveryRegistry({
      ...options,
      capacityPressure: true,
    });
    snapshot = await listRuntimeDiscoveryRegistryEntries(
      layout.rootDirectoryPath,
      limits,
    );
    occupiedSlots = new Set(snapshot.records.map((record) => record.slotName));
    for (const issue of snapshot.issues) {
      occupiedSlots.add(issue.slotName);
    }
  }

  if (occupiedSlots.size >= limits.maxEntries) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_capacity",
      "The runtime discovery registry has no safe publication capacity.",
    );
  }

  const stagingDirectoryPath = path.join(
    layout.stagingDirectoryPath,
    `stage-${randomUUID()}`,
  );
  await mkdir(stagingDirectoryPath, { recursive: false, mode: 0o700 });
  let committedRecord: RuntimeDiscoveryRegistryRecord | null = null;
  let claimedSlotPath: string | null = null;
  try {
    const stagingStats = await lstat(stagingDirectoryPath);
    if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_security",
        "Runtime registry staging directory is unsafe.",
      );
    }
    await applyPathSecurity(
      stagingDirectoryPath,
      "directory",
      options.security,
    );
    const securedStagingStats = await lstat(stagingDirectoryPath);
    if (
      !securedStagingStats.isDirectory() ||
      securedStagingStats.isSymbolicLink()
    ) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_security",
        "Runtime registry staging directory is unsafe.",
      );
    }
    for (const document of credentialDocuments) {
      await writeExclusiveSecureFile(
        path.join(stagingDirectoryPath, document.credentialFileName),
        document.contents,
        options.security,
      );
    }
    await writeExclusiveSecureFile(
      path.join(stagingDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
      serializeEntry(entry),
      options.security,
    );
    await readEntryFile(
      path.join(stagingDirectoryPath, RUNTIME_DISCOVERY_ENTRY_FILE_NAME),
    );

    for (let index = 0; index < limits.maxEntries; index += 1) {
      const slotName = buildRuntimeDiscoverySlotName(index);
      if (occupiedSlots.has(slotName)) {
        continue;
      }
      const slotDirectoryPath = path.join(layout.activeDirectoryPath, slotName);
      try {
        await rename(stagingDirectoryPath, slotDirectoryPath);
        claimedSlotPath = slotDirectoryPath;
      } catch (error) {
        const exactAfterFailure = await findExactRecord(
          layout.rootDirectoryPath,
          options.identity,
          limits,
        );
        if (
          exactAfterFailure &&
          exactAfterFailure.entry.publicationId === publicationId &&
          (await credentialsMatch(exactAfterFailure, credentialDocuments))
        ) {
          claimedSlotPath = exactAfterFailure.slotDirectoryPath;
          await applyPathSecurity(
            claimedSlotPath,
            "directory",
            options.security,
          );
          const readBackAfterFailure = await readRecordFromSlot(
            layout.activeDirectoryPath,
            exactAfterFailure.slotName,
          );
          if (
            !readBackAfterFailure.record ||
            readBackAfterFailure.record.entry.publicationId !== publicationId ||
            !isSameRuntimeDiscoveryIdentity(
              readBackAfterFailure.record.entry,
              entry,
            ) ||
            !(await credentialsMatch(
              readBackAfterFailure.record,
              credentialDocuments,
            ))
          ) {
            throw new RuntimeDiscoveryRegistryError(
              "registry_io",
              "Runtime registry publication read-back failed.",
            );
          }
          committedRecord = readBackAfterFailure.record;
          break;
        }
        if (isAlreadyExistsError(error)) {
          occupiedSlots.add(slotName);
          continue;
        }
        throw error;
      }
      await applyPathSecurity(slotDirectoryPath, "directory", options.security);
      const securedSlotStats = await lstat(slotDirectoryPath);
      if (
        !securedSlotStats.isDirectory() ||
        securedSlotStats.isSymbolicLink()
      ) {
        throw new RuntimeDiscoveryRegistryError(
          "registry_security",
          "Runtime registry slot directory is unsafe.",
        );
      }
      const result = await readRecordFromSlot(
        layout.activeDirectoryPath,
        slotName,
      );
      if (
        !result.record ||
        !isSameRuntimeDiscoveryIdentity(result.record.entry, entry) ||
        result.record.entry.publicationId !== publicationId ||
        !(await credentialsMatch(result.record, credentialDocuments))
      ) {
        throw new RuntimeDiscoveryRegistryError(
          "registry_io",
          "Runtime registry publication read-back failed.",
        );
      }
      committedRecord = result.record;
      break;
    }
    if (!committedRecord) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_capacity",
        "The runtime discovery registry filled during publication.",
      );
    }
  } catch (error) {
    if (claimedSlotPath) {
      const slotName = path.basename(claimedSlotPath);
      const readBack = await readRecordFromSlot(
        layout.activeDirectoryPath,
        slotName,
      ).catch(() => ({ record: null }));
      if (
        readBack.record &&
        isSameRuntimeDiscoveryIdentity(readBack.record.entry, entry) &&
        readBack.record.entry.publicationId === publicationId
      ) {
        const rollbackPath = path.join(
          layout.retiredDirectoryPath,
          `retired-${randomUUID()}`,
        );
        try {
          await rename(claimedSlotPath, rollbackPath);
          await rm(rollbackPath, { recursive: true, force: false });
        } catch (rollbackError) {
          if (isMissingError(rollbackError)) {
            claimedSlotPath = null;
          } else {
            try {
              const current = await readRecordFromSlot(
                layout.activeDirectoryPath,
                slotName,
              );
              if (
                current.record &&
                isSameRuntimeDiscoveryIdentity(current.record.entry, entry) &&
                current.record.entry.publicationId === publicationId
              ) {
                await rm(claimedSlotPath, { recursive: true, force: false });
              }
            } catch (directCleanupError) {
              throw new RuntimeDiscoveryRegistryError(
                "registry_io",
                "Runtime registry publication rollback failed.",
                { cause: directCleanupError },
              );
            }
          }
        }
      }
    }
    throw error;
  } finally {
    await rm(stagingDirectoryPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  return createPublicationHandle({
    layout,
    record: committedRecord,
    security: options.security,
    clock,
    timers,
    limits,
    onHeartbeatError: options.onHeartbeatError,
  });
}
