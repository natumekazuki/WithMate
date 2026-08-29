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
// claim = "invalid authoring snapshotの専用metadata transactionが失敗した場合はcomposer、thread invalidation、running開始保存、providerへ進まない"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// failure_mode = "snapshot/thread clearがcommitできていないのにvalidationまたはprovider外部副作用を開始する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "running開始transactionではなくcomposerより前の専用metadata transaction failure timingを観測する"
// @end-test-value
it("invalid authoring snapshotのmetadata clear失敗時はcomposerもthread invalidationも開始しない", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Old");
  const session = createSession({
    sessionKind: "character-authoring",
    characterRuntimeSnapshot: oldSnapshot,
    threadId: "thread-old",
  });
  let providerDispatched = false;
  let providerThreadInvalidated = false;
  let runningAuditCreated = false;
  let composerResolved = false;
  let runningStartPersisted = false;
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({ ...stored, characterRuntimeSnapshot: null }),
    clearCharacterAuthoringRuntimeState: () => {
      throw new Error("metadata clear failed");
    },
    resolveComposerPreview: async () => {
      composerResolved = true;
      return { attachments: [], errors: [] };
    },
    persistRunningTurnStart: (next) => {
      runningStartPersisted = true;
      return next;
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
    /metadata clear failed/,
  );
  assert.equal(composerResolved, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerDispatched, false);
  assert.equal(providerThreadInvalidated, false);
  assert.equal(runningAuditCreated, false);
});

// @test-value v1
// kind = "regression"
// claim = "invalid authoring snapshotは専用metadata transactionで永続clearし、thread cache無効化後のcomposer validationが失敗してもclear済み状態を維持する"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// failure_mode = "composer validation失敗時に古いsnapshotまたはprovider threadを永続状態やprocess-local cacheへ残す"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "metadata transaction failureではなく、clear commit後のcomposer validation failureとuser message非保存を観測する"
// @end-test-value
it("invalid authoring snapshotはcomposerより前に永続clearし、validation失敗後もclear済み状態を維持する", async () => {
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
  let persistedSession = session;
  const events: string[] = [];
  const adapter = createAdapter(async () => {
    providerDispatched = true;
    throw new Error("provider must not run");
  });
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    resolveRuntimeSessionForTurn: (stored) => ({ ...stored, characterRuntimeSnapshot: null }),
    clearCharacterAuthoringRuntimeState: (resolved) => {
      events.push("metadata-clear");
      persistedSession = { ...resolved, characterRuntimeSnapshot: null, threadId: "" };
      return persistedSession;
    },
    resolveComposerPreview: async (resolved) => {
      events.push("composer-validation");
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
      events.push("thread-invalidated");
    },
  }));

  await assert.rejects(
    service.runSessionTurn(session.id, { userMessage: "お願い" }),
    /attachment invalid/,
  );
  assert.equal(genericUpsertCalled, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerThreadInvalidated, true);
  assert.equal(providerDispatched, false);
  assert.equal(persistedSession.characterRuntimeSnapshot, null);
  assert.equal(persistedSession.threadId, "");
  assert.deepEqual(persistedSession.messages, []);
  assert.equal(persistedSession.runState, "idle");
  assert.deepEqual(events, ["metadata-clear", "thread-invalidated", "composer-validation"]);
});

// @test-value v1
// kind = "invariant"
// claim = "authoring snapshotの専用clear commit後にthreadをinvalidateし、composerとrunning開始保存の成功後だけproviderをdispatchする"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// failure_mode = "snapshot clearのcommit前にthreadをinvalidateするか、古いthreadを保持したままproviderを開始する"
// scope = "SessionRuntimeService.runSessionTurn"
// lifecycle = "permanent"
// distinction = "composer validation failureではなく、metadata clear、invalidation、composer、running開始、provider、terminalの成功順序を観測する"
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
    clearCharacterAuthoringRuntimeState: (resolved) => {
      events.push("metadata-clear");
      return { ...resolved, characterRuntimeSnapshot: null, threadId: "" };
    },
    resolveComposerPreview: async () => {
      events.push("composer-validation");
      return { attachments: [], errors: [] };
    },
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
    "metadata-clear",
    "provider-thread-invalidated",
    "composer-validation",
    "running-start-persisted",
    "provider-dispatch",
    "generic-terminal-error",
    "provider-thread-invalidated",
  ]);
});
