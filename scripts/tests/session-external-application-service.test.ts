import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import type { SessionExecution } from "../../src/session-execution.js";
import type { SessionInteraction } from "../../src/session-interaction.js";
import type { WorkItem } from "../../src/work-item.js";
import {
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeProjectionLimitError,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import { AgentRuntimeBindingRegistry, type ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionCrudError } from "../../src-electron/session-crud-service.js";
import { SessionFileServiceError } from "../../src-electron/session-file-service.js";
import { SessionTurnValidationError } from "../../src-electron/session-turn-validation-error.js";
import { CoordinationEventPublicationError } from "../../src-electron/coordination-event-service.js";
import { SessionExecutionIdempotencyConflictError } from "../../src-electron/session-execution-storage-v6.js";

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
    provider: "codex" as const,
    userMessage: "hello",
    model: "gpt-5.4",
    reasoningEffort: "high" as const,
    approvalMode: "on-request" as const,
    codexSandboxMode: "workspace-write" as const,
    attachments: [],
  },
};

const actorBinding: ResolvedAgentRuntimeBinding = {
  bindingId: "binding-actor",
  bindingIdHash: "binding-hash-actor",
  actorSessionId: "session-actor",
  providerId: "codex",
  executionGeneration: "generation-actor",
  authoritySnapshot: {},
  operationGrants: ["session.runtime.invoke"],
  createdAt: "2026-08-11T00:00:00.000Z",
  expiresAt: null,
};

const resolveTurnInitiator = async (actorSessionId: string) => ({
  kind: "session" as const,
  sessionId: actorSessionId,
  character: {
    characterId: `character-${actorSessionId}`,
    name: `Character ${actorSessionId}`,
    iconFilePath: `C:/characters/${actorSessionId}.png`,
  },
});

function communicationSession(
  sessionId: string,
  sessionRole: "standalone" | "overall-coordinator" | "task-coordinator" | "executor",
  rootSessionId: string,
  parentSessionId: string | null,
  delegationDepth: number,
) {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    sessionRole,
    roleContractRevision: 1 as const,
    rootSessionId,
    parentSessionId,
    delegationDepth,
  } as never;
}

const defaultCommunicationCrudService = {
  async create() { throw new Error("unused"); },
  async list() { throw new Error("unused"); },
  async get(sessionId: string) {
    return sessionId === "session-actor"
      ? communicationSession(sessionId, "overall-coordinator", sessionId, null, 0)
      : communicationSession(sessionId, "executor", "session-actor", "session-actor", 1);
  },
  async rename() { throw new Error("unused"); },
};

function getDefaultTurnAuthoritySession(sessionId: string) {
  return sessionId === "session-actor"
    ? communicationSession(sessionId, "overall-coordinator", sessionId, null, 0)
    : communicationSession(sessionId, "executor", "session-actor", "session-actor", 1);
}

function executeBound(
  service: SessionExternalApplicationService,
  operation: Parameters<SessionExternalApplicationService["execute"]>[0],
  input: unknown,
  binding: ResolvedAgentRuntimeBinding | null = actorBinding,
) {
  return service.execute(operation, input, binding);
}

test("SESSION-SELF-01: application serviceはruntime bindingのactor Sessionだけを公開する", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      async get(sessionId) {
        return {
          sessionId,
          sessionRole: "overall-coordinator",
          roleContractRevision: 1,
          rootSessionId: sessionId,
          parentSessionId: null,
          delegationDepth: 0,
        } as never;
      },
      async rename() { throw new Error("unused"); },
    },
    executionService: {
      beginShutdown() {},
      async run() { return execution; },
      async enqueue() { return execution; },
      resolveReplay() { return null; },
      get() { return execution; },
      listPage() { return []; },
      async cancel() { return execution; },
      async waitForTerminal() { return execution; },
    },
  });
  const registry = new AgentRuntimeBindingRegistry();
  const projection = registry.issueOrReuse({
    actorSessionId: "session-actor",
    providerId: "codex",
    operationGrants: ["session.runtime.invoke"],
  });
  const resolved = registry.resolve(projection.bindingReference, "session.runtime.invoke");
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error("Expected a resolved binding.");

  assert.deepEqual(await executeBound(service, "session.self", {}, resolved.binding),
    createSessionRuntimeResult("session.self", {
      sessionId: "session-actor",
      sessionRole: "overall-coordinator",
      roleContractRevision: 1,
      rootSessionId: "session-actor",
      parentSessionId: null,
      delegationDepth: 0,
    }));
  const missing = await executeBound(service, "session.self", {}, null);
  assert.equal("error" in missing && missing.error.code, "SESSION_BINDING_REQUIRED");
});

test("SESSION-CRUD-SCHEMA-01: session CRUDを専用serviceへdispatchしstable errorを保つ", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
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

  const listResponse = await executeBound(service, "session.list", {});
  assert.deepEqual(calls, [{ operation: "list", input: { limit: 50 } }]);
  assert.equal("result" in listResponse, true);

  const getResponse = await executeBound(service, "session.get", { sessionId: "missing" });
  assert.equal("error" in getResponse && getResponse.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in getResponse && getResponse.error.effect, "not_applied");
});

test("COORD-ADAPTER-01: Coordination operationを同じapplication serviceへdispatchする", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const event = {
    sequence: 1, eventId: "event-1", actorSessionId: "session-actor", sessionRole: "executor" as const,
    roleContractRevision: 1 as const, rootSessionId: "root-1", parentSessionId: "task-1", delegationDepth: 2,
    kind: "progress" as const, state: "recorded" as const, summary: "started", payload: { summary: "started" },
    executionId: null, targetSessionId: null, correctedEventId: null, options: [], actions: [],
    createdAt: "2026-08-21T00:00:00.000Z",
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    executionService: {} as never,
    crudService: {} as never,
    coordinationService: {
      create(input) { calls.push({ operation: "create", input }); return event; },
      list(input) { calls.push({ operation: "list", input }); return { items: [] }; },
      get(input) { calls.push({ operation: "get", input }); return event; },
      resolve(input) { calls.push({ operation: "resolve", input }); return event; },
      cancel(input) { calls.push({ operation: "cancel", input }); return event; },
      correct(input) { calls.push({ operation: "correct", input }); return { correction: event, superseded: event }; },
    },
  });
  const input = { kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" };
  const response = await executeBound(service, "coordination.event.create", input);
  assert.equal("result" in response && response.result.eventId, "event-1");
  assert.deepEqual(calls, [{ operation: "create", input }]);
});

test("COORD-IDEM-01: commit後publication failureはappliedとevent IDを返す", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    executionService: {} as never,
    crudService: {} as never,
    coordinationService: {
      create() { throw new CoordinationEventPublicationError("event-committed"); },
    } as never,
  });
  const response = await executeBound(service, "coordination.event.create", {
    kind: "progress", payload: { summary: "committed" }, idempotencyKey: "key-1",
  });
  assert.equal("error" in response && response.error.effect, "applied");
  assert.equal("error" in response && response.error.details.eventId, "event-committed");
});

test("EXT-TRANSCRIPT-13: transcript.exportを専用serviceへdispatchし結果をそのまま返す", async () => {
  const input = {
    sessionId: "session-1",
    format: "json" as const,
    maxBytes: 1024,
    destination: { kind: "inline" as const },
  };
  const result = { destination: "inline" as const, format: "json" as const, byteLength: 2, content: "{}" };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    executionService: {} as never,
    crudService: {} as never,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    transcriptService: { export: async (received) => {
      assert.deepEqual(received, input);
      return result;
    } },
  });
  const response = await executeBound(service, "transcript.export", input);
  assert.deepEqual(response, {
    schemaVersion: "withmate-session-result-v2",
    operation: "transcript.export",
    result,
  });
});

test("EXT-TRANSCRIPT-13: inline transcript.exportの予期しないfailureはnot_appliedを返す", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    executionService: {} as never,
    crudService: {} as never,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    transcriptService: { export: async () => { throw new Error("publish response lost"); } },
  });
  const response = await executeBound(service, "transcript.export", {
    sessionId: "session-1",
    format: "json",
    maxBytes: 1024,
    destination: { kind: "inline" },
  });
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("EXT-TRANSCRIPT-13: SessionFolder transcript.exportの予期しないfailureはindeterminateを返す", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    executionService: {} as never,
    crudService: {} as never,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    transcriptService: { export: async () => { throw new Error("publish response lost"); } },
  });
  const response = await executeBound(service, "transcript.export", {
    sessionId: "session-1", format: "json", maxBytes: 1024,
    destination: { kind: "session_folder", relativePath: "transcript.json", replace: false, idempotencyKey: "export-1" },
  });
  assert.equal("error" in response && response.error.effect, "indeterminate");
});

test("SF-ADAPTER-02: Session file operationsを同じapplication serviceへdispatchする", async () => {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() {},
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
      async get(sessionId) { return defaultCommunicationCrudService.get(sessionId); },
      async rename() { throw new Error("unused"); },
    },
    fileService: {
      async list(input) { calls.push({ operation: "list", input }); return { items: [] }; },
      async readText(input) {
        calls.push({ operation: "read_text", input });
        return {
          file: { sessionId: input.sessionId, relativePath: input.relativePath, byteLength: 5, modifiedAt: "now" },
          content: "hello",
        };
      },
      async writeText(input) {
        calls.push({ operation: "write_text", input });
        return {
          file: { sessionId: input.sessionId, relativePath: input.relativePath, byteLength: 5, modifiedAt: "now" },
        };
      },
    },
  });

  await executeBound(service, "session.files.list", { sessionId: "session-1" });
  await executeBound(service, "session.files.read_text", { sessionId: "session-1", relativePath: "brief.md" });
  await executeBound(service, "session.files.write_text", {
    sessionId: "session-1",
    relativePath: "brief.md",
    content: "hello",
    idempotencyKey: "write-1",
  });

  assert.deepEqual(calls.map((call) => call.operation), ["list", "read_text", "write_text"]);
  assert.deepEqual(calls[0]?.input, { sessionId: "session-1", limit: 50 });
  assert.deepEqual(calls[2]?.input, {
    sessionId: "session-1",
    relativePath: "brief.md",
    content: "hello",
    maxBytes: 1024 * 1024,
    replace: false,
    idempotencyKey: "write-1",
  });
});

test("SF-EFFECT-01: publish後のtyped file errorをindeterminateとsafe identifiers付きで返す", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() {},
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
      async get() { throw new Error("unused"); },
      async rename() { throw new Error("unused"); },
    },
    fileService: {
      async list() { throw new Error("unused"); },
      async readText() { throw new Error("unused"); },
      async writeText() {
        throw new SessionFileServiceError(
          "PATH_CHANGED",
          "The Session file path changed after publication.",
          true,
          { sessionId: "session-1", relativePath: "brief.md" },
          "indeterminate",
        );
      },
    },
  });

  const response = await executeBound(service, "session.files.write_text", {
    sessionId: "session-1",
    relativePath: "brief.md",
    content: "hello",
    idempotencyKey: "write-effect",
  });

  assert.equal("error" in response && response.error.code, "PATH_CHANGED");
  assert.equal("error" in response && response.error.effect, "indeterminate");
  assert.equal("error" in response && response.error.details.sessionId, "session-1");
  assert.equal("error" in response && response.error.details.relativePath, "brief.md");
});

test("SESSION-PROJECTION-PAGE-04: applied session mutationのprojection超過をappliedとして返す", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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
      async create() { throw new SessionRuntimeProjectionLimitError("result", { sessionId: "session-created" }); },
      async list() { throw new Error("unused"); },
      async get() { throw new Error("unused"); },
      async rename() { throw new SessionRuntimeProjectionLimitError("result", { sessionId: "session-1" }); },
    },
  });

  const createResponse = await executeBound(service, "session.create", {
    title: "New Session",
    sessionRole: "executor",
    provider: "codex",
    catalogRevision: 4,
    workspace: { kind: "session_folder" },
    idempotencyKey: "create-key",
  });
  const renameResponse = await executeBound(service, "session.rename", {
    sessionId: "session-1",
    title: "Renamed Session",
    idempotencyKey: "rename-key",
  });

  assert.equal("error" in createResponse && createResponse.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in createResponse && createResponse.error.effect, "applied");
  assert.equal("error" in createResponse && createResponse.error.details.sessionId, "session-created");
  assert.equal("error" in renameResponse && renameResponse.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in renameResponse && renameResponse.error.effect, "applied");
  assert.equal("error" in renameResponse && renameResponse.error.details.sessionId, "session-1");
});

test("APPLIED-ID-01: final response envelope超過でもmutationのeffectとresource IDを保つ", async () => {
  const createResult = createBoundarySessionResult("session-created");
  const renameResult = createBoundarySessionResult("session-1");
  const executionBase = {
    ...execution,
    state: "completed" as const,
    result: { assistantText: "" },
  };
  const oversizedExecution = {
    ...executionBase,
    result: {
      assistantText: "a".repeat(
        SESSION_RUNTIME_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(executionBase), "utf8"),
      ),
    },
  };
  for (const [operation, result] of [
    ["session.create", createResult],
    ["session.rename", renameResult],
    ["turn.run", oversizedExecution],
  ] as const) {
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
    assert.ok(
      Buffer.byteLength(JSON.stringify(createSessionRuntimeResult(operation, result)), "utf8")
        > SESSION_RUNTIME_MAX_RESPONSE_BYTES,
    );
  }
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    executionService: {
      beginShutdown() {},
      async run() { return oversizedExecution; },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { return createResult as never; },
      async list() { throw new Error("unused"); },
      async get(sessionId) { return defaultCommunicationCrudService.get(sessionId); },
      async rename() { return renameResult as never; },
    },
  });

  const createResponse = await executeBound(service, "session.create", {
    title: "New Session",
    sessionRole: "executor",
    provider: "codex",
    catalogRevision: 4,
    workspace: { kind: "session_folder" },
    idempotencyKey: "create-key",
  });
  const renameResponse = await executeBound(service, "session.rename", {
    sessionId: "session-1",
    title: "Renamed Session",
    idempotencyKey: "rename-key",
  });
  const runResponse = await executeBound(service, "turn.run", mutationInput);

  assert.deepEqual(
    [createResponse, renameResponse, runResponse].map((response) => "error" in response && response.error.effect),
    ["applied", "applied", "applied"],
  );
  assert.equal("error" in createResponse && createResponse.error.details.sessionId, "session-created");
  assert.equal("error" in renameResponse && renameResponse.error.details.sessionId, "session-1");
  assert.equal("error" in runResponse && runResponse.error.details.sessionId, "session-1");
  assert.equal("error" in runResponse && runResponse.error.details.executionId, "execution-1");
});

function createBoundarySessionResult(sessionId: string): { sessionId: string; padding: string } {
  const empty = { sessionId, padding: "" };
  return {
    ...empty,
    padding: "a".repeat(
      SESSION_RUNTIME_MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(empty), "utf8"),
    ),
  };
}

test("READ-EFFECT-01: read-only operationの予期しない例外はnot_appliedへ収束する", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() {},
      async run() { throw new Error("unused"); },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { throw new Error("unused"); },
      get() { throw new Error("database unavailable"); },
      listPage() { throw new Error("database unavailable"); },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("database unavailable"); },
      async get() { throw new Error("database unavailable"); },
      async rename() { throw new Error("unused"); },
    },
  });

  const response = await executeBound(service, "session.get", { sessionId: "session-1" });
  assert.equal("error" in response && response.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("RUNTIME-CATALOG-01: current catalogをpublic projectionで返しexecutionへ触れない", async () => {
  let executionInvoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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
      }, {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet",
        defaultReasoningEffort: "high",
        models: [{ id: "claude-sonnet", label: "Claude Sonnet", reasoningEfforts: ["high"] }],
      }, {
        id: "disabled-provider",
        label: "Disabled",
        defaultModelId: "disabled-model",
        defaultReasoningEffort: "medium",
        models: [],
      }, {
        id: "unknown-provider",
        label: "Unknown",
        defaultModelId: "unknown-model",
        defaultReasoningEffort: "medium",
        models: [],
      }],
      privateCatalogMetadata: "hidden",
    }) as ModelCatalogSnapshot,
    isProviderEnabled: (providerId) => providerId !== "disabled-provider",
    isProviderSupported: (providerId) => providerId === "codex" || providerId === "copilot" || providerId === "disabled-provider",
    discoverSessionCustomAgents: async () => [],
    crudService: {
      async create() { throw new Error("unused"); },
      async list() { throw new Error("unused"); },
      async get() { throw new Error("unused"); },
      async rename() { throw new Error("unused"); },
    },
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

  const response = await executeBound(service, "runtime.catalog", {});

  assert.equal(executionInvoked, false);
  assert.deepEqual(response, {
    schemaVersion: "withmate-session-result-v2",
    operation: "runtime.catalog",
    result: {
      revision: 7,
      sessionRoleContractRevision: 1,
      supportedSessionRoles: ["standalone", "overall-coordinator", "task-coordinator", "executor"],
      allowedChildSessionRoles: {
        standalone: [],
        "overall-coordinator": ["task-coordinator", "executor"],
        "task-coordinator": ["executor"],
        executor: [],
      },
      maxDelegationDepth: 2,
      sessionTurnCommunicationContractRevision: 1,
      coordinationEvents: {
        kinds: ["progress", "decision", "escalation", "user_decision_required", "blocker", "result", "correction"],
        states: ["recorded", "open", "resolved", "superseded", "cancelled"],
        scopes: ["self", "subtree"],
        defaultListLimit: 50,
        maxListLimit: 100,
      },
      workItems: {
        contractRevision: 1,
        states: ["pending", "in_progress", "waiting", "completed", "partially_completed", "failed", "canceled"],
        mutations: ["create", "transition", "result", "cancel"],
        defaultListLimit: 50,
        maxListLimit: 200,
        maxListResponseBytes: 8388608,
        maxResultBytes: 262144,
      },
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
      }, {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet",
        defaultReasoningEffort: "high",
        models: [{
          id: "claude-sonnet",
          label: "Claude Sonnet",
          reasoningEfforts: ["high"],
        }],
      }],
    },
  });
});

test("RUNTIME-CATALOG-01: catalog欠落時はread-only errorへ収束しseedやexecutionへ触れない", async () => {
  let executionInvoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "runtime.catalog", {});

  assert.equal(executionInvoked, false);
  assert.equal("error" in response && response.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in response && response.error.retryable, true);
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("TURN-OPTIONS: 対象Sessionと同じcatalog snapshotからpublic候補だけを返す", async () => {
  let executionInvoked = false;
  let catalogReads = 0;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.options", { sessionId: "session-1" });

  assert.equal(executionInvoked, false);
  assert.equal(catalogReads, 1);
  assert.deepEqual(response, {
    schemaVersion: "withmate-session-result-v2",
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
    resolveTurnInitiator,
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

  const missing = await executeBound(createService(async () => {
    throw new SessionCrudError("SESSION_NOT_FOUND", "missing");
  }), "turn.options", { sessionId: "missing" });
  const providerMissing = await executeBound(createService(async () => ({
    sessionId: "session-1",
    provider: { id: "codex", catalogRevision: 2 },
  } as never)), "turn.options", { sessionId: "session-1" });

  assert.equal("error" in missing && missing.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in missing && missing.error.effect, "not_applied");
  assert.equal("error" in providerMissing && providerMissing.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in providerMissing && providerMissing.error.effect, "not_applied");
});

test("TURN-OPTIONS-PROJECTION-05: public projectionの8 MiB超過を副作用なしで拒否する", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.options", { sessionId: "session-1" });

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("TURN-OPTIONS-CAPABILITY-04: 非対応providerとdisabled providerを候補投影前に拒否する", async () => {
  const createService = (providerId: string, enabled: boolean) => new SessionExternalApplicationService({
    resolveTurnInitiator,
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
        return {
          sessionId: "session-1",
          provider: { id: providerId, catalogRevision: 2 },
          workspace: { kind: "directory", label: "workspace", path: "C:/workspace", branch: null },
        } as never;
      },
      async rename() { throw new Error("unused"); },
    },
  });

  const unsupported = await executeBound(createService("unknown", true), "turn.options", { sessionId: "session-1" });
  const disabled = await executeBound(createService("codex", false), "turn.options", { sessionId: "session-1" });

  assert.equal("error" in unsupported && unsupported.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal("error" in unsupported && unsupported.error.effect, "not_applied");
  assert.equal("error" in disabled && disabled.error.code, "PROVIDER_DISABLED");
  assert.equal("error" in disabled && disabled.error.effect, "not_applied");
});

test("EXT-PROVIDER-01: Copilot turn.optionsはpublic custom agentだけを投影する", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({
      revision: 5,
      providers: [{
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet",
        defaultReasoningEffort: "high",
        models: [{ id: "claude-sonnet", label: "Claude Sonnet", reasoningEfforts: ["high"] }],
      }],
    }),
    isProviderEnabled: () => true,
    isProviderSupported: (providerId) => providerId === "copilot",
    discoverSessionCustomAgents: async () => [{
      name: "reviewer",
      displayName: "Reviewer",
      description: "Review changes",
    }],
    executionService: {
      beginShutdown() {}, async run() { throw new Error("unused"); }, async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; }, get() { throw new Error("unused"); }, listPage() { return []; },
      async cancel() { throw new Error("unused"); }, async waitForTerminal() { throw new Error("unused"); },
    },
    crudService: {
      async create() { throw new Error("unused"); }, async list() { throw new Error("unused"); },
      async get() {
        return {
          sessionId: "session-1",
          provider: { id: "copilot", catalogRevision: 5 },
          workspace: { kind: "directory", label: "workspace", path: "C:/workspace", branch: null },
        } as never;
      },
      async rename() { throw new Error("unused"); },
    },
  });

  const response = await executeBound(service, "turn.options", { sessionId: "session-1" });
  assert.equal("result" in response && response.result.provider.id, "copilot");
  assert.deepEqual("result" in response && "customAgents" in response.result && response.result.customAgents, [
    { name: "", displayName: "Default", description: "" },
    { name: "reviewer", displayName: "Reviewer", description: "Review changes" },
  ]);
  assert.equal("result" in response && "codexSandboxModes" in response.result, false);
});

test("Session application service persists catalog revision with the turn and returns an allowlisted projection", async () => {
  const runInputs: unknown[] = [];
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
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
  const response = await executeBound(service, "turn.run", mutationInput);
  assert.equal("result" in response, true);
  assert.equal(runInputs.length, 1);
  assert.deepEqual(
    { ...(runInputs[0] as Record<string, unknown>), requestFingerprint: "<fingerprint>" },
    {
      sessionId: "session-1",
      request: {
        initiator: await resolveTurnInitiator("session-actor"),
        catalogRevision: 4,
        turn: mutationInput.turn,
      },
      idempotencyKey: "key-1",
      requestFingerprint: "<fingerprint>",
      origin: {
        sourceSessionId: "session-actor",
        targetSessionTitle: "Session session-1",
        targetSessionRole: "executor",
        userMessage: "hello",
      },
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
    resolveTurnInitiator,
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
  const response = await executeBound(service, "turn.run", mutationInput);
  assert.equal(invoked, false);
  assert.equal("error" in response && response.error.code, "CATALOG_REVISION_STALE");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("Session application service rejects an unknown operation before invoking execution dependencies", async () => {
  let invoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.delete", { sessionId: "session-1", executionId: "execution-1" });

  assert.equal(invoked, false);
  assert.equal("error" in response && response.error.code, "INVALID_INPUT");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("Session application service validates the operation payload before invoking execution dependencies", async () => {
  let invoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.cancel", { sessionId: "session-1", idempotencyKey: "wrong-shape" });

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
    resolveTurnInitiator,
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
  const first = await executeBound(service, "turn.list", { sessionId: "session-1", limit: 2 });
  assert.ok("result" in first);
  const cursor = (first.result as { nextCursor: string }).nextCursor;
  assert.deepEqual(pageRequests, [{ afterSequence: null, limit: 3 }]);
  items.push({ ...execution, id: "execution-4", sequence: 4 });
  const second = await executeBound(service, "turn.list", { sessionId: "session-1", limit: 2, cursor });
  assert.deepEqual(
    "result" in second
      ? (second.result as { items: SessionExecution[] }).items.map((item) => item.id)
      : [],
    ["execution-3", "execution-4"],
  );
  const invalid = await executeBound(service, "turn.list", { sessionId: "session-2", limit: 2, cursor });
  assert.equal("error" in invalid && invalid.error.code, "INVALID_CURSOR");
});

test("RL-01: turn.list rejects an aggregate public response over 8 MiB", async () => {
  const largeResult = { assistantText: "a".repeat(5 * 1024 * 1024) };
  let materialized = 0;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.list", { sessionId: "session-1", limit: 2 });

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "not_applied");
  assert.equal(materialized, 2);
});

test("RL-01: applied turn.run reports an oversized inline result with applied effect", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
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

  const response = await executeBound(service, "turn.run", mutationInput);

  assert.equal("error" in response && response.error.code, "CONTENT_TOO_LARGE");
  assert.equal("error" in response && response.error.effect, "applied");
  assert.equal("error" in response && response.error.details.sessionId, "session-1");
  assert.equal("error" in response && response.error.details.executionId, "execution-1");
});

test("TN-PROJ-06: turn.run/enqueue/get/listは同じterminal notification projectorを使う", async () => {
  const projectedNotification = {
    targetSessionId: "target-session",
    state: "pending" as const,
    notificationExecutionId: null,
    errorCode: null,
    updatedAt: "2026-08-18T00:00:01.000Z",
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    projectTerminalFailureNotification: () => projectedNotification,
    executionService: {
      beginShutdown() {},
      async run() { return execution; },
      async enqueue() { return { ...execution, operation: "turn.enqueue", state: "queued" }; },
      resolveReplay() { return null; },
      get() { return execution; },
      *listPage() { yield { ...execution, sequence: 1 }; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { return execution; },
    },
  });
  const { responseMode: _responseMode, ...enqueueInput } = mutationInput;
  const responses = [
    await executeBound(service, "turn.run", mutationInput),
    await executeBound(service, "turn.enqueue", enqueueInput),
    await executeBound(service, "turn.get", { sessionId: "session-1", executionId: "execution-1" }),
    await executeBound(service, "turn.list", { sessionId: "session-1" }),
  ];

  const projections = responses.map((response) => {
    assert.ok("result" in response);
    if (!("result" in response)) throw new Error("Expected application result.");
    return response.operation === "turn.list"
      ? (response.result as { items: Array<{ terminalFailureNotification: unknown }> }).items[0]
        ?.terminalFailureNotification
      : (response.result as { terminalFailureNotification: unknown }).terminalFailureNotification;
  });
  assert.deepEqual(projections, Array.from({ length: 4 }, () => projectedNotification));
});

test("I-01: canonical replayはcatalog revision更新後もstale validationより先に解決する", async () => {
  let runInvoked = false;
  let initiatorResolveCount = 0;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator: async (actorSessionId) => {
      initiatorResolveCount += 1;
      return resolveTurnInitiator(actorSessionId);
    },
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

  const response = await executeBound(service, "turn.run", mutationInput);

  assert.equal("result" in response, true);
  assert.equal(runInvoked, false);
  assert.equal(initiatorResolveCount, 0);
});

test("ID-02/ID-04: actorとtargetを分離しfingerprintをstable actor identityへ結び付ける", async () => {
  const mutations: Array<{ operation: "run" | "enqueue"; input: any }> = [];
  let snapshotRevision = 0;
  let publicGetCalls = 0;
  const getTurnAuthoritySession = (sessionId: string) => {
    if (sessionId === "session-b") return communicationSession(sessionId, "overall-coordinator", sessionId, null, 0);
    if (sessionId === "session-c") return communicationSession(sessionId, "executor", "session-b", "session-b", 1);
    if (sessionId === "session-d") return communicationSession(sessionId, "overall-coordinator", sessionId, null, 0);
    return null;
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator: async (actorSessionId) => {
      snapshotRevision += 1;
      return {
        kind: "session",
        sessionId: actorSessionId,
        character: {
          characterId: `character-${actorSessionId}`,
          name: `Actor ${snapshotRevision}`,
          iconFilePath: `C:/characters/${snapshotRevision}.png`,
        },
      };
    },
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    getTurnAuthoritySession,
    crudService: {
      ...defaultCommunicationCrudService,
      async get() {
        publicGetCalls += 1;
        throw new Error("authority判定でpublic Session detailを取得してはいけない");
      },
    },
    executionService: {
      beginShutdown() {},
      async run(input) {
        mutations.push({ operation: "run", input });
        return { ...execution, sessionId: input.sessionId };
      },
      async enqueue(input) {
        mutations.push({ operation: "enqueue", input });
        return { ...execution, sessionId: input.sessionId, operation: "turn.enqueue", state: "queued" };
      },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const actorB = { ...actorBinding, actorSessionId: "session-b" };
  const actorD = { ...actorBinding, actorSessionId: "session-d" };
  const targetCInput = { ...mutationInput, sessionId: "session-c" };

  await executeBound(service, "turn.run", targetCInput, actorB);
  await executeBound(service, "turn.run", targetCInput, actorB);
  const forbiddenOtherRoot = await executeBound(service, "turn.run", targetCInput, actorD);
  const { responseMode: _responseMode, waitTimeoutMs: _waitTimeoutMs, ...enqueueTargetCInput } = targetCInput;
  await executeBound(service, "turn.enqueue", enqueueTargetCInput, actorB);

  assert.deepEqual(mutations.map(({ operation, input }) => ({
    operation,
    targetSessionId: input.sessionId,
    actorSessionId: input.request.initiator.sessionId,
  })), [
    { operation: "run", targetSessionId: "session-c", actorSessionId: "session-b" },
    { operation: "run", targetSessionId: "session-c", actorSessionId: "session-b" },
    { operation: "enqueue", targetSessionId: "session-c", actorSessionId: "session-b" },
  ]);
  assert.equal(mutations[0]?.input.requestFingerprint, mutations[1]?.input.requestFingerprint);
  assert.equal(mutations[0]?.input.requestFingerprint, mutations[2]?.input.requestFingerprint);
  assert.equal("error" in forbiddenOtherRoot && forbiddenOtherRoot.error.code, "SESSION_TURN_FORBIDDEN");
  assert.notEqual(
    mutations[0]?.input.request.initiator.character.name,
    mutations[1]?.input.request.initiator.character.name,
  );

  const beforeInvalid = mutations.length;
  const spoofed = await executeBound(service, "turn.run", {
    ...targetCInput,
    actorSessionId: "spoofed-actor",
    character: { characterId: "spoofed-character" },
  }, actorB);
  const missingTarget = await executeBound(service, "turn.enqueue", {
    ...targetCInput,
    sessionId: undefined,
  }, actorB);
  const missingCanonicalTarget = await executeBound(service, "turn.run", {
    ...targetCInput,
    sessionId: "missing-session",
    idempotencyKey: "missing-canonical-target",
  }, actorB);
  assert.equal("error" in spoofed && spoofed.error.code, "INVALID_INPUT");
  assert.equal("error" in missingTarget && missingTarget.error.code, "INVALID_INPUT");
  assert.equal("error" in missingCanonicalTarget && missingCanonicalTarget.error.code, "SESSION_NOT_FOUND");
  assert.equal(mutations.length, beforeInvalid);
  assert.equal(publicGetCalls, 0);
});

test("ID-03: actor Sessionのcharacter snapshotを解決できない場合はexecutionを作成しない", async () => {
  let runInvoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator: async () => null,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    executionService: {
      beginShutdown() {},
      async run() { runInvoked = true; return execution; },
      async enqueue() { runInvoked = true; return execution; },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  });
  const response = await executeBound(service, "turn.run", mutationInput);
  assert.equal("error" in response && response.error.code, "SESSION_INITIATOR_UNAVAILABLE");
  assert.equal("error" in response && response.error.effect, "not_applied");
  assert.equal(runInvoked, false);
});

test("TN-AUTH-01/TN-SNAPSHOT-02: explicit targetを副作用前に検証しsource snapshotをactorと分離して保存する", async () => {
  const mutations: any[] = [];
  const resolvedSessions: string[] = [];
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator: async (sessionId) => ({
      kind: "session",
      sessionId,
      character: {
        characterId: `character-${sessionId}`,
        name: `Character ${sessionId}`,
        iconFilePath: `C:/characters/${sessionId}.png`,
      },
    }),
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    getTurnAuthoritySession(sessionId) {
      if (sessionId === "actor-session") {
        return communicationSession(sessionId, "overall-coordinator", sessionId, null, 0);
      }
      if (sessionId === "source-session") {
        return communicationSession(sessionId, "task-coordinator", "actor-session", "actor-session", 1);
      }
      if (sessionId === "target-session") {
        return communicationSession(sessionId, "executor", "actor-session", "source-session", 2);
      }
      if (sessionId === "other-target") {
        return communicationSession(sessionId, "task-coordinator", "actor-session", "actor-session", 1);
      }
      if (sessionId === "cross-root-target") {
        return communicationSession(sessionId, "standalone", sessionId, null, 0);
      }
      return null;
    },
    crudService: {
      async get(sessionId: string) {
        resolvedSessions.push(sessionId);
        if (sessionId === "missing-session") {
          throw new SessionCrudError("SESSION_NOT_FOUND", "missing", false, { sessionId });
        }
        if (sessionId === "actor-session") {
          return communicationSession(sessionId, "overall-coordinator", sessionId, null, 0);
        }
        if (sessionId === "source-session") {
          return communicationSession(sessionId, "task-coordinator", "actor-session", "actor-session", 1);
        }
        return communicationSession(sessionId, "standalone", sessionId, null, 0);
      },
    },
    executionService: {
      beginShutdown() {},
      async run(input: any) {
        mutations.push(input);
        return { ...execution, sessionId: input.sessionId };
      },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; },
      get() { throw new Error("unused"); },
      listPage() { return []; },
      async cancel() { throw new Error("unused"); },
      async waitForTerminal() { throw new Error("unused"); },
    },
  } as any);
  const actor = { ...actorBinding, actorSessionId: "actor-session" };
  const configured = {
    ...mutationInput,
    sessionId: "source-session",
    terminalFailureNotification: { targetSessionId: "target-session" },
  };

  const accepted = await executeBound(service, "turn.run", configured, actor);
  assert.equal("result" in accepted, true);
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].input?.request, undefined);
  assert.equal(mutations[0].request.initiator.sessionId, "actor-session");
  assert.equal(mutations[0].request.terminalFailureNotification.targetSessionId, "target-session");
  assert.equal(mutations[0].request.terminalFailureNotification.sourceSession.sessionId, "source-session");
  assert.equal(mutations[0].request.terminalFailureNotification.sourceSession.character.name,
    "Character source-session");
  assert.deepEqual(resolvedSessions, []);

  const beforeRejected = mutations.length;
  const same = await executeBound(service, "turn.run", {
    ...configured,
    idempotencyKey: "same-target-key",
    terminalFailureNotification: { targetSessionId: "source-session" },
  }, actor);
  const missing = await executeBound(service, "turn.run", {
    ...configured,
    idempotencyKey: "missing-target-key",
    terminalFailureNotification: { targetSessionId: "missing-session" },
  }, actor);
  const crossRoot = await executeBound(service, "turn.run", {
    ...configured,
    idempotencyKey: "cross-root-target-key",
    terminalFailureNotification: { targetSessionId: "cross-root-target" },
  }, actor);
  assert.equal("error" in same && same.error.code, "TERMINAL_NOTIFICATION_SAME_SESSION");
  assert.equal("error" in missing && missing.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in crossRoot && crossRoot.error.code, "SESSION_TURN_FORBIDDEN");
  assert.equal(mutations.length, beforeRejected);

  await executeBound(service, "turn.run", {
    ...configured,
    idempotencyKey: "different-target-key",
    terminalFailureNotification: { targetSessionId: "other-target" },
  }, actor);
  assert.notEqual(mutations[0].requestFingerprint, mutations[1].requestFingerprint);
});

test("TN-AUTH-01: canonical replayはtargetとsource snapshotのcurrent解決より先に返る", async () => {
  let resolved = 0;
  let runInvoked = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator: async () => { resolved += 1; return null; },
    currentModelCatalog: () => null,
    crudService: { async get() { resolved += 1; throw new Error("must not resolve"); } },
    executionService: {
      beginShutdown() {},
      async run() { runInvoked = true; return execution; },
      async enqueue() { throw new Error("unused"); },
      resolveReplay() { return execution; },
      get() { return execution; },
      listPage() { return []; },
      async cancel() { return execution; },
      async waitForTerminal() { return execution; },
    },
  } as any);
  const response = await executeBound(service, "turn.run", {
    ...mutationInput,
    terminalFailureNotification: { targetSessionId: "target-session" },
  });
  assert.equal("result" in response, true);
  assert.equal(resolved, 0);
  assert.equal(runInvoked, false);
});

test("LC-01: shutdown admission後はapplication dependencyを呼ばずnot_appliedで拒否する", async () => {
  let invoked = false;
  let executionShutdownBegun = false;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
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

  const response = await executeBound(service, "turn.run", mutationInput);

  assert.equal(invoked, false);
  assert.equal(executionShutdownBegun, true);
  assert.equal("error" in response && response.error.code, "RUNTIME_SHUTTING_DOWN");
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("ER-01: 副作用前のSession domain errorをstable codeとnot_appliedへ写像する", async () => {
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
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

  const response = await executeBound(service, "turn.run", mutationInput);

  assert.equal("error" in response && response.error.code, "SESSION_NOT_FOUND");
  assert.equal("error" in response && response.error.retryable, false);
  assert.equal("error" in response && response.error.effect, "not_applied");
});

test("EXT-INTERACTION-11/EXT-OBSERVATION-12: respondはanswered interactionとpublic executionを返す", async () => {
  const answered = {
    sequence: 1,
    id: "interaction-1",
    sessionId: "session-1",
    executionId: "execution-1",
    kind: "approval" as const,
    state: "answered" as const,
    publicPayload: { title: "Approve", summary: "Run command" },
    response: { action: "approve" as const, submittedFields: [] },
    expiryReason: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    resolvedAt: "2026-08-13T00:01:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z",
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    executionService: {
      beginShutdown() {}, async run() { throw new Error("unused"); }, async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; }, get() { return execution; },
      getRecord() { return { ...execution, request: { catalogRevision: 4, turn: mutationInput.turn }, sequence: 1 }; },
      listPage() { return []; }, async cancel() { throw new Error("unused"); }, async waitForTerminal() { return execution; },
    },
    interactionService: {
      getPendingForExecution() { return null; }, listSessionInteractionsPage() { return []; },
      respond() { return { interaction: answered, replayed: false }; }, subscribeExecution() { return () => undefined; },
    } as never,
    progressStorage: {
      get() { return { executionId: "execution-1", assistantText: "partial", truncated: false, updatedAt: "now" }; },
    },
    crudService: {
      async create() { throw new Error("unused"); }, async list() { throw new Error("unused"); },
      async get() { throw new Error("unused"); }, async rename() { throw new Error("unused"); },
    },
  });
  const response = await executeBound(service, "interaction.respond", {
    sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
    response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1", responseMode: "deferred",
  });
  assert.ok("result" in response);
  if (!("result" in response)) return;
  assert.equal(response.result.interaction.state, "answered");
  assert.equal(response.result.execution.effectiveTurn?.provider, "codex");
  assert.deepEqual(response.result.execution.attachments, []);
  assert.equal(response.result.execution.partialOutput?.assistantText, "partial");
  assert.equal("provider" in response.result.interaction.request, false);
});

test("EXT-INTERACTION-11/EXT-OBSERVATION-12: turn.run waitはCopilotでも最初のpending interactionを返す", async () => {
  let pending: SessionInteraction | null = null;
  let observer: (() => void) | null = null;
  const copilotTurn = {
    provider: "copilot" as const,
    userMessage: "hello",
    model: "claude-sonnet-4",
    reasoningEffort: "high" as const,
    approvalMode: "on-request" as const,
    customAgentName: "",
    attachments: [],
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    executionService: {
      beginShutdown() {},
      async run() {
        setTimeout(() => {
          pending = {
            sequence: 1, id: "interaction-1", sessionId: "session-1", executionId: "execution-1",
            kind: "approval", state: "pending", publicPayload: { title: "Approve", summary: "Run command" },
            response: null, expiryReason: null, createdAt: "now", resolvedAt: null, updatedAt: "now",
          };
          observer?.();
        }, 0);
        return execution;
      },
      async enqueue() { throw new Error("unused"); }, resolveReplay() { return null; }, get() { return execution; },
      getRecord() { return { ...execution, request: { catalogRevision: 4, turn: copilotTurn }, sequence: 1 }; },
      listPage() { return []; }, async cancel() { throw new Error("unused"); },
      async waitForTerminal() { return new Promise<SessionExecution>(() => undefined); },
    },
    interactionService: {
      getPendingForExecution() { return pending; }, listSessionInteractionsPage() { return []; },
      respond() { throw new Error("unused"); },
      subscribeExecution(_executionId: string, next: () => void) { observer = next; return () => { observer = null; }; },
    } as never,
  });

  const response = await executeBound(service, "turn.run", {
    ...mutationInput,
    turn: copilotTurn,
    responseMode: "wait",
    waitTimeoutMs: 500,
  });

  assert.ok("result" in response);
  if (!("result" in response)) return;
  assert.equal(response.result.effectiveTurn?.provider, "copilot");
  assert.equal(response.result.pendingInteraction?.interactionId, "interaction-1");
});

test("EXT-INTERACTION-11: interaction.respond waitは回答後の次のpending interactionまで待つ", async () => {
  let pending: SessionInteraction | null = null;
  let observer: (() => void) | null = null;
  const answered: SessionInteraction = {
    sequence: 1, id: "interaction-1", sessionId: "session-1", executionId: "execution-1",
    kind: "approval", state: "answered", publicPayload: { title: "Approve", summary: "Run command" },
    response: { action: "approve", submittedFields: [] }, expiryReason: null,
    createdAt: "now", resolvedAt: "now", updatedAt: "now",
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    executionService: {
      beginShutdown() {}, async run() { throw new Error("unused"); }, async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; }, get() { return execution; },
      getRecord() { return { ...execution, request: { catalogRevision: 4, turn: mutationInput.turn }, sequence: 1 }; },
      listPage() { return []; }, async cancel() { throw new Error("unused"); },
      async waitForTerminal() { return new Promise<SessionExecution>(() => undefined); },
    },
    interactionService: {
      getPendingForExecution() { return pending; }, listSessionInteractionsPage() { return []; },
      respond() {
        setTimeout(() => {
          pending = {
            sequence: 2, id: "interaction-2", sessionId: "session-1", executionId: "execution-1",
            kind: "elicitation", state: "pending", publicPayload: { mode: "form", message: "Next", fields: [] },
            response: null, expiryReason: null, createdAt: "later", resolvedAt: null, updatedAt: "later",
          };
          observer?.();
        }, 0);
        return { interaction: answered, replayed: false };
      },
      subscribeExecution(_executionId: string, next: () => void) { observer = next; return () => { observer = null; }; },
    } as never,
  });

  const response = await executeBound(service, "interaction.respond", {
    sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
    response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1",
    responseMode: "wait", waitTimeoutMs: 500,
  });

  assert.ok("result" in response);
  if (!("result" in response)) return;
  assert.equal(response.result.interaction.state, "answered");
  assert.equal(response.result.execution.pendingInteraction?.interactionId, "interaction-2");
});

test("WORK-EXEC-05: run/enqueue/get/listは同じWork Item associationを投影する", async () => {
  const accepted: string[] = [];
  const record = {
    ...execution,
    sessionId: "session-target",
    sequence: 1,
    request: { turn: mutationInput.turn },
  };
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    workItemService: {
      create() { throw new Error("unused"); },
      get() { throw new Error("unused"); },
      resolveListScope() { throw new Error("unused"); },
      iterateList() { return []; },
      transition() { throw new Error("unused"); },
      reportResult() { throw new Error("unused"); },
      cancel() { throw new Error("unused"); },
      requireExecutionAssociation(workItemId) {
        accepted.push(workItemId);
        return {} as never;
      },
    },
    getExecutionWorkItemId: () => "work-1",
    executionService: {
      beginShutdown() {},
      async run() { return { ...execution, sessionId: "session-target" }; },
      async enqueue() { return { ...execution, sessionId: "session-target", operation: "turn.enqueue" }; },
      resolveReplay() { return null; },
      get() { return record; },
      getRecord() { return record; },
      listPage() { return [record]; },
      async cancel() { return execution; },
      async waitForTerminal() { return execution; },
    },
  });
  const base = {
    ...mutationInput,
    sessionId: "session-target",
    workItemId: "work-1",
  };
  const run = await executeBound(service, "turn.run", base);
  const enqueue = await executeBound(service, "turn.enqueue", {
    sessionId: base.sessionId,
    catalogRevision: base.catalogRevision,
    idempotencyKey: "enqueue-work",
    turn: base.turn,
    workItemId: base.workItemId,
  });
  const get = await executeBound(service, "turn.get", {
    sessionId: "session-target",
    executionId: execution.id,
  });
  const list = await executeBound(service, "turn.list", { sessionId: "session-target", limit: 10 });
  assert.deepEqual(accepted, ["work-1", "work-1"]);
  assert.equal((run as any).result.workItemId, "work-1");
  assert.equal((enqueue as any).result.workItemId, "work-1");
  assert.equal((get as any).result.workItemId, "work-1");
  assert.equal((list as any).result.items[0].workItemId, "work-1");
});

test("WORK-EXEC-05: 同じTurn keyでWork Item associationを変更するとconflictになる", async () => {
  let canonicalFingerprint: string | null = null;
  const service = new SessionExternalApplicationService({
    resolveTurnInitiator,
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    workItemService: {
      create() { throw new Error("unused"); }, get() { throw new Error("unused"); },
      resolveListScope() { throw new Error("unused"); }, iterateList() { return []; },
      transition() { throw new Error("unused"); }, reportResult() { throw new Error("unused"); }, cancel() { throw new Error("unused"); },
      requireExecutionAssociation() { return {} as never; },
    },
    getExecutionWorkItemId: () => "work-a",
    executionService: {
      beginShutdown() {},
      resolveReplay(operation, input) {
        if (canonicalFingerprint === null) return null;
        if (canonicalFingerprint !== input.requestFingerprint) {
          throw new SessionExecutionIdempotencyConflictError(operation, input.idempotencyKey);
        }
        return execution;
      },
      async run(input) { canonicalFingerprint = input.requestFingerprint; return execution; },
      async enqueue() { throw new Error("unused"); }, get() { return execution; }, getRecord() { return { ...execution, request: {} }; },
      listPage() { return []; }, async cancel() { throw new Error("unused"); }, async waitForTerminal() { return execution; },
    },
  });
  const first = await executeBound(service, "turn.run", { ...mutationInput, workItemId: "work-a" });
  const second = await executeBound(service, "turn.run", { ...mutationInput, workItemId: "work-b" });
  assert.ok("result" in first);
  assert.ok("error" in second);
  if ("error" in second) assert.equal(second.error.code, "IDEMPOTENCY_CONFLICT");
});

function createWorkListService(openList: (input: {
  afterSequence: number | null;
  limit: number;
}, binding: ResolvedAgentRuntimeBinding) => {
  scope: { rootSessionId: string; actorSessionId: string; visibility: "root" | "actor" };
  items: Iterable<WorkItem>;
}) {
  return new SessionExternalApplicationService({
    resolveTurnInitiator,
    crudService: defaultCommunicationCrudService,
    getTurnAuthoritySession: getDefaultTurnAuthoritySession,
    currentModelCatalog: () => ({ revision: 4, providers: [] }),
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    workItemService: {
      create() { throw new Error("unused"); }, get() { throw new Error("unused"); },
      resolveListScope(binding) {
        return openList({ afterSequence: null, limit: 0 }, binding).scope;
      },
      iterateList(input, scope) {
        return openList(input, { ...actorBinding, actorSessionId: scope.actorSessionId }).items;
      },
      transition() { throw new Error("unused"); }, reportResult() { throw new Error("unused"); },
      cancel() { throw new Error("unused"); }, requireExecutionAssociation() { throw new Error("unused"); },
    } as never,
    executionService: {
      beginShutdown() {}, async run() { throw new Error("unused"); }, async enqueue() { throw new Error("unused"); },
      resolveReplay() { return null; }, get() { return execution; }, getRecord() { return { ...execution, request: {} }; },
      listPage() { return []; }, async cancel() { throw new Error("unused"); }, async waitForTerminal() { return execution; },
    },
  });
}

function workItem(sequence: number, largeResult = false): WorkItem {
  return {
    id: `work-${sequence}`,
    sequence,
    contractRevision: 1,
    rootSessionId: "root-a",
    creatorSessionId: "creator",
    targetSessionId: "target",
    parentWorkItemId: null,
    goal: "goal",
    scope: "scope",
    completionCriteria: "done",
    authority: "local",
    sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
    state: "completed",
    revision: 2,
    result: {
      outcome: "completed",
      summary: "completed",
      changes: largeResult ? Array.from({ length: 15 }, () => "x".repeat(16_000)) : [],
      verificationResults: [],
      findings: [],
      unverifiedItems: [],
      remainingWork: [],
      reportingSessionId: "target",
      reportedAt: "2026-08-24T00:00:00.000Z",
    },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:01:00.000Z",
  };
}

test("WORK-LIST-08: cursorをroot・actor・visibility scopeへ束縛する", async () => {
  let iterations = 0;
  const items = [workItem(1), workItem(2)];
  const service = createWorkListService((input, binding) => ({
    scope: {
      rootSessionId: binding.actorSessionId === "actor-other-root" ? "root-b" : "root-a",
      actorSessionId: binding.actorSessionId,
      visibility: "actor",
    },
    items: (function* () {
      for (const item of items.filter((candidate) => candidate.sequence > (input.afterSequence ?? 0)).slice(0, input.limit)) {
        iterations += 1;
        yield item;
      }
    })(),
  }));
  const bindingFor = (actorSessionId: string): ResolvedAgentRuntimeBinding => ({ ...actorBinding, actorSessionId });
  const first = await executeBound(service, "work.list", { limit: 1 }, bindingFor("actor-a"));
  assert.ok("result" in first && first.result.nextCursor);
  if (!("result" in first) || !first.result.nextCursor) return;
  const sameActor = await executeBound(service, "work.list", { limit: 1, cursor: first.result.nextCursor }, bindingFor("actor-a"));
  assert.deepEqual("result" in sameActor ? sameActor.result.items.map((item) => item.id) : [], ["work-2"]);
  const otherActor = await executeBound(service, "work.list", { limit: 1, cursor: first.result.nextCursor }, bindingFor("actor-b"));
  const otherRoot = await executeBound(service, "work.list", { limit: 1, cursor: first.result.nextCursor }, bindingFor("actor-other-root"));
  assert.equal("error" in otherActor && otherActor.error.code, "INVALID_CURSOR");
  assert.equal("error" in otherRoot && otherRoot.error.code, "INVALID_CURSOR");
  assert.equal(iterations, 3);
});

test("WORK-LIST-09: result付き一覧をresponse byte上限でpage分割し欠落なく継続する", async () => {
  const allItems = Array.from({ length: 50 }, (_, index) => workItem(index + 1, true));
  let iterations = 0;
  const service = createWorkListService((input, binding) => ({
    scope: { rootSessionId: "root-a", actorSessionId: binding.actorSessionId, visibility: "root" },
    items: (function* () {
      for (const item of allItems.filter((candidate) => candidate.sequence > (input.afterSequence ?? 0)).slice(0, input.limit)) {
        iterations += 1;
        yield item;
      }
    })(),
  }));
  const listedIds: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await executeBound(service, "work.list", { limit: 50, ...(cursor ? { cursor } : {}) });
    assert.ok("result" in response);
    if (!("result" in response)) return;
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
    listedIds.push(...response.result.items.map((item) => item.id));
    cursor = response.result.nextCursor;
  } while (cursor);
  assert.deepEqual(listedIds, allItems.map((item) => item.id));
  assert.equal(new Set(listedIds).size, allItems.length);
  assert.ok(iterations <= allItems.length + 2);
});
