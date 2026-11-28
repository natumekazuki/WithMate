import assert from "node:assert/strict";
import test from "node:test";
import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import { registerWindowHandlers } from "../../src-electron/ipc/window.js";
import type { MainIpcWindowDeps } from "../../src-electron/ipc/contracts.js";
import type { SessionFilePreviewWindowPayload } from "../../src-shared/file-explorer/file-explorer-contract.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";

/** 実 Electron 窓の代わりに、生成した窓と内容の再読込み・一覧変更を観測できるサービスを用意する。 */
function setup(loadFilePreviewEntry: () => Promise<void> = async () => {}) {
  let nextToken = 0;
  let changes = 0;
  let navigations = 0;
  const windows: ReturnType<typeof createWindow>[] = [];
  /** 最小化・フォーカス・終了を個別に記録するプレビュー窓を作る。 */
  function createWindow() {
    let destroyed = false;
    let minimized = true;
    let focuses = 0;
    const closed: Array<() => void> = [];
    return {
      /** この試験では URL の読込みを行わず、登録や窓操作を観測する。 */
      async loadURL() {},
      /** 実ファイルは Electron に読み込ませない。 */
      async loadFile() {},
      /** close が呼ばれた後は破棄済みとして扱う。 */
      isDestroyed: () => destroyed,
      /** 最小化状態は restore が呼ばれるまで維持する。 */
      isMinimized: () => minimized,
      /** フォーカス前の復元を状態に反映する。 */
      restore() {
        minimized = false;
      },
      /** 選択された窓へのフォーカス要求を数える。 */
      focus() {
        focuses++;
      },
      /** 実際のデスクトップ表示は行わない。 */
      show() {},
      /** デスクトップの重なり順は試験対象にしない。 */
      setAlwaysOnTop() {},
      /** 一回限りの窓イベントはこの試験窓では発火させない。 */
      once() {},
      /** 登録表を片付けるための closed リスナーを保持する。 */
      on(_event: "closed", listener: () => void) {
        closed.push(listener);
      },
      /** 窓を破棄済みにして登録された終了リスナーへ通知する。 */
      close() {
        destroyed = true;
        closed.forEach((listener) => listener());
      },
      /** 窓ごとに記録したフォーカス回数を返す。 */
      focuses: () => focuses,
    };
  }
  const service = new AuxWindowService({
    /** 開くたびに独立した試験窓を割り当て、順に記録する。 */
    createWindow: () => {
      const window = createWindow();
      windows.push(window);
      return window;
    },
    /** プレビュー以外の Home エントリは読込まない。 */
    async loadHomeEntry() {},
    /** 差分専用窓のエントリ読込みはこの試験では使わない。 */
    async loadDiffEntry() {},
    loadFilePreviewEntry,
    /** チャット画面の読込みは起動しない。 */
    async loadChatEntry() {},
    /** Character Editor のエントリは読み込まない。 */
    async loadCharacterEditorEntry() {},
    /** 内容移動をフォーカス操作と区別できるように数える。 */
    navigateFilePreviewWindow: () => {
      navigations++;
    },
    /** 開き直した窓と古い窓を区別できる連番トークンを返す。 */
    generateDiffToken: () => `preview-${++nextToken}`,
    /** プレビュー一覧が変更された通知を数える。 */
    onFilePreviewWindowsChanged: () => {
      changes++;
    },
  });
  return {
    service,
    windows,
    /** 試験中に届いた一覧変更通知の回数を返す。 */
    changes: () => changes,
    /** ファイル表示内容を移動する要求の回数を返す。 */
    navigations: () => navigations,
  };
}

// @test-value v2
// kind = "contract"
// claim = "全Previewは親Sessionで集約され、focusは表示内容を変更せず、親単位close後も新しく開ける"
// oracle = { type = "contract", ref = "Issue #858 Home Previews parent grouping and independent window management" }
// fault = "Auxを別親へ分離する、focusでresourceを再navigateする、一括closeで別親を閉じるか再openを禁止する"
// observable = "公開一覧のownerとtoken、windowのfocus/minimize状態、navigation数、close後の一覧と再open結果"
// observation_boundary = "public-boundary"
// scope = "AuxWindowService Preview management"
// lifecycle = "permanent"
// impact = "Homeから作業中のPreview内容や別SessionのWindowを失わず整理できる"
// distinction = "型検査では実Windowの復帰、親の隔離、close後の再admissionを保証できない"
// @end-test-value
/** Main と Auxiliary のプレビューを親単位で集約し、フォーカスは内容を変えず、一括終了後も他の親や新規起動に影響しないことを確認する。 */
test("Preview一覧は親で集約しfocusとcloseを独立管理する", async () => {
  const { service, windows, changes, navigations } = setup();
  const payload: SessionFilePreviewWindowPayload = {
    ownerSessionId: "parent",
    displayPath: "C:/workspace/a.md",
    windowTitle: "a.md",
    resource: {
      sessionId: "parent",
      rootId: "workspace",
      relativePath: "a.md",
    },
  };
  await service.openFilePreviewWindow(payload);
  await service.openFilePreviewWindow({
    ...payload,
    displayPath: "C:/sessions/parent/a.md",
    resource: {
      sessionId: "aux",
      rootId: "session-folder",
      relativePath: "a.md",
    },
  });
  await service.openFilePreviewWindow({
    ...payload,
    ownerSessionId: "other",
    resource: { sessionId: "other", absolutePath: "C:/a.md" },
  });
  assert.deepEqual(
    service
      .listFilePreviewWindows()
      .map((group) => [group.ownerSessionId, group.previews.length]),
    [
      ["parent", 2],
      ["other", 1],
    ],
  );
  assert.deepEqual(
    service.listFilePreviewWindows()[0]?.previews.map((item) => item.path),
    ["C:/workspace/a.md", "C:/sessions/parent/a.md"],
  );
  const token = service.listFilePreviewWindows()[0]!.previews[0]!.token;
  service.focusFilePreviewWindow(token);
  assert.equal(windows[0]!.focuses(), 1);
  assert.equal(windows[0]!.isMinimized(), false);
  assert.equal(navigations(), 0);
  assert.equal(changes(), 3);
  await service.openFilePreviewWindow({
    ...payload,
    view: { kind: "diff", scope: "working-tree" },
  });
  assert.equal(navigations(), 1);
  assert.equal(changes(), 4);
  service.closeFilePreviewWindowsForOwner("parent");
  assert.deepEqual(
    service.listFilePreviewWindows().map((group) => group.ownerSessionId),
    ["other"],
  );
  assert.equal(windows[2]!.isDestroyed(), false);
  assert.equal(changes(), 6);
  await service.openFilePreviewWindow(payload);
  assert.equal(service.listFilePreviewWindows().length, 2);
  service.closeFilePreviewWindow(token);
  service.focusFilePreviewWindow(token);
  windows[3]!.close();
  assert.equal(changes(), 8);
  assert.equal(service.listFilePreviewWindows().length, 1);
});

// @test-value v2
// kind = "contract"
// claim = "Preview一覧はcommitと履歴比較の実path・revisionを区別し、load失敗したWindowを通知付きで除去する"
// oracle = { type = "contract", ref = "Issue #858 identifying Preview paths and live registry updates" }
// fault = "revisionを省いて同名履歴を識別不能にするか、load失敗のWindowを一覧へ残す"
// observable = "一覧のpathと軽量summary key集合、load例外、失敗前後のchanged回数と一覧"
// observation_boundary = "public-boundary"
// scope = "AuxWindowService Preview projection and failed admission"
// lifecycle = "permanent"
// impact = "大きなpatch本文を一覧へ渡さず正しい履歴Windowを選べる"
// distinction = "UI fixtureや型検査ではMain registryの投影と非同期load失敗後の通知を検証できない"
// @end-test-value
/** 同じパスの履歴窓を revision 付きの小さな一覧項目で識別し、読込み失敗時は窓を一覧から除去して通知することを確かめる。 */
test("Preview一覧は履歴identityを表示しload失敗を通知する", async () => {
  const { service } = setup();
  const resource = {
    resourceKind: "git-commit-file" as const,
    sessionId: "aux",
    rootId: "additional-opaque",
    repositoryId: "opaque",
    relativePath: "a.md",
    commitId: "abc123",
  };
  await service.openFilePreviewWindow({
    ownerSessionId: "parent",
    displayPath: "C:/repo/a.md",
    windowTitle: "a.md",
    resource,
  });
  await service.openFilePreviewWindow({
    ownerSessionId: "parent",
    displayPath: "C:/repo/a.md",
    windowTitle: "a.md",
    historyDiff: {
      request: {
        sessionId: "aux",
        rootId: "additional-opaque",
        repositoryId: "opaque",
        relativePath: "a.md",
        comparison: {
          mode: "direct",
          base: { kind: "commit", objectId: "abc123" },
          target: { kind: "commit", objectId: "def456" },
          baseCommitId: "abc123",
          targetCommitId: "def456",
          mergeBaseCommitId: null,
        },
      },
      patch: "sensitive patch",
      previewResource: null,
      previewBeforeResource: null,
      previewAfterResource: null,
    },
  });
  const previews = service.listFilePreviewWindows()[0]!.previews;
  assert.deepEqual(
    previews.map((preview) => preview.path),
    ["C:/repo/a.md @ abc123", "C:/repo/a.md @ abc123 → def456"],
  );
  assert.deepEqual(Object.keys(previews[0]!).sort(), [
    "path",
    "title",
    "token",
  ]);
  assert.deepEqual(Object.keys(previews[1]!).sort(), [
    "path",
    "title",
    "token",
  ]);
  const failed = setup(async () => {
    throw new Error("load failed");
  });
  await assert.rejects(
    failed.service.openFilePreviewWindow({
      ownerSessionId: "parent",
      displayPath: "C:/repo/a.md",
      windowTitle: "a.md",
      resource,
    }),
    /load failed/,
  );
  assert.deepEqual(failed.service.listFilePreviewWindows(), []);
  assert.equal(failed.changes(), 2);
});

// @test-value v2
// kind = "contract"
// claim = "Preview一覧と操作IPCはHome実Windowのみに許可し、不正IDをdelegateへ渡さない"
// oracle = { type = "contract", ref = "Issue #858 Home-only Preview management IPC" }
// fault = "MonitorやSession等から他SessionのPreview操作を許可する、空IDをdelegateへ渡す、入力のtokenやownerを落とす"
// observable = "登録IPC handlerの返却一覧、delegate呼出し、許可外senderと不正IDの例外"
// observation_boundary = "public-boundary"
// scope = "Main Preview management IPC"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "他rendererへ全SessionのPreview管理権限を広げない"
// distinction = "preload型はMainでのsender認可やruntime入力検証を保証しない"
// @end-test-value
/** プレビューの一覧取得・フォーカス・終了は実 Home 窓からだけ許可し、不正な ID を後続処理に渡さないことを確かめる。 */
test("Preview管理IPCはHomeのみでIDを検証する", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const home = {};
  const stranger = {};
  const calls: unknown[] = [];
  const groups = [{ ownerSessionId: "parent", session: null, previews: [] }];
  const deps = {
    /** IPC の送信元を試験用の窓オブジェクトとして返す。 */
    resolveEventWindow: (event: { sender: unknown }) => event.sender,
    /** 認可対象にする唯一の Home 窓を返す。 */
    resolveHomeWindow: () => home,
    /** 正当な一覧取得で返る親グループを供給する。 */
    listSessionFilePreviewWindows: async () => groups,
    /** フォーカス要求が受理されたときのトークンを記録する。 */
    focusSessionFilePreviewWindow: (id: string) => calls.push(["focus", id]),
    /** 単体の終了要求が受理されたときのトークンを記録する。 */
    closeSessionFilePreviewWindow: (id: string) => calls.push(["close", id]),
    /** 一括終了の対象に渡された親 ID を記録する。 */
    closeSessionFilePreviewWindows: (id: string) =>
      calls.push(["close-all", id]),
  } as unknown as MainIpcWindowDeps;
  registerWindowHandlers(
    {
      /** 登録された IPC ハンドラーをチャンネル別に保存し、送信元を変えて直接呼べるようにする。 */
      handle(channel, handler) {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    deps,
  );
  const list = handlers.get(
    channels.WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL,
  )!;
  assert.deepEqual(await list({ sender: home }), groups);
  assert.throws(() => list({ sender: stranger }), /Home window/);
  for (const [channel, kind] of [
    [channels.WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL, "focus"],
    [channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL, "close"],
    [channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL, "close-all"],
  ]) {
    const handler = handlers.get(channel!)!;
    assert.throws(() => handler({ sender: stranger }, "id"), /Home window/);
    for (const value of [null, 1, "", " "])
      assert.throws(() => handler({ sender: home }, value), /Invalid preview/);
    handler({ sender: home }, "id");
    assert.deepEqual(calls.at(-1), [kind, "id"]);
  }
  assert.equal(calls.length, 3);
});
