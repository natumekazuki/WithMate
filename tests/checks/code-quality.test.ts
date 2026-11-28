import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const rulesModule = new URL("../../scripts/checks/comment-rules.mjs", import.meta.url);
/** 比較に使う規則・識別子と利用者向けの行番号を保持する。 */
type Finding = { key: string; rule: string; line: number };
const { inspectComments, addedFindings } = await import(rulesModule.href) as {
  /** 指定ソースの違反を一覧にする。 */
  inspectComments(file: string, source: string): Promise<Finding[]>;
  /** 比較元に存在しなかった違反を返す。 */
  addedFindings(previous: Finding[], current: Finding[]): Finding[];
};

/** 宣言・テストと制御構文に結び付いた説明だけが、構文検査を通ることを確認する。 */
test("コメント検査は宣言・node:test 呼び出し・制御構文の位置と形式を判定する", async () => {
  const valid = [
    'import { test as verify } from "node:test";',
    "/** 作成済み項目を一覧に追加する。 */",
    "class Registry {",
    "  /** 非公開の追加処理。重複は一覧に追加しない。 */",
    "  private add(key: string) {",
    "    // 登録済みの項目は現在の値を返す。",
    '    if (key === "ready") return known;',
    "    else {",
    "      // 未登録の項目が利用できるまで作成を試みる。",
    "      while (pending()) {",
    "        // 作成の失敗を別の結果へ変換する。",
    "        try { create(key); }",
    "        catch { /* 作成できなかったキーを記録する。 */ record(key); }",
    "        finally { /* 使用したハンドルを解放する。 */ release(); }",
    "      }",
    "    }",
    "  }",
    "}",
    "/** 未登録キーが取得できることを確認する。 */",
    'verify("create", (t) => {',
    "  /** 同じ条件で登録済みの場合は重複しない。 */",
    '  t.test("duplicate", async () => {});',
    "});",
  ].join("\n");
  assert.deepEqual(await inspectComments("tests/example.test.ts", valid), []);

  // 本来の位置にない同じ文字列では、枝やテストの説明にはならない。
  const invalid = valid
    .replace("  /** 非公開の追加処理。重複は一覧に追加しない。 */", "  /** @param key キー */")
    .replace("      // 未登録の項目が利用できるまで作成を試みる。", "      // TODO: 手順を説明する。")
    .replace("        // 作成の失敗を別の結果へ変換する。", '        trace("// 失敗を記録する。");')
    .replace("/* 作成できなかったキーを記録する。 */", "/* eslint-disable 理由 */")
    .replace("  /** 同じ条件で登録済みの場合は重複しない。 */", "  // 同じ条件で登録済みの場合は重複しない。");
  const violations = await inspectComments("tests/example.test.ts", invalid);
  assert.deepEqual(violations.map(({ rule }) => rule).sort(), ["jsdoc", "jsdoc", "例外処理", "例外処理", "分岐", "反復"]);
});

/** ネストした説明は外側の直線処理を区切らず、既存違反の許容件数を増やさない。 */
test("同じブロックの段落上限と既存違反の繰越しを判定する", async () => {
  const body = Array.from({ length: 13 }, (_, index) => "  steps.push(" + index + ");");
  const before = "/** 手順を順に進める。 */\nexport function walk() {\n" + body.join("\n") + "\n}";
  const withNested = before.replace("steps.push(3)", "invoke(() => { /* 内側の処理。 */ steps.push(3); })");
  const withIntro = before.replace("  steps.push(7);", "  // 残りの処理を進める。\n  steps.push(7);");
  const original = await inspectComments("example.ts", before);
  assert.deepEqual(original.map(({ rule }) => rule), ["段落"]);
  assert.deepEqual((await inspectComments("example.ts", withNested)).map(({ rule }) => rule), ["段落"]);
  assert.deepEqual(await inspectComments("example.ts", withIntro), []);
  assert.deepEqual(addedFindings(original, await inspectComments("example.ts", "\n" + before)), []);
  const duplicate = await inspectComments("example.ts", before + "\n" + before.replace("function walk", "function repeat"));
  assert.equal(addedFindings(original, duplicate).length, 1);
});

/** 説明の翻訳は許可するが、英語だった説明を削っただけでは翻訳と同じ結果にしない。 */
test("既存の英語JSDocを消すと欠落を新しい違反として検出する", async () => {
  const declaration = "export function answer() { return 42; }\n";
  const earlier = await inspectComments("example.ts", "/** Returns the answer. */\n" + declaration);
  const removed = await inspectComments("example.ts", declaration);
  const translated = await inspectComments("example.ts", "/** 答えを返す。 */\n" + declaration);
  assert.deepEqual(earlier.map(({ rule }) => rule), ["jsdoc-language"]);
  assert.deepEqual(addedFindings(earlier, removed).map(({ rule }) => rule), ["jsdoc"]);
  assert.deepEqual(addedFindings(earlier, translated), []);
});

/** 段落説明を翻訳しただけで、場所が動いた既存の無説明区間を新規違反にしない。 */
test("段落の識別子を報告行に依存させない", async () => {
  const steps = Array.from({ length: 32 }, (_, index) => "  steps.push(" + index + ");");
  steps.splice(8, 0, "  // Starts the second stage.");
  const before = "/** 手順を順に進める。 */\nfunction walk() {\n" + steps.join("\n") + "\n}";
  const translated = before.replace("Starts the second stage.", "次の処理段落を開始する。");
  const earlier = await inspectComments("example.ts", before);
  const after = await inspectComments("example.ts", translated);
  assert.equal(earlier.length, 2);
  assert.equal(after.length, 1);
  assert.notEqual(earlier[0].line, after[0].line);
  assert.deepEqual(addedFindings(earlier, after), []);
});

/** 指定された一時 repository でコマンドを実行し、hook の stdout と stderr を合わせて返す。 */
function command(cwd: string, name: string, ...args: string[]) {
  const result = spawnSync(name, args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

/** 実 hook が index の内容だけで判定し、違反・テスト失敗で HEAD を進めないことを確認する。 */
test("Git hook は staged を検証し、空・rename・削除を区別して失敗を伝える", () => {
  const fixture = mkdtempSync(join(tmpdir(), "wm-hook-test-"));
  // 失敗する入力が index に残る場合も、テスト用の作業領域だけを後で回収する。
  try {
    // コミットの成否を、環境のユーザー設定や元の repository の状態から切り離す。
    /** 設定を保存せず、一時 repository 内で Git を呼ぶ。 */
    const git = (...args: string[]) => command(fixture, "git", "-c", "user.name=WithMate Test", "-c", "user.email=test@example.invalid", ...args);
    /** 準備の Git コマンドはすべて成功する必要がある。 */
    const must = (...args: string[]) => {
      const result = git(...args);
      assert.equal(result.status, 0, result.output);
      return result.output.trim();
    };
    /** 一時 repository だけに検査用ソースを書き込む。 */
    const write = (path: string, contents: string) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), contents);
    };
    /** 明示した hook を使うコミット。設定はこの呼び出しだけに適用する。 */
    const commit = (...args: string[]) => git("-c", "core.hooksPath=.githooks", "commit", "-m", "test commit", ...args);
    must("init", "-q", "--template=");
    for (const path of [".githooks/pre-commit", "scripts/checks/check-quality.mjs", "scripts/checks/comment-rules.mjs"]) {
      // 実際に配布する hook と検査本体を差し替えずに使用する。
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      copyFileSync(join(repository, path), join(fixture, path));
    }
    symlinkSync(resolve(repository, "node_modules"), join(fixture, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    write(".gitignore", "node_modules/\n");
    write("package.json", '{"type":"module"}\n');
    write("tests/checks/code-quality.test.ts", 'import {test} from "node:test";\n/** 検査用の空の正常例。 */\ntest("fixture", () => {});\n');
    write("tests/cli/package-config.test.ts", [
      'import assert from "node:assert/strict";',
      'import {readFileSync} from "node:fs";',
      'import {test} from "node:test";',
      "/** ステージされた値以外を読み取ると失敗する。 */",
      'test("smoke", () => assert.equal(readFileSync("value.txt", "utf8"), "good"));',
      "",
    ].join("\n"));
    write("legacy.ts", "export function legacy() { return 1; }\n");
    write("value.txt", "good");
    must("add", ".");
    must("update-index", "--chmod=+x", ".githooks/pre-commit");
    must("commit", "-qm", "baseline");
    const before = must("rev-parse", "HEAD");

    // 作業ツリーだけ直しても、ステージ済みの違反でコミットが止まる。
    write("new.ts", "export function sample() { return 1; }\n");
    must("add", "new.ts");
    write("new.ts", "/** 固定値を返す。 */\nexport function sample() { return 1; }\n");
    const rejected = commit();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.output, /new\.ts:1:.*JSDoc/);
    assert.doesNotMatch(rejected.output, /ステージ済みテスト/);
    assert.equal(must("rev-parse", "HEAD"), before);

    // ステージだけ直しても、未ステージの破損・失敗データには影響されない。
    must("add", "new.ts");
    write("new.ts", "syntax damage }\n");
    write("value.txt", "bad unstaged");
    const good = commit();
    assert.equal(good.status, 0, good.output);
    assert.match(good.output, /ステージ済みテスト/);
    assert.equal(readFileSync(join(fixture, "value.txt"), "utf8"), "bad unstaged");
    assert.equal(readFileSync(join(fixture, "new.ts"), "utf8"), "syntax damage }\n");

    // 同じテストのステージ済みデータを壊すと、lint 通過後にテストで止まる。
    must("add", "value.txt");
    must("mv", "legacy.ts", "renamed legacy.ts");
    const beforeTestFailure = must("rev-parse", "HEAD");
    const bad = commit();
    assert.notEqual(bad.status, 0, bad.output);
    assert.match(bad.output, /ステージ済みテスト/);
    assert.match(bad.output, /bad unstaged/);
    assert.equal(must("rev-parse", "HEAD"), beforeTestFailure);

    // rename と削除は旧違反を新規追加と見なさず、空コミットは検査対象なしと報告する。
    write("value.txt", "good");
    must("add", "value.txt");
    const renamed = commit();
    assert.equal(renamed.status, 0, renamed.output);
    write("new.ts", "/** 固定値を返す。 */\nexport function sample() { return 1; }\n");
    must("rm", "new.ts");
    const deleted = commit();
    assert.equal(deleted.status, 0, deleted.output);
    const empty = commit("--allow-empty");
    assert.equal(empty.status, 0, empty.output);
    assert.match(empty.output, /検査対象なし/);
  } finally {
    // テストが作った一時 repository だけを削除する。
    rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
  }
});
