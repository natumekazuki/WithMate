import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { buildHomeLaunchHandlers } from "../../src/home/home-launch-handlers.js";
import { buildHomeLaunchProjection } from "../../src/home/home-launch-projection.js";
import {
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  createClosedLaunchDraft,
  markLaunchWorkspacePathValidationPending,
  type HomeLaunchCharacterCatalog,
  type HomeLaunchDraft,
} from "../../src/home/home-launch-state.js";
import {
  createDirectoryPathValidationController,
  type DirectoryPathValidationController,
} from "../../src/launch/directory-path-validation.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

/** ID と名前以外を既定にできる Character を用意し、カタログ更新時の識別子と表示名を比較する。 */
function createCharacterEntry(
  partial: Partial<CharacterCatalogEntry> &
    Pick<CharacterCatalogEntry, "id" | "name">,
): CharacterCatalogEntry {
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

/** New Session を開くため、ひとつのモデルを持つ Codex カタログを作る。 */
function createProvider(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
  };
}

/** Character 一覧の成功・失敗を、起動ダイアログ操作と任意の順序で確定する。 */
function createDeferredCatalog() {
  let resolve!: (entries: readonly CharacterCatalogEntry[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<readonly CharacterCatalogEntry[]>(
    (onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    },
  );
  return { promise, resolve, reject };
}

/** ダイアログの状態とカタログ要求を保持する環境を作り、指定時は実際のパス検証へ接続する。 */
function createLaunchHarness(
  workspaceValidation?: DirectoryPathValidationController,
) {
  const state = {
    draft: createClosedLaunchDraft(),
    catalog: { entries: [], status: "loading" } as HomeLaunchCharacterCatalog,
    feedback: "",
  };
  const requests: ReturnType<typeof createDeferredCatalog>[] = [];
  const launchDialogAttemptRef: { current: object | null } = { current: null };
  const launchLifetimeRef = { current: { starting: false } };
  /** 同じ開閉試行と開始状態の参照を使い、最新 draft で起動ハンドラーを組み直す。 */
  const renderHandlers = () =>
    buildHomeLaunchHandlers({
      launchDraft: state.draft,
      launchDialogAttemptRef,
      launchLifetimeRef,
      /** 作成を実行しない開閉テストでは、閉じた試行の結果を処理しない。 */
      onDetachedResult: () => {},
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
      /** ダイアログが一覧を取得するたびに別の保留応答を作り、要求順を記録する。 */
      refreshCharacterEntries: () => {
        const request = createDeferredCatalog();
        requests.push(request);
        return request.promise;
      },
      /** 取得結果の一覧と取得状態を、次のハンドラー構築から参照できるようにする。 */
      setLaunchCharacterCatalog: (value) => {
        state.catalog = value;
      },
      /** 現在の起動フィードバックを保持し、旧試行の失敗が適用されたか比較できるようにする。 */
      setLaunchFeedback: (message) => {
        state.feedback = message;
      },
      /** 実際には作成しないため、開始中フラグの伝播は行わない。 */
      setLaunchStarting: () => {},
      /** 直接更新と関数更新のどちらでも、検証で参照する最新 draft を反映する。 */
      setLaunchDraft: (updater) => {
        state.draft =
          typeof updater === "function" ? updater(state.draft) : updater;
      },
      /** ディレクトリ選択を使わない環境では、パス選択なしを返す。 */
      pickWorkspaceDirectory: () => null,
      /** 設定されていれば、本物の検証コントローラーへ入力パスを渡す。 */
      scheduleWorkspaceValidation: (path) =>
        workspaceValidation?.schedule(path),
      /** 設定されていれば、保留中のパス検証をコントローラー経由で取り消す。 */
      cancelWorkspaceValidation: () => workspaceValidation?.cancel(),
      /** 開閉試行の検証から実際の Session Window を開かない。 */
      openSessionWindow: async () => {},
      /** 検証中は永続 Session を作らず、作成結果を返さない。 */
      createSession: async () => null,
      /** 作成済み Session がないため、一覧に Summary を追加しない。 */
      upsertSessionSummary: () => {},
    });
  return { state, requests, renderHandlers };
}

/** 起動ダイアログの試行管理、パス検証の接続、Character カタログに基づく開始判定を検査する。 */
describe("home-launch-handlers", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Homeの実handlerによるSession Folder選択は保留中のパス検証を取り消し、旧結果を通知せず選択と入力を保持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New Sessionパス検証" }
  // fault = "onSelectSessionFolderから検証取消が外れ、切替前の応答を現在のstateへ通知する"
  // observable = "実onChangeWorkspacePath/onSelectSessionFolder経由の検証開始path、応答解決後のonResult通知配列とHome draft"
  // observation_boundary = "consumer"
  // scope = "Home launch handlerと共有パス検証controllerの取消接続"
  // lifecycle = "permanent"
  // impact = "Session Folder選択後に旧pathの結果を適用する危険を防ぐ"
  // distinction = "controller単体のcancel試験と異なり実handlerの取消結線を通す。state側guardが旧結果を無視しても通知配列で取消欠落を検出する。型検査や通常速度のsmokeでは検出できない遅延応答を1つのPromiseで制御する"
  // @end-test-value
  /** パス検証中に Session Folder を選ぶと保留結果の通知を止め、パス入力と検証状態を初期化する。 */
  it("Session Folder選択handlerは保留中のパス検証を取消し旧結果を通知しない", async () => {
    let resolveValidation!: (value: WorkspaceDirectoryValidationResult) => void;
    const validation = new Promise<WorkspaceDirectoryValidationResult>(
      (resolve) => {
        resolveValidation = resolve;
      },
    );
    const requested: string[] = [];
    const delivered: string[] = [];
    const controller = createDirectoryPathValidationController({
      delayMs: 0,
      /** 検証開始時の入力パスを記録し、切替後に結果を解決できるよう応答を保留する。 */
      validate: (path) => {
        requested.push(path);
        return validation;
      },
      /** 検証の予約を実際の draft 更新へ渡す。 */
      onScheduled: (path) => {
        state.draft = beginLaunchWorkspacePathValidation(state.draft, path);
      },
      /** 検証開始を draft の pending 状態に反映する。 */
      onValidationStart: (path) => {
        state.draft = markLaunchWorkspacePathValidationPending(
          state.draft,
          path,
        );
      },
      /** 適用前にも通知されたパスを記録し、draft 側だけで旧結果が無視される不具合を検出する。 */
      onResult: (path, result) => {
        delivered.push(path);
        state.draft = applyLaunchWorkspacePathValidation(
          state.draft,
          path,
          result,
        );
      },
    });
    const { state, requests, renderHandlers } = createLaunchHarness(controller);
    const handlers = renderHandlers();
    const opening = handlers.onOpenLaunchDialog();
    requests[0].resolve([]);
    await opening;
    handlers.onChangeWorkspacePath("C:\\old-workspace");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requested, ["C:\\old-workspace"]);
    assert.equal(state.draft.workspaceValidation, "pending");

    handlers.onSelectSessionFolder();
    resolveValidation({ valid: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(delivered, []);
    assert.deepEqual(state.draft.workspace, { kind: "session-folder" });
    assert.equal(state.draft.workspaceValidation, "idle");
    assert.equal(state.draft.workspacePathInput, "");
  });

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
  /** 連続して開いても実行中のカタログ取得を共有し、完了時や後続 open で編集中の項目を初期化しない。 */
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
  /** 閉じた試行の取得が後から成功・失敗しても、draft とカタログ、フィードバックを変更しない。 */
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
  /** 閉じて開き直した試行には新しい一覧を取得し、旧要求の成否や完了順によらず現在の入力と通知を維持する。 */
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
        const entries = [
          createCharacterEntry({ id: "latest", name: "Latest" }),
        ];
        /** 新しい試行の一覧取得を完了し、その試行に紐付く Character 選択とフィードバックを設定する。 */
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
          requests[0].resolve([
            createCharacterEntry({ id: "old", name: "Old" }),
          ]);
        } else {
          requests[0].reject(new Error("Old attempt failed"));
        }
        await oldOpening;
        assert.deepEqual(
          state,
          beforeOldCompletion,
          `${outcome}, oldFirst=${oldFirst}`,
        );
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
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New Session dialog" }
  // fault = "再表示時にcatalogを再取得しないか古いCharacter選択を引き継ぐ、または手入力path・Browse結果をvalidation schedulerへ渡さない"
  // observable = "refresh回数、開閉時のcatalog、draftの選択状態とSessionFolder、feedback、検証に渡したraw path"
  // observation_boundary = "component-behavior"
  // scope = "Home launch dialog handlers"
  // lifecycle = "permanent"
  // distinction = "本testは未加工pathのschedulerへの引渡しを観測する。検証結果の採用はhome-launch-state/workspace-validation、開始可否はhome-launch-projectionのtestが担う"
  // @end-test-value
  /** 開き直すたびに一覧を更新してランダムへ戻し、手入力と Browse で得たパスは元の表現のまま検証へ渡す。 */
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
    let catalog: HomeLaunchCharacterCatalog = {
      entries: [],
      status: "loading",
    };

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchDialogAttemptRef: { current: null },
      launchStarting: false,
      launchLifetimeRef: { current: { starting: false } },
      /** 起動実行を調べるテストではないため、離脱済み試行の作成結果を扱わない。 */
      onDetachedResult: () => {},
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
      /** カタログ更新の回数を数え、前回の一覧と区別できる新しい候補を返す。 */
      refreshCharacterEntries: async () => {
        refreshCount += 1;
        return latestEntries;
      },
      /** 開閉に伴う候補の入れ替えと読込状態を検査用変数に保持する。 */
      setLaunchCharacterCatalog: (value) => {
        catalog = value;
      },
      /** ダイアログ操作で表示したフィードバックを、発生順に保存する。 */
      setLaunchFeedback: (message) => feedback.push(message),
      /** 作成待機の状態はこのケースで変更しない。 */
      setLaunchStarting: () => undefined,
      /** 直接値または更新関数を draft へ適用し、ランダム選択やパス変更を観測できるようにする。 */
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      /** Browse から得たパスでも末尾区切りと空白を保持するか検査できる値を返す。 */
      pickWorkspaceDirectory: async () => "C:\\browse workspace\\",
      /** 手入力と Browse のパスを、加工前の引数で記録する。 */
      scheduleWorkspaceValidation: (targetPath) =>
        scheduledWorkspacePaths.push(targetPath),
      /** このケースは予約引数を検査するため、実行中の検証は管理しない。 */
      cancelWorkspaceValidation: () => {},
      /** パスや選択の変更だけを検査するので別ウィンドウを開かない。 */
      openSessionWindow: async () => undefined,
      /** 起動操作を呼ばないケース用に、永続化しない作成口を置く。 */
      createSession: async () => null,
      /** 作成完了がないため、Session 一覧の変更を行わない。 */
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
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New SessionのCharacter取得失敗時は保持済み一覧を起動候補にせず作成を無効にする" }
  // fault = "取得に失敗したCharacter一覧を最新として扱い使用不能なCharacterで開始する"
  // observable = "catalogのerror状態と空一覧、dialogのrandom状態、失敗feedback、有効な開始入力でのprojection.canStartSessionのtrueからfalseへの変化"
  // observation_boundary = "public-boundary"
  // scope = "Home launch catalog refresh failure"
  // lifecycle = "permanent"
  // @end-test-value
  /** 一覧取得の失敗で保存していた候補が無効になり、ほかの入力が有効でもランダム起動を拒むことを検査する。 */
  it("Character catalog の再取得失敗時はstale一覧でrandom開始できない状態にする", async () => {
    let draft = createClosedLaunchDraft();
    const feedback: string[] = [];
    const characterEntries = [
      createCharacterEntry({ id: "stale", name: "Stale" }),
    ];
    let catalog: HomeLaunchCharacterCatalog = {
      entries: characterEntries,
      status: "loaded",
    };
    /** 現在のカタログを本番投影へ渡し、それ以外を有効にしたときの開始可否を返す。 */
    const canStart = () =>
      buildHomeLaunchProjection({
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
        modelCatalog: { providers: [createProvider()] },
      }).canStartSession;
    assert.equal(canStart(), true);

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchDialogAttemptRef: { current: null },
      launchStarting: false,
      launchLifetimeRef: { current: { starting: false } },
      /** カタログの失敗だけを扱うため、離脱後の作成結果を受け取っても処理しない。 */
      onDetachedResult: () => {},
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
      /** 有効な一覧を保持している状態から、最新候補の読み込みだけを失敗させる。 */
      refreshCharacterEntries: async () => {
        throw new Error("Character catalog refresh failed");
      },
      /** 取得失敗により古い候補が消えたか、カタログを保持して検査する。 */
      setLaunchCharacterCatalog: (value) => {
        catalog = value;
      },
      /** 古い通知のクリアと新しい取得エラーの順序を記録する。 */
      setLaunchFeedback: (message) => feedback.push(message),
      /** カタログの失敗では Session 作成に進まないため、開始フラグを追跡しない。 */
      setLaunchStarting: () => undefined,
      /** 取得失敗後もダイアログとランダム選択を維持するか検査できるように、draft の更新を適用する。 */
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      /** カタログ取得の検証では、フォルダー選択結果を返さない。 */
      pickWorkspaceDirectory: async () => null,
      /** 有効な Session Folder を前提とし、外部パスの検証を起こさない。 */
      scheduleWorkspaceValidation: () => {},
      /** 外部パスの検証を使わないため、解除する予約はない。 */
      cancelWorkspaceValidation: () => {},
      /** 候補取得エラー時の可否だけを調べ、実ウィンドウは開かない。 */
      openSessionWindow: async () => undefined,
      /** 作成可否の投影を検査する環境に、保存を伴わない作成口を置く。 */
      createSession: async () => null,
      /** 起動失敗で新規 Session は存在しないため、一覧を更新しない。 */
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
