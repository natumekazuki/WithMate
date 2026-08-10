import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  parseSessionRuntimeRequestEnvelope,
} from "../../src/session-external-runtime-contract.js";

const turn = {
  userMessage: "hello",
  model: "gpt-5.4",
  reasoningEffort: "high",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
};

test("Session runtime validator accepts an explicit deferred turn.run contract", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.run",
    input: {
      sessionId: "session-1",
      catalogRevision: 4,
      idempotencyKey: "key-1",
      responseMode: "deferred",
      turn,
    },
  });
  assert.deepEqual(parsed.input, {
    sessionId: "session-1",
    catalogRevision: 4,
    idempotencyKey: "key-1",
    responseMode: "deferred",
    turn,
  });
});

test("Session runtime validator rejects unknown fields and enqueue response mode", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.run",
      input: {
        sessionId: "session-1",
        catalogRevision: 4,
        idempotencyKey: "key-1",
        responseMode: "deferred",
        turn,
        apiSecret: "must-not-pass",
      },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.apiSecret",
  );
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.enqueue",
      input: {
        sessionId: "session-1",
        catalogRevision: 4,
        idempotencyKey: "key-1",
        responseMode: "wait",
        turn,
      },
    }),
    SessionRuntimeValidationError,
  );
});

test("Session runtime list limit is rejected instead of clamped", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.list",
      input: { sessionId: "session-1", limit: 501 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.code === "LIMIT_EXCEEDED",
  );
});
