/** 開いている Session ウィンドウの初回一覧が未取得・取得済み・取得失敗のいずれかを示す。 */
export type OpenSessionWindowIdsLoadStatus = "loading" | "loaded" | "error";

/** 取得状態と Session ID の一覧。取得済みの空一覧と取得失敗は状態で区別する。 */
export type OpenSessionWindowIdsState = {
  status: OpenSessionWindowIdsLoadStatus;
  sessionIds: string[];
};

/** 開いている Session の一覧の取得と、その後の一覧変更の購読に使う API。 */
export type OpenSessionWindowIdsSubscriptionApi = {
  listOpenSessionWindowIds: () => Promise<string[]>;
  subscribeOpenSessionWindowIds: (
    listener: (sessionIds: string[]) => void,
  ) => () => void;
};

/** 変更通知を先に購読し、通知が届いていない場合だけ初回の一覧または失敗を反映する。 */
export function startOpenSessionWindowIdsSubscription(input: {
  api: OpenSessionWindowIdsSubscriptionApi | null;
  applyState: (state: OpenSessionWindowIdsState) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;

  if (!input.api) {
    return () => {
      active = false;
    };
  }

  /** 初回読み取りと変更通知のどちらも、取得済みの一覧として発行する。 */
  const applyLoadedState = (sessionIds: string[]) => {
    input.applyState({ status: "loaded", sessionIds });
  };
  const unsubscribe = input.api.subscribeOpenSessionWindowIds(
    (nextSessionIds) => {
      if (!active) {
        return;
      }

      receivedSubscriptionUpdate = true;
      applyLoadedState(nextSessionIds);
    },
  );

  void input.api
    .listOpenSessionWindowIds()
    .then((nextSessionIds) => {
      if (!active || receivedSubscriptionUpdate) {
        return;
      }

      applyLoadedState(nextSessionIds);
    })
    .catch(() => {
      if (!active || receivedSubscriptionUpdate) {
        return;
      }

      input.applyState({ status: "error", sessionIds: [] });
    });

  return () => {
    active = false;
    unsubscribe();
  };
}
