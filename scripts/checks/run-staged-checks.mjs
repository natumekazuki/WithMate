import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Git 標準のコマンドで検査対象を選び、失敗時は後続の検査を起動しない。 */
const git = (args, options) => execFileSync("git", args, { encoding: "utf8", ...options });

const root = git(["rev-parse", "--show-toplevel"]).trim();
process.chdir(root);
git(["diff", "--cached", "--check"], { stdio: "inherit" });

if (!git(["diff", "--cached", "--name-only", "-z", "--", ":(exclude,glob)**/*.md"])) {
  console.log("検査対象なし: ステージ済み差分がないか、Markdown の変更のみです。");
} else {
  const tree = git(["write-tree"]).trim();
  const temporary = mkdtempSync(join(tmpdir(), "wm-staged-"));
  const snapshot = join(temporary, "tree");
  try {
    // Git に index の展開を任せ、作業ツリーのファイルや stash を変更しない。
    mkdirSync(snapshot);
    const index = { ...process.env, GIT_INDEX_FILE: join(temporary, "index"), GIT_ATTR_SOURCE: tree };
    git(["read-tree", tree], { env: index });
    git(["checkout-index", "--all", "--ignore-skip-worktree-bits", "--prefix=" + snapshot.replaceAll("\\", "/") + "/"], { env: index });
    symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    const env = { ...process.env };
    for (const key of git(["rev-parse", "--local-env-vars"]).trim().split(/\s+/)) delete env[key];
    delete env.NODE_TEST_CONTEXT;
    const options = { cwd: snapshot, env, stdio: "inherit" };
    // lint は CI と同じ npm コマンド、テスト選択は Git の pathspec と Node の runner を使う。
    execFileSync(process.execPath, [process.env.npm_execpath, "run", "lint"], options);
    const changedTests = git(["diff", "--cached", "--diff-filter=ACMRT", "--name-only", "-z", "--",
      ":(glob)tests/**/*.test.ts", ":(glob)tests/**/*.test.tsx"], { env: index }).split("\0").filter(Boolean);
    const tests = [...new Set(["tests/cli/package-config.test.ts", "tests/main/managed-glossary-skill-service.test.ts", ...changedTests])];
    execFileSync(process.execPath, tests.length > 100
      ? [process.env.npm_execpath, "test"]
      : ["--import", "tsx", "--test", "--test-concurrency=4", ...tests], options);
    if (git(["write-tree"]).trim() !== tree) throw new Error("検証中にステージ内容が変わりました。再実行してください。");
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
