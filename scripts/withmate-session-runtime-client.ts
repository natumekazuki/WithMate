import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

import {
  SESSION_RUNTIME_KIND,
  WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID_ENV,
  WITHMATE_SESSION_RUNTIME_GENERATION_ID_ENV,
  parseSessionRuntimeCredentialEnvelope,
} from "../src/session-runtime-discovery.js";
import {
  SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER,
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  SESSION_RUNTIME_GENERATION_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../src/session-runtime-exchange.js";
import {
  WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV,
  WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV,
} from "../src/agent-runtime/agent-runtime-binding-contract.js";
import {
  RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS,
  isUuid,
  type RuntimeDiscoveryClock,
  type RuntimeDiscoverySelectionOutcomeCode,
} from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  listRuntimeDiscoveryRegistryEntries,
  readRuntimeDiscoveryCredential,
  type RuntimeDiscoveryRegistryChallenge,
} from "../src/runtime-discovery/runtime-discovery-registry.js";
import { selectRuntimeDiscoveryRecord } from "../src/runtime-discovery/runtime-discovery-selector.js";
import type {
  SessionRuntimeAdapterKind,
  SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  assertSessionRuntimeRequestBodySize,
} from "../src/session-external-runtime-contract.js";

export type SessionRuntimeConnection = {
  adapter: SessionRuntimeAdapterKind;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  applicationInstanceId: string;
  runtimeGenerationId: string;
  agentRuntimeBindingReference?: string;
};

export type SessionRuntimeClientResponse = {
  ok: boolean;
  status: number;
  value: unknown;
};

export class SessionRuntimeClientError extends Error {
  readonly dispatched: boolean;

  constructor(message: string, dispatched: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionRuntimeClientError";
    this.dispatched = dispatched;
  }
}

export class SessionRuntimeDiscoveryError extends Error {
  readonly code: RuntimeDiscoverySelectionOutcomeCode;

  constructor(code: RuntimeDiscoverySelectionOutcomeCode) {
    super(`Session runtime discovery failed: ${code}.`);
    this.name = "SessionRuntimeDiscoveryError";
    this.code = code;
  }
}

export function mapSessionRuntimeDiscoveryCode(code: RuntimeDiscoverySelectionOutcomeCode): string {
  switch (code) {
    case "runtime_ambiguous": return "RUNTIME_AMBIGUOUS";
    case "runtime_instance_mismatch": return "RUNTIME_INSTANCE_MISMATCH";
    case "runtime_generation_changed": return "RUNTIME_GENERATION_CHANGED";
    case "runtime_stale": return "RUNTIME_STALE";
    case "runtime_credential_unavailable": return "RUNTIME_CREDENTIAL_UNAVAILABLE";
    case "runtime_registry_capacity": return "RUNTIME_REGISTRY_CAPACITY";
    case "runtime_selector_invalid":
    case "runtime_invalid": return "RUNTIME_SELECTOR_INVALID";
    case "runtime_unavailable": return "RUNTIME_UNAVAILABLE";
  }
}

export async function discoverSessionRuntime(options: {
  adapter?: SessionRuntimeAdapterKind;
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  registryRootDirectoryPath?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  clock?: RuntimeDiscoveryClock;
  staleThresholdMs?: number;
  challenge?: RuntimeDiscoveryRegistryChallenge;
} = {}): Promise<SessionRuntimeConnection | null> {
  const adapter = options.adapter ?? "cli";
  const env = options.env ?? process.env;
  const agentRuntimeBindingReference = resolveAgentRuntimeBindingReference(env);
  const bindingRequired = env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1";
  const envApplicationInstanceId = env[WITHMATE_SESSION_RUNTIME_APPLICATION_INSTANCE_ID_ENV]?.trim();
  const envRuntimeGenerationId = env[WITHMATE_SESSION_RUNTIME_GENERATION_ID_ENV]?.trim();
  if (bindingRequired && (!envApplicationInstanceId || !envRuntimeGenerationId)) {
    throw new SessionRuntimeDiscoveryError("runtime_selector_invalid");
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
    throw new SessionRuntimeDiscoveryError("runtime_selector_invalid");
  }
  const explicitUrl = options.apiUrl ?? env.WITHMATE_SESSION_API_URL?.trim();
  if (explicitUrl) {
    const baseUrl = normalizeLoopbackBaseUrl(explicitUrl);
    if (!baseUrl) {
      throw new Error("Session runtime URL must be a loopback HTTP URL.");
    }
    return buildConnection({
      adapter,
      baseUrl,
      apiSecret: env.WITHMATE_SESSION_API_SECRET,
      adapterSecret: adapter === "cli" ? env.WITHMATE_SESSION_CLI_SECRET : env.WITHMATE_SESSION_MCP_SECRET,
      applicationInstanceId,
      runtimeGenerationId,
      agentRuntimeBindingReference,
    });
  }

  try {
    const snapshot = await listRuntimeDiscoveryRegistryEntries(options.registryRootDirectoryPath);
    const now = options.clock?.now() ?? new Date();
    const staleThresholdMs = options.staleThresholdMs ?? RUNTIME_DISCOVERY_DEFAULT_STALE_THRESHOLD_MS;
    const outcome = await selectRuntimeDiscoveryRecord({
      records: snapshot.records,
      selector: {
        runtimeKind: SESSION_RUNTIME_KIND,
        ...(applicationInstanceId ? { applicationInstanceId } : {}),
        ...(runtimeGenerationId ? { runtimeGenerationId } : {}),
      },
      now,
      staleThresholdMs,
      challenge: options.challenge ?? (async (entry, slotDirectoryPath) => {
        const record = { slotName: "challenge", entry, slotDirectoryPath };
        const serialized = await readRuntimeDiscoveryCredential(record, adapter);
        if (!serialized) return false;
        const envelope = parseSessionRuntimeCredentialEnvelope(serialized, entry, adapter);
        const baseUrl = envelope ? normalizeLoopbackBaseUrl(envelope.credential.baseUrl) : null;
        const connection = baseUrl && envelope ? buildConnection({
          adapter,
          baseUrl,
          apiSecret: envelope.credential.apiSecret,
          adapterSecret: envelope.credential.adapterSecret,
          applicationInstanceId: entry.applicationInstanceId,
          runtimeGenerationId: entry.runtimeGenerationId,
        }) : null;
        return connection
          ? verifySessionRuntimeIdentity(connection, AbortSignal.timeout(2_000)).catch(() => false)
          : false;
      }),
    });
    if (outcome.kind === "error") {
      if (outcome.code === "runtime_unavailable") return null;
      throw new SessionRuntimeDiscoveryError(outcome.code);
    }
    const serialized = await readRuntimeDiscoveryCredential(outcome.record, adapter);
    const envelope = serialized
      ? parseSessionRuntimeCredentialEnvelope(serialized, outcome.record.entry, adapter)
      : null;
    const baseUrl = envelope ? normalizeLoopbackBaseUrl(envelope.credential.baseUrl) : null;
    if (!envelope || !baseUrl) {
      throw new SessionRuntimeDiscoveryError("runtime_credential_unavailable");
    }
    return buildConnection({
      adapter,
      baseUrl,
      apiSecret: envelope.credential.apiSecret,
      adapterSecret: envelope.credential.adapterSecret,
      applicationInstanceId: outcome.record.entry.applicationInstanceId,
      runtimeGenerationId: outcome.record.entry.runtimeGenerationId,
      agentRuntimeBindingReference,
    });
  } catch (error) {
    if (error instanceof SessionRuntimeDiscoveryError) throw error;
    return null;
  }
}

export async function verifySessionRuntimeIdentity(
  connection: SessionRuntimeConnection,
  signal: AbortSignal,
): Promise<boolean> {
  const nonce = randomBytes(16).toString("base64url");
  const url = new URL(`/v1/status?nonce=${encodeURIComponent(nonce)}`, connection.baseUrl);
  const response = await requestJson(url, { method: "GET", headers: {}, signal });
  if (!response.ok || !response.value || typeof response.value !== "object") {
    return false;
  }
  const value = response.value as Record<string, unknown>;
  const challenge = value.challenge as Record<string, unknown> | undefined;
  return value.applicationInstanceId === connection.applicationInstanceId
    && value.runtimeGenerationId === connection.runtimeGenerationId
    && challenge?.nonce === nonce
    && typeof challenge.hmacSha256 === "string"
    && safeEqual(
      challenge.hmacSha256,
      createHmac("sha256", connection.apiSecret)
        .update(`${connection.applicationInstanceId}\n${connection.runtimeGenerationId}\n${nonce}`, "utf8")
        .digest("base64url"),
    );
}

export async function callSessionRuntime(
  connection: SessionRuntimeConnection,
  envelope: SessionRuntimeRequestEnvelope,
  signal: AbortSignal,
): Promise<SessionRuntimeClientResponse> {
  const nonce = randomBytes(16).toString("base64url");
  const body = JSON.stringify({
    schemaVersion: SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: connection.apiSecret,
    adapter: connection.adapter,
    adapterSecret: connection.adapterSecret,
    ...(connection.agentRuntimeBindingReference
      ? { agentRuntimeBindingReference: connection.agentRuntimeBindingReference }
      : {}),
    envelope,
  });
  assertSessionRuntimeRequestBodySize(Buffer.byteLength(body, "utf8"));
  const url = new URL(SESSION_RUNTIME_OPERATION_PATH, connection.baseUrl);
  return requestAuthenticatedJson(url, connection, nonce, body, signal);
}

function requestAuthenticatedJson(
  url: URL,
  connection: SessionRuntimeConnection,
  nonce: string,
  body: string,
  signal: AbortSignal,
): Promise<SessionRuntimeClientResponse> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    let identityVerified = false;
    let settled = false;
    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      reject(new SessionRuntimeClientError(message, dispatched, cause === undefined ? undefined : { cause }));
    };
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER]: connection.applicationInstanceId,
        [SESSION_RUNTIME_GENERATION_HEADER]: connection.runtimeGenerationId,
        [SESSION_RUNTIME_NONCE_HEADER]: nonce,
      },
      signal,
    }, (response) => {
      if (!identityVerified) {
        response.destroy();
        request.destroy();
        fail("Session runtime returned a final response before identity verification.");
        return;
      }
      void readJsonResponse(response).then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve({
            ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode ?? 0,
            value,
          });
        },
        (error: Error) => {
          response.destroy();
          request.destroy();
          fail(error.message, error);
        },
      );
    });
    request.on("information", (information) => {
      if (settled || identityVerified || information.statusCode !== 103) return;
      const applicationInstanceId = information.headers[SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER];
      const runtimeGenerationId = information.headers[SESSION_RUNTIME_GENERATION_HEADER];
      const challenge = information.headers[SESSION_RUNTIME_CHALLENGE_HEADER];
      const expected = createSessionRuntimeChallenge(
        connection.apiSecret,
        connection.applicationInstanceId,
        connection.runtimeGenerationId,
        nonce,
      );
      if (
        applicationInstanceId !== connection.applicationInstanceId
        || runtimeGenerationId !== connection.runtimeGenerationId
        || typeof challenge !== "string"
        || !safeEqual(challenge, expected)
      ) {
        request.destroy();
        fail("Session runtime identity mismatch.");
        return;
      }
      identityVerified = true;
      dispatched = true;
      request.end(body);
    });
    request.once("error", (error) => fail("Session runtime request failed.", error));
    try {
      request.flushHeaders();
    } catch (error) {
      request.destroy();
      fail("Session runtime request could not be dispatched.", error);
    }
  });
}

function requestJson(
  url: URL,
  options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<SessionRuntimeClientResponse> {
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      signal: options.signal,
    }, (response) => {
      void readJsonResponse(response).then(
        (value) => resolve({
          ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode ?? 0,
          value,
        }),
        (error: Error) => {
          response.destroy();
          request.destroy();
          reject(new SessionRuntimeClientError(error.message, dispatched, { cause: error }));
        },
      );
    });
    request.once("finish", () => { dispatched = options.method === "POST"; });
    request.once("error", (error) => reject(new SessionRuntimeClientError("Session runtime request failed.", dispatched, { cause: error })));
    request.end(options.body);
  });
}

async function readJsonResponse(response: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
    throw new Error("Session runtime response exceeds 8 MiB.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > SESSION_RUNTIME_MAX_RESPONSE_BYTES) {
      throw new Error("Session runtime response exceeds 8 MiB.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, totalBytes).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Session runtime returned invalid JSON.", { cause: error });
  }
}

function buildConnection(input: {
  adapter: SessionRuntimeAdapterKind;
  baseUrl: string;
  apiSecret?: string;
  adapterSecret?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  agentRuntimeBindingReference?: string;
}): SessionRuntimeConnection | null {
  const apiSecret = input.apiSecret?.trim();
  const adapterSecret = input.adapterSecret?.trim();
  const applicationInstanceId = input.applicationInstanceId?.trim();
  const runtimeGenerationId = input.runtimeGenerationId?.trim();
  return apiSecret && adapterSecret && applicationInstanceId && runtimeGenerationId
    ? {
        adapter: input.adapter,
        baseUrl: input.baseUrl,
        apiSecret,
        adapterSecret,
        applicationInstanceId,
        runtimeGenerationId,
        ...(input.agentRuntimeBindingReference
          ? { agentRuntimeBindingReference: input.agentRuntimeBindingReference }
          : {}),
      }
    : null;
}

export function resolveAgentRuntimeBindingReference(env: NodeJS.ProcessEnv): string | undefined {
  const reference = env[WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE_ENV]?.trim();
  if (!reference && env[WITHMATE_AGENT_RUNTIME_BINDING_REQUIRED_ENV]?.trim() === "1") {
    throw new Error("WithMate provider execution requires its runtime binding reference.");
  }
  return reference || undefined;
}

export function normalizeLoopbackBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost"
      || hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (
      url.protocol !== "http:"
      || !loopback
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
