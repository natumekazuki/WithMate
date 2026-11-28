import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runner = "scripts/checks/check-quality.mjs";
const rules = "scripts/checks/comment-rules.mjs";
const qualityTest = "tests/checks/code-quality.test.ts";
const smokeTest = "tests/cli/package-config.test.ts";
const testPattern = /^tests\/.+\.test\.tsx?$/;

/** 子プロセスの異常終了も検証失敗として扱い、標準出力を必要な呼び出しにだけ返す。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  // 起動自体に失敗した場合は、子の終了コードとして扱わない。
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // 出力を受け取れない検査でも、終了コードかシグナルを表示する。
    throw new Error(`${command} ${args[0]}: ${result.stderr?.toString().trim() || result.signal || `終了コード ${result.status}`}`);
  }
  return result.stdout;
}

/** Git のパスを shell で展開せず、空白や非 ASCII 名をそのまま扱う。 */
function git(args, options = {}) {
  return run("git", args, options);
}

/** コミット・tree を解決し、検査中は参照名ではなく解決済みの tree を使用する。 */
function tree(ref) {
  return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]).toString().trim();
}

/** HEAD が未作成の場合だけ、初回コミットの比較元を空 tree にする。 */
function headTree() {
  const head = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { encoding: "utf8" });
  // Git を起動できない場合は初回コミットと見なさない。
  if (head.error) throw head.error;
  // 通常時は既存 HEAD の tree を比較元にする。
  if (head.status === 0) return head.stdout.trim();
  // HEAD の解決先が未作成なら、全ファイルを追加として検査する。
  if (head.status === 1) return git(["mktree"], { input: "" }).toString().trim();
  throw new Error(head.stderr.trim() || "HEAD の tree を取得できません。");
}

/** rename の前後を対応付け、削除と追加を違う扱いにする。 */
function changesBetween(base, target) {
  const fields = git(["diff", "--raw", "--no-abbrev", "--no-ext-diff", "-z", "-M", base, target, "--"]).toString().split("\0");
  const changes = [];
  // rename は Git が旧名と新名を別フィールドに入れる。
  for (let position = 0; position < fields.length - 1;) {
    const [oldMode, newMode, oldId, newId, status] = fields[position++].slice(1).split(" ");
    const before = fields[position++];
    const after = /^[RC]/.test(status) ? fields[position++] : before;
    changes.push({ before, after, oldMode, newMode, oldId, newId, copied: status.startsWith("C") });
  }
  return changes;
}

/** blob をまとめて読み、サイズで区切って改行や空のソースも取り出す。 */
function readBlobs(ids) {
  const blobs = new Map();
  // 解析対象がなければ Git の読み取り自体を省略する。
  if (ids.size === 0) return blobs;
  const result = git(["cat-file", "--batch"], { input: [...ids].join("\n") + "\n" });
  let offset = 0;
  // 各ヘッダーが期待するオブジェクトと一致することを確認してから読み進める。
  for (const id of ids) {
    const headerEnd = result.indexOf(10, offset);
    const [observedId, type, length] = result.subarray(offset, headerEnd).toString().split(" ");
    if (headerEnd < 0 || observedId !== id || type !== "blob" || !/^\d+$/.test(length)
      || result[headerEnd + 1 + Number(length)] !== 10) {
      // 欠落 blob や想定外の型は空のソースとして扱わない。
      throw new Error(`Git blob ${id} を取得できません。`);
    }
    offset = headerEnd + 1;
    blobs.set(id, result.subarray(offset, offset + Number(length)).toString("utf8"));
    offset += Number(length) + 1;
  }
  return blobs;
}

/** コミット前に動作へ影響し得る変更を選ぶ。削除・rename は旧パスも見る。 */
function affectsTests(file) {
  return /\.[cm]?[jt]sx?$/i.test(file)
    || /^(?:src(?:-[^/]+)?|tests|scripts|build|resources|\.githooks)\//.test(file)
    && !/\.(?:md|png|ico|jpg|svg)$/i.test(file)
    || /^(?:package(?:-lock)?\.json|tsconfig.*\.json|[^/]+\.html|\.gitattributes|\.withmate\/ci\.yml|\.github\/workflows\/[^/]+\.ya?ml)$/.test(file);
}

/** 別 index を使って固定 tree を展開し、通常の index や作業ファイルを上書きしない。 */
async function inSnapshot(root, target, visit) {
  const temporary = mkdtempSync(join(tmpdir(), "wm-check-"));
  const snapshot = join(temporary, "tree");
  try {
    // 一時 index は、元の index と同時に checkout しても干渉しない。
    mkdirSync(snapshot);
    const options = { env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index"), GIT_WORK_TREE: snapshot } };
    git(["read-tree", target], options);
    git(["checkout-index", "--all", "--prefix=" + snapshot.replaceAll("\\", "/") + "/"], options);
    // npm ci 済みの依存を再利用する。Windows は管理者権限が不要な junction を使う。
    const modules = join(root, "node_modules");
    // 検査の依存を勝手にインストールしたり、未実行で成功にしたりしない。
    if (!existsSync(modules)) throw new Error("先に npm ci を実行してください。");
    symlinkSync(modules, join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await visit(snapshot);
  } finally {
    // 一時ディレクトリだけを片付ける。junction の参照先は削除しない。
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** 追加されたコメント違反と構文エラーをすべて表示し、失敗時はテストに進まない。 */
async function lintSources(snapshot, changes) {
  const { isCommentSource, inspectComments, addedFindings } = await import(pathToFileURL(join(snapshot, rules)).href);
  const files = changes.filter(({ after, newMode }) => newMode.startsWith("100") && isCommentSource(after));
  /** 移動は追跡し、複製は独立した新規ソースとして検査する。 */
  const hasPrevious = (change) => !change.copied && change.oldMode.startsWith("100") && isCommentSource(change.before);
  const ids = new Set(files.flatMap((change) => hasPrevious(change) ? [change.oldId, change.newId] : [change.newId]));
  const blobs = readBlobs(ids);
  let failures = 0;
  for (const change of files) {
    // 同じ parser・規則を前後両方に適用し、比較元の違反増分を検出する。
    try {
      // rename 前の拡張子も parser に渡す。
      const current = await inspectComments(change.after, blobs.get(change.newId));
      const earlier = hasPrevious(change) ? await inspectComments(change.before, blobs.get(change.oldId)) : [];
      for (const finding of addedFindings(earlier, current)) {
        // 修正に必要な場所は新しい側のファイルと行で示す。
        console.error(`${change.after}:${finding.line}: ${finding.message}`);
        failures += 1;
      }
    } catch (error) {
      // 解析エラーも失敗とし、ほかの対象は続けて報告する。
      console.error(`${change.after}: ソースを解析できません: ${error.message}`);
      failures += 1;
    }
  }
  // テスト実行より前にコメント違反で止める。
  if (failures) throw new Error(`コメント lint: ${failures} 件の違反。`);
  console.log(files.length ? `コメント lint: ${files.length} ファイル、追加違反なし。` : "コメント lint: 対象 JS/TS なし。");
}

/** 検査の回帰、配布設定、変更されたテストを、ステージ済みファイルで実行する。 */
function runStagedTests(snapshot, changes) {
  const env = { ...process.env };
  // node:test から呼ばれたときも、子の test runner が再帰実行として全件を止めないようにする。
  delete env.NODE_TEST_CONTEXT;
  // 外側の hook が参照していた Git index や設定を、テスト内の一時 repository に渡さない。
  for (const key of git(["rev-parse", "--local-env-vars"]).toString().trim().split(/\s+/)) delete env[key];
  const files = [...new Set([
    qualityTest,
    smokeTest,
    ...changes.filter(({ after, newMode }) => newMode.startsWith("100") && testPattern.test(after)).map(({ after }) => after),
  ])];
  console.log(`ステージ済みテスト: ${files.length} ファイル。`);
  for (let offset = 0; offset < files.length; offset += 30) {
    // 多数のファイルを stage しても Windows のコマンド行上限に近づけない。
    run(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=4", ...files.slice(offset, offset + 30)], {
      cwd: snapshot, env, stdio: "inherit",
    });
  }
}

/** 手動・hook・CI で同じ差分検査を実行する。 */
async function main(args) {
  const preCommit = args.length === 1 && args[0] === "--pre-commit";
  const committed = args.length === 2 && args[0] === "--base";
  // 認識しないオプションで空の検証を通さない。
  if (args.length > 0 && !preCommit && !committed) throw new Error("使い方: npm run lint -- [--base <ref>] / npm run check:staged");
  const root = git(["rev-parse", "--show-toplevel"]).toString().trim();
  process.chdir(root);
  const target = committed ? tree("HEAD") : git(["write-tree"]).toString().trim();
  const base = committed ? tree(args[1]) : headTree();
  if (target === base) {
    // 空コミットにも対応するが、lint・test の成功とは表示しない。
    console.log("検査対象なし: 比較元と同じ tree です。");
    return;
  }
  // 衝突マーカー・空白違反は、コメント解析より先に検出する。
  git(["diff", "--check", "--no-ext-diff", base, target, "--"], { stdio: "inherit" });
  const changes = changesBetween(base, target);
  const needsTests = preCommit && changes.some(({ before, after }) => affectsTests(before) || affectsTests(after));
  const hasSourceChanges = changes.some(({ before, after }) => /\.[cm]?[jt]sx?$/i.test(before) || /\.[cm]?[jt]sx?$/i.test(after));
  if (hasSourceChanges || needsTests) {
    // ソース lint やテストを実行する場合だけ、対象 tree を一時展開する。
    await inSnapshot(root, target, async (snapshot) => {
      // 実際の検査規則も、作業ツリーではなく対象 tree に含まれるものを読み取る。
      await lintSources(snapshot, changes);
      // 手動の lint と CI の差分 lint はテストを別コマンドで実行する。
      if (needsTests) runStagedTests(snapshot, changes);
    });
  } else {
    // ドキュメントだけの場合も Git の空白検査は済んでいる。
    console.log("コメント lint: 対象 JS/TS なし。");
  }
  // テストを省いた理由を表示し、実行済みの成功とは区別する。
  if (preCommit && !needsTests) console.log("ステージ済みテスト: 実行対象外（文書・設定等のみ）。");
  if (!committed && git(["write-tree"]).toString().trim() !== target) {
    // 検証中の stage 操作により結果が古くなっていたら、コミットを止める。
    throw new Error("検証中にステージ内容が変わりました。再実行してください。");
  }
}

// Git・lint・テストに共通の終了経路。
try {
  await main(process.argv.slice(2));
} catch (error) {
  // 手動実行にも Git hook にも非ゼロ終了を返す。
  console.error(error.message);
  process.exitCode = 1;
}
