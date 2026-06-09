import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ProviderQuotaTelemetry } from "../../src/app-state.js";
import {
  startProviderQuotaTelemetrySubscription,
  type ProviderQuotaTelemetrySubscriptionApi,
} from "../../src/session-telemetry-subscription.js";
import type { ProviderOwnedQuotaTelemetry } from "../../src/session-telemetry-state.js";

const providerTelemetry: ProviderQuotaTelemetry = {
  provider: "copilot",
  updatedAt: "2026-06-10T00:00:00.000Z",
  snapshots: [],
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

test("startProviderQuotaTelemetrySubscription は初回取得と対象 provider の購読更新を反映する", async () => {
  const subscribedTelemetry: ProviderQuotaTelemetry = {
    ...providerTelemetry,
    updatedAt: "2026-06-10T01:00:00.000Z",
  };
  const updates: ProviderOwnedQuotaTelemetry[] = [];
  let subscribedListener: ((providerId: string, telemetry: ProviderQuotaTelemetry | null) => void) | null = null;
  let unsubscribeCount = 0;
  const api: ProviderQuotaTelemetrySubscriptionApi = {
    getProviderQuotaTelemetry: async () => providerTelemetry,
    subscribeProviderQuotaTelemetry: (listener) => {
      subscribedListener = listener;
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
  subscribedListener?.("codex", subscribedTelemetry);
  subscribedListener?.("copilot", subscribedTelemetry);
  cleanup();
  subscribedListener?.("copilot", null);

  assert.deepEqual(updates, [
    { ownerProviderId: "copilot", telemetry: null },
    { ownerProviderId: "copilot", telemetry: providerTelemetry },
    { ownerProviderId: "copilot", telemetry: subscribedTelemetry },
  ]);
  assert.equal(unsubscribeCount, 1);
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

test("CompanionReview の provider quota telemetry subscription は merge view で無効にする", async () => {
  const source = await readFile(new URL("../../src/CompanionReviewApp.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startProviderQuotaTelemetrySubscription({");

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(subscriptionIndex, subscriptionIndex + 240),
    /enabled: !isMergeView/,
  );
});
