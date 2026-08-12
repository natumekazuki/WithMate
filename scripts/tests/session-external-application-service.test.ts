import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { SessionExecution } from "../../src/session-execution.js";
import { SessionRuntimeProjectionLimitError } from "../../src/session-external-runtime-contract.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import { SessionCrudError } from "../../src-electron/session-crud-service.js";
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

test("SESSION-CRUD-SCHEMA-01: session CRUDを専用serviceへdispatchしstable errorを保つ", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() { throw new Error("unused"); },
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      listPage() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create(input) { calls.push({ operation: "create", input }); return { sessionId: "session-1" } as never; },
      async list(input) { calls.push({ operation: "list", input }); return { items: [] }; },
      async get(sessionId) { calls.push({ operation: "get", input: { sessionId } }); throw new SessionCrudError("SESSION_NOT_FOUND", "missing"); },
      async rename(input) { calls.push({ operation: "rename", input }); return { sessionId: input.sessionId } as never; },
    },
  });

  const listResponse = await service.execute("session.list", {});
  assert.deepEqual(calls, [{ operation: "list", input: { limit: 50 } }]);
  assert.equal("result" in listResponse, true);

  const getResponse = await service.execute("session.get", { sessionId: "missing" });
  assert.equal("error" in getResponse && getResponse.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in getResponse && getResponse.error.effect, "not_applied");
});

test("SESSION-PROJECTION-PAGE-04: applied session mutationのprojection超過をappliedとして返す", async () => {
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() { throw new Error("unused"); },
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      listPage() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new SessionRuntimeProjectionLimitError("result"); },
      async list() { throw new Error("unused"); },
      async get() { throw new Error("unused"); },
      async rename() { throw new SessionRuntimeProjectionLimitError("result"); },
    },
  });

  const createResponse = await service.execute("session.create", {
    title: "New Session",
    provider: "codex",
    catalogRevision: 4,
    workspace: { kind: "session_folder" },
    idempotencyKey: "create-key",
  });
  const renameResponse = await service.execute("session.rename", {
    sessionId: "session-1",
    title: "Renamed Session",
    idempotencyKey: "rename-key",
  });

  assert.equal("error" in createResponse && createResponse.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in createResponse && createResponse.error.effect, "applied");
  assert.equal("error" in renameResponse && renameResponse.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in renameResponse && renameResponse.error.effect, "applied");
});

test("RUNTIME-CATALOG-01: current catalogをpublic projectionで返しexecutionへ触れない", async () => {
  let executionInvoked = false;
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({
      revision: 7,
      providers: [{
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{
          id: "gpt-5.4",
          label: "GPT-5.4",
          reasoningEfforts: ["medium", "high"],
          privateModelMetadata: "hidden",
        }],
        privateProviderMetadata: "hidden",
      }],
      privateCatalogMetadata: "hidden",
    }) as ModelCatalogSnapshot,
    executionService: {
      beginShutdown() { executionInvoked = true; },
      async run() { executionInvoked = true; return execution; },
      async enqueue() { executionInvoked = true; return execution; },
      resolveReplay() { executionInvoked = true; return null; },
      get() { executionInvoked = true; return execution; },
      listPage() { executionInvoked = true; return []; },
      async cancel() { executionInvoked = true; return execution; },
      async waitForTerminal() { executionInvoked = true; return execution; },
    },
  });

  const response = await service.execute("runtime.catalog", {});

  assert.equal(executionInvoked, false);
  assert.deepEqual(response, {
    schemaVersion: "withmate-session-result-v1",
    operation: "runtime.catalog",
    result: {
      revision: 7,
      providers: [{
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{
          id: "gpt-5.4",
          label: "GPT-5.4",
          reasoningEfforts: ["medium", "high"],
        }],
      }],
    },
  });
});

test("RUNTIME-CATALOG-01: catalog欠落時はread-only errorへ収束しseedやexecutionへ触れない", async () => {
  let executionInvoked = false;
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => null,
    executionService: {
      beginShutdown() { executionInvoked = true; },
      async run() { executionInvoked = true; return execution; },
      async enqueue() { executionInvoked = true; return execution; },
      resolveReplay() { executionInvoked = true; return null; },
      get() { executionInvoked = true; return execution; },
      listPage() { executionInvoked = true; return []; },
      async cancel() { executionInvoked = true; return execution; },
      async waitForTerminal() { executionInvoked = true; return execution; },
    },
  });

  const response = await service.execute("runtime.catalog", {});

  assert.equal(executionInvoked, false);
  assert.equal("error" in response && response.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in response && response.error.retryable, true);
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("TURN-OPTIONS: 対象Sessionと同じcatalog snapshotからpublic候補だけを返す", async () => {
  let executionInvoked = false;
  let catalogReads = 0;
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => {
      catalogReads += 1;
      return {
        revision: 9,
        providers: [{
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.4",
          defaultReasoningEffort: "high",
          models: [{
            id: "gpt-5.4",
            label: "GPT-5.4",
            reasoningEfforts: ["medium", "high"],
            privateModelMetadata: "hidden",
          }],
          privateProviderMetadata: "hidden",
        }],
      } as ModelCatalogSnapshot;
    },
    isProviderEnabled: () => true,
    executionService: {
      beginShutdown() { executionInvoked = true; },
      async run() { executionInvoked = true; return execution; },
      async enqueue() { executionInvoked = true; return execution; },
      resolveReplay() { executionInvoked = true; return null; },
      get() { executionInvoked = true; return execution; },
      listPage() { executionInvoked = true; return []; },
      async cancel() { executionInvoked = true; return execution; },
      async waitForTerminal() { executionInvoked = true; return execution; },
    },
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      async get(sessionId) {
        return {
          sessionId,
          provider: { id: "codex", catalogRevision: 2 },
          workspace: { path: "private-path" },
          privateSessionMetadata: "hidden",
        } as never;
      },
      async rename() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.options", { sessionId: "session-1" });

  assert.equal(executionInvoked, false);
  assert.equal(catalogReads, 1);
  assert.deepEqual(response, {
    schemaVersion: "withmate-session-result-v1",
    operation: "turn.options",
    result: {
      sessionId: "session-1",
      provider: { id: "codex" },
      catalogRevision: 9,
      models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
      approvalModes: [
        { id: "never", label: "never" },
        { id: "on-request", label: "on-request" },
        { id: "on-failure", label: "on-failure" },
        { id: "untrusted", label: "untrusted" },
      ],
      codexSandboxModes: [
        { id: "read-only", label: "read-only" },
        { id: "workspace-write", label: "workspace-write" },
        { id: "workspace-write-network", label: "workspace-write + network" },
        { id: "danger-full-access", label: "danger-full-access" },
      ],
    },
  });
});

test("TURN-OPTIONS: 対象Session欠落とprovider欠落をread-only errorへ写像する", async () => {
  const createService = (get: () => Promise<never>) => new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 9, providers: [] }),
    isProviderEnabled: () => true,
    executionService: {
      beginShutdown() { throw new Error("unused"); },
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      listPage() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      get,
      async rename() { throw new Error("unused"); },
    },
  });

  const missing = await createService(async () => {
    throw new SessionCrudError("SESSION_NOT_FOUND", "missing");
  }).execute("turn.options", { sessionId: "missing" });
  const providerMissing = await createService(async () => ({
    sessionId: "session-1",
    provider: { id: "codex", catalogRevision: 2 },
  } as never)).execute("turn.options", { sessionId: "session-1" });

  assert.equal("error" in missing && missing.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in missing && missing.error.effect, "not_applied");
  assert.equal("error" in providerMissing && providerMissing.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in providerMissing && providerMissing.error.effect, "not_applied");
});

test("TURN-OPTIONS-PROJECTION-05: public projectionの8 MiB超過を副作用なしで拒否する", async () => {
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({
      revision: 9,
      providers: [{
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "x".repeat(8 * 1024 * 1024), reasoningEfforts: ["high"] }],
      }],
    }),
    isProviderEnabled: () => true,
    executionService: {
      beginShutdown() { throw new Error("unused"); },
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      listPage() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      async get() {
        return { sessionId: "session-1", provider: { id: "codex", catalogRevision: 2 } } as never;
      },
      async rename() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.options", { sessionId: "session-1" });

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("TURN-OPTIONS-CAPABILITY-04: 非対応providerとdisabled providerを候補投影前に拒否する", async () => {
  const createService = (providerId: string, enabled: boolean) => new SessionExternalApplicationService({
    currentModelCatalog: () => ({
      revision: 9,
      providers: [{
        id: providerId,
        label: providerId,
        defaultModelId: "model-1",
        defaultReasoningEffort: "high",
        models: [{ id: "model-1", label: "Model 1", reasoningEfforts: ["high"] }],
      }],
    }),
    isProviderEnabled: () => enabled,
    executionService: {
      beginShutdown() { throw new Error("unused"); },
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      listPage() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      async get() {
        return { sessionId: "session-1", provider: { id: providerId, catalogRevision: 2 } } as never;
      },
      async rename() { throw new Error("unused"); },
    },
  });

  const unsupported = await createService("copilot", true).execute("turn.options", { sessionId: "session-1" });
  const disabled = await createService("codex", false).execute("turn.options", { sessionId: "session-1" });

  assert.equal("error" in unsupported && unsupported.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in unsupported && unsupported.error.effect, "not_applied");
  assert.equal("error" in disabled && disabled.error.code, "PROVIDER_DISABLED");
  assert.equal("error" in disabled && disabled.error.effect, "not_applied");
});

test("Session application service persists catalog revision with the turn and returns an allowlisted projection", async () => {
  const runInputs: unknown[] = [];
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 5, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
  let materialized = 0;
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() {},
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      *listPage() {
        materialized += 1;
        yield { ...execution, id: "execution-1", sequence: 1, result: largeResult };
        materialized += 1;
        yield { ...execution, id: "execution-2", sequence: 2, result: largeResult };
        materialized += 1;
        throw new Error("records after the response budget must not be materialized");
      },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });

  const response = await service.execute("turn.list", { sessionId: "session-1", limit: 2 });

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "not_applied");
  assert.equal(materialized, 2);
});

test("RL-01: applied turn.run reports an oversized inline result with applied effect", async () => {
  const service = new SessionExternalApplicationService({
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 5, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
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
