import assert from "node:assert/strict";
import { it } from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type { AuditLogEntry, ComposerPreview, LiveApprovalDecision } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { normalizeAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ProviderCodingAdapter, RunSessionTurnInput } from "../../src-electron/providers/provider-runtime.js";
import { composeProviderPrompt } from "../../src-electron/providers/provider-prompt.js";
import { refreshSessionCharacterRuntimeSnapshot } from "../../src-electron/character/character-runtime-service.js";
import { NEUTRAL_CHARACTER_ID } from "../../src-shared/character/character-owner.js";
import {
  SessionRuntimeService,
  type SessionRuntimeServiceDeps,
} from "../../src-electron/session/session-runtime-service.js";

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

const TEST_EXECUTION_OPTIONS = captureSessionExecutionOptions(createSession());

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
    invalidateProviderSessionThread: async () => undefined,
    scheduleProviderQuotaTelemetryRefresh: () => undefined,
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
    invalidateSessionThread: async () => undefined,
    invalidateAllSessionThreads: async () => undefined,
    runSessionTurn,
  };
}

// @test-value v2
// kind = "invariant"
// claim = "各送信で採用したCharacter定義を保存してからProviderへ渡し、実行中の変更は次の送信から反映する"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "更新snapshotを保存前に送る、保存時に旧定義へ戻す、または実行中に再解決して同じTurnの定義が変わる"
// observable = "Provider入力の本文とthread、送信時点の保存snapshot、次Turnの入力"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService send-time Character definition"
// lifecycle = "permanent"
// impact = "長期Sessionに古い定義が残るか、Archive後や再起動後に採用した定義を再現できない"
// distinction = "storage単体と異なり解決・保存・prompt合成・Provider dispatchを通した入力を観測する"
// @end-test-value
it("送信時snapshotを先に保存し、Turn中の定義更新は次の送信で採用する", async () => {
  const oldSnapshot = createCharacterRuntimeSnapshot("Saved");
  let canonical = { ...oldSnapshot, definitionMarkdown: "# Latest definition", definitionSha256: "latest", snapshotAt: "latest" };
  let persisted = createSession({ characterRuntimeSnapshot: oldSnapshot, threadId: "continuing-thread" });
  let resolveCount = 0;
  const prompts: string[] = [];
  const adapter = createAdapter(async (input) => {
    assert.deepEqual(input.session.characterRuntimeSnapshot, persisted.characterRuntimeSnapshot);
    assert.equal(input.session.threadId, "continuing-thread");
    const prompt = composeProviderPrompt(input);
    prompts.push(prompt.systemBodyText);
    const adoptedSnapshot = input.session.characterRuntimeSnapshot;
    canonical = { ...canonical, definitionMarkdown: "# Following definition", definitionSha256: "following", snapshotAt: "following" };
    assert.deepEqual(input.session.characterRuntimeSnapshot, adoptedSnapshot);
    return {
      threadId: "continuing-thread", assistantText: "done", logicalPrompt: prompt.logicalPrompt,
      transportPayload: null, operations: [], rawItemsJson: "[]", usage: null,
    };
  });
  adapter.composePrompt = composeProviderPrompt;
  const runtime = new SessionRuntimeService(createRuntimeDeps(persisted, adapter, {
    getSession: () => persisted,
    resolveRuntimeSessionForTurn: (session) => refreshSessionCharacterRuntimeSnapshot(session, async () => {
      resolveCount += 1;
      return canonical;
    }),
    persistRunningTurnStart: (session, expectedMessageCount) => {
      assert.equal(persisted.messages.length, expectedMessageCount);
      persisted = structuredClone(session);
      return persisted;
    },
    upsertSession: (session) => { persisted = structuredClone(session); return persisted; },
  }));
  const first = await runtime.runSessionTurn(persisted.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "first" });
  assert.equal(first.runState, "idle");
  assert.equal(first.characterRuntimeSnapshot?.definitionSha256, "latest");
  assert.equal(first.characterRuntimeSnapshot?.name, oldSnapshot.name);
  const second = await runtime.runSessionTurn(persisted.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "second" });
  assert.equal(second.runState, "idle");
  assert.equal(resolveCount, 2);
  assert.match(prompts[0]!, /Latest definition/);
  assert.doesNotMatch(prompts[0]!, /Following definition/);
  assert.match(prompts[1]!, /Following definition/);
  assert.match(prompts[1]!, /過去のTurnに含まれるCharacter定義を置き換え/);
  assert.deepEqual(second.messages.map((message) => message.text), ["first", "done", "second", "done"]);
});

// @test-value v2
// kind = "invariant"
// claim = "定義の解決または送信開始保存に失敗した場合、Providerは動かず保存済みsnapshotと会話を維持する"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "更新失敗を旧snapshotへのfallbackで隠して実行する、または保存失敗後もProviderをdispatchする"
// observable = "runSessionTurnのreject、Provider呼出数、元Sessionのsnapshotとmessages"
// observation_boundary = "consumer"
// scope = "SessionRuntimeService Character failure admission"
// lifecycle = "permanent"
// impact = "利用者が更新反映済みと誤認したまま操作を実行する"
// distinction = "CharacterStorageの例外検証ではなく送信入口からProvider副作用までの停止を検証する"
// @end-test-value
it("Character解決またはsnapshot保存の失敗を送信成功へ読み替えない", async () => {
  for (const stage of ["resolve", "persist"] as const) {
    const snapshot = createCharacterRuntimeSnapshot("Saved");
    const session = createSession({ characterRuntimeSnapshot: snapshot, threadId: "thread-kept" });
    let dispatched = 0;
    const adapter = createAdapter(async () => { dispatched += 1; throw new Error("must not dispatch"); });
    const runtime = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
      resolveRuntimeSessionForTurn: async (current) => {
        if (stage === "resolve") throw new Error("definition unavailable");
        return { ...current, characterRuntimeSnapshot: { ...snapshot, definitionMarkdown: "updated" } };
      },
      persistRunningTurnStart: () => { throw new Error("snapshot persistence failed"); },
    }));
    await assert.rejects(runtime.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "send" }),
      stage === "resolve" ? /definition unavailable/ : /snapshot persistence failed/);
    assert.equal(dispatched, 0);
    assert.deepEqual(session.characterRuntimeSnapshot, snapshot);
    assert.deepEqual(session.messages, []);
    assert.equal(session.threadId, "thread-kept");
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Characterを選ばず作成したneutral Sessionはcatalog解決なしで継続できる"
// oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
// fault = "neutralを削除済みCharacterと誤認して既存会話を使用不可にする"
// observable = "turn用Sessionとresolver呼出の有無"
// observation_boundary = "consumer"
// scope = "refreshSessionCharacterRuntimeSnapshot neutral"
// lifecycle = "permanent"
// impact = "Characterが0件の環境で作成したSessionが送信不能になる"
// distinction = "通常Characterの更新とは異なる既存neutral契約を最小のresolver境界で守る"
// @end-test-value
it("snapshotなしneutral SessionはCharacterの再解決を行わない", async () => {
  const session = createSession({ characterId: NEUTRAL_CHARACTER_ID, characterRuntimeSnapshot: null });
  assert.equal(await refreshSessionCharacterRuntimeSnapshot(session, async () => {
    throw new Error("neutral must not resolve a Character");
  }), session);
});

// @test-value v2
// kind = "invariant"
// claim = "foreground prompt context が無効な turn では timing / affect resolver を呼ばず、provider prompt へ context を渡さない"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
// fault = "表示しない context のために foreground resolver を実行し、provider prompt へ古い context を渡す"
// observable = "resolver call count と ProviderCodingAdapter.composePrompt の入力"
// observation_boundary = "consumer"
// scope = "session-runtime-prompt-context-resolution"
// lifecycle = "permanent"
// impact = "OFF設定でも不要な foreground context 取得・provider prompt への token 注入が発生する"
// distinction = "provider prompt の section omission だけでなく、turn開始時の resolver 呼び出し境界を確認する"
// @end-test-value
it("foreground prompt context が無効な turn では不要な resolver を呼ばない", async () => {
  const session = createSession();
  let timingResolverCalls = 0;
  let affectResolverCalls = 0;
  let composedInput: RunSessionTurnInput | null = null;
  const adapter: ProviderCodingAdapter = {
    ...createAdapter(async () => {
      throw new Error("provider stopped for resolver boundary test");
    }),
    composePrompt(input) {
      composedInput = input;
      return {
        systemBodyText: "system",
        inputBodyText: "input",
        logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
        imagePaths: [],
        additionalDirectories: [],
      };
    },
  };
  const service = new SessionRuntimeService(createRuntimeDeps(session, adapter, {
    getAppSettings: () => ({
      ...normalizeAppSettings({}),
      characterAffectContextEnabled: false,
      conversationTimingEnabled: false,
    }),
    resolveConversationTimingContext() {
      timingResolverCalls += 1;
      throw new Error("timing resolver must not run");
    },
    resolveCharacterContext() {
      affectResolverCalls += 1;
      throw new Error("affect resolver must not run");
    },
  }));

  const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" });

  assert.equal(result.runState, "error");
  assert.equal(timingResolverCalls, 0);
  assert.equal(affectResolverCalls, 0);
  assert.ok(composedInput);
  const composed = composedInput as RunSessionTurnInput;
  assert.equal(composed.conversationTimingContext, undefined);
  assert.equal(composed.characterContext, undefined);

  const runWithSettings = async (appSettings: ReturnType<typeof normalizeAppSettings>) => {
    let timingCalls = 0;
    let affectCalls = 0;
    let composedInput: RunSessionTurnInput | null = null;
    const timingContext = {
      observedAt: "2026-09-19T04:00:00.000+09:00",
      observedDayOfWeek: "saturday",
      currentSession: null,
      sameCharacterOtherSession: null,
      sameCharacterSharedWork: null,
    } satisfies NonNullable<RunSessionTurnInput["conversationTimingContext"]>;
    const characterContext = {
      schemaVersion: "withmate-character-context-v1",
      baseline: { definitionSha256: "sentinel-definition", snapshotAt: "2026-09-19T04:00:00.000Z" },
      affect: {
        mode: "active",
        effective: [],
        evaluatedAt: "2026-09-19T04:00:00.000Z",
        version: "sentinel-affect",
        updatedAt: null,
      },
      memory: { items: [], updatedAt: null },
    } satisfies NonNullable<RunSessionTurnInput["characterContext"]>;
    const partialAdapter: ProviderCodingAdapter = {
      ...createAdapter(async () => {
        throw new Error("provider stopped for resolver gate test");
      }),
      composePrompt(input) {
        composedInput = input;
        return {
          systemBodyText: "system",
          inputBodyText: "input",
          logicalPrompt: { systemText: "system", inputText: "input", composedText: "system\ninput" },
          imagePaths: [],
          additionalDirectories: [],
        };
      },
    };
    const partialService = new SessionRuntimeService(createRuntimeDeps(session, partialAdapter, {
      getAppSettings: () => appSettings,
      resolveConversationTimingContext() {
        timingCalls += 1;
        return timingContext;
      },
      resolveCharacterContext() {
        affectCalls += 1;
        return characterContext;
      },
    }));

    const partialResult = await partialService.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" });
    assert.equal(partialResult.runState, "error");
    assert.ok(composedInput);
    return { timingCalls, affectCalls, composedInput: composedInput! };
  };
  const timingOff = await runWithSettings({
    ...normalizeAppSettings({}),
    characterAffectContextEnabled: true,
    conversationTimingEnabled: false,
  });
  const affectOff = await runWithSettings({
    ...normalizeAppSettings({}),
    characterAffectContextEnabled: false,
    conversationTimingEnabled: true,
  });

  assert.equal(timingOff.timingCalls, 0);
  assert.equal(timingOff.affectCalls, 1);
  assert.equal((timingOff.composedInput as RunSessionTurnInput).conversationTimingContext, undefined);
  assert.equal((timingOff.composedInput as RunSessionTurnInput).characterContext?.affect.version, "sentinel-affect");
  assert.equal(affectOff.timingCalls, 1);
  assert.equal(affectOff.affectCalls, 0);
  assert.equal((affectOff.composedInput as RunSessionTurnInput).conversationTimingContext?.observedAt, "2026-09-19T04:00:00.000+09:00");
  assert.equal((affectOff.composedInput as RunSessionTurnInput).characterContext, undefined);
});

// @test-value v2
// kind = "invariant"
// claim = "invalid authoring snapshotの専用metadata transactionが失敗した場合はcomposer、thread invalidation、running開始保存、providerへ進まない"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "snapshot/thread clearがcommitできていないのにvalidationまたはprovider外部副作用を開始する"
// observable = "composer・invalidation・running保存・provider・auditの呼出フラグ"
// observation_boundary = "component-behavior"
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
    service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" }),
    /metadata clear failed/,
  );
  assert.equal(composerResolved, false);
  assert.equal(runningStartPersisted, false);
  assert.equal(providerDispatched, false);
  assert.equal(providerThreadInvalidated, false);
  assert.equal(runningAuditCreated, false);
});

// @test-value v2
// kind = "regression"
// claim = "invalid authoring snapshotは専用metadata transactionで永続clearし、thread cache無効化後のcomposer validationが失敗してもclear済み状態を維持する"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "composer validation失敗時に古いsnapshotまたはprovider threadを永続状態やprocess-local cacheへ残す"
// observable = "永続Sessionのsnapshot/thread/messages/runStateとinvalidation・provider呼出履歴"
// observation_boundary = "component-behavior"
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
    service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" }),
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

// @test-value v2
// kind = "invariant"
// claim = "authoring snapshotの専用clear commit後にthreadをinvalidateし、composerとrunning開始保存の成功後だけproviderをdispatchする"
// oracle = { type = "adr", ref = "ADR-010#Authoring-snapshot-lifecycle" }
// fault = "snapshot clearのcommit前にthreadをinvalidateするか、古いthreadを保持したままproviderを開始する"
// observable = "metadata clearからterminalまでのevent順序と保存Session"
// observation_boundary = "component-behavior"
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

  const result = await service.runSessionTurn(session.id, { executionOptions: TEST_EXECUTION_OPTIONS, userMessage: "お願い" });

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
