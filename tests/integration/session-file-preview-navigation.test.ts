import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { IpcMain } from "electron";

import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import { SessionFileExplorerRuntime } from "../../src-electron/files/session-file-explorer-runtime.js";
import { openResolvedDirectoryInFileManager } from "../../src-electron/files/open-path.js";
import { registerSessionQueryHandlers } from "../../src-electron/ipc/session-query.js";
import type { MainIpcSessionQueryDeps } from "../../src-electron/ipc/contracts.js";
import type {
  SessionFilePreviewWindowOpenRequest,
  SessionFilePreviewWindowOpenResult,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
  WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL,
  WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL,
} from "../../src-shared/ipc/withmate-ipc-channels.js";

const execFileAsync = promisify(execFile);

/** URL と破棄状態を持ち、閉じた時に登録済みリスナーを呼ぶ簡易 BrowserWindow を作る。 */
function createWindow(url: string) {
  let destroyed = false;
  const closed: Array<() => void> = [];
  return {
    webContents: {
      /** 送信元 WebContents が破棄されたかをウィンドウと同じ状態で返す。 */ isDestroyed:
        () => destroyed,
      /** 認可時に照合する固定の送信元 URL を返す。 */ getURL: () => url,
    },
    /** 実際のページは開かず URL での読み込みを受け付ける。 */
    loadURL: async () => {},
    /** 実際の画面ファイルは描画せず読み込みを受け付ける。 */
    loadFile: async () => {},
    /** ウィンドウの現在の破棄状態を返す。 */
    isDestroyed: () => destroyed,
    /** テスト中はウィンドウを最小化していないものとして扱う。 */
    isMinimized: () => false,
    /** ウィンドウの復元を受け付けるが表示状態は変えない。 */
    restore() {},
    /** フォーカス操作を受け付けるがネイティブ画面は操作しない。 */
    focus() {},
    /** ウィンドウ表示の要求をテスト内にとどめる。 */
    show() {},
    /** 最前面表示の指定を受け付けるが実画面には反映しない。 */
    setAlwaysOnTop() {},
    /** 単発のイベント登録は受け付けるが配信しない。 */
    once() {},
    /** 閉じたことを通知するリスナーだけを保持する。 */
    on(event: string, listener: () => void) {
      if (event === "closed") closed.push(listener);
    },
    /** ウィンドウを破棄済みにし、閉じたことを全登録先に通知する。 */
    close() {
      destroyed = true;
      closed.forEach((listener) => listener());
    },
  };
}

/** 親 Session と Auxiliary のファイル操作を実ストレージ・Preview サービス・登録 IPC につなぎ、送信元と OS 操作結果を試験から切り替えられるようにする。 */
async function createNavigation() {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "withmate-preview-navigation-"),
  );
  const workspacePath = path.join(temp, "workspace");
  const additionalPath = path.join(temp, "additional");
  await mkdir(path.join(workspacePath, "docs"), { recursive: true });
  await mkdir(additionalPath);
  await writeFile(path.join(workspacePath, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(additionalPath, "extra.txt"), "extra\n");
  await writeFile(path.join(temp, "outside.md"), "# Outside\n");
  const ownerWindow = createWindow("file:///session.html?sessionId=parent");
  const state = {
    sender: ownerWindow,
    ownerSessionId: "parent",
    allowedAdditionalDirectories: [additionalPath],
    /** ディレクトリ操作直前に状態を切り替えるための差し替え点で、初期状態では何もしない。 */
    beforeDirectoryOpen: () => {},
    externalError: "",
    directoryError: "",
    windowError: "",
  };
  const created: ReturnType<typeof createWindow>[] = [];
  const externalOpened: string[] = [];
  const directoryOpened: string[] = [];
  const windows = new AuxWindowService({
    /** Preview ウィンドウの生成を記録し、実際の表示を行わないウィンドウを返す。 */
    createWindow() {
      const window = createWindow("file:///file-preview.html");
      created.push(window);
      return window;
    },
    /** Home 画面を開かずに読み込み依存を満たす。 */
    loadHomeEntry: async () => {},
    /** 独立した Diff エントリーを描画しない。 */
    loadDiffEntry: async () => {},
    /** Preview の読み込みが失敗する条件をテストから注入する。 */
    loadFilePreviewEntry: async () => {
      if (state.windowError) throw new Error(state.windowError);
    },
    /** Chat エントリーは描画せず読み込みを受け付ける。 */
    loadChatEntry: async () => {},
    /** キャラクター編集画面は描画せず読み込みを受け付ける。 */
    loadCharacterEditorEntry: async () => {},
    /** 生成したウィンドウの順序から検証用の識別トークンを作る。 */
    generateDiffToken: () => `token-${created.length + 1}`,
  });
  /** Auxiliary に限り、現在の親 Session と許可済み追加ディレクトリを返す。 */
  const getSessionContext = async (sessionId: string) =>
    sessionId === "aux"
      ? {
          workspacePath,
          parentSessionId: state.ownerSessionId,
          allowedAdditionalDirectories: state.allowedAdditionalDirectories,
        }
      : null;
  const runtime = new SessionFileExplorerRuntime({
    userDataPath: path.join(temp, "user-data"),
    getSessionContext,
    /** 解決済みローカルパスを OS で開かず、成功結果として返す。 */
    openResolvedPath: async (target) => ({
      status: "opened",
      targetType: "local-path",
      target,
    }),
    /** Preview の生成や既存表示の再利用を実ウィンドウ管理処理に渡す。 */
    openPreviewWindow: (payload) => windows.openFilePreviewWindow(payload),
    /** 外部 URL の要求を記録し、設定された OS 側の失敗または成功を返す。 */
    openExternalUrl: async (target) => {
      externalOpened.push(target);
      return state.externalError
        ? {
            status: "failed",
            targetType: "external-url",
            target,
            message: state.externalError,
          }
        : { status: "opened", targetType: "external-url", target };
    },
    /** 開く直前に送信元を変更できるようにしてから、実ファイルシステムと再認可ヘルパーを通す。 */
    openDirectory: async (targetPath, assertSender) => {
      state.beforeDirectoryOpen();
      return openResolvedDirectoryInFileManager(targetPath, {
        statTarget: stat,
        realpathTarget: realpath,
        assertSender,
        // macOS を含めて OS 側の処理は実行せず、本番の認可ヘルパーを通す。
        platform: "win32",
        /** 既定アプリは起動せず、ディレクトリと設定済みのエラーを記録・返却する。 */
        openWithDefaultApp: async (target) => {
          directoryOpened.push(target);
          return state.directoryError;
        },
      });
    },
  });
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const deps = {
    /** IPC イベントの解決先に、テストで選択した送信元ウィンドウを返す。 */
    resolveEventWindow: () => state.sender,
    /** 親 Session の ID だけを当初の所有ウィンドウに解決する。 */
    resolveSessionWindow: (id: string) =>
      id === "parent" ? ownerWindow : null,
    /** Auxiliary のファイル操作を現在所有する親 Session の ID を返す。 */
    getSessionFileExplorerOwnerSessionId: async (id: string) =>
      (await getSessionContext(id))?.parentSessionId ?? null,
    /** ファイル Preview ウィンドウの関連付けを実ウィンドウ管理サービスで照合する。 */
    isFilePreviewWindow: (
      window: ReturnType<typeof createWindow>,
      id: string,
    ) => windows.isFilePreviewWindow(window, id),
    /** 指定 Preview が読み取れるリソースを、要求された表現で取得する。 */
    getFilePreviewWindowResource: (
      window: ReturnType<typeof createWindow>,
      id: string,
      representation?: "source" | "absolute",
    ) => windows.getFilePreviewWindowResource(window, id, representation),
    /** 実 Explorer の処理でファイルを調べ、内容読み込みに使う記述子を得る。 */
    inspectSessionFile: (
      request: Parameters<
        ReturnType<typeof runtime.getExplorer>["inspectFile"]
      >[0],
    ) => runtime.getExplorer().inspectFile(request),
    /** 実 Explorer にチャンクの読み取りを委譲する。 */
    readSessionFileChunk: (
      request: Parameters<
        ReturnType<typeof runtime.getExplorer>["readFileChunk"]
      >[0],
    ) => runtime.getExplorer().readFileChunk(request),
    /** Preview の公開操作を実ランタイムにつなぎ、送信元の再検証も渡す。 */
    openSessionFilePreviewWindow: (
      request: SessionFilePreviewWindowOpenRequest,
      assertSender: () => Promise<void>,
    ) => runtime.getPreview().open(request, assertSender),
  } as unknown as MainIpcSessionQueryDeps;
  registerSessionQueryHandlers(
    {
      /** 検証から公開チャネルを直接呼べるよう IPC ハンドラーを保存する。 */ handle:
        (channel, handler) => {
          handlers.set(channel, handler);
        },
    },
    deps,
  );
  /** 現在の送信元の WebContents で Preview を開く IPC を呼ぶ。 */
  const open = async (
    request: SessionFilePreviewWindowOpenRequest,
  ): Promise<SessionFilePreviewWindowOpenResult> =>
    handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)!(
      { sender: state.sender.webContents } as never,
      request,
    );
  /** 現在の送信元から任意の登録済みチャネルを呼び、結果を Promise で返す。 */
  const invoke = (channel: string, request: unknown) =>
    Promise.resolve(
      handlers.get(channel)!(
        { sender: state.sender.webContents } as never,
        request,
      ),
    );
  return {
    temp,
    workspacePath,
    additionalPath,
    ownerWindow,
    state,
    created,
    windows,
    runtime,
    open,
    invoke,
    externalOpened,
    directoryOpened,
  };
}

// @test-value v2
// kind = "contract"
// claim = "明示PreviewはAdditional Directory解除後も同じ実fileを読めるが、detached Windowは他fileを読めずExplorer rootは失効する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Preview; docs/design/electron-window-runtime.md: Local Path Operation Boundary" }
// fault = "通常PreviewをSession root解除で失効させる、detached Previewに別fileを許す、またはExplorer rootを延命する"
// observable = "実fileのinspectとchunk本文、別fileのIPC拒否、解除rootのExplorer拒否"
// observation_boundary = "public-boundary"
// scope = "preview Window binding -> IPC -> real filesystem after directory removal"
// lifecycle = "permanent"
// impact = "開いたPreviewを継続利用でき、Agent作業範囲とWindow対象の境界を保つ"
// distinction = "単体stubではcanonical payloadからIPCと実fileへの接続、root解除後の継続を確認できない"
// @end-test-value
/** 追加ルートのリンク先を変更してから解除しても、開いていた Preview は確定済みの実ファイルだけを読め、別ファイルと失効した Explorer ルートは拒否されることを確かめる。 */
test("通常Previewのfile読込は作業root解除から独立しWindow対象に束縛される", async () => {
  const h = await createNavigation();
  try {
    const alias = path.join(h.temp, "root-alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(h.additionalPath, alias, linkType);
    h.state.allowedAdditionalDirectories = [alias];
    await h.open({
      kind: "link",
      sessionId: "aux",
      target: path.join(alias, "extra.txt"),
    });
    const original = h.windows.getFilePreviewWindowResource(
      h.created[0]!,
      "aux",
    )!;
    const absolute = h.windows.getFilePreviewWindowResource(
      h.created[0]!,
      "aux",
      "absolute",
    )!;
    h.state.sender = h.created[0]!;
    await rm(alias);
    await symlink(h.workspacePath, alias, linkType);
    await writeFile(path.join(h.workspacePath, "extra.txt"), "different file");
    await assert.rejects(
      h.invoke(WITHMATE_INSPECT_SESSION_FILE_CHANNEL, original),
      /current Preview resource/,
    );
    h.state.allowedAdditionalDirectories = [];
    const descriptor = (await h.invoke(
      WITHMATE_INSPECT_SESSION_FILE_CHANNEL,
      absolute,
    )) as { revision: string };
    const chunk = (await h.invoke(WITHMATE_READ_SESSION_FILE_CHUNK_CHANNEL, {
      ...absolute,
      offset: 0,
      length: 100,
      expectedRevision: descriptor.revision,
    })) as { data: ArrayBuffer };
    assert.equal(new TextDecoder().decode(chunk.data), "extra\n");
    await assert.rejects(
      h.invoke(WITHMATE_INSPECT_SESSION_FILE_CHANNEL, {
        sessionId: "aux",
        absolutePath: path.join(h.temp, "outside.md"),
      }),
      /current Preview resource/,
    );
    assert.ok("rootId" in original);
    await assert.rejects(
      h.runtime.getExplorer().inspectFile(original),
      /root is not available/,
    );
  } finally {
    await rm(h.temp, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Files preview IPCから認可済みrootのresourceを親owner付きで開き、同一resourceを再利用し、不正sender・absolute直指定・traversal・失効rootは開かない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md: Local Path Operation Boundary; docs/adr/034-file-preview-window-navigation.md" }
// fault = "IPC認可またはFiles root検証を迂回する、owner/view/titleを落とす、同一resourceを別Windowにする、Window失敗をopenedへ変換する"
// observable = "公開open結果、Window payloadと生成数、拒否Error"
// observation_boundary = "public-boundary"
// scope = "preview IPC -> SessionFileExplorerRuntime -> Explorer / Preview / AuxWindowService"
// lifecycle = "permanent"
// impact = "未認可ファイル公開とowner誤帰属を防ぎ、preview/diffの再利用と失敗通知を維持する"
// distinction = "既存IPC testはpreview操作をstub化し、ExplorerとWindow単独testは実際のpayload接続を観測しない;小さな一時filesystemのみで連結契約を確認する"
// risk_tags = ["authorization"]
// @end-test-value
/** Files の Preview IPC が正しい親 Session の下で既存ウィンドウを再利用し、不適切な送信元・ルートや読み込み失敗を成功にしないことを確かめる。 */
test("Files preview操作はIPCからroot認可・owner・Window再利用・失敗結果を維持する", async () => {
  const h = await createNavigation();
  try {
    const resource = {
      sessionId: "aux",
      rootId: "workspace",
      relativePath: "docs/guide.md",
    };
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      resource,
    });
    const view = { kind: "diff" as const, scope: "staged" as const };
    assert.deepEqual(await h.open({ kind: "resource", resource, view }), {
      status: "opened",
      targetType: "preview-window",
      disposition: "focused",
      resource,
    });
    assert.equal(h.created.length, 1);
    assert.deepEqual(h.windows.getFilePreviewPayload("token-1"), {
      resource,
      ownerSessionId: "parent",
      displayPath: path.join(h.workspacePath, "docs", "guide.md"),
      windowTitle: "guide.md",
      view,
    });
    h.state.sender = createWindow("file:///session.html?sessionId=other");
    await assert.rejects(
      () => h.open({ kind: "resource", resource }),
      /owning Session window/,
    );
    h.state.sender = h.created[0]!;
    await assert.rejects(
      () => h.open({ kind: "resource", resource }),
      /owning Session window/,
    );
    h.state.sender = createWindow("file:///home.html");
    await assert.rejects(
      () => h.open({ kind: "resource", resource }),
      /owning Session window/,
    );
    h.state.sender = h.ownerWindow;
    await assert.rejects(
      () =>
        h.open({
          kind: "resource",
          resource: {
            sessionId: "aux",
            absolutePath: path.join(h.temp, "outside.md"),
          },
        }),
      /root-scoped or commit-scoped/,
    );
    const traversal = await h.open({
      kind: "resource",
      resource: { ...resource, relativePath: "../outside.md" },
    });
    assert.deepEqual(traversal, {
      status: "failed",
      targetType: "local-file",
      target: "../outside.md",
      message: "relativePath contains an invalid segment.",
    });
    const roots = await h.runtime.getExplorer().listRoots("aux");
    const additionalRoot = roots.find((root) => root.kind === "additional")!;
    const extra = {
      sessionId: "aux",
      rootId: additionalRoot.id,
      relativePath: "extra.txt",
    };
    assert.equal(
      (await h.open({ kind: "resource", resource: extra })).status,
      "opened",
    );
    h.state.allowedAdditionalDirectories = [];
    assert.deepEqual(await h.open({ kind: "resource", resource: extra }), {
      status: "failed",
      targetType: "local-file",
      target: "extra.txt",
      message:
        "The specified file root is not available in the current session.",
    });
    const missing = await h.open({
      kind: "resource",
      resource: { ...resource, relativePath: "missing.md" },
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.targetType, "local-file");
    h.created[0]!.close();
    h.state.windowError = "entry failed";
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "failed",
      targetType: "local-file",
      target: "docs/guide.md",
      message: "entry failed",
    });
    assert.equal(h.windows.getFilePreviewPayload("token-3"), null);
    h.state.windowError = "";
    h.state.ownerSessionId = "";
    const absolutePath = await realpath(path.join(h.temp, "outside.md"));
    assert.deepEqual(
      await h.runtime.getPreview().open(
        {
          kind: "resource",
          resource: { sessionId: "aux", absolutePath },
        },
        async () => {},
      ),
      {
        status: "failed",
        targetType: "local-file",
        target: absolutePath,
        message: "The owning Session could not be resolved.",
      },
    );
    assert.equal(h.created.length, 3);
  } finally {
    await rm(h.temp, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Files link操作はroot内外fileをpreviewしdirectoryとexternalだけをOS portへ渡し、missing・base不一致・遅延中sender/owner変更・Preview終了とOS失敗を公開結果に反映する"
// oracle = { type = "contract", ref = "docs/adr/034-file-preview-window-navigation.md; docs/design/electron-window-runtime.md: Local Path Operation Boundary" }
// fault = "file linkをOSへ渡す、absolute previewで権限を追加する、directory再認可を省く、解決/OS失敗をopenedへ変換する"
// observable = "open結果、resource payload、許可root集合、OS portの呼出先と回数"
// observation_boundary = "public-boundary"
// scope = "preview link IPC -> Files resolver / preview owner -> directory authorization / OS port"
// lifecycle = "permanent"
// impact = "ファイル公開範囲と現在のPreview authorityを保ち、リンクのmissing/失敗を利用者へ返す"
// distinction = "既存のsender再認可testはFiles操作をstub化しており、実際のlink解決から再認可helperへ届くことは確認しない;OS起動せず一時filesystemで低コストに確認する"
// risk_tags = ["authorization"]
// @end-test-value
/** Files リンクの対象種別で Preview と OS 操作を分け、ファイルを開いても Explorer 権限は増えず、ディレクトリ実行前の送信元や所有者の変化は失敗になることを確かめる。 */
test("Files link操作は解決結果・権限追加なし・directory再認可を維持する", async () => {
  const h = await createNavigation();
  try {
    /** Auxiliary の Files リンクとして指定した対象を現在の送信元の IPC から解決する。 */
    const link = (target: string) =>
      h.open({ kind: "link", sessionId: "aux", target });
    const rootsBefore = await h.runtime.getExplorer().listRoots("aux");
    assert.deepEqual(await link("docs/guide.md"), {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      resource: {
        sessionId: "aux",
        rootId: "workspace",
        relativePath: "docs/guide.md",
      },
    });
    const outside = await realpath(path.join(h.temp, "outside.md"));
    assert.deepEqual(await link(outside), {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      resource: { sessionId: "aux", absolutePath: outside },
    });
    assert.deepEqual(
      await h.runtime.getExplorer().listRoots("aux"),
      rootsBefore,
    );
    assert.deepEqual(h.directoryOpened, []);
    assert.deepEqual(h.externalOpened, []);
    assert.deepEqual(await link("https://example.invalid/docs"), {
      status: "opened",
      targetType: "external-url",
      target: "https://example.invalid/docs",
    });
    h.state.externalError = "external refused";
    assert.deepEqual(await link("https://example.invalid/docs"), {
      status: "failed",
      targetType: "unknown",
      target: "https://example.invalid/docs",
      message: "external refused",
    });
    const directory = await realpath(path.join(h.workspacePath, "docs"));
    assert.deepEqual(await link("docs"), {
      status: "opened",
      targetType: "local-directory",
      target: directory,
    });
    h.state.directoryError = "directory refused";
    assert.deepEqual(await link("docs"), {
      status: "failed",
      targetType: "local-path",
      target: directory,
      message: "directory refused",
    });
    h.state.directoryError = "";
    h.state.beforeDirectoryOpen = () => {
      h.state.ownerSessionId = "other";
    };
    const rejected = await link("docs");
    assert.equal(rejected.status, "failed");
    assert.ok(
      "message" in rejected &&
        /owning Session|current Preview/.test(rejected.message),
    );
    assert.deepEqual(h.directoryOpened, [directory, directory]);
    h.state.ownerSessionId = "parent";
    h.state.beforeDirectoryOpen = () => {
      h.state.sender = createWindow("file:///home.html");
    };
    const senderChanged = await link("docs");
    assert.ok(
      "message" in senderChanged &&
        /sender changed/.test(senderChanged.message),
    );
    assert.equal(senderChanged.status, "failed");
    h.state.sender = h.created[0]!;
    const previewBase = h.windows.getFilePreviewWindowResource(
      h.created[0]!,
      "aux",
      "absolute",
    )!;
    h.state.beforeDirectoryOpen = () => h.created[0]!.close();
    const closed = await h.open({
      kind: "link",
      sessionId: "aux",
      target: ".",
      baseResource: previewBase,
    });
    assert.equal(closed.status, "failed");
    assert.ok("message" in closed && /current Preview/.test(closed.message));
    assert.deepEqual(h.directoryOpened, [directory, directory]);
    h.state.sender = h.ownerWindow;
    h.state.beforeDirectoryOpen = () => {};
    const missing = await link("missing.md");
    assert.deepEqual(missing, {
      status: "not-found",
      targetType: "local-path",
      target: path.join(h.workspacePath, "missing.md"),
      message: "The local path was not found.",
    });
    await assert.rejects(() =>
      h.open({
        kind: "link",
        sessionId: "aux",
        target: "docs",
        baseResource: { sessionId: "other", absolutePath: outside },
      }),
    );
  } finally {
    await rm(h.temp, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Files preview操作はGit commit fileと履歴差分の実取得、commit title、比較のbefore/after payloadとWindow再利用、無効Git resourceの失敗を維持する"
// oracle = { type = "contract", ref = "src-shared/file-explorer/file-explorer-contract.ts: SessionFilePreviewWindowOpenRequest/Result/Payload" }
// fault = "historyを現在のfileとして扱う、patch/commit title/before/afterを失う、無効repository/commitを開く、同じ履歴対象を重複生成する"
// observable = "公開open結果、履歴Window payloadのpatch/resource/title、Window生成数"
// observation_boundary = "public-boundary"
// scope = "preview IPC -> Files preview owner -> real Git history service -> AuxWindowService"
// lifecycle = "permanent"
// impact = "Historyから開く内容と比較対象の対応を保証し、取得失敗の誤表示を防ぐ"
// distinction = "GitとWindowの既存単独testは操作ownerによる結果/payloadの接続を確認しない;二commitの一時repositoryで実Gitを最小限実行する"
// @end-test-value
/** 実 Git の履歴からコミット時点のファイルと差分を開き、比較前後の参照・Window 再利用・無効な履歴の失敗を確かめる。 */
test("Files preview操作は実Gitのcommit previewと履歴diff payloadを維持する", async () => {
  const h = await createNavigation();
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    /** 一時ワークスペース内で実 Git を実行し、履歴を組み立てるための標準出力を返す。 */
    const git = async (...args: string[]) =>
      (
        await execFileAsync("git", ["-C", h.workspacePath, ...args], {
          windowsHide: true,
        })
      ).stdout.trim();
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Preview Test",
      "-c",
      "user.email=preview@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    const baseCommitId = await git("rev-parse", "HEAD");
    await writeFile(
      path.join(h.workspacePath, "docs", "guide.md"),
      "# Updated\n",
    );
    await git("add", ".");
    await git(
      "-c",
      "user.name=Preview Test",
      "-c",
      "user.email=preview@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "update",
    );
    const commitId = await git("rev-parse", "HEAD");
    const repositories = await h.runtime
      .getGitChanges()
      .listHistoryRepositories({ sessionId: "aux" });
    assert.equal(repositories.status, "ok");
    const repositoryId = repositories.repositories[0]!.repositoryId;
    await rm(path.join(h.workspacePath, "docs", "guide.md"));
    const resource = {
      resourceKind: "git-commit-file" as const,
      sessionId: "aux",
      rootId: "workspace",
      repositoryId,
      commitId,
      relativePath: "docs/guide.md",
    };
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      resource,
    });
    assert.deepEqual(h.windows.getFilePreviewPayload("token-1"), {
      resource,
      ownerSessionId: "parent",
      displayPath: path.join(h.workspacePath, "docs", "guide.md"),
      windowTitle: `guide.md · ${commitId.slice(0, 7)}`,
      view: { kind: "preview" },
    });
    const request = {
      sessionId: "aux",
      rootId: "workspace",
      repositoryId,
      commitId,
      relativePath: "docs/guide.md",
    };
    assert.deepEqual(await h.open({ kind: "history-diff", request }), {
      status: "opened",
      targetType: "preview-window",
      disposition: "created",
      historyDiff: request,
    });
    const payload = h.windows.getFilePreviewPayload("token-2");
    assert.ok(payload && "historyDiff" in payload);
    assert.equal(payload.ownerSessionId, "parent");
    assert.equal(payload.windowTitle, "guide.md");
    assert.match(payload.historyDiff.patch, /-# Guide\n\+# Updated/);
    assert.deepEqual(payload.historyDiff.previewResource, resource);
    assert.equal(payload.historyDiff.previewBeforeResource, null);
    assert.equal(payload.historyDiff.previewAfterResource, null);
    const repeated = await h.open({ kind: "history-diff", request });
    assert.ok("disposition" in repeated && repeated.disposition === "focused");
    assert.equal(h.created.length, 2);
    const comparison = {
      mode: "direct" as const,
      base: { kind: "commit" as const, objectId: baseCommitId },
      target: { kind: "commit" as const, objectId: commitId },
      baseCommitId,
      targetCommitId: commitId,
      mergeBaseCommitId: null,
    };
    const comparisonRequest = {
      sessionId: "aux",
      rootId: "workspace",
      repositoryId,
      comparison,
      relativePath: "docs/guide.md",
    };
    assert.equal(
      (await h.open({ kind: "history-diff", request: comparisonRequest }))
        .status,
      "opened",
    );
    const compared = h.windows.getFilePreviewPayload("token-3");
    assert.ok(compared && "historyDiff" in compared);
    assert.deepEqual(compared.historyDiff.previewBeforeResource, {
      ...resource,
      commitId: baseCommitId,
    });
    assert.deepEqual(compared.historyDiff.previewAfterResource, resource);
    assert.equal(compared.historyDiff.previewResource, null);
    assert.deepEqual(
      await h.open({
        kind: "link",
        sessionId: "aux",
        target: "docs",
        baseResource: resource,
      }),
      {
        status: "not-previewable",
        targetType: "local-file",
        target: "docs",
        message:
          "Relative links from a Git commit file preview are not available.",
      },
    );
    const failed = await h.open({
      kind: "resource",
      resource: { ...resource, repositoryId: `git:${"0".repeat(24)}` },
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.targetType, "local-file");
    const missing = await h.open({
      kind: "history-diff",
      request: { ...request, commitId: "0".repeat(40) },
    });
    assert.equal(missing.status, "failed");
    assert.equal(missing.targetType, "local-file");
    assert.equal(h.created.length, 3);
  } finally {
    clearInterval(keepAlive);
    await rm(h.temp, { recursive: true, force: true });
  }
});
