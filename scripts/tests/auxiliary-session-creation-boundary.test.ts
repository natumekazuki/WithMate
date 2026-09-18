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
