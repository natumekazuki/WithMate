
import {
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
  type GlossaryOperationError,
  type GlossaryRuntimeEnvelope,
} from "../../../src-shared/glossary/glossary-contract.js";
import type { GlossaryRuntimeOperation } from "../../../src-shared/glossary/glossary-operation-schema.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../agent-runtime/runtime-exchange.js";
import type { RuntimeDiscoveryClock } from "../runtime-discovery/runtime-discovery-contract.js";
import {
  callAgentRuntime,
  mapAgentRuntimeDiscoveryCode,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  resolveAgentRuntimeApi,
  AgentRuntimeExchangeError,
  type AgentRuntimeConnection,
  type AgentRuntimeOperation,
  type AgentRuntimePublicDiscoveryCode,
  type AgentRuntimeResponse,
  type AgentRuntimeResolution,
} from "../agent-runtime/runtime-client.js";

export type GlossaryRuntimeClientDeps = {
  adapter: "cli" | "mcp";
  env?: NodeJS.ProcessEnv;
  connection?: AgentRuntimeConnection;
  apiUrl?: string;
  applicationInstanceId?: string;
  runtimeGenerationId?: string;
  registryRootDirectoryPath?: string;
  clock?: RuntimeDiscoveryClock;
  staleThresholdMs?: number;
  fetch?: typeof fetch;
  runtimeCall?: (
    connection: AgentRuntimeConnection,
    operation: AgentRuntimeOperation,
    options: {
      signal: AbortSignal;
      bindingReference?: string;
      turnCapability?: string;
      exchangePath?: string;
    },
  ) => Promise<AgentRuntimeResponse>;
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
  discoveryCode: AgentRuntimePublicDiscoveryCode,
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
  discoveryCode: AgentRuntimePublicDiscoveryCode,
  candidates: Extract<AgentRuntimeResolution, { kind: "error" }>["candidates"] = [],
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
  resolution: Extract<AgentRuntimeResolution, { kind: "error" }>,
): GlossaryRuntimeEnvelope<GlossaryOperationError> {
  return createGlossaryPublicDiscoveryError(
    mapAgentRuntimeDiscoveryCode(resolution.code),
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
  let resolution: AgentRuntimeResolution | { kind: "selected"; connection: AgentRuntimeConnection };
  try {
    resolution = deps.connection ? { kind: "selected", connection: deps.connection } : await resolveAgentRuntimeApi({
      adapter: deps.adapter,
      env: deps.env,
      apiUrl: deps.apiUrl,
      applicationInstanceId: deps.applicationInstanceId,
      runtimeGenerationId: deps.runtimeGenerationId,
      registryRootDirectoryPath: deps.registryRootDirectoryPath,
      clock: deps.clock,
      staleThresholdMs: deps.staleThresholdMs,
      fetch: deps.fetch,
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
    const response = await (deps.runtimeCall ?? callAgentRuntime)(connection, {
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
    const wasDispatched = error instanceof AgentRuntimeExchangeError
      ? error.dispatched
      : dispatched;
    if (error instanceof AgentRuntimeExchangeError && !wasDispatched && error.discoveryCode) {
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
