import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL } from "../../src-shared/ipc/withmate-ipc-channels.js";

const execFileAsync = promisify(execFile);

function createWindow(url: string) {
  let destroyed = false;
  const closed: Array<() => void> = [];
  return {
    webContents: { isDestroyed: () => destroyed, getURL: () => url },
    loadURL: async () => {},
    loadFile: async () => {},
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore() {},
    focus() {},
    show() {},
    setAlwaysOnTop() {},
    once() {},
    on(event: string, listener: () => void) { if (event === "closed") closed.push(listener); },
    close() { destroyed = true; closed.forEach((listener) => listener()); },
  };
}

async function createNavigation() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "withmate-preview-navigation-"));
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
    beforeDirectoryOpen: () => {},
    externalError: "",
    directoryError: "",
    windowError: "",
  };
  const created: ReturnType<typeof createWindow>[] = [];
  const externalOpened: string[] = [];
  const directoryOpened: string[] = [];
  const windows = new AuxWindowService({
    createWindow() {
      const window = createWindow("file:///file-preview.html");
      created.push(window);
      return window;
    },
    loadHomeEntry: async () => {},
    loadDiffEntry: async () => {},
    loadFilePreviewEntry: async () => { if (state.windowError) throw new Error(state.windowError); },
    loadChatEntry: async () => {},
    loadCharacterEditorEntry: async () => {},
    generateDiffToken: () => `token-${created.length + 1}`,
  });
  const getSessionContext = async (sessionId: string) => sessionId === "aux" ? {
    workspacePath,
    parentSessionId: state.ownerSessionId,
    allowedAdditionalDirectories: state.allowedAdditionalDirectories,
  } : null;
  const runtime = new SessionFileExplorerRuntime({
    userDataPath: path.join(temp, "user-data"),
    getSessionContext,
    openResolvedPath: async (target) => ({ status: "opened", targetType: "local-path", target }),
    openPreviewWindow: (payload) => windows.openFilePreviewWindow(payload),
    openExternalUrl: async (target) => {
      externalOpened.push(target);
      return state.externalError
        ? { status: "failed", targetType: "external-url", target, message: state.externalError }
        : { status: "opened", targetType: "external-url", target };
    },
    openDirectory: async (targetPath, assertSender) => {
      state.beforeDirectoryOpen();
      return openResolvedDirectoryInFileManager(targetPath, {
        statTarget: stat,
        realpathTarget: realpath,
        assertSender,
        // Keep the OS boundary inert, including on macOS; exercise the production authorization helper.
        platform: "win32",
        openWithDefaultApp: async (target) => { directoryOpened.push(target); return state.directoryError; },
      });
    },
  });
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  const deps = {
    resolveEventWindow: () => state.sender,
    resolveSessionWindow: (id: string) => id === "parent" ? ownerWindow : null,
    getSessionFileExplorerOwnerSessionId: async (id: string) => (await getSessionContext(id))?.parentSessionId ?? null,
    isFilePreviewWindow: (window: ReturnType<typeof createWindow>, id: string) => windows.isFilePreviewWindow(window, id),
    getFilePreviewWindowResource: (window: ReturnType<typeof createWindow>, id: string) => windows.getFilePreviewWindowResource(window, id),
    openSessionFilePreviewWindow: (request: SessionFilePreviewWindowOpenRequest, assertSender: () => Promise<void>) =>
      runtime.getPreview().open(request, assertSender),
  } as unknown as MainIpcSessionQueryDeps;
  registerSessionQueryHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, deps);
  const open = async (request: SessionFilePreviewWindowOpenRequest): Promise<SessionFilePreviewWindowOpenResult> =>
    handlers.get(WITHMATE_OPEN_SESSION_FILE_PREVIEW_WINDOW_CHANNEL)!({ sender: state.sender.webContents } as never, request);
  return { temp, workspacePath, additionalPath, ownerWindow, state, created, windows, runtime, open, externalOpened, directoryOpened };
}

// @test-value v2
// kind = "security"
// claim = "Files preview IPCから認可済みrootのresourceを親owner付きで開き、同一resourceを再利用し、不正sender・absolute直指定・traversal・失効rootは開かない"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md: Local Path Operation Boundary; docs/adr/020-file-preview-window-navigation.md" }
// fault = "IPC認可またはFiles root検証を迂回する、owner/view/titleを落とす、同一resourceを別Windowにする、Window失敗をopenedへ変換する"
// observable = "公開open結果、Window payloadと生成数、拒否Error"
// observation_boundary = "public-boundary"
// scope = "preview IPC -> SessionFileExplorerRuntime -> Explorer / Preview / AuxWindowService"
// lifecycle = "permanent"
// impact = "未認可ファイル公開とowner誤帰属を防ぎ、preview/diffの再利用と失敗通知を維持する"
// distinction = "既存IPC testはpreview操作をstub化し、ExplorerとWindow単独testは実際のpayload接続を観測しない;小さな一時filesystemのみで連結契約を確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("Files preview操作はIPCからroot認可・owner・Window再利用・失敗結果を維持する", async () => {
  const h = await createNavigation();
  try {
    const resource = { sessionId: "aux", rootId: "workspace", relativePath: "docs/guide.md" };
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "opened", targetType: "preview-window", disposition: "created", resource,
    });
    const view = { kind: "diff" as const, scope: "staged" as const };
    assert.deepEqual(await h.open({ kind: "resource", resource, view }), {
      status: "opened", targetType: "preview-window", disposition: "focused", resource,
    });
    assert.equal(h.created.length, 1);
    assert.deepEqual(h.windows.getFilePreviewPayload("token-1"), {
      resource, ownerSessionId: "parent", windowTitle: "guide.md", view,
    });
    h.state.sender = createWindow("file:///session.html?sessionId=other");
    await assert.rejects(() => h.open({ kind: "resource", resource }), /owning Session window/);
    h.state.sender = h.created[0]!;
    await assert.rejects(() => h.open({ kind: "resource", resource }), /owning Session window/);
    h.state.sender = createWindow("file:///home.html");
    await assert.rejects(() => h.open({ kind: "resource", resource }), /owning Session window/);
    h.state.sender = h.ownerWindow;
    await assert.rejects(() => h.open({
      kind: "resource", resource: { sessionId: "aux", absolutePath: path.join(h.temp, "outside.md") },
    }), /root-scoped or commit-scoped/);
    const traversal = await h.open({ kind: "resource", resource: { ...resource, relativePath: "../outside.md" } });
    assert.deepEqual(traversal, {
      status: "failed", targetType: "local-file", target: "../outside.md", message: "relativePath contains an invalid segment.",
    });
    const roots = await h.runtime.getExplorer().listRoots("aux");
    const additionalRoot = roots.find((root) => root.kind === "additional")!;
    const extra = { sessionId: "aux", rootId: additionalRoot.id, relativePath: "extra.txt" };
    assert.equal((await h.open({ kind: "resource", resource: extra })).status, "opened");
    h.state.allowedAdditionalDirectories = [];
    assert.deepEqual(await h.open({ kind: "resource", resource: extra }), {
      status: "failed", targetType: "local-file", target: "extra.txt",
      message: "The specified file root is not available in the current session.",
    });
    const missing = await h.open({ kind: "resource", resource: { ...resource, relativePath: "missing.md" } });
    assert.equal(missing.status, "failed");
    assert.equal(missing.targetType, "local-file");
    h.created[0]!.close();
    h.state.windowError = "entry failed";
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "failed", targetType: "local-file", target: "docs/guide.md", message: "entry failed",
    });
    assert.equal(h.windows.getFilePreviewPayload("token-3"), null);
    h.state.windowError = "";
    h.state.ownerSessionId = "";
    const absolutePath = await realpath(path.join(h.temp, "outside.md"));
    assert.deepEqual(await h.runtime.getPreview().open({
      kind: "resource", resource: { sessionId: "aux", absolutePath },
    }, async () => {}), {
      status: "failed", targetType: "local-file", target: absolutePath, message: "The owning Session could not be resolved.",
    });
    assert.equal(h.created.length, 3);
  } finally {
    await rm(h.temp, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Files link操作はroot内外fileをpreviewしdirectoryとexternalだけをOS portへ渡し、missing・base不一致・遅延中sender/owner変更・Preview終了とOS失敗を公開結果に反映する"
// oracle = { type = "contract", ref = "docs/adr/020-file-preview-window-navigation.md; docs/design/electron-window-runtime.md: Local Path Operation Boundary" }
// fault = "file linkをOSへ渡す、absolute previewで権限を追加する、directory再認可を省く、解決/OS失敗をopenedへ変換する"
// observable = "open結果、resource payload、許可root集合、OS portの呼出先と回数"
// observation_boundary = "public-boundary"
// scope = "preview link IPC -> Files resolver / preview owner -> directory authorization / OS port"
// lifecycle = "permanent"
// impact = "ファイル公開範囲と現在のPreview authorityを保ち、リンクのmissing/失敗を利用者へ返す"
// distinction = "既存のsender再認可testはFiles操作をstub化しており、実際のlink解決から再認可helperへ届くことは確認しない;OS起動せず一時filesystemで低コストに確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("Files link操作は解決結果・権限追加なし・directory再認可を維持する", async () => {
  const h = await createNavigation();
  try {
    const link = (target: string) => h.open({ kind: "link", sessionId: "aux", target });
    const rootsBefore = await h.runtime.getExplorer().listRoots("aux");
    assert.deepEqual(await link("docs/guide.md"), {
      status: "opened", targetType: "preview-window", disposition: "created",
      resource: { sessionId: "aux", rootId: "workspace", relativePath: "docs/guide.md" },
    });
    const outside = await realpath(path.join(h.temp, "outside.md"));
    assert.deepEqual(await link(outside), {
      status: "opened", targetType: "preview-window", disposition: "created",
      resource: { sessionId: "aux", absolutePath: outside },
    });
    assert.deepEqual(await h.runtime.getExplorer().listRoots("aux"), rootsBefore);
    assert.deepEqual(h.directoryOpened, []);
    assert.deepEqual(h.externalOpened, []);
    assert.deepEqual(await link("https://example.invalid/docs"), {
      status: "opened", targetType: "external-url", target: "https://example.invalid/docs",
    });
    h.state.externalError = "external refused";
    assert.deepEqual(await link("https://example.invalid/docs"), {
      status: "failed", targetType: "unknown", target: "https://example.invalid/docs", message: "external refused",
    });
    const directory = await realpath(path.join(h.workspacePath, "docs"));
    assert.deepEqual(await link("docs"), { status: "opened", targetType: "local-directory", target: directory });
    h.state.directoryError = "directory refused";
    assert.deepEqual(await link("docs"), {
      status: "failed", targetType: "local-path", target: directory, message: "directory refused",
    });
    h.state.directoryError = "";
    h.state.beforeDirectoryOpen = () => { h.state.ownerSessionId = "other"; };
    const rejected = await link("docs");
    assert.equal(rejected.status, "failed");
    assert.ok("message" in rejected && /owning Session|current Preview/.test(rejected.message));
    assert.deepEqual(h.directoryOpened, [directory, directory]);
    h.state.ownerSessionId = "parent";
    h.state.beforeDirectoryOpen = () => { h.state.sender = createWindow("file:///home.html"); };
    const senderChanged = await link("docs");
    assert.ok("message" in senderChanged && /sender changed/.test(senderChanged.message));
    assert.equal(senderChanged.status, "failed");
    h.state.sender = h.created[0]!;
    h.state.beforeDirectoryOpen = () => h.created[0]!.close();
    const closed = await h.open({
      kind: "link", sessionId: "aux", target: ".",
      baseResource: { sessionId: "aux", rootId: "workspace", relativePath: "docs/guide.md" },
    });
    assert.equal(closed.status, "failed");
    assert.ok("message" in closed && /current Preview/.test(closed.message));
    assert.deepEqual(h.directoryOpened, [directory, directory]);
    h.state.sender = h.ownerWindow;
    h.state.beforeDirectoryOpen = () => {};
    const missing = await link("missing.md");
    assert.deepEqual(missing, {
      status: "not-found", targetType: "local-path", target: path.join(h.workspacePath, "missing.md"),
      message: "The local path was not found.",
    });
    await assert.rejects(() => h.open({
      kind: "link", sessionId: "aux", target: "docs", baseResource: { sessionId: "other", absolutePath: outside },
    }));
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
test("Files preview操作は実Gitのcommit previewと履歴diff payloadを維持する", async () => {
  const h = await createNavigation();
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", h.workspacePath, ...args], { windowsHide: true })).stdout.trim();
    await git("init", "--quiet");
    await git("add", ".");
    await git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "base");
    const baseCommitId = await git("rev-parse", "HEAD");
    await writeFile(path.join(h.workspacePath, "docs", "guide.md"), "# Updated\n");
    await git("add", ".");
    await git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "update");
    const commitId = await git("rev-parse", "HEAD");
    const repositories = await h.runtime.getGitChanges().listHistoryRepositories({ sessionId: "aux" });
    assert.equal(repositories.status, "ok");
    const repositoryId = repositories.repositories[0]!.repositoryId;
    await rm(path.join(h.workspacePath, "docs", "guide.md"));
    const resource = { resourceKind: "git-commit-file" as const, sessionId: "aux", rootId: "workspace", repositoryId, commitId, relativePath: "docs/guide.md" };
    assert.deepEqual(await h.open({ kind: "resource", resource }), {
      status: "opened", targetType: "preview-window", disposition: "created", resource,
    });
    assert.deepEqual(h.windows.getFilePreviewPayload("token-1"), {
      resource, ownerSessionId: "parent", windowTitle: `guide.md · ${commitId.slice(0, 7)}`, view: { kind: "preview" },
    });
    const request = { sessionId: "aux", rootId: "workspace", repositoryId, commitId, relativePath: "docs/guide.md" };
    assert.deepEqual(await h.open({ kind: "history-diff", request }), {
      status: "opened", targetType: "preview-window", disposition: "created", historyDiff: request,
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
      mode: "direct" as const, base: { kind: "commit" as const, objectId: baseCommitId },
      target: { kind: "commit" as const, objectId: commitId }, baseCommitId, targetCommitId: commitId, mergeBaseCommitId: null,
    };
    const comparisonRequest = { sessionId: "aux", rootId: "workspace", repositoryId, comparison, relativePath: "docs/guide.md" };
    assert.equal((await h.open({ kind: "history-diff", request: comparisonRequest })).status, "opened");
    const compared = h.windows.getFilePreviewPayload("token-3");
    assert.ok(compared && "historyDiff" in compared);
    assert.deepEqual(compared.historyDiff.previewBeforeResource, { ...resource, commitId: baseCommitId });
    assert.deepEqual(compared.historyDiff.previewAfterResource, resource);
    assert.equal(compared.historyDiff.previewResource, null);
    assert.deepEqual(await h.open({ kind: "link", sessionId: "aux", target: "docs", baseResource: resource }), {
      status: "not-previewable", targetType: "local-file", target: "docs",
      message: "Relative links from a Git commit file preview are not available.",
    });
    const failed = await h.open({ kind: "resource", resource: { ...resource, repositoryId: `git:${"0".repeat(24)}` } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.targetType, "local-file");
    const missing = await h.open({ kind: "history-diff", request: { ...request, commitId: "0".repeat(40) } });
    assert.equal(missing.status, "failed");
    assert.equal(missing.targetType, "local-file");
    assert.equal(h.created.length, 3);
  } finally {
    clearInterval(keepAlive);
    await rm(h.temp, { recursive: true, force: true });
  }
});
