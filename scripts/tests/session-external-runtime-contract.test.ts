import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES,
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  parseSessionRuntimeRequestEnvelope,
  projectSessionExecution,
} from "../../src/session-external-runtime-contract.js";

const turn = {
  userMessage: "hello",
  model: "gpt-5.4",
  reasoningEffort: "high",
  approvalMode: "on-request",
  codexSandboxMode: "workspace-write",
};

test("RUNTIME-CATALOG-01: runtime.catalog accepts only an explicit empty input", () => {
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "runtime.catalog",
    input: {},
  });
  assert.deepEqual(parsed.input, {});
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "runtime.catalog",
      input: { revision: 4 },
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.details.field === "input.revision",
  );
});

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

test("ID-02: turn.cancel requires an idempotency key", () => {
  assert.throws(
    () => parseSessionRuntimeRequestEnvelope({
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation: "turn.cancel",
      input: { sessionId: "session-1", executionId: "execution-1" },
    }),
    (error) => error instanceof SessionRuntimeValidationError
      && error.details.field === "idempotencyKey",
  );
  const parsed = parseSessionRuntimeRequestEnvelope({
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: "turn.cancel",
    input: {
      sessionId: "session-1",
      executionId: "execution-1",
      idempotencyKey: "cancel-key-1",
    },
  });
  assert.deepEqual(parsed.input, {
    sessionId: "session-1",
    executionId: "execution-1",
    idempotencyKey: "cancel-key-1",
  });
});

test("RL-01: public execution projection rejects inline assistant text over 8 MiB", () => {
  assert.throws(
    () => projectSessionExecution({
      id: "execution-1",
      sessionId: "session-1",
      operation: "turn.run",
      state: "completed",
      result: { assistantText: "a".repeat(SESSION_RUNTIME_MAX_INLINE_TEXT_BYTES + 1) },
      errorCode: "",
      reason: "",
      createdAt: "2026-08-11T00:00:00.000Z",
      admittedAt: "2026-08-11T00:00:00.000Z",
      completedAt: "2026-08-11T00:00:01.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
    }),
    (error) => error instanceof SessionRuntimeValidationError && error.code === "CONTENT_TOO_LARGE",
  );
});
