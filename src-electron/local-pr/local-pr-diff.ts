import type {
  LocalPrData,
  LocalPrDetail,
  LocalPrInput,
  LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { gitUtf8, LocalPrError, localPrGit } from "./local-pr-git.js";

/** 提出版の比較端点、変更ファイル一覧と要求時のパッチを返す公開結果。 */
type Diff = LocalPrData<"pr_diff">;
/** 変更一覧の一ファイル。リネームの場合は元パスも含む。 */
type File = Diff["files"][number];
/** コメントが対象とする比較方法、ファイルの側、必要に応じた行範囲。 */
type Anchor = NonNullable<LocalPrInput<"pr_comment">["anchor"]>;
/** 差分を取得する前後の固定コミット ID の組。 */
type Comparison = Pick<Diff, "beforeCommit" | "afterCommit">;
const fileKinds = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
} as const;

/** 不変のレビュー版を一つ特定する。見つからなければ最新版で代用しない。 */
export function localPrVersion(
  versions: LocalPrVersion[],
  wanted: number,
): LocalPrVersion {
  const version = versions.find(({ version }) => version === wanted);
  if (!version)
    throw new LocalPrError(
      "VERSION_NOT_FOUND",
      "The selected PR version does not exist.",
    );
  return version;
}

/** 全体レビューと差分レビューで使う固定の比較端点を選ぶ。 */
function comparison(
  versions: LocalPrDetail["versions"],
  version: number,
  mode: Anchor["mode"],
): Comparison {
  const selected = localPrVersion(versions, version);
  // 初版には前の版がない。ここでマージベースを使うと、アンカーの比較種別が実態と異なる。
  if (mode === "previous" && version === 1) {
    throw new LocalPrError(
      "NO_PREVIOUS_VERSION",
      "The first submission has no previous version.",
    );
  }
  return {
    beforeCommit:
      mode === "full"
        ? selected.mergeBaseCommit
        : localPrVersion(versions, version - 1).headCommit,
    afterCommit: selected.headCommit,
  };
}

/** ファイル名を分割・正規化せず、Git の NUL 区切りのステータスを解析する。 */
function parseChangedFiles(bytes: Buffer): File[] {
  const tokens = gitUtf8(bytes).split("\0");
  const files: File[] = [];
  // リネーム検出時、R と C には変更元と変更先のパスが含まれる。
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++][0] as keyof typeof fileKinds;
    const kind = fileKinds[status];
    const first = tokens[i++];
    const paired = status === "R" || status === "C";
    const path = paired ? tokens[i++] : first;
    if (!kind || !first || !path)
      throw new LocalPrError(
        "GIT_FAILED",
        "Git returned an unsupported change entry.",
      );
    files.push({ path, previousPath: paired ? first : null, kind });
  }
  return files;
}

/** 変更一覧全体、または指定したファイルのパッチを読み取る。リネーム時は前後両方の名前を扱う。 */
export async function readLocalPrDiff(
  root: string,
  versions: LocalPrVersion[],
  input: LocalPrInput<"pr_diff">,
): Promise<Diff> {
  const range = comparison(versions, input.version, input.mode);
  const args = [
    `--attr-source=${range.afterCommit}`,
    "diff-tree",
    "--no-commit-id",
    "-r",
    "--find-renames=50%",
    "-l1000",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--ignore-submodules=none",
    "--diff-algorithm=myers",
  ];
  const commits = [range.beforeCommit, range.afterCommit, "--"];
  const files = parseChangedFiles(
    await localPrGit(root, [...args, "--name-status", "-z", ...commits]),
  );
  if (input.path === undefined) return { ...range, files, patch: null };
  // 公開された名前と完全一致させる。呼び出し元からの Git pathspec 構文の持ち込みや比較側の切り替えを許さない。
  const file = files.find(({ path }) => path === input.path);
  if (!file)
    throw new LocalPrError(
      "FILE_NOT_CHANGED",
      "This path is not in the selected version's comparison.",
    );
  const specs = [file.previousPath, file.path]
    .filter((value) => value !== null)
    .map((value) => `:(top,literal)${value}`);
  const patch = await localPrGit(root, [
    ...args,
    "--patch",
    "--full-index",
    "--no-indent-heuristic",
    "--unified=3",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-relative",
    "--line-prefix=",
    "--output-indicator-old=-",
    "--output-indicator-new=+",
    "--output-indicator-context= ",
    ...commits,
    ...specs,
  ]);
  return { ...range, files: [file], patch: patch.toString("utf8") };
}

/** アンカーは、ファイルが存在する比較側か、その側のテキストパッチに表示される行を指す。 */
export async function validateLocalPrAnchor(
  root: string,
  versions: LocalPrVersion[],
  prId: string,
  version: number,
  anchor: Anchor,
): Promise<void> {
  const fileOnly = anchor.startLine === null && anchor.endLine === null;
  const diff = await readLocalPrDiff(root, versions, {
    prId,
    version,
    mode: anchor.mode,
    ...(fileOnly ? {} : { path: anchor.path }),
  });
  const file = diff.files.find(({ path }) => path === anchor.path);
  if (
    !file ||
    (file.kind === "added" && anchor.side === "before") ||
    (file.kind === "deleted" && anchor.side === "after")
  ) {
    throw new LocalPrError(
      "INVALID_ANCHOR",
      "This file has no selected side in the comparison.",
    );
  }
  // バイナリやリネームのみの項目には、パッチを取得せずファイル単位でコメントできる。
  if (fileOnly) return;
  if (anchor.startLine === null || anchor.endLine === null) {
    throw new LocalPrError(
      "INVALID_ANCHOR",
      "Select both endpoints of the line range.",
    );
  }
  let next = anchor.startLine;
  const headers = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu;
  // 選んだ側で隣接する差分ハンクの範囲を結合するが、表示されない区間をまたがない。
  for (const match of (diff.patch ?? "").matchAll(headers)) {
    const i = anchor.side === "before" ? 1 : 3;
    const start = Number(match[i]);
    const end = start + Number(match[i + 1] ?? 1) - 1;
    if (next >= start && next <= end) next = end + 1;
    if (next > anchor.endLine) return;
  }
  throw new LocalPrError(
    "INVALID_ANCHOR",
    "Select a line range shown on the chosen side of this file's diff.",
  );
}
