import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src/app-state.js";
import {
  startProviderQuotaTelemetrySubscription,
  startSessionContextTelemetrySubscription,
  type ProviderQuotaTelemetrySubscriptionApi,
  type SessionContextTelemetrySubscriptionApi,
} from "../../src/session-telemetry-subscription.js";
import type { ProviderOwnedQuotaTelemetry, SessionOwnedContextTelemetry } from "../../src/session-telemetry-state.js";

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

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});
test("startProviderQuotaTelemetrySubscription は api 不在なら null telemetry を反映して no-op cleanup を返す", () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];

  const cleanup = startProviderQuotaTelemetrySubscription({
    api: null,
    providerId: "copilot",
    enabled: true,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
  ]);
});
test("startProviderQuotaTelemetrySubscription は disabled provider では fetch せず null telemetry を反映する", () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  let getCallCount = 0;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: async () => {
      getCallCount += 1;
      return providerTelemetry;
    },
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "codex",
    enabled: false,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [
    { ownerProviderId: "codex", telemetry: null },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "provider quota telemetryは初回取得と対象providerの更新だけを反映する"
// oracle = { type = "contract", ref = "provider quota telemetry subscription" }
// fault = "別providerまたはcleanup後のtelemetryが混入する"
// observable = "owner provider telemetry update sequence"
// observation_boundary = "public-boundary"
// scope = "provider-quota-telemetry-subscription"
// lifecycle = "permanent"
// @end-test-value
test("startProviderQuotaTelemetrySubscription は初回取得と対象 provider の購読更新を反映する", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: { subscribedListener: ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void) | null } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: async () => providerTelemetry,
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
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener) control.subscribedListener("codex", subscribedTelemetry);
  if (control.subscribedListener) control.subscribedListener("copilot", subscribedTelemetry);
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
// oracle = { type = "contract", ref = "provider quota telemetry ordering" }
// fault = "遅い初回nullが購読済みtelemetryを消去する"
// observable = "applied telemetry sequence"
// observation_boundary = "public-boundary"
// scope = "provider-telemetry-stale-initial"
// lifecycle = "permanent"
// @end-test-value
test("startProviderQuotaTelemetrySubscription は購読更新後に遅い初回取得で telemetry を巻き戻さない", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: { subscribedListener: ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void) | null } = { subscribedListener: null };
  let resolveTelemetry: (telemetry: ProviderQuotaTelemetry | null) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: () => new Promise((resolve) => {
      resolveTelemetry = resolve;
    }),
    subscribeProviderQuotaTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener) control.subscribedListener("copilot", subscribedTelemetry);
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
// oracle = { type = "contract", ref = "provider quota telemetry ordering" }
// fault = "初回取得失敗が購読済みtelemetryをnullで上書きする"
// observable = "applied telemetry after failed initial fetch"
// observation_boundary = "public-boundary"
// scope = "provider-telemetry-failed-initial"
// lifecycle = "permanent"
// @end-test-value
test("startProviderQuotaTelemetrySubscription は購読更新後に遅い初回取得失敗で telemetry を null に戻さない", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const control: { subscribedListener: ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void) | null } = { subscribedListener: null };
  let rejectTelemetry: (error: Error) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: () => new Promise((_, reject) => {
      rejectTelemetry = reject;
    }),
    subscribeProviderQuotaTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener) control.subscribedListener("copilot", subscribedTelemetry);
  rejectTelemetry(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: subscribedTelemetry },
  ]);
});

test("startProviderQuotaTelemetrySubscription は初回取得失敗時に null telemetry を反映する", async () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: async () => {
      throw new Error("failed");
    },
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: null },
  ]);
});

test("startProviderQuotaTelemetrySubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  let resolveTelemetry: (telemetry: ProviderQuotaTelemetry | null) => void = () => undefined;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: () => new Promise((resolve) => {
      resolveTelemetry = resolve;
    }),
    subscribeProviderQuotaTelemetry: () => () => undefined,
  };

  const cleanup = startProviderQuotaTelemetrySubscription({
    api,
    providerId: "copilot",
    enabled: true,
    applyProviderQuotaTelemetry: (state) => updates.push(state),
  });
  cleanup();
  resolveTelemetry(providerTelemetry);
  await flushPromises();

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
  ]);
});

test("App の provider quota telemetry subscription は Copilot provider だけ有効にする", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startProviderQuotaTelemetrySubscription({");

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(subscriptionIndex, subscriptionIndex + 240),
    /enabled: providerId === "copilot"/,
  );
});
test("startSessionContextTelemetrySubscription は api 不在なら null telemetry を反映して no-op cleanup を返す", () => {
  const updates: SessionOwnedContextTelemetry[] = [];

  const cleanup = startSessionContextTelemetrySubscription({
    api: null,
    sessionId: "session-1",
    enabled: true,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
  ]);
});

test("startSessionContextTelemetrySubscription は disabled session では fetch せず null telemetry を反映する", () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  let getCallCount = 0;
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: async () => {
      getCallCount += 1;
      return sessionTelemetry;
    },
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: false,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "session context telemetryは初回取得と対象session更新を反映する"
// oracle = { type = "contract", ref = "session context telemetry subscription" }
// fault = "別sessionのtelemetryが表示状態へ混入する"
// observable = "owner session telemetry update sequence"
// observation_boundary = "public-boundary"
// scope = "session-context-telemetry-subscription"
// lifecycle = "permanent"
// @end-test-value
test("startSessionContextTelemetrySubscription は初回取得と対象 session の購読更新を反映する", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: { subscribedListener: ((sessionId: string, telemetry: SessionContextTelemetry | null) => void) | null } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: async () => sessionTelemetry,
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
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener) control.subscribedListener("session-other", subscribedTelemetry);
  if (control.subscribedListener) control.subscribedListener("session-1", subscribedTelemetry);
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
// oracle = { type = "contract", ref = "session context telemetry ordering" }
// fault = "遅い初回nullが購読済みsession telemetryを消去する"
// observable = "applied session telemetry sequence"
// observation_boundary = "public-boundary"
// scope = "session-telemetry-stale-initial"
// lifecycle = "permanent"
// @end-test-value
test("startSessionContextTelemetrySubscription は購読更新後に遅い初回取得で telemetry を巻き戻さない", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: { subscribedListener: ((sessionId: string, telemetry: SessionContextTelemetry | null) => void) | null } = { subscribedListener: null };
  let resolveTelemetry: (telemetry: SessionContextTelemetry | null) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: () => new Promise((resolve) => {
      resolveTelemetry = resolve;
    }),
    subscribeSessionContextTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener) control.subscribedListener("session-1", subscribedTelemetry);
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
// oracle = { type = "contract", ref = "session context telemetry ordering" }
// fault = "初回取得失敗が購読済みsession telemetryをnullで上書きする"
// observable = "applied telemetry after failed initial fetch"
// observation_boundary = "public-boundary"
// scope = "session-telemetry-failed-initial"
// lifecycle = "permanent"
// @end-test-value
test("startSessionContextTelemetrySubscription は購読更新後に遅い初回取得失敗で telemetry を null に戻さない", async () => {
  const subscribedTelemetry: SessionContextTelemetry = {
    ...sessionTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: SessionOwnedContextTelemetry[] = [];
  const control: { subscribedListener: ((sessionId: string, telemetry: SessionContextTelemetry | null) => void) | null } = { subscribedListener: null };
  let rejectTelemetry: (error: Error) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: () => new Promise((_, reject) => {
      rejectTelemetry = reject;
    }),
    subscribeSessionContextTelemetry: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  if (control.subscribedListener) control.subscribedListener("session-1", subscribedTelemetry);
  rejectTelemetry(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: subscribedTelemetry },
  ]);
});

test("startSessionContextTelemetrySubscription は初回取得失敗時に null telemetry を反映する", async () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: async () => {
      throw new Error("failed");
    },
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
    { ownerSessionId: "session-1", telemetry: null },
  ]);
});

test("startSessionContextTelemetrySubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: SessionOwnedContextTelemetry[] = [];
  let resolveTelemetry: (telemetry: SessionContextTelemetry | null) => void = () => undefined;
  const api: SessionContextTelemetrySubscriptionApi = {
    getSessionContextTelemetry: () => new Promise((resolve) => {
      resolveTelemetry = resolve;
    }),
    subscribeSessionContextTelemetry: () => () => undefined,
  };

  const cleanup = startSessionContextTelemetrySubscription({
    api,
    sessionId: "session-1",
    enabled: true,
    applySessionContextTelemetry: (state) => updates.push(state),
  });
  cleanup();
  resolveTelemetry(sessionTelemetry);
  await flushPromises();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", telemetry: null },
  ]);
});

test("App の session context telemetry subscription は Copilot provider だけ有効にする", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startSessionContextTelemetrySubscription({");

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(subscriptionIndex, subscriptionIndex + 240),
    /enabled: providerId === "copilot"/,
  );
});
