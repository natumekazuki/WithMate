import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ProviderQuotaTelemetry } from "../../src-shared/session/runtime-state.js";
import { ProviderQuota, ProviderQuotaOverview } from "../../src/provider-usage/provider-quota.js";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { projectQuotaRemaining } from "../../src/provider-usage/provider-quota-projection.js";
import type { ProviderQuotaApi } from "../../src/provider-usage/use-provider-quota.js";

function quota(provider = "codex", used = 20): ProviderQuotaTelemetry {
  return { provider, updatedAt: "2026-10-17T05:00:00Z", snapshots: [], status: "ready",
    rateLimits: [{ quotaKey: provider === "claude" ? "five_hour" : "codex:primary", usedPercentage: used, windowDurationMinutes: 300 }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "contract"
// claim = "残率は使用率だけを反転し、非有限・範囲外値を不明として扱い、標準窓と追加窓を分離し未返却窓を補わない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md#共通の残量表示" }
// fault = "remainingPercentageを再反転する、不正値を0/100にする、追加枠をsummaryへ混ぜるか架空の期間を追加する"
// observable = "projectionの期間label・残率・summary区分・resetと返却件数"
// observation_boundary = "public-boundary"
// scope = "共通quota残率projection"
// lifecycle = "permanent"
// impact = "残量や適用期間を誤認してprovider選択を誤る"
// distinction = "型検査では使用率と残率の方向・欠損値・有限範囲を検出できない"
// @end-test-value
test("quotaは残率に統一し未知値と追加枠を分離する", () => {
  for (const [used, expected] of [[0, "100%"], [100, "0%"], [25.5, "74.5%"], [NaN, "—"], [Infinity, "—"], [-1, "—"], [101, "—"]] as const) {
    assert.deepEqual(projectQuotaRemaining(quota("codex", used)), [
      { key: "codex:primary", label: "5h", remaining: expected, resetDate: undefined, summary: true },
    ]);
  }
  const claude = quota("claude");
  claude.rateLimits!.push(
    { quotaKey: "seven_day", usedPercentage: 75, windowDurationMinutes: 10080, resetDate: "2026-10-20T00:00:00Z" },
    { quotaKey: "model_scoped:Opus", label: "Opus · 7 days", usedPercentage: 10, windowDurationMinutes: 10080 },
  );
  assert.deepEqual(projectQuotaRemaining(claude).map(({ label, remaining, summary, resetDate }) => ({ label, remaining, summary, resetDate })), [
    { label: "5h", remaining: "80%", summary: true, resetDate: undefined },
    { label: "7d", remaining: "25%", summary: true, resetDate: "2026-10-20T00:00:00Z" },
    { label: "Opus · 7 days", remaining: "90%", summary: false, resetDate: undefined },
  ]);
  assert.equal(projectQuotaRemaining({ ...quota(), rateLimits: [{ quotaKey: "extra:primary", usedPercentage: 1 }] })[0]?.summary, false);
  const snapshot = { entitlementRequests: 300, usedRequests: 60, overage: 0, overageAllowedWithExhaustedQuota: false };
  assert.deepEqual(projectQuotaRemaining({ provider: "copilot", updatedAt: null, snapshots: [
    { ...snapshot, quotaKey: "premium_interactions", remainingPercentage: 80 },
    { ...snapshot, quotaKey: "aiu", remainingPercentage: 65 },
    { ...snapshot, quotaKey: "chat", remainingPercentage: NaN },
  ] }).map(({ remaining, summary }) => [remaining, summary]), [["80%", false], ["65%", true], ["—", false]]);
  assert.deepEqual(projectQuotaRemaining(null), []);
});

// @test-value v2
// kind = "contract"
// claim = "quota UIはcacheだけを購読し、通知優先とprovider切替の失効を守り、前回値・失敗・適用外を区別する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md#共通の残量表示" }
// fault = "遅い初回readや旧provider通知が現在値を巻き戻す、Window表示やfocusでremote取得を要求する、失敗や適用外を100%と表示する"
// observable = "表示残率・popupの期間別残率/reset/前回値状態と時刻・不明表示・error indicator・cacheOnly引数・購読解除"
// observation_boundary = "component-behavior"
// scope = "ProviderQuotaのsnapshot/通知/切替/unmount lifecycle"
// lifecycle = "permanent"
// impact = "別providerや古いaccountの値を現在の残量として表示する"
// distinction = "実componentのeffectとDOMを通し、projection単体では観測できない非同期競合を検出する"
// @end-test-value
test("quota UIは通知と送信先を優先し、失敗時も値と状態を区別する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://withmate.local" });
  const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  [dom.window, dom.window.document, dom.window.HTMLElement, true].forEach((value, index) => Object.defineProperty(globalThis, keys[index], { configurable: true, value }));
  const first = deferred<ProviderQuotaTelemetry | null>();
  const second = deferred<ProviderQuotaTelemetry | null>();
  const listeners = new Set<Parameters<ProviderQuotaApi["subscribeProviderQuotaTelemetry"]>[0]>();
  const reads: Parameters<ProviderQuotaApi["getProviderQuotaTelemetry"]>[] = [];
  const api: ProviderQuotaApi = {
    getProviderQuotaTelemetry: async (...args) => { reads.push(args); return reads.length === 1 ? first.promise : second.promise; },
    subscribeProviderQuotaTelemetry: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const emit = async (id: string, value: ProviderQuotaTelemetry | null) => act(async () => { listeners.forEach((listener) => listener(id, value)); });
  try {
    await act(async () => root.render(<ProviderQuota api={api} providerId="codex" />));
    assert.ok(element.querySelector('[aria-label="Codex quota loading"]'));
    assert.deepEqual(reads, [["codex", { cacheOnly: true }]]);
    const oldListener = [...listeners][0]!;
    await emit("codex", quota("codex", 30));
    await act(async () => first.resolve(quota("codex", 10)));
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "5h 70%");
    await emit("codex", { ...quota("codex", 30), status: "error" });
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "5h 70%");
    assert.ok(element.querySelector('[aria-label="Codex quota update failed"]'));
    const detail = dom.window.document.querySelector("[popover]")!;
    assert.match(detail.textContent ?? "", /Update Failed · Previous Values/);
    assert.match(detail.textContent ?? "", /Updated Oct 17, 2026/);
    const button = element.querySelector("button")!;
    assert.equal(button.getAttribute("popovertarget"), detail.id);
    assert.equal(element.firstElementChild?.firstElementChild, button);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(reads.length, 1);

    await act(async () => root.render(<ProviderQuota api={api} providerId="claude" />));
    assert.ok(element.querySelector('[aria-label="Claude quota loading"]'));
    assert.doesNotMatch(element.textContent ?? "", /70%/);
    await emit("claude", { provider: "claude", status: "unsupported", updatedAt: null, snapshots: [] });
    await act(async () => second.reject(new Error("late read")));
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "—");
    assert.equal(element.querySelector(".provider-quota-values span")?.getAttribute("title"), "Not Supported");
    assert.match(dom.window.document.querySelector("[popover]")?.textContent ?? "", /Not Supported/);
    assert.deepEqual(reads, [["codex", { cacheOnly: true }], ["claude", { cacheOnly: true }]]);
    await emit("claude", quota("claude", 0));
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "5h 100%");
    assert.equal(element.querySelector('[aria-label="Claude quota loading"]'), null);
    await act(async () => oldListener("codex", quota("codex", 99)));
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "5h 100%");
    assert.equal(element.querySelector('[aria-label="Claude quota loading"]'), null);
    const withReset = quota("claude", 0);
    withReset.rateLimits!.push({ quotaKey: "seven_day", usedPercentage: 25, windowDurationMinutes: 10080, resetDate: "2026-10-20T05:00:00Z" });
    await emit("claude", withReset);
    const rows = Array.from(element.querySelectorAll(".provider-quota-detail-list > div"));
    assert.deepEqual(rows.map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]), [["5h", "100%"], ["7d", "75%"]]);
    assert.match(rows[1]?.textContent ?? "", /ResetsOct 20, 2026/);
    assert.equal(element.querySelector(".provider-quota-values")?.getAttribute("tabindex"), "0");
    await emit("claude", null);
    assert.equal(element.querySelector(".provider-quota-values")?.textContent, "—");
  } finally {
    await act(async () => root.unmount());
    assert.equal(listeners.size, 0);
    dom.window.close();
    keys.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "全体残量一覧は設定通知の有効providerだけを購読し、無効化で表示と購読を解除する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md#共通の残量表示" }
// fault = "無効providerを残量一覧に残すか、遅い初期設定で新しい有効provider集合を巻き戻す"
// observable = "provider名付き行・snapshot read ID・quota/settings購読解除"
// observation_boundary = "component-behavior"
// scope = "ProviderQuotaOverview設定購読"
// lifecycle = "permanent"
// distinction = "Homeの固定fixtureでは有効化変更と初期設定競合を観測できない"
// @end-test-value
test("quota一覧は有効provider集合へ追従する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://withmate.local" });
  const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  [dom.window, dom.window.document, dom.window.HTMLElement, true].forEach((value, index) => Object.defineProperty(globalThis, keys[index], { configurable: true, value }));
  const initial = deferred<ReturnType<typeof createDefaultAppSettings>>();
  const settingsListeners = new Set<Parameters<WithMateWindowApi["subscribeAppSettings"]>[0]>();
  const quotaListeners = new Set<Parameters<ProviderQuotaApi["subscribeProviderQuotaTelemetry"]>[0]>();
  const reads: string[] = [];
  const api = {
    getAppSettings: () => initial.promise,
    subscribeAppSettings: (listener: Parameters<WithMateWindowApi["subscribeAppSettings"]>[0]) => {
      settingsListeners.add(listener); return () => { settingsListeners.delete(listener); };
    },
    getProviderQuotaTelemetry: async (id: string) => { reads.push(id); return quota(id); },
    subscribeProviderQuotaTelemetry: (listener: Parameters<ProviderQuotaApi["subscribeProviderQuotaTelemetry"]>[0]) => {
      quotaListeners.add(listener); return () => { quotaListeners.delete(listener); };
    },
  };
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () => root.render(<ProviderQuotaOverview api={api} />));
    assert.ok(element.querySelector('[aria-label="Provider settings loading"]'));
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.claude = { ...settings.codingProviderSettings.codex, enabled: true };
    await act(async () => settingsListeners.forEach((listener) => listener(settings)));
    assert.deepEqual(reads, ["codex", "claude"]);
    assert.deepEqual(Array.from(element.querySelectorAll(".provider-quota-name"), (node) => node.textContent), ["Codex", "Claude"]);
    await act(async () => initial.resolve(createDefaultAppSettings()));
    assert.equal(element.querySelectorAll(".provider-quota-name").length, 2);
    settings.codingProviderSettings.codex.enabled = false;
    await act(async () => settingsListeners.forEach((listener) => listener(settings)));
    assert.deepEqual(Array.from(element.querySelectorAll(".provider-quota-name"), (node) => node.textContent), ["Claude"]);
    assert.equal(quotaListeners.size, 1);
  } finally {
    await act(async () => root.unmount());
    assert.equal(settingsListeners.size, 0);
    assert.equal(quotaListeners.size, 0);
    dom.window.close();
    keys.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Monitorの残量欄は初期表示で開き、共通splitterで閉じても一覧を保ち、再描画で開かず、再展開時には最新cacheの残率を表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "開閉操作を無視する、状態更新で閉じた欄を開く、一覧を再mountする、または再展開時に古い残率やremote取得を使う"
// observable = "splitterのaria-expanded・aria-controls、残量領域のhidden属性、再表示した残率、一覧DOM同一性とscrollTop、cacheOnly引数"
// observation_boundary = "component-behavior"
// scope = "Homeと独立Monitorの共通HomeMonitorContentからProviderQuotaOverviewへの開閉とcache再購読"
// lifecycle = "permanent"
// impact = "複数Sessionを監視する一覧の場所を失わず、残量を必要時に再確認できる"
// distinction = "既存quota購読testとRunning/Stopped配分testでは残量欄の開閉を通らない。1つのDOM testで復帰を確認し、実高さとkeyboard操作は実描画で確認する"
// @end-test-value
test("Monitorの残量欄は開閉状態と一覧を維持し、再展開で最新cacheを表示する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://withmate.local" });
  const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  [dom.window, dom.window.document, dom.window.HTMLElement, true].forEach((value, index) => Object.defineProperty(globalThis, keys[index], { configurable: true, value }));
  let currentQuota = quota("codex", 20);
  const reads: Parameters<ProviderQuotaApi["getProviderQuotaTelemetry"]>[] = [];
  const api = {
    getAppSettings: async () => createDefaultAppSettings(),
    subscribeAppSettings: () => () => {},
    getProviderQuotaTelemetry: async (...args: Parameters<ProviderQuotaApi["getProviderQuotaTelemetry"]>) => {
      reads.push(args);
      return currentQuota;
    },
    subscribeProviderQuotaTelemetry: () => () => {},
  };
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  const render = (feedback = "") => root.render(<HomeMonitorContent
    providerQuota={<ProviderQuotaOverview api={api} />}
    runningEntries={[]} nonRunningEntries={[]} feedback={feedback}
    onOpenSession={() => {}} onShowContextMenu={() => {}}
  />);
  try {
    await act(async () => render());
    const splitter = element.querySelector<HTMLButtonElement>('[aria-label="Collapse Provider Quotas"]')!;
    assert.ok(splitter);
    assert.equal(splitter.getAttribute("aria-expanded"), "true");
    const region = dom.window.document.getElementById(splitter.getAttribute("aria-controls")!)!;
    assert.equal(region.hidden, false);
    assert.equal(region.querySelector(".provider-quota-values")?.textContent, "5h 80%");
    const list = element.querySelector<HTMLDivElement>(".home-monitor-list")!;
    list.scrollTop = 42;

    await act(async () => splitter.click());
    assert.equal(splitter.getAttribute("aria-expanded"), "false");
    assert.equal(splitter.getAttribute("aria-label"), "Expand Provider Quotas");
    assert.equal(region.hidden, true);
    assert.equal(element.querySelector(".home-monitor-list"), list);
    assert.equal(list.scrollTop, 42);
    await act(async () => render("Updated status"));
    assert.equal(splitter.getAttribute("aria-expanded"), "false");
    assert.equal(region.hidden, true);

    currentQuota = quota("codex", 45);
    await act(async () => splitter.click());
    assert.equal(splitter.getAttribute("aria-expanded"), "true");
    assert.equal(region.hidden, false);
    assert.equal(region.querySelector(".provider-quota-values")?.textContent, "5h 55%");
    assert.equal(element.querySelector(".home-monitor-list"), list);
    assert.equal(list.scrollTop, 42);
    assert.deepEqual(reads, [["codex", { cacheOnly: true }], ["codex", { cacheOnly: true }]]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});
