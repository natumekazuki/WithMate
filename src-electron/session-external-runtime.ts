import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";

import {
  SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION,
  SESSION_RUNTIME_KIND,
  parseSessionRuntimeCredentialEnvelope,
  type SessionRuntimeCredentialEnvelope,
} from "../src/session-runtime-discovery.js";
import type { SessionRuntimeAdapterKind } from "../src/session-external-runtime-contract.js";
import { createSessionRuntimeChallenge } from "../src/session-runtime-exchange.js";
import {
  isUuid,
  type RuntimeBuildChannel,
  type RuntimeDiscoveryClock,
  type RuntimeDiscoveryRegistryLimits,
  type RuntimeDiscoveryTimers,
  SYSTEM_RUNTIME_DISCOVERY_CLOCK,
} from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  publishRuntimeDiscoveryEntry,
  readRuntimeDiscoveryCredential,
  type RuntimeDiscoveryRegistryChallenge,
  type RuntimeDiscoveryRegistryPublication,
  type RuntimePathSecurity,
} from "../src/runtime-discovery/runtime-discovery-registry.js";
import {
  createSessionRuntimeHttpServer,
  type SessionRuntimeHttpServerOptions,
  type SessionRuntimeHttpHandler,
  type SessionRuntimeHttpServer,
} from "./session-runtime-http-server.js";
import { secureWindowsRuntimePath } from "./runtime-path-security.js";

export type StartSessionExternalRuntimeOptions = {
  applicationInstanceId: string;
  buildChannel: RuntimeBuildChannel;
  processStartedAt: string;
  handle: SessionRuntimeHttpHandler;
  agentRuntimeBindingRegistry?: SessionRuntimeHttpServerOptions["agentRuntimeBindingRegistry"];
  registryRootDirectoryPath?: string;
  runtimeDiscoveryLimits?: Partial<RuntimeDiscoveryRegistryLimits>;
  runtimeDiscoveryClock?: RuntimeDiscoveryClock;
  runtimeDiscoveryTimers?: RuntimeDiscoveryTimers;
  runtimePathSecurity?: RuntimePathSecurity;
  onHeartbeatError?: (error: unknown) => void;
};

export type SessionExternalRuntimeHandle = {
  baseUrl: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  stop(): Promise<void>;
};

export type PublishSessionRuntimeDiscoveryOptions = {
  applicationInstanceId: string;
  runtimeGenerationId?: string;
  buildChannel: RuntimeBuildChannel;
  processStartedAt: string;
  baseUrl: string;
  apiSecret: string;
  cliSecret: string;
  mcpSecret: string;
  registryRootDirectoryPath?: string;
  limits?: Partial<RuntimeDiscoveryRegistryLimits>;
  clock?: RuntimeDiscoveryClock;
  timers?: RuntimeDiscoveryTimers;
  security?: RuntimePathSecurity;
  challenge?: RuntimeDiscoveryRegistryChallenge;
  onHeartbeatError?: (error: unknown) => void;
};

export async function startSessionExternalRuntime(
  options: StartSessionExternalRuntimeOptions,
): Promise<SessionExternalRuntimeHandle> {
  if (!isUuid(options.applicationInstanceId)) {
    throw new Error("Session runtime applicationInstanceId must be a UUID.");
  }
  const apiSecret = createSecret();
  const cliSecret = createSecret();
  const mcpSecret = createSecret();
  const runtimeGenerationId = randomUUID();
  let server: SessionRuntimeHttpServer | null = null;
  let publication: RuntimeDiscoveryRegistryPublication | null = null;
  try {
    server = createSessionRuntimeHttpServer({
      apiSecret,
      cliSecret,
      mcpSecret,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      agentRuntimeBindingRegistry: options.agentRuntimeBindingRegistry,
      handle: options.handle,
    });
    await server.start();
    const address = server.address();
    if (!address) {
      throw new Error("Session runtime did not expose an HTTP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    publication = await publishSessionRuntimeDiscovery({
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      buildChannel: options.buildChannel,
      processStartedAt: options.processStartedAt,
      baseUrl,
      apiSecret,
      cliSecret,
      mcpSecret,
      ...(options.registryRootDirectoryPath
        ? { registryRootDirectoryPath: options.registryRootDirectoryPath }
        : {}),
      ...(options.runtimeDiscoveryLimits ? { limits: options.runtimeDiscoveryLimits } : {}),
      ...(options.runtimeDiscoveryClock ? { clock: options.runtimeDiscoveryClock } : {}),
      ...(options.runtimeDiscoveryTimers ? { timers: options.runtimeDiscoveryTimers } : {}),
      ...(options.runtimePathSecurity ? { security: options.runtimePathSecurity } : {}),
      ...(options.onHeartbeatError ? { onHeartbeatError: options.onHeartbeatError } : {}),
    });
    return {
      baseUrl,
      applicationInstanceId: options.applicationInstanceId,
      runtimeGenerationId,
      async stop(): Promise<void> {
        const errors: unknown[] = [];
        await publication?.unpublish().catch((error) => errors.push(error));
        await server?.stop().catch((error) => errors.push(error));
        await publication?.cleanupGeneration().catch((error) => errors.push(error));
        if (errors.length > 0) {
          throw new AggregateError(errors, "Session runtime cleanup failed.");
        }
      },
    };
  } catch (error) {
    await publication?.unpublish().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await publication?.cleanupGeneration().catch(() => undefined);
    throw error;
  }
}

export async function publishSessionRuntimeDiscovery(
  options: PublishSessionRuntimeDiscoveryOptions,
): Promise<RuntimeDiscoveryRegistryPublication> {
  const runtimeGenerationId = options.runtimeGenerationId ?? randomUUID();
  if (!isUuid(options.applicationInstanceId) || !isUuid(runtimeGenerationId)) {
    throw new Error("Session runtime discovery identity must contain UUIDs.");
  }
  const identity = {
    applicationInstanceId: options.applicationInstanceId,
    runtimeKind: SESSION_RUNTIME_KIND,
    runtimeGenerationId,
  } as const;
  const clock = options.clock ?? SYSTEM_RUNTIME_DISCOVERY_CLOCK;
  const security = options.security ?? secureSessionRuntimePath;
  const credentialDocuments = ([
    ["cli", options.cliSecret],
    ["mcp", options.mcpSecret],
  ] as const).map(([adapterKind, adapterSecret]) => ({
    adapterKind,
    document: {
      schemaVersion: "withmate-runtime-credential-v1",
      ...identity,
      adapterKind,
      credential: {
        schemaVersion: SESSION_RUNTIME_CREDENTIAL_SCHEMA_VERSION,
        baseUrl: options.baseUrl,
        apiSecret: options.apiSecret,
        adapterSecret,
      },
    } satisfies SessionRuntimeCredentialEnvelope,
  }));
  const publication = await publishRuntimeDiscoveryEntry({
    ...(options.registryRootDirectoryPath ? { rootDirectoryPath: options.registryRootDirectoryPath } : {}),
    security,
    ...(options.limits ? { limits: options.limits } : {}),
    clock,
    ...(options.timers ? { timers: options.timers } : {}),
    identity,
    buildChannel: options.buildChannel,
    process: { pid: process.pid, startedAt: options.processStartedAt },
    credentialDocuments,
    challenge: options.challenge ?? challengeSessionRuntimeRegistryEntry,
    ...(options.onHeartbeatError ? { onHeartbeatError: options.onHeartbeatError } : {}),
  });
  publication.startHeartbeat();
  return publication;
}

async function challengeSessionRuntimeRegistryEntry(
  entry: Parameters<RuntimeDiscoveryRegistryChallenge>[0],
  slotDirectoryPath: string,
): Promise<boolean> {
  if (entry.runtimeKind !== SESSION_RUNTIME_KIND) {
    return true;
  }
  const record = { slotName: "challenge", entry, slotDirectoryPath };
  const serialized = await readRuntimeDiscoveryCredential(record, "cli");
  if (!serialized) return false;
  const envelope = parseSessionRuntimeCredentialEnvelope(serialized, record.entry, "cli");
  if (!envelope) return false;
  const credential = envelope.credential;
  const nonce = randomBytes(16).toString("base64url");
  try {
    const response = await fetch(
      new URL(`/v1/status?nonce=${encodeURIComponent(nonce)}`, credential.baseUrl),
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return false;
    const value = await response.json() as Record<string, unknown>;
    const challenge = value.challenge as Record<string, unknown> | undefined;
    return value.applicationInstanceId === entry.applicationInstanceId
      && value.runtimeGenerationId === entry.runtimeGenerationId
      && challenge?.nonce === nonce
      && challenge.hmacSha256 === createSessionRuntimeChallenge(
        credential.apiSecret,
        entry.applicationInstanceId,
        entry.runtimeGenerationId,
        nonce,
      );
  } catch {
    return false;
  }
}

async function secureSessionRuntimePath(targetPath: string, targetKind: "directory" | "file"): Promise<void> {
  if (process.platform === "win32") {
    await secureWindowsRuntimePath(targetPath, targetKind);
    return;
  }
  const expectedMode = targetKind === "directory" ? 0o700 : 0o600;
  const stats = await lstat(targetPath);
  const expectedType = targetKind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!expectedType || stats.isSymbolicLink()) {
    throw new Error(`Session runtime ${targetKind} must be a real ${targetKind}.`);
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new Error(`Session runtime ${targetKind} must be owned by the current OS user.`);
  }
  if ((stats.mode & 0o777) !== expectedMode) {
    await chmod(targetPath, expectedMode);
  }
  const verified = await lstat(targetPath);
  if ((targetKind === "directory" ? !verified.isDirectory() : !verified.isFile())
    || verified.isSymbolicLink()
    || (currentUid !== null && verified.uid !== currentUid)
    || (verified.mode & 0o777) !== expectedMode) {
    throw new Error(`Session runtime ${targetKind} security verification failed.`);
  }
}

function createSecret(): string {
  return randomBytes(32).toString("base64url");
}
