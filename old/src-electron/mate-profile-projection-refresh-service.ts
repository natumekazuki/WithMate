import type { DatabaseSync } from "node:sqlite";

import type { MateProfile } from "../src/mate/mate-state.js";
import type { MateProfileItem, MateProfileItemStorage } from "./mate-profile-item-storage.js";
import { renderMateProfileFiles } from "./mate-profile-file-renderer.js";
import type { ApplyMateProfileFilesInput } from "./mate-storage.js";

type MateProfileProjectionStorage = {
  getMateProfile(): MateProfile | null;
  getUserDataPath(): string;
  applyProfileFiles(input: ApplyMateProfileFilesInput): Promise<MateProfile>;
};

export type MateProfileProjectionRefreshServiceDeps = {
  mateStorage: MateProfileProjectionStorage;
  profileItemStorage: Pick<MateProfileItemStorage, "assertProfileItemMutationAllowed" | "listProfileItems"> & {
    createForgottenTombstoneForProfileItemInTransaction(
      db: DatabaseSync,
      item: MateProfileItem,
      redactionRevisionId?: string,
      createdAt?: string,
    ): void;
    forgetProfileItemInTransaction(
      db: DatabaseSync,
      itemId: string,
      revisionId?: string,
      now?: string,
    ): void;
  };
};

export class MateProfileProjectionRefreshService {
  constructor(private readonly deps: MateProfileProjectionRefreshServiceDeps) {}

  async forgetProfileItemAndRefreshProjection(itemId: string): Promise<void> {
    const targetId = itemId.trim();
    if (!targetId) {
      return;
    }

    const profile = this.deps.mateStorage.getMateProfile();
    if (!profile) {
      throw new Error("Mate が作成されていないよ。");
    }

    this.deps.profileItemStorage.assertProfileItemMutationAllowed();

    const activeProfileItems = this.deps.profileItemStorage.listProfileItems({ state: "active" });
    const targetItem = activeProfileItems.find((item) => item.id === targetId);
    if (!targetItem) {
      return;
    }

    const projectedProfileItems = activeProfileItems.filter((item) => item.id !== targetId);
    const renderedFiles = renderMateProfileFiles(profile, projectedProfileItems);

    await this.deps.mateStorage.applyProfileFiles({
      summary: `forget profile item: ${targetItem.claimKey}`,
      files: renderedFiles,
      finalizeInTransaction: ({ db, revisionId, now }) => {
        this.deps.profileItemStorage.createForgottenTombstoneForProfileItemInTransaction(
          db,
          targetItem,
          revisionId,
          now,
        );
        this.deps.profileItemStorage.forgetProfileItemInTransaction(db, targetId, revisionId, now);
      },
    });
  }
}
