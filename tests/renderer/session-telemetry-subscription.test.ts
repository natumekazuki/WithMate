import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import {
  startProviderQuotaTelemetrySubscription,
  startSessionContextTelemetrySubscription,
  type ProviderQuotaTelemetrySubscriptionApi,
  type SessionContextTelemetrySubscriptionApi,
} from "../../src/chat/runtime/session-telemetry-subscription.js";
import type {
  ProviderOwnedQuotaTelemetry,
  SessionOwnedContextTelemetry,
} from "../../src/chat/runtime/session-telemetry-state.js";

const providerTelemetry: ProviderQuotaTelemetry = {
  provider: "copilot",
  updatedAt: "2026-06-10T00:00:00.000Z",
  snapshots: [],
};

const sessionTelemetry: SessionContextTelemetry = {
  provider: "copilot",
  sessionId: "session-1",
  updatedAt: "2026-06-10T00:00:00.000Z",
  tokenLimit: 1000,
  currentTokens: 100,
  messagesLength: 2,
};

/** 購読と初回取得の Promise が反映されるまでマイクロタスクを一巡させる。 */
const flushPromises = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

// @test-value v2
// kind = "contract"
// claim = "provider quota telemetry APIがない場合はnull telemetryを一度通知しcleanupをno-opにする"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "API不在時に例外を投げる、telemetryを未初期化のままにする、またはcleanupで副作用を起こす"
// observable = "適用されたowner telemetry state"
// observation_boundary = "public-boundary"
// scope = "provider-quota-telemetry-subscription missing api"
// lifecycle = "permanent"
// @end-test-value
/** 使用枠 API がなければ対象プロバイダーに空の状態を一度だけ反映し、解除は副作用を持たない。 */
test("startProviderQuotaTelemetrySubscription は api 不在なら null telemetry を反映して no-op cleanup を返す", () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];

  const cleanup = startProviderQuotaTelemetrySubscription({
    api: null,
    providerId: "copilot",
    enabled: true,
    /** API 不在時に通知される使用枠の状態を記録する。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.deepEqual(updates, [{ ownerProviderId: "copilot", telemetry: null }]);
});
// @test-value v2
// kind = "contract"
// claim = "disabled providerのquota telemetry subscriptionはfetchせずnull telemetryを反映する"
// oracle = { type = "contract", ref = "src/chat/runtime/provider-quota-telemetry-subscription.ts" }
// fault = "disabled providerでもtelemetry取得を実行する、または初期状態をnullとして通知しない"
// observable = "getProviderQuotaTelemetry呼び出し回数と適用telemetry state"
// observation_boundary = "public-boundary"
// scope = "provider-quota-telemetry-subscription disabled provider"
// lifecycle = "permanent"
// @end-test-value
/** 無効なプロバイダーについては使用枠を取得せず、空として通知する。 */
test("startProviderQuotaTelemetrySubscription は disabled provider では fetch せず null telemetry を反映する", () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  let getCallCount = 0;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 無効でも誤って取得した場合に検出できるよう取得回数を数える。 */
    getProviderQuotaTelemetry: async () => {
      getCallCount += 1;
      return providerTelemetry;
    },
    /** 無効なプロバイダーへの実際の更新は発生させない。 */
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "codex",
    enabled: false,
    /** プロバイダーの識別子を含めて反映された状態を保存する。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [{ ownerProviderId: "codex", telemetry: null }]);
});

// @test-value v2
// kind = "contract"
// claim = "provider quota telemetryは初回取得と対象providerの更新だけを反映する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "別providerまたはcleanup後のtelemetryが混入する"
// observable = "owner provider telemetry update sequence"
// observation_boundary = "public-boundary"
// scope = "provider-quota-telemetry-subscription"
// lifecycle = "permanent"
// @end-test-value
/** 初回取得と対象プロバイダーの更新のみを受け取り、解除時に購読を一度だけ外す。 */
test("startProviderQuotaTelemetrySubscription は初回取得と対象 provider の購読更新を反映する", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 初回取得に使う使用枠のスナップショットを返す。 */
    getProviderQuotaTelemetry: async () => providerTelemetry,
    /** 別プロバイダーの通知や解除後の通知も送れるよう、通知先と解除回数を保持する。 */
    subscribeProviderQuotaTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    /** 初回値と購読値の反映順を確認するため、更新を発生順に記録する。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener)
    control.subscribedListener("codex", subscribedTelemetry);
  if (control.subscribedListener)
    control.subscribedListener("copilot", subscribedTelemetry);
  cleanup();
  if (control.subscribedListener) control.subscribedListener("copilot", null);

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: providerTelemetry },
    { ownerProviderId: "copilot", telemetry: subscribedTelemetry },
  ]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "provider telemetry購読更新後の遅い初回取得は新しいtelemetryを巻き戻さない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "遅い初回nullが購読済みtelemetryを消去する"
// observable = "applied telemetry sequence"
// observation_boundary = "public-boundary"
// scope = "provider-telemetry-stale-initial"
// lifecycle = "permanent"
// @end-test-value
/** 初回取得が遅れて空で返っても、先に受信したプロバイダーの使用枠を取り消さない。 */
test("startProviderQuotaTelemetrySubscription は購読更新後に遅い初回取得で telemetry を巻き戻さない", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  /** 新しい使用枠の通知後に、保留中の初回取得を成功させる。 */
  let resolveTelemetry: (
    telemetry: ProviderQuotaTelemetry | null,
  ) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 初回の使用枠取得を保留し、完了用の関数を取り出す。 */
    getProviderQuotaTelemetry: () =>
      new Promise((resolve) => {
        resolveTelemetry = resolve;
      }),
    /** 初回結果より先に使用枠の更新を発行するための購読先を記録する。 */
    subscribeProviderQuotaTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    /** 初回応答が更新を巻き戻さなかったか、反映された状態の列を取る。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener)
    control.subscribedListener("copilot", subscribedTelemetry);
  resolveTelemetry(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: subscribedTelemetry },
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "provider telemetry購読更新後の遅い初回失敗は有効なtelemetryをnullへ戻さない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "初回取得失敗が購読済みtelemetryをnullで上書きする"
// observable = "applied telemetry after failed initial fetch"
// observation_boundary = "public-boundary"
// scope = "provider-telemetry-failed-initial"
// lifecycle = "permanent"
// @end-test-value
/** 先に購読で有効値を受け取ったら、遅れた初回取得失敗でも空に戻さない。 */
test("startProviderQuotaTelemetrySubscription は購読更新後に遅い初回取得失敗で telemetry を null に戻さない", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  /** 購読更新後に使用枠の初回取得を失敗させる。 */
  let rejectTelemetry: (error: Error) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 使用枠の読取を保留し、失敗時点を選べるようにする。 */
    getProviderQuotaTelemetry: () =>
      new Promise((_, reject) => {
        rejectTelemetry = reject;
      }),
    /** 取得失敗より先に有効な使用枠を配信する。 */
    subscribeProviderQuotaTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    /** 失敗による空値が追加で反映されないか更新履歴を取る。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener)
    control.subscribedListener("copilot", subscribedTelemetry);
  rejectTelemetry(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: subscribedTelemetry },
  ]);
});

/** 購読の更新がないまま初回取得が失敗した場合は空の使用枠を反映する。 */
test("startProviderQuotaTelemetrySubscription は初回取得失敗時に null telemetry を反映する", async () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 初回のプロバイダー使用枠取得が直ちに失敗する状態を再現する。 */
    getProviderQuotaTelemetry: async () => {
      throw new Error("failed");
    },
    /** 初回失敗から回復させる購読通知は発生させない。 */
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    /** 空の初期状態と取得失敗後の状態を順に観測する。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: null },
  ]);
});

/** 購読を解除してから到着した初回使用枠は反映しない。 */
test("startProviderQuotaTelemetrySubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  /** 解除後まで保留する使用枠取得を完了させる。 */
  let resolveTelemetry: (
    telemetry: ProviderQuotaTelemetry | null,
  ) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    /** 使用枠取得を開始した時点で完了操作だけを保存する。 */
    getProviderQuotaTelemetry: () =>
      new Promise((resolve) => {
        resolveTelemetry = resolve;
      }),
    /** 購読イベントではなく遅れた取得だけを発生させる。 */
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    /** 最初の空値以降に反映された状態がないか調べる。 */
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();
  resolveTelemetry(providerTelemetry);
  await flushPromises();

  assert.deepEqual(updates, [{ ownerProviderId: "copilot", telemetry: null }]);
});

// @test-value v2
// kind = "contract"
// claim = "session telemetry hookはCopilot providerだけquota/context telemetryを有効にする"
// oracle = { type = "contract", ref = "src/chat/runtime/session-window-telemetry-hooks.ts" }
// fault = "非Copilot providerでtelemetry subscriptionを開始する、またはCopilotで無効化する"
// observable = "telemetry hookのprovider guardとenabled値"
// observation_boundary = "declaration"
// scope = "session-window-telemetry-hooks.provider-guard"
// lifecycle = "permanent"
// @end-test-value
/** プロバイダーの使用枠購読に渡す有効条件が Copilot 限定であることを配線コードから確かめる。 */
test("App の provider quota telemetry subscription は Copilot provider だけ有効にする", async () => {
  const source = await readFile(
    new URL(
      "../../src/chat/runtime/session-window-telemetry-hooks.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const subscriptionIndex = source.indexOf(
    "startProviderQuotaTelemetrySubscription({",
  );

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(source.indexOf("const isCopilot"), subscriptionIndex + 240),
    /const isCopilot = providerId === "copilot";[\s\S]*enabled: isCopilot/,
  );
});
/** 会話コンテキスト API がなければ対象会話を空で通知し、解除処理を実行しても更新は増えない。 */
test("startSessionContextTelemetrySubscription は api 不在なら null telemetry を反映して no-op cleanup を返す", () => {
  const updates: SessionOwnedContextTelemetry[] = [];

  const cleanup = startSessionContextTelemetrySubscription({
    api: null,
    sessionId: "session-1",
    enabled: true,
    /** API がないときに反映される会話識別子と空値を記録する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.deepEqual(updates, [{ ownerSessionId: "session-1", telemetry: null }]);
});

// @test-value v2
// kind = "contract"
// claim = "disabled sessionのcontext telemetry subscriptionはfetchせずnull telemetryを反映する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-context-telemetry-subscription.ts" }
// fault = "disabled sessionでもcontext telemetry取得を実行する、または初期状態をnullとして通知しない"
// observable = "getSessionContextTelemetry呼び出し回数と適用telemetry state"
// observation_boundary = "public-boundary"
// scope = "session-context-telemetry-subscription disabled session"
// lifecycle = "permanent"
// @end-test-value
/** 無効な会話のコンテキストは取得を行わず空にする。 */
test("startSessionContextTelemetrySubscription は disabled session では fetch せず null telemetry を反映する", () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  let getCallCount = 0;
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 無効化によってコンテキスト取得が省かれることを、API の呼び出し回数で観測する。 */
    getSessionContextTelemetry: async () => {
      getCallCount += 1;
      return sessionTelemetry;
    },
    /** 対象が無効なので購読通知を配信しない。 */
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: false,
    /** 会話単位で空になったコンテキストを記録する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [{ ownerSessionId: "session-1", telemetry: null }]);
});

// @test-value v2
// kind = "contract"
// claim = "session context telemetryは初回取得と対象session更新を反映する"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "別sessionのtelemetryが表示状態へ混入する"
// observable = "owner session telemetry update sequence"
// observation_boundary = "public-boundary"
// scope = "session-context-telemetry-subscription"
// lifecycle = "permanent"
// @end-test-value
/** 対象会話の初回値と通知だけを反映し、解除後の通知を無視する。 */
test("startSessionContextTelemetrySubscription は初回取得と対象 session の購読更新を反映する", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((sessionId: string, telemetry: SessionContextTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 既知のトークン数を持つ対象会話の初回スナップショットを返す。 */
    getSessionContextTelemetry: async () => sessionTelemetry,
    /** 対象・別会話のイベントを直接発行できるよう購読先を保持し、解除を数える。 */
    subscribeSessionContextTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    /** 会話の初期値と更新値が反映された順に記録する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener)
    control.subscribedListener("session-other", subscribedTelemetry);
  if (control.subscribedListener)
    control.subscribedListener("session-1", subscribedTelemetry);
  cleanup();
  if (control.subscribedListener) control.subscribedListener("session-1", null);

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: sessionTelemetry },
    { ownerSessionId: "session-1", telemetry: subscribedTelemetry },
  ]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "session telemetry購読更新後の遅い初回取得は新しいtelemetryを巻き戻さない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "遅い初回nullが購読済みsession telemetryを消去する"
// observable = "applied session telemetry sequence"
// observation_boundary = "public-boundary"
// scope = "session-telemetry-stale-initial"
// lifecycle = "permanent"
// @end-test-value
/** 会話コンテキストの通知が先に届いたら、遅れて取得した空値は反映しない。 */
test("startSessionContextTelemetrySubscription は購読更新後に遅い初回取得で telemetry を巻き戻さない", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((sessionId: string, telemetry: SessionContextTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  /** 通知を発行した後に完了させる会話コンテキスト取得の操作。 */
  let resolveTelemetry: (
    telemetry: SessionContextTelemetry | null,
  ) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 初回の会話コンテキスト取得をテスト側で完了させるまで保留する。 */
    getSessionContextTelemetry: () =>
      new Promise((resolve) => {
        resolveTelemetry = resolve;
      }),
    /** 保留中の取得に先行して、会話コンテキスト更新を配信できるようにする。 */
    subscribeSessionContextTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    /** 先に届いた通知値が維持されたか反映履歴を集める。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener)
    control.subscribedListener("session-1", subscribedTelemetry);
  resolveTelemetry(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: subscribedTelemetry },
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "session telemetry購読更新後の遅い初回失敗は有効なtelemetryをnullへ戻さない"
// oracle = { type = "contract", ref = "src/chat/runtime/session-telemetry-subscription.ts" }
// fault = "初回取得失敗が購読済みsession telemetryをnullで上書きする"
// observable = "applied telemetry after failed initial fetch"
// observation_boundary = "public-boundary"
// scope = "session-telemetry-failed-initial"
// lifecycle = "permanent"
// @end-test-value
/** 有効な会話コンテキストの通知後に初回取得が失敗しても、表示を空に戻さない。 */
test("startSessionContextTelemetrySubscription は購読更新後に遅い初回取得失敗で telemetry を null に戻さない", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: {
    subscribedListener:
      | ((sessionId: string, telemetry: SessionContextTelemetry | null) => void)
      | null;
  } = { subscribedListener: null };
  /** 通知後に初回の会話コンテキスト取得を失敗させる。 */
  let rejectTelemetry: (error: Error) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 初回取得の失敗を購読の更新より遅らせる。 */
    getSessionContextTelemetry: () =>
      new Promise((_, reject) => {
        rejectTelemetry = reject;
      }),
    /** 取得失敗より先に対象会話の値を配信できるよう通知先を記録する。 */
    subscribeSessionContextTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    /** 取得失敗後に空値で上書きしなかったか照合する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener)
    control.subscribedListener("session-1", subscribedTelemetry);
  rejectTelemetry(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: subscribedTelemetry },
  ]);
});

/** 初回取得が失敗し、更新通知もないときは対象会話に空のコンテキストを反映する。 */
test("startSessionContextTelemetrySubscription は初回取得失敗時に null telemetry を反映する", async () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 会話コンテキストの取得エラーを即時に返す。 */
    getSessionContextTelemetry: async () => {
      throw new Error("failed");
    },
    /** 取得失敗を覆う購読更新は配信しない。 */
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    /** 初回取得の失敗前後のコンテキスト値を両方記録する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: null },
  ]);
});

/** 購読解除後に届いた会話コンテキストの取得成功を無視する。 */
test("startSessionContextTelemetrySubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  /** 解除済みの購読に対応する初回コンテキスト取得を完了する。 */
  let resolveTelemetry: (
    telemetry: SessionContextTelemetry | null,
  ) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    /** 解除までコンテキスト取得を保留できるようにする。 */
    getSessionContextTelemetry: () =>
      new Promise((resolve) => {
        resolveTelemetry = resolve;
      }),
    /** 取得と破棄の順序だけを確認し、購読イベントは送らない。 */
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    /** 初期の空状態以外にコンテキスト更新がないかを確認する。 */
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();
  resolveTelemetry(sessionTelemetry);
  await flushPromises();

  assert.deepEqual(updates, [{ ownerSessionId: "session-1", telemetry: null }]);
});

// @test-value v2
// kind = "contract"
// claim = "session context telemetry hookはCopilot providerだけ有効にする"
// oracle = { type = "contract", ref = "src/chat/runtime/session-window-telemetry-hooks.ts" }
// fault = "非Copilot providerでsession context telemetry subscriptionを開始する、またはCopilotで無効化する"
// observable = "telemetry hookのprovider guardとenabled値"
// observation_boundary = "declaration"
// scope = "session-window-telemetry-hooks.session-context-guard"
// lifecycle = "permanent"
// @end-test-value
/** 会話コンテキスト購読の有効条件に Copilot 判定を渡していることを配線コードから確かめる。 */
test("App の session context telemetry subscription は Copilot provider だけ有効にする", async () => {
  const source = await readFile(
    new URL(
      "../../src/chat/runtime/session-window-telemetry-hooks.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const subscriptionIndex = source.indexOf(
    "startSessionContextTelemetrySubscription({",
  );

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(source.indexOf("const isCopilot"), subscriptionIndex + 240),
    /const isCopilot = providerId === "copilot";[\s\S]*enabled: isCopilot/,
  );
});
