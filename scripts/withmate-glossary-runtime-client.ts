import type { readFile } from "node:fs/promises";

import {
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
  type GlossaryOperationError,
  type GlossaryRuntimeEnvelope,
} from "../src/glossary-contract.js";
import type { GlossaryRuntimeOperation } from "../src/glossary-operation-schema.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../src/memory-v6/memory-runtime-exchange.js";
import type { RuntimeDiscoveryClock } from "../src/runtime-discovery/runtime-discovery-contract.js";
import {
  callWithMateMemoryRuntime,
  mapWithMateMemoryDiscoveryCode,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  resolveWithMateMemoryApi,
  WithMateMemoryRuntimeExchangeError,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryPublicDiscoveryCode,
  type WithMateMemoryRuntimeResponse,
  type WithMateMemoryRuntimeResolution,
} from "./withmate-memory-runtime-client.js";

export type GlossaryRuntimeClientDeps = {
  adapter: "cli" | "mcp";
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  discoveryFilePath?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  registryRootDirectoryPath?: string;
  clock?: RuntimeDiscoveryClock;
  staleThresholdMs?: number;
  fetch?: typeof fetch;
  readFile?: typeof readFile;
  runtimeCall?: (
    connection: WithMateMemoryRuntimeConnection,
    operation: WithMateMemoryRuntimeOperation,
    options: {
      signal: AbortSignal;
      bindingReference?: string;
      turnCapability?: string;
      exchangePath?: string;
    },
  ) => Promise<WithMateMemoryRuntimeResponse>;
  requestTimeoutMs?: number;
};

export function isGlossaryRuntimeResult(value: unknown): value is GlossaryRuntimeEnvelope<object> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === GLOSSARY_RUNTIME_SCHEMA_VERSION,
  );
}

export function createGlossaryTransportError(
  message: string,
  effect: GlossaryOperationError["effect"] = "none",
): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return {
    schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
    ok: false,
    code: "GLOSSARY_TRANSPORT_ERROR",
    message,
    effect,
    retryable: effect === "none",
  };
}

function createGlossaryBindingRequiredError(): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return {
    schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
    ok: false,
    code: "GLOSSARY_SESSION_BINDING_REQUIRED",
    message: "Glossary operations require the active WithMate provider Session runtime binding.",
    effect: "none",
    retryable: false,
  };
}

function mapGlossaryRuntimeDiscoveryCode(
  discoveryCode: WithMateMemoryPublicDiscoveryCode,
): GlossaryOperationError["code"] {
  switch (discoveryCode) {
    case "WITHMATE_RUNTIME_INSTANCE_MISMATCH":
      return "GLOSSARY_RUNTIME_INSTANCE_MISMATCH";
    case "WITHMATE_RUNTIME_GENERATION_CHANGED":
      return "GLOSSARY_RUNTIME_GENERATION_CHANGED";
    case "WITHMATE_RUNTIME_AMBIGUOUS":
      return "GLOSSARY_RUNTIME_AMBIGUOUS";
    case "WITHMATE_RUNTIME_STALE":
      return "GLOSSARY_RUNTIME_STALE";
    case "WITHMATE_RUNTIME_REGISTRY_CAPACITY":
      return "GLOSSARY_RUNTIME_REGISTRY_CAPACITY";
    case "WITHMATE_RUNTIME_SELECTOR_INVALID":
      return "GLOSSARY_RUNTIME_SELECTOR_INVALID";
    case "WITHMATE_RUNTIME_CREDENTIAL_UNAVAILABLE":
      return "GLOSSARY_RUNTIME_CREDENTIAL_UNAVAILABLE";
    case "WITHMATE_RUNTIME_UNAVAILABLE":
      return "GLOSSARY_RUNTIME_UNAVAILABLE";
  }
}

function createGlossaryPublicDiscoveryError(
  discoveryCode: WithMateMemoryPublicDiscoveryCode,
  candidates: Extract<WithMateMemoryRuntimeResolution, { kind: "error" }>["candidates"] = [],
): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return {
    schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
    ok: false,
    code: mapGlossaryRuntimeDiscoveryCode(discoveryCode),
    message: "WithMate glossary runtime discovery could not select a runtime.",
    effect: "none",
    retryable: discoveryCode === "WITHMATE_RUNTIME_UNAVAILABLE" || discoveryCode === "WITHMATE_RUNTIME_STALE",
    details: {
      discoveryCode,
      candidates,
    },
  };
}

function createGlossaryRuntimeDiscoveryError(
  resolution: Extract<WithMateMemoryRuntimeResolution, { kind: "error" }>,
): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return createGlossaryPublicDiscoveryError(
    mapWithMateMemoryDiscoveryCode(resolution.code),
    resolution.candidates,
  );
}

function createGlossaryRequestTooLargeError(): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return {
    schemaVersion: GLOSSARY_RUNTIME_SCHEMA_VERSION,
    ok: false,
    code: "GLOSSARY_LIMIT_EXCEEDED",
    message: "Glossary runtime request body is too large.",
    effect: "none",
    retryable: false,
  };
}

function isWriteOperation(operation: GlossaryRuntimeOperation): boolean {
  return operation === "create"
    || operation === "create_batch"
    || operation === "update"
    || operation === "delete";
}

export async function callGlossaryRuntime(input: {
  operation: GlossaryRuntimeOperation;
  path: string;
  body: unknown;
}, deps: GlossaryRuntimeClientDeps): Promise<GlossaryRuntimeEnvelope<object>> {
  let bindingReference: string | undefined;
  let turnCapability: string | undefined;
  try {
    bindingReference = resolveAgentRuntimeBindingReference(deps.env);
    turnCapability = resolveAgentRuntimeTurnCapability(deps.env);
  } catch {
    return createGlossaryBindingRequiredError();
  }
  let resolution: WithMateMemoryRuntimeResolution;
  try {
    resolution = await resolveWithMateMemoryApi({
      adapter: deps.adapter,
      env: deps.env,
      apiUrl: deps.apiUrl,
      discoveryFilePath: deps.discoveryFilePath,
      applicationInstanceId: deps.applicationInstanceId,
      runtimeGenerationId: deps.runtimeGenerationId,
      registryRootDirectoryPath: deps.registryRootDirectoryPath,
      clock: deps.clock,
      staleThresholdMs: deps.staleThresholdMs,
      fetch: deps.fetch,
      readFile: deps.readFile,
    });
  } catch {
    return createGlossaryTransportError("WithMate runtime discovery failed.");
  }
  if (resolution.kind === "error") {
    return createGlossaryRuntimeDiscoveryError(resolution);
  }
  const connection = resolution.connection;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), deps.requestTimeoutMs ?? 10_000);
  let dispatched = false;
  try {
    const response = await (deps.runtimeCall ?? callWithMateMemoryRuntime)(connection, {
      method: "POST",
      path: input.path,
      body: input.body,
    }, {
      signal: abortController.signal,
      bindingReference,
      turnCapability,
      exchangePath: WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH,
    });
    dispatched = true;
    if (isGlossaryRuntimeResult(response.value)) {
      return response.value;
    }
    if (response.status === 413) {
      return createGlossaryRequestTooLargeError();
    }
    return createGlossaryTransportError(
      "WithMate runtime returned a non-glossary response.",
      isWriteOperation(input.operation) ? "unknown" : "none",
    );
  } catch (error) {
    const wasDispatched = error instanceof WithMateMemoryRuntimeExchangeError
      ? error.dispatched
      : dispatched;
    if (error instanceof WithMateMemoryRuntimeExchangeError && !wasDispatched && error.discoveryCode) {
      return createGlossaryPublicDiscoveryError(error.discoveryCode);
    }
    return createGlossaryTransportError(
      "WithMate glossary runtime request failed.",
      isWriteOperation(input.operation) && wasDispatched ? "unknown" : "none",
    );
  } finally {
    clearTimeout(timeout);
  }
}
