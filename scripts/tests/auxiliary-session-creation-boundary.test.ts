import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary-session-storage.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character-affect-turn-ownership-coordinator.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/provider-runtime-operation-coordinator.js";

function catalog(revision: number): ModelCatalogSnapshot {
  return {
    revision,
    providers: [{
      id: "codex",
      label: "Codex",
      defaultModelId: "gpt-5.4",
      defaultReasoningEffort: "high",
      models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] }],
    }],
  };
}

function character(id: string, name: string): CharacterRuntimeSnapshot {
  return {
    characterId: id,
    name,
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: `# ${name}`,
    definitionSha256: "test",
    definitionByteSize: name.length + 2,
    snapshotAt: "2026-01-01T00:00:00.000Z",
  };
}

function parent(overrides: Partial<ReturnType<typeof buildNewSession>> = {}) {
  return {
    ...buildNewSession({
      id: "parent-boundary",
      taskTitle: "boundary",
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "main-character",
      character: "Main",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: character("main-character", "Main"),
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
      codexSpeed: "standard",
      codexReviewer: "user",
      allowedAdditionalDirectories: ["C:/workspace/shared"],
    }),
    incarnationId: "incarnation-1",
    ...overrides,
  };
}

function createService(options: {
  getParent: () => ReturnType<typeof parent> | null | Promise<ReturnType<typeof parent> | null>;
  getStorage: () => AuxiliarySessionStorage;
  resolveSelection: () => Promise<ReturnType<typeof selection>>;
  getCatalog?: () => ModelCatalogSnapshot;
  listActiveCharacters?: () => readonly CharacterCatalogEntry[];
  provider: ProviderRuntimeOperationCoordinator;
  affect: CharacterAffectTurnOwnershipCoordinator;
  onCreationStateChanged?: (result: {
    status: string;
    clientRequestId: string;
    parentSessionId: string;
    generationId: string;
    auxiliarySessionId?: string;
  }) => void;
}) {
  const activeCharacters: readonly CharacterCatalogEntry[] = [{
    id: "aux-character",
    name: "Auxiliary",
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    state: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  }];
  return new AuxiliarySessionService({
    getParentSession: () => options.getParent(),
    getStorage: options.getStorage,
    resolveSessionLaunchSelection: options.resolveSelection,
    getModelCatalogSnapshot: options.getCatalog,
    runProviderRuntimeOperationExclusive: (operation) => options.provider.runExclusive(operation),
    runCharacterAffectTurnOwnershipExclusive: (operation) => options.affect.runExclusive(operation),
    listActiveCharacters: options.listActiveCharacters ?? (() => activeCharacters),
    createCharacterRuntimeSnapshot: (id) => character(id, "Auxiliary"),
    randomCharacter: () => 0,
    onCreationStateChanged: options.onCreationStateChanged,
  });
}

function selection(revision = 1) {
  return {
    provider: "codex",
    catalogRevision: revision,
    model: "gpt-5.4",
    reasoningEffort: "high" as const,
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    codexSpeed: "standard" as const,
    codexReviewer: "user" as const,
    customAgentName: "",
  };
}

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成の準備待機はprovider操作を塞がず、commit時のlatest selection/catalog変更を拒否する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "準備中にprovider操作を直列化する、または古いruntime選択を保存する"
// observable = "準備barrier中のprovider操作完了、commit拒否、保存行なし"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-creation-boundary"
// lifecycle = "permanent"
// impact = "古いprovider設定のAuxiliary保存やruntime操作の不要な待機を防ぐ"
// distinction = "型検査や既存のstorage CRUD testでは、準備とcommitの間のcoordinator境界を観測できない"
// @end-test-value
test("Auxiliary作成は準備中のprovider操作を塞がずcommit前のselection変更を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-boundary-selection-"));
  const oldStorage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let parentSession = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  const affect = new CharacterAffectTurnOwnershipCoordinator();
  let releasePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
  let preparationEntered!: () => void;
  const preparationStarted = new Promise<void>((resolve) => { preparationEntered = resolve; });
  let resolverCalls = 0;
  const service = createService({
    getParent: () => parentSession,
    getStorage: () => oldStorage,
    resolveSelection: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        preparationEntered();
        await preparation;
      }
      return selection(resolverCalls === 1 ? 1 : 2);
    },
    getCatalog: () => catalog(1),
    provider,
    affect,
  });
  try {
    const create = service.createAuxiliarySession({
      parentSessionId: parentSession.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "selection-boundary",
    });
    await preparationStarted;
    let providerOperationFinished = false;
    await provider.runExclusive(async () => { providerOperationFinished = true; });
    assert.equal(providerOperationFinished, true);
    releasePreparation();
    await assert.rejects(create, /runtime 選択が作成中に変わった/);
    assert.deepEqual(oldStorage.listAuxiliarySessions(parentSession.id), []);

    resolverCalls = 0;
    let catalogReads = 0;
    const explicitService = createService({
      getParent: () => parentSession,
      getStorage: () => oldStorage,
      resolveSelection: async () => selection(1),
      getCatalog: () => catalog(catalogReads++ === 0 ? 1 : 2),
      provider,
      affect,
    });
    await assert.rejects(
      explicitService.createAuxiliarySession({ parentSessionId: parentSession.id, provider: "codex", clientRequestId: "catalog-boundary" }),
      /runtime 選択が作成中に変わった/,
    );
    assert.deepEqual(oldStorage.listAuxiliarySessions(parentSession.id), []);
  } finally {
    oldStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成の保存前再検証失敗は確定failedとして終端し、結果不明へ昇格しない"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "保存dispatch前のruntime変更をunknown扱いにして再照会を要求する"
// observable = "failed通知、unknown通知なし、保存行なし"
// observation_boundary = "implementation"
// scope = "auxiliary-creation-commit-validation"
// lifecycle = "permanent"
// impact = "保存されていない要求を再試行不能なunknownへ固定しない"
// distinction = "runtime変更を検出してもcommit状態を先に通知する実装では保存前失敗とdispatch後不明を区別できない"
// @end-test-value
test("Auxiliary作成の保存前再検証失敗はfailedで終端する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-precommit-failure-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let selectionCalls = 0;
  const stateChanges: string[] = [];
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(++selectionCalls === 1 ? 1 : 2),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
    onCreationStateChanged: (result) => stateChanges.push(result.status),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    await assert.rejects(service.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "precommit-failure",
      creationContext: context,
    }), /runtime 選択が作成中に変わった/);
    assert.equal(stateChanges.includes("failed"), true);
    assert.equal(stateChanges.includes("unknown"), false);
    assert.deepEqual(storage.listAuxiliarySessions(currentParent.id), []);
    assert.equal((await service.getAuxiliaryCreation({ parentSessionId: currentParent.id,
      clientRequestId: "precommit-failure", creationContext: context })).status, "not-found");
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "保存済みAuxiliaryへの遅延cancelと並行queryはID付きcommittedへ収束し、古いlookup失敗で戻さず、同じ要求の再送も重複なく回復する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "遅延cancelが保存済み作成を隠す、古いlookup失敗で確定を戻す、IDなしのcommittedを返す、または確定後の取消予約が同一要求の再送を拒否する"
// observable = "並行queryと遅延cancelのID付きcommitted、lookup失敗後の通知state、回復後再送の同一ID、保存行数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-cancel-race"
// lifecycle = "permanent"
// impact = "commit先行時にrendererへ取消済みを誤通知しない"
// distinction = "cancel先着testではcommit後にregistryから消えたrequestの保存結果確認を検証しない"
// @end-test-value
test("Auxiliary作成成功後の遅延cancelはcommittedへ解決する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-late-cancel-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let releaseLookup = () => {};
  const stateChanges: string[] = [];
  const currentParent = parent();
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
    onCreationStateChanged: (result) => stateChanges.push(result.status),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "late-cancel",
      creationContext: context,
    };
    const created = await service.createAuxiliarySession(request);
    const originalList = storage.listAuxiliarySessions.bind(storage);
    for (const lookupFails of [false, true]) {
      let rejectLookup!: (error: Error) => void;
      const lookupBarrier = new Promise<void>((resolve, reject) => { releaseLookup = resolve; rejectLookup = reject; });
      let firstLookup = true;
      storage.listAuxiliarySessions = ((parentId: string) => {
        if (!firstLookup) return originalList(parentId);
        firstLookup = false;
        return lookupBarrier.then(() => originalList(parentId));
      }) as typeof storage.listAuxiliarySessions;
      const cancelling = service.cancelAuxiliaryCreation(request);
      assert.equal((await service.cancelAuxiliaryCreation(request)).status, "unknown");
      const duringLookup = service.getAuxiliaryCreation(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const committed = { status: "committed", auxiliarySessionId: created.id };
      assert.deepEqual(await service.getAuxiliaryCreation(request), committed);
      assert.deepEqual(await duringLookup, committed);
      stateChanges.length = 0;
      if (lookupFails) rejectLookup(new Error("stale lookup failed"));
      else releaseLookup();
      assert.deepEqual(await cancelling, committed);
      assert.equal(stateChanges.includes("unknown"), false);
      assert.deepEqual(await service.getAuxiliaryCreation(request), committed);
    }
    assert.deepEqual(await service.cancelAuxiliaryCreation({
      parentSessionId: request.parentSessionId,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    }), { status: "committed", auxiliarySessionId: created.id });
    assert.deepEqual(await service.getAuxiliaryCreation(request), { status: "committed", auxiliarySessionId: created.id });
    let failNextLookup = true;
    storage.listAuxiliarySessions = ((parentId: string) => {
      if (failNextLookup) {
        failNextLookup = false;
        return Promise.reject(new Error("cancel lookup unavailable"));
      }
      return originalList(parentId);
    }) as typeof storage.listAuxiliarySessions;
    assert.equal((await service.cancelAuxiliaryCreation(request)).status, "unknown");
    assert.deepEqual(await service.getAuxiliaryCreation(request), { status: "committed", auxiliarySessionId: created.id });
    assert.equal((await service.createAuxiliarySession(request)).id, created.id);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 1);
  } finally {
    releaseLookup();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "取消lookup待機中のcreateを抑止し、lookup失敗は再照会で収束し、owner失効はexpiredとして扱う"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "空のlookup結果を待つ間にcreateがregistryへ登録され、cancelが古い結果でcancelled tombstoneを作る"
// observable = "cancel結果、作成拒否、lookup失敗後の再照会とowner失効時の終端state、保存行なし"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-cancel-lookup-race"
// lifecycle = "permanent"
// impact = "遅延lookupとrenderer再送の競合で作成要求を誤って隠さない"
// distinction = "通常のcancel先着・遅延cancelではlookup await中の同一request登録を観測できない"
// @end-test-value
test("Auxiliary作成はcancelの永続化lookup中に割り込んだcreateと競合しても収束する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-cancel-lookup-race-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let releaseLookup!: () => void;
  const lookupBarrier = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let lookupStarted!: () => void;
  const lookupStartedPromise = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const originalList = storage.listAuxiliarySessions.bind(storage);
  let lookupCalls = 0;
  storage.listAuxiliarySessions = ((parentSessionId: string) => {
    lookupCalls += 1;
    if (lookupCalls === 1) {
      lookupStarted();
      return lookupBarrier.then(() => []);
    }
    return originalList(parentSessionId);
  }) as typeof storage.listAuxiliarySessions;
  const stateChanges: string[] = [];
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
    onCreationStateChanged: (result) => {
      stateChanges.push(result.status);
    },
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "cancel-lookup-race",
      creationContext: context,
    };
    const cancel = service.cancelAuxiliaryCreation(request);
    await lookupStartedPromise;
    const create = service.createAuxiliarySession(request);
    const createError = create.catch((error) => error);
    releaseLookup();
    assert.deepEqual(await cancel, { status: "cancelled" });
    assert.match(String(await createError), /取消結果を確認中|取り消し済み/);
    assert.equal(stateChanges.includes("cancelled"), true);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
    for (const releaseOwner of [false, true]) {
      const recoveryRequest = { ...request, clientRequestId: `lookup-failure-${releaseOwner}`,
        creationContext: await service.getAuxiliaryCreationContext(currentParent.id) };
      let rejectLookup!: (error: Error) => void;
      const failingLookup = new Promise<never>((_resolve, reject) => { rejectLookup = reject; });
      let firstLookup = true;
      storage.listAuxiliarySessions = ((parentId: string) => {
        if (!firstLookup) return originalList(parentId);
        firstLookup = false;
        return failingLookup;
      }) as typeof storage.listAuxiliarySessions;
      const cancelling = service.cancelAuxiliaryCreation(recoveryRequest);
      if (releaseOwner) service.releaseAuxiliaryCreationOwner(currentParent.id);
      rejectLookup(new Error("lookup unavailable"));
      assert.equal((await cancelling).status, releaseOwner ? "expired" : "unknown");
      assert.equal((await service.getAuxiliaryCreation(recoveryRequest)).status, releaseOwner ? "expired" : "cancelled");
      await assert.rejects(service.createAuxiliarySession(recoveryRequest), releaseOwner ? /creation context が期限切れ/ : /取り消し済み/);
      assert.equal(originalList(currentParent.id).length, 0);
    }
  } finally {
    releaseLookup();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成のcancel先着はcommit前の同一要求をtombstoneで拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "cancel受付前に作成を開始する、またはcancel後の同一要求を再実行する"
// observable = "取消結果、作成拒否、保存行なし"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-lifecycle"
// lifecycle = "permanent"
// impact = "late create responseによる二重作成を防ぐ"
// distinction = "通常の作成成功testではcancel先着と未作成要求のtombstoneを観測できない"
// @end-test-value
test("Auxiliary作成のcancel先着は未作成要求をtombstoneで拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-cancel-first-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const provider = new ProviderRuntimeOperationCoordinator();
  const affect = new CharacterAffectTurnOwnershipCoordinator();
  let releaseParent!: () => void;
  const parentBarrier = new Promise<void>((resolve) => { releaseParent = resolve; });
  let blockParent = false;
  const currentParent = parent();
  const stateChanges: Array<{ status: string; clientRequestId: string; parentSessionId: string; generationId: string }> = [];
  const service = createService({
    getParent: async () => {
      if (blockParent) await parentBarrier;
      return currentParent;
    },
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider,
    affect,
    onCreationStateChanged: (result) => stateChanges.push(result),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "cancel-first",
      creationContext: context,
    };
    blockParent = true;
    const creation = service.createAuxiliarySession(request);
    await Promise.resolve();
    const cancelled = await service.cancelAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(stateChanges.map((change) => change.status), ["preparing", "cancelled"]);
    assert.equal(stateChanges.every((change) => change.clientRequestId === request.clientRequestId), true);
    assert.equal(stateChanges.every((change) => change.parentSessionId === request.parentSessionId), true);
    assert.equal(stateChanges.every((change) => change.generationId === context.generationId), true);
    releaseParent();
    await assert.rejects(creation, /取り消した/);
    await assert.rejects(service.createAuxiliarySession(request), /取り消し済み/);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "永続化lookup中にcancelされたAuxiliary作成要求はregistryへ再登録されず、同一要求を二重作成しない"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "lookup完了後にcancel tombstoneを上書きする、または同一requestの並行createを二重commitする"
// observable = "lookup barrier中のcancel結果、両createの拒否、保存行数0"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-lookup-race"
// lifecycle = "permanent"
// impact = "renderer再送とcancelの競合による孤児Auxiliaryを防ぐ"
// distinction = "親取得barrierだけでは永続化lookup後のregistry再確認を検証できない"
// @end-test-value
test("Auxiliary作成はpersisted lookup中のcancelと並行createを安全に収束する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-lookup-race-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  const affect = new CharacterAffectTurnOwnershipCoordinator();
  let releaseLookup!: () => void;
  const lookupBarrier = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let lookupCalls = 0;
  const originalList = storage.listAuxiliarySessions.bind(storage);
  storage.listAuxiliarySessions = ((parentSessionId: string) => {
    lookupCalls += 1;
    return lookupCalls <= 2
      ? lookupBarrier.then(() => originalList(parentSessionId))
      : originalList(parentSessionId);
  }) as typeof storage.listAuxiliarySessions;
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider,
    affect,
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "lookup-cancel-race",
      creationContext: context,
    };
    const first = service.createAuxiliarySession(request);
    const second = service.createAuxiliarySession(request);
    while (lookupCalls < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    const cancelled = await service.cancelAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    });
    assert.equal(cancelled.status, "cancelled");
    releaseLookup();
    await assert.rejects(first, /取り消し/);
    await assert.rejects(second, /取り消し/);
    assert.equal((await originalList(currentParent.id)).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "unknownのAuxiliary作成結果はDB確定までregistryに保持し、後からcommit済み行を再発見した時だけcommittedへ解決する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "unknownをregistryから回収して同一requestを再実行可能にする、または遅延commit済み行を見失う"
// observable = "DB未検出queryのunknown、同じclientRequestIdの後発行検出時のcommittedとID"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-unknown-recovery"
// lifecycle = "permanent"
// impact = "commit結果不明時の二重作成と孤児化を防ぐ"
// distinction = "通常のcommit成功・失敗testではDB未検出からcommit確定へ遷移するqueryを観測できない"
// @end-test-value
test("Auxiliary作成のunknownはDB未検出後も保持し、後発commitをqueryで解決する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-unknown-recovery-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const originalUpsert = storage.upsertAuxiliarySession.bind(storage);
  let captured: Parameters<typeof storage.upsertAuxiliarySession>[0] | null = null;
  storage.upsertAuxiliarySession = ((session) => {
    captured = session;
    originalUpsert(session);
    throw new Error("commit result lost after SQLite write");
  }) as typeof storage.upsertAuxiliarySession;
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "unknown-recovery",
      creationContext: context,
    };
    await assert.rejects(service.createAuxiliarySession(request), /commit result lost/);
    assert.ok(captured);
    storage.deleteAuxiliarySessionsForParent(currentParent.id);
    assert.deepEqual(await service.getAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    }), { status: "unknown" });
    storage.upsertAuxiliarySession = originalUpsert as typeof storage.upsertAuxiliarySession;
    storage.upsertAuxiliarySession(captured);
    assert.deepEqual(await service.getAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    }), { status: "committed", auxiliarySessionId: captured.id });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成は同一request IDの同一入力だけをdedupeし異なる入力を拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "異なる入力を既存作成へ結合する、または同一入力を二重保存する"
// observable = "一致するparentSessionId・provider・runtimeSelectionでの同一結果IDと、provider差異エラー"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-lifecycle"
// lifecycle = "permanent"
// impact = "再送の安全性とclientRequestId契約を維持する"
// distinction = "既存の再送testではrequest ID再利用時の入力差異を検証しない"
// @end-test-value
test("Auxiliary作成は同一request IDの異なる入力を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-request-input-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "input-conflict",
      creationContext: context,
    };
    const first = service.createAuxiliarySession(request);
    const second = service.createAuxiliarySession(request);
    assert.equal((await first).id, (await second).id);
    await assert.rejects(
      service.createAuxiliarySession({ ...request, provider: "other" }),
      /異なる入力/,
    );
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 1);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成のowner解放は旧generationのcommitを失効させる"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "閉じたownerまたは置換前の親へ作成結果を書き込む"
// observable = "旧作成の拒否、generation変更、保存行なし"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-generation"
// lifecycle = "permanent"
// impact = "window close/reopen後の遅延作成による別scope汚染を防ぐ"
// distinction = "通常の親identity testではowner解放によるgeneration失効を確認しない"
// @end-test-value
test("Auxiliary作成のowner解放は旧generationを失効させる", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-generation-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let currentParent = parent();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const service = createService({
    getParent: async () => { await barrier; return currentParent; },
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  try {
    const context = await (async () => {
      const original = currentParent;
      currentParent = original;
      release();
      return service.getAuxiliaryCreationContext(original.id);
    })();
    const resolvedContext = await context;
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "owner-release",
      creationContext: resolvedContext,
    };
    const creation = service.createAuxiliarySession(request);
    service.releaseAuxiliaryCreationOwner(currentParent.id);
    await assert.rejects(creation);
    assert.notEqual((await service.getAuxiliaryCreationContext(currentParent.id)).generationId, resolvedContext.generationId);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成は保存済みclientRequestIdを新Serviceからqueryして再送結果を回収する"
// oracle = { type = "contract", ref = "src-electron/auxiliary-session-service.ts" }
// fault = "応答消失後にcommit済み行を見失い、同一要求を二重作成する"
// observable = "新Serviceのqueryがcommit済みsession IDを返す"
// observation_boundary = "public-boundary"
// scope = "auxiliary-creation-reconnect"
// lifecycle = "permanent"
// impact = "renderer応答消失時の安全な再接続を可能にする"
// distinction = "process内dedupe testではService再生成後の保存結果lookupを確認しない"
// @end-test-value
test("Auxiliary作成はService再生成後も保存済みclientRequestIdをqueryできる", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-reconnect-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const options = {
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  };
  try {
    const firstService = createService(options);
    const context = await firstService.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "reconnect-result",
      creationContext: context,
    };
    const created = await firstService.createAuxiliarySession(request);
    const restarted = createService(options);
    const result = await restarted.getAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    });
    assert.deepEqual(result, { status: "committed", auxiliarySessionId: created.id });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成は準備中に交換された親storageを読み書きせず、親のincarnation/Character変更と保存を競合させない"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "閉じた旧storageへcommitし、置き換え後の親やCharacterを古いsnapshotで保存する"
// observable = "storage交換・親identity変更時のreject、旧storageのclose後も例外種別が契約エラーであること、保存行なし"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-creation-boundary"
// lifecycle = "permanent"
// impact = "旧DBへの書込みと親に紐づかないAuxiliary作成を防ぐ"
// distinction = "通常の作成成功testではcommit中のstorage/parent交換を観測できない"
// @end-test-value
test("Auxiliary作成はcommit前のstorage・親identity交換を拒否する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-boundary-storage-"));
  const first = new AuxiliarySessionStorage(path.join(directory, "first.db"));
  const second = new AuxiliarySessionStorage(path.join(directory, "second.db"));
  const third = new AuxiliarySessionStorage(path.join(directory, "third.db"));
  let currentStorage = first;
  let currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  const affect = new CharacterAffectTurnOwnershipCoordinator();
  let releaseInitialParent!: () => void;
  const initialParent = new Promise<void>((resolve) => { releaseInitialParent = resolve; });
  let initialParentEntered!: () => void;
  const initialParentStarted = new Promise<void>((resolve) => { initialParentEntered = resolve; });
  let parentReads = 0;
  const initialCreateService = createService({
    getParent: async () => {
      parentReads += 1;
      if (parentReads === 1) {
        initialParentEntered();
        await initialParent;
      }
      return currentParent;
    },
    getStorage: () => currentStorage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider,
    affect,
  });
  try {
    const create = initialCreateService.createAuxiliarySession({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session", clientRequestId: "storage-boundary-initial-read" });
    await initialParentStarted;
    currentStorage = second;
    first.close();
    releaseInitialParent();
    await assert.rejects(create, /保存先が作成中に切り替わった/);
    assert.deepEqual(second.listAuxiliarySessions(currentParent.id), []);

    currentStorage = second;
    parentReads = 0;
    const commitStorageService = createService({
      getParent: async () => {
        parentReads += 1;
        if (parentReads === 2) {
          commitParentEntered();
          await commitParent;
        }
        return currentParent;
      },
      getStorage: () => currentStorage,
      resolveSelection: async () => selection(),
      getCatalog: () => catalog(1),
      provider,
      affect,
    });
    let releaseCommitParent!: () => void;
    const commitParent = new Promise<void>((resolve) => { releaseCommitParent = resolve; });
    let commitParentEntered!: () => void;
    const commitParentStarted = new Promise<void>((resolve) => { commitParentEntered = resolve; });
    currentStorage = third;
    const commitCreate = commitStorageService.createAuxiliarySession({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session", clientRequestId: "storage-boundary-commit-read" });
    await commitParentStarted;
    currentStorage = second;
    third.close();
    releaseCommitParent();
    await assert.rejects(commitCreate, /保存先が作成中に切り替わった/);
    assert.deepEqual(second.listAuxiliarySessions(currentParent.id), []);

    const incarnationBefore = parent({ incarnationId: "incarnation-before", characterId: "stable-character", character: "Stable", characterRuntimeSnapshot: character("stable-character", "Stable") });
    currentParent = incarnationBefore;
    let releaseIncarnation!: () => void;
    const incarnationBarrier = new Promise<void>((resolve) => { releaseIncarnation = resolve; });
    let incarnationRead = 0;
    const incarnationService = createService({
      getParent: async () => {
        incarnationRead += 1;
        if (incarnationRead === 2) {
          incarnationEntered();
          await incarnationBarrier;
        }
        return currentParent;
      },
      getStorage: () => second,
      resolveSelection: async () => selection(),
      getCatalog: () => catalog(1),
      provider,
      affect,
    });
    let incarnationEntered!: () => void;
    const incarnationStarted = new Promise<void>((resolve) => { incarnationEntered = resolve; });
    const incarnationCreate = incarnationService.createAuxiliarySession({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session", clientRequestId: "incarnation-boundary" });
    await incarnationStarted;
    currentParent = parent({ incarnationId: "incarnation-after", characterId: "stable-character", character: "Stable", characterRuntimeSnapshot: character("stable-character", "Stable") });
    releaseIncarnation();
    await assert.rejects(incarnationCreate, /親セッションが作成中に置き換わった/);

    const characterBefore = parent({ incarnationId: "character-incarnation", characterId: "character-before", character: "Before", characterRuntimeSnapshot: character("character-before", "Before") });
    currentParent = characterBefore;
    let releaseCharacter!: () => void;
    const characterBarrier = new Promise<void>((resolve) => { releaseCharacter = resolve; });
    let characterReads = 0;
    const characterService = createService({
      getParent: async () => {
        characterReads += 1;
        if (characterReads === 2) {
          characterEntered();
          await characterBarrier;
        }
        return currentParent;
      },
      getStorage: () => second,
      resolveSelection: async () => selection(),
      getCatalog: () => catalog(1),
      provider,
      affect,
    });
    let characterEntered!: () => void;
    const characterStarted = new Promise<void>((resolve) => { characterEntered = resolve; });
    const characterCreate = characterService.createAuxiliarySession({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session", clientRequestId: "character-identity-boundary" });
    await characterStarted;
    currentParent = parent({ incarnationId: "character-incarnation", characterId: "character-after", character: "After", characterRuntimeSnapshot: character("character-after", "After") });
    releaseCharacter();
    await assert.rejects(characterCreate, /親セッションが作成中に置き換わった/);

    currentParent = parent({ incarnationId: "active-character-incarnation", characterId: "main-character", character: "Main", characterRuntimeSnapshot: character("main-character", "Main") });
    let characterIsActive = true;
    let resolveCalls = 0;
    let releaseCharacterSelection!: () => void;
    const characterSelection = new Promise<void>((resolve) => { releaseCharacterSelection = resolve; });
    let characterSelectionEntered!: () => void;
    const characterSelectionStarted = new Promise<void>((resolve) => { characterSelectionEntered = resolve; });
    const activeCharacterService = createService({
      getParent: () => currentParent,
      getStorage: () => second,
      resolveSelection: async () => {
        resolveCalls += 1;
        if (resolveCalls === 2) {
          characterSelectionEntered();
          await characterSelection;
        }
        return selection();
      },
      getCatalog: () => catalog(1),
      listActiveCharacters: () => characterIsActive ? [{
        id: "aux-character",
        name: "Auxiliary",
        description: "",
        iconFilePath: "",
        theme: { main: "#6f8cff", sub: "#6fb8c7" },
        state: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      }] : [],
      provider,
      affect,
    });
    const activeCharacterCreate = activeCharacterService.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "character-active-boundary",
    });
    await characterSelectionStarted;
    characterIsActive = false;
    releaseCharacterSelection();
    await assert.rejects(activeCharacterCreate, /Character が作成中に利用できなくなった/);
    assert.deepEqual(second.listAuxiliarySessions(currentParent.id), []);
  } finally {
    first.close();
    second.close();
    third.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliary作成commitは同一親identityの最新speed/reviewer/directoriesを保存し、同一clientRequestIdの並行再送を一行へ収束する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "準備時の親設定を保存する、または並行再送で複数rowを作る"
// observable = "保存済みAuxiliaryの親設定、並行結果の同一ID、clientRequestId別のrow数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-creation-boundary"
// lifecycle = "permanent"
// impact = "ユーザーが変更した実行設定を失わず、再送による重複セッションを防ぐ"
// distinction = "既存の単独作成testではcommit直前の親更新と並行再送の収束を同時に検出できない"
// @end-test-value
test("Auxiliary作成commitは最新親設定を保存し同一clientRequestIdを収束する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-boundary-idempotency-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  const affect = new CharacterAffectTurnOwnershipCoordinator();
  let resolverCalls = 0;
  let releaseResolver!: () => void;
  const resolverBarrier = new Promise<void>((resolve) => { releaseResolver = resolve; });
  let resolverEntered!: () => void;
  const resolverStarted = new Promise<void>((resolve) => { resolverEntered = resolve; });
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        resolverEntered();
        await resolverBarrier;
      }
      return selection();
    },
    getCatalog: () => catalog(1),
    provider,
    affect,
  });
  try {
    const request = { parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session" as const, clientRequestId: "same-request" };
    const first = service.createAuxiliarySession(request);
    await resolverStarted;
    currentParent = parent({
      codexSpeed: "fast",
      codexReviewer: "auto-review",
      allowedAdditionalDirectories: ["C:/new-directory"],
    });
    releaseResolver();
    const second = service.createAuxiliarySession(request);
    const [createdA, createdB] = await Promise.all([first, second]);
    assert.equal(createdA.id, createdB.id);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 1);
    const saved = storage.getAuxiliarySession(createdA.id);
    assert.equal(saved?.codexSpeed, "fast");
    assert.equal(saved?.codexReviewer, "auto-review");
    assert.deepEqual(saved?.allowedAdditionalDirectories, ["C:/new-directory"]);
    assert.equal(saved?.clientRequestId, "same-request");
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
