import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

/** 変更を含むディレクトリの相対パスと、配下に表示する変更ノード。 */
export type ChangedFileTreeDirectory = {
  type: "directory";
  name: string;
  relativePath: string;
  children: ChangedFileTreeNode[];
};

/** 変更ファイルの現在の相対パスと、表示・操作に使う Git の変更情報。 */
export type ChangedFileTreeFile = {
  type: "file";
  name: string;
  relativePath: string;
  entry: FileRootGitChangeEntry;
};

/** フォルダーの開閉とファイル変更の選択を種別で区別するツリー行。 */
export type ChangedFileTreeNode =
  ChangedFileTreeDirectory | ChangedFileTreeFile;

/** 組み立て中に子フォルダーを名前で再利用し、ファイルを別に蓄積する内部ノード。 */
type MutableDirectory = {
  name: string;
  relativePath: string;
  directories: Map<string, MutableDirectory>;
  files: ChangedFileTreeFile[];
};

/** Git のスラッシュ区切りの相対パスから、末尾の名前だけを取り出す。 */
function pathBasename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/** 表示名を大文字小文字などの違いを抑えて比較し、同点なら通常の照合で区別する。 */
function compareNames(left: string, right: string): number {
  return (
    left.localeCompare(right, undefined, { sensitivity: "base" }) ||
    left.localeCompare(right)
  );
}

/** フォルダーを先にし、同種の行は名前、同名なら相対パスで順序を決める。 */
function compareNodes(
  left: ChangedFileTreeNode,
  right: ChangedFileTreeNode,
): number {
  const typeOrder =
    (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1);
  return (
    typeOrder ||
    compareNames(left.name, right.name) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

/** 子フォルダーを再帰的に表示ノードにして、同じ階層のファイルとまとめて整列する。 */
function finishDirectory(directory: MutableDirectory): ChangedFileTreeNode[] {
  return [
    ...[...directory.directories.values()].map(
      (child): ChangedFileTreeDirectory => ({
        type: "directory",
        name: child.name,
        relativePath: child.relativePath,
        children: finishDirectory(child),
      }),
    ),
    ...directory.files,
  ].sort(compareNodes);
}

/** 旧パスがある場合は旧名と現名を並べ、それ以外は現名だけを返す。 */
export function changedFileDisplayName(entry: FileRootGitChangeEntry): string {
  return entry.previousRelativePath
    ? `${pathBasename(entry.previousRelativePath)} → ${pathBasename(entry.relativePath)}`
    : pathBasename(entry.relativePath);
}

/** 指定範囲に属する変更を現在のパスでまとめ、変更を含むフォルダーだけを作る。 */
export function buildChangedFileTree(
  entries: FileRootGitChangeEntry[],
  scope: FileRootGitChangeScope,
): ChangedFileTreeNode[] {
  const root: MutableDirectory = {
    name: "",
    relativePath: "",
    directories: new Map(),
    files: [],
  };
  for (const entry of entries) {
    if (!entry.scopes.includes(scope)) {
      continue;
    }
    const segments = entry.relativePath.split("/");
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }
    let directory = root;
    let directoryPath = "";
    for (const segment of segments) {
      directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = {
          name: segment,
          relativePath: directoryPath,
          directories: new Map(),
          files: [],
        };
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({
      type: "file",
      name: fileName,
      relativePath: entry.relativePath,
      entry,
    });
  }
  return finishDirectory(root);
}
