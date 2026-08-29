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
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
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

function createCharacterRuntimeSnapshot(name: string): CharacterRuntimeSnapshot {
  return {
    characterId: "char-a",
    name,
    description: "",
    iconFilePath: "",
    theme: { main: "#111111", sub: "#222222" },
    definitionMarkdown: "# " + name,
    definitionSha256: name.toLowerCase(),
    definitionByteSize: name.length + 2,
    snapshotAt: name.toLowerCase(),
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
// claim = "snapshot clearを含むrunning turn開始の永続化が失敗した場合はprovider thread invalidation、provider dispatch、running audit作成を行わない"
// oracle = { type = "contract", ref = "running-turn-start-persistence#2,#5,#6,#8" }
// failure_mode = "user messageとsnapshot clearをcommitできていないturnでthread invalidationまたはprovider外部副作用だけを開始する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "有効なauthoring snapshotからnullへ遷移する開始保存のcommit failure timingを観測する"
// @end-test-value
it("snapshot clearを含むrunning turn開始の保存失敗時はthreadをinvalidateせずproviderをdispatchしない", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  let providerDispatched = false;
  let providerThreadInvalidated = false;
  let runningAuditCreated = false;
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({ ...stored, characterRuntimeSnapshot: null }),
    persistRunningTurnStart: (next) => {
      assert.equal(next.characterRuntimeSnapshot, null);
      assert.equal(next.threadId, "");
      throw new Error("running persistence failed");
    },
    invalidateProviderSessionThread: () => {
      providerThreadInvalidated = true;
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
  assert.equal(providerThreadInvalidated, false);
  assert.equal(runningAuditCreated, false);
});

// @test-value v1
// kind = "regression"
// claim = "invalid authoring snapshotはcomposer validationへnull投影するが、validation失敗時は永続化とthread invalidationを開始しない"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#Runtime-Snapshot;running-turn-start-persistence#2,#6" }
// failure_mode = "composer validationより前のsnapshot破棄をgeneric保存とthread invalidationで実行し、送信不成立でも永続状態だけ変更する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "storage commit failureではなくcomposer validationでrunning開始transactionへ到達しない経路を観測する"
// @end-test-value
it("invalid authoring snapshotはcomposerへnull投影し、validation失敗時は保存もthread invalidationもしない", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  let genericUpsertCalled = false;
  let runningStartPersisted = false;
  let providerThreadInvalidated = false;
  let providerDispatched = false;
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({ ...stored, characterRuntimeSnapshot: null }),
    resolveComposerPreview: async (resolved) => {
      assert.equal(resolved.characterRuntimeSnapshot, null);
      assert.equal(resolved.threadId, "");
      return { attachments: [], errors: ["attachment invalid"] };
    },
    persistRunningTurnStart: (next) => {
      runningStartPersisted = true;
      return next;
    },
    upsertSession: (next) => {
      genericUpsertCalled = true;
      return next;
    },
    invalidateProviderSessionThread: () => {
      providerThreadInvalidated = true;
    },
  }));

  await assert.rejects(
    service.runSessionTurn(session.id, { userMessage: "お願い" }),
    /attachment invalid/,
  );
  assert.equal(genericUpsertCalled, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerThreadInvalidated, false);
  assert.equal(providerDispatched, false);
});

// @test-value v1
// kind = "invariant"
// claim = "authoring snapshot clearのcommit成功後にthreadをinvalidateし、その後だけproviderをdispatchしてterminal保存は既存経路を使う"
// oracle = { type = "contract", ref = "running-turn-start-persistence#1,#5,#6,#8,#9;docs/design/character-storage.md#Runtime-Snapshot" }
// failure_mode = "snapshot clearのcommit前にthreadをinvalidateするか、古いthreadを保持したままproviderを開始する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "有効なsnapshotからnullへの遷移で開始commit、thread invalidation、provider、terminal generic保存の順序を観測する"
// @end-test-value
it("snapshot clearをcommitしてthreadをinvalidateした後にproviderをdispatchし、terminal状態はgeneric経路で保存する", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  const events: string[] = [];
  const adapter = createAdapter(async () => {
    events.push("provider-dispatch");
    throw new Error("provider failed");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({
      ...stored,
      characterRuntimeSnapshot: null,
    }),
    persistRunningTurnStart: (next, expectedMessageCount) => {
      assert.equal(expectedMessageCount, 0);
      assert.equal(next.characterRuntimeSnapshot, null);
      assert.equal(next.threadId, "");
      events.push("running-start-persisted");
      return next;
    },
    invalidateProviderSessionThread: (providerId, sessionId) => {
      assert.equal(providerId, session.provider);
      assert.equal(sessionId, session.id);
      events.push("provider-thread-invalidated");
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
    "provider-thread-invalidated",
    "provider-dispatch",
    "generic-terminal-error",
    "provider-thread-invalidated",
  ]);
});
