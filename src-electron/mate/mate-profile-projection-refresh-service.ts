import type { DatabaseSync } from "node:sqlite";

import type { MateProfile } from "../../src-shared/mate/mate-state.js";
import type {
  ListProfileItemsRequest,
  MateProfileItem,
  MateProfileItemStorage,
} from "./mate-profile-item-storage.js";
import { renderMateProfileFiles } from "./mate-profile-file-renderer.js";
import type { ApplyMateProfileFilesInput } from "./mate-storage.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 現在の Mate プロフィールの取得と、投影ファイル一式の反映に必要な保存口。 */
type MateProfileProjectionStorage = {
  /** 現在の Mate プロフィールを取得し、取得できなければ null を返す。 */
  getMateProfile(): Awaitable<MateProfile | null>;
  /** Mate の投影が属するアプリのユーザーデータディレクトリを返す。 */
  getUserDataPath(): string;
  /** 投影ファイルを反映し、新しいリビジョンが有効になったプロフィールを返す。 */
  applyProfileFiles(input: ApplyMateProfileFilesInput): Promise<MateProfile>;
};

/** 投影を再生成し、項目の忘却を同じ DB トランザクションで確定するための依存先。 */
export type MateProfileProjectionRefreshServiceDeps = {
  mateStorage: MateProfileProjectionStorage;
  profileItemStorage: Pick<
    MateProfileItemStorage,
    "assertProfileItemMutationAllowed"
  > & {
    /** 再投影の入力となる項目を、指定された状態などの条件で絞って取得する。 */
    listProfileItems(
      request?: ListProfileItemsRequest,
    ): Awaitable<MateProfileItem[]>;
    /** 元の項目を忘却する前に、その内容に対応するトゥームストーンを呼び出し元のトランザクションへ追加する。 */
    createForgottenTombstoneForProfileItemInTransaction(
      db: DatabaseSync,
      item: MateProfileItem,
      redactionRevisionId?: string,
      createdAt?: string,
    ): void;
    /** 既存の項目を、再投影リビジョンの確定処理と同じトランザクションで忘却する。 */
    forgetProfileItemInTransaction(
      db: DatabaseSync,
      itemId: string,
      revisionId?: string,
      now?: string,
    ): void;
  };
};

/** プロフィール項目の忘却と、その項目を除いたファイルの再投影を調整する。 */
export class MateProfileProjectionRefreshService {
  /** プロフィールと項目の保存口を受け取り、再投影時に両方を利用する。 */
  constructor(private readonly deps: MateProfileProjectionRefreshServiceDeps) {}

  /** 有効な対象項目を除いてファイルを再生成し、その反映時に忘却を確定する。空の ID や対象なしは変更しない。 */
  async forgetProfileItemAndRefreshProjection(itemId: string): Promise<void> {
    const targetId = itemId.trim();
    if (!targetId) {
      return;
    }

    const profile = await this.deps.mateStorage.getMateProfile();
    if (!profile) {
      throw new Error("Mate が作成されていないよ。");
    }

    this.deps.profileItemStorage.assertProfileItemMutationAllowed();

    const activeProfileItems =
      await this.deps.profileItemStorage.listProfileItems({ state: "active" });
    const targetItem = activeProfileItems.find((item) => item.id === targetId);
    if (!targetItem) {
      return;
    }

    const projectedProfileItems = activeProfileItems.filter(
      (item) => item.id !== targetId,
    );
    const renderedFiles = renderMateProfileFiles(
      profile,
      projectedProfileItems,
    );

    await this.deps.mateStorage.applyProfileFiles({
      summary: `forget profile item: ${targetItem.claimKey}`,
      files: renderedFiles,
      /** 忘却のトゥームストーンを残してから項目を忘却済みにし、投影と同じリビジョンにひも付ける。 */
      finalizeInTransaction: ({ db, revisionId, now }) => {
        this.deps.profileItemStorage.createForgottenTombstoneForProfileItemInTransaction(
          db,
          targetItem,
          revisionId,
          now,
        );
        this.deps.profileItemStorage.forgetProfileItemInTransaction(
          db,
          targetId,
          revisionId,
          now,
        );
      },
    });
  }
}
