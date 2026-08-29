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
import { SessionRuntimeClientError, type SessionRuntimeConnection } from "../withmate-session-runtime-client.js";
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
  runtimeInstanceId: "runtime-1",
};

const executionInput = { sessionId: "session-1", executionId: "execution-1" };
const cancelInput = { ...executionInput, idempotencyKey: "cancel-key-1" };
const publicExecution = {
  id: "execution-1",
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
  actorSessionId: "session-1",
  sessionRole: "executor" as const,
  roleContractRevision: 1 as const,
  rootSessionId: "root-1",
  parentSessionId: "task-1",
  delegationDepth: 2,
  kind: "progress" as const,
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
  // claim = "MCPはRoot WorkItem三操作を含む全38 toolをdotted name、strict schema、read/write annotation付きで公開する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "HTTP/CLIにあるRoot WorkItem操作がMCP tool一覧から欠落するかstrictnessとeffect annotationが分岐する"
  // scope = "WithMate Session MCP tool catalog"
  // lifecycle = "permanent"
  // distinction = "個別tool dispatchではなくtool集合、schema strictness、annotationを横断検証する"
  // @end-test-value
  it("全38 toolsをdotted name、strict schema、read/write annotation付きで公開する", async () => {
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /scope or policy decision/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /Use user_decision_required/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /free-text response to your blocker/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /does not resolve the blocker/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /Never record secrets/);
    assert.match(SESSION_MCP_SERVER_INSTRUCTIONS, /must not stop the normal response/);
    await withClient(createWithMateSessionMcpServer(), async (client) => {
      const result = await client.listTools();
      assert.deepEqual(result.tools.map((tool) => tool.name), SESSION_MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
      for (const tool of result.tools) {
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
      }
      assert.equal(result.tools.find((tool) => tool.name === "turn.list")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "runtime.catalog")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.self")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "turn.cancel")?.annotations?.destructiveHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "turn.run")?.annotations?.destructiveHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "turn.enqueue")?.annotations?.destructiveHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.list")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.get")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "turn.options")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.files.list")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.files.read_text")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "session.files.write_text")?.annotations?.readOnlyHint, false);
      assert.equal(result.tools.find((tool) => tool.name === "session.files.write_text")?.annotations?.destructiveHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "work.aggregation.get")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "work.aggregation.retry")?.annotations?.readOnlyHint, false);
      assert.equal(result.tools.find((tool) => tool.name === "interaction.list")?.annotations?.readOnlyHint, true);
      assert.equal(result.tools.find((tool) => tool.name === "interaction.respond")?.annotations?.destructiveHint, true);
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
        arguments: { kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" },
      });
      assert.equal(result.isError, undefined);
    });
    assert.deepEqual(requests, [{
      schemaVersion: "withmate-session-request-v2",
      operation: "coordination.event.create",
      input: { kind: "progress", payload: { summary: "started" }, idempotencyKey: "key-1" },
    }]);
  });

  it("COORD-RESOLVE-SURFACE-01: agentは回答optionなしでblockerを解決できる", async () => {
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
        name: "coordination.event.resolve",
        arguments: { eventId: "blocker-1", idempotencyKey: "resolve-blocker-1" },
      });
      assert.equal(result.isError, undefined);
      const invalid = await client.callTool({
        name: "coordination.event.resolve",
        arguments: { eventId: "decision-1", optionId: "continue", idempotencyKey: "resolve-decision-1" },
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
        input: { eventId: "blocker-1", idempotencyKey: "resolve-blocker-1" },
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

  it("session.createはcaller-owned keyを必須にし、session.list/getはread-onlyでdispatchする", async () => {
    const requests: any[] = [];
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
      const created = await client.callTool({ name: "session.create", arguments: {
        sessionRole: "executor", title: "Demo", provider: "codex", catalogRevision: 1,
        workspace: { kind: "session_folder" },
      } });
      assert.equal(created.isError, true);
      const createdWithKey = await client.callTool({ name: "session.create", arguments: {
        sessionRole: "executor",
        title: "Demo",
        provider: "codex",
        catalogRevision: 1,
        workspace: { kind: "session_folder" },
        idempotencyKey: "create-key-1",
      } });
      assert.equal(createdWithKey.isError, undefined);
      const listed = await client.callTool({ name: "session.list", arguments: {} });
      assert.equal(listed.isError, undefined);
      const fetched = await client.callTool({ name: "session.get", arguments: { sessionId: "s1" } });
      assert.equal(fetched.isError, undefined);
    });
    assert.equal(requests[0].operation, "session.create");
    assert.equal(requests[0].input.idempotencyKey, "create-key-1");
    assert.deepEqual(requests.slice(1).map((request) => request.operation), ["session.list", "session.get"]);
  });

  // @test-value v1
  // kind = "contract"
  // claim = "MCP runtime.catalogはWorkItem revision 2とroot改訂・履歴能力をstrict outputで返すread-only operationである"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#公開操作" }
  // failure_mode = "MCP catalogだけがrevision 1 schemaを要求してvalidなRoot WorkItem capability projectionをtool errorにする"
  // scope = "WithMate Session MCP runtime.catalog"
  // lifecycle = "permanent"
  // distinction = "空input dispatchとrevision 2のnested history catalog outputを同じtool callで検証する"
  // @end-test-value
  it("RUNTIME-CATALOG-02: runtime.catalogを空inputのread-only operationとしてdispatchする", async () => {
    const requests: unknown[] = [];
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
            allowedChildSessionRoles: {
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
        allowedChildSessionRoles: {
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
    assert.deepEqual(requests.map((request) => request.input.terminalFailureNotification), [
      { targetSessionId: "target-session" },
      { targetSessionId: "target-session" },
    ]);
  });

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

  it("空白のみの識別子をprotocol validationで拒否してruntimeを呼ばない", async () => {
    let runtimeCalls = 0;
    await withClient(createWithMateSessionMcpServer({
      discover: async () => {
        runtimeCalls += 1;
        return connection;
      },
    }), async (client) => {
      const result = await client.callTool({
        name: "turn.get",
        arguments: { sessionId: "   ", executionId: "execution-1" },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
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

  it("pre-dispatch failureはnot_applied、mutationのpost-dispatch failureはindeterminateにする", async () => {
    for (const [dispatched, expectedEffect] of [[false, "not_applied"], [true, "indeterminate"]] as const) {
      await withClient(createWithMateSessionMcpServer({
        discover: async () => connection,
        call: async () => { throw new SessionRuntimeClientError("private C:\\secret stack", dispatched); },
      }), async (client) => {
        const result = await client.callTool({ name: "turn.cancel", arguments: cancelInput });
        assert.equal(result.isError, true);
        const error = parseToolError(result as any);
        assert.equal(error.error.effect, expectedEffect);
        assert.doesNotMatch(JSON.stringify(error), /secret|stack/i);
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

  it("EXT-INTERACTION-11: interaction.list/respondをstrict schemaとcombined resultで公開する", async () => {
    const requests: any[] = [];
    const answered = {
      sequence: 1, interactionId: "interaction-1", sessionId: "session-1", executionId: "execution-1",
      kind: "approval", state: "answered",
      request: { title: "Approve", summary: "Run command" },
      resolution: { action: "approve", submittedFields: [], resolvedAt: "2026-08-13T00:00:01.000Z" },
      createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:01.000Z",
    };
    await withClient(createWithMateSessionMcpServer({
      discover: async () => connection,
      call: async (_connection, envelope) => {
        requests.push(envelope);
        return {
          ok: true,
          status: 200,
          value: createSessionRuntimeResult(envelope.operation, envelope.operation === "interaction.list"
            ? { items: [answered] }
            : { interaction: answered, execution: publicExecution } as never),
        };
      },
    }), async (client) => {
      const listed = await client.callTool({ name: "interaction.list", arguments: { sessionId: "session-1" } });
      assert.equal(listed.isError, undefined);
      const responded = await client.callTool({
        name: "interaction.respond",
        arguments: {
          sessionId: "session-1", executionId: "execution-1", interactionId: "interaction-1",
          response: { kind: "approval", decision: "approve" }, idempotencyKey: "respond-1", responseMode: "deferred",
        },
      });
      assert.equal(responded.isError, undefined);
      assert.equal((responded.structuredContent as any).result.interaction.state, "answered");
      assert.deepEqual(requests.map((request) => request.operation), ["interaction.list", "interaction.respond"]);
    });
  });
});
