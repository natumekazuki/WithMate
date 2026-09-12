import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  SESSION_MCP_SERVER_INSTRUCTIONS,
  SESSION_MCP_TOOL_DEFINITIONS,
  createWithMateSessionMcpServer,
} from "../withmate-session-mcp.js";
import {
  SessionRuntimeClientError,
  SessionRuntimeDiscoveryError,
  type SessionRuntimeConnection,
} from "../withmate-session-runtime-client.js";
import {
  SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
  SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
  SessionRuntimeValidationError,
  createSessionRuntimeError,
  createSessionRuntimeResult,
} from "../../src/session-external-runtime-contract.js";

const connection: SessionRuntimeConnection = {
  adapter: "mcp",
  baseUrl: "http://127.0.0.1:1",
  apiSecret: "api-secret",
  adapterSecret: "mcp-secret",
  applicationInstanceId: "11111111-1111-4111-8111-111111111111",
  runtimeGenerationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const executionInput = { sessionId: "session-1", executionId: "execution-1" };
const cancelInput = { ...executionInput, expectedRevision: 1, idempotencyKey: "cancel-key-1" };
const publicExecution = {
  id: "execution-1",
  revision: 1,
  sessionId: "session-1",
  operation: "turn.run" as const,
  state: "completed" as const,
  result: { assistantText: "done" },
  errorCode: "",
  reason: "",
  createdAt: "2026-08-11T00:00:00.000Z",
  admittedAt: "2026-08-11T00:00:00.000Z",
  completedAt: "2026-08-11T00:00:01.000Z",
  updatedAt: "2026-08-11T00:00:01.000Z",
  effectiveTurn: {
    provider: "codex" as const,
    model: "gpt-5.4",
    reasoningEffort: "high" as const,
    approvalMode: "on-request" as const,
    sandboxMode: "workspace-write" as const,
    customAgentName: null,
  },
  attachments: [],
  pendingInteraction: null,
  partialOutput: null,
  terminalFailureNotification: null,
  workItemId: null,
};
const publicSession = {
  revision: 1,
  sessionId: "s1",
  sessionRole: "executor" as const,
  roleContractRevision: 1 as const,
  rootSessionId: "root-1",
  parentSessionId: "parent-1",
  delegationDepth: 2,
  title: "Demo",
  sessionKind: "default" as const,
  provider: { id: "codex", catalogRevision: 1 },
  character: { id: "character-1", name: "Character" },
  workspace: { kind: "session_folder" as const, label: "SessionFolder", path: "C:/session" },
  updatedAt: "2026-08-11T00:00:00.000Z",
  sessionFolder: { path: "C:/session", isWorkspace: true },
};
const { sessionFolder: _sessionFolder, ...publicSessionSummary } = publicSession;
const publicFile = {
  sessionId: "session-1",
  relativePath: "brief.md",
  byteLength: 5,
  modifiedAt: "2026-08-11T00:00:00.000Z",
};
const publicCoordinationEvent = {
  sequence: 1,
  eventId: "event-1",
  revision: 0,
  actorSessionId: "session-1",
  sessionRole: "executor" as const,
  roleContractRevision: 1 as const,
  rootSessionId: "root-1",
  parentSessionId: "task-1",
  delegationDepth: 2,
  kind: "progress" as const,
  decisionClass: "deny_or_cancel" as const,
  state: "recorded" as const,
  summary: "started",
  payload: { summary: "started" },
  executionId: null,
  targetSessionId: null,
  correctedEventId: null,
  options: [],
  actions: [],
  createdAt: "2026-08-21T00:00:00.000Z",
};
const publicResolvedCoordinationEvent = {
  ...publicCoordinationEvent,
  revision: 1,
  kind: "blocker" as const,
  decisionClass: "agent_delegable" as const,
  state: "resolved" as const,
  actions: [{
    sequence: 1,
    type: "resolved" as const,
    actorType: "session" as const,
    principalKind: "agent" as const,
    actorSessionId: "session-1",
    optionId: null,
    note: null,
    relatedEventId: null,
    createdAt: "2026-08-21T00:01:00.000Z",
  }],
};
const publicWorkItem = {
  id: "work-1",
  sequence: 1,
  kind: "delegated" as const,
  contractRevision: 2 as const,
  rootSessionId: "root-1",
  creatorSessionId: "session-1",
  targetSessionId: "session-2",
  parentWorkItemId: null,
  goal: "goal",
  scope: "scope",
  completionCriteria: "done",
  authority: "local",
  sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
  state: "pending" as const,
  revision: 1,
  result: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

async function withClient<T>(
  server: ReturnType<typeof createWithMateSessionMcpServer>,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "withmate-session-mcp-test", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function parseToolError(result: { content: unknown[] }): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("WithMate Session MCP contract", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "unbound MCPは複数active Session runtimeを暗黙選択せずRUNTIME_AMBIGUOUS tool errorへ投影する"
  // oracle = { type = "adr", ref = "ADR-023 Selection and binding" }
  // failure_mode = "MCPだけが複数runtimeの一つへ暗黙接続するか、ambiguityをgeneric unavailableへ潰す"
  // scope = "withmate-session-mcp-discovery-error-projection"
  // lifecycle = "permanent"
  // @end-test-value
  it("unbound MCPはambiguous discoveryを明示errorへ投影する", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => { throw new SessionRuntimeDiscoveryError("runtime_ambiguous"); },
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      assert.equal(parseToolError(result as any).error.code, "RUNTIME_AMBIGUOUS");
    });
  });
  // @test-value v2
  // kind = "contract"
  // claim = "MCPはbudget三操作を含む全49 toolをdotted name、generic strict envelope schema、read/write annotation付きで公開する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/09-public-api-migration-and-review.md#public-surface-parity" }
  // fault = "HTTPまたはCLIにあるoperationがMCP tool一覧から欠落するか、generic envelope required fieldまたはreadOnly/destructive分類が分岐する"
  // observable = "MCP tools/listの49 tool名、generic input/output schema strictness、effect annotation"
  // observation_boundary = "public-boundary"
  // scope = "WithMate Session MCP tool catalog"
  // lifecycle = "permanent"
  // distinction = "operation固有payloadのruntime validationではなく、全49件の独立した期待表でtool集合、generic envelope schema、readOnly/destructive annotationを横断検証する"
  // @end-test-value
  it("全49 toolsをdotted name、strict schema、read/write annotation付きで公開する", async () => {
    const expectedEffectAnnotations: Record<string, { readOnlyHint: boolean; destructiveHint: boolean }> = {
      "runtime.catalog": { readOnlyHint: true, destructiveHint: false },
      "budget.get": { readOnlyHint: true, destructiveHint: false },
      "budget.list": { readOnlyHint: true, destructiveHint: false },
      "budget.configure": { readOnlyHint: false, destructiveHint: false },
      "session.self": { readOnlyHint: true, destructiveHint: false },
      "session.create": { readOnlyHint: false, destructiveHint: false },
      "session.list": { readOnlyHint: true, destructiveHint: false },
      "session.get": { readOnlyHint: true, destructiveHint: false },
      "session.rename": { readOnlyHint: false, destructiveHint: false },
      "session.configure": { readOnlyHint: false, destructiveHint: false },
      "session.move.manifest": { readOnlyHint: true, destructiveHint: false },
      "session.move": { readOnlyHint: false, destructiveHint: false },
      "session.clone": { readOnlyHint: false, destructiveHint: false },
      "session.restore": { readOnlyHint: false, destructiveHint: false },
      "session.archive": { readOnlyHint: false, destructiveHint: false },
      "session.delete.manifest": { readOnlyHint: true, destructiveHint: false },
      "session.delete": { readOnlyHint: false, destructiveHint: true },
      "session.files.list": { readOnlyHint: true, destructiveHint: false },
      "session.files.read_text": { readOnlyHint: true, destructiveHint: false },
      "session.files.write_text": { readOnlyHint: false, destructiveHint: true },
      "work.create": { readOnlyHint: false, destructiveHint: false },
      "work.list": { readOnlyHint: true, destructiveHint: false },
      "work.get": { readOnlyHint: true, destructiveHint: false },
      "work.revise": { readOnlyHint: false, destructiveHint: false },
      "work.history.append": { readOnlyHint: false, destructiveHint: false },
      "work.history.list": { readOnlyHint: true, destructiveHint: false },
      "work.transition": { readOnlyHint: false, destructiveHint: false },
      "work.result": { readOnlyHint: false, destructiveHint: false },
      "work.cancel": { readOnlyHint: false, destructiveHint: true },
      "work.aggregation.get": { readOnlyHint: true, destructiveHint: false },
      "work.aggregation.list": { readOnlyHint: true, destructiveHint: false },
      "work.aggregation.decide": { readOnlyHint: false, destructiveHint: false },
      "work.aggregation.retry": { readOnlyHint: false, destructiveHint: false },
      "turn.options": { readOnlyHint: true, destructiveHint: false },
      "turn.run": { readOnlyHint: false, destructiveHint: true },
      "turn.enqueue": { readOnlyHint: false, destructiveHint: true },
      "turn.list": { readOnlyHint: true, destructiveHint: false },
      "turn.get": { readOnlyHint: true, destructiveHint: false },
      "turn.cancel": { readOnlyHint: false, destructiveHint: true },
      "interaction.list": { readOnlyHint: true, destructiveHint: false },
      "interaction.respond": { readOnlyHint: false, destructiveHint: true },
      "coordination.event.create": { readOnlyHint: false, destructiveHint: false },
      "coordination.event.list": { readOnlyHint: true, destructiveHint: false },
      "coordination.event.get": { readOnlyHint: true, destructiveHint: false },
      "coordination.event.resolve": { readOnlyHint: false, destructiveHint: false },
      "coordination.event.consume": { readOnlyHint: false, destructiveHint: false },
      "coordination.event.cancel": { readOnlyHint: false, destructiveHint: true },
      "coordination.event.correct": { readOnlyHint: false, destructiveHint: true },
      "transcript.export": { readOnlyHint: false, destructiveHint: true },
    };
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /scope or policy decision/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /Use user_decision_required/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /free-text response to your blocker/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /does not resolve the blocker/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /Never record secrets/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /must not stop the normal response/);
    await withClient(createWithMateSessionMcpServer(), async (client) => {
      const result = await client.listTools();
      assert.deepEqual(result.tools.map((tool) => tool.name), SESSION_MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
      assert.deepEqual(Object.keys(expectedEffectAnnotations), result.tools.map((tool) => tool.name));
      for (const tool of result.tools) {
        const expectedEffect = expectedEffectAnnotations[tool.name];
        assert.ok(expectedEffect, `Missing effect annotation expectation for ${tool.name}.`);
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.equal(tool.outputSchema?.type, "object");
        assert.equal(tool.outputSchema?.additionalProperties, false);
        assert.ok(tool.outputSchema?.required?.includes("operation"));
        assert.ok(tool.outputSchema?.required?.includes("result"));
        assert.ok(tool.description?.trim());
        assert.equal(
          tool.annotations?.openWorldHint,
          tool.name === "turn.run" || tool.name === "turn.enqueue" || tool.name === "interaction.respond" || tool.name === "transcript.export",
        );
        assert.equal(tool.annotations?.idempotentHint, true);
        assert.equal(tool.annotations?.readOnlyHint, expectedEffect.readOnlyHint, `${tool.name} readOnlyHint`);
        assert.equal(tool.annotations?.destructiveHint, expectedEffect.destructiveHint, `${tool.name} destructiveHint`);
      }
      assert.match(result.tools.find((tool) => tool.name === "coordination.event.create")?.description ?? "", /stable eventId/);
      assert.match(result.tools.find((tool) => tool.name === "coordination.event.list")?.description ?? "", /stable eventId/);
      assert.match(result.tools.find((tool) => tool.name === "coordination.event.get")?.description ?? "", /create idempotencyKey/);
      const consumeDescription = result.tools.find((tool) => tool.name === "coordination.event.consume")?.description ?? "";
      assert.match(consumeDescription, /blocker response/);
      assert.match(consumeDescription, /does not resolve the blocker/);
      assert.doesNotMatch(consumeDescription, /blocker resolution response/);
      const runOutput = result.tools.find((tool) => tool.name === "turn.run")?.outputSchema as any;
      const enqueueOutput = result.tools.find((tool) => tool.name === "turn.enqueue")?.outputSchema as any;
      assert.equal(runOutput.properties.operation.const, "turn.run");
      assert.equal(enqueueOutput.properties.operation.const, "turn.enqueue");
      assert.equal(runOutput.properties.result.properties.operation.const, "turn.run");
      assert.equal(enqueueOutput.properties.result.properties.operation.const, "turn.enqueue");
    });
  });

  it("SF-ADAPTER-04: Session file toolsをstrict schemaと既定limitでdispatchする", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        const result = envelope.operation === "session.files.list"
          ? { items: [publicFile] }
          : envelope.operation === "session.files.read_text"
            ? { file: publicFile, content: "hello" }
            : { file: publicFile };
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult(envelope.operation, result as never),
        } as any;
      },
    }), async (client) => {
      assert.equal((await client.callTool({
        name: "session.files.list",
        arguments: { sessionId: "session-1" },
      })).isError, undefined);
      assert.equal((await client.callTool({
        name: "session.files.read_text",
        arguments: { sessionId: "session-1", relativePath: "brief.md" },
      })).isError, undefined);
      assert.equal((await client.callTool({
        name: "session.files.write_text",
        arguments: {
          sessionId: "session-1",
          relativePath: "brief.md",
          content: "hello",
          idempotencyKey: "write-1",
        },
      })).isError, undefined);
    });

    assert.deepEqual(requests.map((request) => request.operation), [
      "session.files.list",
      "session.files.read_text",
      "session.files.write_text",
    ]);
    assert.deepEqual(requests[0].input, { sessionId: "session-1", limit: 50 });
    assert.deepEqual(requests[2].input, {
      sessionId: "session-1",
      relativePath: "brief.md",
      content: "hello",
      maxBytes: 1024 * 1024,
      replace: false,
      idempotencyKey: "write-1",
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP work.createはtarget Sessionのcurrent revisionをexpectedContainerRevisionとしてshared operationへ渡す"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "MCPだけcontainer revisionを欠落させ、stale target SessionへWork Itemを作成する"
  // scope = "withmate-session-mcp work.create input"
  // lifecycle = "permanent"
  // @end-test-value
  it("WORK-ADAPTER-01: Work Item mutationをstrict schemaでshared operationへdispatchする", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        const result = envelope.operation === "work.result"
          ? {
            ...publicWorkItem,
            state: "completed" as const,
            revision: 3,
            result: {
              outcome: "completed" as const,
              summary: "done",
              changes: [],
              verificationResults: [],
              findings: [],
              unverifiedItems: [],
              remainingWork: [],
              reportingSessionId: "session-2",
              reportedAt: "2026-08-24T00:01:00.000Z",
            },
          }
          : publicWorkItem;
        return { ok: true, status: 200, value: createSessionRuntimeResult(envelope.operation, result as never) };
      },
    }), async (client) => {
      const created = await client.callTool({
        name: "work.create",
        arguments: {
          expectedContainerRevision: 1,
          targetSessionId: "session-2",
          goal: "goal",
          scope: "scope",
          completionCriteria: "done",
          authority: "local",
          sourceIdentity: { workspace: null, repository: null, branch: null, base: null, head: null },
          idempotencyKey: "work-create",
        },
      });
      assert.equal(created.isError, undefined);
      const result = await client.callTool({
        name: "work.result",
        arguments: {
          workItemId: "work-1",
          state: "completed",
          expectedRevision: 2,
          result: {
            summary: "done",
            changes: [],
            verificationResults: [],
            findings: [],
            unverifiedItems: [],
            remainingWork: [],
          },
          idempotencyKey: "work-result",
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests.map((request) => request.operation), ["work.create", "work.result"]);
      assert.equal(requests[0].input.expectedContainerRevision, 1);
    });
  });

  // @test-value v1
  // kind = "regression"
  // claim = "MCPのwork.resultとwork.cancelはoperation固有のterminal shapeに加えて、delegatedの非自己対象とroot専用progress fieldというkind不変条件を検証する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#WorkItem の種別" }
  // failure_mode = "resultまたはcancelだけ未refine schemaを通り、自己対象delegatedやprogress付きdelegatedがMCPの公開出力として受理される"
  // scope = "withmate-session-mcp Work Item result schemas"
  // lifecycle = "permanent"
  // distinction = "一般workItemSchemaを使う操作ではなく、operation固有schemaを直接参照するresultとcancelの両方を反証する"
  // @end-test-value
  it("WORK-ADAPTER-02: resultとcancelの不正なkind tupleをMCP出力境界で拒否する", async () => {
    const terminalResult = {
      outcome: "completed" as const,
      summary: "done",
      changes: [],
      verificationResults: [],
      findings: [],
      unverifiedItems: [],
      remainingWork: [],
      reportingSessionId: "session-2",
      reportedAt: "2026-08-24T00:01:00.000Z",
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        const result = envelope.operation === "work.result"
          ? {
              ...publicWorkItem,
              state: "completed" as const,
              revision: 2,
              result: terminalResult,
              progressSummary: "must not exist",
              blockers: [],
              nextAction: "must not exist",
            }
          : {
              ...publicWorkItem,
              creatorSessionId: "session-2",
              targetSessionId: "session-2",
              state: "canceled" as const,
              revision: 2,
              result: null,
            };
        return { ok: true, status: 200, value: createSessionRuntimeResult(envelope.operation, result as never) };
      },
    }), async (client) => {
      const invalidResult = await client.callTool({
        name: "work.result",
        arguments: {
          workItemId: "work-1",
          state: "completed",
          expectedRevision: 1,
          result: { summary: "done", changes: [], verificationResults: [], findings: [], unverifiedItems: [], remainingWork: [] },
          idempotencyKey: "bad-result-kind",
        },
      });
      const invalidCancel = await client.callTool({
        name: "work.cancel",
        arguments: { workItemId: "work-1", expectedRevision: 1, idempotencyKey: "bad-cancel-kind" },
      });
      assert.equal(invalidResult.isError, true);
      assert.equal(invalidCancel.isError, true);
    });
  });

  it("AGG-ADAPTER-01: Work Item aggregation getをshared operationへdispatchする", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return { ok: true, status: 200, value: createSessionRuntimeResult("work.aggregation.get", {
          contractRevision: 1, parentWorkItemId: "work-parent", aggregateRevision: 2,
          directChildCount: 1, activeCount: 0, undecidedTerminalCount: 0,
          acceptedCount: 1, excludedCount: 0, retryRequestedCount: 0,
        }) };
      },
    }), async (client) => {
      const result = await client.callTool({ name: "work.aggregation.get", arguments: { parentWorkItemId: "work-parent" } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests.map((request) => request.operation), ["work.aggregation.get"]);
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP coordination createはexpected container revisionとstrict result provenanceを保持する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "MCPだけrevisionを欠落させるかcoordination summaryのdecision classを拒否する"
  // scope = "withmate-session-mcp-coordination-create"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-ADAPTER-01: Coordination toolを同じstrict operationへdispatchする", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult(envelope.operation, publicCoordinationEvent as never),
        };
      },
    }), async (client) => {
      const result = await client.callTool({
        name: "coordination.event.create",
        arguments: { expectedContainerRevision: 1, kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" },
      });
      assert.equal(result.isError, undefined);
    });
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "coordination.event.create",
      input: { expectedContainerRevision: 1, kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" },
    }]);
  });

  // @test-value v1
  // kind = "security"
  // claim = "MCP coordination resolveはcurrent revisionを要求しtrusted option回答をAgent surfaceから拒否する"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01/AUTONOMY-MUTATION-05" }
  // failure_mode = "stale event解決またはtrusted GUI optionのAgent偽装を受理する"
  // scope = "withmate-session-mcp-coordination-resolve"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-RESOLVE-SURFACE-01: agentは回答optionなしでblockerを解決できる", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult(envelope.operation, publicResolvedCoordinationEvent as never),
        };
      },
    }), async (client) => {
      const result = await client.callTool({
        name: "coordination.event.resolve",
        arguments: { eventId: "blocker-1", expectedRevision: 0, idempotencyKey: "resolve-blocker-1" },
      });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).result.revision, 1);
      assert.equal((result.structuredContent as any).result.decisionClass, "agent_delegable");
      assert.equal((result.structuredContent as any).result.actions[0].principalKind, "agent");
      const invalid = await client.callTool({
        name: "coordination.event.resolve",
        arguments: { eventId: "decision-1", expectedRevision: 0, optionId: "continue", idempotencyKey: "resolve-decision-1" },
      });
      assert.equal(invalid.isError, true);
      const consumed = await client.callTool({
        name: "coordination.event.consume",
        arguments: {
          eventId: "decision-1", expectedResolutionSequence: 3, idempotencyKey: "consume-decision-1",
        },
      });
      assert.equal(consumed.isError, undefined);
    });
    assert.deepEqual(requests, [
      {
        schemaVersion: "withmate-session-request-v2",
        operation: "coordination.event.resolve",
        input: { eventId: "blocker-1", expectedRevision: 0, idempotencyKey: "resolve-blocker-1" },
      },
      {
        schemaVersion: "withmate-session-request-v2",
        operation: "coordination.event.consume",
        input: { eventId: "decision-1", expectedResolutionSequence: 3, idempotencyKey: "consume-decision-1" },
      },
    ]);
  });

  it("EXT-TRANSCRIPT-13: inline transcript exportの8 MiB超過はpre-dispatchで拒否する", async () => {
    let calls = 0;
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => { calls += 1; return connection; },
    }), async (client) => {
      const result = await client.callTool({ name: "transcript.export", arguments: {
        sessionId: "session-1", format: "json", maxBytes: 8 * 1024 * 1024 + 1,
        destination: { kind: "inline" },
      } });
      assert.equal(result.isError, true);
      assert.equal(calls, 0);
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "MCP Session createはexpected container revisionとcaller-owned keyを必須にする"
  // fault = "MCP createがcontainer revisionまたはidempotency keyなしでdispatchされる"
  // observable = "MCP call result and dispatched operation input"
  // observation_boundary = "public-boundary"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // scope = "withmate-session-mcp-session-create"
  // lifecycle = "permanent"
  // @end-test-value
  it("session.createはcaller-owned keyを必須にし、session.list/getはread-onlyでdispatchする", async () => {
    const requests: any[] = [];
    const validInput = {
      expectedContainerRevision: 1,
      placement: { kind: "child", parentSessionId: "actor-session", sessionRole: "executor" },
      title: "Demo",
      character: { characterId: "character-1", expectedDefinitionSha256: "definition-sha256" },
      provider: { id: "codex", catalogRevision: 1, model: "model-1", reasoningEffort: "medium", threadContinuity: "reset", approvalMode: "on-request", codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] },
      workspace: { kind: "session_folder" },
      initialGrant: { kind: "inherit" },
      budget: { kind: "inherit" },
      idempotencyKey: "create-key-1",
    } as const;
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        const result = envelope.operation === "session.list"
          ? { items: [publicSessionSummary] }
          : envelope.operation === "session.get"
            ? { ...publicSession, workspace: { ...publicSession.workspace, branch: null } }
            : publicSession;
        return { ok: true, status: 200, value: createSessionRuntimeResult(envelope.operation, result as never) } as any;
      },
    }), async (client) => {
      const { idempotencyKey: _key, ...missingKeyInput } = validInput;
      const created = await client.callTool({ name: "session.create", arguments: missingKeyInput });
      assert.equal(created.isError, true);
      const { expectedContainerRevision: _revision, ...missingRevisionInput } = validInput;
      const missingRevision = await client.callTool({ name: "session.create", arguments: missingRevisionInput });
      assert.equal(missingRevision.isError, true);
      const createdWithKey = await client.callTool({ name: "session.create", arguments: validInput });
      assert.equal(createdWithKey.isError, undefined);
      const listed = await client.callTool({ name: "session.list", arguments: {} });
      assert.equal(listed.isError, undefined);
      const fetched = await client.callTool({ name: "session.get", arguments: { sessionId: "s1" } });
      assert.equal(fetched.isError, undefined);
    });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0], { schemaVersion: "withmate-session-request-v2", operation: "session.create", input: validInput });
    assert.deepEqual(requests.slice(1).map((request) => request.operation), ["session.list", "session.get"]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "MCP runtime.catalogはauthority mapping、resource budget契約、baseline Role templateを区別してstrict outputで返す"
  // oracle = { type = "contract", ref = "AUTONOMY-GRANT-02/AUTONOMY-PARITY-08 and designs/08-resource-budget.md" }
  // fault = "MCP catalogがresource budget契約を欠落させるかbaseline templateをlive grantとして公開する"
  // observable = "MCP structuredContentのruntime.catalog resultとdispatch request envelope"
  // observation_boundary = "public-boundary"
  // scope = "WithMate Session MCP runtime.catalog"
  // lifecycle = "permanent"
  // distinction = "空input dispatch、operation classification、budget projection、baseline template名を同じtool callで検証する"
  // @end-test-value
  it("RUNTIME-CATALOG-02: runtime.catalogを空inputのread-only operationとしてdispatchする", async () => {
    const requests: unknown[] = [];
    const budgetCatalog = {
      contractRevision: 1 as const,
      operations: ["get", "list", "configure"] as const,
      dimensions: ["concurrentTurns", "queuedTurns", "totalTurns", "retries", "sessions", "workItems", "delegations", "storageBytes"] as const,
      defaultHardLimits: {
        concurrentTurns: 4,
        queuedTurns: 100,
        totalTurns: 1000,
        retries: 100,
        sessions: 100,
        workItems: 500,
        delegations: 500,
        storageBytes: 1073741824,
      },
      retryPerExecutionLimit: 3,
      defaultDurationMs: 2592000000,
      defaultListLimit: 50,
      maxListLimit: 500,
      meteredUsage: ["tokens", "monetary_cost", "provider_usage"] as const,
      constraints: [],
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("runtime.catalog", {
            revision: 7,
            sessionRoleContractRevision: 1,
            sessionTurnCommunicationContractRevision: 1,
            supportedSessionRoles: ["standalone", "overall-coordinator", "task-coordinator", "executor"],
            authority: {
              mappingRevision: 1,
              operations: [{
                action: "session.create",
                resourceKind: "session_namespace",
                scopeSource: "actor",
                effectClass: "local_mutation",
                decisionClass: "agent_delegable",
              }],
              budget: budgetCatalog,
              validationGaps: [],
            },
            baselineChildSessionRoleTemplates: {
              standalone: [],
              "overall-coordinator": ["task-coordinator", "executor"],
              "task-coordinator": ["executor"],
              executor: [],
            },
            maxDelegationDepth: 2,
            coordinationEvents: {
              kinds: ["progress", "decision", "escalation", "user_decision_required", "blocker", "result", "correction"],
              states: ["recorded", "open", "resolved", "superseded", "cancelled"],
              scopes: ["self", "subtree"],
              defaultListLimit: 50,
              maxListLimit: 100,
            },
            workItems: {
              contractRevision: 2,
              states: ["pending", "in_progress", "waiting", "completed", "partially_completed", "failed", "canceled"],
              mutations: ["create", "revise", "transition", "result", "cancel", "history.append"],
              history: {
                events: ["created", "migration_baseline", "contract_revised", "progress", "handoff", "state_transitioned", "result_reported"],
                operations: ["append", "list"],
                defaultListLimit: 50,
                maxListLimit: 200,
              },
              defaultListLimit: 50,
              maxListLimit: 200,
              maxListResponseBytes: 8388608,
              maxEventPayloadBytes: 524288,
              maxMigrationBaselinePayloadBytes: 2097152,
              maxResultBytes: 262144,
              aggregation: {
                contractRevision: 1,
                decisions: ["accepted", "excluded", "retry_requested"],
                operations: ["get", "list", "decide", "retry"],
                defaultListLimit: 50,
                maxListLimit: 200,
              },
            },
            providers: [],
          }),
        };
      },
    }), async (client) => {
      const result = await client.callTool({ name: "runtime.catalog", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests, [{
        schemaVersion: "withmate-session-request-v2",
        operation: "runtime.catalog",
        input: {},
      }]);
      assert.deepEqual((result.structuredContent as any).result, {
        revision: 7,
        sessionRoleContractRevision: 1,
        sessionTurnCommunicationContractRevision: 1,
        supportedSessionRoles: ["standalone", "overall-coordinator", "task-coordinator", "executor"],
        authority: {
          mappingRevision: 1,
          operations: [{
            action: "session.create",
            resourceKind: "session_namespace",
            scopeSource: "actor",
            effectClass: "local_mutation",
            decisionClass: "agent_delegable",
          }],
          budget: budgetCatalog,
          validationGaps: [],
        },
        baselineChildSessionRoleTemplates: {
          standalone: [],
          "overall-coordinator": ["task-coordinator", "executor"],
          "task-coordinator": ["executor"],
          executor: [],
        },
        maxDelegationDepth: 2,
        coordinationEvents: {
          kinds: ["progress", "decision", "escalation", "user_decision_required", "blocker", "result", "correction"],
          states: ["recorded", "open", "resolved", "superseded", "cancelled"],
          scopes: ["self", "subtree"],
          defaultListLimit: 50,
          maxListLimit: 100,
        },
        workItems: {
          contractRevision: 2,
          states: ["pending", "in_progress", "waiting", "completed", "partially_completed", "failed", "canceled"],
          mutations: ["create", "revise", "transition", "result", "cancel", "history.append"],
          history: {
            events: ["created", "migration_baseline", "contract_revised", "progress", "handoff", "state_transitioned", "result_reported"],
            operations: ["append", "list"],
            defaultListLimit: 50,
            maxListLimit: 200,
          },
          defaultListLimit: 50,
          maxListLimit: 200,
          maxListResponseBytes: 8388608,
          maxEventPayloadBytes: 524288,
          maxMigrationBaselinePayloadBytes: 2097152,
          maxResultBytes: 262144,
          aggregation: {
            contractRevision: 1,
            decisions: ["accepted", "excluded", "retry_requested"],
            operations: ["get", "list", "decide", "retry"],
            defaultListLimit: 50,
            maxListLimit: 200,
          },
        },
        providers: [],
      });
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP session.selfはactor container revisionをpublic resultに保持する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "Agentが次のcreateに必要なexpectedContainerRevisionをMCPから取得できない"
  // scope = "withmate-session-mcp-session-self"
  // lifecycle = "permanent"
  // @end-test-value
  it("SESSION-SELF-02: session.selfを空inputのread-only operationとしてdispatchする", async () => {
    const requests: unknown[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("session.self", {
            revision: 1,
            sessionId: "session-actor",
            sessionRole: "overall-coordinator",
            roleContractRevision: 1,
            rootSessionId: "session-actor",
            parentSessionId: null,
            delegationDepth: 0,
          }),
        };
      },
    }), async (client) => {
      const result = await client.callTool({ name: "session.self", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests, [{
        schemaVersion: "withmate-session-request-v2",
        operation: "session.self",
        input: {},
      }]);
      assert.deepEqual((result.structuredContent as any).result, {
        revision: 1,
        sessionId: "session-actor",
        sessionRole: "overall-coordinator",
        roleContractRevision: 1,
        rootSessionId: "session-actor",
        parentSessionId: null,
        delegationDepth: 0,
      });
    });
  });

  it("TURN-OPTIONS: turn.optionsをstrict read-only operationとしてdispatchする", async () => {
    const requests: unknown[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("turn.options", {
            sessionId: "session-1",
            provider: { id: "codex" },
            catalogRevision: 9,
            models: [],
            approvalModes: [],
            codexSandboxModes: [],
          }),
        };
      },
    }), async (client) => {
      const result = await client.callTool({
        name: "turn.options",
        arguments: { sessionId: "session-1" },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(requests, [{
        schemaVersion: "withmate-session-request-v2",
        operation: "turn.options",
        input: { sessionId: "session-1" },
      }]);
      assert.equal((result.structuredContent as any).operation, "turn.options");
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP turn.run/enqueueはtarget SessionのexpectedContainerRevisionとprovider固有tupleをshared operationへ渡す"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "MCP Turn経路だけcontainer revisionを欠落させるかprovider固有fieldを混在させる"
  // scope = "withmate-session-mcp Turn creation input"
  // lifecycle = "permanent"
  // @end-test-value
  it("EXT-PROVIDER-02: Copilot Turnをprovider固有schemaでrun/enqueueへdispatchする", async () => {
    const requests: any[] = [];
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult(envelope.operation, {
            ...publicExecution,
            operation: envelope.operation,
          } as never),
        };
      },
    }), async (client) => {
      const turn = {
        provider: "copilot",
        userMessage: "hello",
        model: "claude-sonnet",
        reasoningEffort: "high",
        approvalMode: "on-request",
        customAgentName: "reviewer",
        attachments: [],
      };
      assert.equal((await client.callTool({
        name: "turn.run",
        arguments: {
          expectedContainerRevision: 1,
          sessionId: "session-1",
          catalogRevision: 5,
          idempotencyKey: "run-1",
          responseMode: "deferred",
          terminalFailureNotification: { targetSessionId: "target-session" },
          turn,
        },
      })).isError, undefined);
      assert.equal((await client.callTool({
        name: "turn.enqueue",
        arguments: {
          expectedContainerRevision: 2,
          sessionId: "session-1",
          catalogRevision: 5,
          idempotencyKey: "enqueue-1",
          terminalFailureNotification: { targetSessionId: "target-session" },
          turn,
        },
      })).isError, undefined);
      const invalid = await client.callTool({
        name: "turn.enqueue",
        arguments: {
          expectedContainerRevision: 3,
          sessionId: "session-1",
          catalogRevision: 5,
          idempotencyKey: "enqueue-2",
          turn: { ...turn, codexSandboxMode: "workspace-write" },
        },
      });
      assert.equal(invalid.isError, true);
      const invalidNotification = await client.callTool({
        name: "turn.enqueue",
        arguments: {
          expectedContainerRevision: 3,
          sessionId: "session-1",
          catalogRevision: 5,
          idempotencyKey: "enqueue-3",
          terminalFailureNotification: { targetSessionId: "target-session", characterId: "spoof" },
          turn,
        },
      });
      assert.equal(invalidNotification.isError, true);
    });
    assert.deepEqual(requests.map((request) => request.operation), ["turn.run", "turn.enqueue"]);
    assert.deepEqual(requests.map((request) => request.input.expectedContainerRevision), [1, 2]);
    assert.deepEqual(requests.map((request) => request.input.terminalFailureNotification), [
      { targetSessionId: "target-session" },
      { targetSessionId: "target-session" },
    ]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP turn.runはrevision付きpublic executionを受理し、異なるoperationのexecutionを拒否する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05/AUTONOMY-PARITY-08" }
  // failure_mode = "execution revisionが公開面から落ちるか、enqueue結果をrun結果として受理する"
  // scope = "withmate-session-mcp public execution result"
  // lifecycle = "permanent"
  // @end-test-value
  it("EXT-RESULT-03: turn.runはenqueue executionをoperation別result schemaで拒否する", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult("turn.run", {
          ...publicExecution,
          operation: "turn.enqueue",
        } as never),
      }),
    }), async (client) => {
      const result = await client.callTool({
        name: "turn.run",
        arguments: {
          expectedContainerRevision: 1,
          sessionId: "session-1",
          catalogRevision: 5,
          idempotencyKey: "run-operation-mismatch",
          responseMode: "deferred",
          turn: {
            provider: "codex",
            userMessage: "hello",
            model: "gpt-5.4",
            reasoningEffort: "high",
            approvalMode: "on-request",
            codexSandboxMode: "workspace-write",
            attachments: [],
          },
        },
      });
      assert.equal(result.isError, true);
      assert.equal(parseToolError(result as any).error.code, "RUNTIME_UNAVAILABLE");
    });
  });

  it("EXT-RESULT-03: provider設定とinteraction種別の不正なpublic tupleを拒否する", async () => {
    const invalidExecution = {
      ...publicExecution,
      effectiveTurn: {
        ...publicExecution.effectiveTurn,
        provider: "copilot",
      },
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult("turn.get", invalidExecution),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      assert.equal(parseToolError(result as any).error.code, "RUNTIME_UNAVAILABLE");
    });

    const invalidInteraction = {
      sequence: 1,
      interactionId: "interaction-1",
      sessionId: "session-1",
      executionId: "execution-1",
      kind: "approval",
      state: "pending",
      request: { mode: "form", message: "wrong request kind", fields: [] },
      resolution: null,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult("interaction.list", { items: [invalidInteraction] }),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "interaction.list", arguments: { sessionId: "session-1" } });
      assert.equal(result.isError, true);
      assert.equal(parseToolError(result as any).error.code, "RUNTIME_UNAVAILABLE");
    });
  });

  it("MCP専用adapterでdiscoveryし、public resultをstructuredContentへ返す", async () => {
    let adapter = "";
    await withClient(createWithMateSessionMcpServer({
      discover: async (options) => {
        adapter = options.adapter ?? "";
        return connection;
      },
      call: async (_connection, envelope) => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult(envelope.operation, publicExecution as never),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(adapter, "mcp");
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION,
        operation: "turn.get",
        result: publicExecution,
      });
    });
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP inputのidentifier違反とunknown fieldはruntime dispatch前に共通のversioned INVALID_INPUT errorへ収束する"
  // oracle = { type = "contract", ref = "AUTONOMY-PARITY-08" }
  // failure_mode = "MCP frameworkの事前validationがoperation handlerを迂回し、code・effect・retryableのないprotocol errorを返す"
  // scope = "withmate-session-mcp input validation error envelope"
  // lifecycle = "permanent"
  // distinction = "application errorやruntime transport errorではなく、MCP tool argumentのstrict validation失敗をruntime未呼出しで観測する"
  // @end-test-value
  it("AUTONOMY-PARITY-08: 不正なMCP inputをversioned INVALID_INPUTへ写像してruntimeを呼ばない", async () => {
    let runtimeCalls = 0;
    await withClient(createWithMateSessionMcpServer({
      discover: async () => {
        runtimeCalls += 1;
        return connection;
      },
    }), async (client) => {
      const blankIdentifier = await client.callTool({
        name: "turn.get",
        arguments: { sessionId: "   ", executionId: "execution-1" },
      });
      const unknownField = await client.callTool({
        name: "turn.get",
        arguments: { sessionId: "session-1", executionId: "execution-1", privateMarker: "must-not-pass" },
      });
      for (const result of [blankIdentifier, unknownField]) {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        const error = parseToolError(result as any).error;
        assert.equal(error.code, "INVALID_INPUT");
        assert.equal(error.effect, "not_applied");
        assert.equal(error.retryable, false);
      }
      assert.equal(runtimeCalls, 0);
    });
  });

  it("application errorをversioned structured tool errorへ写像する", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: false,
        status: 409,
        value: createSessionRuntimeError({ code: "SESSION_BUSY", message: "Session is busy." }),
      }),
    }), async (client) => {
      await client.listTools();
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
        schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
        error: {
          code: "SESSION_BUSY",
          message: "Session is busy.",
          retryable: false,
          effect: "not_applied",
          details: {},
        },
      });
    });
  });

  it("terminal failed executionをtool successとして返す", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => ({
        ok: true,
        status: 200,
        value: createSessionRuntimeResult("turn.get", {
          ...publicExecution,
          state: "failed",
          result: null,
          errorCode: "PROVIDER_FAILURE",
        }),
      }),
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent as any).result.state, "failed");
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "MCPのrenameとcancelはdispatch後の応答喪失を適用不明として報告する"
  // oracle = { type = "contract", ref = "docs/runbooks/session-cli.md#Exit codes" }
  // fault = "変更済みかもしれないrenameを未適用と誤報する"
  // observable = "MCP tool errorのeffectと秘匿済みmessage"
  // observation_boundary = "public-boundary"
  // scope = "MCP transport effect mapping"
  // lifecycle = "permanent"
  // @end-test-value
  it("pre-dispatch failureはnot_applied、mutationのpost-dispatch failureはindeterminateにする", async () => {
    for (const [dispatched, expectedEffect] of [[false, "not_applied"], [true, "indeterminate"]] as const) {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => connection,
        call: async () => { throw new SessionRuntimeClientError("private C:\\secret stack", dispatched); },
      }), async (client) => {
        for (const request of [
          { name: "turn.cancel", arguments: cancelInput },
          { name: "session.rename", arguments: { sessionId: "session-1", title: "Renamed", expectedRevision: 1, idempotencyKey: "rename-response-loss" } },
        ]) {
          const result = await client.callTool(request);
          assert.equal(result.isError, true);
          const error = parseToolError(result as any);
          assert.equal(error.error.effect, expectedEffect);
          assert.doesNotMatch(JSON.stringify(error), /secret|stack/i);
        }
      });
    }
  });

  it("read operationのpost-dispatch failureはnot_appliedにする", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => { throw new SessionRuntimeClientError("response lost", true); },
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(parseToolError(result as any).error.effect, "not_applied");
    });
  });

  it("EXT-TRANSCRIPT-13: MCP transport response lossはinlineをnot_applied、SessionFolderをindeterminateにする", async () => {
    const inputs = [
      {
        sessionId: "session-1",
        format: "json",
        maxBytes: 1024,
        destination: { kind: "inline" },
        expectedEffect: "not_applied",
      },
      {
        sessionId: "session-1",
        format: "json",
        maxBytes: 1024,
        destination: {
          kind: "session_folder",
          relativePath: "exports/transcript.json",
          replace: false,
          idempotencyKey: "transcript-response-loss",
        },
        expectedEffect: "indeterminate",
      },
    ] as const;
    for (const { expectedEffect, ...input } of inputs) {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => connection,
        call: async () => { throw new SessionRuntimeClientError("response lost", true); },
      }), async (client) => {
        const result = await client.callTool({ name: "transcript.export", arguments: input });
        assert.equal(parseToolError(result as any).error.effect, expectedEffect);
      });
    }
  });

  it("CLI-INPUT-LIMIT-01: shared request limit failureはCONTENT_TOO_LARGE/not_appliedを返す", async () => {
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async () => {
        throw new SessionRuntimeValidationError(
          "Session runtime request body exceeds 8 MiB.",
          { maxBytes: 8 * 1024 * 1024 },
          "CONTENT_TOO_LARGE",
        );
      },
    }), async (client) => {
      const result = await client.callTool({ name: "turn.get", arguments: executionInput });
      assert.equal(result.isError, true);
      const error = parseToolError(result as any);
      assert.equal(error.error.code, "CONTENT_TOO_LARGE");
      assert.equal(error.error.effect, "not_applied");
    });
  });

  it("identity mismatchではoperation requestをdispatchしない", async () => {
    let operationBodyBytes = 0;
    const runtime = createServer((request, response) => {
      request.on("data", (chunk) => { operationBodyBytes += Buffer.byteLength(chunk); });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtimeInstanceId: "different-runtime", challenge: {} }));
    });
    await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
    const port = (runtime.address() as AddressInfo).port;
    try {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => ({ ...connection, baseUrl: `http://127.0.0.1:${port}` }),
      }), async (client) => {
        const result = await client.callTool({ name: "turn.cancel", arguments: cancelInput });
        assert.equal(result.isError, true);
        assert.equal(parseToolError(result as any).error.effect, "not_applied");
        assert.equal(operationBodyBytes, 0);
      });
    } finally {
      await new Promise<void>((resolve) => runtime.close(() => resolve()));
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "MCP interaction listはdecision classとrevisionを公開しrespondはexpected revisionを要求する"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01" }
  // failure_mode = "Agentがdecision classを確認できないかstale responseをrevisionなしでdispatchする"
  // scope = "withmate-session-mcp-interaction"
  // lifecycle = "permanent"
  // @end-test-value
  it("EXT-INTERACTION-11: interaction.list/respondをstrict schemaとcombined resultで公開する", async () => {
    const requests: any[] = [];
    const answered = {
      sequence: 1, revision: 2, decisionClass: "user_only",
      interactionId: "interaction-1", sessionId: "session-1", executionId: "execution-1",
      kind: "approval", state: "answered",
      request: { title: "Approve", summary: "Run command" },
      resolution: { action: "approve", submittedFields: [], resolvedAt: "2026-08-13T00:00:01.000Z" },
      createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:01.000Z",
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        if (envelope.operation === "interaction.respond") {
          return {
            ok: false,
            status: 403,
            value: createSessionRuntimeError({
              code: "INTERACTION_RESPONSE_FORBIDDEN",
              message: "The interaction requires a trusted user response.",
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult("interaction.list", { items: [answered] }),
        };
      },
    }), async (client) => {
      const listed = await client.callTool({ name: "interaction.list", arguments: { sessionId: "session-1" } });
      assert.equal(listed.isError, undefined);
      assert.equal((listed.structuredContent as any).result.items[0].decisionClass, "user_only");
      assert.equal((listed.structuredContent as any).result.items[0].revision, 2);
      const responded = await client.callTool({
        name: "interaction.respond",
        arguments: {
          sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
          expectedRevision: 1,
          response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1", responseMode: "deferred",
        },
      });
      assert.equal(responded.isError, true);
      assert.deepEqual(requests.map((request) => request.operation), ["interaction.list", "interaction.respond"]);
    });
  });
});
