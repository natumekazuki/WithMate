import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
  parseSessionRuntimeOperationInput,
} from "../../src/session-external-runtime-contract.js";
import {
  SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
  SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER,
  SESSION_RUNTIME_GENERATION_HEADER,
  SESSION_RUNTIME_NONCE_HEADER,
  SESSION_RUNTIME_OPERATION_PATH,
} from "../../src/session-runtime-exchange.js";
import {
  WORK_ITEM_DEFAULT_LIST_LIMIT,
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_RESULT_ITEMS,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WorkItemEventPayloadTooLargeError,
  type WorkItemEvent,
} from "../../src/work-item.js";
import { AgentRuntimeBindingRegistry, type ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { SessionExternalApplicationService } from "../../src-electron/session-external-application-service.js";
import { createSessionRuntimeHttpServer } from "../../src-electron/session-runtime-http-server.js";
import {
  WorkItemIdempotencyResponseUnavailableError,
  WorkItemRevisionConflictError,
} from "../../src-electron/work-item-storage-v6.js";
import {
  SESSION_MCP_TOOL_DEFINITIONS,
  createWithMateSessionMcpServer,
} from "../withmate-session-mcp.js";
import {
  WITHMATE_SESSION_CLI_EXIT_CODES,
  runWithMateSessionCli,
} from "../withmate-session.js";
import type { SessionRuntimeConnection } from "../withmate-session-runtime-client.js";

const rootWorkItem = {
  id: "work-root",
  sequence: 1,
  contractRevision: 2 as const,
  kind: "root" as const,
  rootSessionId: "root-a",
  creatorSessionId: "root-a",
  targetSessionId: "root-a",
  parentWorkItemId: null,
  goal: "Root goal",
  scope: "",
  completionCriteria: "",
  authority: "",
  sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
  state: "in_progress" as const,
  revision: 2,
  progressSummary: "Started",
  blockers: [] as string[],
  nextAction: "Continue",
  result: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:01:00.000Z",
};

const createdEvent: WorkItemEvent = {
  sequence: 1,
  workItemId: rootWorkItem.id,
  revision: 1,
  type: "created",
  actorSessionId: "root-a",
  payload: {
    kind: "root",
    rootSessionId: "root-a",
    creatorSessionId: "root-a",
    targetSessionId: "root-a",
    parentWorkItemId: null,
    sourceIdentity: rootWorkItem.sourceIdentity,
    contract: {
      goal: rootWorkItem.goal,
      scope: rootWorkItem.scope,
      completionCriteria: rootWorkItem.completionCriteria,
      authority: rootWorkItem.authority,
    },
    progress: { progressSummary: "", blockers: [], nextAction: "" },
    state: "pending",
    result: null,
  },
  createdAt: rootWorkItem.createdAt,
};

const progressEvent: WorkItemEvent = {
  sequence: 2,
  workItemId: rootWorkItem.id,
  revision: 2,
  type: "progress",
  actorSessionId: "root-a",
  payload: { progressSummary: "Started", blockers: [], nextAction: "Continue" },
  createdAt: rootWorkItem.updatedAt,
};

const reviseInput = {
  workItemId: rootWorkItem.id,
  goal: "Root goal",
  scope: "",
  completionCriteria: "",
  authority: "",
  expectedRevision: 1,
  idempotencyKey: "revise-1",
};

const historyAppendInput = {
  workItemId: rootWorkItem.id,
  type: "progress" as const,
  summary: "Started",
  blockers: [] as string[],
  nextAction: "Continue",
  expectedRevision: 1,
  idempotencyKey: "progress-1",
};

describe("Root WorkItem public contract", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "shared parserはRoot契約改訂とprogress|handoff履歴入力を正規化し、未知field、不正discriminator、上限超過、非正revision、空idempotency keyをdispatch前に拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "public adapterごとに入力制約がずれ、不正な履歴または競合制御不能なmutationがapplication serviceへ到達する"
  // scope = "session-runtime-shared-parser"
  // lifecycle = "permanent"
  // distinction = "transport固有schemaではなく全public入口が共有するparserと既定履歴limitを直接観測する"
  // @end-test-value
  test("Root WorkItem shared parserは改訂・履歴union・上限・競合入力をstrictに検証する", () => {
  assert.deepEqual(parseSessionRuntimeOperationInput("work.revise", reviseInput), reviseInput);
  assert.deepEqual(parseSessionRuntimeOperationInput("work.history.append", historyAppendInput), historyAppendInput);
  assert.deepEqual(parseSessionRuntimeOperationInput("work.history.append", {
    ...historyAppendInput,
    type: "handoff",
    idempotencyKey: "handoff-1",
  }), {
    ...historyAppendInput,
    type: "handoff",
    idempotencyKey: "handoff-1",
  });
  assert.deepEqual(parseSessionRuntimeOperationInput("work.history.list", {
    workItemId: rootWorkItem.id,
  }), {
    workItemId: rootWorkItem.id,
    limit: WORK_ITEM_DEFAULT_LIST_LIMIT,
  });

  const invalidInputs: Array<{
    operation: "work.revise" | "work.history.append" | "work.history.list";
    input: unknown;
    code: string;
    field: string;
  }> = [
    { operation: "work.revise", input: { ...reviseInput, unknown: true }, code: "INVALID_INPUT", field: "input.unknown" },
    { operation: "work.revise", input: { ...reviseInput, goal: " " }, code: "INVALID_INPUT", field: "goal" },
    { operation: "work.history.append", input: { ...historyAppendInput, type: "created" }, code: "INVALID_INPUT", field: "type" },
    { operation: "work.history.append", input: { ...historyAppendInput, summary: "x".repeat(WORK_ITEM_MAX_TEXT_LENGTH + 1) }, code: "INVALID_INPUT", field: "summary" },
    { operation: "work.history.append", input: { ...historyAppendInput, summary: " " }, code: "INVALID_INPUT", field: "summary" },
    { operation: "work.history.append", input: { ...historyAppendInput, nextAction: " " }, code: "INVALID_INPUT", field: "nextAction" },
    { operation: "work.history.append", input: { ...historyAppendInput, blockers: Array.from({ length: WORK_ITEM_MAX_RESULT_ITEMS + 1 }, () => "blocked") }, code: "LIMIT_EXCEEDED", field: "blockers" },
    { operation: "work.revise", input: { ...reviseInput, expectedRevision: 0 }, code: "INVALID_INPUT", field: "expectedRevision" },
    { operation: "work.history.append", input: { ...historyAppendInput, idempotencyKey: " " }, code: "INVALID_INPUT", field: "idempotencyKey" },
    { operation: "work.history.list", input: { workItemId: rootWorkItem.id, limit: 0 }, code: "LIMIT_EXCEEDED", field: "limit" },
  ];
  for (const candidate of invalidInputs) {
    assert.throws(
      () => parseSessionRuntimeOperationInput(candidate.operation, candidate.input),
      (error) => error instanceof SessionRuntimeValidationError
        && error.code === candidate.code
        && error.details.field === candidate.field,
      candidate.operation + ":" + candidate.field,
    );
  }
  const acceptedLargeHistory = {
    ...historyAppendInput,
    blockers: Array.from({ length: 32 }, () => "x".repeat(WORK_ITEM_MAX_TEXT_LENGTH)),
  };
  assert.equal(
    parseSessionRuntimeOperationInput("work.history.append", acceptedLargeHistory).blockers.length,
    32,
  );
  const oversizedHistory = {
    ...historyAppendInput,
    blockers: Array.from({ length: 33 }, () => "x".repeat(WORK_ITEM_MAX_TEXT_LENGTH)),
  };
  assert.throws(
    () => parseSessionRuntimeOperationInput("work.history.append", oversizedHistory),
    (error) => error instanceof SessionRuntimeValidationError
      && error.code === "CONTENT_TOO_LARGE"
      && error.details.field === "input"
      && error.details.maxBytes === WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  );
});

  // @test-value v1
  // kind = "contract"
  // claim = "raw HTTP runtime envelopeはRoot WorkItem操作を認証済みactor bindingとともにhandlerへ渡し、不正unionをhandler前に拒否し、適用済みlegacy replay復元不能errorを409で返す"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "新operationがHTTP routingから欠落する、不正な履歴種別がapplication handlerへ到達する、または適用済みlegacy replayを400へ崩してconsumerが競合処理できない"
  // scope = "session-runtime-http"
  // lifecycle = "permanent"
  // distinction = "client wrapperではなく交換envelopeをHTTP socketへ送りwire statusとhandler入力を観測する"
  // @end-test-value
  test("raw HTTP envelopeはRoot WorkItem公開操作をroutingし不正unionをdispatchしない", async () => {
  const registry = new AgentRuntimeBindingRegistry();
  const projection = registry.issueOrReuse({
    actorSessionId: "root-a",
    providerId: "codex",
    operationGrants: ["session.runtime.invoke"],
  });
  const calls: Array<{ operation: string; input: unknown; actorSessionId: string | null }> = [];
  const server = createSessionRuntimeHttpServer({
    apiSecret: "api-secret",
    cliSecret: "cli-secret",
    mcpSecret: "mcp-secret",
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agentRuntimeBindingRegistry: registry,
    handle: async (operation, input, _adapter, context) => {
      calls.push({ operation, input, actorSessionId: context.agentRuntimeBinding?.actorSessionId ?? null });
      if (operation === "work.revise" && (input as { expectedRevision?: number }).expectedRevision === 98) {
        return createSessionRuntimeError({
          code: "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
          message: "The original idempotent Work Item response is unavailable after migration.",
          retryable: false,
          effect: "applied",
          details: { operation: "work.revise", workItemId: rootWorkItem.id },
        });
      }
      return createSessionRuntimeResult(operation, {} as never);
    },
  });
  await server.start();
  try {
    const address = server.address();
    assert.ok(address);
    const inputs = [
      ["work.revise", reviseInput],
      ["work.history.append", historyAppendInput],
      ["work.history.list", { workItemId: rootWorkItem.id }],
    ] as const;
    for (const [operation, input] of inputs) {
      const response = await postRawRuntime(address.port, createExchangePayload(
        operation,
        input,
        projection.bindingReference,
      ));
      assert.equal(response.status, 200, operation);
      assert.equal(JSON.parse(response.body).operation, operation);
    }

    const invalid = await postRawRuntime(address.port, createExchangePayload(
      "work.history.append",
      { ...historyAppendInput, type: "result_reported" },
      projection.bindingReference,
    ));
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.body).error.code, "INVALID_INPUT");
    const emptySummary = await postRawRuntime(address.port, createExchangePayload(
      "work.history.append",
      { ...historyAppendInput, summary: "" },
      projection.bindingReference,
    ));
    assert.equal(emptySummary.status, 400);
    assert.equal(JSON.parse(emptySummary.body).error.code, "INVALID_INPUT");
    const unavailableReplay = await postRawRuntime(address.port, createExchangePayload(
      "work.revise",
      { ...reviseInput, expectedRevision: 98 },
      projection.bindingReference,
    ));
    assert.equal(unavailableReplay.status, 409);
    assert.equal(JSON.parse(unavailableReplay.body).error.code, "IDEMPOTENCY_RESPONSE_UNAVAILABLE");
    assert.equal(JSON.parse(unavailableReplay.body).error.effect, "applied");
    assert.deepEqual(calls.map((call) => call.operation), [...inputs.map(([operation]) => operation), "work.revise"]);
    assert.ok(calls.every((call) => call.actorSessionId === "root-a"));
    assert.deepEqual(calls[2]?.input, { workItemId: rootWorkItem.id, limit: WORK_ITEM_DEFAULT_LIST_LIMIT });
  } finally {
    await server.stop();
  }
});

// @test-value v1
// kind = "contract"
// claim = "application dispatchはRoot owner bindingを各操作へ渡し、成功mutationだけinvalidateし、history cursor、revision conflict、event payload超過、legacy replay復元不能をstableなerrorへ投影する"
// oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
// failure_mode = "外部mutation後もGUIが古いprojectionを保持する、拒否mutationでinvalidateする、cursor scopeを破る、またはstale revision、payload超過、適用済みlegacy replayをgeneric errorへ崩す"
// scope = "session-external-application-service"
// lifecycle = "permanent"
// distinction = "parserとtransportでは見えないowner binding、成功二件と三種の失敗のinvalidation差、cursor scope、domain errorのeffect/detailsをapplication境界で観測する"
// @end-test-value
test("application dispatchはRoot owner method・history cursor scope・revision errorを保つ", async () => {
  const calls: Array<{ method: string; input: unknown; actorSessionId: string }> = [];
  const invalidatedSessionIds: string[] = [];
  const service = new SessionExternalApplicationService({
    executionService: { beginShutdown() {} },
    crudService: {},
    currentModelCatalog: () => null,
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    resolveTurnInitiator: async () => null,
    getTurnAuthoritySession: () => ({ rootSessionId: "root-a" } as never),
    invalidateSession: (sessionId) => { invalidatedSessionIds.push(sessionId); },
    workItemService: {
      revise(input: typeof reviseInput, binding: ResolvedAgentRuntimeBinding) {
        calls.push({ method: "revise", input, actorSessionId: binding.actorSessionId });
        if (input.expectedRevision === 99) throw new WorkItemRevisionConflictError(input.workItemId, 99, 2);
        if (input.expectedRevision === 98) {
          throw new WorkItemIdempotencyResponseUnavailableError(
            "work.revise",
            input.idempotencyKey,
            input.workItemId,
          );
        }
        if (input.expectedRevision === 97) {
          throw new WorkItemEventPayloadTooLargeError("contract_revised", 524_289, 524_288);
        }
        return rootWorkItem;
      },
      appendHistory(input: typeof historyAppendInput, binding: ResolvedAgentRuntimeBinding) {
        calls.push({ method: "appendHistory", input, actorSessionId: binding.actorSessionId });
        return rootWorkItem;
      },
      resolveListScope(binding: ResolvedAgentRuntimeBinding) {
        return { rootSessionId: "root-a", actorSessionId: binding.actorSessionId, visibility: "root" as const };
      },
      iterateHistory(input: { workItemId: string; limit: number; afterSequence: number | null }, binding: ResolvedAgentRuntimeBinding) {
        calls.push({ method: "iterateHistory", input, actorSessionId: binding.actorSessionId });
        return input.afterSequence === null ? [createdEvent, progressEvent] : [progressEvent];
      },
    },
  } as any);

  const owner = actorBinding("root-a");
  assert.equal((await service.execute("work.revise", reviseInput, owner)).operation, "work.revise");
  assert.equal((await service.execute("work.history.append", historyAppendInput, owner)).operation, "work.history.append");
  const first = await service.execute("work.history.list", { workItemId: rootWorkItem.id, limit: 1 }, owner);
  assert.equal(first.operation, "work.history.list");
  assert.ok("result" in first && first.result.nextCursor);

  const foreignCursor = await service.execute("work.history.list", {
    workItemId: rootWorkItem.id,
    limit: 1,
    cursor: "result" in first ? first.result.nextCursor : undefined,
  }, actorBinding("root-b"));
  assert.ok("error" in foreignCursor);
  assert.equal("error" in foreignCursor ? foreignCursor.error.code : "", "INVALID_CURSOR");

  const stale = await service.execute("work.revise", { ...reviseInput, expectedRevision: 99 }, owner);
  assert.ok("error" in stale);
  assert.equal("error" in stale ? stale.error.code : "", "WORK_ITEM_REVISION_CONFLICT");
  const unavailableReplay = await service.execute("work.revise", { ...reviseInput, expectedRevision: 98 }, owner);
  assert.ok("error" in unavailableReplay);
  assert.deepEqual(unavailableReplay, {
    schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
    error: {
      code: "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
      message: "The original idempotent Work Item response is unavailable after migration.",
      retryable: false,
      effect: "applied",
      details: {
        operation: "work.revise",
        workItemId: rootWorkItem.id,
      },
    },
  });
  const oversized = await service.execute("work.revise", { ...reviseInput, expectedRevision: 97 }, owner);
  assert.deepEqual(oversized, {
    schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
    error: {
      code: "CONTENT_TOO_LARGE",
      message: "Work Item event payload exceeds the byte limit.",
      retryable: false,
      effect: "not_applied",
      details: { eventType: "contract_revised", actualBytes: 524_289, maxBytes: 524_288 },
    },
  });
  assert.deepEqual(invalidatedSessionIds, ["root-a", "root-a"]);
  assert.deepEqual(calls.slice(0, 3).map(({ method, actorSessionId }) => ({ method, actorSessionId })), [
    { method: "revise", actorSessionId: "root-a" },
    { method: "appendHistory", actorSessionId: "root-a" },
    { method: "iterateHistory", actorSessionId: "root-a" },
  ]);
  assert.deepEqual((calls[2]?.input as { limit: number; afterSequence: number | null }), {
    workItemId: rootWorkItem.id,
    limit: 2,
    afterSequence: null,
  });
  assert.equal(calls.some((call) => call.method === "iterateHistory" && call.actorSessionId === "root-b"), false);
});

  // @test-value v1
  // kind = "regression"
  // claim = "work.history.listは8 MiBへ収まるeventだけをiteratorから読み、last included sequenceのcursorで次pageを欠落なく再開する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "個々は512 KiB以内のeventを全件展開してmain processへ過大な負荷を掛けるか、要求全体をLIMIT_EXCEEDEDで拒否してconsumerが履歴へ到達できない"
  // scope = "SessionExternalApplicationService work.history.list response projection"
  // lifecycle = "permanent"
  // distinction = "単一巨大eventではなくvalidな大容量eventを複数生成し、iterator消費件数、response byte上限、短いpage、cursor連続性を同時に観測する"
  // @end-test-value
  test("work.history.listはresponse上限へ収まるpageと継続cursorを返す", async () => {
  const largeBlockers = Array.from({ length: 25 }, () => "x".repeat(WORK_ITEM_MAX_TEXT_LENGTH));
  const events: WorkItemEvent[] = Array.from({ length: 30 }, (_, index) => ({
    ...progressEvent,
    sequence: index + 1,
    revision: index + 1,
    payload: {
      progressSummary: `progress-${index + 1}`,
      blockers: largeBlockers,
      nextAction: "Continue",
    },
  }));
  let yieldedEvents = 0;
  const service = new SessionExternalApplicationService({
    executionService: { beginShutdown() {} },
    crudService: {},
    currentModelCatalog: () => null,
    isProviderEnabled: () => true,
    isProviderSupported: () => true,
    discoverSessionCustomAgents: async () => [],
    resolveTurnInitiator: async () => null,
    getTurnAuthoritySession: () => null,
    workItemService: {
      resolveListScope(binding: ResolvedAgentRuntimeBinding) {
        return { rootSessionId: "root-a", actorSessionId: binding.actorSessionId, visibility: "root" as const };
      },
      *iterateHistory(input: { limit: number; afterSequence: number | null }) {
        for (const event of events.filter((candidate) => candidate.sequence > (input.afterSequence ?? 0)).slice(0, input.limit)) {
          yieldedEvents += 1;
          yield event;
        }
      },
    },
  } as any);

  const first = await service.execute("work.history.list", {
    workItemId: rootWorkItem.id,
    limit: WORK_ITEM_DEFAULT_LIST_LIMIT,
  }, actorBinding("root-a"));
  assert.ok("result" in first);
  if (!("result" in first)) throw new Error("first history page failed");
  assert.ok(first.result.items.length > 0);
  assert.ok(first.result.items.length < events.length);
  assert.ok(first.result.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
  const firstPageYieldCount = yieldedEvents;
  assert.ok(firstPageYieldCount < events.length);

  const lastSequence = first.result.items.at(-1)?.sequence;
  const second = await service.execute("work.history.list", {
    workItemId: rootWorkItem.id,
    limit: WORK_ITEM_DEFAULT_LIST_LIMIT,
    cursor: first.result.nextCursor,
  }, actorBinding("root-a"));
  assert.ok("result" in second);
  if (!("result" in second)) throw new Error("second history page failed");
  assert.equal(second.result.items[0]?.sequence, (lastSequence ?? 0) + 1);
  assert.ok(Buffer.byteLength(JSON.stringify(second), "utf8") <= SESSION_RUNTIME_MAX_RESPONSE_BYTES);
});

  // @test-value v1
  // kind = "contract"
  // claim = "MCPは三つのRoot WorkItem toolをstrict input/output schemaで登録し、kindごとのbinding tupleとprogress fieldを満たすvalid payloadだけを同名operationへdispatchする"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "tool登録漏れ、unknown input受理、不正history discriminator受理、またはroot/delegatedのbindingとprogress fieldが不整合なoutput受理によりMCP consumerの契約がHTTPと分岐する"
  // scope = "withmate-session-mcp"
  // lifecycle = "permanent"
  // distinction = "tool discovery schemaと実際のMCP input/output validationおよびdispatch envelopeを同じtransport上で観測する"
  // @end-test-value
  test("MCPはRoot WorkItem toolsをstrict schemaで公開しvalid input/outputだけdispatchする", async () => {
  const connection: SessionRuntimeConnection = {
    adapter: "mcp",
    baseUrl: "http://127.0.0.1:1",
    apiSecret: "api-secret",
    adapterSecret: "mcp-secret",
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const requests: Array<{ operation: string; input: unknown }> = [];
  const server = createWithMateSessionMcpServer({
    discover: async () => connection,
    call: async (_connection, envelope) => {
      requests.push({ operation: envelope.operation, input: envelope.input });
      const idempotencyKey = (envelope.input as { idempotencyKey?: string }).idempotencyKey;
      const { progressSummary: _progress, blockers: _blockers, nextAction: _nextAction, ...withoutProgress } = rootWorkItem;
      const result = envelope.operation === "work.history.list"
        ? { items: [createdEvent, progressEvent] }
        : idempotencyKey === "bad-output"
          ? { ...rootWorkItem, unknownProjection: true }
          : idempotencyKey === "bad-root-binding"
            ? { ...rootWorkItem, targetSessionId: "root-b" }
            : idempotencyKey === "bad-delegated-self"
              ? { ...withoutProgress, kind: "delegated", scope: "scope", completionCriteria: "done", authority: "local" }
              : idempotencyKey === "bad-delegated-progress"
                ? { ...rootWorkItem, kind: "delegated", targetSessionId: "task-a", scope: "scope", completionCriteria: "done", authority: "local" }
          : rootWorkItem;
      return { ok: true, status: 200, value: createSessionRuntimeResult(envelope.operation, result as never) };
    },
  });

  await withMcpClient(server, async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.filter((tool) => tool.name.startsWith("work.")).map((tool) => tool.name),
      SESSION_MCP_TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith("work.")).map((tool) => tool.name),
    );
    for (const name of ["work.revise", "work.history.append", "work.history.list"]) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, name);
      assert.equal(tool.inputSchema.additionalProperties, false, name + ":input");
      assert.equal(tool.outputSchema?.additionalProperties, false, name + ":output");
      assert.ok(tool.outputSchema?.required?.includes("result"), name + ":result");
    }
    const appendSchema = tools.tools.find((tool) => tool.name === "work.history.append")!.inputSchema as any;
    assert.deepEqual(appendSchema.properties.type.enum, ["progress", "handoff"]);

    assert.equal((await client.callTool({ name: "work.revise", arguments: reviseInput })).isError, undefined);
    assert.equal((await client.callTool({ name: "work.history.append", arguments: historyAppendInput })).isError, undefined);
    assert.equal((await client.callTool({
      name: "work.history.list",
      arguments: { workItemId: rootWorkItem.id },
    })).isError, undefined);

    const callsBeforeInvalidInput = requests.length;
    assert.equal((await client.callTool({
      name: "work.revise",
      arguments: { ...reviseInput, unknown: true },
    })).isError, true);
    assert.equal((await client.callTool({
      name: "work.history.append",
      arguments: { ...historyAppendInput, type: "created" },
    })).isError, true);
    assert.equal((await client.callTool({
      name: "work.revise",
      arguments: { ...reviseInput, goal: "" },
    })).isError, true);
    assert.equal((await client.callTool({
      name: "work.history.append",
      arguments: { ...historyAppendInput, summary: "" },
    })).isError, true);
    assert.equal((await client.callTool({
      name: "work.history.append",
      arguments: { ...historyAppendInput, nextAction: "" },
    })).isError, true);
    assert.equal(requests.length, callsBeforeInvalidInput);

    assert.equal((await client.callTool({
      name: "work.revise",
      arguments: { ...reviseInput, idempotencyKey: "bad-output" },
    })).isError, true);
    for (const idempotencyKey of ["bad-root-binding", "bad-delegated-self", "bad-delegated-progress"]) {
      assert.equal((await client.callTool({
        name: "work.revise",
        arguments: { ...reviseInput, idempotencyKey },
      })).isError, true, idempotencyKey);
    }
  });

  assert.deepEqual(requests.slice(0, 3), [
    { operation: "work.revise", input: reviseInput },
    { operation: "work.history.append", input: historyAppendInput },
    { operation: "work.history.list", input: { workItemId: rootWorkItem.id, limit: WORK_ITEM_DEFAULT_LIST_LIMIT } },
  ]);
});

  // @test-value v1
  // kind = "contract"
  // claim = "CLIのwork revise、work history append、work history list commandはshared parserの正規化後に対応するruntime operationへ一対一で写像される"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "三語のwork history command解析またはcommand mapが欠け、CLI consumerだけ新しいRoot WorkItem操作を呼べない"
  // scope = "withmate-session-cli"
  // lifecycle = "permanent"
  // distinction = "schema列挙の文字列存在ではなくpublic CLI argvからruntime callまでの実dispatchを観測する"
  // @end-test-value
  test("CLIはRoot WorkItem revise・history append・history listをruntime operationへ写像する", async () => {
  const connection: SessionRuntimeConnection = {
    adapter: "cli",
    baseUrl: "http://127.0.0.1:1",
    apiSecret: "api-secret",
    adapterSecret: "cli-secret",
    applicationInstanceId: "11111111-1111-4111-8111-111111111111",
    runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const requests: Array<{ operation: string; input: unknown }> = [];
  const cases = [
    { args: ["work", "revise", "--json", JSON.stringify(reviseInput)], operation: "work.revise" },
    { args: ["work", "history", "append", "--json", JSON.stringify(historyAppendInput)], operation: "work.history.append" },
    { args: ["work", "history", "list", "--json", JSON.stringify({ workItemId: rootWorkItem.id })], operation: "work.history.list" },
  ] as const;

  for (const candidate of cases) {
    const output = captureOutput();
    const exitCode = await runWithMateSessionCli(candidate.args, {
      stdout: output,
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push({ operation: envelope.operation, input: envelope.input });
        const result = envelope.operation === "work.history.list" ? { items: [createdEvent] } : rootWorkItem;
        return { ok: true, status: 200, value: createSessionRuntimeResult(envelope.operation, result as never) };
      },
    });
    assert.equal(exitCode, WITHMATE_SESSION_CLI_EXIT_CODES.ok, candidate.operation + ":" + output.text());
  }

  assert.deepEqual(requests, [
    { operation: "work.revise", input: reviseInput },
    { operation: "work.history.append", input: historyAppendInput },
    { operation: "work.history.list", input: { workItemId: rootWorkItem.id, limit: WORK_ITEM_DEFAULT_LIST_LIMIT } },
  ]);
  });
});

function createExchangePayload(operation: string, input: unknown, bindingReference: string): string {
  return JSON.stringify({
    schemaVersion: SESSION_RUNTIME_EXCHANGE_SCHEMA_VERSION,
    apiSecret: "api-secret",
    adapter: "mcp",
    adapterSecret: "mcp-secret",
    agentRuntimeBindingReference: bindingReference,
    envelope: {
      schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
      operation,
      input,
    },
  });
}

function postRawRuntime(port: number, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: SESSION_RUNTIME_OPERATION_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_RUNTIME_APPLICATION_INSTANCE_HEADER]: "11111111-1111-4111-8111-111111111111",
        [SESSION_RUNTIME_GENERATION_HEADER]: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        [SESSION_RUNTIME_NONCE_HEADER]: "root-public-nonce",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.once("information", (information) => {
      if (information.statusCode === 103) request.end(payload);
    });
    request.flushHeaders();
  });
}

async function withMcpClient<T>(
  server: ReturnType<typeof createWithMateSessionMcpServer>,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "root-work-item-public-contract-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function captureOutput(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) { chunks.push(chunk); },
    text() { return chunks.join(""); },
  };
}

function actorBinding(actorSessionId: string): ResolvedAgentRuntimeBinding {
  return {
    bindingId: `binding-${actorSessionId}`,
    bindingIdHash: `binding-hash-${actorSessionId}`,
    actorSessionId,
    providerId: "codex",
    executionGeneration: `generation-${actorSessionId}`,
    authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"],
    createdAt: "2026-08-30T00:00:00.000Z",
    expiresAt: null,
  };
}
