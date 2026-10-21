import assert from "node:assert/strict";
import test from "node:test";
import { AuxWindowService } from "../../src-electron/auxiliary/aux-window-service.js";
import { registerWindowHandlers } from "../../src-electron/ipc/window.js";
import type { MainIpcWindowDeps } from "../../src-electron/ipc/contracts.js";
import type { SessionFilePreviewWindowPayload } from "../../src-shared/file-explorer/file-explorer-contract.js";
import * as channels from "../../src-shared/ipc/withmate-ipc-channels.js";

function setup(loadFilePreviewEntry: () => Promise<void> = async () => {}) {
  let nextToken = 0;
  let changes = 0;
  let navigations = 0;
  const windows: ReturnType<typeof createWindow>[] = [];
  function createWindow() {
    let destroyed = false;
    let minimized = true;
    let focuses = 0;
    const closed: Array<() => void> = [];
    return {
      async loadURL() {}, async loadFile() {},
      isDestroyed: () => destroyed, isMinimized: () => minimized,
      restore() { minimized = false; }, focus() { focuses++; },
      show() {}, setAlwaysOnTop() {}, once() {},
      on(_event: "closed", listener: () => void) { closed.push(listener); },
      close() { destroyed = true; closed.forEach((listener) => listener()); },
      focuses: () => focuses,
    };
  }
  const service = new AuxWindowService({
    createWindow: () => { const window = createWindow(); windows.push(window); return window; },
    async loadHomeEntry() {}, async loadDiffEntry() {}, loadFilePreviewEntry,
    async loadChatEntry() {}, async loadCharacterEditorEntry() {},
    navigateFilePreviewWindow: () => { navigations++; },
    generateDiffToken: () => `preview-${++nextToken}`,
    onFilePreviewWindowsChanged: () => { changes++; },
  });
  return { service, windows, changes: () => changes, navigations: () => navigations };
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
test("Preview一覧は親で集約しfocusとcloseを独立管理する", async () => {
  const { service, windows, changes, navigations } = setup();
  const payload: SessionFilePreviewWindowPayload = {
    ownerSessionId: "parent", displayPath: "C:/workspace/a.md", windowTitle: "a.md",
    resource: { sessionId: "parent", rootId: "workspace", relativePath: "a.md" },
  };
  await service.openFilePreviewWindow(payload);
  await service.openFilePreviewWindow({ ...payload, displayPath: "C:/sessions/parent/a.md", resource: { sessionId: "aux", rootId: "session-folder", relativePath: "a.md" } });
  await service.openFilePreviewWindow({ ...payload, ownerSessionId: "other", resource: { sessionId: "other", absolutePath: "C:/a.md" } });
  assert.deepEqual(service.listFilePreviewWindows().map((group) => [group.ownerSessionId, group.previews.length]), [["parent", 2], ["other", 1]]);
  assert.deepEqual(service.listFilePreviewWindows()[0]?.previews.map((item) => item.path), ["C:/workspace/a.md", "C:/sessions/parent/a.md"]);
  const token = service.listFilePreviewWindows()[0]!.previews[0]!.token;
  service.focusFilePreviewWindow(token);
  assert.equal(windows[0]!.focuses(), 1);
  assert.equal(windows[0]!.isMinimized(), false);
  assert.equal(navigations(), 0);
  assert.equal(changes(), 3);
  await service.openFilePreviewWindow({ ...payload, view: { kind: "diff", scope: "working-tree" } });
  assert.equal(navigations(), 1);
  assert.equal(changes(), 4);
  service.closeFilePreviewWindowsForOwner("parent");
  assert.deepEqual(service.listFilePreviewWindows().map((group) => group.ownerSessionId), ["other"]);
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
test("Preview一覧は履歴identityを表示しload失敗を通知する", async () => {
  const { service } = setup();
  const resource = { resourceKind: "git-commit-file" as const, sessionId: "aux", rootId: "additional-opaque", repositoryId: "opaque", relativePath: "a.md", commitId: "abc123" };
  await service.openFilePreviewWindow({ ownerSessionId: "parent", displayPath: "C:/repo/a.md", windowTitle: "a.md", resource });
  await service.openFilePreviewWindow({ ownerSessionId: "parent", displayPath: "C:/repo/a.md", windowTitle: "a.md", historyDiff: {
    request: { sessionId: "aux", rootId: "additional-opaque", repositoryId: "opaque", relativePath: "a.md", comparison: { mode: "direct", base: { kind: "commit", objectId: "abc123" }, target: { kind: "commit", objectId: "def456" }, baseCommitId: "abc123", targetCommitId: "def456", mergeBaseCommitId: null } },
    patch: "sensitive patch", previewResource: null, previewBeforeResource: null, previewAfterResource: null,
  } });
  const previews = service.listFilePreviewWindows()[0]!.previews;
  assert.deepEqual(previews.map((preview) => preview.path), ["C:/repo/a.md @ abc123", "C:/repo/a.md @ abc123 → def456"]);
  assert.deepEqual(Object.keys(previews[0]!).sort(), ["path", "title", "token"]);
  assert.deepEqual(Object.keys(previews[1]!).sort(), ["path", "title", "token"]);
  const failed = setup(async () => { throw new Error("load failed"); });
  await assert.rejects(failed.service.openFilePreviewWindow({ ownerSessionId: "parent", displayPath: "C:/repo/a.md", windowTitle: "a.md", resource }), /load failed/);
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
test("Preview管理IPCはHomeのみでIDを検証する", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const home = {};
  const stranger = {};
  const calls: unknown[] = [];
  const groups = [{ ownerSessionId: "parent", session: null, previews: [] }];
  const deps = {
    resolveEventWindow: (event: { sender: unknown }) => event.sender,
    resolveHomeWindow: () => home,
    listSessionFilePreviewWindows: async () => groups,
    focusSessionFilePreviewWindow: (id: string) => calls.push(["focus", id]),
    closeSessionFilePreviewWindow: (id: string) => calls.push(["close", id]),
    closeSessionFilePreviewWindows: (id: string) => calls.push(["close-all", id]),
  } as unknown as MainIpcWindowDeps;
  registerWindowHandlers({ handle(channel, handler) { handlers.set(channel, handler as (...args: unknown[]) => unknown); } }, deps);
  const list = handlers.get(channels.WITHMATE_LIST_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL)!;
  assert.deepEqual(await list({ sender: home }), groups);
  assert.throws(() => list({ sender: stranger }), /Home window/);
  for (const [channel, kind] of [
    [channels.WITHMATE_FOCUS_SESSION_FILE_PREVIEW_WINDOW_CHANNEL, "focus"],
    [channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOW_CHANNEL, "close"],
    [channels.WITHMATE_CLOSE_SESSION_FILE_PREVIEW_WINDOWS_CHANNEL, "close-all"],
  ]) {
    const handler = handlers.get(channel!)!;
    assert.throws(() => handler({ sender: stranger }, "id"), /Home window/);
    for (const value of [null, 1, "", " "]) assert.throws(() => handler({ sender: home }, value), /Invalid preview/);
    handler({ sender: home }, "id");
    assert.deepEqual(calls.at(-1), [kind, "id"]);
  }
  assert.equal(calls.length, 3);
});
