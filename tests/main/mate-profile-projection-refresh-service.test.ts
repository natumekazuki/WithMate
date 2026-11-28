import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type { MateProfileItem } from "../../src-electron/mate/mate-profile-item-storage.js";
import { MateProfileProjectionRefreshService } from "../../src-electron/mate/mate-profile-projection-refresh-service.js";
import type { ApplyMateProfileFilesInput } from "../../src-electron/mate/mate-storage.js";

/** 対象の忘却と削除記録を同じリビジョンに結び、投影ファイルから対象だけを除く。 */
test("forgetProfileItemAndRefreshProjection は対象 item を除いた Mate files を作る", async () => {
  const profile = createProfile();
  const targetItem = createItem({
    id: "item-forget",
    claimKey: "nickname",
    renderedText: "忘れる内容",
  });
  const keptItem = createItem({
    id: "item-keep",
    claimKey: "tone",
    renderedText: "残す内容",
  });
  const forgetCalls: Array<{
    itemId: string;
    revisionId?: string;
    now?: string;
  }> = [];
  const tombstoneCalls: Array<{
    itemId: string;
    revisionId?: string;
    now?: string;
  }> = [];
  const appliedInputs: ApplyMateProfileFilesInput[] = [];

  const service = new MateProfileProjectionRefreshService({
    mateStorage: {
      /** 更新前のリビジョンを持つプロフィールを返す。 */
      getMateProfile: () => profile,
      /** 投影先のルートを、実ファイルを作らずに指定する。 */
      getUserDataPath: () => "user-data",
      /** 生成入力を捕捉し、確定処理に新しいリビジョンと時刻を渡す。 */
      applyProfileFiles: async (input) => {
        appliedInputs.push(input);
        input.finalizeInTransaction?.({
          db: {} as DatabaseSync,
          revisionId: "rev-forget",
          now: "2026-05-10T00:00:00.000Z",
        });
        return {
          ...profile,
          activeRevisionId: "rev-forget",
          profileGeneration: 2,
        };
      },
    },
    profileItemStorage: {
      /** 変異可否は本ケースの対象外なので、忘却の処理を許可する。 */
      assertProfileItemMutationAllowed: () => {},
      /** 忘却対象と、再投影で保持する項目を返す。 */
      listProfileItems: () => [targetItem, keptItem],
      /** 削除記録が対象を正しいリビジョンと時刻に結び付けるか照合できるようにする。 */
      createForgottenTombstoneForProfileItemInTransaction: (
        _db,
        item,
        revisionId,
        now,
      ) => {
        tombstoneCalls.push({ itemId: item.id, revisionId, now });
      },
      /** 項目の忘却に渡された識別子と確定情報を記録する。 */
      forgetProfileItemInTransaction: (_db, itemId, revisionId, now) => {
        forgetCalls.push({ itemId, revisionId, now });
      },
    },
  });

  await service.forgetProfileItemAndRefreshProjection("item-forget");

  assert.equal(appliedInputs.length, 1);
  assert.equal(appliedInputs[0].summary, "forget profile item: nickname");
  assert.equal(appliedInputs[0].files.length, 4);
  const coreFile = appliedInputs[0].files.find(
    (file) => file.sectionKey === "core",
  );
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
});

/** 更新前リビジョンに各セクションがそろった有効な Mate プロフィールを作る。 */
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

/** 既存ファイルのパスと更新リビジョンを含むセクションを作る。 */
function createSection(
  sectionKey: MateProfile["sections"][number]["sectionKey"],
  filePath: string,
): MateProfile["sections"][number] {
  return {
    sectionKey,
    filePath,
    sha256: "sha",
    byteSize: 1,
    updatedByRevisionId: "rev-1",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

/** 指定項目以外は、core に投影できる有効な項目の値で補う。 */
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
