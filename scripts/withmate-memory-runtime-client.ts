import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import {
  createCharacterContextError,
  isCharacterContextError,
  type CharacterContextErrorCode,
} from "../src/character-context/character-context-contract.js";
import {
  buildWithMateMemoryDiscoveryGenerationFileName,
  normalizeWithMateMemoryApiBaseUrl,
  resolveDefaultWithMateMemoryDiscoveryFilePath,
  WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION,
  WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION,
  type WithMateMemoryAdapterKind,
  type WithMateMemoryDiscoveryDocument,
  type WithMateMemoryDiscoveryPointer,
} from "../src/memory-v6/memory-discovery.js";
import {
  createMemoryErrorResponse,
  type MemoryErrorResponse,
} from "../src/memory-v6/memory-response-contract.js";
import {
  createWithMateMemoryRuntimeChallenge,
  createWithMateMemoryRuntimeOwnerChallenge,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../src/memory-v6/memory-runtime-exchange.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
  WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV,
  WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  getRuntimeDiscoveryLeaseState,
  isUuid,
  RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
  RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION,
  type RuntimeBuildChannel,
  type RuntimeDiscoveryClock,
  type RuntimeDiscoveryCredentialEnvelope,
  type RuntimeDiscoverySelectionOutcomeCode,
} from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  readRuntimeDiscoveryCredential,
  type RuntimeDiscoveryRegistryRecord,
} from "../src/runtime-discovery/runtime-discovery-registry.js";

export type WithMateMemoryApiConnection = {
  baseUrl: string;
  apiSecret: string;
  applicationInstanceId?: string;
  runtimeGenerationId: string;
  /** @deprecated This alias has runtime generation semantics. */
  runtimeInstanceId: string;
};

export type WithMateMemoryAdapterCredential = {
  adapter: WithMateMemoryAdapterKind;
  adapterSecret: string;
};

export type WithMateMemoryRuntimeConnection = {
  api: WithMateMemoryApiConnection;
  credential: WithMateMemoryAdapterCredential;
};

export type WithMateMemoryRuntimeOperation = {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  fallbackFrom?: "mcp";
};

export type WithMateMemoryRuntimeResponse = {
  ok: boolean;
  status: number;
  value: unknown;
};

export type WithMateMemoryRuntimeCandidate = {
  source: "registry" | "legacy" | "explicit";
  applicationInstanceId: string | null;
  runtimeGenerationId: string;
  buildChannel: RuntimeBuildChannel;
  pid: number | null;
  leaseState: "fresh" | "expired" | "legacy" | "explicit";
  active: boolean;
};

export type WithMateMemoryRuntimeResolution =
  | {
      kind: "selected";
      connection: WithMateMemoryRuntimeConnection;
      candidate: WithMateMemoryRuntimeCandidate;
      candidates: WithMateMemoryRuntimeCandidate[];
    }
  | {
      kind: "error";
      code: RuntimeDiscoverySelectionOutcomeCode;
      candidates: WithMateMemoryRuntimeCandidate[];
    };

export type WithMateMemoryPublicDiscoveryCode =
  | "WITHMATE_RUNTIME_UNAVAILABLE"
  | "WITHMATE_RUNTIME_INSTANCE_MISMATCH"
  | "WITHMATE_RUNTIME_GENERATION_CHANGED"
  | "WITHMATE_RUNTIME_AMBIGUOUS"
  | "WITHMATE_RUNTIME_STALE"
  | "WITHMATE_RUNTIME_REGISTRY_CAPACITY"
  | "WITHMATE_RUNTIME_SELECTOR_INVALID"
  | "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE";

export class WithMateMemoryRuntimeExchangeError extends Error {
  readonly dispatched: boolean;
  readonly discoveryCode?: WithMateMemoryPublicDiscoveryCode;

  constructor(
    message: string,
    dispatched: boolean,
    options?: ErrorOptions & { discoveryCode?: WithMateMemoryPublicDiscoveryCode },
  ) {
    super(message, options);
    this.name = "WithMateMemoryRuntimeExchangeError";
    this.dispatched = dispatched;
    this.discoveryCode = options?.discoveryCode;
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const WITHMATE_MEMORY_API_SECRET_HEADER = "x-withmate-memory-api-secret";

export function mapRuntimeHttpFailureToCharacterContext(
  response: WithMateMemoryRuntimeResponse,
): unknown {
  if (response.ok || isCharacterContextError(response.value)) {
    return response.value;
  }
  const code: CharacterContextErrorCode = response.status === 401 || response.status === 403
    ? "authority_denied"
    : response.status === 404
      ? "migration_required"
      : response.status === 413 || response.status === 415 || response.status === 422
        ? "invalid_input"
        : "storage_unavailable";
  return createCharacterContextError(code, "WithMate runtime rejected the Character context request.", {
    retryable: response.status === 429 || response.status >= 500,
    conversationMayContinue: true,
    effect: "none",
    details: { httpStatus: response.status },
  });
}

export function isMemoryErrorResponse(value: unknown): value is MemoryErrorResponse {
  return typeof value === "object"
    && value !== null
    && (value as { schemaVersion?: unknown }).schemaVersion === "withmate-memory-v1"
    && typeof (value as { error?: { code?: unknown } }).error?.code === "string";
}

export function createMemoryRuntimeError(
  code: string,
  message: string,
  options: {
    retryable: boolean;
    conversationMayContinue: boolean;
    effect: "none" | "committed" | "partial" | "unknown";
    details?: Record<string, unknown>;
  },
): MemoryErrorResponse {
  return createMemoryErrorResponse({ code, message, ...options });
}

export function mapRuntimeHttpFailureToMemory(
  response: WithMateMemoryRuntimeResponse,
  operationKind: "read" | "write" = "read",
): unknown {
  if (isMemoryErrorResponse(response.value)) {
    if (response.value.error.effect) {
      return response.value;
    }
    return createMemoryErrorResponse({
      ...response.value.error,
      effect: operationKind === "write" && response.status >= 500 ? "unknown" : "none",
    });
  }
  if (response.ok) {
    return response.value;
  }
  const code = response.status === 401
    ? "MEMORY_UNAUTHORIZED"
    : response.status === 403
      ? "MEMORY_FORBIDDEN"
      : response.status === 404
        ? "MEMORY_ROUTE_NOT_FOUND"
        : response.status === 413
          ? "MEMORY_REQUEST_TOO_LARGE"
          : response.status === 415
            ? "MEMORY_UNSUPPORTED_MEDIA_TYPE"
            : response.status === 429
              ? "MEMORY_TOO_MANY_REQUESTS"
              : response.status >= 500
                ? "MEMORY_STORAGE_UNAVAILABLE"
                : "MEMORY_INVALID_REQUEST";
  return createMemoryRuntimeError(code, "WithMate runtime rejected the Memory request.", {
    retryable: response.status === 429 || response.status >= 500,
    conversationMayContinue: true,
    effect: operationKind === "write" && response.status >= 500 ? "unknown" : "none",
    details: { httpStatus: response.status },
  });
}

function usageError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_CLI_USAGE",
    message,
    retryable: false,
    conversationMayContinue: true,
    effect: "none",
  });
}

function transportError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
    effect: "none",
  });
}

function readRequiredEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function resolveAdapterSecret(env: NodeJS.ProcessEnv, adapter: WithMateMemoryAdapterKind): string | undefined {
  return readRequiredEnvValue(
    env,
    adapter === "cli" ? "WITHMATE_MEMORY_OPERATOR_API_SECRET" : "WITHMATE_MEMORY_MCP_API_SECRET",
  );
}

function buildConnectionFromValues(input: {
  adapter: WithMateMemoryAdapterKind;
  baseUrl: string;
  apiSecret?: string;
  adapterSecret?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  /** Legacy boundary; use runtimeGenerationId for new callers. */
  runtimeInstanceId?: string;
}): WithMateMemoryRuntimeConnection | null {
  const runtimeGenerationId = input.runtimeGenerationId ?? input.runtimeInstanceId;
  if (!input.apiSecret || !input.adapterSecret || !runtimeGenerationId) {
    return null;
  }
  return {
    api: {
      baseUrl: input.baseUrl,
      apiSecret: input.apiSecret,
      ...(input.applicationInstanceId ? { applicationInstanceId: input.applicationInstanceId } : {}),
      runtimeGenerationId,
      runtimeInstanceId: runtimeGenerationId,
    },
    credential: {
      adapter: input.adapter,
      adapterSecret: input.adapterSecret,
    },
  };
}

async function readDiscoveryProjection(
  pointerFilePath: string,
  adapter: WithMateMemoryAdapterKind,
  read: typeof readFile,
): Promise<Partial<WithMateMemoryDiscoveryDocument> | null> {
  const first = JSON.parse(await read(pointerFilePath, "utf8")) as Partial<WithMateMemoryDiscoveryPointer | WithMateMemoryDiscoveryDocument>;
  if (first.schemaVersion === WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION) {
    return first as Partial<WithMateMemoryDiscoveryDocument>;
  }
  if (
    first.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_POINTER_SCHEMA_VERSION
    || typeof first.runtimeInstanceId !== "string"
    || !first.runtimeInstanceId.trim()
  ) {
    return null;
  }
  const generationFilePath = path.join(
    path.dirname(pointerFilePath),
    buildWithMateMemoryDiscoveryGenerationFileName(adapter, first.runtimeInstanceId),
  );
  const document = JSON.parse(await read(generationFilePath, "utf8")) as Partial<WithMateMemoryDiscoveryDocument>;
  return document.runtimeInstanceId === first.runtimeInstanceId ? document : null;
}

type InternalMemoryRuntimeCandidate = {
  safe: WithMateMemoryRuntimeCandidate;
  connection: WithMateMemoryRuntimeConnection | null;
  credentialUnavailable: boolean;
};

const MEMORY_RUNTIME_KIND = "memory";
const KNOWN_MEMORY_DISCOVERY_KEYS = new Set([
  "schemaVersion",
  "adapter",
  "baseUrl",
  "apiSecret",
  "adapterSecret",
  "applicationInstanceId",
  "runtimeGenerationId",
  "runtimeInstanceId",
  "buildChannel",
  "publishedAt",
]);
const KNOWN_CREDENTIAL_ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "applicationInstanceId",
  "runtimeKind",
  "adapterKind",
  "runtimeGenerationId",
  "credential",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isBuildChannel(value: unknown): value is RuntimeBuildChannel {
  return value === "installed" || value === "development" || value === "visual-check" || value === "unknown";
}

function parseRegistryMemoryCredential(
  serialized: string,
  record: RuntimeDiscoveryRegistryRecord,
  adapter: WithMateMemoryAdapterKind,
): WithMateMemoryRuntimeConnection | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)
    || !hasOnlyKnownKeys(value, KNOWN_CREDENTIAL_ENVELOPE_KEYS)
    || value.schemaVersion !== "withmate-runtime-credential-v1"
    || value.applicationInstanceId !== record.entry.applicationInstanceId
    || value.runtimeKind !== MEMORY_RUNTIME_KIND
    || value.adapterKind !== adapter
    || value.runtimeGenerationId !== record.entry.runtimeGenerationId
    || !isRecord(value.credential)
    || !hasOnlyKnownKeys(value.credential, KNOWN_MEMORY_DISCOVERY_KEYS)) {
    return null;
  }
  const envelope = value as RuntimeDiscoveryCredentialEnvelope<Record<string, unknown>>;
  const document = envelope.credential;
  if (document.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
    || document.adapter !== adapter
    || document.applicationInstanceId !== record.entry.applicationInstanceId
    || document.runtimeGenerationId !== record.entry.runtimeGenerationId
    || document.runtimeInstanceId !== record.entry.runtimeGenerationId
    || typeof document.baseUrl !== "string"
    || (document.buildChannel !== undefined && document.buildChannel !== record.entry.buildChannel)) {
    return null;
  }
  const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
  if (!baseUrl) {
    return null;
  }
  return buildConnectionFromValues({
    adapter,
    baseUrl,
    apiSecret: typeof document.apiSecret === "string" ? document.apiSecret.trim() : undefined,
    adapterSecret: typeof document.adapterSecret === "string" ? document.adapterSecret.trim() : undefined,
    applicationInstanceId: record.entry.applicationInstanceId,
    runtimeGenerationId: record.entry.runtimeGenerationId,
  });
}

function buildRegistrySafeCandidate(
  record: RuntimeDiscoveryRegistryRecord,
  now: Date,
  active: boolean,
  staleThresholdMs = RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
): WithMateMemoryRuntimeCandidate {
  return {
    source: "registry",
    applicationInstanceId: record.entry.applicationInstanceId,
    runtimeGenerationId: record.entry.runtimeGenerationId,
    buildChannel: record.entry.buildChannel,
    pid: record.entry.process.pid,
    leaseState: getRuntimeDiscoveryLeaseState(record.entry, now, staleThresholdMs),
    active,
  };
}

function candidateMatchesSelector(
  candidate: InternalMemoryRuntimeCandidate,
  applicationInstanceId: string | undefined,
  runtimeGenerationId: string | undefined,
): boolean {
  return (!applicationInstanceId || candidate.safe.applicationInstanceId === applicationInstanceId)
    && (!runtimeGenerationId || candidate.safe.runtimeGenerationId === runtimeGenerationId);
}

function toSafeCandidates(candidates: InternalMemoryRuntimeCandidate[]): WithMateMemoryRuntimeCandidate[] {
  return candidates.map(({ safe }) => safe);
}

function candidateDedupeKey(candidate: InternalMemoryRuntimeCandidate): string {
  if (candidate.safe.applicationInstanceId) {
    return `${candidate.safe.applicationInstanceId}\0${candidate.safe.runtimeGenerationId}`;
  }
  const baseUrl = candidate.connection?.api.baseUrl ?? "";
  return `legacy\0${candidate.safe.runtimeGenerationId}\0${baseUrl}`;
}

function dedupeCandidates(candidates: InternalMemoryRuntimeCandidate[]): InternalMemoryRuntimeCandidate[] {
  const result = new Map<string, InternalMemoryRuntimeCandidate>();
  for (const candidate of candidates) {
    let key = candidateDedupeKey(candidate);
    if (candidate.safe.source === "legacy") {
      const registryMatch = candidates.find((other) => other.safe.source === "registry"
        && other.safe.runtimeGenerationId === candidate.safe.runtimeGenerationId
        && other.connection?.api.baseUrl === candidate.connection?.api.baseUrl
        && (candidate.safe.applicationInstanceId === null
          || other.safe.applicationInstanceId === candidate.safe.applicationInstanceId));
      if (registryMatch) {
        key = candidateDedupeKey(registryMatch);
      }
    }
    const existing = result.get(key);
    if (!existing) {
      result.set(key, candidate);
      continue;
    }
    if (existing.safe.source === "legacy" && candidate.safe.source === "registry") {
      result.set(key, {
        safe: candidate.safe,
        connection: candidate.connection ?? existing.connection,
        credentialUnavailable: candidate.connection === null && existing.connection === null,
      });
    } else if (existing.safe.source === "registry"
      && candidate.safe.source === "legacy"
      && existing.connection === null) {
      result.set(key, {
        safe: existing.safe,
        connection: candidate.connection,
        credentialUnavailable: candidate.connection === null,
      });
    }
  }
  return [...result.values()];
}

function discoveryError(
  code: RuntimeDiscoverySelectionOutcomeCode,
  candidates: InternalMemoryRuntimeCandidate[],
): WithMateMemoryRuntimeResolution {
  return { kind: "error", code, candidates: toSafeCandidates(candidates) };
}

export function mapWithMateMemoryDiscoveryCode(
  code: RuntimeDiscoverySelectionOutcomeCode,
): WithMateMemoryPublicDiscoveryCode {
  switch (code) {
    case "runtime_instance_mismatch":
      return "WITHMATE_RUNTIME_INSTANCE_MISMATCH";
    case "runtime_generation_changed":
      return "WITHMATE_RUNTIME_GENERATION_CHANGED";
    case "runtime_ambiguous":
      return "WITHMATE_RUNTIME_AMBIGUOUS";
    case "runtime_stale":
      return "WITHMATE_RUNTIME_STALE";
    case "runtime_registry_capacity":
      return "WITHMATE_RUNTIME_REGISTRY_CAPACITY";
    case "runtime_selector_invalid":
    case "runtime_invalid":
      return "WITHMATE_RUNTIME_SELECTOR_INVALID";
    case "runtime_credential_unavailable":
      return "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE";
    case "runtime_unavailable":
      return "WITHMATE_RUNTIME_UNAVAILABLE";
  }
}

function safeDiscoveryDetails(result: Extract<WithMateMemoryRuntimeResolution, { kind: "error" }>) {
  return {
    discoveryCode: mapWithMateMemoryDiscoveryCode(result.code),
    candidates: result.candidates,
  };
}

export function createMemoryRuntimeDiscoveryError(
  result: Extract<WithMateMemoryRuntimeResolution, { kind: "error" }>,
): MemoryErrorResponse {
  return createMemoryRuntimeError(
    mapWithMateMemoryDiscoveryCode(result.code),
    "WithMate Memory runtime discovery could not select a runtime.",
    {
      retryable: result.code === "runtime_unavailable" || result.code === "runtime_stale",
      conversationMayContinue: true,
      effect: "none",
      details: safeDiscoveryDetails(result),
    },
  );
}

export function createCharacterRuntimeDiscoveryError(
  result: Extract<WithMateMemoryRuntimeResolution, { kind: "error" }>,
): unknown {
  return createCharacterContextError(
    "storage_unavailable",
    "WithMate runtime discovery could not select a runtime.",
    {
      retryable: result.code === "runtime_unavailable" || result.code === "runtime_stale",
      conversationMayContinue: true,
      effect: "none",
      details: safeDiscoveryDetails(result),
    },
  );
}

export async function resolveWithMateMemoryApi(
  options: {
    adapter: WithMateMemoryAdapterKind;
    env?: NodeJS.ProcessEnv;
    apiUrl?: string;
    registryRootDirectoryPath?: string;
    registryDirectoryPath?: string;
    legacyDiscoveryFilePath?: string;
    discoveryFilePath?: string;
    applicationInstanceId?: string;
    runtimeGenerationId?: string;
    readFile?: typeof readFile;
    fetch?: typeof fetch;
    clock?: RuntimeDiscoveryClock;
    staleThresholdMs?: number;
    signal?: AbortSignal;
  },
): Promise<WithMateMemoryRuntimeResolution> {
  const env = options.env ?? process.env;
  const bindingRequired = env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1";
  const envApplicationInstanceId = readRequiredEnvValue(env, WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV);
  const envRuntimeGenerationId = readRequiredEnvValue(env, WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV);
  if (bindingRequired && (!envApplicationInstanceId || !envRuntimeGenerationId)) {
    return discoveryError("runtime_selector_invalid", []);
  }

  const applicationInstanceId = bindingRequired
    ? envApplicationInstanceId
    : options.applicationInstanceId ?? envApplicationInstanceId;
  const runtimeGenerationId = bindingRequired
    ? envRuntimeGenerationId
    : options.runtimeGenerationId ?? envRuntimeGenerationId;
  if ((applicationInstanceId && !isUuid(applicationInstanceId))
    || (runtimeGenerationId && !isUuid(runtimeGenerationId))
    || (runtimeGenerationId && !applicationInstanceId)) {
    return discoveryError("runtime_selector_invalid", []);
  }

  const explicitApiUrl = options.apiUrl ?? env.WITHMATE_MEMORY_API_URL?.trim();
  if (explicitApiUrl) {
    const baseUrl = normalizeWithMateMemoryApiBaseUrl(explicitApiUrl);
    if (!baseUrl) {
      return discoveryError("runtime_selector_invalid", []);
    }
    const connection = buildConnectionFromValues({
      adapter: options.adapter,
      baseUrl,
      apiSecret: readRequiredEnvValue(env, "WITHMATE_MEMORY_API_SECRET"),
      adapterSecret: resolveAdapterSecret(env, options.adapter),
      applicationInstanceId,
      runtimeGenerationId,
      runtimeInstanceId: readRequiredEnvValue(env, "WITHMATE_MEMORY_RUNTIME_INSTANCE_ID"),
    });
    if (!connection || (bindingRequired && !connection.api.applicationInstanceId)) {
      return discoveryError("runtime_credential_unavailable", []);
    }
    const candidate: WithMateMemoryRuntimeCandidate = {
      source: "explicit",
      applicationInstanceId: connection.api.applicationInstanceId ?? null,
      runtimeGenerationId: connection.api.runtimeGenerationId,
      buildChannel: "unknown",
      pid: null,
      leaseState: "explicit",
      active: true,
    };
    return { kind: "selected", connection, candidate, candidates: [candidate] };
  }

  const now = options.clock?.now() ?? new Date();
  const staleThresholdMs = options.staleThresholdMs ?? RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS;
  const fetchImpl = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const registryRootDirectoryPath = options.registryRootDirectoryPath ?? options.registryDirectoryPath;
  const registryCandidates: InternalMemoryRuntimeCandidate[] = [];
  try {
    const snapshot = await listRuntimeDiscoveryRegistryEntries(registryRootDirectoryPath);
    for (const record of snapshot.records) {
      if (record.entry.schemaVersion !== RUNTIME_DISCOVERY_REGISTRY_SCHEMA_VERSION
        || record.entry.runtimeKind !== MEMORY_RUNTIME_KIND) {
        continue;
      }
      const credential = await readRuntimeDiscoveryCredential(record, options.adapter);
      const connection = credential === null
        ? null
        : parseRegistryMemoryCredential(credential, record, options.adapter);
      const fresh = getRuntimeDiscoveryLeaseState(record.entry, now, staleThresholdMs) === "fresh";
      registryCandidates.push({
        safe: buildRegistrySafeCandidate(record, now, fresh, staleThresholdMs),
        connection,
        credentialUnavailable: connection === null,
      });
    }
  } catch {
    return discoveryError("runtime_unavailable", []);
  }

  const targetedRegistryCandidates = applicationInstanceId
    ? registryCandidates.filter((candidate) => candidateMatchesSelector(
      candidate,
      applicationInstanceId,
      runtimeGenerationId,
    ))
    : registryCandidates;
  for (const candidate of targetedRegistryCandidates) {
    if (candidate.safe.leaseState !== "expired" || !candidate.connection) {
      continue;
    }
    try {
      candidate.safe.active = await verifyRuntimeIdentity(candidate.connection.api, fetchImpl, signal);
    } catch {
      candidate.safe.active = false;
    }
  }

  const legacyCandidates: InternalMemoryRuntimeCandidate[] = [];
  if (!bindingRequired) {
    const read = options.readFile ?? readFile;
    const envDiscoveryFilePath = env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim();
    const legacyDiscoveryFilePath = options.legacyDiscoveryFilePath
      ?? options.discoveryFilePath
      ?? (envDiscoveryFilePath || resolveDefaultWithMateMemoryDiscoveryFilePath(env, options.adapter));
    try {
      const document = await readDiscoveryProjection(legacyDiscoveryFilePath, options.adapter, read);
      if (document?.schemaVersion === WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
        && document.adapter === options.adapter
        && typeof document.baseUrl === "string") {
        const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
        const legacyGeneration = typeof document.runtimeGenerationId === "string"
          ? document.runtimeGenerationId.trim()
          : typeof document.runtimeInstanceId === "string"
            ? document.runtimeInstanceId.trim()
            : undefined;
        const legacyApplication = typeof document.applicationInstanceId === "string"
          ? document.applicationInstanceId.trim()
          : undefined;
        const selectorMatches = (!applicationInstanceId || legacyApplication === applicationInstanceId)
          && (!runtimeGenerationId || legacyGeneration === runtimeGenerationId);
        if (baseUrl && legacyGeneration && selectorMatches) {
          const connection = buildConnectionFromValues({
            adapter: options.adapter,
            baseUrl,
            apiSecret: typeof document.apiSecret === "string" ? document.apiSecret.trim() : undefined,
            adapterSecret: typeof document.adapterSecret === "string" ? document.adapterSecret.trim() : undefined,
            applicationInstanceId: legacyApplication,
            runtimeGenerationId: legacyGeneration,
          });
          if (connection) {
            let active = false;
            try {
              active = await verifyRuntimeIdentity(connection.api, fetchImpl, signal);
            } catch {
              active = false;
            }
            legacyCandidates.push({
              connection,
              credentialUnavailable: false,
              safe: {
                source: "legacy",
                applicationInstanceId: legacyApplication ?? null,
                runtimeGenerationId: legacyGeneration,
                buildChannel: isBuildChannel(document.buildChannel) ? document.buildChannel : "unknown",
                pid: null,
                leaseState: "legacy",
                active,
              },
            });
          }
        }
      }
    } catch {
      // A missing or malformed legacy projection is not a registry failure.
    }
  }

  const allCandidates = dedupeCandidates([...registryCandidates, ...legacyCandidates]);
  const matching = allCandidates.filter((candidate) => candidateMatchesSelector(
    candidate,
    applicationInstanceId,
    runtimeGenerationId,
  ));
  if (applicationInstanceId && matching.length === 0) {
    const sameApplication = allCandidates.filter(
      (candidate) => candidate.safe.applicationInstanceId === applicationInstanceId,
    );
    if (runtimeGenerationId && sameApplication.length > 0) {
      return discoveryError("runtime_generation_changed", sameApplication);
    }
    return discoveryError(
      allCandidates.length > 0 ? "runtime_instance_mismatch" : "runtime_unavailable",
      allCandidates,
    );
  }
  const active = matching.filter((candidate) => candidate.safe.active);
  if (active.length === 0) {
    return discoveryError(matching.length > 0 ? "runtime_stale" : "runtime_unavailable", matching);
  }
  if (active.length > 1) {
    return discoveryError("runtime_ambiguous", matching);
  }
  const selected = active[0]!;
  if (selected.credentialUnavailable || selected.connection === null) {
    return discoveryError("runtime_credential_unavailable", matching);
  }
  return {
    kind: "selected",
    connection: selected.connection,
    candidate: selected.safe,
    candidates: toSafeCandidates(allCandidates),
  };
}

export async function discoverWithMateMemoryApi(
  options: {
    adapter: WithMateMemoryAdapterKind;
    env?: NodeJS.ProcessEnv;
    apiUrl?: string;
    discoveryFilePath?: string;
    readFile?: typeof readFile;
  },
): Promise<WithMateMemoryRuntimeConnection | null> {
  const env = options.env ?? process.env;
  const explicitApiUrl = options.apiUrl ?? env.WITHMATE_MEMORY_API_URL?.trim();
  if (explicitApiUrl) {
    const baseUrl = normalizeWithMateMemoryApiBaseUrl(explicitApiUrl);
    if (!baseUrl) {
      throw usageError(`${options.apiUrl !== undefined ? "--api-url" : "WITHMATE_MEMORY_API_URL"} must be a valid loopback HTTP URL.`);
    }
    return buildConnectionFromValues({
      adapter: options.adapter,
      baseUrl,
      apiSecret: readRequiredEnvValue(env, "WITHMATE_MEMORY_API_SECRET"),
      adapterSecret: resolveAdapterSecret(env, options.adapter),
      applicationInstanceId: readRequiredEnvValue(env, WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_ID_ENV),
      runtimeGenerationId: readRequiredEnvValue(env, WITHMATE_MEMORY_RUNTIME_GENERATION_ID_ENV),
      runtimeInstanceId: readRequiredEnvValue(env, "WITHMATE_MEMORY_RUNTIME_INSTANCE_ID"),
    });
  }

  const envDiscoveryFilePath = env.WITHMATE_MEMORY_DISCOVERY_FILE?.trim();
  const discoveryFilePath = options.discoveryFilePath
    ?? (envDiscoveryFilePath || resolveDefaultWithMateMemoryDiscoveryFilePath(env, options.adapter));
  const read = options.readFile ?? readFile;

  try {
    const document = await readDiscoveryProjection(discoveryFilePath, options.adapter, read);
    if (
      document?.schemaVersion !== WITHMATE_MEMORY_DISCOVERY_SCHEMA_VERSION
      || document.adapter !== options.adapter
      || typeof document.baseUrl !== "string"
    ) {
      return null;
    }
    const baseUrl = normalizeWithMateMemoryApiBaseUrl(document.baseUrl);
    if (!baseUrl) {
      return null;
    }
    return buildConnectionFromValues({
      adapter: options.adapter,
      baseUrl,
      apiSecret: typeof document.apiSecret === "string" ? document.apiSecret.trim() : undefined,
      adapterSecret: typeof document.adapterSecret === "string" ? document.adapterSecret.trim() : undefined,
      applicationInstanceId: typeof document.applicationInstanceId === "string"
        ? document.applicationInstanceId.trim()
        : undefined,
      runtimeGenerationId: typeof document.runtimeGenerationId === "string"
        ? document.runtimeGenerationId.trim()
        : undefined,
      runtimeInstanceId: typeof document.runtimeInstanceId === "string" ? document.runtimeInstanceId.trim() : undefined,
    });
  } catch {
    return null;
  }
}

export async function callWithMateMemoryRuntime(
  connection: WithMateMemoryRuntimeConnection,
  operation: WithMateMemoryRuntimeOperation,
  options: {
    signal: AbortSignal;
    bindingReference?: string;
    turnCapability?: string;
    exchangePath?: string;
    fetch?: typeof fetch;
  },
): Promise<WithMateMemoryRuntimeResponse> {
  let identityOutcome: RuntimeIdentityVerificationOutcome;
  try {
    identityOutcome = await verifyRuntimeIdentityOutcome(
      connection.api,
      options.fetch ?? fetch,
      options.signal,
    );
  } catch (error) {
    throw new WithMateMemoryRuntimeExchangeError(
      "Memory API runtime identity preflight failed.",
      false,
      { cause: error, discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE" },
    );
  }
  if (!identityOutcome.ok) {
    throw new WithMateMemoryRuntimeExchangeError(
      "Memory API runtime identity could not be verified.",
      false,
      { discoveryCode: identityOutcome.discoveryCode },
    );
  }

  const nonce = randomBytes(16).toString("base64url");
  const exchangeUrl = new URL(options.exchangePath ?? WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH, connection.api.baseUrl);

  return new Promise<WithMateMemoryRuntimeResponse>((resolve, reject) => {
    let dispatched = false;
    let identityVerified = false;
    let settled = false;
    const fail = (
      message: string,
      cause?: unknown,
      discoveryCode?: WithMateMemoryPublicDiscoveryCode,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new WithMateMemoryRuntimeExchangeError(message, dispatched, {
        ...(cause === undefined ? {} : { cause }),
        ...(discoveryCode === undefined ? {} : { discoveryCode }),
      }));
    };
    let request: ReturnType<typeof httpRequest>;
    try {
      request = httpRequest({
        protocol: exchangeUrl.protocol,
        hostname: exchangeUrl.hostname,
        port: exchangeUrl.port,
        path: exchangeUrl.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WITHMATE_MEMORY_RUNTIME_NONCE_HEADER]: nonce,
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: connection.api.runtimeGenerationId,
          [WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER]: connection.api.runtimeGenerationId,
          ...(connection.api.applicationInstanceId
            ? { [WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER]: connection.api.applicationInstanceId }
            : {}),
        },
        signal: options.signal,
      }, (response) => {
        if (!identityVerified) {
          response.destroy();
          request.destroy();
          fail("Memory API returned a final response before runtime identity was verified.");
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("error", (error) => fail("Memory API response failed.", error));
        response.on("end", () => {
          if (settled) {
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.trim()) {
            fail("Memory API returned a non-JSON response.");
            return;
          }
          try {
            const value = JSON.parse(text) as unknown;
            settled = true;
            resolve({
              ok: typeof response.statusCode === "number" && response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode ?? 500,
              value,
            });
          } catch (error) {
            fail("Memory API returned a non-JSON response.", error);
          }
        });
      });
    } catch (error) {
      fail("Memory API request could not be created.", error);
      return;
    }

    request.on("information", (information) => {
      if (settled || identityVerified || information.statusCode !== 103) {
        return;
      }
      const runtimeInstanceId = information.headers[WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER];
      const runtimeGenerationId = information.headers[WITHMATE_MEMORY_RUNTIME_GENERATION_HEADER];
      const applicationInstanceId = information.headers[WITHMATE_MEMORY_RUNTIME_APPLICATION_INSTANCE_HEADER];
      const challenge = information.headers[WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER];
      const expected = createWithMateMemoryRuntimeChallenge(
        connection.api.apiSecret,
        connection.api.runtimeGenerationId,
        nonce,
      );
      if (runtimeInstanceId !== connection.api.runtimeGenerationId
        || (runtimeGenerationId !== undefined && runtimeGenerationId !== connection.api.runtimeGenerationId)
        || (connection.api.applicationInstanceId && runtimeGenerationId !== connection.api.runtimeGenerationId)
        || (connection.api.applicationInstanceId && applicationInstanceId !== connection.api.applicationInstanceId)) {
        request.destroy();
        const discoveryCode = connection.api.applicationInstanceId
          && applicationInstanceId !== connection.api.applicationInstanceId
          ? "WITHMATE_RUNTIME_INSTANCE_MISMATCH"
          : "WITHMATE_RUNTIME_GENERATION_CHANGED";
        fail("Memory API runtime identity could not be verified.", undefined, discoveryCode);
        return;
      }
      if (challenge !== expected) {
        request.destroy();
        fail(
          "Memory API runtime identity challenge could not be verified.",
          undefined,
          "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE",
        );
        return;
      }
      identityVerified = true;
      dispatched = true;
      request.end(JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
        apiSecret: connection.api.apiSecret,
        adapter: connection.credential.adapter,
        adapterSecret: connection.credential.adapterSecret,
        ...(options.bindingReference ? { bindingReference: options.bindingReference } : {}),
        ...(options.turnCapability ? { turnCapability: options.turnCapability } : {}),
        operation,
      }));
    });
    request.on("error", (error) => fail("Memory API request failed.", error));
    options.signal.addEventListener("abort", () => fail("Memory API request was aborted."), { once: true });
    try {
      request.flushHeaders();
    } catch (error) {
      request.destroy();
      fail("Memory API request could not be dispatched.", error);
    }
  });
}

export function resolveAgentRuntimeBindingReference(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]?.trim();
  if (!reference && env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1") {
    throw usageError("WithMate provider execution requires its runtime binding reference.");
  }
  return reference || undefined;
}

export function resolveAgentRuntimeTurnCapability(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const capability = env[WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY_ENV]?.trim();
  return capability || undefined;
}

type RuntimeIdentityVerificationOutcome =
  | { ok: true }
  | { ok: false; discoveryCode: WithMateMemoryPublicDiscoveryCode };

async function verifyRuntimeIdentityOutcome(
  connection: WithMateMemoryApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<RuntimeIdentityVerificationOutcome> {
  const nonce = randomBytes(16).toString("base64url");
  const response = await fetchImpl(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_UNAVAILABLE" };
  }
  const text = await response.text();
  if (!text.trim()) {
    throw transportError("Memory API returned a non-JSON response.");
  }
  let status: {
    applicationInstanceId?: unknown;
    runtimeGenerationId?: unknown;
    runtimeInstanceId?: unknown;
    challenge?: { nonce?: unknown; hmacSha256?: unknown; ownerHmacSha256?: unknown };
  };
  try {
    status = JSON.parse(text) as typeof status;
  } catch {
    throw transportError("Memory API returned a non-JSON response.");
  }
  const expectedLegacyChallenge = createHmac("sha256", connection.apiSecret).update(nonce, "utf8").digest("base64url");
  if (connection.applicationInstanceId
    && status.applicationInstanceId !== connection.applicationInstanceId) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_INSTANCE_MISMATCH" };
  }
  if (status.runtimeInstanceId !== connection.runtimeGenerationId
    || (status.runtimeGenerationId !== undefined
      && status.runtimeGenerationId !== connection.runtimeGenerationId)
    || (connection.applicationInstanceId
      && status.runtimeGenerationId !== connection.runtimeGenerationId)) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_GENERATION_CHANGED" };
  }
  if (status.challenge?.nonce !== nonce
    || status.challenge.hmacSha256 !== expectedLegacyChallenge) {
    return { ok: false, discoveryCode: "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE" };
  }
  if (!connection.applicationInstanceId) {
    return { ok: true };
  }
  const expectedOwnerChallenge = createWithMateMemoryRuntimeOwnerChallenge(
    connection.apiSecret,
    connection.applicationInstanceId,
    connection.runtimeGenerationId,
    nonce,
  );
  return status.challenge.ownerHmacSha256 === expectedOwnerChallenge
    ? { ok: true }
    : { ok: false, discoveryCode: "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE" };
}

export async function verifyRuntimeIdentity(
  connection: WithMateMemoryApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  return (await verifyRuntimeIdentityOutcome(connection, fetchImpl, signal)).ok;
}
