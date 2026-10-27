import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SessionFolderCleanupService } from "../../src-electron/files/session-folder-cleanup-service.js";
import { parseSessionFolderCleanupRequest } from "../../src-shared/session/session-folder-cleanup.js";

const all = { fromDate: "", toDate: "", minimumFileSizeMiB: 0 };
const session = (
  id: string,
  updatedAt = new Date(2026, 4, 12, 12).toISOString(),
) => ({
  id,
  incarnationId: `incarnation-${id}`,
  updatedAt,
  workspacePath: "",
  status: "saved" as const,
  runState: "idle",
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-cleanup-"));
  let identity = {};
  const sessions = [session("main")];
  const running = new Set<string>();
  const service = new SessionFolderCleanupService({
    userDataPath: root,
    readState: async () => ({ identity, sessions }),
    assertCurrent: (value) => {
      assert.equal(value, identity);
    },
    isRunning: (id) => running.has(id),
  });
  const folder = (id = "main") => path.join(root, "session-files", id);
  const file = async (
    relativePath: string,
    data: string | Buffer,
    id = "main",
  ) => {
    const destination = path.join(folder(id), relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
    return destination;
  };
  return {
    root,
    sessions,
    running,
    service,
    folder,
    file,
    changeStorage: () => {
      identity = {};
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

// @test-value v2
// kind = "contract"
// claim = "local日付の両端と最小サイズ同値を含め、条件外fileとSessionを保持し、空の下位directoryだけ除去する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "日付境界かサイズ境界を除外する、または条件外fileとSession Folder rootを削除する"
// observable = "serviceのscan件数、削除件数と容量、filesystem上の保持fileおよびroot"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService scan/run boundaries"
// lifecycle = "permanent"
// impact = "選択した掃除範囲が破られると保存fileを不可逆に失う"
// distinction = "型checkで保証できない実filesystemの条件判定と削除を合成fileで確認する"
// @end-test-value
it("local日付とMiB境界を含め、rootと条件外fileを保持する", async () => {
  const f = await fixture();
  try {
    f.sessions[0]!.updatedAt = new Date(2026, 4, 12, 0, 0, 0).toISOString();
    f.sessions.push(
      session("end", new Date(2026, 4, 13, 23, 59, 59).toISOString()),
      session("outside", new Date(2026, 4, 14, 0).toISOString()),
    );
    const keep = await f.file("keep", "small");
    await f.file("nested/large", Buffer.alloc(1024 * 1024));
    await f.file("end", Buffer.alloc(1024 * 1024), "end");
    const outside = await f.file(
      "outside",
      Buffer.alloc(1024 * 1024),
      "outside",
    );
    const scan = await f.service.scan({
      fromDate: "2026-05-12",
      toDate: "2026-05-13",
      minimumFileSizeMiB: 1,
    });
    assert.equal(scan.sessionCount, 2);
    assert.equal(scan.totalFileCount, 3);
    assert.equal(scan.matchedFileCount, 2);
    const result = await f.service.run(scan.scanId);
    assert.deepEqual(
      [
        result.deletedFileCount,
        result.deletedBytes,
        result.deletedDirectoryCount,
      ],
      [2, 2 * 1024 * 1024, 1],
    );
    assert.equal((await stat(f.folder())).isDirectory(), true);
    assert.equal((await stat(f.folder("end"))).isDirectory(), true);
    assert.equal(await readFile(keep, "utf8"), "small");
    assert.equal((await stat(outside)).size, 1024 * 1024);
    assert.equal(f.sessions.length, 3);
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "0サイズを含む掃除でも実行中、他SessionのWorkspaceと重なるfolder、孤立folder、link先を保持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "除外対象folderまたはlink先を走査削除する"
// observable = "除外件数と実行後の実file内容、0byte file削除件数"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService protected folders"
// lifecycle = "permanent"
// impact = "Workspaceまたは実行中の成果物の不可逆削除を防ぐ"
// distinction = "実directory linkと複数Sessionの関係は型checkや単独fileの削除testでは保証しない"
// @end-test-value
it("実行中、Workspace、孤立folderとlinkを除外し0byteは掃除する", async () => {
  const f = await fixture();
  try {
    f.sessions.push(session("running"), session("workspace"), session("other"));
    f.sessions[3]!.workspacePath = path.join(f.folder("workspace"), "nested");
    f.running.add("running");
    const protectedPaths = [
      await f.file("keep", "running", "running"),
      await f.file("nested/keep", "workspace", "workspace"),
      await f.file("keep", "orphan", "orphan"),
    ];
    const external = path.join(f.root, "external");
    await mkdir(external);
    await writeFile(path.join(external, "keep"), "external");
    await f.file("empty", "");
    await symlink(
      external,
      path.join(f.folder(), "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const scan = await f.service.scan(all);
    assert.deepEqual(
      [
        scan.skippedRunningSessionCount,
        scan.skippedWorkspaceSessionCount,
        scan.skippedLinkCount,
        scan.matchedFileCount,
      ],
      [1, 1, 1, 1],
    );
    const result = await f.service.run(scan.scanId);
    assert.equal(result.deletedFileCount, 1);
    assert.equal(result.deletedBytes, 0);
    for (const retained of protectedPaths)
      assert.equal((await stat(retained)).isFile(), true);
    assert.equal(
      await readFile(path.join(external, "keep"), "utf8"),
      "external",
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "確認後の変更file、追加file、実行開始Session、incarnation変更、Workspace変更を削除せず、最新scanだけを一回実行する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "scanを再走査して未確認fileを削除するか、古い状態のSessionへ削除を適用する"
// observable = "runのskip件数、保持file内容、古いscanと再実行の拒否"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService confirmation snapshot"
// lifecycle = "permanent"
// impact = "ユーザーが確認していない成果物の不可逆削除を防ぐ"
// distinction = "scanとrunの間の実filesystemおよびSession状態変化をserviceから確認する"
// @end-test-value
it("確認snapshot以外と状態変化を保持しscanを失効させる", async () => {
  const f = await fixture();
  try {
    for (const id of ["running", "replaced", "workspace"]) {
      f.sessions.push(session(id));
      await f.file("keep", id, id);
    }
    const changed = await f.file("changed", "before");
    const stale = await f.service.scan(all);
    const scan = await f.service.scan(all);
    await assert.rejects(f.service.run(stale.scanId), /expired/);
    await writeFile(changed, "after with a different size");
    const added = await f.file("added", "new");
    f.running.add("running");
    f.sessions[2]!.incarnationId = "new-incarnation";
    f.sessions[3]!.workspacePath = f.folder("workspace");
    const result = await f.service.run(scan.scanId);
    assert.equal(result.skippedFileCount, 4);
    assert.equal(result.deletedFileCount, 0);
    assert.equal(
      result.issues.every((issue) => issue.kind === "skipped"),
      true,
    );
    assert.equal(
      await readFile(changed, "utf8"),
      "after with a different size",
    );
    assert.equal(await readFile(added, "utf8"), "new");
    for (const id of ["running", "replaced", "workspace"])
      assert.equal(await readFile(path.join(f.folder(id), "keep"), "utf8"), id);
    await assert.rejects(f.service.run(scan.scanId), /expired/);
    const next = await f.service.scan(all);
    f.changeStorage();
    await assert.rejects(f.service.run(next.scanId), /Storage has changed/);
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "scan後にdirectoryをlinkへ置換してもlink先の同名fileを削除しない"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "fileだけ検査して祖先directoryのlink置換先を削除する"
// observable = "runのskip件数とlink先fileの内容"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService directory identity"
// lifecycle = "permanent"
// impact = "確認範囲外のfileの不可逆削除を防ぐ"
// distinction = "fileのidentityと更新metadataを保持したdirectory移動後にlinkを設置し、file自体の差分でなく祖先検証による除外を確認する"
// @end-test-value
it("scan後のdirectory link置換を除外する", async () => {
  const f = await fixture();
  try {
    await f.file("nested/keep", "confirmed");
    const before = await stat(path.join(f.folder(), "nested", "keep"));
    const scan = await f.service.scan(all);
    const external = path.join(f.root, "external");
    await fs.rename(path.join(f.folder(), "nested"), external);
    await symlink(
      external,
      path.join(f.folder(), "nested"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const after = await stat(path.join(f.folder(), "nested", "keep"));
    for (const key of ["dev", "ino", "birthtimeMs", "size", "mtimeMs", "ctimeMs"] as const) {
      assert.equal(after[key], before[key]);
    }
    const result = await f.service.run(scan.scanId);
    assert.equal(result.skippedFileCount, 1);
    assert.equal(result.deletedFileCount, 0);
    assert.equal(
      await readFile(path.join(external, "keep"), "utf8"),
      "confirmed",
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "削除失敗と消失fileを成功と区別し、成功fileだけを削除容量へ計上する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "unlink失敗を成功に数えるか、消失fileの容量を削除量へ加える"
// observable = "runの成功、失敗、skip件数と容量および保持file"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService partial filesystem failure"
// lifecycle = "permanent"
// impact = "掃除の失敗を隠さず残存fileと解放容量を正確に伝える"
// distinction = "OSのunlink失敗を注入しserviceの集計と実file保持を確認する"
// @end-test-value
it("削除失敗、消失、成功を区別する", async () => {
  const f = await fixture();
  const originalUnlink = fs.unlink;
  try {
    const failure = await f.file("failure", "retained");
    const missing = await f.file("missing", "missing");
    await f.file("success", "ok");
    const scan = await f.service.scan(all);
    await rm(missing);
    fs.unlink = async (target) => {
      if (String(target) === failure)
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      await originalUnlink(target);
    };
    const result = await f.service.run(scan.scanId);
    assert.deepEqual(
      [
        result.deletedFileCount,
        result.deletedBytes,
        result.failedFileCount,
        result.skippedFileCount,
      ],
      [1, 2, 1, 1],
    );
    assert.equal(result.issues.length, 2);
    assert.equal(
      result.issues.find((issue) => issue.relativePath === "failure")?.kind,
      "failed",
    );
    assert.equal(
      result.issues.find((issue) => issue.relativePath === "missing")?.kind,
      "skipped",
    );
    assert.equal(await readFile(failure, "utf8"), "retained");
  } finally {
    fs.unlink = originalUnlink;
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "削除中にstorage owner identityが失効すると以降の削除を中断し、既に削除したfileと残りskipを返す"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md" }
// fault = "storage ownerの失効後も削除を続ける、または部分成功と残りskipを正しく集計できない"
// observable = "runのdeletedFileCount/deletedBytes/skippedFileCount/failedFileCount、残存file数と最終Issue kind"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService storage owner identity invalidation during run"
// lifecycle = "permanent"
// impact = "storage owner失効後の追加削除を止め、既に実行した削除と残存fileを正確に伝える"
// distinction = "unlinkのawait中にfixtureのstorage owner identityだけを変更する。Mainが保持するSession配列参照の更新検証やWorkspace状態更新は通さない"
// @end-test-value
it("削除中のstorage owner失効で中断し部分結果を返す", async () => {
  const f = await fixture();
  const originalUnlink = fs.unlink;
  try {
    await f.file("first", "one");
    await f.file("second", "two");
    const scan = await f.service.scan(all);
    fs.unlink = async (target) => {
      await originalUnlink(target);
      f.changeStorage();
    };
    const result = await f.service.run(scan.scanId);
    assert.deepEqual(
      [
        result.deletedFileCount,
        result.deletedBytes,
        result.skippedFileCount,
        result.failedFileCount,
      ],
      [1, 3, 1, 0],
    );
    assert.equal((await fs.readdir(f.folder())).length, 1);
    assert.equal(result.issues.at(-1)?.kind, "skipped");
  } finally {
    fs.unlink = originalUnlink;
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "掃除入力は実在日付、昇順期間、換算byteが安全な範囲の非負finite MiB閾値だけを受理する"
// oracle = { type = "contract", ref = "src-shared/session/session-folder-cleanup.ts: SessionFolderCleanupRequest" }
// fault = "不正日付または負数や無限大のサイズを削除条件として受理する"
// observable = "parserの受理結果とTypeError"
// observation_boundary = "public-boundary"
// scope = "Session folder cleanup IPC input parser"
// lifecycle = "permanent"
// impact = "不正入力による意図しない掃除範囲を防ぐ"
// distinction = "IPCで失われるTypeScript型のruntime入力検証を確認する"
// @end-test-value
it("掃除条件を信頼境界で検証する", () => {
  assert.deepEqual(parseSessionFolderCleanupRequest(all), all);
  assert.equal(
    parseSessionFolderCleanupRequest({ ...all, minimumFileSizeMiB: 0.1 })
      .minimumFileSizeMiB,
    0.1,
  );
  assert.equal(
    parseSessionFolderCleanupRequest({
      ...all,
      minimumFileSizeMiB: 1 / (1024 * 1024),
    }).minimumFileSizeMiB,
    1 / (1024 * 1024),
  );
  for (const input of [
    null,
    {},
    { ...all, fromDate: "2026-02-30" },
    { ...all, fromDate: "2026-05-13", toDate: "2026-05-12" },
    ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER].map(
      (minimumFileSizeMiB) => ({ ...all, minimumFileSizeMiB }),
    ),
  ]) {
    assert.throws(() => parseSessionFolderCleanupRequest(input), TypeError);
  }
});
