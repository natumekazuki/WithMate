import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listTestFiles, selectShard } from "../checks/test-files.js";

const runnerPath = fileURLToPath(new URL("../checks/run-tests.ts", import.meta.url));

function createFixture(): string {
  return mkdtempSync(path.join(os.tmpdir(), "withmate test runner "));
}

function writeFixture(root: string, name: string, text = ""): void {
  const filePath = path.join(root, name);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(root: string, args: string[] = []) {
  // Child runners must not inherit a parent node:test context or CI shard selection.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_SHARD_INDEX;
  delete env.TEST_SHARD_TOTAL;
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), runnerPath, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

// @test-value v2
// kind = "invariant"
// claim = "通常列挙は両test rootの深いTS/TSXを一度ずつpath順に含め、helperと非testを実行対象にしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/730" }
// fault = "直下だけを走査する、拡張子を片方だけ拾う、helperまでtestにする"
// observable = "fixture rootから列挙された相対pathとbyte size"
// observation_boundary = "public-boundary"
// scope = "test-file-discovery"
// lifecycle = "permanent"
// @end-test-value
test("discovers nested TS and TSX tests in deterministic path order", () => {
  const root = createFixture();
  try {
    writeFixture(root, "tests/renderer/deep/z.test.tsx", "xyz");
    writeFixture(root, "scripts/tests/a.test.ts", "ab");
    writeFixture(root, "tests/main/a.test.ts", "a");
    writeFixture(root, "tests/support/helper.ts");
    writeFixture(root, "tests/main/not.test.js");
    writeFixture(root, "src/ignored.test.ts");
    assert.deepEqual(listTestFiles(root), [
      { relativePath: "scripts/tests/a.test.ts", size: 2 },
      { relativePath: "tests/main/a.test.ts", size: 1 },
      { relativePath: "tests/renderer/deep/z.test.tsx", size: 3 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "全shardの和集合は通常集合と一致し、重複・漏れがなく入力列挙順にも依存しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/730" }
// fault = "同サイズの並べ替えやbucket選択によりtestが重複・脱落する"
// observable = "各shardの選択path、全shardを連結した集合と件数"
// observation_boundary = "public-boundary"
// scope = "test-shard-selection"
// lifecycle = "permanent"
// @end-test-value
test("partitions the complete collection exactly once with stable ties", () => {
  const files = [8, 8, 7, 5, 3, 1].map((size, index) => ({ relativePath: `tests/${index}.test.ts`, size }));
  for (const total of [1, 2, 3, 8]) {
    const shards = Array.from({ length: total }, (_, index) => selectShard(files, { index: index + 1, total }));
    assert.deepEqual(shards.flat().map((file) => file.relativePath).sort(), files.map((file) => file.relativePath));
    for (const [index, shard] of shards.entries()) {
      assert.deepEqual(selectShard([...files].reverse(), { index: index + 1, total }), shard);
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "通常runnerと全shardは列挙したTS/TSXを実際に実行し、不正なshard指定を失敗として返す"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/730" }
// fault = "listだけ正しく実行から階層testが落ちる、または不正指定を成功扱いする"
// observable = "runner subprocessのlist JSON、Node test runnerの実行件数、exit status"
// observation_boundary = "consumer"
// scope = "test-runner-cli"
// lifecycle = "permanent"
// @end-test-value
test("normal and shard CLI execute the same nested test collection", () => {
  const root = createFixture();
  const expected = ["scripts/tests/first.test.ts", "tests/renderer/nested/second.test.tsx"];
  const titleByPath = new Map(expected.map((name) => [name, `fixture execution: ${name}`]));
  try {
    for (const name of expected) {
      writeFixture(root, name, `import test from 'node:test'; test(${JSON.stringify(titleByPath.get(name))}, () => {});\n`);
    }
    const normal = run(root, ["--list"]);
    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(JSON.parse(normal.stdout), expected);
    const shardPaths: string[] = [];
    for (const shard of ["1/2", "2/2"]) {
      const listed = run(root, [`--shard=${shard}`, "--list"]);
      assert.equal(listed.status, 0, listed.stderr);
      shardPaths.push(...JSON.parse(listed.stdout));
      const executed = run(root, [`--shard=${shard}`, "--test-reporter=tap"]);
      assert.equal(executed.status, 0, executed.stdout + executed.stderr);
      const selected = JSON.parse(listed.stdout) as string[];
      assert.equal(selected.length, 1);
      assert.match(executed.stdout, new RegExp(`fixture execution: ${escapeRegExp(selected[0])}`));
      const omitted = expected.find((name) => !selected.includes(name));
      assert.ok(omitted);
      assert.doesNotMatch(executed.stdout, new RegExp(`fixture execution: ${escapeRegExp(omitted)}`));
      assert.match(executed.stdout, /# tests 1\b/);
    }
    assert.deepEqual(shardPaths.sort(), expected);
    const executed = run(root, ["--test-reporter=tap"]);
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /# tests 2\b/);
    for (const shard of ["0/2", "3/2", "1/0", "1/2/3", "1x/2"]) {
      const invalid = run(root, [`--shard=${shard}`, "--list"]);
      assert.notEqual(invalid.status, 0, invalid.stdout + invalid.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "testの失敗とtestがない場合をrunnerがexit成功へ変換しない"
// oracle = { type = "contract", ref = "AGENTS.md#Testing" }
// fault = "子processの非zero終了や空集合を親runnerが成功扱いする"
// observable = "空fixtureと失敗test実行時のsubprocess exit statusとfailure出力"
// observation_boundary = "consumer"
// scope = "test-runner-failure-propagation"
// lifecycle = "permanent"
// @end-test-value
test("propagates failing tests and rejects an empty collection", () => {
  const root = createFixture();
  try {
    const empty = run(root);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /No test files selected/);
    writeFixture(root, "tests/failure.test.ts", "import test from 'node:test'; test('intentional failure', () => { throw new Error('fixture failure'); });\n");
    const failed = run(root, ["--test-reporter=tap"]);
    assert.notEqual(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, /fixture failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
