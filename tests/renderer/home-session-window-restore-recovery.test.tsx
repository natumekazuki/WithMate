import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { SessionWindowRestoreService } from "../../src-electron/windows/session-window-restore-service.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountHome(restoreApi: Pick<WithMateWindowApi,
  "getSessionWindowRestoreSet" | "subscribeSessionWindowRestoreSet" | "restoreSessionWindows"
>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://withmate.local/" });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const api: Partial<WithMateWindowApi> = {
    getMateState: async () => "not_created",
    listCharacters: async () => [],
    getAppSettings: async () => createDefaultAppSettings(),
    subscribeAppSettings: () => () => {},
    getModelCatalog: async () => ({ providers: [{ id: "codex", label: "Codex", defaultModelId: "", defaultReasoningEffort: "", models: [] }] }),
    subscribeModelCatalog: () => () => {},
    getProviderQuotaTelemetry: async () => null,
    subscribeProviderQuotaTelemetry: () => () => {},
    listSessionSummaryPage: async () => ({ entries: [], hasMore: false, nextCursor: null }),
    listSessionMonitorPage: async () => ({ entries: [], auxiliarySessions: [], hasMore: false, nextCursor: null }),
    listSessionCharacterUsage: async () => [],
    subscribeSessionInvalidation: () => () => {},
    onSessionTurnUpdated: () => () => {},
    listOpenSessionWindowIds: async () => [],
    subscribeOpenSessionWindowIds: () => () => {},
    subscribeLiveSessionRunStatus: () => () => {},
    executeCoordination: async () => ({ items: [], total: 0, nextOffset: null }),
    subscribeCoordinationChanged: () => () => {},
    ...restoreApi,
  };
  dom.window.withmate = api as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  const { createRoot } = await import("react-dom/client");
  const { default: HomeApp } = await import("../../src/home/HomeApp.js");
  await act(async () => { root = createRoot(container); root.render(<HomeApp />); });
  return {
    dom,
    container,
    restoreButton() {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent?.trim() === "Restore Sessions");
      assert.ok(button);
      return button;
    },
    async dispose() {
      await act(async () => root?.unmount());
      for (const [key, value] of Object.entries(previous)) Object.defineProperty(globalThis, key, { value, configurable: true });
      dom.window.close();
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Homeは初期復元候補の取得errorを表示し、障害解消後のfocus再取得で同じserviceの通知・候補・復元操作を回復する"
// oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
// fault = "読込失敗を0件へ隠すか、回復してもerrorと無効な復元操作を残すか、正常時もfocusごとに再読込する"
// observable = "実Home DOMのerrorとRestore button、serviceのstorage読込回数とopen対象"
// observation_boundary = "consumer"
// scope = "Home restore recovery subscription and focus"
// lifecycle = "permanent"
// impact = "一時障害後もRestore Sessionsが使用できない"
// distinction = "service単体ではHome effectの再取得・通知・feedback・button結線を確認できない"
// @end-test-value
test("Homeは読込失敗後だけfocusで再取得し、同一serviceの復元操作を回復する", async () => {
  let available = false;
  let loads = 0;
  let onSnapshot: ((sessionIds: string[]) => void) | undefined;
  const opened: string[] = [];
  const service = new SessionWindowRestoreService({
    storage: {
      async loadSnapshot() {
        loads += 1;
        if (!available) throw new Error("Restore storage unavailable");
        return ["pending"];
      },
      async saveSnapshot() {},
    },
    getSession: () => ({}),
    getSessionWindowRestoreStates: () => new Map(),
    async openSessionWindow(sessionId) { opened.push(sessionId); },
    onRestoreSetChanged: (sessionIds) => onSnapshot?.([...sessionIds]),
  });
  const home = await mountHome({
    getSessionWindowRestoreSet: () => service.getSnapshot(),
    subscribeSessionWindowRestoreSet(listener) { onSnapshot = listener; return () => { onSnapshot = undefined; }; },
    restoreSessionWindows: () => service.restoreSnapshot(),
  });
  try {
    assert.match(home.container.textContent ?? "", /Restore storage unavailable/);
    assert.equal(home.restoreButton().disabled, true);
    assert.equal(loads, 1);
    available = true;
    await act(async () => home.dom.window.dispatchEvent(new home.dom.window.Event("focus")));
    assert.equal(home.container.textContent?.includes("Restore storage unavailable"), false);
    assert.equal(home.restoreButton().disabled, false);
    assert.equal(loads, 2);
    await act(async () => home.dom.window.dispatchEvent(new home.dom.window.Event("focus")));
    assert.equal(loads, 2);
    await act(async () => home.restoreButton().click());
    assert.deepEqual(opened, ["pending"]);
    assert.equal(home.restoreButton().disabled, true);
  } finally {
    await home.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Homeは回復通知後の古い初期取得errorを無視し、対象別復元失敗のfeedbackを通常の候補通知で消さない"
// oracle = { type = "contract", ref = "docs/features/session-window-restore.md#失敗時の扱い" }
// fault = "回復済み候補へ遅延errorを重ねるか、候補通知で対象別failureを隠す"
// observable = "Home DOMのfeedback、Restore button、復元API呼出し数"
// observation_boundary = "consumer"
// scope = "Home restore snapshot notification and stale initial failure"
// lifecycle = "permanent"
// @end-test-value
test("回復通知より古い取得errorを表示せず、対象別復元失敗は候補通知後も残す", async () => {
  let rejectInitial!: (error: Error) => void;
  const initial = new Promise<string[]>((_resolve, reject) => { rejectInitial = reject; });
  let onSnapshot: ((sessionIds: string[]) => void) | undefined;
  let restores = 0;
  const home = await mountHome({
    getSessionWindowRestoreSet: () => initial,
    subscribeSessionWindowRestoreSet(listener) { onSnapshot = listener; return () => { onSnapshot = undefined; }; },
    async restoreSessionWindows() {
      restores += 1;
      return { requestedSessionIds: ["saved"], openedSessionIds: [], failures: [{ sessionId: "saved", reason: "open-failed" }] };
    },
  });
  try {
    await act(async () => onSnapshot?.(["saved"]));
    await act(async () => rejectInitial(new Error("Stale initial error")));
    assert.equal(home.container.textContent?.includes("Stale initial error"), false);
    assert.equal(home.restoreButton().disabled, false);
    await act(async () => home.restoreButton().click());
    assert.equal(restores, 1);
    assert.match(home.container.textContent ?? "", /saved \(Could not open window\)/);
    await act(async () => onSnapshot?.(["saved", "other"]));
    assert.match(home.container.textContent ?? "", /saved \(Could not open window\)/);
  } finally {
    await home.dispose();
  }
});
