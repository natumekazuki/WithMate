import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const launcherPath = fileURLToPath(new URL("../../scripts/start-withmate-visual-check.ps1", import.meta.url));
const harnessPath = fileURLToPath(new URL("../fixtures/visual-check-launcher.ps1", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };

type LaunchReport = {
  result: { DataMode: string; Ready?: boolean; UserDataPath: string } | null;
  error: string | null;
  events: string[];
  launch: { arguments: string[]; userDataPath: string; workingDirectory: string } | null;
};

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "withmate-visual-check-"));
  const repository = path.join(root, "worktree with spaces");
  const dataRoot = path.join(root, "appdata");
  const target = path.join(dataRoot, "WithMate-visual-check");
  const source = path.join(dataRoot, "WithMate");
  const files: Record<string, string> = {
    "package.json": "{}",
    "package-lock.json": JSON.stringify({ packages: { "node_modules/electron": { version: "1.2.3" } } }),
    "node_modules/electron/package.json": JSON.stringify({ version: "1.2.3" }),
    "node_modules/electron/dist/electron.exe": "",
    "dist-electron/src-electron/main.js": "",
  };
  for (const binary of ["tsc", "tsx", "vite", "install-electron"]) {
    files[`node_modules/.bin/${binary}.cmd`] = "";
  }
  await mkdir(dataRoot, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repository, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return {
    root, repository, dataRoot, target, source,
    async run(mode?: string, ...flags: string[]): Promise<LaunchReport> {
      const { stdout } = await execute("pwsh.exe", [
        "-NoProfile", "-NonInteractive", "-File", harnessPath,
        "-LauncherPath", launcherPath, "-RepositoryPath", repository, "-DataRoot", dataRoot,
        ...(mode ? ["-Mode", mode] : []), ...flags,
      ], { timeout: 30_000, windowsHide: true });
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("RESULT_JSON:"));
      assert.ok(line, stdout);
      return JSON.parse(line.slice("RESULT_JSON:".length)) as LaunchReport;
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "既定Reuseはコピー元なしでも指定先を保持し、通常起動へ同じuserDataを渡す"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "無指定でコピーを要求する、再利用データを置換する、または別userDataで起動する"
// observable = "既存ファイルの内容とlaunch引数・userData・結果mode"
// observation_boundary = "public-boundary"
// scope = "visual-check launcher Reuse"
// lifecycle = "permanent"
// impact = "再利用する検証データの消失と意図しない本体データ使用を防ぐ"
// distinction = "型検査やDB単体testでは検証scriptの既定modeと起動先を確認できない。Windows上で一時directoryだけを使用する"
// @end-test-value
test("visual-check defaults to Reuse and preserves data without a copy source", windowsOnly, async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.target);
    await writeFile(path.join(fixture.target, "retained.txt"), "retained");
    const report = await fixture.run();
    assert.equal(report.error, null);
    assert.equal(report.result?.DataMode, "Reuse");
    assert.equal(await readFile(path.join(fixture.target, "retained.txt"), "utf8"), "retained");
    assert.equal(existsSync(fixture.source), false);
    assert.equal(report.launch?.userDataPath, fixture.target);
    assert.deepEqual(report.launch?.arguments, [
      path.join(fixture.repository, "dist-electron", "src-electron", "main.js"),
      "--withmate-visual-check",
    ]);
    assert.deepEqual(report.events, ["npm run build", "process-scan", "launch"]);
  } finally {
    await fixture.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Freshはコピー元がなくても不存在または空の検証先を用意し通常起動へ渡す"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "Freshがコピー元を要求する、初期化用directoryを用意しない、または起動先を誤る"
// observable = "作成されたdirectoryの内容とlaunch userData・結果mode"
// observation_boundary = "public-boundary"
// scope = "visual-check launcher Fresh"
// lifecycle = "permanent"
// @end-test-value
test("Fresh launches with a missing or empty target and no source", windowsOnly, async () => {
  for (const existing of [false, true]) {
    const fixture = await createFixture();
    try {
      if (existing) await mkdir(fixture.target);
      const report = await fixture.run("Fresh");
      assert.equal(report.error, null);
      assert.equal(report.result?.DataMode, "Fresh");
      assert.equal(report.launch?.userDataPath, fixture.target);
      assert.deepEqual(await readdir(fixture.target), ["visual-check-process.json"]);
      assert.equal(existsSync(fixture.source), false);
    } finally {
      await fixture.dispose();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "不正mode・不存在Reuse・コピー元なしCopy・非空Fresh・非directory対象はbuildやprocess操作前に拒否されデータを保持する"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "危険なデータ状態を受理するか、拒否より先にbuild・process操作・データ破棄する"
// observable = "エラー、外部操作eventが空、拒否後の既存file内容"
// observation_boundary = "public-boundary"
// scope = "visual-check launcher preflight"
// lifecycle = "permanent"
// impact = "操作誤りによる既存データの消失や稼働中の検証processの不要な停止を防ぐ"
// distinction = "PowerShellのmode別制御と隠しfile判定は型検査・DB testでは担保できない。小規模fixtureで各拒否境界を実行する"
// @end-test-value
test("invalid mode and unsafe data states fail before build or process control", windowsOnly, async () => {
  const cases = [
    { mode: "Unknown", state: "missing", error: /ValidateSet|validation|argument/i },
    { mode: "Reuse", state: "missing", error: /Fresh.*Copy/ },
    { mode: "Copy", state: "missing", error: /Source userData was not found/ },
    { mode: "Fresh", state: "file", error: /must be a directory/ },
    { mode: "Reuse", state: "file", error: /must be a directory/ },
    { mode: "Copy", state: "file", error: /must be a directory/ },
    { mode: "Fresh", state: "hidden", error: /requires an empty/ },
    { mode: "Fresh", state: "contents", error: /requires an empty/ },
  ];
  for (const entry of cases) {
    const fixture = await createFixture();
    try {
      let preservedPath: string | undefined;
      if (entry.state === "file") {
        preservedPath = fixture.target;
      } else if (entry.state !== "missing") {
        await mkdir(fixture.target);
        preservedPath = path.join(fixture.target, "keep.txt");
      }
      if (preservedPath) {
        await writeFile(preservedPath, "keep");
        if (entry.state === "hidden") {
          await execute("attrib.exe", ["+H", preservedPath], { windowsHide: true });
        }
      }
      const report = await fixture.run(entry.mode);
      assert.match(report.error ?? "", entry.error);
      assert.deepEqual(report.events, []);
      if (preservedPath) assert.equal(await readFile(preservedPath, "utf8"), "keep");
    } finally {
      await fixture.dispose();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Freshはbuild中に対象へ追加されたデータもprocess停止・起動前に検出して保持する"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "build前の空判定だけで初期状態起動を継続する"
// observable = "非空エラー、buildのみのevent、build中に作成したfileの保持"
// observation_boundary = "public-boundary"
// scope = "visual-check Fresh post-build preflight"
// lifecycle = "permanent"
// @end-test-value
test("Fresh rechecks data after the build before process control", windowsOnly, async () => {
  const fixture = await createFixture();
  try {
    const report = await fixture.run("Fresh", "-SeedDuringBuild");
    assert.match(report.error ?? "", /requires an empty/);
    assert.deepEqual(report.events, ["npm run build"]);
    assert.equal(await readFile(path.join(fixture.target, "arrived-during-build.txt"), "utf8"), "keep");
  } finally {
    await fixture.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "明示Copyは通常fileとSQLite snapshotで検証先を置換しコピー元を保持する"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "Copyを省略する、古い検証データを混入させる、SQLite内容を失う、またはコピー元を変更する"
// observable = "コピー先のfile・SQL行・旧file不在とコピー元のfile・DB bytes"
// observation_boundary = "public-boundary"
// scope = "visual-check launcher Copy"
// lifecycle = "permanent"
// impact = "コピー元の保護と再現用snapshotの一貫性を維持する"
// distinction = "実robocopyとSQLite backupを一時fixtureへ実行する。mockしたコピー結果やbuildだけではデータ境界を確認できない"
// @end-test-value
test("Copy replaces target files and snapshots SQLite without changing the source", windowsOnly, async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.source);
    await mkdir(fixture.target);
    await writeFile(path.join(fixture.source, "settings.json"), '{"value":"source"}');
    await writeFile(path.join(fixture.target, "obsolete.txt"), "old");
    const sourceDb = path.join(fixture.source, "withmate-v6.db");
    const database = new DatabaseSync(sourceDb);
    database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('source')");
    database.close();
    const sourceBytes = await readFile(sourceDb);
    const report = await fixture.run("Copy");
    assert.equal(report.error, null);
    assert.equal(report.result?.DataMode, "Copy");
    assert.equal(await readFile(path.join(fixture.target, "settings.json"), "utf8"), '{"value":"source"}');
    assert.equal(existsSync(path.join(fixture.target, "obsolete.txt")), false);
    const copiedDb = new DatabaseSync(path.join(fixture.target, "withmate-v6.db"), { readOnly: true });
    try {
      assert.equal((copiedDb.prepare("SELECT value FROM retained").get() as { value: string }).value, "source");
    } finally {
      copiedDb.close();
    }
    assert.deepEqual(await readFile(sourceDb), sourceBytes);
    assert.equal(await readFile(path.join(fixture.source, "settings.json"), "utf8"), '{"value":"source"}');
    assert.equal(report.launch?.userDataPath, fixture.target);
  } finally {
    await fixture.dispose();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "ValidateOnlyは全modeでbuildまで行うが検証データを準備せずprocess操作を行わない"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "ValidateOnlyでデータを作成・置換したりprocess停止・起動へ進む"
// observable = "Readyとmode、buildだけのevent、target不存在または既存file保持"
// observation_boundary = "public-boundary"
// scope = "visual-check ValidateOnly"
// lifecycle = "permanent"
// @end-test-value
test("ValidateOnly builds without preparing data or controlling processes in all modes", windowsOnly, async () => {
  for (const mode of ["Fresh", "Reuse", "Copy"]) {
    const fixture = await createFixture();
    try {
      if (mode !== "Fresh") {
        await mkdir(fixture.target);
        await writeFile(path.join(fixture.target, "keep.txt"), "keep");
      }
      if (mode === "Copy") await mkdir(fixture.source);
      const report = await fixture.run(mode, "-ValidateOnly");
      assert.equal(report.error, null);
      assert.equal(report.result?.Ready, true);
      assert.equal(report.result?.DataMode, mode);
      assert.deepEqual(report.events, ["npm run build"]);
      assert.equal(report.launch, null);
      if (mode === "Fresh") {
        assert.equal(existsSync(fixture.target), false);
      } else {
        assert.deepEqual(await readdir(fixture.target), ["keep.txt"]);
        assert.equal(await readFile(path.join(fixture.target, "keep.txt"), "utf8"), "keep");
      }
    } finally {
      await fixture.dispose();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "全modeはjunctionの検証先を拒否し、そのリンク先を変更しない"
// oracle = { type = "contract", ref = "Issue #855: コピー元と再利用データの意図しない破棄を防ぐ" }
// fault = "データmode分岐がreparse pointの拒否を迂回する"
// observable = "junction拒否エラー、外部操作eventが空、リンク先file保持"
// observation_boundary = "public-boundary"
// scope = "visual-check target path protection"
// lifecycle = "permanent"
// @end-test-value
test("all modes reject a junction target without touching its contents", windowsOnly, async () => {
  for (const mode of ["Fresh", "Reuse", "Copy"]) {
    const fixture = await createFixture();
    try {
      await mkdir(fixture.source);
      await writeFile(path.join(fixture.source, "keep.txt"), "keep");
      await symlink(fixture.source, fixture.target, "junction");
      const report = await fixture.run(mode);
      assert.match(report.error ?? "", /junction or symbolic link/);
      assert.deepEqual(report.events, []);
      assert.equal(await readFile(path.join(fixture.source, "keep.txt"), "utf8"), "keep");
    } finally {
      await fixture.dispose();
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Reuseは安全に停止できるprocessがなくlockfileが残る場合、lockと既存データを保持して起動を拒否する"
// oracle = { type = "contract", ref = "README.md#分離したvisual-check" }
// fault = "再利用modeでlock確認を省略するかlockを削除して二重起動する"
// observable = "lockエラー、launchなし、lockfileと保存fileの内容"
// observation_boundary = "public-boundary"
// scope = "visual-check Reuse lock protection"
// lifecycle = "permanent"
// impact = "使用中の検証データへの多重起動と破損を防ぐ"
// distinction = "reparse拒否やDB単体testとは独立した、既存directory再利用時のOS lock保護を実行する。既存10秒の待機上限を含む"
// @end-test-value
test("Reuse refuses an unidentified userData lock without deleting it", windowsOnly, async () => {
  const fixture = await createFixture();
  try {
    await mkdir(fixture.target);
    await writeFile(path.join(fixture.target, "lockfile"), "in use");
    await writeFile(path.join(fixture.target, "keep.txt"), "keep");
    const report = await fixture.run("Reuse");
    assert.match(report.error ?? "", /remains locked/);
    assert.deepEqual(report.events, ["npm run build", "process-scan"]);
    assert.equal(report.launch, null);
    assert.equal(await readFile(path.join(fixture.target, "lockfile"), "utf8"), "in use");
    assert.equal(await readFile(path.join(fixture.target, "keep.txt"), "utf8"), "keep");
  } finally {
    await fixture.dispose();
  }
});
