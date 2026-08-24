import type { readFile } from "node:fs/promises";

import {
  GLOSSARY_RUNTIME_SCHEMA_VERSION,
  type GlossaryOperationError,
  type GlossaryRuntimeEnvelope,
} from "../src/glossary-contract.js";
import type { GlossaryRuntimeOperation } from "../src/glossary-operation-schema.js";
import { WITHMATE_AGENT_RUNTIME_EXTENSION_EXCHANGE_PATH } from "../src/memory-v6/memory-runtime-exchange.js";
import {
  callWithMateMemoryRuntime,
  discoverWithMateMemoryApi,
  resolveAgentRuntimeBindingReference,
  resolveAgentRuntimeTurnCapability,
  WithMateMemoryRuntimeExchangeError,
  type WithMateMemoryRuntimeConnection,
  type WithMateMemoryRuntimeOperation,
  type WithMateMemoryRuntimeResponse,
} from "./withmate-memory-runtime-client.js";

export type GlossaryRuntimeClientDeps = {
  adapter: "cli" | "mcp";
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  discoveryFilePath?: string;
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
  let connection: WithMateMemoryRuntimeConnection | null;
  try {
    connection = await discoverWithMateMemoryApi({
      adapter: deps.adapter,
      env: deps.env,
      apiUrl: deps.apiUrl,
      discoveryFilePath: deps.discoveryFilePath,
      readFile: deps.readFile,
    });
  } catch {
    return createGlossaryTransportError("WithMate runtime discovery failed.");
  }
  if (!connection) {
    return createGlossaryTransportError("WithMate runtime is unavailable.");
  }
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
    return createGlossaryTransportError(
      "WithMate glossary runtime request failed.",
      isWriteOperation(input.operation) && wasDispatched ? "unknown" : "none",
    );
  } finally {
    clearTimeout(timeout);
  }
}
