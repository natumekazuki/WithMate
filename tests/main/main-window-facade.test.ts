import assert from "node:assert/strict";
import test from "node:test";

import { MainWindowFacade } from "../../src-electron/app/main-window-facade.js";
import type { SessionFilePreviewWindowSummary } from "../../src-shared/file-explorer/file-explorer-contract.js";

// @test-value v2
// kind = "contract"
// claim = "MainWindowFacadeのWindow操作は対象serviceへ渡され、reset時はSessionと補助Windowの両方を閉じる"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#windowの再利用と配置" }
// fault = "Window操作を別serviceや誤った対象へ渡す、Window種別判定を誤る、reset時に一方のWindow群を残す"
// observable = "各公開操作のdelegate引数と呼出し記録、Window種別判定、open Session IDs"
// observation_boundary = "public-boundary"
// scope = "MainWindowFacadeのWindow操作委譲"
// lifecycle = "permanent"
// impact = "HomeからのWindow起動とreset対象の一括終了を正しい所有者へ接続する"
// distinction = "型検査は引数や同型delegateの取り違えを検出せず、Electron起動なしの同期mockで接続を確認する"
// @end-test-value
test("MainWindowFacade は aux/session window service を束ねる", async () => {
  const calls: string[] = [];
  const facade = new MainWindowFacade({
    getAuxWindowService: () =>
      ({
        async openHomeWindow() {
          calls.push("home");
          return { id: "home" };
        },
        async openSessionMonitorWindow() {
          calls.push("monitor");
          return { id: "monitor" };
        },
        async openSettingsWindow() {
          calls.push("settings");
          return { id: "settings" };
        },
        async openMemoryV6ReviewWindow() {
          calls.push("memory-review");
          return { id: "memory-review" };
        },
        isSettingsWindow(window: { id: string }) {
          calls.push(`is-settings:${window.id}`);
          return window.id === "settings";
        },
        isMemoryV6ReviewWindow(window: { id: string }) {
          calls.push(`is-memory-review:${window.id}`);
          return window.id === "memory-review";
        },
        async openCharacterEditorWindow(characterId?: string | null) {
          calls.push(`character:${characterId ?? "new"}`);
          return { id: characterId ?? "new" };
        },
        async openDiffWindow() {
          calls.push("diff");
          return { id: "diff" };
        },
        closeResetTargetWindows() {
          calls.push("close-aux");
        },
      }) as never,
    getSessionWindowBridge: () =>
      ({
        async openSessionWindow(sessionId: string) {
          calls.push(`session:${sessionId}`);
          return { id: sessionId };
        },
        listOpenSessionWindowIds() {
          calls.push("list-session");
          return ["s-1", "s-2"];
        },
        closeAllSessionWindows() {
          calls.push("close-session");
        },
      }) as never,
  });

  await facade.openHomeWindow();
  await facade.openSessionMonitorWindow();
  await facade.openSettingsWindow();
  await facade.openMemoryV6ReviewWindow();
  assert.equal(facade.isSettingsWindow({ id: "settings" } as never), true);
  assert.equal(facade.isMemoryV6ReviewWindow({ id: "memory-review" } as never), true);
  await facade.openCharacterEditorWindow("char-1");
  await facade.openSessionWindow("s-1");
  await facade.openDiffWindow({ token: "d-1" } as never);
  assert.deepEqual(facade.listOpenSessionWindowIds(), ["s-1", "s-2"]);
  facade.closeResetTargetWindows();

  assert.deepEqual(calls, [
    "home",
    "monitor",
    "settings",
    "memory-review",
    "is-settings:settings",
    "is-memory-review:memory-review",
    "character:char-1",
    "session:s-1",
    "diff",
    "list-session",
    "close-session",
    "close-aux",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Previews投影は開いているSessionを0件でもWindow順で残し、閉じたSessionの残存Previewも重複なく含める"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#windowの再利用と配置" }
// fault = "Preview Close Allで開いている親を除去または並べ替える、親を重複する、閉じた親の残存Previewを隠す"
// observable = "WindowとPreviewの開閉前後の公開group一覧、owner順と各Preview token"
// observation_boundary = "public-boundary"
// scope = "MainWindowFacadeのSession Window mapとPreview registryの合成"
// lifecycle = "permanent"
// impact = "Homeの同数時の基準順を保ちつつSession本体が閉じた後のPreviewも整理できる"
// distinction = "renderer fixtureと個別registryのtestでは2種類のWindow集合の合成を検証できず、同期投影の小さなtestで保証する"
// @end-test-value
test("Preview groups retain all open sessions and remaining detached previews", () => {
  let openIds = ["empty", "open"];
  let previews: Array<{ ownerSessionId: string; previews: SessionFilePreviewWindowSummary[] }> = [
    { ownerSessionId: "detached", previews: [{ token: "detached-token", title: "report.md", path: "C:/detached/report.md" }] },
    { ownerSessionId: "open", previews: [{ token: "open-token", title: "report.md", path: "C:/open/report.md" }] },
  ];
  const facade = new MainWindowFacade({
    getAuxWindowService: () => ({ listFilePreviewWindows: () => previews }) as never,
    getSessionWindowBridge: () => ({ listOpenSessionWindowIds: () => openIds }) as never,
  });
  const snapshot = () => facade.listFilePreviewWindows().map((entry) => [entry.ownerSessionId, entry.previews.map((preview) => preview.token)]);
  assert.deepEqual(snapshot(), [["empty", []], ["open", ["open-token"]], ["detached", ["detached-token"]]]);
  previews = [previews[0]!];
  assert.deepEqual(snapshot(), [["empty", []], ["open", []], ["detached", ["detached-token"]]]);
  openIds = ["open", "new"];
  assert.deepEqual(snapshot(), [["open", []], ["new", []], ["detached", ["detached-token"]]]);
  openIds = [];
  assert.deepEqual(snapshot(), [["detached", ["detached-token"]]]);
  previews = [];
  assert.deepEqual(snapshot(), []);
});
