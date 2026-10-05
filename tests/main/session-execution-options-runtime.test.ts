import assert from "node:assert/strict";
import { createAuditProgressWriter } from "./helpers/audit-progress-fixture.js";
import { it } from "node:test";

import { buildNewSession, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { SessionRuntimeService, type SessionRuntimeServiceDeps } from "../../src-electron/session/session-runtime-service.js";
import type { RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "model-a",
  defaultReasoningEffort: "high",
  models: [
    { id: "model-a", label: "Model A", reasoningEfforts: ["high"] },
    { id: "model-b", label: "Model B", reasoningEfforts: ["medium"] },
  ],
};

function makeService(observe: {
  composed: RunSessionTurnInput[];
  executed: RunSessionTurnInput[];
  audit: Array<Parameters<SessionRuntimeServiceDeps["createAuditLog"]>[0]>;
  persisted: Session[];
}) {
  const stored = buildNewSession({
    taskTitle: "Execution options",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    provider: "codex",
    approvalMode: "untrusted",
    model: "model-a",
    reasoningEffort: "high",
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { main: "#111111", sub: "#222222" },
  });
  let current = stored;
  const adapter = {
    composePrompt(input: RunSessionTurnInput) {
      observe.composed.push(input);
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
    async getProviderQuotaTelemetry() { return null; },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    async runSessionTurn(input: RunSessionTurnInput) {
      observe.executed.push(input);
      return {
        threadId: "thread-1",
        assistantText: "done",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        transportPayload: null,
        operations: [],
        rawItemsJson: "[]",
        usage: null,
      };
    },
  };
  const service = new SessionRuntimeService({
    getSession: () => current,
    upsertSession(next) {
      current = { ...next, model: stored.model, reasoningEffort: stored.reasoningEffort, approvalMode: stored.approvalMode };
      observe.persisted.push(current);
      return current;
    },
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }),
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => ({ snapshot: { revision: 1, providers: [providerCatalog] }, provider: providerCatalog }),
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: () => ({
      sessionId: stored.id,
      workspacePath: stored.workspacePath,
      threadId: "",
      schemaVersion: 1,
      updatedAt: "",
      goal: "",
      decisions: [],
      openQuestions: [],
      nextActions: [],
      notes: [],
    }),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createAuditLog(input) {
      observe.audit.push(input);
      return { id: 1, ...input };
    },
    updateAuditLog(_id, input) { observe.audit.push(input); },
    updateAuditLogProgress: createAuditProgressWriter(),
    setLiveSessionRun() {},
    getLiveSessionRun: () => null,
    waitForApprovalDecision: () => "deny",
    waitForElicitationResponse: () => ({ action: "cancel" }),
    setProviderQuotaTelemetry() {},
    setSessionContextTelemetry() {},
    invalidateProviderSessionThread() {},
    scheduleProviderQuotaTelemetryRefresh() {},
    broadcastLiveSessionRun() {},
    resolvePendingApprovalRequest() {},
    resolvePendingElicitationRequest() {},
  });
  return { service, stored };
}

// @test-value v2
// kind = "invariant"
// claim = "送信時に選んだ model/depth/approval は、開始・終了保存が古いSession設定を返しても同一turnのprompt、Provider、running/terminal auditへ伝わる"
// oracle = { type = "contract", ref = "Issue #738 turn execution options boundary" }
// fault = "保存済みSession設定または保存戻り値からturn実行設定を再取得する"
// observable = "composer/provider inputのexecutionOptionsとrunning/terminal audit fields"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn execution"
// lifecycle = "permanent"
// impact = "表示選択と異なるmodelやapprovalでProviderを実行し監査に誤設定が残る"
// distinction = "既存のSession永続化・Provider単体testでは保存戻り値と送信値の不一致を観測しない"
// @end-test-value
it("turn送信値を保存済み設定と独立にprompt・Provider・auditへ固定する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], audit: [] as Array<Parameters<SessionRuntimeServiceDeps["createAuditLog"]>[0]>, persisted: [] as Session[] };
  const { service, stored } = makeService(observe);
  const selected = Object.freeze({ ...captureSessionExecutionOptions(stored), model: "model-b", reasoningEffort: "medium" as const, approvalMode: "never" as const });

  await service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: selected });
  for (let attempt = 0; attempt < 20 && !observe.audit.some((entry) => entry.phase === "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(observe.persisted[0]?.model, "model-a");
  assert.equal(observe.composed[0]?.session.model, "model-a");
  assert.deepEqual(observe.composed[0]?.executionOptions, selected);
  assert.deepEqual(observe.executed[0]?.executionOptions, selected);
  assert.equal(observe.executed[0]?.session.model, "model-a");
  assert.equal(observe.executed[0]?.executionOptions, observe.composed[0]?.executionOptions);
  assert.equal(Object.isFrozen(observe.executed[0]?.executionOptions), true);
  for (const phase of ["running", "completed"] as const) {
    const audit = observe.audit.find((entry) => entry.phase === phase);
    assert.equal(audit?.model, "model-b");
    assert.equal(audit?.reasoningEffort, "medium");
    assert.equal(audit?.approvalMode, "never");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "catalogに無いmodelまたは当該model非対応depthはProvider起動とturn開始保存の前に拒否される"
// oracle = { type = "contract", ref = "Issue #738 invalid turn selection rejection" }
// fault = "無効な送信値をDB値・default・clampへ置き換えて実行する"
// observable = "runSessionTurn rejection、provider call数、保存数"
// observation_boundary = "component-behavior"
// scope = "SessionRuntimeService turn selection validation"
// lifecycle = "permanent"
// impact = "利用者が選ばなかったmodel/depthで実行される"
// distinction = "型検査ではIPC実行時値とcatalog対応関係を検証できない"
// @end-test-value
it("無効なmodel・depthを保存とProvider起動前に拒否する", async () => {
  const observe = { composed: [] as RunSessionTurnInput[], executed: [] as RunSessionTurnInput[], audit: [] as Array<Parameters<SessionRuntimeServiceDeps["createAuditLog"]>[0]>, persisted: [] as Session[] };
  const { service, stored } = makeService(observe);
  const selected = captureSessionExecutionOptions(stored);
  await assert.rejects(service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: { ...selected, model: "unknown" } }), /model catalog/);
  await assert.rejects(service.runSessionTurn(stored.id, { userMessage: "run", executionOptions: { ...selected, model: "model-b", reasoningEffort: "high" } }), /reasoning effort/);
  assert.equal(observe.persisted.length, 0);
  assert.equal(observe.composed.length, 0);
  assert.equal(observe.executed.length, 0);
  assert.equal(observe.audit.length, 0);
});
