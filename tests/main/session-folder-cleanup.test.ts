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
import { syncBuiltinESMExports } from "node:module";
import { it } from "node:test";
import { SessionFolderCleanupService } from "../../src-electron/files/session-folder-cleanup-service.js";
import { parseSessionFolderCleanupRequest } from "../../src-shared/session/session-folder-cleanup.js";
import type { AppLogInput } from "../../src-shared/window/app-log-types.js";

const all = { fromDate: "", toDate: "", minimumFileSizeMiB: 0 };
/** 一覧の日時やワークスペース保護条件を組み替えられる、非実行中のセッション概要を作る。 */
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
/** 一時ユーザーデータに掃除サービスを接続し、ログ、実行中判定、ストア世代を操作できるようにする。 */
async function fixture(writeLog?: (input: AppLogInput) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-cleanup-"));
  let identity = {};
  const sessions = [session("main")];
  const running = new Set<string>();
  const logs: AppLogInput[] = [];
  const service = new SessionFolderCleanupService({
    /** 診断イベントを検証用に保持し、任意の外部ライターにも渡す。 */
    writeLog: (input) => {
      logs.push(input);
      writeLog?.(input);
    },
    userDataPath: root,
    /** スキャンや実行時の現在のストア世代とセッション一覧を返す。 */
    readState: async () => ({ identity, sessions }),
    /** 保存されたスナップショットの所有者が今も最新か検証する。 */
    assertCurrent: (value) => {
      assert.equal(value, identity);
    },
    /** 実行中の集合に登録したセッションを掃除対象から除外させる。 */
    isRunning: (id) => running.has(id),
  });
  /** 指定したセッションに対応する管理フォルダーのパスを返す。 */
  const folder = (id = "main") => path.join(root, "session-files", id);
  /** 指定のセッション配下に途中のフォルダーと検証用ファイルを作る。 */
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
    logs,
    service,
    folder,
    file,
    /** セッション一覧を残したままストア世代だけを切り替え、古い確認結果を失効させる。 */
    changeStorage: () => {
      identity = {};
    },
    /** 掃除対象のフィクスチャを含む一時データを削除する。 */
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
/** ローカル日付の両端と最小サイズちょうどのファイルを対象に含め、選択外のファイル、セッション、フォルダーのルートは維持する。 */
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
// claim = "期間と0MiBでの計算診断は日時・保護・folder・fileの段階別件数を記録し、個別データを含めない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md: Session Folder Cleanup Diagnostic Log Policy" }
// fault = "期間除外と後段除外を混同する、0byteを候補から落とす、または個別識別子をログへ混入する"
// observable = "scanの候補数とwriteLogへ渡された集計eventの完全なdata項目"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService scan diagnostics"
// lifecycle = "permanent"
// impact = "問題PCの候補0件の切分けを可能にし、共有する診断ログの個別情報漏えいを防ぐ"
// distinction = "合成filesystemでscanのみ実行し、型checkでは保証できない実分岐の集計とログpayloadを検証する"
// risk_tags = ["privacy"]
// @end-test-value
/** 期間指定と 0 MiB のスキャンでは各段階の候補数を記録し、個別のセッション・パス・内容は診断に含めない。 */
it("期間と0MiBのscan診断を個別情報なしで集計する", async () => {
  const f = await fixture();
  try {
    f.sessions.push(
      session("before", new Date(2026, 4, 11, 23, 59).toISOString()),
      session("after", new Date(2026, 4, 13, 0).toISOString()),
      session("invalid", "not-a-date"),
      session("running"),
      session("workspace"),
      session("missing"),
      session("empty"),
    );
    f.running.add("running");
    f.sessions[5]!.workspacePath = f.folder("workspace");
    await mkdir(f.folder("empty"), { recursive: true });
    await f.file("private-filename", "private-content");
    await f.file("zero", "");
    const request = { ...all, fromDate: "2026-05-12", toDate: "2026-05-12" };
    const scan = await f.service.scan(request);
    assert.equal(scan.matchedFileCount, 2);
    assert.equal(f.logs.length, 1);
    const log = f.logs[0]!;
    assert.equal(log.kind, "session-folder-cleanup.scan-completed");
    assert.equal(log.level, "info");
    assert.equal(log.process, "main");
    const data = log.data as Record<string, unknown>;
    assert.ok(Number(data.elapsedMs) >= 0);
    assert.deepEqual(data, {
      ...request,
      minimumFileSizeBytes: 0,
      dateBasis: "session.updatedAt/local-date",
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      stage: "assert-current",
      managedRoot: "present",
      totalSessionCount: 8,
      invalidUpdatedAtSessionCount: 1,
      outsideDateSessionCount: 2,
      beforeFromDateSessionCount: 1,
      afterToDateSessionCount: 1,
      dateMatchedSessionCount: 5,
      skippedRunningSessionCount: 1,
      skippedWorkspaceSessionCount: 1,
      attemptedFolderCount: 3,
      scannedFolderCount: 2,
      foldersWithoutRegularFilesCount: 1,
      missingFolderCount: 1,
      skippedLinkCount: 0,
      totalFileCount: 2,
      totalBytes: 15,
      belowMinimumFileCount: 0,
      matchedFileCount: 2,
      matchedBytes: 15,
      failedEntryCount: 0,
      missingEntryCount: 0,
      elapsedMs: data.elapsedMs,
      entryFailureCategories: { permission: 0, io: 0, missing: 0, other: 0 },
      scanFailureCategory: null,
    });
    assert.deepEqual(Object.keys(log).sort(), [
      "data",
      "kind",
      "level",
      "message",
      "process",
    ]);
    for (const privateValue of [
      f.root,
      "private-filename",
      "private-content",
      scan.scanId,
      "incarnation-main",
    ])
      assert.equal(JSON.stringify(log).includes(privateValue), false);
    const sized = await f.service.scan({ ...request, minimumFileSizeMiB: 1 });
    assert.equal(sized.matchedFileCount, 0);
    assert.equal(
      (f.logs[1]!.data as Record<string, unknown>).belowMinimumFileCount,
      2,
    );
    assert.equal(
      await readFile(path.join(f.folder(), "private-filename"), "utf8"),
      "private-content",
    );
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "managed rootの消失による正常0件と不正rootによる中断をログで区別し、元の例外を保持する"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md: Session Folder Cleanup Diagnostic Log Policy" }
// fault = "消失rootを走査済みと報告する、または中断を正常完了として記録する"
// observable = "scanの結果またはrejectと診断eventのkind、stage、managedRoot、件数"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService root diagnostics"
// lifecycle = "permanent"
// impact = "候補0件と容量計算失敗を混同する誤診を防ぐ"
// distinction = "実filesystemのmissingと通常file rootを作り、返却結果と記録を同時に観測する"
// @end-test-value
/** 管理ルートがなければ正常な候補ゼロ、通常ファイルなら元のエラーによる失敗とし、診断の状態も分ける。 */
it("managed rootのmissingと失敗を診断で区別する", async () => {
  const f = await fixture();
  try {
    const scan = await f.service.scan(all);
    assert.equal(scan.matchedFileCount, 0);
    const missing = f.logs[0]!;
    assert.equal(missing.kind, "session-folder-cleanup.scan-completed");
    assert.equal(
      (missing.data as Record<string, unknown>).managedRoot,
      "missing",
    );
    assert.equal(
      (missing.data as Record<string, unknown>).attemptedFolderCount,
      0,
    );
    await writeFile(path.join(f.root, "session-files"), "not-a-directory");
    await assert.rejects(f.service.scan(all), /not a regular directory/);
    const failed = f.logs[1]!;
    assert.equal(failed.kind, "session-folder-cleanup.scan-failed");
    assert.equal(failed.level, "warn");
    assert.equal(
      (failed.data as Record<string, unknown>).stage,
      "check-managed-root",
    );
    assert.equal(
      (failed.data as Record<string, unknown>).managedRoot,
      "not-regular-directory",
    );
    assert.equal(failed.error, undefined);
    assert.equal(JSON.stringify(failed).includes(f.root), false);
    assert.equal(f.logs.length, 2);
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "診断writerの失敗はscanの正常結果も元の失敗も変更しない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md: Session Folder Cleanup Diagnostic Log Policy" }
// fault = "ログ書込失敗で容量計算をrejectする、または元の例外を置換する"
// observable = "writeLogをthrowさせたscanの返却候補数とreject理由"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService diagnostic writer failure"
// lifecycle = "permanent"
// impact = "ログ保存先の障害で掃除の容量計算が利用不能になることを防ぐ"
// distinction = "通常loggerの静的接続や型checkでは確認できない実行時throwを注入する"
// @end-test-value
/** 診断ライターが例外を投げても、正常な空結果と不正ルートの拒否理由を変えない。 */
it("ログ書込失敗はscanの成否を変えない", async () => {
  const f = await fixture(() => {
    throw new Error("log-writer-failed");
  });
  try {
    assert.equal((await f.service.scan(all)).matchedFileCount, 0);
    await writeFile(path.join(f.root, "session-files"), "not-a-directory");
    await assert.rejects(f.service.scan(all), /not a regular directory/);
    assert.equal(f.logs.length, 2);
  } finally {
    await f.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "entry失敗とscan中断はpermission・io・missing・otherへ固定分類し、例外の自由文字列をログへ出さない"
// oracle = { type = "contract", ref = "docs/design/app-log-base.md: Session Folder Cleanup Diagnostic Log Policy" }
// fault = "読取障害の種類を失う、未知のcodeをログへ転記する、または部分失敗をscan中断として扱う"
// observable = "scan結果のissues件数、entryFailureCategories、scanFailureCategoryと元例外の同一性"
// observation_boundary = "public-boundary"
// scope = "SessionFolderCleanupService filesystem and state failure diagnostics"
// lifecycle = "permanent"
// impact = "問題PCの権限障害とI/O障害を識別し、例外に含まれるpathや本文の漏えいを防ぐ"
// distinction = "実walk内のdirectory読取とreadStateへ同じerrnoを注入し、継続と中断の両経路を確認する"
// risk_tags = ["privacy"]
// @end-test-value
/** 個別項目の失敗と状態読込の中断を固定カテゴリで数え、例外の自由文や個別パスを診断へ公開しない。 */
it("失敗を固定分類し例外の個別情報を診断へ出さない", async () => {
  const f = await fixture();
  const originalReaddir = fs.readdir;
  try {
    await f.file("blocked/private-file", "private-content");
    for (const [code, category] of [
      ["EACCES", "permission"],
      ["EPERM", "permission"],
      ["EIO", "io"],
      ["ENOENT", "missing"],
      ["ENOTDIR", "missing"],
      ["private-code", "other"],
    ] as const) {
      const error = Object.assign(new Error(`private-error ${f.root}`), {
        code,
      });
      fs.readdir = (async (
        target: Parameters<typeof fs.readdir>[0],
        ...options: unknown[]
      ) => {
        if (String(target) === path.join(f.folder(), "blocked")) throw error;
        return Reflect.apply(originalReaddir, fs, [target, ...options]);
      }) as typeof fs.readdir;
      syncBuiltinESMExports();
      const scan = await f.service.scan(all);
      assert.equal(scan.issues.length, 1);
      const partial = f.logs.at(-1)!;
      assert.equal(partial.kind, "session-folder-cleanup.scan-completed");
      const data = partial.data as Record<string, unknown>;
      assert.equal(data.failedEntryCount, 1);
      assert.equal(data.missingEntryCount, code === "ENOENT" ? 1 : 0);
      assert.deepEqual(data.entryFailureCategories, {
        permission: 0,
        io: 0,
        missing: 0,
        other: 0,
        [category]: 1,
      });
      assert.equal(data.scanFailureCategory, null);
      const failing = new SessionFolderCleanupService({
        userDataPath: f.root,
        /** スキャン自体を中断する経路で、その時点のエラーをそのまま投げる。 */
        readState: async () => {
          throw error;
        },
        /** 状態が読めないケースではストア世代の追加条件を設けない。 */
        assertCurrent: () => {},
        /** 実行中判定では失敗させず、状態読み取りの失敗に限定する。 */
        isRunning: () => false,
        /** 個別項目の失敗と中断の診断を同じ記録先で比較できるようにする。 */
        writeLog: (input) => {
          f.logs.push(input);
        },
      });
      await assert.rejects(failing.scan(all), (actual) => actual === error);
      const aborted = f.logs.at(-1)!;
      assert.equal(aborted.kind, "session-folder-cleanup.scan-failed");
      assert.equal(
        (aborted.data as Record<string, unknown>).stage,
        "read-state",
      );
      assert.equal(
        (aborted.data as Record<string, unknown>).scanFailureCategory,
        category,
      );
      for (const log of [partial, aborted]) {
        for (const privateValue of [
          f.root,
          "private-file",
          "private-content",
          "private-error",
          "private-code",
        ])
          assert.equal(JSON.stringify(log).includes(privateValue), false);
      }
    }
  } finally {
    fs.readdir = originalReaddir;
    syncBuiltinESMExports();
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
/** 0 バイトの候補は削除しつつ、実行中、他のワークスペースと重なる場所、孤立フォルダーとリンクの先を保持する。 */
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
/** 変更・追加されたファイルと実行開始や世代変更後のセッションを保持し、最新のスキャンも一度しか実行できない。 */
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
/** スキャン後に祖先フォルダーをリンクへ置き換えた場合、同じファイルの識別情報でも削除せずにスキップする。 */
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
    for (const key of [
      "dev",
      "ino",
      "birthtimeMs",
      "size",
      "mtimeMs",
      "ctimeMs",
    ] as const) {
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
/** 削除時の失敗と既に消失したファイルは成功と分け、実際に消した分だけ件数と容量へ計上する。 */
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
/** 最初の削除でストア所有者が失効したら後続を中断し、完了済みの件数・容量と残りのスキップを返す。 */
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
/** 実在する日付、正しい期間順序、安全なバイト数へ換算できる非負の有限値だけを掃除条件として受け入れる。 */
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
