import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionExecution } from "../../src/session-execution.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";

const execution: SessionExecution = {
  id: "execution-1",
  sessionId: "session-1",
  operation: "turn.run",
  state: "running",
  result: null,
  errorCode: "",
  reason: "",
  createdAt: "2026-08-11T00:00:00.000Z",
  admittedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-08-11T00:00:00.000Z",
};

const mutationInput = {
  sessionId: "session-1",
  catalogRevision: 4,
  idempotencyKey: "key-1",
  responseMode: "deferred" as const,
  turn: {
    userMessage: "hello",
    model: "gpt-5.4",
    reasoningEffort: "high" as const,
    approvalMode: "on-request" as const,
    codexSandboxMode: "workspace-write" as const,
  },
};

test("Session application service forwards only the turn effect and returns an allowlisted projection", async () => {
  const runInputs: unknown[] = [];
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      async run(input) {
        runInputs.push(input);
        return {
          ...execution,
          result: { assistantText: "safe", rawProviderPayload: "hidden" },
          request: { apiSecret: "hidden" },
        } as SessionExecution;
      },
      async enqueue() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      list() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const response = await service.execute("turn.run", mutationInput);
  assert.equal("result" in response, true);
  assert.equal(runInputs.length, 1);
  assert.deepEqual(
    { ...(runInputs[0] as Record<string, unknown>), requestFingerprint: "<fingerprint>" },
    {
      sessionId: "session-1",
      request: mutationInput.turn,
      idempotencyKey: "key-1",
      requestFingerprint: "<fingerprint>",
    },
  );
  assert.match((runInputs[0] as { requestFingerprint: string }).requestFingerprint, /^[a-f0-9]{64}$/);
  if ("result" in response) {
    assert.equal("request" in (response.result as Record<string, unknown>), false);
    assert.deepEqual((response.result as SessionExecution).result, { assistantText: "safe" });
  }
});

test("Session application service rejects a stale catalog before creating an execution", async () => {
  let invoked = false;
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 5,
    executionService: {
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      get() { throw new Error("unused"); },
      list() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const response = await service.execute("turn.run", mutationInput);
  assert.equal(invoked, false);
  assert.equal("error" in response && response.error.code, "CATALOG_REVISION_STALE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("Session application service rejects an unknown operation before invoking execution dependencies", async () => {
  let invoked = false;
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      get() { invoked = true; return execution; },
      list() { invoked = true; return []; },
      async cancel() { invoked = true; return execution; },
      async waitForTerminal() { invoked = true; return execution; },
    },
  });

  const response = await service.execute("turn.delete", { sessionId: "session-1", executionId: "execution-1" });

  assert.equal(invoked, false);
  assert.equal("error" in response && response.error.code, "INVALID_INPUT");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("Session application service validates the operation payload before invoking execution dependencies", async () => {
  let invoked = false;
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      get() { invoked = true; return execution; },
      list() { invoked = true; return []; },
      async cancel() { invoked = true; return execution; },
      async waitForTerminal() { invoked = true; return execution; },
    },
  });

  const response = await service.execute("turn.cancel", { sessionId: "session-1", idempotencyKey: "wrong-shape" });

  assert.equal(invoked, false);
  assert.equal("error" in response && response.error.code, "INVALID_INPUT");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("Session application service binds list cursors to the requested Session", async () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    ...execution,
    id: `execution-${index + 1}`,
  }));
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      list() { return items; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const first = await service.execute("turn.list", { sessionId: "session-1", limit: 2 });
  assert.ok("result" in first);
  const cursor = (first.result as { nextCursor: string }).nextCursor;
  const invalid = await service.execute("turn.list", { sessionId: "session-2", limit: 2, cursor });
  assert.equal("error" in invalid && invalid.error.code, "INVALID_CURSOR");
});
