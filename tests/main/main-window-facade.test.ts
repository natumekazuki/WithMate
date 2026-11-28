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
/** 補助窓とセッション窓の操作をそれぞれの所有者に委ね、リセットでは両方を順に閉じることを確認する。 */
test("MainWindowFacade は aux/session window service を束ねる", async () => {
  const calls: string[] = [];
  const facade = new MainWindowFacade({
    /** Home や設定などの補助窓操作を監視するサービスを返す。 */
    getAuxWindowService: () =>
      ({
        /** Home の起動が補助窓に委譲されることを記録する。 */
        async openHomeWindow() {
          calls.push("home");
          return { id: "home" };
        },
        /** 監視窓の起動を Home と区別して記録する。 */
        async openSessionMonitorWindow() {
          calls.push("monitor");
          return { id: "monitor" };
        },
        /** 設定窓を開く要求を記録する。 */
        async openSettingsWindow() {
          calls.push("settings");
          return { id: "settings" };
        },
        /** 渡された窓 ID を記録し、設定窓だけを該当とする。 */
        isSettingsWindow(window: { id: string }) {
          calls.push(`is-settings:${window.id}`);
          return window.id === "settings";
        },
        /** 編集対象の Character ID が渡ったか、未指定だったかを記録する。 */
        async openCharacterEditorWindow(characterId?: string | null) {
          calls.push(`character:${characterId ?? "new"}`);
          return { id: characterId ?? "new" };
        },
        /** 差分窓の起動が補助窓に届いたことを記録する。 */
        async openDiffWindow() {
          calls.push("diff");
          return { id: "diff" };
        },
        /** リセット時に補助窓まで閉じたことを記録する。 */
        closeResetTargetWindows() {
          calls.push("close-aux");
        },
      }) as never,
    /** セッション窓専用の操作と一覧を監視する橋渡しを返す。 */
    getSessionWindowBridge: () =>
      ({
        /** 渡されたセッション ID を使って窓を開いたことを記録する。 */
        async openSessionWindow(sessionId: string) {
          calls.push(`session:${sessionId}`);
          return { id: sessionId };
        },
        /** 一覧の委譲を記録し、順序付きのセッション ID を返す。 */
        listOpenSessionWindowIds() {
          calls.push("list-session");
          return ["s-1", "s-2"];
        },
        /** リセット時のセッション窓の終了を記録する。 */
        closeAllSessionWindows() {
          calls.push("close-session");
        },
      }) as never,
  });

  await facade.openHomeWindow();
  await facade.openSessionMonitorWindow();
  await facade.openSettingsWindow();
  assert.equal(facade.isSettingsWindow({ id: "settings" } as never), true);
  await facade.openCharacterEditorWindow("char-1");
  await facade.openSessionWindow("s-1");
  await facade.openDiffWindow({ token: "d-1" } as never);
  assert.deepEqual(facade.listOpenSessionWindowIds(), ["s-1", "s-2"]);
  facade.closeResetTargetWindows();

  assert.deepEqual(calls, [
    "home",
    "monitor",
    "settings",
    "is-settings:settings",
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
/** 開いているセッションをプレビューなしでも窓の順に並べ、親が閉じたプレビューも重複なく残すことを確認する。 */
test("Preview groups retain all open sessions and remaining detached previews", () => {
  let openIds = ["empty", "open"];
  let previews: Array<{
    ownerSessionId: string;
    previews: SessionFilePreviewWindowSummary[];
  }> = [
    {
      ownerSessionId: "detached",
      previews: [
        {
          token: "detached-token",
          title: "report.md",
          path: "C:/detached/report.md",
        },
      ],
    },
    {
      ownerSessionId: "open",
      previews: [
        { token: "open-token", title: "report.md", path: "C:/open/report.md" },
      ],
    },
  ];
  const facade = new MainWindowFacade({
    /** 更新可能なプレビュー登録一覧への窓口を返す。 */
    getAuxWindowService: () =>
      ({
        /** 現在のプレビューを所有セッションごとに返す。 */
        listFilePreviewWindows: () => previews,
      }) as never,
    /** 試験段階ごとのセッション窓の順序を参照できる橋渡しを返す。 */
    getSessionWindowBridge: () =>
      ({
        /** 現在開いているセッションの ID を窓の順で返す。 */
        listOpenSessionWindowIds: () => openIds,
      }) as never,
  });
  /** 合成結果を所有セッション ID とプレビュートークンへ絞り、順序と重複を検査できるようにする。 */
  const snapshot = () =>
    facade
      .listFilePreviewWindows()
      .map((entry) => [
        entry.ownerSessionId,
        entry.previews.map((preview) => preview.token),
      ]);
  assert.deepEqual(snapshot(), [
    ["empty", []],
    ["open", ["open-token"]],
    ["detached", ["detached-token"]],
  ]);
  previews = [previews[0]!];
  assert.deepEqual(snapshot(), [
    ["empty", []],
    ["open", []],
    ["detached", ["detached-token"]],
  ]);
  openIds = ["open", "new"];
  assert.deepEqual(snapshot(), [
    ["open", []],
    ["new", []],
    ["detached", ["detached-token"]],
  ]);
  openIds = [];
  assert.deepEqual(snapshot(), [["detached", ["detached-token"]]]);
  previews = [];
  assert.deepEqual(snapshot(), []);
});
