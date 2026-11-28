import type {
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";

/** ワークスペースを指定できるカタログ取得と、対応している場合の変更購読。 */
export type ModelCatalogSubscriptionApi = {
  getModelCatalog: (
    request?: ModelCatalogRequest,
  ) => Promise<ModelCatalogSnapshot | null>;
  subscribeModelCatalog?: (
    listener: (catalog: ModelCatalogSnapshot) => void,
  ) => () => void;
};

/** 末尾の区切りを除いてワークスペースパスを比較し、Windows 形式では区切りと大小文字もそろえる。 */
export function isSameModelCatalogWorkspace(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return left === right;
  /** ドライブ・UNC 形式だけを大文字小文字非依存にする比較キーを作る。 */
  const key = (workspacePath: string) => {
    const windowsPath = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(workspacePath);
    const normalized = (
      windowsPath ? workspacePath.replace(/\\/g, "/") : workspacePath
    ).replace(/\/+$/, "");
    return windowsPath ? normalized.toLowerCase() : normalized;
  };
  return key(left) === key(right);
}

/** 指定ワークスペースと一致するカタログだけを受け付け、先に届いた購読通知を初回取得より優先する。 */
export function startModelCatalogSubscription(input: {
  api: ModelCatalogSubscriptionApi | null;
  enabled: boolean;
  subscribe: boolean;
  workspacePath?: string;
  applyModelCatalog: (snapshot: ModelCatalogSnapshot | null) => void;
  onInitialLoadError?: (error: unknown) => void;
}): () => void {
  let active = true;
  let receivedNotification = false;

  if (!input.api || !input.enabled) {
    return () => {
      active = false;
    };
  }

  void input.api
    .getModelCatalog(
      input.workspacePath ? { workspacePath: input.workspacePath } : undefined,
    )
    .then((snapshot) => {
      if (
        snapshot &&
        input.workspacePath &&
        !isSameModelCatalogWorkspace(
          snapshot.workspacePath,
          input.workspacePath,
        )
      )
        return;
      if (active && !receivedNotification) input.applyModelCatalog(snapshot);
    })
    .catch((error: unknown) => {
      if (active && !receivedNotification) {
        input.onInitialLoadError?.(error);
      }
    });

  const unsubscribe =
    input.subscribe && input.api.subscribeModelCatalog
      ? input.api.subscribeModelCatalog((snapshot) => {
          if (!active) return;
          if (
            input.workspacePath &&
            !isSameModelCatalogWorkspace(
              snapshot.workspacePath,
              input.workspacePath,
            )
          )
            return;
          receivedNotification = true;
          input.applyModelCatalog(snapshot);
        })
      : null;

  return () => {
    active = false;
    unsubscribe?.();
  };
}
