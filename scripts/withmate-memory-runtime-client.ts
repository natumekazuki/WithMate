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
import { createMemoryErrorResponse } from "../src/memory-v6/memory-response-contract.js";
import {
  createWithMateMemoryRuntimeChallenge,
  WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH,
  WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER,
  WITHMATE_MEMORY_RUNTIME_NONCE_HEADER,
} from "../src/memory-v6/memory-runtime-exchange.js";

export type WithMateMemoryApiConnection = {
  baseUrl: string;
  apiSecret: string;
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

export class WithMateMemoryRuntimeExchangeError extends Error {
  readonly dispatched: boolean;

  constructor(message: string, dispatched: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "WithMateMemoryRuntimeExchangeError";
    this.dispatched = dispatched;
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

function usageError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_CLI_USAGE",
    message,
  });
}

function transportError(message: string) {
  return createMemoryErrorResponse({
    code: "WITHMATE_MEMORY_TRANSPORT_ERROR",
    message,
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
  runtimeInstanceId?: string;
}): WithMateMemoryRuntimeConnection | null {
  if (!input.apiSecret || !input.adapterSecret || !input.runtimeInstanceId) {
    return null;
  }
  return {
    api: {
      baseUrl: input.baseUrl,
      apiSecret: input.apiSecret,
      runtimeInstanceId: input.runtimeInstanceId,
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
      runtimeInstanceId: typeof document.runtimeInstanceId === "string" ? document.runtimeInstanceId.trim() : undefined,
    });
  } catch {
    return null;
  }
}

export async function callWithMateMemoryRuntime(
  connection: WithMateMemoryRuntimeConnection,
  operation: WithMateMemoryRuntimeOperation,
  options: { signal: AbortSignal },
): Promise<WithMateMemoryRuntimeResponse> {
  const nonce = randomBytes(16).toString("base64url");
  const exchangeUrl = new URL(WITHMATE_MEMORY_RUNTIME_EXCHANGE_PATH, connection.api.baseUrl);

  return new Promise<WithMateMemoryRuntimeResponse>((resolve, reject) => {
    let dispatched = false;
    let identityVerified = false;
    let settled = false;
    const fail = (message: string, cause?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new WithMateMemoryRuntimeExchangeError(message, dispatched, cause === undefined ? undefined : { cause }));
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
          [WITHMATE_MEMORY_RUNTIME_INSTANCE_HEADER]: connection.api.runtimeInstanceId,
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
      const challenge = information.headers[WITHMATE_MEMORY_RUNTIME_CHALLENGE_HEADER];
      const expected = createWithMateMemoryRuntimeChallenge(connection.api.apiSecret, connection.api.runtimeInstanceId, nonce);
      if (runtimeInstanceId !== connection.api.runtimeInstanceId || challenge !== expected) {
        request.destroy();
        fail("Memory API runtime identity could not be verified.");
        return;
      }
      identityVerified = true;
      dispatched = true;
      request.end(JSON.stringify({
        schemaVersion: WITHMATE_MEMORY_RUNTIME_EXCHANGE_SCHEMA_VERSION,
        apiSecret: connection.api.apiSecret,
        adapter: connection.credential.adapter,
        adapterSecret: connection.credential.adapterSecret,
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

export async function verifyRuntimeIdentity(
  connection: WithMateMemoryApiConnection,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  const nonce = randomBytes(16).toString("base64url");
  const response = await fetchImpl(`${connection.baseUrl}/v1/status?nonce=${encodeURIComponent(nonce)}`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    return false;
  }
  const text = await response.text();
  if (!text.trim()) {
    throw transportError("Memory API returned a non-JSON response.");
  }
  let status: {
    runtimeInstanceId?: unknown;
    challenge?: { nonce?: unknown; hmacSha256?: unknown };
  };
  try {
    status = JSON.parse(text) as typeof status;
  } catch {
    throw transportError("Memory API returned a non-JSON response.");
  }
  const expectedChallenge = createHmac("sha256", connection.apiSecret).update(nonce, "utf8").digest("base64url");
  return status.runtimeInstanceId === connection.runtimeInstanceId
    && status.challenge?.nonce === nonce
    && status.challenge.hmacSha256 === expectedChallenge;
}
