import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character/character-affect-turn-ownership-coordinator.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";

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
  getCatalog?: () => ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
  listActiveCharacters?: () => readonly CharacterCatalogEntry[];
  createCharacterRuntimeSnapshot?: (id: string) => CharacterRuntimeSnapshot | null | Promise<CharacterRuntimeSnapshot | null>;
  randomCharacter?: () => number;
  provider: ProviderRuntimeOperationCoordinator;
  affect: CharacterAffectTurnOwnershipCoordinator;
  onCreationStateChanged?: (result: {
    status: string;
    clientRequestId: string;
    parentSessionId: string;
    generationId: string;
    auxiliarySessionId?: string;
  }) => void;
  rememberExecutionOptions?: (session: AuxiliarySessionSummary, options: SessionExecutionOptions) => void;
  overlayCurrentExecutionOptions?: <T extends AuxiliarySessionSummary>(session: T) => T;
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
    createCharacterRuntimeSnapshot: options.createCharacterRuntimeSnapshot ?? ((id) => character(id, "Auxiliary")),
    randomCharacter: options.randomCharacter ?? (() => 0),
    onCreationStateChanged: options.onCreationStateChanged,
    rememberExecutionOptions: options.rememberExecutionOptions,
    overlayCurrentExecutionOptions: options.overlayCurrentExecutionOptions,
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

function characterCandidates(): CharacterCatalogEntry[] {
  return ["main-character", "archived-character", "aux-a", "aux-b", "aux-c"].map((id) => ({
    id,
    name: "Same display name",
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    state: id === "archived-character" ? "archived" : "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: id === "archived-character" ? "2026-01-01T00:00:00.000Z" : null,
  }));
}

// @test-value v2
// kind = "contract"
// claim = "Claude Auxiliaryのexplicit作成は非対応approvalを保存前に拒否し、省略時はon-requestで作成する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "共通enumだけを検証してClaude非対応値を永続化するかClaude既定値を変更する"
// observable = "createAuxiliarySessionのreject、SQLiteの作成件数と保存approvalMode"
// observation_boundary = "public-boundary"
// scope = "auxiliary-explicit-claude-approval"
// lifecycle = "permanent"
// impact = "見かけ上正常な新規Auxiliaryが送信不能になることを防ぐ"
// distinction = "共通enumや送信時validationでは作成APIが保存前に拒否することを保証できず、短い実DB確認で維持する"
// @end-test-value
test("Claude Auxiliaryは非対応approvalを保存せず既定on-requestで作成する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-claude-approval-"));
  const sessionStorage = new SessionStorageV6(path.join(directory, "app.db"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const main = parent({ characterRuntimeSnapshot: null });
  const snapshot = catalog(1);
  snapshot.providers[0] = { ...snapshot.providers[0]!, id: "claude", label: "Claude" };
  const service = createService({
    getParent: () => main,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => snapshot,
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  try {
    sessionStorage.upsertSession(main);
    for (const approvalMode of ["untrusted", "never"] as const) {
      await assert.rejects(service.createAuxiliarySession({
        parentSessionId: main.id, provider: "claude", runtimeSelection: "explicit", approvalMode,
      }), /approval mode is not supported by this provider/);
      assert.deepEqual(storage.listAuxiliarySessions(main.id), []);
    }
    const created = await service.createAuxiliarySession({
      parentSessionId: main.id, provider: "claude", runtimeSelection: "explicit",
    });
    assert.equal(created.approvalMode, "on-request");
    assert.equal(storage.getAuxiliarySession(created.id)?.approvalMode, "on-request");
  } finally {
    storage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "新規Auxiliaryは同じ親の保存済みactive/closed CharacterをIDで避け、枯渇時だけMain以外で重複できる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "表示名・他の親の使用状況を除外に使う、closedを無視する、または枯渇時に作成を拒否する"
// observable = "作成結果のCharacter ID列、再取得した既存会話・snapshot・draft・threadの一致"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-selection"
// lifecycle = "permanent"
// impact = "再表示可能な会話との不要な重複と、Character数による作成制限を防ぐ"
// distinction = "既存のMain除外testでは親別の保存済み使用状況と枯渇境界を検証できず、短い実DB testで保持する"
// @end-test-value
test("Auxiliary Characterは同じ親の保存済み使用状況を優先し枯渇時に重複を許可する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-character-usage-"));
  const sessionStorage = new SessionStorageV6(path.join(directory, "app.db"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const main = parent({ characterRuntimeSnapshot: null });
  let currentParent = parent({ id: "other-parent", characterRuntimeSnapshot: null });
  let random = 0.99;
  const options = {
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    listActiveCharacters: characterCandidates,
    randomCharacter: () => random,
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  };
  let service = createService(options);
  const create = () => service.createAuxiliarySession({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session" });
  try {
    sessionStorage.upsertSession(main);
    sessionStorage.upsertSession(currentParent);
    const other = await create();
    assert.equal(other.characterId, "aux-c");
    const preservedOther = storage.getAuxiliarySession(other.id);
    currentParent = main;
    random = 0;
    const first = await create();
    assert.equal(first.characterId, "aux-a");
    storage.upsertAuxiliarySession({ ...first, threadId: "keep-thread", messages: [{ role: "user", text: "keep conversation" }] });
    const draft = await service.getAuxiliaryDraft(first.id);
    assert.ok(draft);
    assert.equal((await service.saveAuxiliaryDraft({ auxiliarySessionId: first.id, parentSessionId: main.id, incarnation: draft.incarnation, expectedDurableRevision: draft.durableRevision, text: "keep draft", updatedAt: "2026-10-03T00:00:00.000Z" })).outcome, "saved");
    await service.closeAuxiliarySession(first.id);
    const preserved = storage.getAuxiliarySession(first.id);
    assert.equal(preserved?.status, "closed");
    assert.equal(preserved?.composerDraft, "keep draft");
    const second = await create();
    assert.equal(second.characterId, "aux-b");
    assert.equal(second.runState, "idle");
    const preservedSecond = storage.getAuxiliarySession(second.id);

    service = createService(options);
    const third = await create();
    assert.equal(third.characterId, "aux-c");
    random = 0.99;
    assert.equal((await create()).characterId, "aux-c");
    random = 0;
    assert.equal((await create()).characterId, "aux-a");
    assert.equal(storage.listAuxiliarySessions(main.id).length, 5);
    assert.deepEqual(storage.getAuxiliarySession(first.id), preserved);
    assert.deepEqual(storage.getAuxiliarySession(second.id), preservedSecond);
    assert.deepEqual(storage.getAuxiliarySession(other.id), preservedOther);
  } finally {
    storage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同じ候補から並行準備したAuxiliaryはcommit時に再選択し、未使用候補を使い切るまで重複せず保存する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "古い使用状況のまま並行要求を保存する、再選択したIDとsnapshotを混同する、または同一要求の再送を増殖させる"
// observable = "並行作成のID・Character ID・snapshot ID、保存行数、再送結果の同一ID"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-commit-race"
// lifecycle = "permanent"
// impact = "同時追加でも未使用Character優先と既存のrequest冪等性を維持する"
// distinction = "逐次選択testでは生じない同一snapshot準備の競合をbarrierと実coordinatorで再現し、小さい実DBで検証する"
// @end-test-value
test("Auxiliary並行作成は未使用Characterを確定し枯渇後も作成を継続する", async () => {
  for (const mode of ["context", "request-id", "no-request-id"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-character-race-"));
    const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
    const gate = Promise.withResolvers<void>();
    let initialSnapshots = 0;
    const service = createService({
      getParent: parent,
      getStorage: () => storage,
      resolveSelection: async () => selection(),
      listActiveCharacters: characterCandidates,
      createCharacterRuntimeSnapshot: async (id) => {
        if (id === "aux-a" && initialSnapshots < 3) {
          initialSnapshots += 1;
          if (initialSnapshots === 3) gate.resolve();
          await gate.promise;
        }
        return character(id, id);
      },
      provider: new ProviderRuntimeOperationCoordinator(),
      affect: new CharacterAffectTurnOwnershipCoordinator(),
    });
    try {
      const creationContext = mode === "context" ? await service.getAuxiliaryCreationContext(parent().id) : undefined;
      const inputs = [0, 1, 2].map((index) => ({
        parentSessionId: parent().id,
        provider: "codex",
        runtimeSelection: "latest-session" as const,
        ...(mode !== "no-request-id" ? { clientRequestId: `parallel-${index}` } : {}),
        ...(creationContext ? { creationContext } : {}),
      }));
      const created = await Promise.all(inputs.map((input) => service.createAuxiliarySession(input)));
      assert.equal(initialSnapshots, 3);
      assert.equal(new Set(created.map((session) => session.id)).size, 3);
      assert.deepEqual(created.map((session) => session.characterId).sort(), ["aux-a", "aux-b", "aux-c"]);
      for (const session of created) {
        assert.equal(session.characterRuntimeSnapshot?.characterId, session.characterId);
        const stored = storage.getAuxiliarySession(session.id);
        assert.equal(stored?.characterId, session.characterId);
        assert.deepEqual(stored?.characterRuntimeSnapshot, session.characterRuntimeSnapshot);
      }
      if (mode !== "no-request-id") {
        assert.equal((await service.createAuxiliarySession(inputs[0]!)).id, created[0]!.id);
      }
      const exhausted = await service.createAuxiliarySession({ ...inputs[0]!, clientRequestId: "exhausted" });
      assert.equal(exhausted.characterId, "aux-a");
      assert.equal(storage.listAuxiliarySessions(parent().id).length, 4);
    } finally {
      gate.resolve();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "未使用Characterへのsnapshot再準備は広域排他を塞がず、取消・snapshot失敗・親やstorageや設定やcatalogの変更時は保存しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "再準備をcoordinator内で待つ、再試行が最終検証を省略する、または保存前失敗をunknownや成功にする"
// observable = "再準備中のprovider/ownership操作完了、作成拒否、状態通知、既存行の一致と保存件数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-repreparation-boundary"
// lifecycle = "permanent"
// impact = "重複回避の再試行が取消や保存ownerを破り孤児会話を作ることを防ぐ"
// distinction = "初回準備の境界testでは通らない再準備経路を決定的barrierで検証し、少数の実DB操作で安全条件を保つ"
// @end-test-value
test("Auxiliary Character再準備は排他を解放し取消と保存前の再検証を維持する", async () => {
  for (const failure of ["snapshot", "cancel", "owner", "parent", "storage", "runtime", "archive"] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-character-reprepare-"));
    const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
    const replacement = new AuxiliarySessionStorage(path.join(directory, "replacement.db"));
    let currentStorage = storage;
    let currentParent = parent();
    let revision = 1;
    let entries = characterCandidates();
    const provider = new ProviderRuntimeOperationCoordinator();
    const affect = new CharacterAffectTurnOwnershipCoordinator();
    const firstSnapshots = Promise.withResolvers<void>();
    const repreparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let snapshotCount = 0;
    const changes: Array<{ clientRequestId: string; status: string }> = [];
    const service = createService({
      getParent: () => currentParent,
      getStorage: () => currentStorage,
      resolveSelection: async () => selection(revision),
      listActiveCharacters: () => entries,
      createCharacterRuntimeSnapshot: async (id) => {
        if (id === "aux-a") {
          snapshotCount += 1;
          if (snapshotCount === 2) firstSnapshots.resolve();
          await firstSnapshots.promise;
        } else {
          repreparing.resolve();
          await release.promise;
          if (failure === "snapshot") return null;
        }
        return character(id, id);
      },
      provider,
      affect,
      onCreationStateChanged: (change) => { changes.push(change); },
    });
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const creationContext = await service.getAuxiliaryCreationContext(currentParent.id);
      const inputs = ["first", "second"].map((clientRequestId) => ({ parentSessionId: currentParent.id, provider: "codex", runtimeSelection: "latest-session" as const, clientRequestId, creationContext }));
      settled = Promise.allSettled(inputs.map((input) => service.createAuxiliarySession(input)));
      await repreparing.promise;
      const preserved = storage.listAllAuxiliarySessions();
      assert.equal(preserved.length, 1);
      const pendingInput = inputs.find((input) => input.clientRequestId !== preserved[0]!.clientRequestId)!;
      await provider.runExclusive(() => affect.runExclusive(async () => {
        if (failure === "cancel") assert.equal((await service.cancelAuxiliaryCreation(pendingInput)).status, "cancelled");
        if (failure === "owner") service.releaseAuxiliaryCreationOwner(currentParent.id);
        if (failure === "parent") currentParent = parent({ incarnationId: "replacement-parent" });
        if (failure === "storage") currentStorage = replacement;
        if (failure === "runtime") revision = 2;
        if (failure === "archive") entries = entries.filter((entry) => entry.id !== "aux-b");
      }));
      release.resolve();
      const results = await settled;
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.match(String(rejected.reason), failure === "snapshot" ? /Character snapshot could not be created/ : /creation was canceled/);
      assert.equal(changes.filter((change) => change.clientRequestId === pendingInput.clientRequestId).at(-1)?.status,
        failure === "cancel" ? "cancelled" : failure === "owner" ? "expired" : "failed");
      assert.deepEqual(storage.listAllAuxiliarySessions(), preserved);
      assert.equal(replacement.listAuxiliarySessions(parent().id).length, 0);
    } finally {
      firstSnapshots.resolve();
      release.resolve();
      await settled;
      storage.close();
      replacement.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Main除外後にactive候補がない場合と不一致snapshotの場合はAuxiliary作成を失敗させる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "Mainやarchived Characterへ置換して成功にする、または別Characterのsnapshotを保存する"
// observable = "作成拒否のエラーと保存行数0"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-selection-failure"
// lifecycle = "permanent"
// impact = "意図しないCharacter identityで会話を開始することを防ぐ"
// distinction = "既存のnull snapshot testにない候補0とidentity不一致を小さい実DBで検証する"
// @end-test-value
test("AuxiliaryはMain以外の候補0とsnapshot identity不一致を成功扱いしない", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-character-unavailable-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let entries = characterCandidates().filter((entry) => !entry.id.startsWith("aux-"));
  const service = createService({
    getParent: parent,
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    listActiveCharacters: () => entries,
    createCharacterRuntimeSnapshot: () => character("main-character", "Main"),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  try {
    const creationContext = await service.getAuxiliaryCreationContext(parent().id);
    const input = { parentSessionId: parent().id, provider: "codex", runtimeSelection: "latest-session" as const, creationContext };
    await assert.rejects(service.createAuxiliarySession({ ...input, clientRequestId: "no-candidate" }), /No Character is available/);
    entries = characterCandidates();
    await assert.rejects(service.createAuxiliarySession({ ...input, clientRequestId: "invalid-snapshot" }), /Character snapshot could not be created/);
    assert.equal(storage.listAuxiliarySessions(parent().id).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await assert.rejects(create, /Auxiliary Session creation was canceled because its runtime selection changed during creation/);
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
      /Auxiliary Session creation was canceled because its runtime selection changed during creation/,
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
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
    }), /Auxiliary Session creation was canceled because its runtime selection changed during creation/);
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
// claim = "保存済みAuxiliaryへの遅延cancelと並行queryは、別要求の取消回収による世代更新や古いlookup失敗をまたいでもID付きcommittedへ収束する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
      assert.equal((await service.cancelAuxiliaryCreation({
        ...request,
        clientRequestId: `retire-during-lookup-${lookupFails}`,
      })).status, "cancelled");
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
      request.creationContext = await service.getAuxiliaryCreationContext(currentParent.id);
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
    assert.equal((await service.cancelAuxiliaryCreation({
      ...request,
      clientRequestId: "retire-before-recovery-query",
    })).status, "cancelled");
    assert.deepEqual(await service.getAuxiliaryCreation(request), { status: "committed", auxiliarySessionId: created.id });
    assert.deepEqual(await service.cancelAuxiliaryCreation(request), { status: "committed", auxiliarySessionId: created.id });
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
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
    assert.match(String(await createError), /Auxiliary Session creation cancellation is still being confirmed/);
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
      await assert.rejects(service.createAuxiliarySession(recoveryRequest), /The Auxiliary Session creation context has expired/);
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
// claim = "Auxiliary作成のcancel先着はcommitを止め、処理終了後はレコードを回収して旧世代の同一要求を拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
// fault = "cancel受付前に作成を開始する、またはcancel後の同一要求を再実行する"
// observable = "取消結果、作成拒否、保存行なし、処理終了後のcreationRecords件数"
// observation_boundary = "implementation"
// scope = "auxiliary-creation-lifecycle"
// lifecycle = "permanent"
// impact = "取消要求の蓄積によるMainのメモリ増加と、late create responseによる不要な作成を防ぐ"
// distinction = "型検査やstorage CRUDでは観測できないcancel後の非同期settlementとレコード解放を、短いbarrier付き実DB testで継続検証する"
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
    await assert.rejects(creation, /Auxiliary Session creation was canceled/);
    assert.equal((service as unknown as { creationRecords: Map<string, unknown> }).creationRecords.size, 0);
    await assert.rejects(service.createAuxiliarySession(request), /The Auxiliary Session creation context has expired/);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "永続化lookup中にcancelされたAuxiliary作成要求はregistryへ再登録されず、同一要求を二重作成しない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
    await assert.rejects(first, /The Auxiliary Session creation context has expired/);
    await assert.rejects(second, /The Auxiliary Session creation context has expired/);
    assert.equal((await originalList(currentParent.id)).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "unknownのAuxiliary作成結果はDB確定までregistryに保持し、後からcommit済み行を再発見した時だけcommittedへ解決する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
    const committed: Parameters<typeof storage.upsertAuxiliarySession>[0] = captured!;
    storage.deleteAuxiliarySessionsForParent(currentParent.id);
    assert.deepEqual(await service.getAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    }), { status: "unknown" });
    storage.upsertAuxiliarySession = originalUpsert as typeof storage.upsertAuxiliarySession;
    storage.upsertAuxiliarySession(committed);
    assert.deepEqual(await service.getAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    }), { status: "committed", auxiliarySessionId: committed.id });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成は同一request IDの同一入力だけをdedupeし異なる入力を拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
      /same Auxiliary creation request ID cannot be used with different input/,
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
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
  const currentParent = parent();
  let releaseSelection!: () => void;
  const selectionBarrier = new Promise<void>((resolve) => { releaseSelection = resolve; });
  let selectionStarted!: () => void;
  const selectionReached = new Promise<void>((resolve) => { selectionStarted = resolve; });
  let preparingStarted!: () => void;
  const preparingReached = new Promise<void>((resolve) => { preparingStarted = resolve; });
  const stateChanges: string[] = [];
  const service = createService({
    getParent: () => currentParent,
    getStorage: () => storage,
    resolveSelection: async () => {
      selectionStarted();
      await selectionBarrier;
      return selection();
    },
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
    onCreationStateChanged: (result) => {
      stateChanges.push(result.status);
      if (result.status === "preparing") preparingStarted();
    },
  });
  try {
    const resolvedContext = await service.getAuxiliaryCreationContext(currentParent.id);
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "owner-release",
      creationContext: resolvedContext,
    };
    const creation = service.createAuxiliarySession(request);
    await preparingReached;
    await selectionReached;
    service.releaseAuxiliaryCreationOwner(currentParent.id);
    releaseSelection();
    await assert.rejects(creation, /Auxiliary Session creation was canceled/);
    assert.deepEqual(stateChanges, ["preparing", "expired"]);
    assert.notEqual((await service.getAuxiliaryCreationContext(currentParent.id)).generationId, resolvedContext.generationId);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
  } finally {
    releaseSelection();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成は保存済みclientRequestIdを新Serviceからqueryして再送結果を回収する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
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
    await assert.rejects(create, /Auxiliary Session creation was canceled because its storage changed during creation/);
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
    await assert.rejects(commitCreate, /Auxiliary Session creation was canceled because its storage changed during creation/);
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
    await assert.rejects(incarnationCreate, /Auxiliary Session creation was canceled because its parent session changed during creation/);

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
    await assert.rejects(characterCreate, /Auxiliary Session creation was canceled because its parent session changed during creation/);

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
    await assert.rejects(activeCharacterCreate, /Auxiliary Session creation was canceled because its Character became unavailable/);
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

// @test-value v2
// kind = "invariant"
// claim = "異なるIDの未作成取消を繰り返しても終端レコードは増えず、旧世代の遅延createを拒否し登録済みの別要求と新しい作成は継続できる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Runtime Model（取消済み作成レコードの回収）" }
// fault = "取消済みレコードを蓄積する、回収後に取消済み要求を保存する、または世代更新で登録済みの別要求を取り消す"
// observable = "creationRecords件数、unknownからcancelledへの再照会、旧要求の作成拒否、別要求と新contextの保存結果"
// observation_boundary = "implementation"
// scope = "auxiliary-creation-cancellation-retention"
// lifecycle = "permanent"
// impact = "長時間稼働するMainのメモリ増加と、取消済み会話の復活・無関係な作成の中断を防ぐ"
// distinction = "型・buildや単発の取消testでは蓄積と受付世代切替の影響を観測できない。時刻待ちなしの有限回ループと一つの実DBで資源回収契約を検証する"
// @end-test-value
test("Auxiliaryの取消レコードは回収し、遅延要求を拒否して登録済み要求を維持する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-cancel-retention-"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let blockNextParent = false;
  let releaseParent!: () => void;
  const parentBarrier = new Promise<void>((resolve) => { releaseParent = resolve; });
  let parentEntered!: () => void;
  const parentStarted = new Promise<void>((resolve) => { parentEntered = resolve; });
  const originalList = storage.listAuxiliarySessions.bind(storage);
  const service = createService({
    getParent: async () => {
      if (blockNextParent) {
        blockNextParent = false;
        parentEntered();
        await parentBarrier;
      }
      return currentParent;
    },
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => catalog(1),
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
  });
  const records = (service as unknown as { creationRecords: Map<string, unknown> }).creationRecords;
  let creation: ReturnType<AuxiliarySessionService["createAuxiliarySession"]> | undefined;
  try {
    const admittedRequest = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "already-admitted",
      creationContext: await service.getAuxiliaryCreationContext(currentParent.id),
    };
    blockNextParent = true;
    creation = service.createAuxiliarySession(admittedRequest);
    void creation.catch(() => {});
    await parentStarted;
    for (let index = 0; index < 64; index += 1) {
      const request = {
        ...admittedRequest,
        clientRequestId: `cancel-without-create-${index}`,
        creationContext: await service.getAuxiliaryCreationContext(currentParent.id),
      };
      if (index % 2 === 1) {
        storage.listAuxiliarySessions = () => { throw new Error("lookup unavailable"); };
        assert.equal((await service.cancelAuxiliaryCreation(request)).status, "unknown");
        assert.equal(records.size, 2);
        storage.listAuxiliarySessions = originalList;
        assert.equal((await service.getAuxiliaryCreation(request)).status, "cancelled");
      } else {
        assert.equal((await service.cancelAuxiliaryCreation(request)).status, "cancelled");
      }
      assert.equal(records.size, 1);
      assert.equal((await service.getAuxiliaryCreation(request)).status, "expired");
      await assert.rejects(service.createAuxiliarySession(request), /The Auxiliary Session creation context has expired/);
      assert.equal((await service.getAuxiliaryCreation(admittedRequest)).status, "preparing");
    }
    releaseParent();
    const created = await creation;
    assert.equal(created.clientRequestId, admittedRequest.clientRequestId);
    assert.equal(records.size, 0);
    const next = await service.createAuxiliarySession({
      ...admittedRequest,
      clientRequestId: "fresh-request",
      creationContext: await service.getAuxiliaryCreationContext(currentParent.id),
    });
    assert.notEqual(next.id, created.id);
    assert.equal(records.size, 0);
    assert.equal(originalList(currentParent.id).length, 2);
  } finally {
    releaseParent();
    storage.listAuxiliarySessions = originalList;
    await creation?.catch(() => {});
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryの軽量変更は履歴を再読込せず、実行中の確定messageのbookmarkを更新でき、失敗や遅延検証・checkpointの後も最後の実行設定選択を保持する"
// oracle = { type = "contract", ref = "Auxiliary current execution selection and narrow mutation boundary" }
// fault = "軽量変更が全履歴をhydrationする、実行中のbookmarkを拒否する、または失敗・遅延検証・checkpointで現在選択を消す"
// observable = "title/bookmark保存結果とservice summary・storageの実行設定"
// observation_boundary = "component-behavior"
// scope = "auxiliary-narrow-mutations"
// lifecycle = "permanent"
// impact = "大量履歴の読み込み遅延または次Turnで旧model選択の実行を招く"
// distinction = "保存値だけを見るstorage testではserviceのhydration境界とmemory選択を検出できない"
// @end-test-value
test("Auxiliary軽量変更は全履歴を読まずcheckpoint失敗後も現在選択を保持する", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-auxiliary-narrow-mutation-"));
  const dbPath = path.join(directory, "app.db");
  const sessionStorage = new SessionStorageV6(dbPath);
  sessionStorage.upsertSession(parent({ characterId: "", characterRuntimeSnapshot: null }));
  const storage = new AuxiliarySessionStorage(dbPath);
  const selected = new Map<string, SessionExecutionOptions>();
  let delayNextCatalog = false;
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
  let catalogEntered!: () => void;
  const catalogStarted = new Promise<void>((resolve) => { catalogEntered = resolve; });
  const service = createService({
    getParent: () => parent(),
    getStorage: () => storage,
    resolveSelection: async () => selection(),
    getCatalog: () => {
      if (delayNextCatalog) {
        delayNextCatalog = false;
        catalogEntered();
        return catalogGate.then(() => catalog(1));
      }
      return catalog(1);
    },
    provider: new ProviderRuntimeOperationCoordinator(),
    affect: new CharacterAffectTurnOwnershipCoordinator(),
    rememberExecutionOptions: (session, options) => { selected.set(session.id, options); },
    overlayCurrentExecutionOptions: (session) => {
      const options = selected.get(session.id);
      return options ? { ...session, ...options } : session;
    },
  });
  const originalGet = storage.getAuxiliarySession.bind(storage);
  const originalCheckpoint = storage.updateAuxiliaryExecutionOptionsIfMatches.bind(storage);
  try {
    const created = await service.createAuxiliarySession({ parentSessionId: parent().id, provider: "codex" });
    storage.upsertAuxiliarySession({ ...created, messages: [{ role: "user", text: "question" }] });
    storage.getAuxiliarySession = () => { throw new Error("full Auxiliary hydration is forbidden"); };
    const identity = { auxiliarySessionId: created.id, parentSessionId: created.parentSessionId, createdAt: created.createdAt };
    await service.setAuxiliaryTitle({ ...identity, title: "renamed" });
    await service.setAuxiliaryMessageBookmark({ ...identity, messageIndex: 0, isBookmarked: true });
    const chosen: SessionExecutionOptions = {
      catalogRevision: 1, model: "gpt-5.4", reasoningEffort: "medium",
      approvalMode: created.approvalMode, codexSandboxMode: created.codexSandboxMode,
      codexSpeed: created.codexSpeed, codexReviewer: created.codexReviewer,
      customAgentName: created.customAgentName,
    };
    storage.updateAuxiliaryExecutionOptionsIfMatches = () => { throw new Error("checkpoint unavailable"); };
    assert.deepEqual(await service.setAuxiliaryExecutionOptions({ ...identity, executionOptions: chosen }), {
      status: "accepted", checkpointSaved: false,
    });
    assert.equal((await service.getAuxiliarySessionSummary(created.id))?.reasoningEffort, "medium");
    assert.equal((await service.getAuxiliarySessionSummary(created.id))?.title, "renamed");
    storage.getAuxiliarySession = originalGet;
    assert.equal(storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked, true);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let checkpointCount = 0;
    storage.updateAuxiliaryExecutionOptionsIfMatches = (async (input: Parameters<typeof originalCheckpoint>[0]) => {
      checkpointCount += 1;
      if (checkpointCount === 1) {
        firstEntered();
        await firstGate;
      }
      return originalCheckpoint(input);
    }) as unknown as typeof storage.updateAuxiliaryExecutionOptionsIfMatches;
    const earlier = service.setAuxiliaryExecutionOptions({ ...identity, executionOptions: { ...chosen, reasoningEffort: "high" } });
    await firstStarted;
    const later = service.setAuxiliaryExecutionOptions({ ...identity, executionOptions: chosen });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await service.getAuxiliarySessionSummary(created.id))?.reasoningEffort, "medium");
    releaseFirst();
    await Promise.all([earlier, later]);
    assert.equal(storage.getAuxiliarySession(created.id)?.reasoningEffort, "medium");

    storage.updateAuxiliaryExecutionOptionsIfMatches = originalCheckpoint;
    delayNextCatalog = true;
    const stale = service.setAuxiliaryExecutionOptions({ ...identity, executionOptions: { ...chosen, reasoningEffort: "high" } });
    await catalogStarted;
    await service.setAuxiliaryExecutionOptions({ ...identity, executionOptions: chosen });
    releaseCatalog();
    assert.deepEqual(await stale, { status: "superseded" });
    assert.equal(storage.getAuxiliarySession(created.id)?.reasoningEffort, "medium");

    storage.upsertAuxiliarySession({ ...storage.getAuxiliarySession(created.id)!, runState: "running" });
    await service.setAuxiliaryMessageBookmark({ ...identity, messageIndex: 0, isBookmarked: false });
    assert.equal(storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked, undefined);
    await service.setAuxiliaryMessageBookmark({ ...identity, messageIndex: 0, isBookmarked: true });
    assert.equal(storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked, true);
    await assert.rejects(service.setAuxiliaryExecutionOptions({
      ...identity,
      executionOptions: { ...chosen, approvalMode: "never" },
    }), /A running Auxiliary Session cannot change these execution options/);
    assert.equal(selected.get(created.id)?.approvalMode, chosen.approvalMode);
  } finally {
    releaseCatalog();
    storage.getAuxiliarySession = originalGet;
    storage.updateAuxiliaryExecutionOptionsIfMatches = originalCheckpoint;
    storage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
