export type PersistentStoreOwnerGuard<T> = {
  owner: T;
  assertActive(operation: string): void;
};

export function capturePersistentStoreOwner<T>(
  getActiveOwner: () => T | null,
  ownerName: string,
): PersistentStoreOwnerGuard<T> {
  const owner = getActiveOwner();
  if (owner === null) {
    throw new Error(`${ownerName} は永続storeの初期化完了後に作成してください。`);
  }
  return {
    owner,
    assertActive(operation) {
      if (getActiveOwner() !== owner) {
        throw new Error(`${operation} は古い永続store世代から実行できません。`);
      }
    },
  };
}

export function assertPersistentStoreOwnerActive<T>(
  getActiveOwner: () => T | null,
  owner: T,
  operation: string,
): void {
  if (getActiveOwner() !== owner) {
    throw new Error(`${operation} は古い永続store世代から実行できません。`);
  }
}
