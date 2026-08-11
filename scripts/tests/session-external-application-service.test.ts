import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionExecution } from "../../src/session-execution.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import { SessionTurnValidationError } from "../../src-electron/session-turn-validation-error.js";

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

test("Session application service persists catalog revision with the turn and returns an allowlisted projection", async () => {
  const runInputs: unknown[] = [];
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() {},
      async run(input) {
        runInputs.push(input);
        return {
          ...execution,
          result: { assistantText: "safe", rawProviderPayload: "hidden" },
          request: { apiSecret: "hidden" },
        } as SessionExecution;
      },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
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
      request: {
        catalogRevision: 4,
        turn: mutationInput.turn,
      },
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
      beginShutdown() {},
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
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
      beginShutdown() {},
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      resolveReplay() { invoked = true; return null; },
      get() { invoked = true; return execution; },
      listPage() { invoked = true; return []; },
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
      beginShutdown() {},
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      resolveReplay() { invoked = true; return null; },
      get() { invoked = true; return execution; },
      listPage() { invoked = true; return []; },
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
    sequence: index + 1,
  }));
  const pageRequests: Array<{ afterSequence: number | null; limit: number }> = [];
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() {},
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage(_sessionId, afterSequence, limit) {
        pageRequests.push({ afterSequence, limit });
        return items.filter((item) => afterSequence === null || item.sequence > afterSequence).slice(0, limit);
      },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const first = await service.execute("turn.list", { sessionId: "session-1", limit: 2 });
  assert.ok("result" in first);
  const cursor = (first.result as { nextCursor: string }).nextCursor;
  assert.deepEqual(pageRequests, [{ afterSequence: null, limit: 3 }]);
  items.push({ ...execution, id: "execution-4", sequence: 4 });
  const second = await service.execute("turn.list", { sessionId: "session-1", limit: 2, cursor });
  assert.deepEqual(
    "result" in second
      ? (second.result as { items: SessionExecution[] }).items.map((item) => item.id)
      : [],
    ["execution-3", "execution-4"],
  );
  const invalid = await service.execute("turn.list", { sessionId: "session-2", limit: 2, cursor });
  assert.equal("error" in invalid && invalid.error.code, "INVALID_CURSOR");
});

test("RL-01: turn.list rejects an aggregate public response over 8 MiB", async () => {
  const largeResult = { assistantText: "a".repeat(5 * 1024 * 1024) };
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() {},
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() {
        return [
          { ...execution, id: "execution-1", sequence: 1, result: largeResult },
          { ...execution, id: "execution-2", sequence: 2, result: largeResult },
        ];
      },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.list", { sessionId: "session-1", limit: 2 });

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("RL-01: applied turn.run reports an oversized inline result with applied effect", async () => {
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() {},
      async run() {
        return { ...execution, state: "completed", result: { assistantText: "a".repeat(8 * 1024 * 1024 + 1) } };
      },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.run", mutationInput);

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "applied");
});

test("I-01: canonical replayはcatalog revision更新後もstale validationより先に解決する", async () => {
  let runInvoked = false;
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 5,
    executionService: {
      beginShutdown() {},
      async run() { runInvoked = true; return execution; },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return execution; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.run", mutationInput);

  assert.equal("result" in response, true);
  assert.equal(runInvoked, false);
});

test("LC-01: shutdown admission後はapplication dependencyを呼ばずnot_appliedで拒否する", async () => {
  let invoked = false;
  let executionShutdownBegun = false;
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() { executionShutdownBegun = true; },
      async run() { invoked = true; return execution; },
      async enqueue() { invoked = true; return execution; },
      resolveReplay() { invoked = true; return null; },
      get() { invoked = true; return execution; },
      listPage() { invoked = true; return []; },
      async cancel() { invoked = true; return execution; },
      async waitForTerminal() { invoked = true; return execution; },
    },
  });
  service.beginShutdown();

  const response = await service.execute("turn.run", mutationInput);

  assert.equal(invoked, false);
  assert.equal(executionShutdownBegun, true);
  assert.equal("error" in response && response.error.code, "RUNTIME_SHUTTING_DOWN");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("ER-01: 副作用前のSession domain errorをstable codeとnot_appliedへ写像する", async () => {
  const service = new SessionExternalApplicationService({
    currentCatalogRevision: () => 4,
    executionService: {
      beginShutdown() {},
      async run() {
        throw new SessionTurnValidationError("SESSION_NOT_FOUND", "Session not found.");
      },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.run", mutationInput);

  assert.equal("error" in response && response.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in response && response.error.retryable, false);
  assert.equal("error" in response && response.error.effect, "not_applied");
});
