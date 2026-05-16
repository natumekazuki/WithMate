import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

import type { MateProfile } from "../../src/mate/mate-state.js";
import type { MateProfileItem } from "../../src-electron/mate-profile-item-storage.js";
import { MateProfileProjectionRefreshService } from "../../src-electron/mate-profile-projection-refresh-service.js";
import type { ApplyMateProfileFilesInput } from "../../src-electron/mate-storage.js";

test("forgetProfileItemAndRefreshProjection は対象 item を除いた Mate files を作り provider instruction を同期する", async () => {
  const profile = createProfile();
  const targetItem = createItem({ id: "item-forget", claimKey: "nickname", renderedText: "忘れる内容" });
  const keptItem = createItem({ id: "item-keep", claimKey: "tone", renderedText: "残す内容" });
  const forgetCalls: Array<{ itemId: string; revisionId?: string; now?: string }> = [];
  const tombstoneCalls: Array<{ itemId: string; revisionId?: string; now?: string }> = [];
  const appliedInputs: ApplyMateProfileFilesInput[] = [];
  const syncedRevisionIds: Array<string | null> = [];

  const service = new MateProfileProjectionRefreshService({
    mateStorage: {
      getMateProfile: () => profile,
      getUserDataPath: () => "user-data",
      applyProfileFiles: async (input) => {
        appliedInputs.push(input);
        input.finalizeInTransaction?.({
          db: {} as DatabaseSync,
          revisionId: "rev-forget",
          now: "2026-05-10T00:00:00.000Z",
        });
        return { ...profile, activeRevisionId: "rev-forget", profileGeneration: 2 };
      },
    },
    profileItemStorage: {
      assertProfileItemMutationAllowed: () => {},
      listProfileItems: () => [targetItem, keptItem],
      createForgottenTombstoneForProfileItemInTransaction: (_db, item, revisionId, now) => {
        tombstoneCalls.push({ itemId: item.id, revisionId, now });
      },
      forgetProfileItemInTransaction: (_db, itemId, revisionId, now) => {
        forgetCalls.push({ itemId, revisionId, now });
      },
    },
    providerInstructionSyncer: {
      syncEnabledProviderInstructionTargetsForMateProfile: async (updatedProfile) => {
        syncedRevisionIds.push(updatedProfile.activeRevisionId);
      },
    },
  });

  await service.forgetProfileItemAndRefreshProjection("item-forget");

  assert.equal(appliedInputs.length, 1);
  assert.equal(appliedInputs[0].summary, "forget profile item: nickname");
  assert.equal(appliedInputs[0].files.length, 4);
  const coreFile = appliedInputs[0].files.find((file) => file.sectionKey === "core");
  assert.ok(coreFile);
  assert.match(coreFile.content, /残す内容/);
  assert.doesNotMatch(coreFile.content, /忘れる内容/);
  assert.deepEqual(forgetCalls, [
    {
      itemId: "item-forget",
      revisionId: "rev-forget",
      now: "2026-05-10T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(tombstoneCalls, [
    {
      itemId: "item-forget",
      revisionId: "rev-forget",
      now: "2026-05-10T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(syncedRevisionIds, ["rev-forget"]);
});

test("forgetProfileItemAndRefreshProjection は project digest item の Markdown 投影も更新する", async () => {
  const profile = createProfile();
  const targetItem = createItem({
    id: "project-item-forget",
    sectionKey: "project_digest",
    projectDigestId: "digest-1",
    category: "project_context",
    claimKey: "old",
    renderedText: "忘れるProject情報",
  });
  const keptItem = createItem({
    id: "project-item-keep",
    sectionKey: "project_digest",
    projectDigestId: "digest-1",
    category: "project_context",
    claimKey: "new",
    renderedText: "残すProject情報",
  });
  const rewrittenContents: string[] = [];

  const service = new MateProfileProjectionRefreshService({
    mateStorage: {
      getMateProfile: () => profile,
      getUserDataPath: () => "user-data",
      applyProfileFiles: async (input) => {
        input.finalizeInTransaction?.({
          db: {} as DatabaseSync,
          revisionId: "rev-project-forget",
          now: "2026-05-10T00:00:00.000Z",
        });
        return { ...profile, activeRevisionId: "rev-project-forget", profileGeneration: 2 };
      },
    },
    profileItemStorage: {
      assertProfileItemMutationAllowed: () => {},
      listProfileItems: () => [targetItem, keptItem],
      createForgottenTombstoneForProfileItemInTransaction: () => {},
      forgetProfileItemInTransaction: () => {},
    },
    projectDigestProjectionWriter: {
      rewriteProjectDigestProjection: async (input) => {
        rewrittenContents.push(input.content);
        return {
          digestFilePath: "mate/project-digests/digest-1.md",
          sha256: "sha",
          byteSize: input.content.length,
          lastCompiledAt: "2026-05-10T00:00:00.000Z",
          updatedAt: "2026-05-10T00:00:00.000Z",
        };
      },
    },
  });

  await service.forgetProfileItemAndRefreshProjection("project-item-forget");

  assert.equal(rewrittenContents.length, 1);
  assert.match(rewrittenContents[0], /残すProject情報/);
  assert.doesNotMatch(rewrittenContents[0], /忘れるProject情報/);
});

test("forgetProfileItemAndRefreshProjection は project digest 投影更新に失敗したら item を forgotten にしない", async () => {
  const profile = createProfile();
  const targetItem = createItem({
    id: "project-item-forget",
    sectionKey: "project_digest",
    projectDigestId: "digest-1",
    category: "project_context",
    claimKey: "old",
    renderedText: "忘れるProject情報",
  });
  const keptItem = createItem({
    id: "project-item-keep",
    sectionKey: "project_digest",
    projectDigestId: "digest-1",
    category: "project_context",
    claimKey: "new",
    renderedText: "残すProject情報",
  });
  let applyProfileFilesCalled = false;
  let forgetCalled = false;

  const service = new MateProfileProjectionRefreshService({
    mateStorage: {
      getMateProfile: () => profile,
      getUserDataPath: () => "user-data",
      applyProfileFiles: async () => {
        applyProfileFilesCalled = true;
        return profile;
      },
    },
    profileItemStorage: {
      assertProfileItemMutationAllowed: () => {},
      listProfileItems: () => [targetItem, keptItem],
      createForgottenTombstoneForProfileItemInTransaction: () => {},
      forgetProfileItemInTransaction: () => {
        forgetCalled = true;
      },
    },
    projectDigestProjectionWriter: {
      rewriteProjectDigestProjection: async () => {
        throw new Error("project digest rewrite failed");
      },
    },
  });

  await assert.rejects(
    () => service.forgetProfileItemAndRefreshProjection("project-item-forget"),
    /project digest rewrite failed/,
  );

  assert.equal(applyProfileFilesCalled, false);
  assert.equal(forgetCalled, false);
});

test("forgetProfileItemAndRefreshProjection は provider instruction 同期失敗を呼び出し元へ伝える", async () => {
  const profile = createProfile();
  const targetItem = createItem({ id: "item-forget", claimKey: "nickname", renderedText: "忘れる内容" });
  const keptItem = createItem({ id: "item-keep", claimKey: "tone", renderedText: "残す内容" });

  const service = new MateProfileProjectionRefreshService({
    mateStorage: {
      getMateProfile: () => profile,
      getUserDataPath: () => "user-data",
      applyProfileFiles: async (input) => {
        input.finalizeInTransaction?.({
          db: {} as DatabaseSync,
          revisionId: "rev-forget",
          now: "2026-05-10T00:00:00.000Z",
        });
        return { ...profile, activeRevisionId: "rev-forget", profileGeneration: 2 };
      },
    },
    profileItemStorage: {
      assertProfileItemMutationAllowed: () => {},
      listProfileItems: () => [targetItem, keptItem],
      createForgottenTombstoneForProfileItemInTransaction: () => {},
      forgetProfileItemInTransaction: () => {},
    },
    providerInstructionSyncer: {
      syncEnabledProviderInstructionTargetsForMateProfile: async () => {
        throw new Error("provider sync failed");
      },
    },
  });

  await assert.rejects(
    () => service.forgetProfileItemAndRefreshProjection("item-forget"),
    /provider sync failed/,
  );
});

function createProfile(): MateProfile {
  const now = "2026-05-10T00:00:00.000Z";
  return {
    id: "current",
    state: "active",
    displayName: "Mate",
    description: "test mate",
    themeMain: "#111111",
    themeSub: "#eeeeee",
    avatarFilePath: "",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: "rev-1",
    profileGeneration: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    sections: [
      createSection("core", "mate/core.md"),
      createSection("bond", "mate/bond.md"),
      createSection("work_style", "mate/work-style.md"),
      createSection("notes", "mate/notes.md"),
      createSection("project_digest", "mate/project-digests.md"),
    ],
  };
}

function createSection(sectionKey: MateProfile["sections"][number]["sectionKey"], filePath: string): MateProfile["sections"][number] {
  return {
    sectionKey,
    filePath,
    sha256: "sha",
    byteSize: 1,
    updatedByRevisionId: "rev-1",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

function createItem(overrides: Partial<MateProfileItem>): MateProfileItem {
  const now = "2026-05-10T00:00:00.000Z";
  return {
    id: overrides.id ?? "item",
    sectionKey: overrides.sectionKey ?? "core",
    projectDigestId: overrides.projectDigestId ?? null,
    category: overrides.category ?? "persona",
    claimKey: overrides.claimKey ?? "claim",
    claimValue: overrides.claimValue ?? overrides.renderedText ?? "value",
    claimValueNormalized: overrides.claimValueNormalized ?? "value",
    renderedText: overrides.renderedText ?? "value",
    normalizedClaim: overrides.normalizedClaim ?? "value",
    confidence: overrides.confidence ?? 80,
    salienceScore: overrides.salienceScore ?? 80,
    recurrenceCount: overrides.recurrenceCount ?? 1,
    projectionAllowed: overrides.projectionAllowed ?? true,
    state: overrides.state ?? "active",
    firstSeenAt: overrides.firstSeenAt ?? now,
    lastSeenAt: overrides.lastSeenAt ?? now,
    createdRevisionId: overrides.createdRevisionId ?? "rev-1",
    updatedRevisionId: overrides.updatedRevisionId ?? null,
    disabledRevisionId: overrides.disabledRevisionId ?? null,
    forgottenRevisionId: overrides.forgottenRevisionId ?? null,
    disabledAt: overrides.disabledAt ?? null,
    forgottenAt: overrides.forgottenAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    tags: overrides.tags ?? [],
  };
}
