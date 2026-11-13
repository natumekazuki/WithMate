import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runWithMateSessionCli } from "../../src-cli/session/withmate-session.js";
import { createWithMateSessionMcpServer } from "../../src-electron/platform/mcp/withmate-session-mcp.js";
import type {
  callWithMateMemoryRuntime,
  WithMateMemoryRuntimeConnection,
} from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { SessionManagementApplication } from "../../src-electron/session/session-management-application.js";
import { SessionManagementRuntimeService } from "../../src-electron/session/session-management-runtime-service.js";
import { SessionRuntimeService } from "../../src-electron/session/session-runtime-service.js";
import { SessionPersistenceService } from "../../src-electron/session/session-persistence-service.js";
import {
  resolveRelatedSessions,
  type RelatedSession,
} from "../../src-electron/session/session-relationship-resolver.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { AgentRuntimeBindingRegistry } from "../../src-electron/providers/agent-runtime-binding.js";
import { ProviderAgentRuntimeTurnCoordinator } from "../../src-electron/providers/provider-agent-runtime-turn-coordinator.js";
import type { ProviderCodingAdapter, RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import {
  getSessionAgentRuntimeOperations,
  type SessionTarget,
} from "../../src-shared/session/session-management-contract.js";
import { buildNewSession, getSessionIncarnationId, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

const target = (session: Session): SessionTarget => ({
  kind: "main",
  sessionId: session.id,
  incarnationId: getSessionIncarnationId(session),
});
const owner = (session: Session) => ({ sessionId: session.id, incarnationId: getSessionIncarnationId(session) });
const connection: WithMateMemoryRuntimeConnection = {
  api: {
    baseUrl: "http://127.0.0.1:7777",
    apiSecret: "secret",
    applicationInstanceId: "instance",
    runtimeGenerationId: "generation",
    runtimeInstanceId: "generation",
  },
  credential: { adapter: "mcp", adapterSecret: "adapter" },
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function fixture(provider = "codex") {
  const directory = await mkdtemp(join(tmpdir(), "withmate-parent-steer-"));
  const options = {
    dbPath: join(directory, "withmate-v6.db"),
    userDataPath: directory,
    workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
    handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url),
    workerOptions: { execArgv: ["--import", "tsx"] },
  };
  const bundle = createV6StorageWorkerBundle(options);
  try {
    await bundle.initialize();
    const create = (id: string, parentSessionId: string | null, childProvider = provider) =>
      bundle.stores.session.insertSession(
        buildNewSession({
          id,
          taskTitle: id,
          workspaceLabel: id,
          workspacePath: directory,
          branch: "main",
          characterId: id,
          character: id,
          characterIconPath: "",
          characterThemeColors: { main: "#123456", sub: "#abcdef" },
          provider: childProvider,
          model: "model",
          reasoningEffort: "high",
          approvalMode: "on-request",
          codexSandboxMode: "workspace-write",
          sessionRole:
            parentSessionId === "child" ? "executor" : parentSessionId ? "task-coordinator" : "overall-coordinator",
          rootSessionId: "parent",
          parentSessionId,
          createdBySessionId: parentSessionId,
        }),
      );
    const parent = await create("parent", null, "copilot"),
      child = await create("child", parent.id);
    const sibling = await create("sibling", parent.id),
      grandchild = await create("grandchild", child.id);
    let cached = [parent, child, sibling, grandchild];
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings[provider] = { enabled: true, apiKey: "", skillRootPath: "" };
    const catalog = {
      id: provider,
      label: provider,
      defaultModelId: "model",
      defaultReasoningEffort: "high",
      models: [{ id: "model", label: "Model", reasoningEfforts: ["high"] }],
    };
    const unused = async (): Promise<never> => {
      throw new Error("Unexpected operation");
    };
    const hooks = {
      preview: async () => {},
      afterBegin: async () => {},
      dispatch: async () => {},
      afterConfirm: async () => {},
    };
    const persistence = new SessionPersistenceService({
      getSessions: () => cached,
      setSessions: (next) => {
        cached = next;
      },
      getSession: (id) => cached.find((session) => session.id === id) ?? null,
      getStoredSession: (id) => bundle.stores.session.getSession(id),
      isSessionRunInFlight: () => true,
      upsertStoredSession: unused,
      replaceStoredSessions: unused,
      listStoredSessions: () => bundle.stores.session.listSessions(),
      appendStoredRunningTurnStart: (input) => bundle.stores.session.appendRunningTurnStart(input),
      beginStoredSessionSteer: async (input) => {
        const result = await bundle.stores.session.beginSessionSteer(input);
        await hooks.afterBegin();
        return result;
      },
      settleStoredSessionSteer: async (input) => {
        const result = await bundle.stores.session.settleSessionSteer(input);
        if (input.state === "confirmed") await hooks.afterConfirm();
        return result;
      },
      appendStoredSessionTerminal: (input) => bundle.stores.session.appendSessionTerminal(input),
      checkpointStoredSessionRunMetadata: (input) => bundle.stores.session.checkpointSessionRunMetadata(input),
      getAppSettings: () => settings,
      getModelCatalogSnapshot: () => ({ providers: [catalog] }),
      syncSessionDependencies() {},
      clearSessionContextTelemetry() {},
      clearSessionBackgroundActivities() {},
      invalidateProviderSessionThread() {},
      closeSessionWindow() {},
      broadcastSessions() {},
    });
    const live = new Map<string, LiveSessionRunState | null>();
    const runs: RunSessionTurnInput[] = [],
      sent: Parameters<NonNullable<ProviderCodingAdapter["steerSessionTurn"]>>[0][] = [];
    let started = deferred(),
      finish = deferred();
    const adapter: ProviderCodingAdapter = {
      composePrompt: () => ({
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        imagePaths: [],
        additionalDirectories: [],
      }),
      getProviderQuotaTelemetry: async () => null,
      invalidateSessionThread: async () => {},
      invalidateAllSessionThreads: async () => {},
      runSessionTurn: async (input, progress) => {
        runs.push(input);
        await progress?.(
          {
            sessionId: child.id,
            threadId: "thread",
            turnId: "native-turn",
            inputAvailable: true,
            assistantText: "",
            reasoningText: "",
            steps: [],
            backgroundTasks: [],
            usage: null,
            errorMessage: "",
            approvalRequest: null,
            elicitationRequest: null,
          },
          { steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } },
        );
        started.resolve();
        await finish.promise;
        return { threadId: "thread", assistantText: "done", usage: null };
      },
      steerSessionTurn: async (input) => {
        sent.push(input);
        const saved = await bundle.stores.session.getSession(child.id);
        assert.equal(saved!.messages.at(-1)!.turnInput!.state, "pending");
        assert.equal(saved!.messages.at(-1)!.turnInput!.origin!.actorSessionId, parent.id);
        await hooks.dispatch();
        return { turnId: input.expectedTurnId };
      },
    };
    const runtime = new SessionRuntimeService({
      getSession: (id) => bundle.stores.session.getSession(id),
      persistRunningTurnStart: (...args) => persistence.persistRunningTurnStart(...args),
      appendRunningInput: (...args) => persistence.appendRunningInput(...args),
      beginRunningInput: (...args) => persistence.beginRunningInput(...args),
      settleRunningInput: (...args) => persistence.settleRunningInput(...args),
      checkpointRuntimeMetadata: (...args) => persistence.checkpointRuntimeMetadata(...args),
      appendTerminalSession: (session, commit) => persistence.appendTerminalSession(session, commit),
      resolveComposerPreview: async (_session, text) => {
        if (text !== "A") await hooks.preview();
        return { attachments: [], errors: [] };
      },
      getAppSettings: () => settings,
      resolveProviderCatalog: () => ({ snapshot: { providers: [catalog] }, provider: catalog }),
      getProviderCodingAdapter: () => adapter,
      createSessionTurn: (input) => bundle.stores.turn.createSessionTurn(input),
      updateSessionTurn: (id, input) => bundle.stores.turn.updateSessionTurn(id, input),
      setLiveSessionRun: (id, value) => {
        live.set(id, value);
      },
      getLiveSessionRun: (id) => live.get(id) ?? null,
      waitForApprovalDecision: () => "approve",
      waitForElicitationResponse: () => ({ action: "cancel" }),
      setProviderQuotaTelemetry() {},
      setSessionContextTelemetry() {},
      invalidateProviderSessionThread() {},
      scheduleProviderQuotaTelemetryRefresh() {},
      broadcastLiveSessionRun() {},
      resolvePendingApprovalRequest() {},
      resolvePendingElicitationRequest() {},
    });
    const source = await bundle.stores.turn.createSessionTurn({
      sessionId: parent.id,
      phase: "running",
      createdAt: new Date().toISOString(),
      provider: parent.provider,
      model: parent.model,
      reasoningEffort: parent.reasoningEffort,
      approvalMode: parent.approvalMode,
      threadId: "",
      errorMessage: "",
    });
    const queue = new SessionTurnQueueService({
      store: bundle.stores.queue,
      isRunInFlight: () => true,
      dispatch: unused,
    });
    const facade = new MainSessionTurnQueueFacade({
      assertActive() {},
      assertAccepting() {},
      getSession: (id) => bundle.stores.session.getSession(id),
      getAppSettings: async () => settings,
      validateWorkspace: async () => {},
      validateProvider: async () => ({ provider: catalog }),
      preview: async () => ({ attachments: [], errors: [] }),
      store: bundle.stores.queue,
      service: queue,
    });
    const extra: RelatedSession[] = [];
    const application = new SessionManagementApplication({
      operatingPolicy: unused,
      listSessions: async () => [
        ...resolveRelatedSessions(await bundle.stores.session.listSessionSummaries(), []),
        ...extra,
      ],
      currentTurn: async (actor) => ({
        turnId: actor.id === parent.id ? String(source.id) : (live.get(actor.id)?.sessionTurnId ?? null),
        receipt: null,
        origin: null,
      }),
      crewFolder: async () => ({ rootSessionId: parent.id, path: directory }),
      steer: (destination, input, actor, turnId, guard) =>
        runtime.steerChildSessionTurn(
          { sessionId: destination.id, incarnationId: destination.incarnationId },
          input.turnId,
          input.message,
          { sessionId: actor.id, incarnationId: actor.incarnationId, turnId },
          guard,
        ),
      readExecution: async (_destination, operation, request) =>
        bundle.stores.execution.execute({ target: request.target, operation, request }),
      enqueue: (destination, input, actor, turnId, guard) =>
        facade.enqueueSessionMessage(
          input,
          {
            kind: "session",
            operation: "send",
            actorKind: actor.kind,
            actorSessionId: actor.id,
            actorIncarnationId: actor.incarnationId,
            actorTurnId: turnId,
            targetSessionId: destination.id,
            targetIncarnationId: destination.incarnationId,
          },
          guard,
        ),
      getReceipt: unused,
      directories: unused,
      updateMetadata: unused,
      cancelReceipt: unused,
      stopTurn: unused,
      createChild: unused,
      coordinate: unused,
      catalog: unused,
    });
    const bindings = new AgentRuntimeBindingRegistry(),
      turns = new ProviderAgentRuntimeTurnCoordinator();
    const routing = new SessionManagementRuntimeService({
      application,
      bindingRegistry: bindings,
      providerAgentRuntimeTurns: turns,
    });
    const runtimeCall: typeof callWithMateMemoryRuntime = async (_connection, operation, bound) => {
      const response = await routing.route({
        ...operation,
        transport: "mcp",
        bindingReference: bound.bindingReference,
        turnCapability: bound.turnCapability,
      });
      assert.ok(response);
      return { ok: response.status >= 200 && response.status < 300, status: response.status, value: response.value };
    };
    const cleanups: (() => Promise<void>)[] = [];
    async function endpoint(session: Session, identity = target(session)) {
      const binding = bindings.issueOrReuse({
        actorSessionId: identity.sessionId,
        providerId: session.provider,
        authoritySnapshot: { sessionIdentity: identity },
        operationGrants: getSessionAgentRuntimeOperations(),
      });
      const active = turns.begin({ actorSessionId: identity.sessionId, providerId: session.provider });
      const env = {
        WITHMATE_AGENT_RUNTIME_BINDING_REFERENCE: binding.bindingReference,
        WITHMATE_AGENT_RUNTIME_TURN_CAPABILITY: active.capability,
      };
      const server = createWithMateSessionMcpServer({ env, connection, runtimeCall });
      const client = new Client({ name: "parent-steer", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      cleanups.push(async () => {
        await client.close();
        await server.close();
        turns.end(active);
      });
      return {
        revoke: () => turns.end(active),
        call: async (
          transport: "cli" | "mcp",
          operation: string,
          body: Record<string, unknown>,
        ): Promise<Record<string, any>> => {
          if (transport === "mcp") {
            const result = await client.callTool({ name: `session.${operation}`, arguments: body });
            return result.structuredContent ?? result;
          }
          let output = "";
          await runWithMateSessionCli([operation.replaceAll("_", "-"), "--json", JSON.stringify(body)], {
            env,
            connection,
            runtimeCall,
            stdout: {
              write: (text) => {
                output += String(text);
                return true;
              },
            },
            stderr: { write: () => true },
          });
          return JSON.parse(output);
        },
      };
    }
    let running: Promise<Session> | undefined;
    return {
      parent,
      child,
      sibling,
      grandchild,
      source,
      extra,
      runtime,
      bundle,
      hooks,
      live,
      sent,
      runs,
      endpoint,
      async start() {
        started = deferred();
        finish = deferred();
        running = runtime.runSessionTurn(child.id, {
          userMessage: "A",
          executionOptions: captureSessionExecutionOptions(child),
        });
        await Promise.race([
          started.promise,
          running.then(() => {
            throw new Error("Turn ended before starting");
          }),
        ]);
        return live.get(child.id)!.sessionTurnId!;
      },
      async finish() {
        finish.resolve();
        await running;
      },
      async close() {
        finish.resolve();
        await running?.catch(() => {});
        for (const cleanup of cleanups) await cleanup();
        await queue.close();
        await bundle.client.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await bundle.client.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// @test-value v2
// kind = "contract"
// claim = "MCPとCLIの親Steerは同じ子Turnへ本文と実親来歴を保存し、通常enqueueは次Turnを待ち、保存設定を変えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938" }
// fault = "Steerを通常queueへ送る、来歴をGUI扱いする、確定追加入力を取得できない、進行中設定や保存設定を変更する"
// observable = "両入口の結果、実Workerから読んだ入力A/BとinputOrigin・speaker、Providerへのnative Turnと来歴、receipt状態とTurn設定"
// observation_boundary = "public-boundary"
// scope = "SDK MCP/bound CLI→binding→application→production runtime/persistence→実Storage Worker。Provider・HTTP交換・currentTurn解決はfixture"
// lifecycle = "permanent"
// impact = "親の訂正が別作業へ届く、またはユーザーの発話と誤認される"
// distinction = "schema検査とruntime単体では両入口から永続化・履歴読取までの接続を検証できない"
// @end-test-value
test("parent Steer preserves the exact Turn, attribution and settings through MCP and CLI", async () => {
  const f = await fixture();
  try {
    const parent = await f.endpoint(f.parent);
    const turnId = await f.start();
    const initial = captureSessionExecutionOptions((await f.bundle.stores.session.getSession(f.child.id))!);
    for (const transport of ["mcp", "cli"] as const) {
      assert.equal((await parent.call(transport, "get", { target: target(f.child) })).currentTurn.turnId, turnId);
      const text = `B ${transport}: check loading before changing settings`;
      const response = await parent.call(transport, "steer", { target: target(f.child), turnId, message: text });
      assert.equal(response.ok, true);
      assert.equal(response.result.outcome, "applied");
      assert.equal(response.result.turnId, turnId);
      const seq = response.result.messageSeq;
      const detail = await parent.call(transport, "get_execution_input", { target: target(f.child), turnId, seq });
      assert.equal(detail.text, text);
      assert.equal(detail.turnId, turnId);
      assert.equal(detail.inputOrigin.operation, "steer");
      assert.equal(detail.inputOrigin.actorSessionId, f.parent.id);
      assert.equal(detail.inputOrigin.actorIncarnationId, f.parent.incarnationId);
      assert.equal(detail.inputOrigin.actorTurnId, String(f.source.id));
      assert.equal(detail.inputOrigin.kind, "session");
      const history = await parent.call(transport, "get_message", { target: target(f.child), seq });
      assert.equal(history.speaker.kind, "agent");
      assert.equal(history.speaker.session.id, f.parent.id);
      assert.equal(f.sent.at(-1)!.expectedTurnId, "native-turn");
      assert.match(f.sent.at(-1)!.userMessage, /not spoken directly by the user/);
      assert.ok(f.sent.at(-1)!.userMessage.includes(text));
    }
    const inputs = await parent.call("cli", "list_execution_inputs", { target: target(f.child), turnId });
    assert.deepEqual(
      inputs.items.map((item: { kind: string }) => item.kind),
      ["start", "additional", "additional"],
    );
    assert.equal(
      (await parent.call("mcp", "get_execution_input", { target: target(f.child), turnId, seq: inputs.items[0].seq }))
        .text,
      "A",
    );
    const executions = await f.bundle.stores.execution.execute({
      target: target(f.child),
      operation: "list_executions",
      request: { target: target(f.child), kind: "turns" },
    });
    assert.ok(executions.ok);
    assert.equal(executions.total, 1);
    const queued = await parent.call("cli", "enqueue", {
      target: target(f.child),
      requestId: randomUUID(),
      message: "next Turn",
      model: "model",
      reasoningEffort: "high",
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
    });
    assert.equal(queued.receipt.state, "queued");
    assert.equal(f.sent.length, 2);
    assert.equal(f.runs.length, 1);
    assert.deepEqual(captureSessionExecutionOptions((await f.bundle.stores.session.getSession(f.child.id))!), initial);
    const execution = await parent.call("mcp", "get_execution", { target: target(f.child), turnId });
    assert.deepEqual(
      [
        execution.executionSettings.model,
        execution.executionSettings.reasoningEffort,
        execution.executionSettings.approvalMode,
        execution.executionSettings.codexSandboxMode,
      ],
      ["model", "high", "on-request", "workspace-write"],
    );
    await f.finish();
    assert.equal(
      (await parent.call("cli", "list_execution_inputs", { target: target(f.child), turnId })).items.length,
      3,
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "両入口のSteerは実直属親だけに許可し、旧世代・終了済Turn・非対応Providerを送信せず準備中の交代や失効も別Turnへ転送しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938" }
// fault = "子・兄弟・祖父母・Auxiliaryを親扱いする、終了・交代・非対応や失効後にProviderへ送信する"
// observable = "両入口の拒否code/effectまたはnot-applied、Provider呼出数、子の保存入力件数"
// observation_boundary = "public-boundary"
// scope = "MCP/CLI→実認可・runtime、実Worker履歴、Provider/準備gateとAuxiliary metadataはfixture"
// lifecycle = "permanent"
// impact = "権限のないAgentや古い依頼が別作業の進行へ介入する"
// distinction = "正常系とschemaでは関係・世代・非同期Turn交代を検出できない"
// @end-test-value
test("parent Steer rejects unrelated senders and never retargets stale or unsupported Turns", async () => {
  for (const provider of ["codex", "copilot", "claude", "opencode"]) {
    const f = await fixture(provider);
    try {
      const parent = await f.endpoint(f.parent),
        child = await f.endpoint(f.child),
        sibling = await f.endpoint(f.sibling);
      const turnId = await f.start();
      f.extra.push({
        ...resolveRelatedSessions([f.parent], [])[0],
        id: "aux",
        incarnationId: "aux-v1",
        kind: "auxiliary",
        role: "auxiliary",
        mainSessionId: f.parent.id,
        mainIncarnationId: f.parent.incarnationId!,
      });
      const aux = await f.endpoint(f.parent, {
        kind: "auxiliary",
        sessionId: "aux",
        incarnationId: "aux-v1",
        mainSessionId: f.parent.id,
        mainIncarnationId: f.parent.incarnationId!,
      });
      for (const transport of ["mcp", "cli"] as const) {
        for (const [sender, recipient] of [
          [child, f.parent],
          [sibling, f.child],
          [parent, f.grandchild],
          [aux, f.child],
        ] as const) {
          const response = await sender.call(transport, "steer", {
            target: target(recipient),
            turnId,
            message: "forbidden",
          });
          assert.equal(response.code, "SESSION_FORBIDDEN");
          assert.equal(response.effect, "none");
        }
        const replaced = await parent.call(transport, "steer", {
          target: { ...target(f.child), incarnationId: "old" },
          turnId,
          message: "old owner",
        });
        assert.equal(replaced.code, "SESSION_REPLACED");
        assert.equal(replaced.effect, "none");
        const notApplied = await parent.call(transport, "steer", {
          target: target(f.child),
          turnId: provider === "codex" ? "999999" : turnId,
          message: "not applicable",
        });
        assert.equal(notApplied.result.outcome, "not-applied");
      }
      if (provider === "codex") {
        const entered = deferred(),
          resume = deferred();
        f.hooks.preview = async () => {
          entered.resolve();
          await resume.promise;
        };
        const pending = parent.call("cli", "steer", { target: target(f.child), turnId, message: "race" });
        await entered.promise;
        await f.finish();
        resume.resolve();
        assert.equal((await pending).result.outcome, "not-applied");
        const nextId = await f.start();
        assert.notEqual(nextId, turnId);
        assert.equal(
          (await parent.call("cli", "steer", { target: target(f.child), turnId, message: "stale Turn" })).result
            .outcome,
          "not-applied",
        );
        f.hooks.preview = async () => {
          parent.revoke();
        };
        assert.equal(
          (await parent.call("mcp", "steer", { target: target(f.child), turnId: nextId, message: "revoked" })).result
            .outcome,
          "not-applied",
        );
      } else await f.finish();
      assert.equal(f.sent.length, 0);
      assert.ok(
        (await f.bundle.stores.session.getSession(f.child.id))!.messages.every((message) => !message.turnInput),
      );
    } finally {
      await f.close();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "親SteerのProvider結果不明は未送信と区別して保存・取得でき、ACK喪失や終端競合でも自動再送しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/938" }
// fault = "送信後失敗をnot-appliedにする、確定保存を不明へ巻き戻す、未送信・不明を成功とする、終端が入力保存を追い越す"
// observable = "両入口のeffect/outcome、履歴stateとinputOrigin、Provider回数、保存終端と入力本文"
// observation_boundary = "public-boundary"
// scope = "production runtime/persistenceと実Worker。Provider失敗、begin/confirm後ACKと終端のgateをfixture注入"
// lifecycle = "permanent"
// impact = "訂正の重複配送または適用済みと誤認したまま運用する"
// distinction = "通常Steer testは公開MCP/CLIの結果と保存された親来歴を照合しない"
// @end-test-value
test("parent Steer reports uncertain delivery and preserves confirmed input across terminal races", async () => {
  for (const mode of ["unknown", "not-sent", "confirm-lost", "terminal-race"] as const) {
    const f = await fixture();
    try {
      const parent = await f.endpoint(f.parent);
      const turnId = await f.start();
      if (mode === "unknown")
        f.hooks.dispatch = async () => {
          throw new Error("Provider response lost");
        };
      if (mode === "not-sent")
        f.hooks.afterBegin = async () => {
          parent.revoke();
        };
      if (mode === "confirm-lost")
        f.hooks.afterConfirm = async () => {
          throw new Error("Confirmation reply lost");
        };
      const dispatchEntered = deferred(),
        dispatchResume = deferred();
      if (mode === "terminal-race")
        f.hooks.dispatch = async () => {
          dispatchEntered.resolve();
          await dispatchResume.promise;
        };
      const pending = parent.call(mode === "unknown" || mode === "terminal-race" ? "cli" : "mcp", "steer", {
        target: target(f.child),
        turnId,
        message: "B",
      });
      let finishing: Promise<void> | undefined;
      if (mode === "terminal-race") {
        await dispatchEntered.promise;
        finishing = f.finish();
        dispatchResume.resolve();
      }
      const response = await pending;
      const uncertain = mode === "unknown" || mode === "confirm-lost";
      assert.equal(response.ok, !uncertain);
      assert.equal(response.result.outcome, uncertain ? "unknown" : mode === "not-sent" ? "not-applied" : "applied");
      if (uncertain) {
        assert.equal(response.code, "SESSION_STEER_UNKNOWN");
        assert.equal(response.effect, "unknown");
      }
      assert.equal(f.sent.length, mode === "not-sent" ? 0 : 1);
      await finishing;
      await f.finish();
      const reader = await f.endpoint(f.child);
      const inputState = mode === "unknown" ? "unresolved" : mode === "not-sent" ? "not-sent" : "confirmed";
      const inputs = await reader.call("cli", "list_execution_inputs", {
        target: target(f.child),
        turnId,
        state: inputState,
      });
      const additional = inputs.items.filter((input: { kind: string }) => input.kind === "additional");
      assert.equal(additional.length, 1);
      assert.equal(
        additional[0].state,
        mode === "unknown" ? "unknown" : mode === "not-sent" ? "not-sent" : "confirmed",
      );
      assert.equal(additional[0].inputOrigin.actorSessionId, f.parent.id);
      assert.equal(
        (await reader.call("mcp", "get_execution_input", { target: target(f.child), turnId, seq: additional[0].seq }))
          .text,
        "B",
      );
      assert.deepEqual(
        (await f.bundle.stores.session.getSession(f.child.id))!.messages.map((message) => message.text),
        ["A", "B", "done"],
      );
    } finally {
      await f.close();
    }
  }
});
