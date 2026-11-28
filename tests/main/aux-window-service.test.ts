import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src-shared/character/character-state.js";
import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import {
  CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
  DIFF_WINDOW_DEFAULT_BOUNDS,
  FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS,
} from "../../src-electron/windows/window-defaults.js";

/** 表示せずに作成、フォーカス、最小化、閉鎖を観測できるウィンドウの代替を作る。 */
function createWindowStub() {
  let destroyed = false;
  let minimized = false;
  let focusCount = 0;
  const events = new Map<string, Array<() => void>>();
  return {
    window: {
      /** 開発環境向けの URL 読み込みを実行せず完了させる。 */
      async loadURL() {},
      /** 配布用の画面ファイルを実際には開かない。 */
      async loadFile() {},
      /** 閉鎖されたウィンドウかを現在の状態から返す。 */
      isDestroyed: () => destroyed,
      /** テストが設定した最小化状態を返す。 */
      isMinimized: () => minimized,
      /** 再利用時の復帰を確認できるよう最小化を解除する。 */
      restore: () => {
        minimized = false;
      },
      /** 既存ウィンドウにフォーカスした回数を数える。 */
      focus: () => {
        focusCount += 1;
      },
      /** ウィンドウを画面に表示せずに表示要求を受ける。 */
      show: () => {},
      /** 破棄済みに切り替え、登録された閉鎖通知を発火する。 */
      close: () => {
        destroyed = true;
        for (const listener of events.get("closed") ?? []) {
          listener();
        }
      },
      /** 最前面化を実際のウィンドウへ適用しない。 */
      setAlwaysOnTop: () => {},
      /** 表示可能になる際の通知先をイベント名で登録する。 */
      once: (event: "ready-to-show", listener: () => void) => {
        const listeners = events.get(event) ?? [];
        listeners.push(listener);
        events.set(event, listeners);
      },
      /** 閉鎖時に呼ぶリスナーを登録し、破棄の検証に使う。 */
      on: (event: "closed", listener: () => void) => {
        const listeners = events.get(event) ?? [];
        listeners.push(listener);
        events.set(event, listeners);
      },
    },
    /** 再表示時の挙動を検証するために最小化状態を切り替える。 */
    setMinimized(value: boolean) {
      minimized = value;
    },
    /** 再利用によるフォーカス回数を検証側へ返す。 */
    getFocusCount() {
      return focusCount;
    },
  };
}

/** 一行の削除と追加を持つ差分プレビューの入力を作る。 */
function createDiffPreview(): DiffPreviewPayload {
  return {
    file: {
      kind: "edit",
      path: "src/file.ts",
      summary: "diff",
      diffRows: [
        { kind: "delete", leftNumber: 1, leftText: "old" },
        { kind: "add", rightNumber: 1, rightText: "new" },
      ],
    },
    title: "diff",
    themeColors: DEFAULT_CHARACTER_THEME_COLORS,
  };
}

// @test-value v2
// kind = "contract"
// claim = "singleton Windowを再利用し、live状態通知の宛先は生存するHome／Monitorに限定する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "singleton各windowの再利用・分類判定・close後のregistry解除またはlive状態宛先を誤る"
// observable = "home/settingsのwindow identity、load mode列、生成数、close後の判定、live状態宛先集合"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** Home の再オープンで同じ実体を使い、実行状態の通知先を開いている Home と Monitor に絞る。 */
test("AuxWindowService は singleton window を再利用する", async () => {
  const created: unknown[] = [];
  const homeLoads: string[] = [];
  const service = new AuxWindowService({
    /** 作成したウィンドウを記録し、種別ごとの再利用を生成数で確認できるようにする。 */
    createWindow() {
      const stub = createWindowStub();
      created.push(stub.window);
      return stub.window;
    },
    /** 共通の Home エントリーがどのモードで読み込まれたかを記録する。 */
    async loadHomeEntry(_window, mode) {
      homeLoads.push(mode);
    },
    /** 単独ウィンドウの検証では差分画面を表示しない。 */
    async loadDiffEntry() {},
    /** この検証ではファイルプレビュー画面を読み込まない。 */
    async loadFilePreviewEntry() {},
    /** この検証では個別チャット画面を読み込まない。 */
    async loadChatEntry() {},
    /** この検証ではキャラクター編集画面を読み込まない。 */
    async loadCharacterEditorEntry() {},
    /** プレビューに依存しない検証には既定のトークンを用意する。 */
    generateDiffToken() {
      return "diff-token";
    },
  });

  const first = await service.openHomeWindow();
  const second = await service.openHomeWindow();
  const settings = await service.openSettingsWindow();

  assert.equal(first, second);
  assert.notEqual(first, settings);
  assert.equal(service.isSettingsWindow(settings), true);
  assert.deepEqual(homeLoads, ["home", "settings"]);
  assert.equal(created.length, 2);
  const monitor = await service.openSessionMonitorWindow();
  assert.deepEqual(service.listLiveSessionRunStatusWindows(), [first, monitor]);
  monitor.close();
  assert.deepEqual(service.listLiveSessionRunStatusWindows(), [first]);
  settings.close();
  assert.equal(service.isSettingsWindow(settings), false);
});

// @test-value v2
// kind = "contract"
// claim = "起動状態を表示したWindowはentryを読み直さずHomeとして引き継がれる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window-startup" }
// fault = "Homeへの切替で別Windowを生成するか、表示中のentryを読み直して画面をちらつかせる"
// observable = "Window identity、Home registry、entry load回数、close後のregistry解除"
// observation_boundary = "public-boundary"
// scope = "AuxWindowService startup-to-Home handoff"
// lifecycle = "permanent"
// impact = "起動とHomeが二重表示されるか、切替時に描画が途切れる"
// distinction = "buildや単独renderer testではWindow identityとentry再loadの有無を確認できない"
// @end-test-value
/** 起動ウィンドウを Home に引き継ぎ、再生成もエントリーの再読込もせず、閉鎖後は登録を外す。 */
test("AuxWindowService は起動WindowをHomeとして引き継ぐ", async () => {
  const startupWindow = createWindowStub();
  const modes: string[] = [];
  let createdWindows = 0;
  const service = new AuxWindowService({
    /** 引き継ぎ時に新規生成が発生しないことを呼び出し回数で確認する。 */
    createWindow() {
      createdWindows += 1;
      return startupWindow.window;
    },
    /** エントリー再読込があれば対象とモードを捕捉する。 */
    async loadHomeEntry(window, mode) {
      assert.equal(window, startupWindow.window);
      modes.push(mode);
    },
    /** Home 引き継ぎの検証で差分エントリーは描画しない。 */
    async loadDiffEntry() {},
    /** Home 引き継ぎの検証でプレビューエントリーは描画しない。 */
    async loadFilePreviewEntry() {},
    /** Home 引き継ぎの検証でチャットエントリーは描画しない。 */
    async loadChatEntry() {},
    /** Home 引き継ぎの検証でキャラクター編集エントリーは描画しない。 */
    async loadCharacterEditorEntry() {},
    /** Home の引き継ぎに無関係な差分トークンを固定する。 */
    generateDiffToken() {
      return "diff-token";
    },
  });

  const homeWindow = await service.adoptHomeWindow(startupWindow.window);
  assert.equal(homeWindow, startupWindow.window);
  assert.equal(service.getHomeWindow(), startupWindow.window);
  assert.equal(await service.openHomeWindow(), startupWindow.window);
  assert.equal(createdWindows, 0);
  assert.deepEqual(modes, []);

  startupWindow.window.close();
  assert.equal(service.getHomeWindow(), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は diff preview を保持し reset 時に close する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "diff previewをregistryへ保存しないか、reset後もpreviewを残す"
// observable = "diff load token、preview取得結果、reset後のWindow destroyedとregistryのnull"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 差分をトークンで取得でき、初期化対象を閉じると関連ウィンドウと保存した差分を取り除くことを確認する。 */
test("AuxWindowService は diff preview を保持し reset 時に close する", async () => {
  const diffLoads: string[] = [];
  const diffStub = createWindowStub();
  const createdOptions: Array<Record<string, unknown>> = [];
  const service = new AuxWindowService({
    /** 差分ウィンドウの生成設定を捕捉し、固定の実体を返す。 */
    createWindow(options) {
      createdOptions.push(options);
      return diffStub.window;
    },
    /** 差分ウィンドウの検証では Home エントリーを起動しない。 */
    async loadHomeEntry() {},
    /** 差分画面に渡ったトークンを記録して保存済みデータと照合する。 */
    async loadDiffEntry(_window, token) {
      diffLoads.push(token);
    },
    /** 差分とは別のファイルプレビューの画面描画は行わない。 */
    async loadFilePreviewEntry() {},
    /** 差分表示の試験にチャット画面を読み込まない。 */
    async loadChatEntry() {},
    /** 差分表示の試験にキャラクター編集画面を読み込まない。 */
    async loadCharacterEditorEntry() {},
    /** 表示要求と保管内容の照合に同じ差分トークンを使う。 */
    generateDiffToken() {
      return "diff-token";
    },
  });

  await service.openDiffWindow(createDiffPreview());
  assert.ok(service.getDiffPreview("diff-token"));
  assert.deepEqual(diffLoads, ["diff-token"]);
  assert.deepEqual(createdOptions, [
    {
      ...DIFF_WINDOW_DEFAULT_BOUNDS,
      title: "Diff - src/file.ts",
    },
  ]);

  service.closeResetTargetWindows();
  assert.equal(diffStub.window.isDestroyed(), true);
  assert.equal(service.getDiffPreview("diff-token"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は同じ file preview resource を再利用し close 後は作り直す"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "同一resourceを別windowとして重複生成するか、close後にregistry・payloadを残す"
// observable = "created/focused disposition、window identity、navigation payload、preview payload、生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 同じファイルでは表示内容を切り替えて既存ウィンドウを使い、閉鎖後の再表示は新規に開く。 */
test("AuxWindowService は同じ file preview resource を再利用し close 後は作り直す", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  const previewLoads: string[] = [];
  const navigations: unknown[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    /** プレビュー用ウィンドウの生成設定と実体を呼び出し順で保存する。 */
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 同一ファイルのプレビューでは Home の画面を起動しない。 */
    async loadHomeEntry() {},
    /** ファイルプレビュー試験で単独の差分エントリーを描画しない。 */
    async loadDiffEntry() {},
    /** エントリーを最初に開いた回数とトークンを捕捉する。 */
    async loadFilePreviewEntry(_window, token) {
      previewLoads.push(token);
    },
    /** 既存ウィンドウに渡った新しいプレビュー内容を記録する。 */
    navigateFilePreviewWindow(_window, nextPayload) {
      navigations.push(nextPayload);
    },
    /** ファイルのビュー切り替えにはチャット画面を使わない。 */
    async loadChatEntry() {},
    /** ファイルのビュー切り替えにはキャラクター編集画面を使わない。 */
    async loadCharacterEditorEntry() {},
    /** 再生成したプレビューを以前の登録と区別できるようトークンに連番を付ける。 */
    generateDiffToken() {
      tokenSequence += 1;
      return `preview-${tokenSequence}`;
    },
  });
  const payload = {
    resource: {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "src/file.ts",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  };

  const first = await service.openFilePreviewWindow(payload);
  const reused = await service.openFilePreviewWindow({
    ...payload,
    view: { kind: "diff", scope: "working-tree" },
  });

  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(first.window, reused.window);
  assert.equal(stubs.length, 1);
  assert.equal(stubs[0]?.getFocusCount(), 1);
  assert.deepEqual(service.getFilePreviewPayload("preview-1"), {
    ...payload,
    displayPath: "C:/workspace/file",
    windowTitle: "file.ts",
    view: { kind: "diff", scope: "working-tree" },
  });
  assert.deepEqual(navigations, [
    {
      ...payload,
      displayPath: "C:/workspace/file",
      windowTitle: "file.ts",
      view: { kind: "diff", scope: "working-tree" },
    },
  ]);
  assert.equal(service.isFilePreviewWindow(first.window, "session-1"), true);
  assert.deepEqual(
    service.getFilePreviewWindowResource(first.window, "session-1"),
    payload.resource,
  );
  assert.equal(
    service.isFilePreviewTokenWindow(first.window, "preview-1"),
    true,
  );

  const otherPayload = {
    resource: {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "src/other.ts",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/other.ts",
  };
  const other = await service.openFilePreviewWindow(otherPayload);
  assert.equal(other.disposition, "created");
  assert.notEqual(other.window, first.window);

  first.window.close();
  assert.equal(service.getFilePreviewPayload("preview-1"), null);
  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.notEqual(reopened.window, first.window);
  assert.deepEqual(previewLoads, ["preview-1", "preview-2", "preview-3"]);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "file.ts" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "other.ts" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "file.ts" },
  ]);
  service.closeFilePreviewWindowsForSession("session-1");
  assert.equal(reopened.window.isDestroyed(), true);
  assert.equal(other.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("preview-3"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は file preview entry load 失敗時に registry と window を残さない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "entry load失敗後に破棄済みwindowまたはpreview registryを残し、再試行を妨げる"
// observable = "reject error、destroyed state、preview payload null、再open disposition"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** プレビューの読み込みで失敗したらウィンドウと登録を取り除き、同じ対象で再試行できるようにする。 */
test("AuxWindowService は file preview entry load 失敗時に registry と window を残さない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  let loadShouldFail = true;
  const service = new AuxWindowService({
    /** 初回失敗と再試行でそれぞれ作られたウィンドウと設定を捕捉する。 */
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** プレビューの失敗・再試行で Home を読み込まない。 */
    async loadHomeEntry() {},
    /** この失敗試験では単独の差分画面に遷移しない。 */
    async loadDiffEntry() {},
    /** タグの登録後に起きる画面読込エラーを再現し、再試行では成功を返す。 */
    async loadFilePreviewEntry() {
      if (loadShouldFail) {
        throw new Error("entry load failed");
      }
    },
    /** プレビューの失敗再現にチャット画面を介さない。 */
    async loadChatEntry() {},
    /** プレビューの失敗再現にキャラクター編集画面を介さない。 */
    async loadCharacterEditorEntry() {},
    /** 生成済みウィンドウの数から、失敗した登録と再試行の登録を区別する。 */
    generateDiffToken() {
      return `preview-${stubs.length}`;
    },
  });
  const payload = {
    resource: {
      sessionId: "session-1",
      rootId: "workspace",
      relativePath: "src/file.ts",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "",
  };

  await assert.rejects(
    () => service.openFilePreviewWindow(payload),
    /entry load failed/,
  );
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("preview-1"), null);

  loadShouldFail = false;
  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.equal(stubs.length, 2);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "File Preview" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "File Preview" },
  ]);
  assert.equal(
    service.getFilePreviewPayload("preview-1")?.windowTitle,
    "File Preview",
  );
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は commit file preview を root・repository・commit・path 単位で再利用する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "repository・commit・pathの識別を混同し、異なるcommitを既存previewへ再利用する"
// observable = "root・repository・commit・pathの各識別子差分に対するcreated/focused disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** コミット内ファイルのプレビューをリポジトリ、コミット、ファイルパスの組み合わせで再利用する。 */
test("AuxWindowService は commit file preview を repository・commit・path 単位で再利用する", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    /** コミット内の参照を変えたときのウィンドウ生成を観測する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** コミットのプレビューでは Home を読み込まない。 */
    async loadHomeEntry() {},
    /** コミットのプレビューで単独の差分画面は表示しない。 */
    async loadDiffEntry() {},
    /** 識別キーの比較ではファイル画面そのものを読み込まず完了させる。 */
    async loadFilePreviewEntry() {},
    /** コミット内ファイルの識別にチャット画面を起動しない。 */
    async loadChatEntry() {},
    /** コミット内ファイルの識別にキャラクター編集画面を起動しない。 */
    async loadCharacterEditorEntry() {},
    /** コミットのプレビュー登録に通し番号を付ける。 */
    generateDiffToken() {
      tokenSequence += 1;
      return `commit-preview-${tokenSequence}`;
    },
  });
  const resource = {
    resourceKind: "git-commit-file" as const,
    sessionId: "session-1",
    rootId: "workspace",
    repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
    commitId: "a".repeat(40),
    relativePath: "src/file.ts",
  };
  const first = await service.openFilePreviewWindow({
    resource,
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  });
  const reused = await service.openFilePreviewWindow({
    resource: { ...resource },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  });
  const otherCommit = await service.openFilePreviewWindow({
    resource: { ...resource, commitId: "b".repeat(40) },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  });
  const otherRoot = await service.openFilePreviewWindow({
    resource: { ...resource, rootId: "workspace-2" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  });
  const otherRepository = await service.openFilePreviewWindow({
    resource: { ...resource, repositoryId: "git:bbbbbbbbbbbbbbbbbbbbbbbb" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/file.ts",
  });
  const otherPath = await service.openFilePreviewWindow({
    resource: { ...resource, relativePath: "src/other.ts" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "src/other.ts",
  });

  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(reused.window, first.window);
  assert.equal(otherCommit.disposition, "created");
  assert.notEqual(otherCommit.window, first.window);
  assert.equal(otherRoot.disposition, "created");
  assert.equal(otherRepository.disposition, "created");
  assert.equal(otherPath.disposition, "created");
  assert.equal(stubs.length, 5);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は absolute file preview を path 単位で再利用し close 後に破棄する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "同一absolute pathを再利用せず、close後のpayloadを残す"
// observable = "created/focused disposition、window生成数、destroy後payload null、window title"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 絶対パスが同じプレビューは再利用し、閉じるとそのパスに対応する登録を取り除く。 */
test("AuxWindowService は absolute file preview を path 単位で再利用し close 後に破棄する", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    /** 絶対パス用のウィンドウとその表示設定を捕捉する。 */
    createWindow(options) {
      createdOptions.push(options);
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 絶対パスの照合では Home エントリーを読み込まない。 */
    async loadHomeEntry() {},
    /** 絶対パスの表示で別の差分エントリーを開かない。 */
    async loadDiffEntry() {},
    /** ファイルにアクセスせずプレビューのエントリー読込を完了させる。 */
    async loadFilePreviewEntry() {},
    /** 絶対パスの再利用検証でチャットを表示しない。 */
    async loadChatEntry() {},
    /** 絶対パスの再利用検証でキャラクター編集を表示しない。 */
    async loadCharacterEditorEntry() {},
    /** 絶対パスの各プレビュー登録を連番のトークンで識別する。 */
    generateDiffToken() {
      tokenSequence += 1;
      return `absolute-preview-${tokenSequence}`;
    },
  });
  const payload = {
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "C:\\Users\\private\\notes.md",
  };

  const first = await service.openFilePreviewWindow(payload);
  const reused = await service.openFilePreviewWindow(payload);
  assert.equal(first.disposition, "created");
  assert.equal(reused.disposition, "focused");
  assert.equal(stubs.length, 1);
  first.window.close();
  assert.equal(service.getFilePreviewPayload("absolute-preview-1"), null);

  const reopened = await service.openFilePreviewWindow(payload);
  assert.equal(reopened.disposition, "created");
  assert.equal(stubs.length, 2);
  assert.deepEqual(createdOptions, [
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "notes.md" },
    { ...FILE_PREVIEW_WINDOW_DEFAULT_BOUNDS, title: "notes.md" },
  ]);
  assert.equal(
    service.getFilePreviewPayload("absolute-preview-2")?.windowTitle,
    "notes.md",
  );
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は大小文字だけが異なる absolute path を別 Preview として扱う"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "pathの大文字小文字を正規化しすぎて異なるPreviewを同一windowへ束ねる"
// observable = "各openのcreated disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 大文字・小文字だけが違う絶対パスのプレビューを同じウィンドウにまとめない。 */
test("AuxWindowService は大小文字だけが異なる absolute path を別 Preview として扱う", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    /** パスの大文字・小文字の違いで別ウィンドウが生成されるかを記録する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** パスの文字ケース比較に Home の実画面を読み込まない。 */
    async loadHomeEntry() {},
    /** パスの文字ケース比較に差分画面の読み込みを使わない。 */
    async loadDiffEntry() {},
    /** 文字ケースの異なる二つのプレビューを画面なしで開けるようにする。 */
    async loadFilePreviewEntry() {},
    /** パスの文字ケース比較ではチャットを読み込まない。 */
    async loadChatEntry() {},
    /** パスの文字ケース比較ではキャラクター編集を読み込まない。 */
    async loadCharacterEditorEntry() {},
    /** 生成した別々のプレビューをトークンでも識別する。 */
    generateDiffToken() {
      tokenSequence += 1;
      return `case-preview-${tokenSequence}`;
    },
  });

  const upper = await service.openFilePreviewWindow({
    resource: {
      sessionId: "session-1",
      absolutePath: "C:\\case-sensitive\\Report.md",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "Report.md",
  });
  const lower = await service.openFilePreviewWindow({
    resource: {
      sessionId: "session-1",
      absolutePath: "C:\\case-sensitive\\report.md",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "report.md",
  });

  assert.equal(upper.disposition, "created");
  assert.equal(lower.disposition, "created");
  assert.notEqual(upper.window, lower.window);
  assert.equal(stubs.length, 2);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は literal backslash を含む canonical path を separator path と区別する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "literal backslashとseparatorを同一pathとして扱いPreviewを誤って共有する"
// observable = "各openのcreated disposition、window identity、stub生成数"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** パス名に含まれる文字としてのバックスラッシュを区切り記号の別表現に置換しない。 */
test("AuxWindowService は literal backslash を含む canonical path を separator path と区別する", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  let tokenSequence = 0;
  const service = new AuxWindowService({
    /** 異なるパス表現ごとに生成したウィンドウを捕捉する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 区切り文字の比較に Home を表示しない。 */
    async loadHomeEntry() {},
    /** 区切り文字の比較に差分エントリーを使わない。 */
    async loadDiffEntry() {},
    /** パス表現の検証ではファイルプレビューの画面を実際に描画しない。 */
    async loadFilePreviewEntry() {},
    /** 区切り文字の比較にチャット画面を読み込まない。 */
    async loadChatEntry() {},
    /** 区切り文字の比較にキャラクター編集画面を読み込まない。 */
    async loadCharacterEditorEntry() {},
    /** 区切り文字の異なる各プレビューの登録をトークンで区別する。 */
    generateDiffToken() {
      tokenSequence += 1;
      return `separator-preview-${tokenSequence}`;
    },
  });

  const literalBackslash = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "/tmp/a\\b" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "a\\b",
  });
  const separatorPath = await service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "/tmp/a/b" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "b",
  });

  assert.equal(literalBackslash.disposition, "created");
  assert.equal(separatorPath.disposition, "created");
  assert.notEqual(literalBackslash.window, separatorPath.window);
  assert.equal(stubs.length, 2);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は entry load 中に閉じた Session を opened 扱いにしない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "entry load中のSession close後もopen処理を成功扱いし、window・payloadを残す"
// observable = "reject error、destroyed state、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** エントリーの読込中に Session が閉じた場合は完了後も成功として返さず、登録とウィンドウを片付ける。 */
test("AuxWindowService は entry load 中に閉じた Session を opened 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const loadControl = { resolve: undefined as (() => void) | undefined };
  const load = new Promise<void>((resolve) => {
    loadControl.resolve = resolve;
  });
  const service = new AuxWindowService({
    /** 読み込み中に閉じたプレビューの破棄を検査できるよう生成先を保持する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 読込中の閉鎖試験では Home を読み込まない。 */
    async loadHomeEntry() {},
    /** 読込中の閉鎖試験では差分画面を使わない。 */
    async loadDiffEntry() {},
    /** ウィンドウを閉じた後に読み込みを再開できるよう保留する。 */
    async loadFilePreviewEntry() {
      await load;
    },
    /** プレビュー読込中の閉鎖にチャットを介さない。 */
    async loadChatEntry() {},
    /** プレビュー読込中の閉鎖にキャラクター編集を介さない。 */
    async loadCharacterEditorEntry() {},
    /** 失効したプレビューの登録が破棄されたかを固定トークンで照合する。 */
    generateDiffToken() {
      return "delayed-preview";
    },
  });
  const opening = service.openFilePreviewWindow({
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "notes.md",
  });

  service.closeFilePreviewWindowsForSession("session-1");
  loadControl.resolve?.();

  await assert.rejects(opening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("delayed-preview"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は共有 entry load 中に閉じた Session を reused 扱いにしない"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "共有load中のSession close後に再利用処理を成功扱いし、registryを残す"
// observable = "両openのreject error、destroyed state、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 同じ読込を待つ複数要求は、所有 Session が閉じた時点で新規・再利用のどちらも成功させない。 */
test("AuxWindowService は共有 entry load 中に閉じた Session を reused 扱いにしない", async () => {
  const stubs: ReturnType<typeof createWindowStub>[] = [];
  const loadControl = { resolve: undefined as (() => void) | undefined };
  const load = new Promise<void>((resolve) => {
    loadControl.resolve = resolve;
  });
  const service = new AuxWindowService({
    /** 共同で待っているプレビュー用に作ったウィンドウを捕捉する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 複数のプレビュー要求で Home を読み込まない。 */
    async loadHomeEntry() {},
    /** 複数のプレビュー要求で単独の差分画面を使わない。 */
    async loadDiffEntry() {},
    /** 二つの表示要求が同じ読み込みの完了を待つ状況を作る。 */
    async loadFilePreviewEntry() {
      await load;
    },
    /** 共有読込の検証ではチャットを開かない。 */
    async loadChatEntry() {},
    /** 共有読込の検証ではキャラクター編集を開かない。 */
    async loadCharacterEditorEntry() {},
    /** 二つの要求が共有したプレビューの登録を特定するトークンを返す。 */
    generateDiffToken() {
      return "shared-delayed-preview";
    },
  });
  const payload = {
    resource: { sessionId: "session-1", absolutePath: "C:\\outside\\notes.md" },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "notes.md",
  };
  const firstOpening = service.openFilePreviewWindow(payload);
  const reusedOpening = service.openFilePreviewWindow(payload);

  service.closeFilePreviewWindowsForSession("session-1");
  loadControl.resolve?.();

  await assert.rejects(firstOpening, /Session is no longer active/);
  await assert.rejects(reusedOpening, /Session is no longer active/);
  assert.equal(stubs[0]?.window.isDestroyed(), true);
  assert.equal(service.getFilePreviewPayload("shared-delayed-preview"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は close 済み Session の遅延 file preview admission を拒否する"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "close済みSessionのpreview admissionを受け入れwindowやpayloadを作成する"
// observable = "reject error、stub生成数、preview payload null"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** 既に閉じた Session から遅れて届いたプレビューを、ウィンドウも登録も作らず拒否する。 */
test("AuxWindowService は close 済み Session の遅延 file preview admission を拒否する", async () => {
  const stubs: Array<ReturnType<typeof createWindowStub>> = [];
  const service = new AuxWindowService({
    /** 遅延要求を拒否する前にウィンドウが作られていないかを観測する。 */
    createWindow() {
      const stub = createWindowStub();
      stubs.push(stub);
      return stub.window;
    },
    /** 遅延要求から Home の画面を読み込まない。 */
    loadHomeEntry: async () => {},
    /** 遅延要求から差分画面を読み込まない。 */
    loadDiffEntry: async () => {},
    /** 拒否試験で実際のファイルプレビューの画面を使わない。 */
    loadFilePreviewEntry: async () => {},
    /** 遅延要求にチャット画面を介さない。 */
    loadChatEntry: async () => {},
    /** 遅延要求にキャラクター編集画面を介さない。 */
    loadCharacterEditorEntry: async () => {},
    /** 拒否されたプレビューの登録有無を照合するため固定トークンを返す。 */
    generateDiffToken: () => "preview-1",
  });
  const payload = {
    resource: {
      sessionId: "aux-1",
      rootId: "workspace",
      relativePath: "src/file.ts",
    },
    ownerSessionId: "session-1",
    displayPath: "C:/workspace/file",
    windowTitle: "file.ts",
  };

  service.closeFilePreviewWindowsForSession("aux-1");

  await assert.rejects(
    () => service.openFilePreviewWindow(payload),
    /Session is no longer active/,
  );
  assert.equal(stubs.length, 0);
  assert.equal(service.getFilePreviewPayload("preview-1"), null);
});

// @test-value v2
// kind = "contract"
// claim = "AuxWindowService は Character Editor window を create/edit key ごとに再利用し、役割に合うtitleを付ける"
// oracle = { type = "contract", ref = "src-electron/auxiliary/aux-window-service.ts" }
// fault = "create keyとedit keyのwindowを混同するか、同一keyを再利用しない"
// observable = "window identity、characterId load列、created optionsのtitle"
// observation_boundary = "public-boundary"
// scope = "tests/main/aux-window-service.test.ts"
// lifecycle = "permanent"
// @end-test-value
/** キャラクターの新規作成と既存キャラクターの編集を区別し、同じキーで開いた場合は再利用する。 */
test("AuxWindowService は Character Editor window を create/edit key ごとに再利用する", async () => {
  const characterEditorLoads: Array<string | null | undefined> = [];
  const createdOptions: Array<Record<string, unknown>> = [];
  const service = new AuxWindowService({
    /** 作成時に指定されたタイトルやサイズなどの画面設定を記録する。 */
    createWindow(options) {
      const stub = createWindowStub();
      createdOptions.push(options);
      return stub.window;
    },
    /** キャラクター編集画面の検証で Home エントリーを開かない。 */
    async loadHomeEntry() {},
    /** キャラクター編集画面の検証で差分画面を開かない。 */
    async loadDiffEntry() {},
    /** キャラクター編集画面の検証でファイルプレビューを開かない。 */
    async loadFilePreviewEntry() {},
    /** キャラクター編集画面の検証でチャットを読み込まない。 */
    async loadChatEntry() {},
    /** 新規作成を示す空の識別子と既存キャラクターの識別子を別々に記録する。 */
    async loadCharacterEditorEntry(_window, characterId) {
      characterEditorLoads.push(characterId);
    },
    /** キャラクター編集に無関係な差分トークンを固定する。 */
    generateDiffToken() {
      return "diff-token";
    },
  });

  const createWindow = await service.openCharacterEditorWindow();
  const createWindowReopened = await service.openCharacterEditorWindow(null);
  const editWindow = await service.openCharacterEditorWindow("char-1");
  const editWindowReopened = await service.openCharacterEditorWindow("char-1");

  assert.equal(createWindow, createWindowReopened);
  assert.equal(editWindow, editWindowReopened);
  assert.notEqual(createWindow, editWindow);
  assert.deepEqual(characterEditorLoads, [null, "char-1"]);
  assert.deepEqual(createdOptions, [
    {
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: "New Character",
    },
    {
      ...CHARACTER_EDITOR_WINDOW_DEFAULT_BOUNDS,
      title: "Character Editor",
    },
  ]);
});
