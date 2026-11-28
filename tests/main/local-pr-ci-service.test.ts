import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { LocalPrCiService, type LocalPrCiOperation } from "../../src-electron/local-pr/local-pr-ci-service.js";
import { runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../../src-electron/platform/agent-runtime/runtime-turn-admission.js";
import type { LocalPrInput, LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";

const definition = (commands: string[]) => `version: 1\ncommands:\n${commands.map((command) => `  - ${JSON.stringify(command)}`).join("\n")}\n`;

/** 実際のリポジトリを作り、`.git` ディレクトリを仮定せずリンクされた worktree のパスを CI に渡す。 */
async function fixture(t: TestContext, minimumDataPathLength = 0) {
  const root = await mkdtemp(join(tmpdir(), "withmate & %CI_TEST_PATH% "));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  const data = join(root, "user data" + "x".repeat(Math.max(0, minimumDataPathLength - root.length - 10)));
  const original = join(root, "repository");
  const workspace = join(root, "worktree with spaces");
  await mkdir(data);
  await mkdir(original);
  // 本番の CI 準備処理に到達する前に、fixture の準備が `MAX_PATH` に引っかからないようにする。
  const git = (cwd: string, ...args: string[]) => execFileSync("git",
    [...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []), ...args],
    { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(original, "init", "--template=");
  git(original, "config", "user.name", "CI fixture");
  git(original, "config", "user.email", "ci@example.invalid");
  git(original, "config", "core.autocrlf", "false");
  await writeFile(join(original, "tracked.txt"), "base");
  git(original, "add", ".");
  git(original, "commit", "-m", "base");
  const base = git(original, "rev-parse", "HEAD");
  git(original, "worktree", "add", "-b", "fixture", workspace);
  const repository = { repositoryId: "repo fixture", workspacePath: workspace };
  const prId = randomUUID();
  const statuses: string[] = [];
  const service = new LocalPrCiService({ userDataPath: data, onChanged: (repo, pr) => statuses.push(`${repo}:${pr}`) });
  await service.initialize();
  t.after(() => service.shutdown());
  const makeVersion = (headCommit: string, version = 1, targetCommit = base): LocalPrVersion => ({
    headCommit, targetCommit, mergeBaseCommit: base, version, submittedAt: "fixture", submittedBy: { kind: "main", sessionId: "s", incarnationId: "i" },
  });
  const commit = async (source: string | Buffer, number = 1) => {
    await mkdir(join(workspace, ".withmate"), { recursive: true });
    await writeFile(join(workspace, ".withmate", "ci.yml"), source);
    git(workspace, "add", ".withmate/ci.yml");
    git(workspace, "commit", "-m", "CI definition");
    return makeVersion(git(workspace, "rev-parse", "HEAD"), number);
  };
  const run = <T extends LocalPrCiOperation>(version: LocalPrVersion, operation: T, extras: object = {}, owner = service) =>
    owner.execute(repository, prId, version, operation, { prId, version: version.version, ...extras } as LocalPrInput<T>);
  return { data, workspace, original, git, statuses, service, repository, prId, run, commit, base, makeVersion };
}

/** 操作の成功を検証し、戻り値の具体的な型を維持する。 */
function unwrap<T>(result: { ok: true; data: T } | { ok: false; message: string }): T {
  if (!result.ok) assert.fail(result.message);
  return result.data;
}

/** Git やネイティブシェルの起動時間を仮定せず、観測可能なサービスの状態を繰り返し確認する。 */
async function eventually<T>(get: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 220; attempt++) {
    const result = await get();
    if (result !== undefined) return result;
    await delay(50);
  }
  assert.fail("CI did not reach the expected state");
}

/** HEAD のみにある定義を独立したチェックアウトで実行し、未コミットのファイル、ref、インデックスを維持する。結果は正確な比較版とベースにひも付く。 */
test("CI runs fixed Git content and never reuses results for another version, base, repository or PR", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "verify.cjs"), `const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
if (fs.readFileSync('tracked.txt', 'utf8') !== 'base' || fs.existsSync('untracked.txt')) process.exit(7);
if (!fs.statSync('.git').isDirectory() || fs.existsSync('.git/objects/info/alternates')) process.exit(8);
if (execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim() !== '.git') process.exit(9);
fs.writeFileSync('tracked.txt', 'changed by CI');
console.log('fixed checkout: 日本語');\n`);
  await writeFile(join(f.workspace, "package.json"), JSON.stringify({ scripts: { verify: "node verify.cjs" } }));
  f.git(f.workspace, "add", "verify.cjs", "package.json");
  f.git(f.workspace, "commit", "-m", "reusable script");
  const config = definition([process.platform === "win32" ? "set CI_FIXTURE=yes" : "export CI_FIXTURE=yes", `node -e "if (process.env.CI_FIXTURE !== 'yes') process.exit(5)"`, process.platform === "win32" ? "npm.cmd run verify" : "npm run verify", "echo completed-after-npm"]);
  const v1 = await f.commit(config);
  const v2 = await f.commit(definition([`node -e "process.exit(42)"`, "echo must-not-run"]), 2);
  await writeFile(join(f.workspace, ".withmate", "ci.yml"), "invalid working tree YAML\n");
  await writeFile(join(f.workspace, "tracked.txt"), "staged");
  f.git(f.workspace, "add", "tracked.txt");
  await writeFile(join(f.workspace, "tracked.txt"), "unstaged");
  await writeFile(join(f.workspace, "untracked.txt"), "untracked");
  const before = f.git(f.workspace, "status", "--porcelain");
  const checked = unwrap(await f.run(v1, "pr_ci_validate"));
  assert.equal(checked.source, config);
  assert.equal(checked.state, "valid");
  const started = unwrap(await f.run(v1, "pr_ci_start"));
  assert.equal(started.state, "running");
  const end = await eventually(async () => unwrap(await f.run(v1, "pr_ci_list")).runs.find((item) => item.state !== "running"));
  assert.equal(end.state, "succeeded", end.error ?? "CI should succeed");
  assert.equal(end.headCommit, v1.headCommit);
  assert.equal(end.targetCommit, v1.targetCommit);
  const log = unwrap(await f.run(v1, "pr_ci_log", { runId: started.id })).log;
  assert.match(log, /fixed checkout: 日本語/u);
  assert.match(log, /completed-after-npm/u);
  assert.deepEqual(unwrap(await f.run(v2, "pr_ci_list")).runs, []);
  assert.deepEqual(unwrap(await f.run({ ...v1, targetCommit: v2.headCommit }, "pr_ci_list")).runs, []);
  assert.deepEqual(unwrap(await f.run({ ...v1, mergeBaseCommit: v2.headCommit }, "pr_ci_list")).runs, []);
  assert.deepEqual(unwrap(await f.service.execute({ ...f.repository, repositoryId: "another" }, f.prId, v1, "pr_ci_list", { prId: f.prId, version: 1 })).runs, []);
  const other = randomUUID();
  assert.deepEqual(unwrap(await f.service.execute(f.repository, other, v1, "pr_ci_list", { prId: other, version: 1 })).runs, []);
  assert.equal((await f.run(v2, "pr_ci_log", { runId: started.id })).ok, false);
  const failed = unwrap(await f.run(v2, "pr_ci_start"));
  const failedEnd = await eventually(async () => unwrap(await f.run(v2, "pr_ci_list")).runs.find((item) => item.state !== "running"));
  assert.equal(failedEnd.state, "failed");
  assert.equal(failedEnd.exitCode, 42);
  assert.doesNotMatch(unwrap(await f.run(v2, "pr_ci_log", { runId: failed.id })).log, /must-not-run/u);
  const rerun = unwrap(await f.run(v1, "pr_ci_rerun", { runId: started.id }));
  assert.notEqual(rerun.id, started.id);
  await eventually(async () => unwrap(await f.run(v1, "pr_ci_list")).runs.find((item) => item.id === rerun.id && item.state === "succeeded"));
  assert.equal(f.git(f.workspace, "status", "--porcelain"), before);
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), v2.headCommit);
  assert.equal(f.git(f.workspace, "show", ":tracked.txt"), "staged");
  assert.equal(await readFile(join(f.workspace, "tracked.txt"), "utf8"), "unstaged");
  assert.equal(await readFile(join(f.workspace, "untracked.txt"), "utf8"), "untracked");
  assert.ok(f.statuses.length >= 6);
});

/** 安全な YAML のサブセットは曖昧な構文や危険な構文を拒否し、無効・未設定・成功の各状態を混同しない。 */
test("CI validates only an ordinary pinned UTF-8 blob with supported YAML", async (t) => {
  const f = await fixture(t);
  assert.equal(unwrap(await f.run(f.makeVersion(f.base), "pr_ci_validate")).state, "not_configured");
  const invalid = [
    "version: 1\nversion: 1\ncommands: [echo ok]\n",
    "version: 1\ncommands: [&x echo ok, *x]\n",
    "version: 1\ncommands: [!!str echo ok]\n",
    "version: 1\ncommands: [echo ok]\nunknown: true\n",
    "version: 1\ncommands: [true]\n",
    "version: 1\ncommands: []\n",
    "version: 1\ncommands:\n  - |\n    echo multiple\n    echo lines\n",
    "version: 1\ncommands: [echo a]\n---\nversion: 1\ncommands: [echo b]\n",
    Buffer.from([0xc3, 0x28]),
    "#".repeat(65_537),
  ];
  for (const [index, source] of invalid.entries()) {
    const v = await f.commit(source, index + 1);
    assert.equal(unwrap(await f.run(v, "pr_ci_validate")).state, "invalid", `case ${index}`);
    assert.equal((await f.run(v, "pr_ci_start")).ok, false);
  }
  const blob = f.git(f.workspace, "hash-object", "-w", "tracked.txt");
  f.git(f.workspace, "update-index", "--cacheinfo", `120000,${blob},.withmate/ci.yml`);
  f.git(f.workspace, "commit", "-m", "symlink definition");
  const link = f.makeVersion(f.git(f.workspace, "rev-parse", "HEAD"), 30);
  assert.equal(unwrap(await f.run(link, "pr_ci_validate")).state, "invalid");
});

/** 同じ固定 CI 識別情報なら、Session がより深いディレクトリにあっても別の定義を選んではならない。 */
test("CI validates, starts and reruns only the repository-root definition from root and worktree subdirectories", async (t) => {
  const f = await fixture(t);
  const sub = join(f.workspace, "sub");
  await mkdir(join(sub, ".withmate"), { recursive: true });
  await writeFile(join(sub, ".withmate", "ci.yml"), definition(["echo nested-definition"]));
  f.git(f.workspace, "add", "sub");
  f.git(f.workspace, "commit", "-m", "nested CI lookalike");
  const nestedOnly = f.makeVersion(f.git(f.workspace, "rev-parse", "HEAD"));
  const source = definition(["echo root-definition"]);
  const v = await f.commit(source, 2);
  f.git(f.original, "checkout", "--detach", v.headCommit);

  const paths = [f.original, join(f.original, "sub"), sub];
  const run = <T extends LocalPrCiOperation>(workspacePath: string, version: LocalPrVersion, operation: T, extras: object = {}) =>
    f.service.execute({ ...f.repository, workspacePath }, f.prId, version, operation,
      { prId: f.prId, version: version.version, ...extras } as LocalPrInput<T>);
  let previousRunId: string | undefined;
  for (const workspacePath of paths) {
    const checked = unwrap(await run(workspacePath, v, "pr_ci_validate"));
    assert.equal(checked.state, "valid", workspacePath);
    assert.equal(checked.source, source, workspacePath);
    assert.equal(unwrap(await run(workspacePath, nestedOnly, "pr_ci_validate")).state, "not_configured", workspacePath);
    const started = unwrap(previousRunId
      ? await run(workspacePath, v, "pr_ci_rerun", { runId: previousRunId })
      : await run(workspacePath, v, "pr_ci_start"));
    const end = await eventually(async () => unwrap(await f.run(v, "pr_ci_list")).runs.find((item) => item.id === started.id && item.state !== "running"));
    assert.equal(end.state, "succeeded", end.error ?? workspacePath);
    const output = unwrap(await f.run(v, "pr_ci_log", { runId: started.id })).log;
    assert.match(output, /root-definition/u);
    assert.doesNotMatch(output, /nested-definition/u);
    previousRunId = started.id;
  }
});

/** `userData` が深くても Git オブジェクトストアのパスは長くならず、長いソースパスのファイルもチェックアウトできる。 */
test("Windows CI runs a fixed submission with deep userData and tracked paths beyond MAX_PATH", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t, 180);
  const directory = `${"d".repeat(124)}/${"e".repeat(124)}`;
  const path = `${directory}/pinned.txt`;
  await mkdir(join(f.workspace, directory), { recursive: true });
  await writeFile(join(f.workspace, path), "pinned content");
  f.git(f.workspace, "add", path);
  f.git(f.workspace, "commit", "-m", "deep tracked path");
  const v = await f.commit(definition([`node -e "const fs=require('node:fs'); if (fs.readFileSync('${path}','utf8') !== 'pinned content') process.exit(7); console.log(process.cwd())"`]));
  await writeFile(join(f.workspace, path), "uncommitted edit");
  const before = f.git(f.workspace, "status", "--porcelain");
  const started = unwrap(await f.run(v, "pr_ci_start"));
  const end = await eventually(async () => unwrap(await f.run(v, "pr_ci_list")).runs.find((item) => item.id === started.id && item.state !== "running"));
  assert.equal(end.state, "succeeded", end.error ?? "Git must prepare the long checkout");
  const checkout = unwrap(await f.run(v, "pr_ci_log", { runId: started.id })).log.trim();
  assert.ok(join(checkout, path).length > 260, "fixture must exceed legacy MAX_PATH");
  assert.ok(!checkout.startsWith(f.data + "\\"), "working copy must not be nested under deep userData");
  await assert.rejects(lstat(checkout), { code: "ENOENT" });
  assert.equal(f.git(f.workspace, "rev-parse", "HEAD"), v.headCommit);
  assert.equal(f.git(f.workspace, "status", "--porcelain"), before);
  assert.equal(await readFile(join(f.workspace, path), "utf8"), "uncommitted edit");
  const restarted = new LocalPrCiService({ userDataPath: f.data });
  assert.deepEqual(unwrap(await f.run(v, "pr_ci_list", {}, restarted)).runs, [end]);
  assert.equal(unwrap(await f.run(v, "pr_ci_log", { runId: started.id }, restarted)).log.trim(), checkout);
});

/** ネイティブシェルが長時間動く子プロセスを実際に実行するまで待つ。 */
async function runningPid(f: Awaited<ReturnType<typeof fixture>>, v: LocalPrVersion, id: string): Promise<number> {
  return eventually(async () => {
    const match = /owned-child:(\d+)/u.exec(unwrap(await f.run(v, "pr_ci_log", { runId: id })).log);
    return match ? Number(match[1]) : undefined;
  });
}

/** キャンセルとアプリの正常終了は、最終状態を公開する前に管理下の子プロセスを終了する。 */
test("cancel and application shutdown stop the running command", async (t) => {
  const f = await fixture(t);
  const v = await f.commit(definition([`node -e "console.log('owned-child:'+process.pid);setInterval(()=>{},1000)"`, "echo must-not-run"]));
  const first = unwrap(await f.run(v, "pr_ci_start"));
  const child = await runningPid(f, v, first.id);
  const canceled = unwrap(await f.run(v, "pr_ci_cancel", { runId: first.id }));
  assert.equal(canceled.state, "canceled", canceled.error ?? "CI should be canceled");
  assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  assert.doesNotMatch(unwrap(await f.run(v, "pr_ci_log", { runId: first.id })).log, /must-not-run/u);
  const next = unwrap(await f.run(v, "pr_ci_rerun", { runId: first.id }));
  await runningPid(f, v, next.id);
  await f.service.shutdown();
  const restarted = new LocalPrCiService({ userDataPath: f.data });
  assert.equal(unwrap(await f.run(v, "pr_ci_list", {}, restarted)).runs.find(({ id }) => id === next.id)?.state, "interrupted");
  assert.equal(unwrap(await f.run(v, "pr_ci_list", {}, restarted)).runs.find(({ id }) => id === first.id)?.state, "canceled");
});

/** 遅延した変更操作は、binding が失効していれば CI の予約も停止もせずに拒否する。受理済みの処理は開始元の Turn が終わっても続く。 */
test("CI rechecks captured runtime Turn admission only before start, rerun and cancellation effects", async (t) => {
  const f = await fixture(t);
  const v = await f.commit(definition([`node -e "console.log('owned-child:'+process.pid);setInterval(()=>{},1000)"`]));
  const inactive = (error: unknown) => error instanceof RuntimeTurnInactiveError && error.effect === "none";
  const state = () => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const deactivate = (captured: SharedArrayBuffer) => Atomics.store(new Int32Array(captured), 0, 1);

  // `initialize()` は解決済みなので、先に操作を再開させ、結果を待つ Git の検索を開始させる。
  const staleStart = state();
  const pendingStart = runWithRuntimeTurnAdmission({ state: staleStart }, () => f.run(v, "pr_ci_start"));
  queueMicrotask(() => deactivate(staleStart));
  await assert.rejects(pendingStart, inactive);
  assert.deepEqual(unwrap(await f.run(v, "pr_ci_list")).runs, []);

  const creator = state();
  const accepted = unwrap(await runWithRuntimeTurnAdmission({ state: creator }, () => f.run(v, "pr_ci_start")));
  deactivate(creator);
  const pid = await runningPid(f, v, accepted.id);
  const staleCancel = state();
  const pendingCancel = runWithRuntimeTurnAdmission({ state: staleCancel }, () => f.run(v, "pr_ci_cancel", { runId: accepted.id }));
  deactivate(staleCancel);
  await assert.rejects(pendingCancel, inactive);
  assert.equal(unwrap(await f.run(v, "pr_ci_list")).runs[0]?.state, "running");
  assert.equal(process.kill(pid, 0), true);

  const canceled = unwrap(await runWithRuntimeTurnAdmission({ state: state() }, () => f.run(v, "pr_ci_cancel", { runId: accepted.id })));
  assert.equal(canceled.state, "canceled");
  const staleRerun = state();
  const pendingRerun = runWithRuntimeTurnAdmission({ state: staleRerun }, () => f.run(v, "pr_ci_rerun", { runId: accepted.id }));
  queueMicrotask(() => deactivate(staleRerun));
  await assert.rejects(pendingRerun, inactive);
  assert.deepEqual(unwrap(await f.run(v, "pr_ci_list")).runs, [canceled]);
});

/** 後続コマンドを飛ばして正常終了しても、CI 実行の成功とはみなさない。 */
test("early zero exit does not report success", async (t) => {
  const f = await fixture(t);
  const v = await f.commit(definition(["exit 0", "echo must-not-run"]));
  const run = unwrap(await f.run(v, "pr_ci_start"));
  const end = await eventually(async () => unwrap(await f.run(v, "pr_ci_list")).runs.find((item) => item.state !== "running"));
  assert.equal(end.state, "failed");
  assert.match(end.error ?? "", /before completing/u);
  assert.doesNotMatch(unwrap(await f.run(v, "pr_ci_log", { runId: run.id })).log, /must-not-run/u);
});

/** 実際に強制終了したときは、終端結果を作らず、復旧に使う実行中の記録を残す。 */
test("startup recovers an interrupted Windows CI process and retains its log", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const temp = join(f.data, "temp");
  await mkdir(temp);
  const v = await f.commit(definition([`node -e "console.log('owned-child:'+process.pid+':'+process.env.WITHMATE_CI_WORK);setInterval(()=>{},1000)"`]));
  const entry = new URL("../../src-electron/local-pr/local-pr-ci-service.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { LocalPrCiService } from ${JSON.stringify(entry)};
    const service = new LocalPrCiService({userDataPath:${JSON.stringify(f.data)}});
    const result = await service.execute(${JSON.stringify(f.repository)}, ${JSON.stringify(f.prId)}, ${JSON.stringify(v)}, 'pr_ci_start', ${JSON.stringify({ prId: f.prId, version: v.version })});
    if (!result.ok) throw new Error(result.message);
  `], { windowsHide: true, stdio: "pipe", env: { ...process.env, TEMP: temp, TMP: temp } });
  const exit = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => { child.kill(); await exit; });
  const history = join(f.data, "local-pr-ci", "runs");
  const live = await eventually(async () => {
    if (child.exitCode !== null) assert.fail(stderr || "CI host exited before its command ran");
    const [id] = await readdir(history);
    if (!id) return undefined;
    const log = await readFile(join(history, id, "output.log"), "utf8").catch(() => "");
    const match = /owned-child:(\d+):([^\r\n]+)/u.exec(log);
    return match ? { id, pid: Number(match[1]), work: match[2] } : undefined;
  });
  child.kill();
  await exit;
  await eventually(async () => {
    try { process.kill(live.pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return true;
    }
  });
  const restarted = new LocalPrCiService({ userDataPath: f.data });
  assert.equal(unwrap(await f.run(v, "pr_ci_list", {}, restarted)).runs[0]?.state, "interrupted");
  assert.match(unwrap(await f.run(v, "pr_ci_log", { runId: live.id }, restarted)).log, /owned-child:/u);
  assert.ok(live.work.startsWith(join(temp, "withmate-pr-ci-")));
  assert.ok((await lstat(live.work)).isDirectory());
});
