import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveOpenCodeEnvironment } from "../../src-electron/providers/opencode/opencode-environment.js";

// @test-value v2
// kind = "contract"
// claim = "native CLIのversionをDB path照会より先に検査し、既存環境を変更せずCLIが返すDB pathを利用する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "対応外CLIでDB処理を続ける、またはXDGやOPENCODE_DBをWithMate用設定へ置換する"
// observable = "実行command列、解決結果のDB pathと環境、対応外versionのrejectと照会数"
// observation_boundary = "public-boundary"
// scope = "OpenCode native CLI environment"
// lifecycle = "permanent"
// impact = "既存認証を利用できないか対応外versionで既存DBを変更する"
// distinction = "CLI応答はruntime境界であり型検査では検出できない。外部processなしで環境選択を検証する"
// @end-test-value
test("OpenCode checks the CLI version before resolving the unchanged native environment", async () => {
  const env = { OPENCODE_DB: "relative.sqlite", XDG_DATA_HOME: path.join(process.cwd(), "native-data"), OPENAI_API_KEY: "test-only-key" };
  const calls: string[][] = [];
  const databasePath = path.join(process.cwd(), "native-data", "opencode", "relative.sqlite");
  const result = await resolveOpenCodeEnvironment({ cwd: process.cwd(), executable: process.execPath, env }, {
    runCommand: async (_executable, args, options) => {
      calls.push([...args]);
      assert.deepEqual(options.env, env);
      return args[0] === "--version" ? "opencode v2.2.1\n" : databasePath + "\n";
    },
  });
  assert.deepEqual(calls, [["--version"], ["debug", "paths", "db"]]);
  assert.equal(result.databasePath, databasePath);
  assert.deepEqual(result.env, env);
  assert.notEqual(result.env, env);
  for (const version of ["opencode v2.1.4", "opencode v2.2.0", "opencode v2.2.2", "2.2.1", "invalid"]) {
    let count = 0;
    await assert.rejects(resolveOpenCodeEnvironment({ cwd: process.cwd(), executable: process.execPath }, {
      runCommand: async () => { count++; return version; },
    }), /2\.2\.1 is required/u);
    assert.equal(count, 1);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "DB pathはnative CLIの単一absolute出力だけを受け付け、abort済みの環境解決はcommandを実行しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "不正なCLI出力をDB排他keyに使うか取消後にCLIを実行する"
// observable = "不正pathのrejectとabort時のcommand呼出数"
// observation_boundary = "public-boundary"
// scope = "OpenCode environment subprocess response boundary"
// lifecycle = "permanent"
// impact = "DB排他の対象が実際のDBとずれるか取消済み操作が継続する"
// distinction = "外部文字列とAbortSignalのruntime保証をprocess起動なしで検証する"
// @end-test-value
test("OpenCode rejects invalid database announcements and pre-aborted lookup", async () => {
  for (const output of ["relative.sqlite", "", path.join(process.cwd(), "db") + "\nextra"]) {
    await assert.rejects(resolveOpenCodeEnvironment({ cwd: process.cwd(), executable: process.execPath }, {
      runCommand: async (_executable, args) => args[0] === "--version" ? "opencode v2.2.1" : output,
    }), /absolute database path/u);
  }
  let count = 0;
  await assert.rejects(resolveOpenCodeEnvironment({ cwd: process.cwd(), executable: process.execPath, signal: AbortSignal.abort() }, {
    runCommand: async () => { count++; return ""; },
  }), { name: "AbortError" });
  assert.equal(count, 0);
});

// @test-value v2
// kind = "contract"
// claim = "Windows PATHの公式npm native-bin shimだけを対応するCLI実行物へ解決し未知shimを迂回しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/902" }
// fault = "npm shimをshellで実行するか未知shimを別installの実行物へ置き換える"
// observable = "実行するabsolute native executableと未知shimのreject、command未実行"
// observation_boundary = "public-boundary"
// scope = "OpenCode Windows PATH resolution"
// lifecycle = "permanent"
// impact = "PCの選択したCLIを無視するかshell経由で想定外commandを実行する"
// distinction = "一時fixtureとfake commandでPATH探索の契約を検証し、実PCのCLIや認証へ接触しない"
// @end-test-value
test("OpenCode resolves the official npm shim but does not bypass unknown Windows commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-opencode-path-"));
  try {
    const packageRoot = path.join(root, "node_modules", "@opencode", "cli");
    await mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@opencode/cli", bin: { opencode: "./bin/opencode.exe" } }));
    const binary = path.join(packageRoot, "bin", "opencode.exe");
    await writeFile(binary, "fixture");
    const shim = path.join(root, "opencode.cmd");
    await writeFile(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n');
    let commands = 0;
    const runCommand = async (executable: string, args: readonly string[]) => {
      commands++;
      assert.equal(executable, await realpath(binary));
      return args[0] === "--version" ? "opencode v2.2.1" : path.join(root, "native.sqlite");
    };
    const result = await resolveOpenCodeEnvironment({ cwd: root, env: { Path: root } }, { platform: "win32", runCommand });
    assert.equal(result.executable, await realpath(binary));
    assert.equal(commands, 2);
    await writeFile(shim, '@echo off\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*\necho extra');
    await assert.rejects(resolveOpenCodeEnvironment({ cwd: root, env: { Path: root } }, { platform: "win32", runCommand }), /recognized official npm shim/u);
    assert.equal(commands, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
