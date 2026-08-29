import assert from "node:assert/strict";
import { it } from "node:test";

import {
  buildNewSession,
  currentTimestampLabel,
  type AuditLogEntry,
  type ComposerPreview,
  type LiveApprovalDecision,
  type Session,
  type SessionMemory,
} from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { normalizeAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import type { ProviderCodingAdapter } from "../../src-electron/provider-runtime.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session-runtime-service.js";

function createSession(overrides?: Partial<Session>): Session {
  return {
    ...buildNewSession({
      taskTitle: "Runtime Test",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "char-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    ...overrides,
  };
}

function createProviderCatalog(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
  };
}

function createSessionMemory(sessionId: string): SessionMemory {
  return {
    sessionId,
    workspacePath: "C:/workspace",
    threadId: "",
    schemaVersion: 1,
    goal: "テストする",
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

type CreateAuditLogInput = Parameters<SessionRuntimeServiceDeps["createAuditLog"]>[0];

function createAuditLog(input: CreateAuditLogInput): AuditLogEntry {
  return { id: 1, ...input };
}

function createRuntimeDeps(
  session: Session,
  adapter: ProviderCodingAdapter,
  overrides: Partial<SessionRuntimeServiceDeps>,
): SessionRuntimeServiceDeps {
  return {
    getSession: (sessionId) => sessionId === session.id ? session : null,
    upsertSession: (next) => next,
    resolveComposerPreview: async () => ({ attachments: [], errors: [] }) satisfies ComposerPreview,
    getAppSettings: () => normalizeAppSettings({}),
    resolveProviderCatalog: () => {
      const provider = createProviderCatalog();
      return { snapshot: { revision: 1, providers: [provider] }, provider };
    },
    getProviderCodingAdapter: () => adapter,
    getSessionMemory: (current) => createSessionMemory(current.id),
    resolveProjectMemoryEntriesForPrompt: () => [],
    createAuditLog,
    updateAuditLog: () => undefined,
    setLiveSessionRun: () => undefined,
    getLiveSessionRun: () => null,
    waitForApprovalDecision: async (): Promise<LiveApprovalDecision> => "approve",
    waitForElicitationResponse: async () => ({ action: "cancel" }),
    setProviderQuotaTelemetry: () => undefined,
    setSessionContextTelemetry: () => undefined,
    invalidateProviderSessionThread: () => undefined,
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
    runCharacterReflection: () => undefined,
    broadcastLiveSessionRun: () => undefined,
    resolvePendingApprovalRequest: () => undefined,
    resolvePendingElicitationRequest: () => undefined,
    currentTimestampLabel,
    ...overrides,
  };
}

function createAdapter(runSessionTurn: ProviderCodingAdapter["runSessionTurn"]): ProviderCodingAdapter {
  return {
    composePrompt: () => ({
      systemBodyText: "system",
      inputBodyText: "input",
      logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
      imagePaths: [],
      additionalDirectories: [],
    }),
    getProviderQuotaTelemetry: async () => null,
    invalidateSessionThread: () => undefined,
    invalidateAllSessionThreads: () => undefined,
    runSessionTurn,
  };
}

// @test-value v1
// kind = "invariant"
// claim = "running turn開始の永続化が失敗した場合はprovider dispatchとrunning audit作成を行わない"
// oracle = { type = "contract", ref = "running-turn-start-persistence#2,#6" }
// failure_mode = "user messageとrunning metadataを保存できていないturnをproviderへdispatchして外部副作用だけを開始する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "provider failureではなくprovider dispatch前の専用persistence failure timingを観測する"
// @end-test-value
it("running turn開始の保存失敗時はproviderをdispatchしない", async () => {
  const session = createSession();
  let providerDispatched = false;
  let runningAuditCreated = false;
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    persistRunningTurnStart: () => {
      throw new Error("running persistence failed");
    },
    createAuditLog: (input) => {
      runningAuditCreated = true;
      return createAuditLog(input);
    },
  }));

  await assert.rejects(
    service.runSessionTurn(session.id, { userMessage: "お願い" }),
    /running persistence failed/,
  );
  assert.equal(providerDispatched, false);
  assert.equal(runningAuditCreated, false);
});

// @test-value v1
// kind = "invariant"
// claim = "provider dispatchは最新authoring snapshotを含む専用開始保存の成功後だけに行われ、terminal保存は既存経路を使う"
// oracle = { type = "contract", ref = "running-turn-start-persistence#1,#6,#7;docs/design/character-storage.md#Runtime-Snapshot" }
// failure_mode = "providerを開始保存より先にdispatchするか、再生成したCharacter snapshotを開始保存へ渡さずDBとproviderを不一致にする"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "authoring snapshot解決、開始保存、provider外部副作用、provider失敗後のterminal generic保存の順序と入力を観測する"
// @end-test-value
it("providerは最新authoring snapshotの開始保存後にdispatchし、terminal状態はgeneric経路で保存する", async () => {
  const oldSnapshot = {
    characterId: "char-a",
    name: "Old",
    description: "",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# Old",
    definitionSha256: "old",
    definitionByteSize: 5,
    snapshotAt: "old",
  };
  const freshSnapshot = {
    ...oldSnapshot,
    name: "Fresh",
    definitionMarkdown: "# Fresh",
    definitionSha256: "fresh",
    definitionByteSize: 7,
    snapshotAt: "fresh",
  };
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
  });
  const events: string[] = [];
  const adapter = createAdapter(async () => {
    events.push("provider-dispatch");
    throw new Error("provider failed");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({
      ...stored,
      character: freshSnapshot.name,
      characterRuntimeSnapshot: freshSnapshot,
    }),
    persistRunningTurnStart: (next, expectedMessageCount) => {
      assert.equal(expectedMessageCount, 0);
      assert.deepEqual(next.characterRuntimeSnapshot, freshSnapshot);
      assert.equal(next.character, "Fresh");
      events.push("running-start-persisted");
      return next;
    },
    upsertSession: (next) => {
      events.push("generic-terminal-" + next.runState);
      return next;
    },
  }));

  const result = await service.runSessionTurn(session.id, { userMessage: "お願い" });

  assert.equal(result.runState, "error");
  assert.deepEqual(events, [
    "running-start-persisted",
    "provider-dispatch",
    "generic-terminal-error",
  ]);
});
