import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  RUNTIME_IPC_LIMITS,
  RUNTIME_IPC_PROTOCOL_VERSION,
  RuntimeIpcProtocolError,
  RUNTIME_IPC_OPERATIONS,
  decodeRuntimeIpcEnvelope,
  deriveRuntimeRequestId,
  encodeRuntimeIpcEnvelope,
  type RuntimeIpcRequest,
  type RuntimeIpcOperation,
} from "../src/main/runtime-host/runtime-ipc-contract.js";
import { RuntimeIpcJsonlDecoder } from "../src/main/runtime-host/runtime-ipc-jsonl.js";
import { decodeRuntimeWireValue, encodeRuntimeWireValue } from "../src/main/runtime-host/runtime-ipc-value.js";

const clientId = "10f6e3df-348f-4f1e-9438-e5bf810f3248";
const generationId = "cdf145e4-e5b8-4c02-b07a-7a94b8201816";

test("runtime IPC handshake and request envelopes snapshot exact versioned fields", () => {
  assert.deepEqual(
    decodeRuntimeIpcEnvelope({
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "handshake_request",
      clientId,
    }),
    {
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "handshake_request",
      clientId,
    },
  );

  const request = runtimeRequest("session.read", { sessionId: "session_abc" });
  assert.deepEqual(decodeRuntimeIpcEnvelope(request), request);
  assert.equal(encodeRuntimeIpcEnvelope(request).endsWith("\n"), true);
});

test("runtime IPC request ID is coupled to client identity and monotonic sequence", () => {
  const first = deriveRuntimeRequestId(clientId, 1);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(first, deriveRuntimeRequestId(clientId, 1));
  assert.notEqual(first, deriveRuntimeRequestId(clientId, 2));
  assert.notEqual(first, deriveRuntimeRequestId(randomUUID(), 1));

  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        ...runtimeRequest("session.read", { sessionId: "session_abc" }),
        requestId: randomUUID(),
      }),
    protocolFailure("invalid_envelope"),
  );
});

test("runtime IPC rejects unknown fields, kinds, operations, authorization, and invalid payload combinations", () => {
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "handshake_request",
        clientId,
        extra: true,
      }),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
        kind: "mystery",
      }),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () => decodeRuntimeIpcEnvelope(runtimeRequest("session.missing", {})),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("session.read", {
          sessionId: "session_abc",
          authorization: { transport: "local_cli" },
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("session.close", {
          sessionId: "session_abc",
          idempotencyKey: randomUUID(),
          expectedLifecycleStatus: "closed",
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("run.output_chunk", {
          sessionId: "session_abc",
          runId: "run_abc",
          outputItemId: "item_abc",
          offset: 0,
          maxBytes: 256 * 1024 + 1,
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () => decodeRuntimeIpcEnvelope(runtimeRequest("session.list", { localRepositoryKeys: [] })),
    protocolFailure("invalid_envelope"),
  );
});

test("runtime IPC reports protocol version mismatch before applying version-specific exact fields", () => {
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        protocolVersion: "withmate-runtime-ipc-v2",
        kind: "handshake_request",
        clientId,
        versionTwoField: true,
      }),
    protocolFailure("version_mismatch"),
  );
});

test("runtime IPC failure codes admit only their defined execution and retry tuples", () => {
  const base = {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "response",
    hostGenerationId: generationId,
    clientId,
    requestId: deriveRuntimeRequestId(clientId, 1),
    requestSequence: 1,
    operation: "session.read",
    outcome: "failure",
  };
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        ...base,
        error: { code: "request_rejected", message: "Rejected.", retryable: false, execution: "started" },
      }),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope({
        ...base,
        error: { code: "operation_failed", message: "Failed.", retryable: false, execution: "not_started" },
      }),
    protocolFailure("invalid_envelope"),
  );
  assert.doesNotThrow(() =>
    decodeRuntimeIpcEnvelope({
      ...base,
      error: { code: "runtime_unavailable", message: "Unavailable.", retryable: false, execution: "unknown" },
    }),
  );
});

test("runtime IPC allowlist covers all 25 operational Application operations", () => {
  const idempotencyKey = randomUUID();
  const validPayloads = {
    "session.create": {
      title: "Title",
      workspacePath: "C:\\workspace",
      idempotencyKey,
      providerId: "codex",
      allowedAdditionalDirectories: [],
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 1,
    },
    "session.update_title": { sessionId: "session_abc", idempotencyKey, title: "Updated" },
    "session.list": { limit: 25 },
    "session.list_local_repositories": { limit: 25 },
    "session.read": { sessionId: "session_abc" },
    "session.read_directories_chunk": { sessionId: "session_abc", offset: 0, maxBytes: 256 * 1024 },
    "session.archive": { sessionId: "session_abc", idempotencyKey },
    "session.unarchive": { sessionId: "session_abc", idempotencyKey },
    "session.close": { sessionId: "session_abc", idempotencyKey, expectedLifecycleStatus: "active" },
    "session.delete": { sessionId: "session_abc", idempotencyKey },
    "session.messages": { sessionId: "session_abc", limit: 25 },
    "session.message_content_chunk": {
      sessionId: "session_abc",
      messageId: "message_abc",
      offset: 0,
      maxBytes: 256 * 1024,
    },
    "session.runs": { sessionId: "session_abc", limit: 25 },
    "run.start": {
      sessionId: "session_abc",
      idempotencyKey,
      contentBlocks: [{ type: "text", text: "hello" }],
      execution: {
        model: "gpt-test",
        reasoningEffort: "medium",
        sandbox: { mode: "workspace-write", networkAccess: false },
      },
    },
    "run.retry": {
      sessionId: "session_abc",
      retryOfRunId: "run_source",
      idempotencyKey,
      executionOverrides: {
        reasoningEffort: "high",
      },
    },
    "run.send_input": {
      sessionId: "session_abc",
      runId: "run_abc",
      idempotencyKey,
      contentBlocks: [{ type: "text", text: "continue" }],
    },
    "run.cancel": { sessionId: "session_abc", runId: "run_abc", idempotencyKey },
    "run.status": { sessionId: "session_abc", runId: "run_abc" },
    "run.events": { sessionId: "session_abc", runId: "run_abc", limit: 25 },
    "run.follow": { sessionId: "session_abc", runId: "run_abc", limit: 25, waitMs: 10_000, pollMs: 250 },
    "run.output_counts": { sessionId: "session_abc", runId: "run_abc" },
    "run.outputs": { sessionId: "session_abc", runId: "run_abc", limit: 25 },
    "run.output_preview": {
      sessionId: "session_abc",
      runId: "run_abc",
      outputItemId: "output_abc",
      maxBytes: 64 * 1024,
    },
    "run.output_chunk": {
      sessionId: "session_abc",
      runId: "run_abc",
      outputItemId: "output_abc",
      offset: 0,
      maxBytes: 256 * 1024,
    },
    "run.output_export": {
      sessionId: "session_abc",
      runId: "run_abc",
      outputItemId: "output_abc",
      destination: "C:\\exports\\output.bin",
    },
  } satisfies Record<RuntimeIpcOperation, unknown>;
  assert.equal(RUNTIME_IPC_OPERATIONS.length, 25);
  for (const operation of RUNTIME_IPC_OPERATIONS) {
    const decoded = decodeRuntimeIpcEnvelope(runtimeRequest(operation, validPayloads[operation]));
    assert.equal(decoded.kind, "request");
    if (decoded.kind !== "request") throw new Error("Expected a runtime request.");
    assert.equal(decoded.operation, operation);
  }
});

test("Run content mutations snapshot exact inline content and reject one byte beyond the IPC content limit", () => {
  const idempotencyKey = randomUUID();
  const emptyJsonBytes = Buffer.byteLength(JSON.stringify([{ type: "text", text: "" }]));
  const exactText = "a".repeat(64 * 1024 - emptyJsonBytes);
  const payload = {
    sessionId: "session_abc",
    idempotencyKey,
    contentBlocks: [{ type: "text", text: exactText }],
    execution: {
      model: "gpt-test",
      reasoningEffort: "medium",
      sandbox: { mode: "read-only", networkAccess: true },
    },
  };

  assert.doesNotThrow(() => decodeRuntimeIpcEnvelope(runtimeRequest("run.start", payload)));
  assert.doesNotThrow(() =>
    decodeRuntimeIpcEnvelope(
      runtimeRequest("run.send_input", {
        sessionId: "session_abc",
        runId: "run_abc",
        idempotencyKey,
        contentBlocks: payload.contentBlocks,
      }),
    ),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("run.send_input", {
          sessionId: "session_abc",
          runId: "run_abc",
          idempotencyKey,
          contentBlocks: [{ type: "text", text: `${exactText}a` }],
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("run.start", {
          ...payload,
          contentBlocks: [{ type: "text", text: `${exactText}a` }],
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("run.retry", {
          sessionId: "session_abc",
          retryOfRunId: "run_source",
          idempotencyKey,
          executionOverrides: { providerId: "attacker" },
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
});

test("runtime IPC operation payload arrays must be dense, bounded, and read once", () => {
  const sparse: string[] = [];
  sparse.length = 1;
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("session.create", {
          title: "Title",
          workspacePath: "C:\\workspace",
          idempotencyKey: randomUUID(),
          providerId: "codex",
          allowedAdditionalDirectories: sparse,
          defaultCharacterId: "character",
          maxConcurrentChildRuns: 1,
        }),
      ),
    protocolFailure("invalid_envelope"),
  );

  let reads = 0;
  const payload = {
    get sessionId() {
      reads += 1;
      return "session_abc";
    },
  };
  const decoded = decodeRuntimeIpcEnvelope(runtimeRequest("session.read", payload));
  assert.equal(decoded.kind, "request");
  if (decoded.kind !== "request") throw new Error("Expected a runtime request.");
  assert.deepEqual(decoded.payload, {
    sessionId: "session_abc",
  });
  assert.equal(reads, 1);

  const accessorArray = ["path"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    configurable: true,
    get: () => "C:\\other",
  });
  assert.throws(
    () =>
      decodeRuntimeIpcEnvelope(
        runtimeRequest("session.create", {
          title: "Title",
          workspacePath: "C:\\workspace",
          idempotencyKey: randomUUID(),
          providerId: "codex",
          allowedAdditionalDirectories: accessorArray,
          defaultCharacterId: "character",
          maxConcurrentChildRuns: 1,
        }),
      ),
    protocolFailure("invalid_envelope"),
  );
});

test("runtime IPC JSONL decoder handles split UTF-8 and exact line limits", () => {
  const envelope = runtimeRequest("session.read", { sessionId: "セッション" });
  const bytes = Buffer.from(encodeRuntimeIpcEnvelope(envelope));
  const decoded: unknown[] = [];
  const decoder = new RuntimeIpcJsonlDecoder(RUNTIME_IPC_LIMITS.maxLineBytes, RUNTIME_IPC_LIMITS.maxBufferedBytes);
  for (const byte of bytes) decoder.push(Uint8Array.of(byte), (value) => decoded.push(value));
  decoder.finish();
  assert.deepEqual(decoded, [envelope]);

  const exactLine = JSON.stringify({
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "handshake_request",
    clientId,
  });
  const exactDecoder = new RuntimeIpcJsonlDecoder(Buffer.byteLength(exactLine), Buffer.byteLength(exactLine));
  exactDecoder.push(Buffer.from(`${exactLine}\n`), () => undefined);
  exactDecoder.finish();

  const splitCrLfDecoder = new RuntimeIpcJsonlDecoder(Buffer.byteLength(exactLine), Buffer.byteLength(exactLine) + 1);
  splitCrLfDecoder.push(Buffer.from(`${exactLine}\r`), () => undefined);
  splitCrLfDecoder.push(Buffer.from("\n"), () => undefined);
  splitCrLfDecoder.finish();

  const oversized = new RuntimeIpcJsonlDecoder(Buffer.byteLength(exactLine) - 1, Buffer.byteLength(exactLine));
  assert.throws(
    () => oversized.push(Buffer.from(`${exactLine}\n`), () => undefined),
    protocolFailure("line_too_large"),
  );
});

test("runtime IPC JSONL decoder rejects invalid UTF-8, duplicate fields, partial lines, and aggregate buffering", () => {
  const invalidUtf8 = new RuntimeIpcJsonlDecoder();
  assert.throws(
    () => invalidUtf8.push(Uint8Array.of(0xc3, 0x28, 0x0a), () => undefined),
    protocolFailure("invalid_utf8"),
  );

  const duplicate = new RuntimeIpcJsonlDecoder();
  assert.throws(
    () =>
      duplicate.push(
        Buffer.from(
          `{"protocolVersion":"${RUNTIME_IPC_PROTOCOL_VERSION}","kind":"handshake_request","clientId":"${clientId}","clientId":"${clientId}"}\n`,
        ),
        () => undefined,
      ),
    protocolFailure("duplicate_field"),
  );

  const partial = new RuntimeIpcJsonlDecoder();
  partial.push(
    Buffer.from(
      `{"protocolVersion":"${RUNTIME_IPC_PROTOCOL_VERSION}","kind":"handshake_request","clientId":"${clientId}"}`,
    ),
    () => undefined,
  );
  assert.throws(() => partial.finish(), protocolFailure("partial_line"));

  const aggregate = new RuntimeIpcJsonlDecoder(1024, 8);
  assert.throws(() => aggregate.push(Buffer.from("123456789"), () => undefined), protocolFailure("buffer_too_large"));
});

test("runtime wire value codec is collision-free and lossless for binary limits", () => {
  const collisionCandidate = {
    tag: "bytes",
    encoding: "base64",
    byteLength: 1,
    data: "AA==",
  };
  const bytes = Uint8Array.from([0, 1, 2, 254, 255]).buffer;
  const encoded = encodeRuntimeWireValue({ collisionCandidate, bytes });
  const decoded = decodeRuntimeWireValue(encoded) as Readonly<Record<string, unknown>>;
  assert.deepEqual({ ...(decoded.collisionCandidate as Readonly<Record<string, unknown>>) }, collisionCandidate);
  assert.deepEqual(new Uint8Array(decoded.bytes as ArrayBuffer), new Uint8Array(bytes));

  const empty = decodeRuntimeWireValue(encodeRuntimeWireValue(new ArrayBuffer(0)));
  assert.equal((empty as ArrayBuffer).byteLength, 0);

  const maximum = new ArrayBuffer(RUNTIME_IPC_LIMITS.maxBinaryBytes);
  assert.equal((decodeRuntimeWireValue(encodeRuntimeWireValue(maximum)) as ArrayBuffer).byteLength, maximum.byteLength);
  assert.throws(
    () => encodeRuntimeWireValue(new ArrayBuffer(RUNTIME_IPC_LIMITS.maxBinaryBytes + 1)),
    protocolFailure("binary_too_large"),
  );
});

test("runtime wire value codec rejects malformed base64, declared length mismatch, and duplicate object entries", () => {
  assert.throws(
    () =>
      decodeRuntimeWireValue({
        tag: "bytes",
        encoding: "base64",
        byteLength: 1,
        data: "**",
      }),
    protocolFailure("invalid_binary"),
  );
  assert.throws(
    () =>
      decodeRuntimeWireValue({
        tag: "bytes",
        encoding: "base64",
        byteLength: 2,
        data: "AA==",
      }),
    protocolFailure("invalid_binary"),
  );
  assert.throws(
    () =>
      decodeRuntimeWireValue({
        tag: "object",
        entries: [
          ["same", { tag: "null" }],
          ["same", { tag: "null" }],
        ],
      }),
    protocolFailure("invalid_value"),
  );

  const arrayWithHiddenField = [{ tag: "null" }];
  Object.defineProperty(arrayWithHiddenField, "hidden", { value: true });
  assert.throws(
    () => decodeRuntimeWireValue({ tag: "array", items: arrayWithHiddenField }),
    protocolFailure("invalid_value"),
  );
});

function runtimeRequest(operation: string, payload: unknown): RuntimeIpcRequest {
  const requestSequence = 1;
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "request",
    hostGenerationId: generationId,
    clientId,
    requestId: deriveRuntimeRequestId(clientId, requestSequence),
    requestSequence,
    operation,
    payload,
  } as RuntimeIpcRequest;
}

function protocolFailure(code: RuntimeIpcProtocolError["code"]) {
  return (error: unknown) => error instanceof RuntimeIpcProtocolError && error.code === code;
}
