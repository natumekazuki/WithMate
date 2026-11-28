import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  saveHomeMateProfile,
  selectHomeMateAvatar,
  type HomeMateProfileApi,
} from "../../src/home/home-mate-profile-actions.js";
import { buildHomeMateProfileHandlers } from "../../src/home/home-mate-profile-handlers.js";
import { buildHomeMateSetupContentProps } from "../../src/mate/home-mate-setup-props.js";
import {
  HomeMateSetupPanel,
  type MateAvatarAction,
} from "../../src/mate/MateSetupPanel.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** 表示名と画像パスを指定できるactiveなMateの最小プロフィールを作る。 */
function createMateProfile(
  displayName = "Mia",
  avatarFilePath = "avatar.png",
): MateProfile {
  return {
    id: "mate-1",
    state: "active",
    displayName,
    description: "",
    themeMain: "#111111",
    themeSub: "#f5f5f5",
    avatarFilePath,
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    sections: [],
  };
}

/** 正常系のプロフィールAPIを揃え、ケース固有の待機やエラーだけを差し替えられるようにする。 */
function createApi(
  overrides: Partial<HomeMateProfileApi> = {},
): HomeMateProfileApi {
  const profile = createMateProfile();
  return {
    /** 作成要求の表示名を新規プロフィールへ反映する。 */
    createMate: async ({ displayName }) => createMateProfile(displayName),
    /** 更新要求の表示名を更新後のプロフィールへ反映する。 */
    updateMate: async ({ displayName }) => createMateProfile(displayName),
    /** 作成済みのMateとして現在の状態を返す。 */
    getMateState: async () => "active",
    /** 初期読込で事前に作ったプロフィールを返す。 */
    getMateProfile: async () => profile,
    /** 通常は新しい画像の選択が完了したものとする。 */
    pickImageFile: async () => "next-avatar.png",
    /** 指定画像を設定し、解除のnullは表示用の空パスへ変換して返す。 */
    setMateAvatar: async ({ avatarFilePath }) =>
      createMateProfile("Mia", avatarFilePath ?? ""),
    ...overrides,
  };
}

/** 画像選択や保存の処理を保留し、任意の時点に成功または失敗させる。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 実際のAvatar操作ハンドラーと描画propsを繋ぎ、各処理段階で表示を調べられるようにする。 */
function createAvatarHarness(api: HomeMateProfileApi, creating = false) {
  let profile: MateProfile | null = createMateProfile("Mia", "old.png");
  let displayName = "Mia";
  let avatarAction: MateAvatarAction = null;
  let feedback = "";
  let refreshCount = 0;
  const completed = deferred<void>();
  const handlers = buildHomeMateProfileHandlers({
    /** 操作ハンドラーにケース固有のAPIの代替を渡す。 */
    getApi: () => api as WithMateWindowApi,
    mateState: "active",
    mateDisplayName: displayName,
    mateProfile: profile,
    /** Avatar操作はactiveなMateの状態を前提とし、このハーネスでは状態遷移を描画しない。 */
    setMateState: () => {},
    /** 保存から返ったプロフィールを次の描画に用いる。 */
    setMateProfile: (nextProfile) => {
      profile = nextProfile;
    },
    /** 更新された表示名を次の描画に用いる。 */
    setMateDisplayName: (nextName) => {
      displayName = nextName;
    },
    /** 操作結果のメッセージをセットアップパネルに反映する。 */
    setMateCreationFeedback: (message) => {
      feedback = message;
    },
    /** Avatar側ではプロフィールエディターの開閉状態を持たない。 */
    setMateProfileEditorOpen: () => {},
    /** プロフィール作成中かどうかはハーネスの引数で固定する。 */
    setMateCreating: () => {},
    /** 選択または解除の処理中状態を保存し、解除時にはテストの待機も解く。 */
    setMateAvatarAction: (action) => {
      avatarAction = action;
      if (action === null) completed.resolve();
    },
    /** Avatar操作の通知がSession開始用の表示へ紛れたら失敗させる。 */
    setLaunchFeedback: () =>
      assert.fail("setLaunchFeedback should not be called"),
    /** 成功後にSession要約を再読込する回数を数える。 */
    refreshSessionSummaries: async () => {
      refreshCount += 1;
    },
  });
  return {
    handlers,
    /** 現在までに要求された要約再読込回数を返す。 */
    refreshCount: () => refreshCount,
    completed: completed.promise,
    /** 最新のプロフィール・操作状態でセットアップパネルを描画し、DOM属性を検査できるようにする。 */
    document: () =>
      new JSDOM(
        renderToStaticMarkup(
          createElement(
            HomeMateSetupPanel,
            buildHomeMateSetupContentProps({
              mateState: "active",
              mateProfile: profile,
              mateDisplayName: displayName,
              mateCreating: creating,
              mateAvatarAction: avatarAction,
              mateCreationFeedback: feedback,
              ...handlers,
              /** この描画では設定画面への移動は行わない。 */
              onOpenSettings: () => {},
            }),
          ),
        ),
      ).window.document,
  };
}

/** 選択と解除の各ボタンを区別し、busy・無効状態、元ラベルとspinnerが処理段階に合うか検査する。 */
function assertAvatarButtons(
  document: Document,
  action: MateAvatarAction,
  disabled = action !== null,
) {
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".home-mate-avatar-actions button",
    ),
  ];
  assert.equal(buttons.length, 2);
  const labels =
    action === "select"
      ? ["Selecting Avatar Image", "Clear Avatar"]
      : action === "clear"
        ? ["Select Image", "Clearing Avatar"]
        : ["Select Image", "Clear Avatar"];
  buttons.forEach((button, index) => {
    const busy = index === 0 ? action === "select" : action === "clear";
    assert.equal(button.getAttribute("aria-label"), labels[index]);
    assert.equal(button.getAttribute("aria-busy"), String(busy));
    assert.equal(button.disabled, disabled);
    assert.equal(
      button.querySelectorAll(".button-content-spinner[aria-hidden='true']")
        .length,
      busy ? 1 : 0,
    );
    assert.equal(
      button.querySelector(".button-content-label")?.textContent,
      index === 0 ? "Select Image" : "Clear",
    );
  });
  assert.equal(
    document.querySelector("form")?.getAttribute("aria-busy"),
    String(disabled),
  );
}

/** Mateプロフィール保存とAvatar操作の境界を、API呼出し・画面状態・処理結果から検証する。 */
describe("home-mate-profile-actions", () => {
  /** 空白だけの表示名ではプロフィールを反映せず、入力を促す通知だけを返す。 */
  it("displayName が空なら保存せず feedback を返す", async () => {
    const feedback: string[] = [];

    await saveHomeMateProfile({
      api: createApi(),
      displayName: "  ",
      mateState: "not_created",
      /** 入力不備でMateの状態を書き換えないことを検査する。 */
      setMateState: () => assert.fail("setMateState should not be called"),
      /** 入力不備でプロフィールが反映されたら失敗する。 */
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      /** 保存しない場合は表示名の編集内容を上書きしない。 */
      setMateDisplayName: () =>
        assert.fail("setMateDisplayName should not be called"),
      /** 空名に対する案内を検査できるよう記録する。 */
      setMateCreationFeedback: (message) => feedback.push(message),
      /** 入力を修正できるよう開閉状態は変えないことを確認する。 */
      setMateProfileEditorOpen: () =>
        assert.fail("setMateProfileEditorOpen should not be called"),
      /** 不正な入力で保存開始状態に入ったら失敗する。 */
      setMateCreating: () =>
        assert.fail("setMateCreating should not be called"),
      /** 入力不備はSession開始用の通知へは渡さない。 */
      setLaunchFeedback: () =>
        assert.fail("setLaunchFeedback should not be called"),
      /** 保存しなかった場合にHomeの再読込は起こさない。 */
      hydrateHomeData: async () =>
        assert.fail("hydrateHomeData should not be called"),
      /** 検証段階で成長画面の状態を消す操作は許さない。 */
      clearMateGrowthViewState: () =>
        assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.deepEqual(feedback, ["displayName を入力してね。"]);
  });

  /** 新規作成後に再取得したプロフィールで表示を更新し、編集を閉じてHomeを再読込し、処理中状態を解除する。 */
  it("Mate 作成後に profile を反映して Home data を hydrate する", async () => {
    const feedback: string[] = [];
    const creatingStates: boolean[] = [];
    let hydrated = false;
    let editorOpen = true;
    let displayName = "";

    await saveHomeMateProfile({
      api: createApi({
        /** 作成要求で受け取った表示名を反映し、作成の成功を返す。 */
        createMate: async ({ displayName: nextDisplayName }) =>
          createMateProfile(nextDisplayName),
        /** 作成応答と異なる名前を再取得時に返し、どちらが画面へ反映されたか区別する。 */
        getMateProfile: async () => createMateProfile("Loaded Mia"),
      }),
      displayName: " Mia ",
      mateState: "not_created",
      /** 作成完了時の状態がactiveであることをその場で確認する。 */
      setMateState: (state) => assert.equal(state, "active"),
      /** 読み直したプロフィールが反映されたことを確認する。 */
      setMateProfile: (profile) =>
        assert.equal(profile?.displayName, "Loaded Mia"),
      /** エディターに同期された表示名を記録する。 */
      setMateDisplayName: (nextDisplayName) => {
        displayName = nextDisplayName;
      },
      /** 作成中から完了までのプロフィール通知を順に記録する。 */
      setMateCreationFeedback: (message) => feedback.push(message),
      /** 作成後のエディター開閉状態を取り込む。 */
      setMateProfileEditorOpen: (open) => {
        editorOpen = open;
      },
      /** 処理中フラグが開始から終了へ変化した順番を記録する。 */
      setMateCreating: (creating) => creatingStates.push(creating),
      /** 作成通知がSession開始欄へ送られたら失敗する。 */
      setLaunchFeedback: () =>
        assert.fail("setLaunchFeedback should not be called"),
      /** 作成成功後にHomeの再取得まで進んだことを記録する。 */
      hydrateHomeData: async () => {
        hydrated = true;
      },
      /** 作成時に成長画面の状態を消す処理が起きないことを確認する。 */
      clearMateGrowthViewState: () =>
        assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.equal(displayName, "Loaded Mia");
    assert.equal(editorOpen, false);
    assert.equal(hydrated, true);
    assert.deepEqual(creatingStates, [true, false]);
    assert.deepEqual(feedback, ["Mate 作成中...", ""]);
  });

  /** プロフィール利用不可では作成・更新も関連画面状態の書換えもせず、その理由を返す。 */
  it("profile_unavailable では Mate 保存 API を呼ばず feedback を返す", async () => {
    const feedback: string[] = [];

    await saveHomeMateProfile({
      api: createApi({
        /** 利用不可状態で新規プロフィールAPIを呼び出したら失敗する。 */
        createMate: async () => assert.fail("createMate should not be called"),
        /** 利用不可状態で既存プロフィールの更新要求を出したら失敗する。 */
        updateMate: async () => assert.fail("updateMate should not be called"),
      }),
      displayName: "Mia",
      mateState: "profile_unavailable",
      /** 利用不可のままMateの状態を切り替えないことを確認する。 */
      setMateState: () => assert.fail("setMateState should not be called"),
      /** 取得不能なプロフィールを反映しない。 */
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      /** 表示名を上書きせず利用不可を伝えることを検査する。 */
      setMateDisplayName: () =>
        assert.fail("setMateDisplayName should not be called"),
      /** 利用できない理由がプロフィール欄へ伝わったか記録する。 */
      setMateCreationFeedback: (message) => feedback.push(message),
      /** 利用不可でエディターの状態に副作用が出たら失敗する。 */
      setMateProfileEditorOpen: () =>
        assert.fail("setMateProfileEditorOpen should not be called"),
      /** APIを使えない場合は作成中フラグを設定しない。 */
      setMateCreating: () =>
        assert.fail("setMateCreating should not be called"),
      /** プロフィール利用不可をSession開始の失敗として表示しない。 */
      setLaunchFeedback: () =>
        assert.fail("setLaunchFeedback should not be called"),
      /** 保存を拒否した後にHome再読込へ進まない。 */
      hydrateHomeData: async () =>
        assert.fail("hydrateHomeData should not be called"),
      /** 利用不可の操作で成長画面の状態を消さない。 */
      clearMateGrowthViewState: () =>
        assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.deepEqual(feedback, [
      "V6 Memory foundation では Mate Profile はまだ利用できません。",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "画像選択の開始から保存までSelect Imageだけをbusy表示し、成功後に新Avatarと操作可能状態を反映する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window / docs/design/ui-design-guidelines.md ボタン" }
  // fault = "選択actionの操作種別が表示へ渡らない、または保存完了前にbusyを解除する"
  // observable = "実handlerとprops builder経由のbuttonのspinner・名前・busy・disabled、Avatar、feedback"
  // observation_boundary = "consumer"
  // scope = "Home Avatar選択のhandler→action→state→props→component"
  // lifecycle = "permanent"
  // impact = "実行対象の誤認と重複操作を防ぎ、成功結果を確認できる"
  // distinction = "componentへ正しいbusy propsを直接渡すtestや型検査ではactionの誤帰属を検出できない"
  // @end-test-value
  /** 画像選択から保存済み結果の到着までSelectだけにspinnerを出し、成功後に新画像と表示名、要約の更新を反映する。 */
  it("アイコン選択で avatar を更新して session summary を refresh する", async () => {
    const picker = deferred<string | null>();
    const update = deferred<MateProfile>();
    let avatarPath = "";
    const harness = createAvatarHarness(
      createApi({
        /** pickerの開始パスが現在画像であることを確認し、選択結果をテスト側まで保留する。 */
        pickImageFile: async (currentPath) => {
          assert.equal(currentPath, "old.png");
          return picker.promise;
        },
        /** 選択結果が保存要求へ渡ったことを記録し、保存完了を任意の時点まで待たせる。 */
        setMateAvatar: async ({ avatarFilePath }) => {
          avatarPath = avatarFilePath ?? "";
          return update.promise;
        },
      }),
    );

    assertAvatarButtons(harness.document(), null);
    harness.handlers.onSelectAvatar();
    assertAvatarButtons(harness.document(), "select");
    picker.resolve("new.png");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(avatarPath, "new.png");
    assertAvatarButtons(harness.document(), "select");
    update.resolve(createMateProfile("Updated Mia", "new.png"));
    await harness.completed;
    const document = harness.document();
    assertAvatarButtons(document, null);
    assert.equal(
      document.querySelector<HTMLInputElement>("input")?.value,
      "Updated Mia",
    );
    assert.equal(harness.refreshCount(), 1);
    assert.match(
      document.querySelector("img")?.getAttribute("src") ?? "",
      /new\.png/,
    );
    assert.equal(
      document.querySelector(".home-mate-feedback")?.textContent,
      "Mate のアイコンを更新したよ。",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Mate Profile利用不可ではAvatar選択・保存APIやbusy更新を実行せず理由を返す"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window" }
  // fault = "利用不可のMateにAvatar更新要求を送る"
  // observable = "API・state更新callback未呼出しとfeedback"
  // observation_boundary = "consumer"
  // scope = "Home Avatar編集の利用可否"
  // lifecycle = "permanent"
  // @end-test-value
  /** Mate Profile利用不可の場合は画像pickerも保存も開始せず、操作不能の案内だけを返す。 */
  it("profile_unavailable では avatar 選択 API を呼ばず feedback を返す", async () => {
    const feedback: string[] = [];

    await selectHomeMateAvatar({
      api: createApi({
        /** 利用不可のMateで画像選択画面を開いたら失敗する。 */
        pickImageFile: async () =>
          assert.fail("pickImageFile should not be called"),
        /** 利用できないプロフィールに画像更新を送らない。 */
        setMateAvatar: async () =>
          assert.fail("setMateAvatar should not be called"),
      }),
      mateState: "profile_unavailable",
      currentAvatarFilePath: "old.png",
      /** 更新を開始しないのでプロフィールを置き換えない。 */
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      /** 画像を変えられない場合に表示名まで上書きしない。 */
      setMateDisplayName: () =>
        assert.fail("setMateDisplayName should not be called"),
      /** Avatar操作を開始できない理由を画面通知として捕捉する。 */
      setMateCreationFeedback: (message) => feedback.push(message),
      /** 利用不可の場合にAvatarのbusy状態へ入ったら失敗する。 */
      setMateAvatarAction: () =>
        assert.fail("setMateAvatarAction should not be called"),
      /** Avatarの案内がSession開始欄へ漏れないことを検査する。 */
      setLaunchFeedback: () =>
        assert.fail("setLaunchFeedback should not be called"),
      /** 保存しないのでSession要約の更新も要求しない。 */
      refreshSessionSummaries: async () =>
        assert.fail("refreshSessionSummaries should not be called"),
    });

    assert.deepEqual(feedback, [
      "V6 Memory foundation では Mate Profile はまだ利用できません。",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Avatar解除中はClearだけをbusy表示し、成功後にAvatarとClear操作を除きbusyを解除する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window / docs/design/ui-design-guidelines.md ボタン" }
  // fault = "Clear actionをSelect Imageのbusyとして表示するか成功結果を反映しない"
  // observable = "実handlerとprops builder経由のbuttonのspinner・名前・busy・disabled、Avatarとfeedback"
  // observation_boundary = "consumer"
  // scope = "Home Avatar解除のhandler→action→state→props→component"
  // lifecycle = "permanent"
  // impact = "解除中の誤認を防ぎ、完了後の操作を実際のAvatar有無に合わせる"
  // distinction = "選択と同じbooleanに戻る欠陥は型検査やcomponent単体のprops注入だけでは保証できない"
  // @end-test-value
  /** Clearはnullを保存し、待機中は解除だけをbusyにする。完了後は画像とClearを除き、選択ボタンを再び使えるようにする。 */
  it("アイコン解除で avatar を null に更新する", async () => {
    const update = deferred<MateProfile>();
    let avatarPath: string | null | undefined = undefined;
    const harness = createAvatarHarness(
      createApi({
        /** 解除が渡すnullを記録し、保存が終わるまでは解除中の表示を観測する。 */
        setMateAvatar: async ({ avatarFilePath }) => {
          avatarPath = avatarFilePath;
          return update.promise;
        },
      }),
    );

    harness.handlers.onClearAvatar();
    assert.equal(avatarPath, null);
    assertAvatarButtons(harness.document(), "clear");
    update.resolve(createMateProfile("Mia", ""));
    await harness.completed;
    const document = harness.document();
    assert.equal(document.querySelector("img"), null);
    assert.equal(document.querySelector("[aria-label='Clear Avatar']"), null);
    const select = document.querySelector<HTMLButtonElement>(
      "[aria-label='Select Image']",
    );
    assert.ok(select);
    assert.equal(select.disabled, false);
    assert.equal(select.getAttribute("aria-busy"), "false");
    assert.equal(
      document.querySelectorAll(".button-content-spinner").length,
      0,
    );
    assert.equal(
      document.querySelector("form")?.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(harness.refreshCount(), 1);
    assert.equal(
      document.querySelector(".home-mate-feedback")?.textContent,
      "Mate のアイコンを解除したよ。",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "画像選択をキャンセルすると保存せず元のAvatarと操作可能状態に戻る"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md Home Window" }
  // fault = "pickerキャンセルでbusyが残るか元のAvatarを失う"
  // observable = "キャンセル後のAvatar、feedback、buttonのbusy・disabled"
  // observation_boundary = "consumer"
  // scope = "Home Avatar選択キャンセル"
  // lifecycle = "permanent"
  // @end-test-value
  /** 画像pickerのキャンセルは保存もエラー表示もせず、元画像を維持して両操作を再度使えるようにする。 */
  it("画像選択のキャンセルでは元のAvatarを保持してbusyを解除する", async () => {
    const picker = deferred<string | null>();
    const harness = createAvatarHarness(
      createApi({
        /** 選択結果を保留し、処理中を検査してからキャンセルとして解決する。 */
        pickImageFile: () => picker.promise,
        /** キャンセル後に保存へ進んだ場合は失敗する。 */
        setMateAvatar: async () => assert.fail("cancel must not save"),
      }),
    );
    harness.handlers.onSelectAvatar();
    assertAvatarButtons(harness.document(), "select");
    picker.resolve(null);
    await harness.completed;
    const document = harness.document();
    assertAvatarButtons(document, null);
    assert.match(
      document.querySelector("img")?.getAttribute("src") ?? "",
      /old\.png/,
    );
    assert.equal(document.querySelector(".home-mate-feedback"), null);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Avatar選択・解除の失敗では元のAvatarと失敗理由を保持し両操作を再び利用できる"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md ボタン / フィードバックとmotion" }
  // fault = "失敗を成功扱いするかbusyを解除せず再操作不能にする"
  // observable = "picker・選択保存・解除保存の拒否後のbutton、Avatar、error feedback"
  // observation_boundary = "consumer"
  // scope = "Home Avatar操作の失敗終端"
  // lifecycle = "permanent"
  // @end-test-value
  /** picker・選択保存・解除保存それぞれの失敗を、元画像とエラーを残しながらbusyを解除する結果へ収束させる。 */
  it("picker・選択保存・解除保存の失敗でerrorと元のAvatarを保持してbusyを解除する", async () => {
    for (const stage of ["picker", "select", "clear"] as const) {
      const failure = deferred<MateProfile>();
      const picker = deferred<string | null>();
      const harness = createAvatarHarness(
        createApi({
          /** pickerの失敗ケースだけ選択応答を保留し、保存失敗ケースでは新画像が選ばれた状態を作る。 */
          pickImageFile: () =>
            stage === "picker" ? picker.promise : Promise.resolve("new.png"),
          /** 画像選択後と解除時の保存が任意の時点で失敗するように保留する。 */
          setMateAvatar: () => failure.promise,
        }),
      );
      if (stage === "clear") harness.handlers.onClearAvatar();
      else harness.handlers.onSelectAvatar();
      assertAvatarButtons(
        harness.document(),
        stage === "clear" ? "clear" : "select",
      );
      if (stage === "picker") picker.reject(new Error("Picker failed"));
      else failure.reject(new Error("Save failed"));
      await harness.completed;
      const document = harness.document();
      assertAvatarButtons(document, null);
      assert.match(
        document.querySelector("img")?.getAttribute("src") ?? "",
        /old\.png/,
      );
      assert.equal(
        document.querySelector(".home-mate-feedback")?.textContent,
        stage === "picker" ? "Picker failed" : "Save failed",
      );
    }
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Mate保存中のAvatar操作はdisabledだがAvatar更新のbusyとは区別する"
  // oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md ボタン" }
  // fault = "creatingによる操作制限を外すかAvatar処理中と誤表示する"
  // observable = "Avatar buttonのdisabled・aria-busy・spinner"
  // observation_boundary = "component-behavior"
  // scope = "Mate保存とAvatar操作の状態境界"
  // lifecycle = "permanent"
  // @end-test-value
  /** Mate本体の保存中は画像の選択と解除を両方無効にし、Avatar処理を示すspinnerは表示しない。 */
  it("Mate保存中はAvatar両操作をdisabledにしAvatar用spinnerは出さない", () => {
    assertAvatarButtons(
      createAvatarHarness(createApi(), true).document(),
      null,
      true,
    );
  });
});
