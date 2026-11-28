import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import type {
  CharacterCatalogEntry,
  CharacterRuntimeSnapshot,
} from "../../src-shared/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  captureSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { AuxiliarySessionService } from "../../src-electron/auxiliary/auxiliary-session-service.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";

/** Codexのモデルと選択可能な推論レベルを持つ最小のカタログを作る。 */
function catalog(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            reasoningEfforts: ["medium", "high"],
          },
        ],
      },
    ],
  };
}

/** 指定IDを保持し、表示名から定義本文を区別できるCharacter snapshotを作る。 */
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

/** 親のincarnation、Character、設定を定義し、境界ケースごとに必要な項目を上書きする。 */
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

/** 実Auxiliaryサービスへ独立したストレージとCoordinatorを接続し、準備中の依存をケースごとに制御する。 */
function createService(options: {
  getParent: () =>
    | ReturnType<typeof parent>
    | null
    | Promise<ReturnType<typeof parent> | null>;
  getStorage: () => AuxiliarySessionStorage;
  resolveSelection: () => Promise<ReturnType<typeof selection>>;
  getCatalog?: () => ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
  listActiveCharacters?: () => readonly CharacterCatalogEntry[];
  createCharacterRuntimeSnapshot?: (
    id: string,
  ) =>
    CharacterRuntimeSnapshot | null | Promise<CharacterRuntimeSnapshot | null>;
  randomCharacter?: () => number;
  provider: ProviderRuntimeOperationCoordinator;
  onCreationStateChanged?: (result: {
    status: string;
    clientRequestId: string;
    parentSessionId: string;
    generationId: string;
    auxiliarySessionId?: string;
  }) => void;
  rememberExecutionOptions?: (
    session: AuxiliarySessionSummary,
    options: SessionExecutionOptions,
  ) => void;
  overlayCurrentExecutionOptions?: <T extends AuxiliarySessionSummary>(
    session: T,
  ) => T;
}) {
  const activeCharacters: readonly CharacterCatalogEntry[] = [
    {
      id: "aux-character",
      name: "Auxiliary",
      description: "",
      iconFilePath: "",
      theme: { main: "#6f8cff", sub: "#6fb8c7" },
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
    },
  ];
  return new AuxiliarySessionService({
    /** 親の再取得をケースの依存へ転送し、準備中の親の交換を模擬できるようにする。 */
    getParentSession: () => options.getParent(),
    getStorage: options.getStorage,
    resolveSessionLaunchSelection: options.resolveSelection,
    getModelCatalogSnapshot: options.getCatalog,
    /** 保存境界が使う排他を、ケース側からも操作できるCoordinatorと共有する。 */
    runProviderRuntimeOperationExclusive: (operation) =>
      options.provider.runExclusive(operation),
    listActiveCharacters:
      options.listActiveCharacters ?? (() => activeCharacters),
    createCharacterRuntimeSnapshot:
      options.createCharacterRuntimeSnapshot ??
      ((id) => character(id, "Auxiliary")),
    randomCharacter: options.randomCharacter ?? (() => 0),
    onCreationStateChanged: options.onCreationStateChanged,
    rememberExecutionOptions: options.rememberExecutionOptions,
    overlayCurrentExecutionOptions: options.overlayCurrentExecutionOptions,
  });
}

/** 実行条件の捕捉に使う既定のCodex選択を組み立てる。 */
function selection() {
  return {
    provider: "codex",
    model: "gpt-5.4",
    reasoningEffort: "high" as const,
    approvalMode: DEFAULT_APPROVAL_MODE,
    codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    codexSpeed: "standard" as const,
    codexReviewer: "user" as const,
    customAgentName: "",
  };
}

/** 表示名を同じにして親・休止済み・利用可能な候補をIDだけで区別できるようにする。 */
function characterCandidates(): CharacterCatalogEntry[] {
  return [
    "main-character",
    "archived-character",
    "aux-a",
    "aux-b",
    "aux-c",
  ].map((id) => ({
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
// claim = "Claude Auxiliaryは有効な承認方針だけ保存し、Reviewerを伴う変更は確認済みの場合に一括保存する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#approval-modes" }
// fault = "非対応や未確認の組合せを保存するか、確認済み変更を保存できない"
// observable = "作成・更新APIのrejectとACK、SQLiteの作成件数・保存approvalMode・codexReviewer"
// observation_boundary = "public-boundary"
// scope = "auxiliary-explicit-claude-approval"
// lifecycle = "permanent"
// impact = "見かけ上正常な新規Auxiliaryが送信不能になることを防ぐ"
// distinction = "共通enumや送信時validationでは作成APIが保存前に拒否することを保証できず、短い実DB確認で維持する"
// @end-test-value
/** Claudeで非対応の承認方針を保存せず、確認を伴うReviewer変更だけを原子的に反映することを確かめる。 */
test("Claude Auxiliaryは非対応approvalを保存せず既定on-requestで作成する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-claude-approval-"),
  );
  const sessionStorage = new SessionStorageV6(path.join(directory, "app.db"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let main = parent({ characterRuntimeSnapshot: null });
  const snapshot = catalog();
  snapshot.providers[0] = {
    ...snapshot.providers[0]!,
    id: "claude",
    label: "Claude",
  };
  const service = createService({
    /** 承認方針の変更前後で現在の親を参照する。 */
    getParent: () => main,
    /** 承認方針が永続化されたかを照会できる実Auxiliaryストレージを渡す。 */
    getStorage: () => storage,
    /** 比較に使う親由来の実行設定を既定値へ固定する。 */
    resolveSelection: async () => selection(),
    /** Claude向けの承認対応を検証できるカタログを渡す。 */
    getCatalog: () => snapshot,
    provider: new ProviderRuntimeOperationCoordinator(),
  });
  try {
    sessionStorage.upsertSession(main);
    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: main.id,
        provider: "claude",
        runtimeSelection: "explicit",
        approvalMode: "untrusted",
      }),
      /approval mode is not supported by this provider/,
    );
    assert.deepEqual(storage.listAuxiliarySessions(main.id), []);
    for (const approvalMode of [
      "never",
      "on-request",
      "accept-edits",
      "dont-ask",
      "plan",
    ] as const) {
      const supported = await service.createAuxiliarySession({
        parentSessionId: main.id,
        provider: "claude",
        runtimeSelection: "explicit",
        approvalMode,
      });
      const restored = storage.getAuxiliarySession(supported.id);
      assert.equal(restored?.approvalMode, approvalMode);
      assert.equal(restored?.codexReviewer, "user");
    }
    const created = await service.createAuxiliarySession({
      parentSessionId: main.id,
      provider: "claude",
      runtimeSelection: "explicit",
    });
    assert.equal(created.approvalMode, "on-request");
    assert.equal(
      storage.getAuxiliarySession(created.id)?.approvalMode,
      "on-request",
    );
    /** 同じ保存済みAuxiliaryへ承認方針とReviewerを送り、確認前の方針も指定できるようにする。 */
    const update = (
      approvalMode: SessionExecutionOptions["approvalMode"],
      codexReviewer: SessionExecutionOptions["codexReviewer"],
      previousApprovalMode?: SessionExecutionOptions["approvalMode"],
    ) =>
      service.setAuxiliaryExecutionOptions({
        auxiliarySessionId: created.id,
        parentSessionId: main.id,
        createdAt: created.createdAt,
        executionOptions: {
          ...captureSessionExecutionOptions(created),
          approvalMode,
          codexReviewer,
        },
        ...(previousApprovalMode
          ? { confirmedReviewerChange: { previousApprovalMode } }
          : {}),
      });
    assert.deepEqual(await update("on-request", "auto-review"), {
      status: "accepted",
      checkpointSaved: true,
    });
    assert.equal(
      storage.getAuxiliarySession(created.id)?.codexReviewer,
      "auto-review",
    );
    main = { ...main, codexReviewer: "auto-review" };
    const countBefore = storage.listAuxiliarySessions(main.id).length;
    for (const approvalMode of ["accept-edits", "dont-ask", "plan"] as const) {
      await assert.rejects(
        service.createAuxiliarySession({
          parentSessionId: main.id,
          provider: "claude",
          runtimeSelection: "explicit",
          approvalMode,
        }),
        /reviewer is not supported with this approval mode/,
      );
      assert.equal(storage.listAuxiliarySessions(main.id).length, countBefore);
    }
    for (const approvalMode of ["on-request", "never"] as const) {
      const inherited = await service.createAuxiliarySession({
        parentSessionId: main.id,
        provider: "claude",
        runtimeSelection: "explicit",
        approvalMode,
      });
      assert.equal(
        storage.getAuxiliarySession(inherited.id)?.approvalMode,
        approvalMode,
      );
      assert.equal(
        storage.getAuxiliarySession(inherited.id)?.codexReviewer,
        "auto-review",
      );
    }
    await assert.rejects(
      update("plan", "auto-review"),
      /reviewer is not supported with this approval mode/,
    );
    assert.equal(
      storage.getAuxiliarySession(created.id)?.approvalMode,
      "on-request",
    );
    await update("never", "auto-review");
    await assert.rejects(
      update("plan", "user"),
      /reviewer is not supported with this approval mode/,
    );
    assert.equal(
      storage.getAuxiliarySession(created.id)?.approvalMode,
      "never",
    );
    assert.equal(
      storage.getAuxiliarySession(created.id)?.codexReviewer,
      "auto-review",
    );
    await assert.rejects(
      update("plan", "user", "on-request"),
      /no longer valid/,
    );
    assert.equal(
      storage.getAuxiliarySession(created.id)?.approvalMode,
      "never",
    );
    assert.deepEqual(await update("plan", "user", "never"), {
      status: "accepted",
      checkpointSaved: true,
    });
    assert.equal(storage.getAuxiliarySession(created.id)?.approvalMode, "plan");
    assert.equal(
      storage.getAuxiliarySession(created.id)?.codexReviewer,
      "user",
    );
  } finally {
    storage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "新規Auxiliaryは同じ親の保存済みCharacterをIDで避け、枯渇時だけMain以外で重複できる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "表示名・他の親の使用状況を除外に使う、非表示会話を無視する、または枯渇時に作成を拒否する"
// observable = "作成結果のCharacter ID列、再取得した既存会話・snapshot・draft・threadの一致"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-selection"
// lifecycle = "permanent"
// impact = "再表示可能な会話との不要な重複と、Character数による作成制限を防ぐ"
// distinction = "既存のMain除外testでは親別の保存済み使用状況と枯渇境界を検証できず、短い実DB testで保持する"
// @end-test-value
/** 同じ親の永続会話は非表示でも使用済みと見なし、未使用候補が尽きたときだけ親以外の重複を許す。 */
test("Auxiliary Characterは同じ親の保存済み使用状況を優先し枯渇時に重複を許可する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-character-usage-"),
  );
  const sessionStorage = new SessionStorageV6(path.join(directory, "app.db"));
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const main = parent({ characterRuntimeSnapshot: null });
  let currentParent = parent({
    id: "other-parent",
    characterRuntimeSnapshot: null,
  });
  let random = 0.99;
  const options = {
    /** 親を切り替えるケースでも最新の親を返す。 */
    getParent: () => currentParent,
    /** 同じDB上の既存会話を対象に候補を選び直せるようにする。 */
    getStorage: () => storage,
    /** Character選び以外の実行条件を揃える。 */
    resolveSelection: async () => selection(),
    listActiveCharacters: characterCandidates,
    /** 枯渇後の抽選結果を比較できるように値を切り替える。 */
    randomCharacter: () => random,
    provider: new ProviderRuntimeOperationCoordinator(),
  };
  let service = createService(options);
  /** 現在の親と同じ実行条件で新たなAuxiliaryの作成を呼ぶ。 */
  const create = () =>
    service.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
    });
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
    storage.upsertAuxiliarySession({
      ...first,
      threadId: "keep-thread",
      messages: [{ role: "user", text: "keep conversation" }],
    });
    const draft = await service.getAuxiliaryDraft(first.id);
    assert.ok(draft);
    assert.equal(
      (
        await service.saveAuxiliaryDraft({
          auxiliarySessionId: first.id,
          parentSessionId: main.id,
          incarnation: draft.incarnation,
          expectedDurableRevision: draft.durableRevision,
          text: "keep draft",
          updatedAt: "2026-10-03T00:00:00.000Z",
        })
      ).outcome,
      "saved",
    );
    const preserved = storage.getAuxiliarySession(first.id);
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
/** 同じ候補を準備した並行要求を保存時に再選定し、別々のIDと対応するsnapshotを割り当てる。 */
test("Auxiliary並行作成は未使用Characterを確定し枯渇後も作成を継続する", async () => {
  for (const mode of ["context", "request-id", "no-request-id"] as const) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-auxiliary-character-race-"),
    );
    const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
    const gate = Promise.withResolvers<void>();
    let initialSnapshots = 0;
    const service = createService({
      getParent: parent,
      /** 並行要求の使用状況を一つの永続ストレージへ集約する。 */
      getStorage: () => storage,
      /** 要求間でモデルや推論レベルを変えず、Character競合に絞る。 */
      resolveSelection: async () => selection(),
      listActiveCharacters: characterCandidates,
      /** 全要求が同じ最初の候補を選ぶまでsnapshot解決を待たせ、再選定後のIDはそのまま返す。 */
      createCharacterRuntimeSnapshot: async (id) => {
        if (id === "aux-a" && initialSnapshots < 3) {
          initialSnapshots += 1;
          if (initialSnapshots === 3) gate.resolve();
          await gate.promise;
        }
        return character(id, id);
      },
      provider: new ProviderRuntimeOperationCoordinator(),
    });
    try {
      const creationContext =
        mode === "context"
          ? await service.getAuxiliaryCreationContext(parent().id)
          : undefined;
      const inputs = [0, 1, 2].map((index) => ({
        parentSessionId: parent().id,
        provider: "codex",
        runtimeSelection: "latest-session" as const,
        ...(mode !== "no-request-id"
          ? { clientRequestId: `parallel-${index}` }
          : {}),
        ...(creationContext ? { creationContext } : {}),
      }));
      const created = await Promise.all(
        inputs.map((input) => service.createAuxiliarySession(input)),
      );
      assert.equal(initialSnapshots, 3);
      assert.equal(new Set(created.map((session) => session.id)).size, 3);
      assert.deepEqual(created.map((session) => session.characterId).sort(), [
        "aux-a",
        "aux-b",
        "aux-c",
      ]);
      for (const session of created) {
        assert.equal(
          session.characterRuntimeSnapshot?.characterId,
          session.characterId,
        );
        const stored = storage.getAuxiliarySession(session.id);
        assert.equal(stored?.characterId, session.characterId);
        assert.deepEqual(
          stored?.characterRuntimeSnapshot,
          session.characterRuntimeSnapshot,
        );
      }
      if (mode !== "no-request-id") {
        assert.equal(
          (await service.createAuxiliarySession(inputs[0]!)).id,
          created[0]!.id,
        );
      }
      const exhausted = await service.createAuxiliarySession({
        ...inputs[0]!,
        clientRequestId: "exhausted",
      });
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
// claim = "未使用Characterへのsnapshot再準備は広域排他を塞がず、取消・snapshot失敗・親やstorageやCharacterの変更時は保存しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#character-identity" }
// fault = "再準備をcoordinator内で待つ、再試行が最終検証を省略する、または保存前失敗をunknownや成功にする"
// observable = "再準備中のprovider操作完了、作成拒否、状態通知、既存行の一致と保存件数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-character-repreparation-boundary"
// lifecycle = "permanent"
// impact = "重複回避の再試行が取消や保存ownerを破り孤児会話を作ることを防ぐ"
// distinction = "初回準備の境界testでは通らない再準備経路を決定的barrierで検証し、少数の実DB操作で安全条件を保つ"
// @end-test-value
/** 候補再準備中も別操作が排他を使え、取消や依存変更後に未確定の会話を保存しないことを確認する。 */
test("Auxiliary Character再準備は排他を解放し取消と保存前の再検証を維持する", async () => {
  for (const failure of [
    "snapshot",
    "cancel",
    "owner",
    "parent",
    "storage",
    "archive",
  ] as const) {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "withmate-auxiliary-character-reprepare-"),
    );
    const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
    const replacement = new AuxiliarySessionStorage(
      path.join(directory, "replacement.db"),
    );
    let currentStorage = storage;
    let currentParent = parent();
    let entries = characterCandidates();
    const provider = new ProviderRuntimeOperationCoordinator();
    const firstSnapshots = Promise.withResolvers<void>();
    const repreparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let snapshotCount = 0;
    const changes: Array<{ clientRequestId: string; status: string }> = [];
    const service = createService({
      /** 再準備を待つ間に親を取り替えられるようにする。 */
      getParent: () => currentParent,
      /** 保存前にストレージ実体を交換した場合が観測できるようにする。 */
      getStorage: () => currentStorage,
      /** 再準備では実行モデルの解決結果を変えない。 */
      resolveSelection: async () => selection(),
      /** 選択した候補が準備中にカタログから外れた状態を返せるようにする。 */
      listActiveCharacters: () => entries,
      /** 最初は同じ候補に競合させ、再選定後は障害発生までsnapshotを保留する。 */
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
      /** 再準備失敗がどの終端へ通知されたかを、要求IDとともに記録する。 */
      onCreationStateChanged: (change) => {
        changes.push(change);
      },
    });
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const creationContext = await service.getAuxiliaryCreationContext(
        currentParent.id,
      );
      const inputs = ["first", "second"].map((clientRequestId) => ({
        parentSessionId: currentParent.id,
        provider: "codex",
        runtimeSelection: "latest-session" as const,
        clientRequestId,
        creationContext,
      }));
      settled = Promise.allSettled(
        inputs.map((input) => service.createAuxiliarySession(input)),
      );
      await repreparing.promise;
      const preserved = storage.listAllAuxiliarySessions();
      assert.equal(preserved.length, 1);
      const pendingInput = inputs.find(
        (input) => input.clientRequestId !== preserved[0]!.clientRequestId,
      )!;
      await provider.runExclusive(async () => {
        if (failure === "cancel")
          assert.equal(
            (await service.cancelAuxiliaryCreation(pendingInput)).status,
            "cancelled",
          );
        if (failure === "owner")
          service.releaseAuxiliaryCreationOwner(currentParent.id);
        if (failure === "parent")
          currentParent = parent({ incarnationId: "replacement-parent" });
        if (failure === "storage") currentStorage = replacement;
        if (failure === "archive")
          entries = entries.filter((entry) => entry.id !== "aux-b");
      });
      release.resolve();
      const results = await settled;
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.match(
        String(rejected.reason),
        failure === "snapshot"
          ? /Character snapshot could not be created/
          : /creation was canceled/,
      );
      assert.equal(
        changes
          .filter(
            (change) => change.clientRequestId === pendingInput.clientRequestId,
          )
          .at(-1)?.status,
        failure === "cancel"
          ? "cancelled"
          : failure === "owner"
            ? "expired"
            : "failed",
      );
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
/** 親を除いた候補が空、または選択したIDとsnapshotが不一致なら保存しないことを確認する。 */
test("AuxiliaryはMain以外の候補0とsnapshot identity不一致を成功扱いしない", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-character-unavailable-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let entries = characterCandidates().filter(
    (entry) => !entry.id.startsWith("aux-"),
  );
  const service = createService({
    getParent: parent,
    /** 失敗後に保存行が残っていないかを観測する実ストレージを渡す。 */
    getStorage: () => storage,
    /** 候補不在とsnapshot不一致を、同じ実行選択で比較する。 */
    resolveSelection: async () => selection(),
    /** 休止済みを含めて、ケースで設定した候補データを返す。 */
    listActiveCharacters: () => entries,
    /** 選んだ子のIDとは異なる親Characterのsnapshotを意図的に返す。 */
    createCharacterRuntimeSnapshot: () => character("main-character", "Main"),
    provider: new ProviderRuntimeOperationCoordinator(),
  });
  try {
    const creationContext = await service.getAuxiliaryCreationContext(
      parent().id,
    );
    const input = {
      parentSessionId: parent().id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      creationContext,
    };
    await assert.rejects(
      service.createAuxiliarySession({
        ...input,
        clientRequestId: "no-candidate",
      }),
      /No Character is available/,
    );
    entries = characterCandidates();
    await assert.rejects(
      service.createAuxiliarySession({
        ...input,
        clientRequestId: "invalid-snapshot",
      }),
      /Character snapshot could not be created/,
    );
    assert.equal(storage.listAuxiliarySessions(parent().id).length, 0);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成の準備待機はprovider操作を塞がず、取得した選択を保存まで保持する"
// oracle = { type = "contract", ref = "accepted behavior: discovery updates preserve captured selections" }
// fault = "準備中にprovider操作を直列化する、または取得したruntime選択を再取得で置換する"
// observable = "準備barrier中のprovider操作完了、作成結果のmodelとdepth"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-creation-boundary"
// lifecycle = "permanent"
// impact = "作成中にmodelが勝手に変わることやruntime操作の不要な待機を防ぐ"
// distinction = "型検査や既存のstorage CRUD testでは、準備とcommitの間のcoordinator境界を観測できない"
// @end-test-value
/** 準備中も別のProvider操作を進められ、最初に捕捉したモデルと深度を再解決で置き換えないことを確認する。 */
test("Auxiliary作成は準備中のprovider操作を塞がずcaptured選択を保存する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-boundary-selection-"),
  );
  const oldStorage = new AuxiliarySessionStorage(
    path.join(directory, "app.db"),
  );
  let parentSession = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  let releasePreparation!: () => void;
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let preparationEntered!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    preparationEntered = resolve;
  });
  let resolverCalls = 0;
  const service = createService({
    /** 準備と保存で同じ親を参照する。 */
    getParent: () => parentSession,
    /** 捕捉した実行条件の保存先を固定する。 */
    getStorage: () => oldStorage,
    /** 一回目の解決だけを止め、仮に再取得した場合は別モデルになるようにする。 */
    resolveSelection: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        preparationEntered();
        await preparation;
      }
      return {
        ...selection(),
        model: resolverCalls === 1 ? "captured-model" : "replacement-model",
      };
    },
    /** 準備中の排他を調べる間もカタログ条件は固定する。 */
    getCatalog: () => catalog(),
    provider,
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
    await provider.runExclusive(async () => {
      providerOperationFinished = true;
    });
    assert.equal(providerOperationFinished, true);
    releasePreparation();
    const created = await create;
    assert.equal(created.model, "captured-model");
    assert.equal(created.reasoningEffort, "high");

    resolverCalls = 0;
    let catalogReads = 0;
    const explicitService = createService({
      /** 明示Providerを指定するケースでも同じ親を返す。 */
      getParent: () => parentSession,
      /** 明示作成の結果を最初のケースと同じDBで観測する。 */
      getStorage: () => oldStorage,
      /** 明示作成に混入しない既定の起動選択を用意する。 */
      resolveSelection: async () => selection(),
      /** カタログ取得ごとに既定モデルを変え、初回だけが採用されるかを確かめる。 */
      getCatalog: () => {
        const snapshot = catalog();
        snapshot.providers[0]!.defaultModelId =
          catalogReads++ === 0
            ? "first-discovered-model"
            : "later-discovered-model";
        return snapshot;
      },
      provider,
    });
    const explicitCreated = await explicitService.createAuxiliarySession({
      parentSessionId: parentSession.id,
      provider: "codex",
      clientRequestId: "catalog-boundary",
    });
    assert.equal(explicitCreated.model, "first-discovered-model");
  } finally {
    oldStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary作成の保存前再検証失敗は確定failedとして終端し、結果不明へ昇格しない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/auxiliary-session-service.ts" }
// fault = "保存dispatch前のCharacter利用不可をunknown扱いにして再照会を要求する"
// observable = "failed通知、unknown通知なし、保存行なし"
// observation_boundary = "implementation"
// scope = "auxiliary-creation-commit-validation"
// lifecycle = "permanent"
// impact = "保存されていない要求を再試行不能なunknownへ固定しない"
// distinction = "Character利用不可を検出してもcommit状態を先に通知する実装では保存前失敗とdispatch後不明を区別できない"
// @end-test-value
/** 保存前に選択したCharacterを利用できなくなった場合、結果不明ではなく確定失敗を通知する。 */
test("Auxiliary作成の保存前再検証失敗はfailedで終端する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-precommit-failure-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let entries = characterCandidates();
  const stateChanges: string[] = [];
  const service = createService({
    /** 失敗の原因を親の交換にしないため、同じ親を返し続ける。 */
    getParent: () => currentParent,
    /** 保存前の失敗で書込みがなかったことを実DBから検証する。 */
    getStorage: () => storage,
    /** 取得できる実行設定を固定し、Characterの障害と区別する。 */
    resolveSelection: async () => selection(),
    /** snapshot解決後には候補が消えた状態を返す。 */
    listActiveCharacters: () => entries,
    /** snapshot自体は構築し、最終検証でCharacter不在になるよう候補を消す。 */
    createCharacterRuntimeSnapshot: (id) => {
      entries = [];
      return character(id, "Auxiliary");
    },
    /** 失敗理由をモデルカタログの変更から切り離す。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
    /** 確定失敗と結果不明の通知を区別して履歴に残す。 */
    onCreationStateChanged: (result) => stateChanges.push(result.status),
  });
  try {
    const context = await service.getAuxiliaryCreationContext(currentParent.id);
    await assert.rejects(
      service.createAuxiliarySession({
        parentSessionId: currentParent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
        clientRequestId: "precommit-failure",
        creationContext: context,
      }),
      /Character became unavailable/,
    );
    assert.equal(stateChanges.includes("failed"), true);
    assert.equal(stateChanges.includes("unknown"), false);
    assert.deepEqual(storage.listAuxiliarySessions(currentParent.id), []);
    assert.equal(
      (
        await service.getAuxiliaryCreation({
          parentSessionId: currentParent.id,
          clientRequestId: "precommit-failure",
          creationContext: context,
        })
      ).status,
      "not-found",
    );
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
/** 保存後の遅延取消と並行照会は、古い照会の遅延や失敗にかかわらず作成済みIDへ収束する。 */
test("Auxiliary作成成功後の遅延cancelはcommittedへ解決する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-late-cancel-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  /** 最初の保留照会を作るまでは、安全に呼べる解放処理を置く。 */
  let releaseLookup = () => {};
  const stateChanges: string[] = [];
  const currentParent = parent();
  const service = createService({
    /** 回復中も同じ親を解決し、作成要求の世代だけを比較する。 */
    getParent: () => currentParent,
    /** 確定済み行を含むDBを照会し、遅延する読取りをテストで差し替える。 */
    getStorage: () => storage,
    /** 遅延取消より前に成功する作成の固定設定を返す。 */
    resolveSelection: async () => selection(),
    /** 遅延処理の合間に実行設定側の条件を変えない。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
    /** 古い失敗が確定後にunknownを通知していないかを記録する。 */
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
      const lookupBarrier = new Promise<void>((resolve, reject) => {
        releaseLookup = resolve;
        rejectLookup = reject;
      });
      let firstLookup = true;
      storage.listAuxiliarySessions = ((parentId: string) => {
        if (!firstLookup) return originalList(parentId);
        firstLookup = false;
        return lookupBarrier.then(() => originalList(parentId));
      }) as typeof storage.listAuxiliarySessions;
      const cancelling = service.cancelAuxiliaryCreation(request);
      assert.equal(
        (await service.cancelAuxiliaryCreation(request)).status,
        "unknown",
      );
      assert.equal(
        (
          await service.cancelAuxiliaryCreation({
            ...request,
            clientRequestId: `retire-during-lookup-${lookupFails}`,
          })
        ).status,
        "cancelled",
      );
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
      request.creationContext = await service.getAuxiliaryCreationContext(
        currentParent.id,
      );
    }
    assert.deepEqual(
      await service.cancelAuxiliaryCreation({
        parentSessionId: request.parentSessionId,
        clientRequestId: request.clientRequestId,
        creationContext: context,
      }),
      { status: "committed", auxiliarySessionId: created.id },
    );
    assert.deepEqual(await service.getAuxiliaryCreation(request), {
      status: "committed",
      auxiliarySessionId: created.id,
    });
    let failNextLookup = true;
    storage.listAuxiliarySessions = ((parentId: string) => {
      if (failNextLookup) {
        failNextLookup = false;
        return Promise.reject(new Error("cancel lookup unavailable"));
      }
      return originalList(parentId);
    }) as typeof storage.listAuxiliarySessions;
    assert.equal(
      (await service.cancelAuxiliaryCreation(request)).status,
      "unknown",
    );
    assert.equal(
      (
        await service.cancelAuxiliaryCreation({
          ...request,
          clientRequestId: "retire-before-recovery-query",
        })
      ).status,
      "cancelled",
    );
    assert.deepEqual(await service.getAuxiliaryCreation(request), {
      status: "committed",
      auxiliarySessionId: created.id,
    });
    assert.deepEqual(await service.cancelAuxiliaryCreation(request), {
      status: "committed",
      auxiliarySessionId: created.id,
    });
    assert.equal(
      (await service.createAuxiliarySession(request)).id,
      created.id,
    );
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
/** 取消に必要な永続照会の途中は新規作成を抑止し、照会失敗は再照会へ、owner失効は期限切れへ収束させる。 */
test("Auxiliary作成はcancelの永続化lookup中に割り込んだcreateと競合しても収束する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-cancel-lookup-race-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let releaseLookup!: () => void;
  const lookupBarrier = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let lookupStarted!: () => void;
  const lookupStartedPromise = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
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
    /** 取消と作成の競合に、同じ親identityを供給する。 */
    getParent: () => currentParent,
    /** 一時停止できる永続照会を持つストレージを供給する。 */
    getStorage: () => storage,
    /** 作成が進んだ場合でも使う実行選択を一定にする。 */
    resolveSelection: async () => selection(),
    /** 競合の結果がモデル変更に左右されないようにする。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
    /** 再照会やowner失効に伴う状態通知を順序付きで記録する。 */
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
    assert.match(
      String(await createError),
      /Auxiliary Session creation cancellation is still being confirmed/,
    );
    assert.equal(stateChanges.includes("cancelled"), true);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 0);
    for (const releaseOwner of [false, true]) {
      const recoveryRequest = {
        ...request,
        clientRequestId: `lookup-failure-${releaseOwner}`,
        creationContext: await service.getAuxiliaryCreationContext(
          currentParent.id,
        ),
      };
      let rejectLookup!: (error: Error) => void;
      const failingLookup = new Promise<never>((_resolve, reject) => {
        rejectLookup = reject;
      });
      let firstLookup = true;
      storage.listAuxiliarySessions = ((parentId: string) => {
        if (!firstLookup) return originalList(parentId);
        firstLookup = false;
        return failingLookup;
      }) as typeof storage.listAuxiliarySessions;
      const cancelling = service.cancelAuxiliaryCreation(recoveryRequest);
      if (releaseOwner) service.releaseAuxiliaryCreationOwner(currentParent.id);
      rejectLookup(new Error("lookup unavailable"));
      assert.equal(
        (await cancelling).status,
        releaseOwner ? "expired" : "unknown",
      );
      assert.equal(
        (await service.getAuxiliaryCreation(recoveryRequest)).status,
        releaseOwner ? "expired" : "cancelled",
      );
      await assert.rejects(
        service.createAuxiliarySession(recoveryRequest),
        /The Auxiliary Session creation context has expired/,
      );
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
/** 取消が作成より先なら墓標で後続を拒否し、終端を回収した後も旧世代を再実行しないことを確認する。 */
test("Auxiliary作成のcancel先着は未作成要求をtombstoneで拒否する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-cancel-first-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const provider = new ProviderRuntimeOperationCoordinator();
  let releaseParent!: () => void;
  const parentBarrier = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let blockParent = false;
  const currentParent = parent();
  const stateChanges: Array<{
    status: string;
    clientRequestId: string;
    parentSessionId: string;
    generationId: string;
  }> = [];
  const service = createService({
    /** 親の解決を必要な間だけ保留し、取消を先に確定させる。 */
    getParent: async () => {
      if (blockParent) await parentBarrier;
      return currentParent;
    },
    /** 取消後に会話が作られなかったことを実DBで確認できるようにする。 */
    getStorage: () => storage,
    /** 取消競合から実行選択の変動を除外する。 */
    resolveSelection: async () => selection(),
    /** 有効なカタログを供給して、失敗理由を取消に限定する。 */
    getCatalog: () => catalog(),
    provider,
    /** 保存されなかった要求の識別情報を通知ごとに保持する。 */
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
    assert.deepEqual(
      stateChanges.map((change) => change.status),
      ["preparing", "cancelled"],
    );
    assert.equal(
      stateChanges.every(
        (change) => change.clientRequestId === request.clientRequestId,
      ),
      true,
    );
    assert.equal(
      stateChanges.every(
        (change) => change.parentSessionId === request.parentSessionId,
      ),
      true,
    );
    assert.equal(
      stateChanges.every(
        (change) => change.generationId === context.generationId,
      ),
      true,
    );
    releaseParent();
    await assert.rejects(creation, /Auxiliary Session creation was canceled/);
    assert.equal(
      (service as unknown as { creationRecords: Map<string, unknown> })
        .creationRecords.size,
      0,
    );
    await assert.rejects(
      service.createAuxiliarySession(request),
      /The Auxiliary Session creation context has expired/,
    );
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
/** 作成の永続照会を待つ間に取消と同一要求が到着しても、墓標を上書きせず両要求で保存しないことを確認する。 */
test("Auxiliary作成はpersisted lookup中のcancelと並行createを安全に収束する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-lookup-race-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  let releaseLookup!: () => void;
  const lookupBarrier = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let lookupCalls = 0;
  const originalList = storage.listAuxiliarySessions.bind(storage);
  storage.listAuxiliarySessions = ((parentSessionId: string) => {
    lookupCalls += 1;
    return lookupCalls <= 2
      ? lookupBarrier.then(() => originalList(parentSessionId))
      : originalList(parentSessionId);
  }) as typeof storage.listAuxiliarySessions;
  const service = createService({
    /** 並行する作成と取消の所有者を同じ親に固定する。 */
    getParent: () => currentParent,
    /** 照会を一時停止させる実ストレージを作成と取消で共有する。 */
    getStorage: () => storage,
    /** 並行作成に同一の実行条件を供給する。 */
    resolveSelection: async () => selection(),
    /** モデルの再選択を競合ケースに持ち込まない。 */
    getCatalog: () => catalog(),
    provider,
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
    while (lookupCalls < 2)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const cancelled = await service.cancelAuxiliaryCreation({
      parentSessionId: currentParent.id,
      clientRequestId: request.clientRequestId,
      creationContext: context,
    });
    assert.equal(cancelled.status, "cancelled");
    releaseLookup();
    await assert.rejects(
      first,
      /The Auxiliary Session creation context has expired/,
    );
    await assert.rejects(
      second,
      /The Auxiliary Session creation context has expired/,
    );
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
/** 保存応答が不明な受付を、未検出だけでは取り消さず、後発行を検出したときに作成済みIDへ解決する。 */
test("Auxiliary作成のunknownはDB未検出後も保持し、後発commitをqueryで解決する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-unknown-recovery-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const originalUpsert = storage.upsertAuxiliarySession.bind(storage);
  let captured: Parameters<typeof storage.upsertAuxiliarySession>[0] | null =
    null;
  storage.upsertAuxiliarySession = ((session) => {
    captured = session;
    originalUpsert(session);
    throw new Error("commit result lost after SQLite write");
  }) as typeof storage.upsertAuxiliarySession;
  const service = createService({
    /** 未確定と確定の照会へ同じ親を供給する。 */
    getParent: () => currentParent,
    /** 書込み結果を遅れて確認できる実DBを渡す。 */
    getStorage: () => storage,
    /** 応答喪失ケースで基準になる実行選択を返す。 */
    resolveSelection: async () => selection(),
    /** 遅延する保存結果と独立したカタログを返す。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
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
    await assert.rejects(
      service.createAuxiliarySession(request),
      /commit result lost/,
    );
    assert.ok(captured);
    const committed: Parameters<typeof storage.upsertAuxiliarySession>[0] =
      captured!;
    storage.deleteAuxiliarySessionsForParent(currentParent.id);
    assert.deepEqual(
      await service.getAuxiliaryCreation({
        parentSessionId: currentParent.id,
        clientRequestId: request.clientRequestId,
        creationContext: context,
      }),
      { status: "unknown" },
    );
    storage.upsertAuxiliarySession =
      originalUpsert as typeof storage.upsertAuxiliarySession;
    storage.upsertAuxiliarySession(committed);
    assert.deepEqual(
      await service.getAuxiliaryCreation({
        parentSessionId: currentParent.id,
        clientRequestId: request.clientRequestId,
        creationContext: context,
      }),
      { status: "committed", auxiliarySessionId: committed.id },
    );
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
/** 同じ要求IDの一致する再送は一件へまとめ、入力が変わった場合には別要求としても受理しない。 */
test("Auxiliary作成は同一request IDの異なる入力を拒否する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-request-input-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const service = createService({
    /** 同じ要求IDの各試行で親を変えない。 */
    getParent: () => currentParent,
    /** 重複有無を確かめるため、各試行で同一の永続ストレージを使う。 */
    getStorage: () => storage,
    /** 同じ入力に同じ実行条件を返す。 */
    resolveSelection: async () => selection(),
    /** Provider差異が入力の差として観測できるよう有効なモデルカタログを返す。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
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
/** owner解放前に始まった準備は、世代が進んだ親へ保存できないことを確認する。 */
test("Auxiliary作成のowner解放は旧generationを失効させる", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-generation-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let releaseSelection!: () => void;
  const selectionBarrier = new Promise<void>((resolve) => {
    releaseSelection = resolve;
  });
  let selectionStarted!: () => void;
  const selectionReached = new Promise<void>((resolve) => {
    selectionStarted = resolve;
  });
  let preparingStarted!: () => void;
  const preparingReached = new Promise<void>((resolve) => {
    preparingStarted = resolve;
  });
  const stateChanges: string[] = [];
  const service = createService({
    /** ownerを解放する前後で、親の行自体は同じものを返す。 */
    getParent: () => currentParent,
    /** 旧世代の作成が残っていないことをDBで観測する。 */
    getStorage: () => storage,
    /** 実行選択を一時停止し、その間に作成ownerを解放する。 */
    resolveSelection: async () => {
      selectionStarted();
      await selectionBarrier;
      return selection();
    },
    /** 選択の再開後もモデル条件には変化を加えない。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
    /** 準備に入った時点を同期点として知らせ、失効後の通知も記録する。 */
    onCreationStateChanged: (result) => {
      stateChanges.push(result.status);
      if (result.status === "preparing") preparingStarted();
    },
  });
  try {
    const resolvedContext = await service.getAuxiliaryCreationContext(
      currentParent.id,
    );
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
    assert.notEqual(
      (await service.getAuxiliaryCreationContext(currentParent.id))
        .generationId,
      resolvedContext.generationId,
    );
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
/** サービスを新しくしても、旧サービスがDBに確定した要求をclientRequestIdで照会できることを確認する。 */
test("Auxiliary作成はService再生成後も保存済みclientRequestIdをqueryできる", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-reconnect-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  const options = {
    /** サービスを作り直した後も元の親identityを解決する。 */
    getParent: () => currentParent,
    /** 新サービスから同じDBへ照会し、メモリに依存しない結果の再構成を確認する。 */
    getStorage: () => storage,
    /** 再送後も一致する既定の実行条件を返す。 */
    resolveSelection: async () => selection(),
    /** サービスの世代変更以外のカタログ差は作らない。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
  };
  try {
    const firstService = createService(options);
    const context = await firstService.getAuxiliaryCreationContext(
      currentParent.id,
    );
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
    assert.deepEqual(result, {
      status: "committed",
      auxiliarySessionId: created.id,
    });
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
/** 親やストレージが読込み途中で置き換わった場合は、閉じた旧DBを使わず明示的な取消を返す。 */
test("Auxiliary作成はcommit前のstorage・親identity交換を拒否する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-boundary-storage-"),
  );
  const first = new AuxiliarySessionStorage(path.join(directory, "first.db"));
  const second = new AuxiliarySessionStorage(path.join(directory, "second.db"));
  const third = new AuxiliarySessionStorage(path.join(directory, "third.db"));
  let currentStorage = first;
  let currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  let releaseInitialParent!: () => void;
  const initialParent = new Promise<void>((resolve) => {
    releaseInitialParent = resolve;
  });
  let initialParentEntered!: () => void;
  const initialParentStarted = new Promise<void>((resolve) => {
    initialParentEntered = resolve;
  });
  let parentReads = 0;
  const initialCreateService = createService({
    /** 最初の親照会を保留し、その間に初回スコープのDBを閉じる。 */
    getParent: async () => {
      parentReads += 1;
      if (parentReads === 1) {
        initialParentEntered();
        await initialParent;
      }
      return currentParent;
    },
    /** 最初の読込み中に差し替えられるストレージを返す。 */
    getStorage: () => currentStorage,
    /** 最初の親照会以外で選択解決を止めない。 */
    resolveSelection: async () => selection(),
    /** 初回境界の検証に既定モデルを供給する。 */
    getCatalog: () => catalog(),
    provider,
  });
  try {
    const create = initialCreateService.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "storage-boundary-initial-read",
    });
    await initialParentStarted;
    currentStorage = second;
    first.close();
    releaseInitialParent();
    await assert.rejects(
      create,
      /Auxiliary Session creation was canceled because its storage changed during creation/,
    );
    assert.deepEqual(second.listAuxiliarySessions(currentParent.id), []);

    currentStorage = second;
    parentReads = 0;
    const commitStorageService = createService({
      /** 保存前の二回目の親照会で止め、その間にストレージを交換する。 */
      getParent: async () => {
        parentReads += 1;
        if (parentReads === 2) {
          commitParentEntered();
          await commitParent;
        }
        return currentParent;
      },
      /** 準備時と保存直前で異なるストレージを解決できるようにする。 */
      getStorage: () => currentStorage,
      /** ここでは実行選択の変更を起こさず、保存側の所有者だけを照合させる。 */
      resolveSelection: async () => selection(),
      /** 保存側の再確認を有効なモデル条件で走らせる。 */
      getCatalog: () => catalog(),
      provider,
    });
    let releaseCommitParent!: () => void;
    const commitParent = new Promise<void>((resolve) => {
      releaseCommitParent = resolve;
    });
    let commitParentEntered!: () => void;
    const commitParentStarted = new Promise<void>((resolve) => {
      commitParentEntered = resolve;
    });
    currentStorage = third;
    const commitCreate = commitStorageService.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "storage-boundary-commit-read",
    });
    await commitParentStarted;
    currentStorage = second;
    third.close();
    releaseCommitParent();
    await assert.rejects(
      commitCreate,
      /Auxiliary Session creation was canceled because its storage changed during creation/,
    );
    assert.deepEqual(second.listAuxiliarySessions(currentParent.id), []);

    const incarnationBefore = parent({
      incarnationId: "incarnation-before",
      characterId: "stable-character",
      character: "Stable",
      characterRuntimeSnapshot: character("stable-character", "Stable"),
    });
    currentParent = incarnationBefore;
    let releaseIncarnation!: () => void;
    const incarnationBarrier = new Promise<void>((resolve) => {
      releaseIncarnation = resolve;
    });
    let incarnationRead = 0;
    const incarnationService = createService({
      /** 二回目の親照会を止め、同じSession IDに別incarnationを割り当てる。 */
      getParent: async () => {
        incarnationRead += 1;
        if (incarnationRead === 2) {
          incarnationEntered();
          await incarnationBarrier;
        }
        return currentParent;
      },
      /** incarnation検証時は同じストレージを返し、拒否理由を親のidentityに絞る。 */
      getStorage: () => second,
      /** incarnation変更と無関係なモデル選択を固定する。 */
      resolveSelection: async () => selection(),
      /** 親交換のケースで実行モデルを使用可能にする。 */
      getCatalog: () => catalog(),
      provider,
    });
    let incarnationEntered!: () => void;
    const incarnationStarted = new Promise<void>((resolve) => {
      incarnationEntered = resolve;
    });
    const incarnationCreate = incarnationService.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "incarnation-boundary",
    });
    await incarnationStarted;
    currentParent = parent({
      incarnationId: "incarnation-after",
      characterId: "stable-character",
      character: "Stable",
      characterRuntimeSnapshot: character("stable-character", "Stable"),
    });
    releaseIncarnation();
    await assert.rejects(
      incarnationCreate,
      /Auxiliary Session creation was canceled because its parent session changed during creation/,
    );

    const characterBefore = parent({
      incarnationId: "character-incarnation",
      characterId: "character-before",
      character: "Before",
      characterRuntimeSnapshot: character("character-before", "Before"),
    });
    currentParent = characterBefore;
    let releaseCharacter!: () => void;
    const characterBarrier = new Promise<void>((resolve) => {
      releaseCharacter = resolve;
    });
    let characterReads = 0;
    const characterService = createService({
      /** 保存前の親読込みを待つ間に、incarnationを保ってCharacter IDだけを変更する。 */
      getParent: async () => {
        characterReads += 1;
        if (characterReads === 2) {
          characterEntered();
          await characterBarrier;
        }
        return currentParent;
      },
      /** 親Characterの差だけを検証できるよう、DBを交換しない。 */
      getStorage: () => second,
      /** 親のCharacterが変わっても実行選択は同じ値を返す。 */
      resolveSelection: async () => selection(),
      /** Character交換の検証に既定カタログを使う。 */
      getCatalog: () => catalog(),
      provider,
    });
    let characterEntered!: () => void;
    const characterStarted = new Promise<void>((resolve) => {
      characterEntered = resolve;
    });
    const characterCreate = characterService.createAuxiliarySession({
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session",
      clientRequestId: "character-identity-boundary",
    });
    await characterStarted;
    currentParent = parent({
      incarnationId: "character-incarnation",
      characterId: "character-after",
      character: "After",
      characterRuntimeSnapshot: character("character-after", "After"),
    });
    releaseCharacter();
    await assert.rejects(
      characterCreate,
      /Auxiliary Session creation was canceled because its parent session changed during creation/,
    );

    currentParent = parent({
      incarnationId: "active-character-incarnation",
      characterId: "main-character",
      character: "Main",
      characterRuntimeSnapshot: character("main-character", "Main"),
    });
    let characterIsActive = true;
    let releaseCharacterSelection!: () => void;
    const characterSelection = new Promise<void>((resolve) => {
      releaseCharacterSelection = resolve;
    });
    let characterSelectionEntered!: () => void;
    const characterSelectionStarted = new Promise<void>((resolve) => {
      characterSelectionEntered = resolve;
    });
    const activeCharacterService = createService({
      /** 候補の選択中も親のidentityは一定にする。 */
      getParent: () => currentParent,
      /** 候補消失で保存しないことを既存のストレージで観測する。 */
      getStorage: () => second,
      /** 候補の有効性以外の起動条件を固定する。 */
      resolveSelection: async () => selection(),
      /** 選んだ候補を記録した後にsnapshot生成を待たせ、その間に候補を利用不能にする。 */
      createCharacterRuntimeSnapshot: async (id) => {
        characterSelectionEntered();
        await characterSelection;
        return character(id, "Auxiliary");
      },
      /** 候補を無効にしてもモデル自体は有効とする。 */
      getCatalog: () => catalog(),
      /** 最終検証で選択候補が一覧から消えたことを模擬する。 */
      listActiveCharacters: () =>
        characterIsActive
          ? [
              {
                id: "aux-character",
                name: "Auxiliary",
                description: "",
                iconFilePath: "",
                theme: { main: "#6f8cff", sub: "#6fb8c7" },
                state: "active" as const,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                archivedAt: null,
              },
            ]
          : [],
      provider,
    });
    const activeCharacterCreate = activeCharacterService.createAuxiliarySession(
      {
        parentSessionId: currentParent.id,
        provider: "codex",
        runtimeSelection: "latest-session",
        clientRequestId: "character-active-boundary",
      },
    );
    await characterSelectionStarted;
    characterIsActive = false;
    releaseCharacterSelection();
    await assert.rejects(
      activeCharacterCreate,
      /Auxiliary Session creation was canceled because its Character became unavailable/,
    );
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
// claim = "Auxiliary作成commitは同一親identityの最新speed/reviewerを保存し、同一clientRequestIdの並行再送を一行へ収束する"
// oracle = { type = "adr", ref = "docs/adr/007-provider-runtime-selection-inheritance.md" }
// fault = "準備時の親設定を保存する、または並行再送で複数rowを作る"
// observable = "保存済みAuxiliaryの親設定、並行結果の同一ID、clientRequestId別のrow数"
// observation_boundary = "public-boundary"
// scope = "auxiliary-session-creation-boundary"
// lifecycle = "permanent"
// impact = "ユーザーが変更した実行設定を失わず、再送による重複セッションを防ぐ"
// distinction = "既存の単独作成testではcommit直前の親更新と並行再送の収束を同時に検出できない"
// @end-test-value
/** 準備後に変わった親の速度とReviewerを保存へ反映し、同一要求の並行再送を一行にまとめる。 */
test("Auxiliary作成commitは最新親設定を保存し同一clientRequestIdを収束する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-boundary-idempotency-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  let currentParent = parent();
  const provider = new ProviderRuntimeOperationCoordinator();
  let resolverCalls = 0;
  let releaseResolver!: () => void;
  const resolverBarrier = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  let resolverEntered!: () => void;
  const resolverStarted = new Promise<void>((resolve) => {
    resolverEntered = resolve;
  });
  const service = createService({
    /** 準備と保存の間に更新される同一identityの親を返す。 */
    getParent: () => currentParent,
    /** 並行再送の結果を同じDBで観測する。 */
    getStorage: () => storage,
    /** 最初の実行選択を保留し、待機中の親設定更新と再送を可能にする。 */
    resolveSelection: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        resolverEntered();
        await resolverBarrier;
      }
      return selection();
    },
    /** 親設定の更新中もモデルカタログは固定する。 */
    getCatalog: () => catalog(),
    provider,
  });
  try {
    const request = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "same-request",
    };
    const first = service.createAuxiliarySession(request);
    await resolverStarted;
    currentParent = parent({
      codexSpeed: "fast",
      codexReviewer: "auto-review",
    });
    releaseResolver();
    const second = service.createAuxiliarySession(request);
    const [createdA, createdB] = await Promise.all([first, second]);
    assert.equal(createdA.id, createdB.id);
    assert.equal(storage.listAuxiliarySessions(currentParent.id).length, 1);
    const saved = storage.getAuxiliarySession(createdA.id);
    assert.equal(saved?.codexSpeed, "fast");
    assert.equal(saved?.codexReviewer, "auto-review");
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
/** 取消済みレコードを回収しつつ、旧世代の遅延要求とまだ登録中の別要求を区別する。 */
test("Auxiliaryの取消レコードは回収し、遅延要求を拒否して登録済み要求を維持する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-cancel-retention-"),
  );
  const storage = new AuxiliarySessionStorage(path.join(directory, "app.db"));
  const currentParent = parent();
  let blockNextParent = false;
  let releaseParent!: () => void;
  const parentBarrier = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let parentEntered!: () => void;
  const parentStarted = new Promise<void>((resolve) => {
    parentEntered = resolve;
  });
  const originalList = storage.listAuxiliarySessions.bind(storage);
  const service = createService({
    /** 指定された次の親照会だけを止め、登録済み要求を残したまま別要求を回収する。 */
    getParent: async () => {
      if (blockNextParent) {
        blockNextParent = false;
        parentEntered();
        await parentBarrier;
      }
      return currentParent;
    },
    /** 回収中と再開後の保存結果を同じ永続ストレージで観測する。 */
    getStorage: () => storage,
    /** 取消状態に左右されない既定の選択を返す。 */
    resolveSelection: async () => selection(),
    /** 各世代の開始で有効なモデル条件を揃える。 */
    getCatalog: () => catalog(),
    provider: new ProviderRuntimeOperationCoordinator(),
  });
  const records = (
    service as unknown as { creationRecords: Map<string, unknown> }
  ).creationRecords;
  let creation:
    ReturnType<AuxiliarySessionService["createAuxiliarySession"]> | undefined;
  try {
    const admittedRequest = {
      parentSessionId: currentParent.id,
      provider: "codex",
      runtimeSelection: "latest-session" as const,
      clientRequestId: "already-admitted",
      creationContext: await service.getAuxiliaryCreationContext(
        currentParent.id,
      ),
    };
    blockNextParent = true;
    creation = service.createAuxiliarySession(admittedRequest);
    void creation.catch(() => {});
    await parentStarted;
    for (let index = 0; index < 64; index += 1) {
      const request = {
        ...admittedRequest,
        clientRequestId: `cancel-without-create-${index}`,
        creationContext: await service.getAuxiliaryCreationContext(
          currentParent.id,
        ),
      };
      if (index % 2 === 1) {
        storage.listAuxiliarySessions = () => {
          throw new Error("lookup unavailable");
        };
        assert.equal(
          (await service.cancelAuxiliaryCreation(request)).status,
          "unknown",
        );
        assert.equal(records.size, 2);
        storage.listAuxiliarySessions = originalList;
        assert.equal(
          (await service.getAuxiliaryCreation(request)).status,
          "cancelled",
        );
      } else {
        assert.equal(
          (await service.cancelAuxiliaryCreation(request)).status,
          "cancelled",
        );
      }
      assert.equal(records.size, 1);
      assert.equal(
        (await service.getAuxiliaryCreation(request)).status,
        "expired",
      );
      await assert.rejects(
        service.createAuxiliarySession(request),
        /The Auxiliary Session creation context has expired/,
      );
      assert.equal(
        (await service.getAuxiliaryCreation(admittedRequest)).status,
        "preparing",
      );
    }
    releaseParent();
    const created = await creation;
    assert.equal(created.clientRequestId, admittedRequest.clientRequestId);
    assert.equal(records.size, 0);
    const next = await service.createAuxiliarySession({
      ...admittedRequest,
      clientRequestId: "fresh-request",
      creationContext: await service.getAuxiliaryCreationContext(
        currentParent.id,
      ),
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
// claim = "Auxiliaryの軽量変更は履歴を再読込せず、実行中のbookmarkと次送信向け実行設定を更新でき、失敗や遅延検証・checkpointの後も最後の選択を保持する"
// oracle = { type = "contract", ref = "docs/design/electron-session-store.md: 実行設定と Send; docs/design/session-run-lifecycle.md: GUI Turn Queue" }
// fault = "軽量変更が全履歴をhydrationする、実行中のbookmarkや次送信向け設定を拒否する、または失敗・遅延検証・checkpointで現在選択を消す"
// observable = "title/bookmark保存結果とservice summary・storageの実行設定"
// observation_boundary = "component-behavior"
// scope = "auxiliary-narrow-mutations"
// lifecycle = "permanent"
// impact = "大量履歴の読み込み遅延または次Turnで旧model選択の実行を招く"
// distinction = "保存値だけを見るstorage testではserviceのhydration境界とmemory選択を検出できない"
// @end-test-value
/** 実行中の軽量更新を全履歴なしで行い、失敗や遅延した検証後も次の送信に使う最新設定を保つ。 */
test("Auxiliary軽量変更は全履歴を読まずcheckpoint失敗後も現在選択を保持する", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "withmate-auxiliary-narrow-mutation-"),
  );
  const dbPath = path.join(directory, "app.db");
  const sessionStorage = new SessionStorageV6(dbPath);
  sessionStorage.upsertSession(
    parent({ characterId: "", characterRuntimeSnapshot: null }),
  );
  const storage = new AuxiliarySessionStorage(dbPath);
  const selected = new Map<string, SessionExecutionOptions>();
  let delayNextCatalog = false;
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  let catalogEntered!: () => void;
  const catalogStarted = new Promise<void>((resolve) => {
    catalogEntered = resolve;
  });
  const service = createService({
    /** 軽量変更と作成の双方で同じ親を用いる。 */
    getParent: () => parent(),
    /** タイトル・ブックマーク・実行設定の軽量保存を実DBで検証する。 */
    getStorage: () => storage,
    /** 編集前の会話を作成するために既定の選択を返す。 */
    resolveSelection: async () => selection(),
    /** 選択を競合させるケースで、次のカタログ応答だけを保留する。 */
    getCatalog: () => {
      if (delayNextCatalog) {
        delayNextCatalog = false;
        catalogEntered();
        return catalogGate.then(() => catalog());
      }
      return catalog();
    },
    provider: new ProviderRuntimeOperationCoordinator(),
    /** 保存や後続の解決で採用された実行設定を、Auxiliary ID単位で覚える。 */
    rememberExecutionOptions: (session, options) => {
      selected.set(session.id, options);
    },
    /** ストレージの要約へメモリに保持した次回実行設定を重ね、現行の選択を返す。 */
    overlayCurrentExecutionOptions: (session) => {
      const options = selected.get(session.id);
      return options ? { ...session, ...options } : session;
    },
  });
  const originalGet = storage.getAuxiliarySession.bind(storage);
  const originalCheckpoint =
    storage.updateAuxiliaryExecutionOptionsIfMatches.bind(storage);
  try {
    const created = await service.createAuxiliarySession({
      parentSessionId: parent().id,
      provider: "codex",
    });
    storage.upsertAuxiliarySession({
      ...created,
      messages: [{ role: "user", text: "question" }],
    });
    storage.getAuxiliarySession = () => {
      throw new Error("full Auxiliary hydration is forbidden");
    };
    const identity = {
      auxiliarySessionId: created.id,
      parentSessionId: created.parentSessionId,
      createdAt: created.createdAt,
    };
    await service.setAuxiliaryTitle({ ...identity, title: "renamed" });
    await service.setAuxiliaryMessageBookmark({
      ...identity,
      messageIndex: 0,
      isBookmarked: true,
    });
    const chosen: SessionExecutionOptions = {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalMode: created.approvalMode,
      codexSandboxMode: created.codexSandboxMode,
      codexSpeed: created.codexSpeed,
      codexReviewer: created.codexReviewer,
      customAgentName: created.customAgentName,
    };
    storage.updateAuxiliaryExecutionOptionsIfMatches = () => {
      throw new Error("checkpoint unavailable");
    };
    assert.deepEqual(
      await service.setAuxiliaryExecutionOptions({
        ...identity,
        executionOptions: chosen,
      }),
      {
        status: "accepted",
        checkpointSaved: false,
      },
    );
    assert.equal(
      (await service.getAuxiliarySessionSummary(created.id))?.reasoningEffort,
      "medium",
    );
    assert.equal(
      (await service.getAuxiliarySessionSummary(created.id))?.title,
      "renamed",
    );
    storage.getAuxiliarySession = originalGet;
    assert.equal(
      storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked,
      true,
    );

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let checkpointCount = 0;
    storage.updateAuxiliaryExecutionOptionsIfMatches = (async (
      input: Parameters<typeof originalCheckpoint>[0],
    ) => {
      checkpointCount += 1;
      if (checkpointCount === 1) {
        firstEntered();
        await firstGate;
      }
      return originalCheckpoint(input);
    }) as unknown as typeof storage.updateAuxiliaryExecutionOptionsIfMatches;
    const earlier = service.setAuxiliaryExecutionOptions({
      ...identity,
      executionOptions: { ...chosen, reasoningEffort: "high" },
    });
    await firstStarted;
    const later = service.setAuxiliaryExecutionOptions({
      ...identity,
      executionOptions: chosen,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (await service.getAuxiliarySessionSummary(created.id))?.reasoningEffort,
      "medium",
    );
    releaseFirst();
    await Promise.all([earlier, later]);
    assert.equal(
      storage.getAuxiliarySession(created.id)?.reasoningEffort,
      "medium",
    );

    storage.updateAuxiliaryExecutionOptionsIfMatches = originalCheckpoint;
    delayNextCatalog = true;
    const stale = service.setAuxiliaryExecutionOptions({
      ...identity,
      executionOptions: { ...chosen, reasoningEffort: "high" },
    });
    await catalogStarted;
    await service.setAuxiliaryExecutionOptions({
      ...identity,
      executionOptions: chosen,
    });
    releaseCatalog();
    assert.deepEqual(await stale, { status: "superseded" });
    assert.equal(
      storage.getAuxiliarySession(created.id)?.reasoningEffort,
      "medium",
    );

    storage.upsertAuxiliarySession({
      ...storage.getAuxiliarySession(created.id)!,
      runState: "running",
    });
    await service.setAuxiliaryMessageBookmark({
      ...identity,
      messageIndex: 0,
      isBookmarked: false,
    });
    assert.equal(
      storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked,
      undefined,
    );
    await service.setAuxiliaryMessageBookmark({
      ...identity,
      messageIndex: 0,
      isBookmarked: true,
    });
    assert.equal(
      storage.getAuxiliarySession(created.id)?.messages[0]?.isBookmarked,
      true,
    );
    assert.deepEqual(
      await service.setAuxiliaryExecutionOptions({
        ...identity,
        executionOptions: { ...chosen, approvalMode: "never" },
      }),
      { status: "accepted", checkpointSaved: true },
    );
    assert.equal(selected.get(created.id)?.approvalMode, "never");
    assert.equal(
      storage.getAuxiliarySession(created.id)?.approvalMode,
      "never",
    );
    assert.equal(storage.getAuxiliarySession(created.id)?.runState, "running");
  } finally {
    releaseCatalog();
    storage.getAuxiliarySession = originalGet;
    storage.updateAuxiliaryExecutionOptionsIfMatches = originalCheckpoint;
    storage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
