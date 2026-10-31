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
import { HomeMateSetupPanel, type MateAvatarAction } from "../../src/mate/MateSetupPanel.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

function createMateProfile(displayName = "Mia", avatarFilePath = "avatar.png"): MateProfile {
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

function createApi(overrides: Partial<HomeMateProfileApi> = {}): HomeMateProfileApi {
  const profile = createMateProfile();
  return {
    createMate: async ({ displayName }) => createMateProfile(displayName),
    updateMate: async ({ displayName }) => createMateProfile(displayName),
    getMateState: async () => "active",
    getMateProfile: async () => profile,
    pickImageFile: async () => "next-avatar.png",
    setMateAvatar: async ({ avatarFilePath }) => createMateProfile("Mia", avatarFilePath ?? ""),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAvatarHarness(api: HomeMateProfileApi, creating = false) {
  let profile: MateProfile | null = createMateProfile("Mia", "old.png");
  let displayName = "Mia";
  let avatarAction: MateAvatarAction = null;
  let feedback = "";
  let refreshCount = 0;
  const completed = deferred<void>();
  const handlers = buildHomeMateProfileHandlers({
    getApi: () => api as WithMateWindowApi,
    mateState: "active",
    mateDisplayName: displayName,
    mateProfile: profile,
    setMateState: () => {},
    setMateProfile: (nextProfile) => { profile = nextProfile; },
    setMateDisplayName: (nextName) => { displayName = nextName; },
    setMateCreationFeedback: (message) => { feedback = message; },
    setMateProfileEditorOpen: () => {},
    setMateCreating: () => {},
    setMateAvatarAction: (action) => {
      avatarAction = action;
      if (action === null) completed.resolve();
    },
    setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
    refreshSessionSummaries: async () => { refreshCount += 1; },
  });
  return {
    handlers,
    refreshCount: () => refreshCount,
    completed: completed.promise,
    document: () => new JSDOM(renderToStaticMarkup(createElement(HomeMateSetupPanel,
      buildHomeMateSetupContentProps({
        mateState: "active",
        mateProfile: profile,
        mateDisplayName: displayName,
        mateCreating: creating,
        mateAvatarAction: avatarAction,
        mateCreationFeedback: feedback,
        ...handlers,
        onOpenSettings: () => {},
      }),
    ))).window.document,
  };
}

function assertAvatarButtons(document: Document, action: MateAvatarAction, disabled = action !== null) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".home-mate-avatar-actions button")];
  assert.equal(buttons.length, 2);
  const labels = action === "select"
    ? ["Selecting Avatar Image", "Clear Avatar"]
    : action === "clear" ? ["Select Image", "Clearing Avatar"] : ["Select Image", "Clear Avatar"];
  buttons.forEach((button, index) => {
    const busy = index === 0 ? action === "select" : action === "clear";
    assert.equal(button.getAttribute("aria-label"), labels[index]);
    assert.equal(button.getAttribute("aria-busy"), String(busy));
    assert.equal(button.disabled, disabled);
    assert.equal(button.querySelectorAll(".button-content-spinner[aria-hidden='true']").length, busy ? 1 : 0);
    assert.equal(button.querySelector(".button-content-label")?.textContent, index === 0 ? "Select Image" : "Clear");
  });
  assert.equal(document.querySelector("form")?.getAttribute("aria-busy"), String(disabled));
}

describe("home-mate-profile-actions", () => {
  it("displayName が空なら保存せず feedback を返す", async () => {
    const feedback: string[] = [];

    await saveHomeMateProfile({
      api: createApi(),
      displayName: "  ",
      mateState: "not_created",
      setMateState: () => assert.fail("setMateState should not be called"),
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      setMateDisplayName: () => assert.fail("setMateDisplayName should not be called"),
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateProfileEditorOpen: () => assert.fail("setMateProfileEditorOpen should not be called"),
      setMateCreating: () => assert.fail("setMateCreating should not be called"),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      hydrateHomeData: async () => assert.fail("hydrateHomeData should not be called"),
      clearMateGrowthViewState: () => assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.deepEqual(feedback, ["displayName を入力してね。"]);
  });

  it("Mate 作成後に profile を反映して Home data を hydrate する", async () => {
    const feedback: string[] = [];
    const creatingStates: boolean[] = [];
    let hydrated = false;
    let editorOpen = true;
    let displayName = "";

    await saveHomeMateProfile({
      api: createApi({
        createMate: async ({ displayName: nextDisplayName }) => createMateProfile(nextDisplayName),
        getMateProfile: async () => createMateProfile("Loaded Mia"),
      }),
      displayName: " Mia ",
      mateState: "not_created",
      setMateState: (state) => assert.equal(state, "active"),
      setMateProfile: (profile) => assert.equal(profile?.displayName, "Loaded Mia"),
      setMateDisplayName: (nextDisplayName) => {
        displayName = nextDisplayName;
      },
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateProfileEditorOpen: (open) => {
        editorOpen = open;
      },
      setMateCreating: (creating) => creatingStates.push(creating),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      hydrateHomeData: async () => {
        hydrated = true;
      },
      clearMateGrowthViewState: () => assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.equal(displayName, "Loaded Mia");
    assert.equal(editorOpen, false);
    assert.equal(hydrated, true);
    assert.deepEqual(creatingStates, [true, false]);
    assert.deepEqual(feedback, ["Mate 作成中...", ""]);
  });

  it("profile_unavailable では Mate 保存 API を呼ばず feedback を返す", async () => {
    const feedback: string[] = [];

    await saveHomeMateProfile({
      api: createApi({
        createMate: async () => assert.fail("createMate should not be called"),
        updateMate: async () => assert.fail("updateMate should not be called"),
      }),
      displayName: "Mia",
      mateState: "profile_unavailable",
      setMateState: () => assert.fail("setMateState should not be called"),
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      setMateDisplayName: () => assert.fail("setMateDisplayName should not be called"),
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateProfileEditorOpen: () => assert.fail("setMateProfileEditorOpen should not be called"),
      setMateCreating: () => assert.fail("setMateCreating should not be called"),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      hydrateHomeData: async () => assert.fail("hydrateHomeData should not be called"),
      clearMateGrowthViewState: () => assert.fail("clearMateGrowthViewState should not be called"),
    });

    assert.deepEqual(feedback, ["V6 Memory foundation では Mate Profile はまだ利用できません。"]);
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
  it("アイコン選択で avatar を更新して session summary を refresh する", async () => {
    const picker = deferred<string | null>();
    const update = deferred<MateProfile>();
    let avatarPath = "";
    const harness = createAvatarHarness(createApi({
      pickImageFile: async (currentPath) => {
        assert.equal(currentPath, "old.png");
        return picker.promise;
      },
      setMateAvatar: async ({ avatarFilePath }) => {
        avatarPath = avatarFilePath ?? "";
        return update.promise;
      },
    }));

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
    assert.equal(document.querySelector<HTMLInputElement>("input")?.value, "Updated Mia");
    assert.equal(harness.refreshCount(), 1);
    assert.match(document.querySelector("img")?.getAttribute("src") ?? "", /new\.png/);
    assert.equal(document.querySelector(".home-mate-feedback")?.textContent, "Mate のアイコンを更新したよ。");
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
  it("profile_unavailable では avatar 選択 API を呼ばず feedback を返す", async () => {
    const feedback: string[] = [];

    await selectHomeMateAvatar({
      api: createApi({
        pickImageFile: async () => assert.fail("pickImageFile should not be called"),
        setMateAvatar: async () => assert.fail("setMateAvatar should not be called"),
      }),
      mateState: "profile_unavailable",
      currentAvatarFilePath: "old.png",
      setMateProfile: () => assert.fail("setMateProfile should not be called"),
      setMateDisplayName: () => assert.fail("setMateDisplayName should not be called"),
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateAvatarAction: () => assert.fail("setMateAvatarAction should not be called"),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      refreshSessionSummaries: async () => assert.fail("refreshSessionSummaries should not be called"),
    });

    assert.deepEqual(feedback, ["V6 Memory foundation では Mate Profile はまだ利用できません。"]);
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
  it("アイコン解除で avatar を null に更新する", async () => {
    const update = deferred<MateProfile>();
    let avatarPath: string | null | undefined = undefined;
    const harness = createAvatarHarness(createApi({
      setMateAvatar: async ({ avatarFilePath }) => {
        avatarPath = avatarFilePath;
        return update.promise;
      },
    }));

    harness.handlers.onClearAvatar();
    assert.equal(avatarPath, null);
    assertAvatarButtons(harness.document(), "clear");
    update.resolve(createMateProfile("Mia", ""));
    await harness.completed;
    const document = harness.document();
    assert.equal(document.querySelector("img"), null);
    assert.equal(document.querySelector("[aria-label='Clear Avatar']"), null);
    const select = document.querySelector<HTMLButtonElement>("[aria-label='Select Image']");
    assert.ok(select);
    assert.equal(select.disabled, false);
    assert.equal(select.getAttribute("aria-busy"), "false");
    assert.equal(document.querySelectorAll(".button-content-spinner").length, 0);
    assert.equal(document.querySelector("form")?.getAttribute("aria-busy"), "false");
    assert.equal(harness.refreshCount(), 1);
    assert.equal(document.querySelector(".home-mate-feedback")?.textContent, "Mate のアイコンを解除したよ。");
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
  it("画像選択のキャンセルでは元のAvatarを保持してbusyを解除する", async () => {
    const picker = deferred<string | null>();
    const harness = createAvatarHarness(createApi({
      pickImageFile: () => picker.promise,
      setMateAvatar: async () => assert.fail("cancel must not save"),
    }));
    harness.handlers.onSelectAvatar();
    assertAvatarButtons(harness.document(), "select");
    picker.resolve(null);
    await harness.completed;
    const document = harness.document();
    assertAvatarButtons(document, null);
    assert.match(document.querySelector("img")?.getAttribute("src") ?? "", /old\.png/);
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
  it("picker・選択保存・解除保存の失敗でerrorと元のAvatarを保持してbusyを解除する", async () => {
    for (const stage of ["picker", "select", "clear"] as const) {
      const failure = deferred<MateProfile>();
      const picker = deferred<string | null>();
      const harness = createAvatarHarness(createApi({
        pickImageFile: () => stage === "picker" ? picker.promise : Promise.resolve("new.png"),
        setMateAvatar: () => failure.promise,
      }));
      if (stage === "clear") harness.handlers.onClearAvatar();
      else harness.handlers.onSelectAvatar();
      assertAvatarButtons(harness.document(), stage === "clear" ? "clear" : "select");
      if (stage === "picker") picker.reject(new Error("Picker failed"));
      else failure.reject(new Error("Save failed"));
      await harness.completed;
      const document = harness.document();
      assertAvatarButtons(document, null);
      assert.match(document.querySelector("img")?.getAttribute("src") ?? "", /old\.png/);
      assert.equal(document.querySelector(".home-mate-feedback")?.textContent,
        stage === "picker" ? "Picker failed" : "Save failed");
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
  it("Mate保存中はAvatar両操作をdisabledにしAvatar用spinnerは出さない", () => {
    assertAvatarButtons(createAvatarHarness(createApi(), true).document(), null, true);
  });
});
