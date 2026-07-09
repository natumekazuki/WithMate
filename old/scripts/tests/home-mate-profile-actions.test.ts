import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearHomeMateAvatar,
  saveHomeMateProfile,
  selectHomeMateAvatar,
  type HomeMateProfileApi,
} from "../../src/home/home-mate-profile-actions.js";
import type { MateProfile } from "../../src/mate/mate-state.js";

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

  it("アイコン選択で avatar を更新して session summary を refresh する", async () => {
    const feedback: string[] = [];
    const updatingStates: boolean[] = [];
    let refreshed = false;
    let avatarPath = "";

    await selectHomeMateAvatar({
      api: createApi({
        pickImageFile: async (currentPath) => {
          assert.equal(currentPath, "old.png");
          return "new.png";
        },
        setMateAvatar: async ({ avatarFilePath }) => {
          avatarPath = avatarFilePath ?? "";
          return createMateProfile("Mia", avatarFilePath ?? "");
        },
      }),
      mateState: "active",
      currentAvatarFilePath: "old.png",
      setMateProfile: (profile) => assert.equal(profile.avatarFilePath, "new.png"),
      setMateDisplayName: (displayName) => assert.equal(displayName, "Mia"),
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateAvatarUpdating: (updating) => updatingStates.push(updating),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      refreshSessionSummaries: async () => {
        refreshed = true;
      },
    });

    assert.equal(avatarPath, "new.png");
    assert.equal(refreshed, true);
    assert.deepEqual(updatingStates, [true, false]);
    assert.deepEqual(feedback, ["", "Mate のアイコンを更新中...", "Mate のアイコンを更新したよ。"]);
  });

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
      setMateAvatarUpdating: () => assert.fail("setMateAvatarUpdating should not be called"),
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      refreshSessionSummaries: async () => assert.fail("refreshSessionSummaries should not be called"),
    });

    assert.deepEqual(feedback, ["V6 Memory foundation では Mate Profile はまだ利用できません。"]);
  });

  it("アイコン解除で avatar を null に更新する", async () => {
    const feedback: string[] = [];
    let avatarPath: string | null | undefined = undefined;

    await clearHomeMateAvatar({
      api: createApi({
        setMateAvatar: async ({ avatarFilePath }) => {
          avatarPath = avatarFilePath;
          return createMateProfile("Mia", "");
        },
      }),
      mateState: "active",
      currentAvatarFilePath: "old.png",
      setMateProfile: (profile) => assert.equal(profile.avatarFilePath, ""),
      setMateDisplayName: (displayName) => assert.equal(displayName, "Mia"),
      setMateCreationFeedback: (message) => feedback.push(message),
      setMateAvatarUpdating: () => {},
      setLaunchFeedback: () => assert.fail("setLaunchFeedback should not be called"),
      refreshSessionSummaries: async () => {},
    });

    assert.equal(avatarPath, null);
    assert.deepEqual(feedback, ["Mate のアイコンを解除中...", "Mate のアイコンを解除したよ。"]);
  });
});
