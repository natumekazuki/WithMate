import assert from "node:assert/strict";
import test from "node:test";

import { PERSISTENCE_PROTOCOL_VERSION } from "../src/shared/persistence-protocol.js";
import {
  decodeMainToWorkerMessage,
  decodeWorkerToMainMessage,
  isCanonicalUuid,
  isPlainObject,
} from "../src/shared/persistence-runtime-protocol.js";

const generationId = "018f1f4e-7f0a-7000-8000-000000000001";
const requestId = "018f1f4e-7f0a-7000-8000-000000000002";

test("MainToWorkerのrequest、cancel、shutdownをdecodeする", () => {
  const request = {
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId,
    requestSequence: 1,
    operation: "session.list",
    requestClass: "read",
    payload: { limit: 20 },
  };

  assert.deepEqual(decodeMainToWorkerMessage(request), { ok: true, value: request });
  for (const kind of ["cancel", "shutdown"] as const) {
    const message = { protocolVersion: PERSISTENCE_PROTOCOL_VERSION, generationId, kind, requestId };
    assert.deepEqual(decodeMainToWorkerMessage(message), { ok: true, value: message });
  }
});

test("WorkerToMainのlifecycleとresponseをdecodeする", () => {
  const messages = [
    { protocolVersion: PERSISTENCE_PROTOCOL_VERSION, generationId, kind: "ready" },
    {
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "startupFailed",
      error: { code: "database_unavailable", message: "Database is unavailable.", retryable: true, effect: "none" },
    },
    {
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "response",
      requestId,
      ok: true,
      result: { items: [] },
    },
    {
      protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
      generationId,
      kind: "response",
      requestId,
      ok: false,
      error: { code: "operation_failed", message: "Operation failed.", retryable: false, effect: "unknown" },
    },
    { protocolVersion: PERSISTENCE_PROTOCOL_VERSION, generationId, kind: "closed", requestId, checkpoint: "completed" },
  ];

  for (const message of messages) {
    assert.deepEqual(decodeWorkerToMainMessage(message), { ok: true, value: message });
  }
});

test("version不一致と未知kindを区別して拒否する", () => {
  assert.deepEqual(decodeMainToWorkerMessage({ protocolVersion: 2, generationId, kind: "shutdown", requestId }), {
    ok: false,
    code: "protocol_version_unsupported",
  });
  assert.deepEqual(
    decodeMainToWorkerMessage({ protocolVersion: PERSISTENCE_PROTOCOL_VERSION, generationId, kind: "other" }),
    { ok: false, code: "protocol_invalid" },
  );
});

test("非canonical UUID、非plain payload、余分なfieldを拒否する", () => {
  const base = {
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId,
    requestSequence: 1,
    operation: "session.list",
    requestClass: "read",
    payload: {},
  };

  assert.equal(decodeMainToWorkerMessage({ ...base, requestId: requestId.toUpperCase() }).ok, false);
  assert.equal(decodeMainToWorkerMessage({ ...base, payload: [] }).ok, false);
  assert.equal(decodeMainToWorkerMessage({ ...base, extra: true }).ok, false);
  assert.equal(decodeMainToWorkerMessage({ ...base, operation: "Session List" }).ok, false);
  assert.equal(decodeMainToWorkerMessage({ ...base, requestSequence: 0 }).ok, false);
  assert.equal(decodeMainToWorkerMessage({ ...base, requestSequence: 1.5 }).ok, false);
});

test("unsafe error codeと過剰なmessageを拒否する", () => {
  const base = {
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "response",
    requestId,
    ok: false,
  };

  assert.equal(
    decodeWorkerToMainMessage({
      ...base,
      error: { code: "SQLITE_IOERR", message: "raw path", retryable: false, effect: "unknown" },
    }).ok,
    false,
  );
  assert.equal(
    decodeWorkerToMainMessage({
      ...base,
      error: { code: "internal_error", message: "x".repeat(513), retryable: false, effect: "unknown" },
    }).ok,
    false,
  );
});

test("canonical UUIDとplain object guardを公開する", () => {
  assert.equal(isCanonicalUuid(generationId), true);
  assert.equal(isCanonicalUuid(generationId.toUpperCase()), false);
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
});
