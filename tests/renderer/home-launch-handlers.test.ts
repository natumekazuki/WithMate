import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { buildHomeLaunchHandlers } from "../../src/home/home-launch-handlers.js";
import { buildHomeLaunchProjection } from "../../src/home/home-launch-projection.js";
import { createClosedLaunchDraft, type HomeLaunchCharacterCatalog, type HomeLaunchDraft } from "../../src/home/home-launch-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

function createCharacterEntry(partial: Partial<CharacterCatalogEntry> & Pick<CharacterCatalogEntry, "id" | "name">): CharacterCatalogEntry {
  return {
    id: partial.id,
    name: partial.name,
    description: partial.description ?? "",
    iconFilePath: partial.iconFilePath ?? "",
    theme: partial.theme ?? { main: "#6f8cff", sub: "#6fb8c7" },
    state: partial.state ?? "active",
    createdAt: partial.createdAt ?? "",
    updatedAt: partial.updatedAt ?? "",
    archivedAt: partial.archivedAt ?? null,
  };
}

function createProvider(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
  };
}

function createDeferredCatalog() {
  let resolve!: (entries: readonly CharacterCatalogEntry[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<readonly CharacterCatalogEntry[]>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createLaunchHarness() {
  const state = {
    draft: createClosedLaunchDraft(),
    catalog: { entries: [], status: "loading" } as HomeLaunchCharacterCatalog,
    feedback: "",
  };
  const requests: ReturnType<typeof createDeferredCatalog>[] = [];
  const launchDialogAttemptRef: { current: object | null } = { current: null };
  const renderHandlers = () => buildHomeLaunchHandlers({
    launchDraft: state.draft,
    launchDialogAttemptRef,
    launchStarting: false,
    mateState: "active",
    mateProfile: null,
    enabledLaunchProviders: [createProvider()],
    characterEntries: state.catalog.entries,
    selectedLaunchProviderId: state.draft.providerId,
    sessions: [],
    sessionCharacterUsage: [],
    openSessionWindowIds: [],
    openSessionWindowIdsLoadStatus: "loaded",
    sessionCharacterUsageLoadStatus: "loaded",
    refreshCharacterEntries: () => {
      const request = createDeferredCatalog();
      requests.push(request);
      return request.promise;
    },
    setLaunchCharacterCatalog: (value) => { state.catalog = value; },
    setLaunchFeedback: (message) => { state.feedback = message; },
    setLaunchStarting: () => {},
    setLaunchDraft: (updater) => {
      state.draft = typeof updater === "function" ? updater(state.draft) : updater;
    },
    pickWorkspaceDirectory: () => null,
    scheduleWorkspaceValidation: () => {},
    cancelWorkspaceValidation: () => {},
    openSessionWindow: async () => {},
    createSession: async () => null,
    upsertSessionSummary: () => {},
  });
  return { state, requests, renderHandlers };
}

describe("home-launch-handlers", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "同じ表示試行の連続openは再描画をまたいでも単一取得となり、取得中の入力と取得後の選択を維持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
  // fault = "連続openが別取得を開始するか、遅延取得完了がdraftを初期化する"
  // observable = "取得回数、取得中のopenとloading、完了前後のdraft、loaded一覧"
  // observation_boundary = "component-behavior"
  // scope = "New Session open single flight across handler rebuilds"
  // lifecycle = "permanent"
  // impact = "入力済みのtitle・workspace・provider・Character選択が失われる"
  // distinction = "型検査と同期open testでは検出できないPromise待機中と再描画後の再入をdeferredで低コストに確認する"
  // @end-test-value
  it("連続openは取得を単一化し、取得完了と表示中のopenで入力を初期化しない", async () => {
    const { state, requests, renderHandlers } = createLaunchHarness();
    const handlers = renderHandlers();
    const opening = handlers.onOpenLaunchDialog();
    await handlers.onOpenLaunchDialog();
    await renderHandlers().onOpenLaunchDialog();
    assert.equal(requests.length, 1);
    assert.equal(state.draft.open, true);
    assert.equal(state.catalog.status, "loading");

    handlers.onChangeTitle("Keep my title");
    handlers.onSelectSessionFolder();
    handlers.onSelectLaunchProvider("copilot");
    const enteredDraft = { ...state.draft };
    const entries = [createCharacterEntry({ id: "new", name: "New" })];
    requests[0].resolve(entries);
    await opening;
    assert.deepEqual(state.draft, enteredDraft);
    assert.deepEqual(state.catalog, { entries, status: "loaded" });

    renderHandlers().onSelectLaunchCharacter("new");
    const selectedDraft = { ...state.draft };
    await handlers.onOpenLaunchDialog();
    await renderHandlers().onOpenLaunchDialog();
    assert.equal(requests.length, 1);
    assert.deepEqual(state.draft, selectedDraft);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "取得中にCancelした試行の成功と失敗は閉じたdialogのdraft・catalog・feedbackを変更しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
  // fault = "Cancel後の旧取得がdialogを再表示するか古い一覧またはエラーを適用する"
  // observable = "遅延成功と失敗の完了前後で閉じたstateが同値"
  // observation_boundary = "component-behavior"
  // scope = "New Session cancellation while loading"
  // lifecycle = "permanent"
  // impact = "取消した入力画面が再表示され、ユーザー操作を奪う"
  // distinction = "deferred成功・失敗の両経路を直接制御し、通常速度のsmokeでは再現が不確実な取消境界を検証する"
  // @end-test-value
  it("Cancel後の遅延成功と失敗を閉じたdialogへ適用しない", async () => {
    for (const outcome of ["success", "failure"] as const) {
      const { state, requests, renderHandlers } = createLaunchHarness();
      const opening = renderHandlers().onOpenLaunchDialog();
      renderHandlers().onCloseLaunchDialog();
      assert.equal(state.draft.open, false);
      const closedState = structuredClone(state);
      if (outcome === "success") {
        requests[0].resolve([createCharacterEntry({ id: "old", name: "Old" })]);
      } else {
        requests[0].reject(new Error("Canceled attempt failed"));
      }
      await opening;
      assert.deepEqual(state, closedState, outcome);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Cancel後の再表示は最新一覧とRandomで開始し、新旧応答の順序によらず旧成功・失敗から現行入力とfeedbackを保護する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
  // fault = "失効した応答が次の試行の一覧・入力・選択を上書きするかエラーを混入させる"
  // observable = "再取得回数、再表示時のRandom、新しいdraft・catalog・feedbackの旧応答前後の同値"
  // observation_boundary = "component-behavior"
  // scope = "New Session reopen with out-of-order completions"
  // lifecycle = "permanent"
  // impact = "開き直したSessionの設定が失われるか無関係な取得エラーで開始できなくなる"
  // distinction = "新旧二つのdeferredを両順序で解決し、静的checkや単一要求testが保証しない試行間の分離を軽量に検証する"
  // @end-test-value
  it("開き直し後は新旧応答順に関係なく現行試行だけを反映する", async () => {
    for (const outcome of ["success", "failure"] as const) {
      for (const oldFirst of [true, false]) {
        const { state, requests, renderHandlers } = createLaunchHarness();
        const oldOpening = renderHandlers().onOpenLaunchDialog();
        renderHandlers().onCloseLaunchDialog();
        const newOpening = renderHandlers().onOpenLaunchDialog();
        assert.equal(requests.length, 2);
        assert.equal(state.draft.characterSelectionMode, "random");
        assert.deepEqual(state.catalog, { entries: [], status: "loading" });
        const current = renderHandlers();
        current.onChangeTitle("New attempt title");
        current.onSelectSessionFolder();
        const entries = [createCharacterEntry({ id: "latest", name: "Latest" })];
        const finishNew = async () => {
          requests[1].resolve(entries);
          await newOpening;
          renderHandlers().onSelectLaunchCharacter("latest");
          state.feedback = "Current attempt feedback";
        };
        if (!oldFirst) {
          await finishNew();
        }
        const beforeOldCompletion = structuredClone(state);
        if (outcome === "success") {
          requests[0].resolve([createCharacterEntry({ id: "old", name: "Old" })]);
        } else {
          requests[0].reject(new Error("Old attempt failed"));
        }
        await oldOpening;
        assert.deepEqual(state, beforeOldCompletion, `${outcome}, oldFirst=${oldFirst}`);
        if (oldFirst) {
          await finishNew();
        }
        assert.equal(state.draft.open, true);
        assert.equal(state.draft.title, "New attempt title");
        assert.deepEqual(state.draft.workspace, { kind: "session-folder" });
        assert.equal(state.draft.characterId, "latest");
        assert.equal(state.draft.characterSelectionMode, "specific");
        assert.deepEqual(state.catalog, { entries, status: "loaded" });
        assert.equal(state.feedback, "Current attempt feedback");
      }
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "launch dialog再表示はCharacter一覧を再取得して保持しrandom選択へ戻し、workspace入力は検証へ渡す"
  // oracle = { type = "contract", ref = "src/home/home-launch-handlers.ts" }
  // fault = "古いCharacter選択を引き継ぐか、入力されたworkspaceを検証せず開始候補にする"
  // observable = "refresh回数、開閉時のcatalog、draftの選択状態とSessionFolder、feedback、検証に渡したraw path"
  // observation_boundary = "component-behavior"
  // scope = "Home launch dialog handlers"
  // lifecycle = "permanent"
  // @end-test-value
  it("launch dialog を開くたびに Character catalog を再取得してrandom選択へ戻す", async () => {
    let draft: HomeLaunchDraft = {
      ...createClosedLaunchDraft(),
      characterId: "old",
    };
    const latestEntries = [
      createCharacterEntry({ id: "new-character", name: "New Character" }),
    ];
    const feedback: string[] = [];
    const scheduledWorkspacePaths: string[] = [];
    let refreshCount = 0;
    let catalog: HomeLaunchCharacterCatalog = { entries: [], status: "loading" };

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchDialogAttemptRef: { current: null },
      launchStarting: false,
      mateState: "active",
      mateProfile: null,
      enabledLaunchProviders: [createProvider()],
      characterEntries: [createCharacterEntry({ id: "old", name: "Old" })],
      selectedLaunchProviderId: "codex",
      sessions: [],
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionCharacterUsageLoadStatus: "loaded",
      refreshCharacterEntries: async () => {
        refreshCount += 1;
        return latestEntries;
      },
      setLaunchCharacterCatalog: (value) => { catalog = value; },
      setLaunchFeedback: (message) => feedback.push(message),
      setLaunchStarting: () => undefined,
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      pickWorkspaceDirectory: async () => "C:\\browse workspace\\",
      scheduleWorkspaceValidation: (targetPath) => scheduledWorkspacePaths.push(targetPath),
      cancelWorkspaceValidation: () => {},
      openSessionWindow: async () => undefined,
      createSession: async () => null,
      upsertSessionSummary: () => undefined,
    });

    await handlers.onOpenLaunchDialog();

    assert.equal(refreshCount, 1);
    assert.deepEqual(catalog, { entries: latestEntries, status: "loaded" });
    assert.equal(draft.open, true);
    assert.equal(draft.characterId, "");
    assert.equal(draft.characterSelectionMode, "random");
    assert.deepEqual(feedback, [""]);

    handlers.onSelectRandomLaunchCharacter();
    assert.equal(draft.characterSelectionMode, "random");

    handlers.onSelectLaunchCharacter("new-character");
    assert.equal(draft.characterSelectionMode, "specific");

    handlers.onCloseLaunchDialog();
    assert.deepEqual(catalog, { entries: [], status: "loading" });
    await handlers.onOpenLaunchDialog();
    assert.equal(refreshCount, 2);
    assert.deepEqual(catalog, { entries: latestEntries, status: "loaded" });
    assert.equal(draft.characterSelectionMode, "random");

    handlers.onSelectSessionFolder();
    assert.deepEqual(draft.workspace, { kind: "session-folder" });
    assert.equal(draft.workspacePathInput, "");

    handlers.onChangeWorkspacePath("\\\\server\\share\\manual workspace\\");
    handlers.onBrowseWorkspace();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(scheduledWorkspacePaths, [
      "\\\\server\\share\\manual workspace\\",
      "C:\\browse workspace\\",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Character一覧再取得の失敗はloaded状態を解除し古い一覧でのrandom開始を防ぐ"
  // oracle = { type = "contract", ref = "src/home/home-launch-handlers.ts" }
  // fault = "取得に失敗したCharacter一覧を最新として扱い使用不能なCharacterで開始する"
  // observable = "catalogのerror状態と空一覧、dialogのrandom状態、失敗feedback、有効な開始入力でのprojection.canStartSessionのtrueからfalseへの変化"
  // observation_boundary = "public-boundary"
  // scope = "Home launch catalog refresh failure"
  // lifecycle = "permanent"
  // @end-test-value
  it("Character catalog の再取得失敗時はstale一覧でrandom開始できない状態にする", async () => {
    let draft = createClosedLaunchDraft();
    const feedback: string[] = [];
    const characterEntries = [createCharacterEntry({ id: "stale", name: "Stale" })];
    let catalog: HomeLaunchCharacterCatalog = { entries: characterEntries, status: "loaded" };
    const canStart = () => buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "Valid task",
      launchWorkspace: { kind: "session-folder" },
      launchCharacterSelectionMode: "random",
      characterEntries: catalog.entries,
      charactersLoaded: catalog.status === "loaded",
      characterLoadStatus: catalog.status,
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
      appSettings: createDefaultAppSettings(),
      modelCatalog: { revision: 1, providers: [createProvider()] },
    }).canStartSession;
    assert.equal(canStart(), true);

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchDialogAttemptRef: { current: null },
      launchStarting: false,
      mateState: "active",
      mateProfile: null,
      enabledLaunchProviders: [createProvider()],
      characterEntries,
      selectedLaunchProviderId: "codex",
      sessions: [],
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionCharacterUsageLoadStatus: "loaded",
      refreshCharacterEntries: async () => {
        throw new Error("Character catalog refresh failed");
      },
      setLaunchCharacterCatalog: (value) => { catalog = value; },
      setLaunchFeedback: (message) => feedback.push(message),
      setLaunchStarting: () => undefined,
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      pickWorkspaceDirectory: async () => null,
      scheduleWorkspaceValidation: () => {},
      cancelWorkspaceValidation: () => {},
      openSessionWindow: async () => undefined,
      createSession: async () => null,
      upsertSessionSummary: () => undefined,
    });

    await handlers.onOpenLaunchDialog();

    assert.equal(draft.open, true);
    assert.equal(draft.characterSelectionMode, "random");
    assert.deepEqual(catalog, { entries: [], status: "error" });
    assert.equal(canStart(), false);
    assert.deepEqual(feedback, ["", "Character catalog refresh failed"]);
  });
});
