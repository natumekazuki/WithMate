/** 永続ストアを利用する処理が、取得時と同じ所有者に属しているか確認するための参照。 */
export type PersistentStoreOwnerGuard<T> = {
  owner: T;
  /** 対象の操作を開始する前に、取得した所有者が現役でなければ例外を投げる。 */
  assertActive(operation: string): void;
};

/** 初期化済みの所有者を取得し、再作成などによる世代交代を検出するガードを返す。 */
export function capturePersistentStoreOwner<T>(
  getActiveOwner: () => T | null,
  ownerName: string,
): PersistentStoreOwnerGuard<T> {
  const owner = getActiveOwner();
  if (owner === null) {
    throw new Error(
      `${ownerName} は永続storeの初期化完了後に作成してください。`,
    );
  }
  return {
    owner,
    /** 取得時の所有者を現在の所有者と同一性で比較する。 */
    assertActive(operation) {
      if (getActiveOwner() !== owner) {
        throw new Error(`${operation} は古い永続store世代から実行できません。`);
      }
    },
  };
}

/** 既に保持している所有者で操作を続行できるか確認し、世代が変わっていれば拒否する。 */
export function assertPersistentStoreOwnerActive<T>(
  getActiveOwner: () => T | null,
  owner: T,
  operation: string,
): void {
  if (getActiveOwner() !== owner) {
    throw new Error(`${operation} は古い永続store世代から実行できません。`);
  }
}
