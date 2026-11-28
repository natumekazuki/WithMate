import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import {
  resetHomeDatabase,
  saveHomeSettings,
  deleteOldSessions,
  type HomeSettingsApi,
} from "../../src/settings/settings-actions.js";
import { buildSettingsCommandHandlers } from "../../src/settings/settings-command-handlers.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** 設定画面の保存・DB初期化・古いSession削除に正常応答を用意し、操作履歴や失敗をケースごとに上書きできるようにする。 */
function createApi(overrides?: Partial<HomeSettingsApi>): HomeSettingsApi {
  return {
    /** 保存要求を受理し、同じ設定を確定値として返す。 */
    updateAppSettings: async (settings) => settings,
    /** Sessionだけを初期化した成功結果を返す。 */
    resetAppDatabase: async () => ({
      resetTargets: ["sessions"],
      sessions: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: { providers: [] },
    }),
    /** 指定基準日でSessionを1件削除した結果を返す。 */
    deleteSessionsLastActiveBefore: async () => ({
      cutoffDate: "2026-07-01",
      cutoffTimestampMs: 1782831600000,
      deletedSessionIds: ["s-1"],
      skippedRunningSessionIds: [],
    }),
    ...overrides,
  };
}

/** ボタン操作が非同期に反映する状態を検査する前に、待機中の処理を1回進める。 */
async function flushAsyncHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Home設定の保存・確認付きのデータ操作・ファイル選択が、結果と通知を正しく返すことを検証する。 */
describe("home-settings-actions", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Settings save actionは更新済みsettingsと保存完了feedbackを返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: saveHomeSettings" }
  // fault = "保存後のnextSettingsまたは成功feedbackを返さず、呼び出し側の状態更新を失わせる"
  // observable = "saveHomeSettingsのnextSettingsとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-save-result"
  // lifecycle = "permanent"
  // @end-test-value
  /** 保存済み設定に変更値を反映し、成功したことを示す通知も返す。 */
  it("save は nextSettings と feedback を返す", async () => {
    const settings = createDefaultAppSettings();
    settings.autoCollapseActionDockOnSend = false;

    const result = await saveHomeSettings(createApi(), settings);

    assert.equal(result.nextSettings.autoCollapseActionDockOnSend, false);
    assert.equal(result.feedback, "Settings saved.");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "保存処理の待機中に加えられた新しいSettings draftを保存済み値で上書きしない"
  // oracle = { type = "contract", ref = "Issue #731 settings save draft preservation" }
  // fault = "保存完了時に後から編集した値が消え、dirty状態も失われる"
  // observable = "保存完了後のappSettings、settings draft、feedback"
  // observation_boundary = "public-boundary"
  // scope = "settings-save-concurrent-edit"
  // lifecycle = "permanent"
  // @end-test-value
  /** 保存開始後に加えた編集は遅れて完了した保存結果で上書きされず、未保存の変更が残ったことを通知する。 */
  it("save は待機中に追加されたdraft編集を保持する", async () => {
    const settings = createDefaultAppSettings();
    settings.autoCollapseActionDockOnSend = false;
    let draft = settings;
    let appSettings = settings;
    let feedback = "";
    let resolveUpdate: ((value: AppSettings) => void) | undefined;
    const updateCompleted = new Promise<AppSettings>((resolve) => {
      resolveUpdate = resolve;
    });
    const handlers = buildSettingsCommandHandlers({
      /** 完了の時点を制御できる保存APIを設定ハンドラーへ渡す。 */
      getApi: () =>
        createApi({
          /** 送信された設定を、テストが保存完了を通知するまで保留して返す。 */
          updateAppSettings: async (nextSettings) => {
            return updateCompleted.then(() => nextSettings);
          },
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** 保存中に編集された可能性のある最新ドラフトを読み直す。 */
      getPersistedSettingsDraft: () => draft,
      /** 保存結果が確定側に適用されたか確認できるよう記録する。 */
      setAppSettings: (nextSettings) => {
        appSettings = nextSettings;
      },
      /** 保存完了時にドラフトを置き換えるか観測する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** 保存後も未確定の編集が残る旨の通知を捕捉する。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    const savePromise = handlers.onSaveSettings();
    await flushAsyncHandlers();
    draft = { ...draft, scrollToLatestOnSend: !draft.scrollToLatestOnSend };
    resolveUpdate?.(settings);
    await savePromise;

    assert.equal(appSettings.autoCollapseActionDockOnSend, false);
    assert.equal(draft.autoCollapseActionDockOnSend, false);
    assert.equal(draft.scrollToLatestOnSend, false);
    assert.equal(feedback, "Settings saved. New changes remain unsaved.");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Settings保存の失敗はdraftを維持し、失敗理由をfeedbackへ表示する"
  // oracle = { type = "contract", ref = "Issue #731 settings save failure feedback" }
  // fault = "保存失敗を成功扱いにする、または失敗理由を消してdraftを失う"
  // observable = "保存後のdraft、appSettings、settings feedback"
  // observation_boundary = "public-boundary"
  // scope = "settings-save-error"
  // lifecycle = "permanent"
  // @end-test-value
  /** 書込み失敗時は適用済み設定とドラフトを変えず、失敗理由を設定フィードバックへ表示する。 */
  it("save failure はdraftを維持してfeedbackに失敗理由を表示する", async () => {
    const settings = createDefaultAppSettings();
    let draft = settings;
    let appSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** 保存実行時に失敗するAPIをハンドラーへ渡す。 */
      getApi: () =>
        createApi({
          /** DB書込みの代わりに容量不足の例外を返す。 */
          updateAppSettings: async () => {
            throw new Error("disk full");
          },
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** 失敗後の適用済み設定への書込みを観測する。 */
      setAppSettings: (nextSettings) => {
        appSettings = nextSettings;
      },
      /** 失敗しても元のドラフトが残るか記録する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** 書込み例外が利用者に届いたか確認するため通知を記録する。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    await handlers.onSaveSettings();

    assert.equal(appSettings, settings);
    assert.equal(draft, settings);
    assert.equal(feedback, "disk full");
  });

  // @test-value v2
  // kind = "contract"
  // claim = "database reset actionは選択対象を確認し、成功時にsessionsの影響とcharacter file bodiesの保持をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: resetHomeDatabase" }
  // fault = "confirm後のreset結果を誤った対象へ投影するか、保持対象を隠して破壊的操作の影響を誤認させる"
  // observable = "reset result kind、feedback、resetTargets"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-database-reset-success"
  // lifecycle = "permanent"
  // @end-test-value
  /** 確認で続行したSession初期化は成功と対象を返し、Characterファイル本文が残ったことを通知する。 */
  it("reset は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      /** Session初期化への確認を承認した場合を再現する。 */
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(
        result.feedback,
        "Reset Sessions. Character file bodies were preserved.",
      );
      assert.deepEqual(result.result.resetTargets, ["sessions"]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "database reset actionは対象なしをnoopとし、confirm拒否をcanceledとして副作用なしに返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: resetHomeDatabase" }
  // fault = "空の対象をresetするか、confirm falseを成功扱いして破壊的操作を実行する"
  // observable = "noop/canceled resultのkindとfeedback、resetAppDatabase呼び出し数"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-database-reset-guard"
  // lifecycle = "permanent"
  // @end-test-value
  /** 初期化対象が空ならnoop、確認で拒否されたらcanceledとなり、どちらもDB初期化APIを呼ばない。 */
  it("reset target が空なら noop、confirm false なら canceled を返す", async () => {
    let resetCalls = 0;
    const api = createApi({
      /** 初期化APIが誤って実行された回数を数える。 */
      resetAppDatabase: async () => {
        resetCalls += 1;
        throw new Error("reset must not run");
      },
    });

    const noopResult = await resetHomeDatabase({
      api,
      resetTargets: [],
      /** 承認しても対象が無ければ初期化されない条件を作る。 */
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "Select at least one reset target.",
    });

    const canceledResult = await resetHomeDatabase({
      api,
      resetTargets: ["sessions"],
      /** 有効な初期化対象でも利用者が続行しない場合を再現する。 */
      confirm: () => false,
    });
    assert.deepEqual(canceledResult, {
      kind: "canceled",
    });
    assert.equal(resetCalls, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "old session delete actionはconfirm後に削除件数を返し、対象sessionの影響をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: deleteOldSessions" }
  // fault = "削除結果の件数または対象を落とし、破壊的操作の完了状態を誤表示する"
  // observable = "delete result kind、feedback、deletedSessionIds"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-session-cleanup-success"
  // lifecycle = "permanent"
  // @end-test-value
  /** 期限切れSessionの削除を承認すると成功結果に削除IDが残り、件数を案内する。 */
  it("old session delete は confirm と result を扱う", async () => {
    const api = createApi();
    const result = await deleteOldSessions({
      api,
      cutoffDate: "2026-07-01",
      /** 古いSessionの削除を利用者が承認した状態にする。 */
      confirm: () => true,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.feedback, "1 old session deleted.");
      assert.deepEqual(result.result.deletedSessionIds, ["s-1"]);
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "old session delete actionはcleanup date未指定をnoopとし、confirm拒否をcanceledとして返す"
  // oracle = { type = "contract", ref = "src/settings/settings-actions.ts: deleteOldSessions" }
  // fault = "日付なしで削除を実行するか、confirm falseを成功扱いしてSessionを削除する"
  // observable = "noop/canceled resultのkindとfeedback、deleteSessionsLastActiveBefore呼び出し数"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-session-cleanup-guard"
  // lifecycle = "permanent"
  // @end-test-value
  /** 基準日がなければnoop、拒否ならcanceledとし、どちらも古いSessionの削除APIには到達しない。 */
  it("old session delete は cutoff 未指定なら noop、confirm false なら canceled を返す", async () => {
    let deleteCalls = 0;
    const api = createApi({
      /** 削除APIへの呼出しが発生したか数える。 */
      deleteSessionsLastActiveBefore: async () => {
        deleteCalls += 1;
        throw new Error("delete must not run");
      },
    });

    const noopResult = await deleteOldSessions({
      api,
      cutoffDate: "",
      /** 日付が未指定でも確認側は許可を返すようにし、日付チェックを独立して検査する。 */
      confirm: () => true,
    });
    assert.deepEqual(noopResult, {
      kind: "noop",
      feedback: "Select a cleanup date.",
    });

    const canceledResult = await deleteOldSessions({
      api,
      cutoffDate: "2026-07-01",
      /** 基準日があっても利用者が削除を拒否した場合を再現する。 */
      confirm: () => false,
    });
    assert.deepEqual(canceledResult, {
      kind: "canceled",
    });
    assert.equal(deleteCalls, 0);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill root pickerは選択pathだけを更新し、既存relative pathとenabledを維持する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRootPath" }
  // fault = "root path選択時にrelative pathまたはprovider enabledを失い、feedbackも更新しない"
  // observable = "draft provider settingsとfeedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-root-picker"
  // lifecycle = "permanent"
  // @end-test-value
  /** providerのルート選択は現在パスから始まり、選んだルートと結果通知だけを変えて他のprovider設定を維持する。 */
  it("provider skill root picker は選択 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/before",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** 新しいルートディレクトリを選択するダイアログを代替する。 */
      getApi: () =>
        ({
          /** 初期位置が既存ルートであることを確認して、別のディレクトリを返す。 */
          pickDirectory: async (initialPath) => {
            assert.equal(initialPath, "C:/before");
            return "C:/after";
          },
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** ディレクトリ選択はまだ設定保存を行わないため適用済み値は扱わない。 */
      setAppSettings: () => undefined,
      /** ルート変更後の未保存ドラフトを捕捉する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** ルート更新の案内を取り込む。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    handlers.onBrowseProviderSkillRootPath("codex");
    await flushAsyncHandlers();

    assert.equal(draft.codingProviderSettings.codex.skillRootPath, "C:/after");
    assert.equal(
      draft.codingProviderSettings.codex.skillRelativePath,
      ".codex/skills",
    );
    assert.equal(
      draft.codingProviderSettings.codex.instructionRelativePath,
      "AGENTS.md",
    );
    assert.equal(draft.codingProviderSettings.codex.enabled, true);
    assert.match(feedback, /Root directory updated/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill relative pickerはRoot Directory配下の選択をrelative pathへ変換する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRelativePath" }
  // fault = "root外のabsolute pathや誤ったrelative pathをdraftへ保存する"
  // observable = "draftのskillRootPath、skillRelativePath、feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-skill-relative-picker"
  // lifecycle = "permanent"
  // @end-test-value
  /** ルート配下のSkillディレクトリを、ルートや指示ファイルを変えずに相対パスでドラフトへ反映する。 */
  it("provider skill relative picker は Root Directory 配下の相対 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: "",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** ルート配下のSkillディレクトリを選択するAPIを提供する。 */
      getApi: () =>
        ({
          /** ルートをダイアログの初期位置にして、そこから配下のSkillフォルダーを選ぶ。 */
          pickDirectory: async (initialPath) => {
            assert.equal(initialPath, "C:/workspace");
            return "C:/workspace/.codex/skills";
          },
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** 選択時の検査対象は保存前のドラフトであり、適用済み値は更新しない。 */
      setAppSettings: () => undefined,
      /** 選択した相対パスを反映したドラフトを受け取る。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** Skill相対パスの変更通知を記録する。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    handlers.onBrowseProviderSkillRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(
      draft.codingProviderSettings.codex.skillRootPath,
      "C:/workspace",
    );
    assert.equal(
      draft.codingProviderSettings.codex.skillRelativePath,
      ".codex/skills",
    );
    assert.equal(
      draft.codingProviderSettings.codex.instructionRelativePath,
      "AGENTS.md",
    );
    assert.match(feedback, /Skill relative path updated/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider instruction relative pickerはRoot Directory配下のfileをrelative pathへ変換する"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderInstructionRelativePath" }
  // fault = "instruction fileのabsolute pathを保存するか、既存skill pathを壊す"
  // observable = "draftのinstructionRelativePathと既存provider settings、feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-instruction-relative-picker"
  // lifecycle = "permanent"
  // @end-test-value
  /** ルート内のInstructionファイルを相対パスへ変換して保存前のドラフトに設定し、既存Skillパスは保つ。 */
  it("provider instruction relative picker は Root Directory 配下の相対 path を draft に反映する", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** ルート内部のInstructionファイルを選択するAPIを渡す。 */
      getApi: () =>
        ({
          /** ダイアログの開始位置を調べ、ルート直下のAGENTS.mdを返す。 */
          pickFile: async (initialPath) => {
            assert.equal(initialPath, "C:/workspace");
            return "C:/workspace/AGENTS.md";
          },
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** ファイル選択では保存済み設定の反映を扱わない。 */
      setAppSettings: () => undefined,
      /** Instruction選択後のドラフトを記録する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** Instructionの相対パスが更新された旨の通知を受け取る。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    handlers.onBrowseProviderInstructionRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(
      draft.codingProviderSettings.codex.skillRootPath,
      "C:/workspace",
    );
    assert.equal(
      draft.codingProviderSettings.codex.skillRelativePath,
      ".codex/skills",
    );
    assert.equal(
      draft.codingProviderSettings.codex.instructionRelativePath,
      "AGENTS.md",
    );
    assert.match(feedback, /Instruction relative path updated/);
  });

  // @test-value v2
  // kind = "security"
  // claim = "provider instruction relative pickerはRoot Directory外の選択をdraftへ反映せず、理由をfeedbackへ示す"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderInstructionRelativePath" }
  // fault = "root外のfile pathをinstruction設定として保存し、provider file boundaryを越える"
  // observable = "draft identityとroot directory feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-instruction-root-boundary"
  // lifecycle = "permanent"
  // @end-test-value
  /** ルート外のInstructionファイルはドラフトへ反映せず、ルート内を選ぶよう案内する。 */
  it("provider instruction relative picker は Root Directory 外の選択を反映しない", async () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: true,
      apiKey: "key",
      skillRootPath: "C:/workspace",
      skillRelativePath: ".codex/skills",
      instructionRelativePath: "AGENTS.md",
    };
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** Instructionの選択がルート外を返す条件を作る。 */
      getApi: () =>
        ({
          /** 選択済みだが指定ルート外にある別ドライブのファイルを返す。 */
          pickFile: async () => "D:/other/AGENTS.md",
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** パス選択の拒否は設定の保存には進まない。 */
      setAppSettings: () => undefined,
      /** 境界外の選択でドラフトが置き換わらないか観測する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** ルート外である理由が利用者に返ったか記録する。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    handlers.onBrowseProviderInstructionRelativePath("codex");
    await flushAsyncHandlers();

    assert.equal(draft, settings);
    assert.match(feedback, /inside the root directory/);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "provider skill root pickerのcancelはdraftを変更せずselection canceled feedbackを返す"
  // oracle = { type = "contract", ref = "src/settings/settings-command-handlers.ts: onBrowseProviderSkillRootPath" }
  // fault = "picker cancelをpath変更または成功として扱い、古いdraftを汚す"
  // observable = "draft identityとcancel feedback"
  // observation_boundary = "public-boundary"
  // scope = "home-settings-provider-root-picker-cancel"
  // lifecycle = "permanent"
  // @end-test-value
  /** ルート選択をキャンセルすると元のドラフトを同一参照で保持し、キャンセル通知を返す。 */
  it("provider skill root picker cancel は draft を変更しない", async () => {
    const settings = createDefaultAppSettings();
    let draft: AppSettings = settings;
    let feedback = "";
    const handlers = buildSettingsCommandHandlers({
      /** ディレクトリダイアログを選択せず閉じたときのAPIを渡す。 */
      getApi: () =>
        ({
          /** キャンセルを表すnullを返す。 */
          pickDirectory: async () => null,
        }) as Partial<WithMateWindowApi> as WithMateWindowApi,
      persistedSettingsDraft: settings,
      /** 選択しなかった場合は適用済み設定の更新を扱わない。 */
      setAppSettings: () => undefined,
      /** キャンセルでもドラフトが置き換えられていないか観測する。 */
      setSettingsDraft: (nextSettings) => {
        draft = nextSettings;
      },
      /** 選択のキャンセルが通知へ届いたか記録する。 */
      setSettingsFeedback: (nextFeedback) => {
        feedback = nextFeedback;
      },
    });

    handlers.onBrowseProviderSkillRootPath("codex");
    await flushAsyncHandlers();

    assert.equal(draft, settings);
    assert.match(feedback, /selection canceled/);
  });
});
