import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import {
  SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION,
  SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION,
  buildSessionRuntimeDiscoveryGenerationFileName,
  resolveDefaultSessionRuntimeDiscoveryFilePath,
  type SessionRuntimeDiscoveryDocument,
  type SessionRuntimeDiscoveryPointer,
} from "../src/session-runtime-discovery.js";
import {
  SESSION_RUNTIME_ADAPTER_HEADER,
  SESSION_RUNTIME_ADAPTER_SECRET_HEADER,
  SESSION_RUNTIME_API_SECRET_HEADER,
  SESSION_RUNTIME_CHALLENGE_HEADER,
  SESSION_RUNTIME_INSTANCE_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
  createSessionRuntimeChallenge,
} from "../src/session-runtime-exchange.js";
import type {
  SessionRuntimeAdapterKind,
  SessionRuntimeRequestEnvelope,
} from "../src/session-external-runtime-contract.js";

export type SessionRuntimeConnection = {
  adapter: SessionRuntimeAdapterKind;
  baseUrl: string;
  apiSecret: string;
  adapterSecret: string;
  runtimeInstanceId: string;
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

export async function discoverSessionRuntime(options: {
  adapter?: SessionRuntimeAdapterKind;
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  discoveryFilePath?: string;
  read?: typeof readFile;
} = {}): Promise<SessionRuntimeConnection | null> {
  const adapter = options.adapter ?? "cli";
  const env = options.env ?? process.env;
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
      runtimeInstanceId: env.WITHMATE_SESSION_RUNTIME_INSTANCE_ID,
    });
  }

  const discoveryFilePath = options.discoveryFilePath
    ?? env.WITHMATE_SESSION_DISCOVERY_FILE?.trim()
    ?? resolveDefaultSessionRuntimeDiscoveryFilePath(env);
  const read = options.read ?? readFile;
  try {
    const pointer = JSON.parse(await read(discoveryFilePath, "utf8")) as Partial<SessionRuntimeDiscoveryPointer>;
    if (
      pointer.schemaVersion !== SESSION_RUNTIME_DISCOVERY_POINTER_SCHEMA_VERSION
      || typeof pointer.runtimeInstanceId !== "string"
      || !pointer.runtimeInstanceId.trim()
    ) {
      return null;
    }
    const generationPath = path.join(
      path.dirname(discoveryFilePath),
      buildSessionRuntimeDiscoveryGenerationFileName(adapter, pointer.runtimeInstanceId),
    );
    const document = JSON.parse(await read(generationPath, "utf8")) as Partial<SessionRuntimeDiscoveryDocument>;
    if (
      document.schemaVersion !== SESSION_RUNTIME_DISCOVERY_SCHEMA_VERSION
      || document.adapter !== adapter
      || document.runtimeInstanceId !== pointer.runtimeInstanceId
      || typeof document.baseUrl !== "string"
    ) {
      return null;
    }
    const baseUrl = normalizeLoopbackBaseUrl(document.baseUrl);
    return baseUrl ? buildConnection({ ...document, adapter, baseUrl }) : null;
  } catch {
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
  return value.runtimeInstanceId === connection.runtimeInstanceId
    && challenge?.nonce === nonce
    && typeof challenge.hmacSha256 === "string"
    && safeEqual(
      challenge.hmacSha256,
      createHmac("sha256", connection.apiSecret)
        .update(`${connection.runtimeInstanceId}\n${nonce}`, "utf8")
        .digest("base64url"),
    );
}

export async function callSessionRuntime(
  connection: SessionRuntimeConnection,
  envelope: SessionRuntimeRequestEnvelope,
  signal: AbortSignal,
): Promise<SessionRuntimeClientResponse> {
  let identityVerified = false;
  try {
    identityVerified = await verifySessionRuntimeIdentity(connection, signal);
  } catch (error) {
    throw new SessionRuntimeClientError("Session runtime identity check failed.", false, { cause: error });
  }
  if (!identityVerified) {
    throw new SessionRuntimeClientError("Session runtime identity mismatch.", false);
  }

  const nonce = randomBytes(16).toString("base64url");
  const body = JSON.stringify(envelope);
  const url = new URL(SESSION_RUNTIME_OPERATION_PATH, connection.baseUrl);
  return requestJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      [SESSION_RUNTIME_API_SECRET_HEADER]: connection.apiSecret,
      [SESSION_RUNTIME_ADAPTER_HEADER]: connection.adapter,
      [SESSION_RUNTIME_ADAPTER_SECRET_HEADER]: connection.adapterSecret,
      [SESSION_RUNTIME_INSTANCE_HEADER]: connection.runtimeInstanceId,
      [SESSION_RUNTIME_NONCE_HEADER]: nonce,
      [SESSION_RUNTIME_CHALLENGE_HEADER]: createSessionRuntimeChallenge(
        connection.apiSecret,
        connection.runtimeInstanceId,
        nonce,
      ),
    },
    body,
    signal,
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
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode ?? 0,
            value: text.trim() ? JSON.parse(text) : {},
          });
        } catch (error) {
          reject(new SessionRuntimeClientError("Session runtime returned invalid JSON.", dispatched, { cause: error }));
        }
      });
    });
    request.once("finish", () => { dispatched = options.method === "POST"; });
    request.once("error", (error) => reject(new SessionRuntimeClientError("Session runtime request failed.", dispatched, { cause: error })));
    request.end(options.body);
  });
}

function buildConnection(input: {
  adapter: SessionRuntimeAdapterKind;
  baseUrl: string;
  apiSecret?: string;
  adapterSecret?: string;
  runtimeInstanceId?: string;
}): SessionRuntimeConnection | null {
  const apiSecret = input.apiSecret?.trim();
  const adapterSecret = input.adapterSecret?.trim();
  const runtimeInstanceId = input.runtimeInstanceId?.trim();
  return apiSecret && adapterSecret && runtimeInstanceId
    ? { adapter: input.adapter, baseUrl: input.baseUrl, apiSecret, adapterSecret, runtimeInstanceId }
    : null;
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
