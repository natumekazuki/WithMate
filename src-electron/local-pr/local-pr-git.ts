import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import {
  localPrCommitSchema,
  type LocalPrFailure,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { getDefaultGitExecutablePath } from "../platform/git-executable.js";

/** ワークスペースの worktree と、リンクされたすべての worktree が共有する識別情報。 */
export type LocalPrRepository = {
  repositoryId: string;
  root: string;
  workspacePath: string;
};

/** 公開結果として意図的に返す拒否。永続化への影響を確認する必要があるかも示す。 */
export class LocalPrError extends Error {
  /** 業務上の失敗と、予期しない Git やストレージのエラーを区別する。 */
  constructor(
    readonly code: string,
    message: string,
    readonly effect: LocalPrFailure["effect"] = "none",
  ) {
    super(message);
  }
}

const gitNullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
const gitArgs = [
  "--no-optional-locks",
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${gitNullDevice}`,
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
const timeout = 30_000;
/** マージ実行時の Git 設定上書きに値を渡す、一時環境変数の名前。 */
export const localPrEmptyGitConfigEnv = "GIT_WITHMATE_EMPTY_CONFIG";

/** リポジトリの作業ディレクトリは探索せず、プロセスの PATH から Git を探す。 */
async function gitExecutable(): Promise<string> {
  try {
    return await getDefaultGitExecutablePath();
  } catch {
    throw new LocalPrError(
      "GIT_UNAVAILABLE",
      "Git is not available on the application PATH.",
    );
  }
}

/** 継承された設定による Git の参照先変更、置換オブジェクト、ネットワーク取得を防ぐ。 */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toUpperCase().startsWith("GIT_"),
      ),
    ),
    LC_ALL: "C",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    [localPrEmptyGitConfigEnv]: " ",
  };
}

/** シェルを介さず、上限を設けて Git を実行し、出力を取得する。想定内の非ゼロ終了は呼び出し側で解釈する。 */
export async function runLocalPrGit(
  root: string,
  args: string[],
  input?: Buffer | string,
) {
  const file = await gitExecutable();
  return new Promise<{ code: number; stdout: Buffer; stderr: string }>(
    (resolve, reject) => {
      const child = execFile(
        file,
        [...gitArgs, ...args],
        {
          cwd: root,
          windowsHide: true,
          env: gitEnvironment(),
          encoding: "buffer",
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          // シグナル、タイムアウト、出力上限による終了は、通常の Git 終了ステータスとは区別する。
          if (error && typeof error.code !== "number") {
            reject(
              new LocalPrError(
                "GIT_FAILED",
                `Git ${args[0]} did not complete: ${error.code ?? error.signal ?? "interrupted"}.`,
              ),
            );
            return;
          }
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            stdout,
            stderr: stderr.toString("utf8").trim(),
          });
        },
      );
      // Git が早期終了すると、要求をすべて読み取る前に標準入力が閉じることがある。
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    },
  );
}

/** 利用可能な結果を得るために、成功が必要な Git 操作。 */
export async function localPrGit(
  root: string,
  args: string[],
  input?: Buffer | string,
): Promise<Buffer> {
  const result = await runLocalPrGit(root, args, input);
  if (result.code) {
    throw new LocalPrError(
      "GIT_FAILED",
      result.stderr || `Git ${args[0]} exited with code ${result.code}.`,
    );
  }
  return result.stdout;
}

/** Git が出力する行の末尾には改行が付く。空白を含め、ファイル名の各バイトには意味がある。 */
export function gitLine(bytes: Buffer): string {
  return gitUtf8(bytes).replace(/\r?\n$/u, "");
}

/** 公開インターフェースの文字列で情報を失わずに表せないパス出力は拒否する。 */
export function gitUtf8(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes)) {
    throw new LocalPrError(
      "UNSUPPORTED_PATH",
      "Git returned a path that is not valid UTF-8.",
    );
  }
  return value;
}

/** Git オブジェクト ID は省略しない。リビジョン式やオプションとして解釈されてはならない。 */
export function gitObjectId(value: string): string {
  if (!localPrCommitSchema.safeParse(value).success) {
    throw new LocalPrError(
      "GIT_FAILED",
      "Git did not return a full object ID.",
    );
  }
  return value;
}

/** 信頼された Session のワークスペースを解決する。ブランチや呼び出し元の入力はリポジトリの識別に使わない。 */
export async function resolveLocalPrRepository(
  workspacePath: string,
): Promise<LocalPrRepository> {
  const workspace = await realpath(workspacePath);
  const root = await realpath(
    gitLine(await localPrGit(workspace, ["rev-parse", "--show-toplevel"])),
  );
  const repositoryId = await realpath(
    gitLine(
      await localPrGit(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ),
  );
  return { repositoryId, root, workspacePath: workspace };
}

/** 共通の形式検査を通過していても、ref 入力にリビジョン構文が含まれていれば拒否する。 */
export async function validateLocalPrBranch(
  root: string,
  ref: string,
): Promise<void> {
  const result = await runLocalPrGit(root, ["check-ref-format", ref]);
  if (!ref.startsWith("refs/heads/") || result.code !== 0) {
    throw new LocalPrError(
      "INVALID_BRANCH",
      "Select an exact local branch ref.",
    );
  }
}

/** ローカルのコミットを直接指す正確な ref を読む。シンボリックな別名はマージの対象にしない。 */
export async function readLocalPrBranch(
  root: string,
  ref: string,
): Promise<string | null> {
  const bytes = await localPrGit(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
    ref,
  ]);
  const value = gitUtf8(bytes)
    .split(/\r?\n/u)
    .map((line) => line.split("\0"))
    .find(([name]) => name === ref);
  if (!value) return null;
  if (value[2] !== "commit" || value[3]) {
    throw new LocalPrError(
      "INVALID_BRANCH",
      "The selected branch is not a direct commit ref.",
    );
  }
  return gitObjectId(value[1]);
}

/** コミットオブジェクトだけを厳密に受け付ける。タグ、ツリー、省略 ID、作業ツリーは受け付けない。 */
export async function verifyLocalPrCommit(
  root: string,
  oid: string,
): Promise<void> {
  const result = await runLocalPrGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${gitObjectId(oid)}^{commit}`,
  ]);
  if (result.code !== 0 || gitLine(result.stdout) !== oid) {
    throw new LocalPrError(
      "COMMIT_NOT_FOUND",
      "The selected object is not an available commit.",
    );
  }
}
