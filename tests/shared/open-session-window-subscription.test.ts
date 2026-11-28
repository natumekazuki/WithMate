import assert from "node:assert/strict";
import test from "node:test";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
  type OpenSessionWindowIdsSubscriptionApi,
} from "../../src/app/open-session-window-subscription.js";

/** 一覧取得の Promise に登録された処理が走るよう、マイクロタスクの境界まで待つ。 */
const flushPromises = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

/** 通知なしでも、初回の一覧取得が成功すれば返された ID を loaded として反映する。 */
test("open Session Window 一覧の初回取得成功を loaded として反映する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const api: OpenSessionWindowIdsSubscriptionApi = {
    /** 最初に開いている Window の ID を一件返す。 */
    listOpenSessionWindowIds: async () => ["session-1"],
    /** 初回取得だけを切り分けるため、通知も解除時の処理も発生させない。 */
    subscribeOpenSessionWindowIds: () => () => undefined,
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    /** 初回読取から公開された状態を記録し、通知に依存していないことを確認する。 */
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [
    { status: "loaded", sessionIds: ["session-1"] },
  ]);
});

/** 購読による更新がない状況で最初の一覧が失敗すると、ID を持たない error を表示する。 */
test("open Session Window 一覧の初回取得失敗を error として反映する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const api: OpenSessionWindowIdsSubscriptionApi = {
    /** 初回一覧が取得できなかった場合を、Promise の拒否で再現する。 */
    listOpenSessionWindowIds: async () => {
      throw new Error("list failed");
    },
    /** 失敗した一覧以外に状態を変える経路がないよう、何も通知しない。 */
    subscribeOpenSessionWindowIds: () => () => undefined,
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    /** 失敗後の状態を保存し、受理された ID や loaded に切り替わっていないことを確認する。 */
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [{ status: "error", sessionIds: [] }]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回取得失敗はloaded stateをerrorへ巻き戻さない"
// oracle = { type = "contract", ref = "open session window subscription ordering" }
// fault = "初回取得失敗が購読で受け取ったsession idsを消す"
// observable = "applied open-window states"
// observation_boundary = "public-boundary"
// scope = "open-session-window-stale-error"
// lifecycle = "permanent"
// @end-test-value
/** 購読が先に新しい ID を通知したら、遅れて失敗した初回取得で loaded を上書きしない。 */
test("購読更新後の初回取得失敗は loaded state を error へ戻さない", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const control: {
    subscribedListener: ((sessionIds: string[]) => void) | null;
  } = { subscribedListener: null };
  /** 一覧取得を後から失敗させる関数を保持し、購読の通知と失敗の順序を分離する。 */
  let rejectList: (error: Error) => void = () => undefined;
  const api: OpenSessionWindowIdsSubscriptionApi = {
    /** 通知されるまで初回応答を保留できるよう、一覧の拒否関数を渡す。 */
    listOpenSessionWindowIds: () =>
      new Promise((_, reject) => {
        rejectList = reject;
      }),
    /** 初回取得が未完了の間に最新 ID を流せるよう、実際の購読リスナーを保持する。 */
    subscribeOpenSessionWindowIds: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    /** 早く届いた通知と遅い失敗のどちらを採ったか、状態遷移が増えないことも含めて記録する。 */
    applyState: (state) => appliedStates.push(state),
  });
  if (control.subscribedListener)
    control.subscribedListener(["session-current"]);
  rejectList(new Error("stale list failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [
    { status: "loaded", sessionIds: ["session-current"] },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "初回取得失敗後の購読更新はloaded stateへ復帰させる"
// oracle = { type = "contract", ref = "open session window subscription recovery" }
// fault = "取得失敗後に有効な購読更新を無視しerror表示を維持する"
// observable = "recovered state and session ids"
// observation_boundary = "public-boundary"
// scope = "open-session-window-recovery"
// lifecycle = "permanent"
// @end-test-value
/** 初回失敗で error になった後も購読は有効で、次の ID 通知で loaded に復帰する。 */
test("初回取得失敗後も購読更新で loaded state へ復帰する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const control: {
    subscribedListener: ((sessionIds: string[]) => void) | null;
  } = { subscribedListener: null };
  const api: OpenSessionWindowIdsSubscriptionApi = {
    /** 購読イベントを流す前に初回取得を失敗させる。 */
    listOpenSessionWindowIds: async () => {
      throw new Error("list failed");
    },
    /** 初回取得失敗が反映された後も通知できるよう、購読リスナーを退避する。 */
    subscribeOpenSessionWindowIds: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    /** 空の error から回復済み ID を持つ loaded までを、順序付きの状態として記録する。 */
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener)
    control.subscribedListener(["session-recovered"]);
  cleanup();

  assert.deepEqual(appliedStates, [
    { status: "error", sessionIds: [] },
    { status: "loaded", sessionIds: ["session-recovered"] },
  ]);
});
