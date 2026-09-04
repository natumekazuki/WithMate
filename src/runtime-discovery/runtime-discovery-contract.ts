import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export const RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION = "withmate-runtime-discovery-entry-v1" as const;
export const RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME = "runtime-discovery" as const;
export const RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME = "v1" as const;
export const RUNTIME_DISCOVERY_ENTRY_FILE_NAME = "entry.json" as const;

export const RUNTIME_DISCOVERY_DEFAULT_HEARTBEAT_MS = 5_000;
export const RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS = 20_000;
export const RUNTIME_DISCOVERY_DEFAULT_CAPACITY_CLEANUP_GRACE_MS = 60_000;
export const RUNTIME_DISCOVERY_DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES = 64;
export const RUNTIME_DISCOVERY_SLOT_COUNT = 64;

export type RuntimeBuildChannel = "installed" | "development" | "visual-check" | "unknown";
export type RuntimeKind = "memory" | (string & {});

export type RuntimeDiscoveryIdentity = {
  applicationInstanceId: string;
  runtimeKind: RuntimeKind;
  runtimeGenerationId: string;
};

export type RuntimeDiscoveryAdapterReference = {
  adapterKind: string;
  credentialFileName: string;
};

/** Credential material is deliberately opaque to the safe registry projection. */
export type RuntimeDiscoveryCredentialEnvelope<T = unknown> = {
  schemaVersion: "withmate-runtime-credential-v1";
  applicationInstanceId: string;
  runtimeKind: RuntimeKind;
  adapterKind: string;
  runtimeGenerationId: string;
  credential: T;
};

export type RuntimeDiscoveryRegistryEntry = RuntimeDiscoveryIdentity & {
  schemaVersion: typeof RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION;
  buildChannel: RuntimeBuildChannel;
  process: {
    pid: number;
    startedAt: string;
  };
  publicationId: string;
  publishedAt: string;
  lease: {
    heartbeatAt: string;
  };
  adapters: RuntimeDiscoveryAdapterReference[];
};

export type RuntimeDiscoveryLeaseState = "fresh" | "expired";

export type SafeRuntimeDiscoveryMetadata = RuntimeDiscoveryIdentity & {
  buildChannel: RuntimeBuildChannel;
  pid: number;
  processStartedAt: string;
  publicationId: string;
  publishedAt: string;
  leaseHeartbeatAt: string;
  leaseState: RuntimeDiscoveryLeaseState;
};

export type RuntimeDiscoverySelectionOutcomeCode =
  | "runtime_unavailable"
  | "runtime_instance_mismatch"
  | "runtime_generation_changed"
  | "runtime_ambiguous"
  | "runtime_stale"
  | "runtime_registry_capacity"
  | "runtime_selector_invalid"
  | "runtime_credential_unavailable"
  | "runtime_invalid";

export type RuntimeDiscoverySelector = {
  runtimeKind: RuntimeKind;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
};

export type RuntimeDiscoverySelectionOutcome =
  | {
      kind: "selected";
      identity: RuntimeDiscoveryIdentity;
      metadata: SafeRuntimeDiscoveryMetadata;
    }
  | {
      kind: "error";
      code: RuntimeDiscoverySelectionOutcomeCode;
      metadata?: SafeRuntimeDiscoveryMetadata[];
    };

export type RuntimeDiscoveryRegistryErrorCode =
  | "registry_configuration"
  | "registry_capacity"
  | "registry_conflict"
  | "registry_invalid_entry"
  | "registry_security"
  | "registry_io";

export class RuntimeDiscoveryRegistryError extends Error {
  readonly code: RuntimeDiscoveryRegistryErrorCode;

  constructor(code: RuntimeDiscoveryRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeDiscoveryRegistryError";
    this.code = code;
  }
}

export type RuntimeDiscoveryRegistryLimits = {
  heartbeatMs: number;
  staleThresholdMs: number;
  capacityCleanupGraceMs: number;
  retentionMs: number;
  maxEntries: number;
};

export const DEFAULT_RUNTIME_DISCOVERY_REGISTRY_LIMITS: Readonly<RuntimeDiscoveryRegistryLimits> = {
  heartbeatMs: RUNTIME_DISCOVERY_DEFAULT_HEARTBEAT_MS,
  staleThresholdMs: RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
  capacityCleanupGraceMs: RUNTIME_DISCOVERY_DEFAULT_CAPACITY_CLEANUP_GRACE_MS,
  retentionMs: RUNTIME_DISCOVERY_DEFAULT_RETENTION_MS,
  maxEntries: RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES,
};

export type RuntimeDiscoveryClock = {
  now(): Date;
};

export type RuntimeDiscoveryTimerHandle = ReturnType<typeof setInterval>;

export type RuntimeDiscoveryTimers = {
  setInterval(callback: () => void, intervalMs: number): RuntimeDiscoveryTimerHandle;
  clearInterval(handle: RuntimeDiscoveryTimerHandle): void;
};

export const SYSTEM_RUNTIME_DISCOVERY_CLOCK: RuntimeDiscoveryClock = {
  now: () => new Date(),
};

export const SYSTEM_RUNTIME_DISCOVERY_TIMERS: RuntimeDiscoveryTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ADAPTER_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CREDENTIAL_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,126}\.json$/;
const BUILD_CHANNELS = new Set<RuntimeBuildChannel>([
  "installed",
  "development",
  "visual-check",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isSafeRelativeRuntimeDiscoveryReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && !value.includes("/")
    && !value.includes("\\")
    && path.posix.basename(value) === value;
}

export function isRuntimeDiscoveryIdentity(value: unknown): value is RuntimeDiscoveryIdentity {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.applicationInstanceId === "string"
    && UUID_PATTERN.test(value.applicationInstanceId)
    && typeof value.runtimeGenerationId === "string"
    && UUID_PATTERN.test(value.runtimeGenerationId)
    && typeof value.runtimeKind === "string"
    && RUNTIME_KIND_PATTERN.test(value.runtimeKind);
}

export function isRuntimeDiscoveryAdapterReference(
  value: unknown,
): value is RuntimeDiscoveryAdapterReference {
  if (!isRecord(value) || !hasExactKeys(value, ["adapterKind", "credentialFileName"])) {
    return false;
  }
  if (typeof value.adapterKind !== "string" || !ADAPTER_KIND_PATTERN.test(value.adapterKind)) {
    return false;
  }
  if (typeof value.credentialFileName !== "string"
    || !CREDENTIAL_FILE_NAME_PATTERN.test(value.credentialFileName)
    || !isSafeRelativeRuntimeDiscoveryReference(value.credentialFileName)
    || value.credentialFileName === RUNTIME_DISCOVERY_ENTRY_FILE_NAME) {
    return false;
  }
  return true;
}

export function isRuntimeDiscoverySelector(value: unknown): value is RuntimeDiscoverySelector {
  if (!isRecord(value)
    || typeof value.runtimeKind !== "string"
    || !RUNTIME_KIND_PATTERN.test(value.runtimeKind)) {
    return false;
  }
  if (value.applicationInstanceId !== undefined && !isUuid(value.applicationInstanceId)) {
    return false;
  }
  if (value.runtimeGenerationId !== undefined && !isUuid(value.runtimeGenerationId)) {
    return false;
  }
  return value.runtimeGenerationId === undefined || value.applicationInstanceId !== undefined;
}

/** Slot and credential names are hashes; identity values never appear in file names. */
export function buildRuntimeDiscoveryEntryFileName(identity: RuntimeDiscoveryIdentity): string {
  return `entry-${hashRuntimeDiscoveryIdentity(identity)}.json`;
}

export function buildRuntimeDiscoveryCredentialFileName(
  identity: RuntimeDiscoveryIdentity,
  adapterKind: string,
): string {
  if (!ADAPTER_KIND_PATTERN.test(adapterKind)) {
    throw new RuntimeDiscoveryRegistryError("registry_configuration", "Invalid adapter kind.");
  }
  const digest = createHash("sha256")
    .update(`${identity.applicationInstanceId}\0${identity.runtimeKind}\0${identity.runtimeGenerationId}\0${adapterKind}`)
    .digest("hex");
  return `credential-${digest}.json`;
}

export function hashRuntimeDiscoveryIdentity(identity: RuntimeDiscoveryIdentity): string {
  return createHash("sha256")
    .update(`${identity.applicationInstanceId}\0${identity.runtimeKind}\0${identity.runtimeGenerationId}`)
    .digest("hex");
}

export function buildRuntimeDiscoverySlotName(slot: number): string {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= RUNTIME_DISCOVERY_SLOT_COUNT) {
    throw new RuntimeDiscoveryRegistryError("registry_configuration", "Runtime registry slot is out of range.");
  }
  return `slot-${String(slot).padStart(2, "0")}`;
}

export function parseRuntimeDiscoveryRegistryEntry(value: unknown): RuntimeDiscoveryRegistryEntry {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "applicationInstanceId",
    "runtimeKind",
    "runtimeGenerationId",
    "buildChannel",
    "process",
    "publicationId",
    "publishedAt",
    "lease",
    "adapters",
  ])) {
    throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry entry has an invalid shape.");
  }
  if (value.schemaVersion !== RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION
    || !isRuntimeDiscoveryIdentity(value)
    || typeof (value as RuntimeDiscoveryRegistryEntry).buildChannel !== "string"
    || !BUILD_CHANNELS.has((value as RuntimeDiscoveryRegistryEntry).buildChannel as RuntimeBuildChannel)
    || !isUuid((value as RuntimeDiscoveryRegistryEntry).publicationId)
    || !isIsoTimestamp((value as RuntimeDiscoveryRegistryEntry).publishedAt)) {
    throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry entry metadata is invalid.");
  }
  const entry = value as RuntimeDiscoveryRegistryEntry;
  if (!isRecord(entry.process)
    || !hasExactKeys(entry.process, ["pid", "startedAt"])
    || typeof entry.process.pid !== "number"
    || !Number.isSafeInteger(entry.process.pid)
    || entry.process.pid <= 0
    || !isIsoTimestamp(entry.process.startedAt)) {
    throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry process metadata is invalid.");
  }
  if (!isRecord(entry.lease)
    || !hasExactKeys(entry.lease, ["heartbeatAt"])
    || !isIsoTimestamp(entry.lease.heartbeatAt)) {
    throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry lease metadata is invalid.");
  }
  if (!Array.isArray(entry.adapters)
    || entry.adapters.length === 0
    || !entry.adapters.every(isRuntimeDiscoveryAdapterReference)) {
    throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry adapter references are invalid.");
  }
  const adapterKinds = new Set<string>();
  const credentialFileNames = new Set<string>();
  for (const adapter of entry.adapters) {
    if (adapterKinds.has(adapter.adapterKind) || credentialFileNames.has(adapter.credentialFileName)) {
      throw new RuntimeDiscoveryRegistryError("registry_invalid_entry", "Runtime registry adapter references must be unique.");
    }
    adapterKinds.add(adapter.adapterKind);
    credentialFileNames.add(adapter.credentialFileName);
  }
  return value as RuntimeDiscoveryRegistryEntry;
}

export function isSameRuntimeDiscoveryIdentity(
  left: RuntimeDiscoveryIdentity,
  right: RuntimeDiscoveryIdentity,
): boolean {
  return left.applicationInstanceId === right.applicationInstanceId
    && left.runtimeKind === right.runtimeKind
    && left.runtimeGenerationId === right.runtimeGenerationId;
}

export function getRuntimeDiscoveryLeaseState(
  entry: RuntimeDiscoveryRegistryEntry,
  now: Date,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): RuntimeDiscoveryLeaseState {
  return now.getTime() - Date.parse(entry.lease.heartbeatAt) > staleThresholdMs ? "expired" : "fresh";
}

export function toSafeRuntimeDiscoveryMetadata(
  entry: RuntimeDiscoveryRegistryEntry,
  now: Date,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): SafeRuntimeDiscoveryMetadata {
  return {
    applicationInstanceId: entry.applicationInstanceId,
    runtimeKind: entry.runtimeKind,
    runtimeGenerationId: entry.runtimeGenerationId,
    buildChannel: entry.buildChannel,
    pid: entry.process.pid,
    processStartedAt: entry.process.startedAt,
    publicationId: entry.publicationId,
    publishedAt: entry.publishedAt,
    leaseHeartbeatAt: entry.lease.heartbeatAt,
    leaseState: getRuntimeDiscoveryLeaseState(entry, now, staleThresholdMs),
  };
}

export function resolveDefaultRuntimeDiscoveryRegistryRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData || !path.win32.isAbsolute(localAppData)) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        "LOCALAPPDATA must identify an absolute Windows directory.",
      );
    }
    return path.win32.join(
      localAppData,
      "WithMate",
      RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME,
      RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME,
    );
  }

  const ownerSegment = typeof process.getuid === "function" ? `uid-${process.getuid()}` : "local-user";
  return path.join(
    tmpdir(),
    "withmate",
    ownerSegment,
    RUNTIME_DISCOVERY_REGISTRY_DIRECTORY_NAME,
    RUNTIME_DISCOVERY_REGISTRY_VERSION_DIRECTORY_NAME,
  );
}

export function normalizeRuntimeDiscoveryRegistryLimits(
  overrides: Partial<RuntimeDiscoveryRegistryLimits> = {},
): RuntimeDiscoveryRegistryLimits {
  const limits = { ...DEFAULT_RUNTIME_DISCOVERY_REGISTRY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RuntimeDiscoveryRegistryError(
        "registry_configuration",
        `Runtime registry limit ${name} must be a positive integer.`,
      );
    }
  }
  if (limits.maxEntries > RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES) {
    throw new RuntimeDiscoveryRegistryError(
      "registry_configuration",
      `Runtime registry maxEntries must not exceed ${RUNTIME_DISCOVERY_DEFAULT_MAX_ENTRIES}.`,
    );
  }
  return limits;
}
