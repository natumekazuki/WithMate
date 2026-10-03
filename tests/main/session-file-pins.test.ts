import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionFileExplorerService } from "../../src-electron/files/session-file-explorer-service.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";

function newSession(id: string, workspacePath: string) {
  return buildNewSession({ id, taskTitle: "Files Pin", workspaceLabel: "workspace", workspacePath,
    branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE });
}

// @test-value v2
// kind = "contract"
// claim = "親SessionのPinはMainとAuxで共有し再起動保持され、別親には共有せずroot除去・rename後も解除できる"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Files Pin" }
// fault = "Pinをactive Sessionだけに保存するか、利用不可参照を削除するか、再起動で保存内容を失う"
// observable = "serviceで取得したPin、利用不可理由、解除後の一覧"
// observation_boundary = "public-boundary"
// scope = "SessionFileExplorerServiceとSessionStorageV6のPin保存・取得・解除"
// lifecycle = "permanent"
// impact = "作業目印の喪失とSession間の混入を防ぐ"
// distinction = "既存Session Pinとは異なるroot参照の永続化と認可変更を実SQLite・filesystemで確認する"
// @end-test-value
test("Files Pin は親で共有し保存・利用不可・復帰・解除を維持する", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-file-pins-"));
  const workspace = path.join(temporary, "workspace");
  const additional = path.join(workspace, "Docs");
  const dbPath = path.join(temporary, "withmate-v6.db");
  let storage: SessionStorageV6 | null = null;
  try {
    await mkdir(additional, { recursive: true });
    await writeFile(path.join(additional, "Guide.txt"), "guide");
    storage = new SessionStorageV6(dbPath);
    const parent = storage.insertSession(newSession("main", workspace));
    const other = storage.insertSession(newSession("other", workspace));
    let allowed = [additional];
    const service = new SessionFileExplorerService({ userDataPath: temporary,
      getPinStorage: () => storage!,
      async getSessionContext(id) {
        const owner = id === "aux" ? parent : id === "other" ? other : parent;
        return { workspacePath: workspace, parentSessionId: owner.id,
          parentIncarnationId: getSessionIncarnationId(owner), allowedAdditionalDirectories: allowed };
      },
      openFile: async () => { throw new Error("Pin must not read file contents"); },
      listDirectory: async () => { throw new Error("Pin must not scan directories"); },
    });
    const roots = await service.listRoots("main");
    const additionalRoot = roots.find((root) => root.kind === "additional")!;
    const first = await service.pinSessionFile({ sessionId: "main", rootId: "workspace", relativePath: "Docs/Guide.txt" });
    await service.pinSessionFile({ sessionId: "aux", rootId: additionalRoot.id, relativePath: "Guide.txt" });
    await service.pinSessionFile({ sessionId: "main", rootId: "workspace", relativePath: "Docs" });
    assert.equal(first.relativePath, "Docs/Guide.txt");
    assert.equal((await service.listSessionFilePins("aux")).length, 3);
    assert.deepEqual(await service.listSessionFilePins("other"), []);
    storage.close();
    storage = new SessionStorageV6(dbPath);
    assert.equal((await service.listSessionFilePins("main")).length, 3);
    allowed = [];
    const withoutRoot = await service.listSessionFilePins("aux");
    assert.ok(withoutRoot.find((pin) => pin.rootKind === "additional")?.unavailableReason);
    await service.unpinSessionFile({ sessionId: "aux", ...withoutRoot.find((pin) => pin.rootKind === "additional")! });
    await rename(path.join(additional, "Guide.txt"), path.join(additional, "Renamed.txt"));
    const renamed = (await service.listSessionFilePins("main")).find((pin) => pin.kind === "file")!;
    assert.ok(renamed.unavailableReason);
    assert.equal(renamed.relativePath, "Docs/Guide.txt");
    await rename(path.join(additional, "Renamed.txt"), path.join(additional, "Guide.txt"));
    assert.equal((await service.listSessionFilePins("aux")).find((pin) => pin.kind === "file")?.unavailableReason, null);
    storage.deleteSession(parent.id);
    const recreated = storage.insertSession(newSession(parent.id, workspace));
    assert.deepEqual(storage.listSessionFilePins({ sessionId: recreated.id, incarnationId: getSessionIncarnationId(recreated) }), []);
    const oldOwner = { sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) };
    assert.throws(() => storage!.pinSessionFile(oldOwner, first), /owner session/);
    assert.throws(() => storage!.unpinSessionFile(oldOwner, first), /owner session/);
  } finally {
    storage?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "security"
// claim = "Pinはtraversal・symlink・認可外rootを拒否し、保存遅延中のowner再作成とDB失敗を成功や0件にしない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Files Pin" }
// fault = "未認可pathまたは古いSession incarnationの参照を保存するかDB例外を空一覧に変換する"
// observable = "Pinと一覧APIの拒否Errorおよび再作成ownerの空一覧"
// observation_boundary = "public-boundary"
// scope = "SessionFileExplorerServiceのPin認可と保存境界"
// lifecycle = "permanent"
// risk_tags = ["authorization"]
// impact = "Pin経由のアクセス権拡大と削除したSessionの目印混入を防ぐ"
// distinction = "既存preview検証にないPin書込遅延・storage errorを注入し保存結果を確認する"
// @end-test-value
test("Files Pin は認可・owner世代・DB失敗の境界を維持する", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-file-pin-security-"));
  const workspace = path.join(temporary, "workspace");
  const dbPath = path.join(temporary, "withmate-v6.db");
  let storage: SessionStorageV6 | null = null;
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "file.txt"), "file");
    await symlink(path.join(workspace, "file.txt"), path.join(workspace, "link.txt"), "file");
    storage = new SessionStorageV6(dbPath);
    let parent = storage.insertSession(newSession("main", workspace));
    let replaceOwner = false;
    const service = new SessionFileExplorerService({ userDataPath: temporary, getPinStorage: () => storage!,
      async getSessionContext() {
        return { workspacePath: workspace, parentSessionId: parent.id, parentIncarnationId: getSessionIncarnationId(parent), allowedAdditionalDirectories: [] };
      },
      async lstatPath(target) {
        const stats = await lstat(target);
        if (replaceOwner) {
          replaceOwner = false;
          storage!.deleteSession(parent.id);
          parent = storage!.insertSession(newSession(parent.id, workspace));
        }
        return stats;
      },
    });
    for (const request of [
      { rootId: "workspace", relativePath: "../file.txt" },
      { rootId: "workspace", relativePath: "link.txt" },
      { rootId: "unavailable", relativePath: "file.txt" },
      { rootId: "workspace", relativePath: "" },
    ]) await assert.rejects(service.pinSessionFile({ sessionId: "main", ...request }));
    replaceOwner = true;
    await assert.rejects(service.pinSessionFile({ sessionId: "main", rootId: "workspace", relativePath: "file.txt" }), /owner session/);
    assert.deepEqual(await service.listSessionFilePins("main"), []);
    storage.close();
    await assert.rejects(service.listSessionFilePins("main"));
    storage = null;
  } finally {
    storage?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Pinの追加・列挙・解除は実storage Workerの許可commandとして永続化へ接続される"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Files Pin" }
// fault = "Workerのallowlistまたはmutation登録を欠落しPin APIがMain単体では動いてもruntimeで拒否される"
// observable = "Worker store経由のPin一覧と解除後の空一覧"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundleのSession file pin command"
// lifecycle = "permanent"
// impact = "実アプリのPin主要動作がWorker境界で不成立になることを防ぐ"
// distinction = "同期storeのtestや型検査では保証しない実Workerのcommand許可とtransportを確認する"
// @end-test-value
test("Files Pin は実storage Workerのcommandで保存・取得・解除できる", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-file-pin-worker-"));
  let bundle: ReturnType<typeof createV6StorageWorkerBundle> | null = null;
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(temporary);
    bundle = createV6StorageWorkerBundle({ dbPath, userDataPath: temporary,
      bundledModelCatalogPath: path.join(process.cwd(), "public/model-catalog.json"),
      workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
      handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url),
      workerOptions: { execArgv: ["--import", "tsx"] },
    });
    await bundle.initialize();
    const parent = await bundle.stores.session.insertSession(newSession("main", temporary));
    const owner = { sessionId: parent.id, incarnationId: getSessionIncarnationId(parent) };
    const pin = { rootKind: "workspace" as const, rootPath: temporary, relativePath: "file.txt", kind: "file" as const, rootLabel: "Workspace" };
    await bundle.stores.session.pinSessionFile(owner, pin);
    assert.deepEqual(await bundle.stores.session.listSessionFilePins(owner), [pin]);
    await bundle.stores.session.unpinSessionFile(owner, pin);
    assert.deepEqual(await bundle.stores.session.listSessionFilePins(owner), []);
  } finally {
    await bundle?.client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Pin一覧は保存済み参照だけを内容read・tree走査なしで最大4項目並列検査する"
// oracle = { type = "contract", ref = "docs/design/database-schema.md: Files Pin" }
// fault = "登録数分のstatを無制限並列実行するか内容read・全tree走査を行う"
// observable = "lstatの最大同時実行数、検査path集合と取得したPin一覧"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerService.listSessionFilePinsの参照検査"
// lifecycle = "permanent"
// impact = "多数の深いPinでもFiles表示がfilesystem呼出の無制限増加や全走査を引き起こさない"
// distinction = "型検査や小数正常系では確認できない多数Pinの同時IO上限と対象限定を測定する"
// @end-test-value
test("Files Pin の参照検査は最大4項目並列で保存pathのみを扱う", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-file-pin-bounded-"));
  try {
    const directory = path.join(temporary, "deep", "nested");
    await mkdir(directory, { recursive: true });
    const pins = Array.from({ length: 24 }, (_, index) => ({ rootKind: "workspace" as const,
      rootPath: process.platform === "win32" ? temporary.toLowerCase() : temporary,
      relativePath: `deep/nested/file-${index}.txt`, kind: "file" as const, rootLabel: "Workspace" }));
    await Promise.all(pins.map((pin) => writeFile(path.join(temporary, pin.relativePath), "file")));
    let active = 0;
    let maximum = 0;
    const inspected = new Set<string>();
    const service = new SessionFileExplorerService({ userDataPath: temporary,
      getPinStorage: () => ({ listSessionFilePins: () => pins, pinSessionFile: () => {}, unpinSessionFile: () => {} }),
      getSessionContext: async () => ({ workspacePath: temporary, parentSessionId: "main", parentIncarnationId: "incarnation", allowedAdditionalDirectories: [] }),
      async lstatPath(target) {
        active++;
        maximum = Math.max(maximum, active);
        inspected.add(target);
        try {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return await lstat(target);
        } finally { active--; }
      },
      openFile: async () => { throw new Error("Pin must not read file contents"); },
      listDirectory: async () => { throw new Error("Pin must not scan directories"); },
    });
    const result = await service.listSessionFilePins("main");
    assert.equal(result.length, pins.length);
    assert.ok(result.every((pin) => pin.unavailableReason === null));
    assert.ok(maximum <= 4);
    assert.deepEqual([...inspected].sort(), pins.map((pin) => path.join(temporary, ...pin.relativePath.split("/"))).sort());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
