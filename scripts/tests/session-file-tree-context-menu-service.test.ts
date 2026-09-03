import assert from "node:assert/strict";
import test from "node:test";

import { SessionFileTreeContextMenuService } from "../../src-electron/session-file-tree-context-menu-service.js";

const REQUEST = {
  sessionId: "session-1",
  rootId: "workspace",
  relativePath: "docs/report.txt",
  nodeKind: "file" as const,
  point: { x: 10, y: 20 },
  canInsert: true,
};

type MenuItem = {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
};

function createMenuHarness(options?: {
  platform?: NodeJS.Platform;
  resolveTarget?: (call: number) => string | Promise<string>;
  writeText?: (targetPath: string) => void;
  copyFileObject?: (request: { sessionId: string; rootId: string; relativePath: string }) => Promise<{
    status: "copied";
    message: string;
  }>;
}) {
  let template: MenuItem[] = [];
  let popupCallback: (() => void) | undefined;
  let resolveCalls = 0;
  const service = new SessionFileTreeContextMenuService({
    platform: options?.platform ?? "win32",
    createAuthorizationBoundary: () => ({
      async resolvePathActionTarget() {
        resolveCalls += 1;
        return options?.resolveTarget
          ? options.resolveTarget(resolveCalls)
          : "C:\\workspace\\docs\\report.txt";
      },
    }),
    writeText: options?.writeText ?? (() => {}),
    copyFileObject: options?.copyFileObject ?? (async () => ({ status: "copied", message: "File copied." })),
    buildMenu(nextTemplate) {
      template = nextTemplate as MenuItem[];
      return {
        popup(popupOptions) {
          popupCallback = popupOptions.callback;
        },
      };
    },
  });
  return {
    service,
    getTemplate: () => template,
    closePopup: () => popupCallback?.(),
    getResolveCalls: () => resolveCalls,
  };
}

// @test-value v1
// kind = "contract"
// claim = "native Files menuは2つのpath操作を全対象へ出し、Windows regular fileだけseparator後にfile-object copyを追加する"
// oracle = { type = "contract", ref = "accepted behavior invariant 2 and 3: native menu composition" }
// failure_mode = "path copyとfile-object copyが混同される、directoryやrootからpath操作が欠落する、またはinsert不可時にも操作可能になる"
// scope = "SessionFileTreeContextMenuService menu template"
// lifecycle = "permanent"
// distinction = "node kindとplatformによるmenu sibling構成およびinsert capabilityを観測する"
// @end-test-value
test("Files path context menuはpath操作とWindows file copyをnode kind別に合成する", async () => {
  const copiedFileRequests: unknown[] = [];
  const fileHarness = createMenuHarness({
    copyFileObject: async (request) => {
      copiedFileRequests.push(request);
      return { status: "copied", message: "File copied." };
    },
  });
  const fileResult = fileHarness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  assert.deepEqual(fileHarness.getTemplate().map(({ label, type, enabled }) => ({ label, type, enabled })), [
    { label: "パスをコピー", type: undefined, enabled: undefined },
    { label: "プロンプトにパスを挿入", type: undefined, enabled: true },
    { label: undefined, type: "separator", enabled: undefined },
    { label: "ファイルをコピー", type: undefined, enabled: undefined },
  ]);
  fileHarness.getTemplate()[3]?.click?.();
  fileHarness.closePopup();
  assert.deepEqual(await fileResult, { status: "copied-file" });
  assert.equal(fileHarness.getResolveCalls(), 2);
  assert.deepEqual(copiedFileRequests, [{
    sessionId: "session-1",
    rootId: "workspace",
    relativePath: "docs/report.txt",
  }]);

  const nonWindowsHarness = createMenuHarness({ platform: "linux" });
  const nonWindowsResult = nonWindowsHarness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  assert.equal(nonWindowsHarness.getTemplate().length, 2);
  nonWindowsHarness.closePopup();
  assert.deepEqual(await nonWindowsResult, { status: "dismissed" });

  for (const nodeKind of ["root", "directory"] as const) {
    const harness = createMenuHarness();
    const result = harness.service.showContextMenu({} as never, {
      ...REQUEST,
      relativePath: nodeKind === "root" ? "" : "docs",
      nodeKind,
      canInsert: false,
    });
    await Promise.resolve();
    assert.deepEqual(harness.getTemplate().map(({ label, enabled }) => ({ label, enabled })), [
      { label: "パスをコピー", enabled: undefined },
      { label: "プロンプトにパスを挿入", enabled: false },
    ]);
    harness.closePopup();
    assert.deepEqual(await result, { status: "dismissed" });
  }
});

// @test-value v1
// kind = "invariant"
// claim = "path copyはaction確定時に再認可したlexical absolute pathをclipboardへ1回書いた後だけ成功する"
// oracle = { type = "contract", ref = "accepted behavior invariant 1 and 2: path authority and clipboard failure timing" }
// failure_mode = "staleな認可結果をcopyする、clipboardへ複数回書く、またはwrite失敗をcopiedとして返す"
// scope = "SessionFileTreeContextMenuService path copy action"
// lifecycle = "permanent"
// distinction = "menu open時とaction時の二段階認可およびclipboard side effect完了後の結果を観測する"
// @end-test-value
test("Files path copyはaction時に再認可しclipboard write完了後だけ成功する", async () => {
  const writes: string[] = [];
  const harness = createMenuHarness({
    resolveTarget: (call) => call === 1 ? "C:\\old\\report.txt" : "C:\\current\\report.txt",
    writeText: (targetPath) => writes.push(targetPath),
  });
  const result = harness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  harness.getTemplate()[0]?.click?.();
  harness.getTemplate()[0]?.click?.();
  harness.closePopup();
  assert.deepEqual(await result, { status: "copied-path" });
  assert.equal(harness.getResolveCalls(), 2);
  assert.deepEqual(writes, ["C:\\current\\report.txt"]);

  const failedHarness = createMenuHarness({
    writeText: () => {
      throw new Error("clipboard unavailable");
    },
  });
  const failedResult = failedHarness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  failedHarness.getTemplate()[0]?.click?.();
  assert.deepEqual(await failedResult, { status: "failed", message: "Path action failed." });

  const staleHarness = createMenuHarness({
    resolveTarget: (call) => call === 1
      ? "C:\\old\\report.txt"
      : Promise.reject(new Error("root changed")),
    writeText: (targetPath) => writes.push(targetPath),
  });
  const staleResult = staleHarness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  staleHarness.getTemplate()[0]?.click?.();
  assert.deepEqual(await staleResult, { status: "failed", message: "Path action failed." });
  assert.deepEqual(writes, ["C:\\current\\report.txt"]);
});

// @test-value v1
// kind = "invariant"
// claim = "insert actionはMain側でdraftを変更せず、action時に再認可したpathとrequest ownerだけをRendererへ返す"
// oracle = { type = "contract", ref = "accepted behavior invariant 2: insertion result ownership" }
// failure_mode = "menu open時のstale pathを返す、clipboardへ書く、またはpopup close raceでinsert結果をdismiss扱いする"
// scope = "SessionFileTreeContextMenuService insert action"
// lifecycle = "permanent"
// distinction = "clipboard side effectを持つcopy actionではなく、owner付き認可結果だけを返すinsert actionを観測する"
// @end-test-value
test("Files path insertはaction時の認可pathをowner付きで返しpopup closeに負けない", async () => {
  const writes: string[] = [];
  const harness = createMenuHarness({
    resolveTarget: (call) => call === 1 ? "C:\\old\\report.txt" : "C:\\current\\report.txt",
    writeText: (targetPath) => writes.push(targetPath),
  });
  const result = harness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  harness.getTemplate()[1]?.click?.();
  harness.closePopup();
  assert.deepEqual(await result, {
    status: "insert-path",
    ownerSessionId: "session-1",
    absolutePath: "C:\\current\\report.txt",
  });
  assert.deepEqual(writes, []);
});

// @test-value v1
// kind = "security"
// claim = "Windows file-object copyはmenu open後もregular fileであるtargetだけをaction時のtree認可境界へ渡す"
// oracle = { type = "contract", ref = "accepted behavior invariant 1 and 3: symbolic link exclusion and file-only object copy" }
// failure_mode = "menu open後にfileがsymlinkまたは別kindへ変わってもfile object clipboard writeを開始する"
// scope = "SessionFileTreeContextMenuService file-object copy action"
// lifecycle = "permanent"
// distinction = "path copyではなくWindows file-object copy siblingもaction時のtree node kindを再認可する"
// @end-test-value
test("Files file-object copyはaction時のtree再認可失敗後にclipboard処理を開始しない", async () => {
  let copyCalls = 0;
  const harness = createMenuHarness({
    resolveTarget: (call) => call === 1
      ? "C:\\workspace\\docs\\report.txt"
      : Promise.reject(new Error("target became a symbolic link")),
    copyFileObject: async () => {
      copyCalls += 1;
      return { status: "copied", message: "File copied." };
    },
  });
  const result = harness.service.showContextMenu({} as never, REQUEST);
  await Promise.resolve();
  harness.getTemplate()[3]?.click?.();
  assert.deepEqual(await result, { status: "failed", message: "File could not be copied." });
  assert.equal(copyCalls, 0);
});
