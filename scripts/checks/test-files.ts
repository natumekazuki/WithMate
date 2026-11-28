import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Nodeに渡すリポジトリ相対パスと、シャードの配分に使うファイルサイズ（バイト）。 */
export type TestFile = {
  relativePath: string;
  size: number;
};

/** 全シャード数と、その中で実行する1始まりのシャード番号。 */
export type ShardOptions = {
  index: number;
  total: number;
};

/** ロケールに依存しない相対パス順で並べ、テストの実行順と同サイズ時の配分を一定にする。 */
function comparePaths(left: TestFile, right: TestFile): number {
  return left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0;
}

/** tests配下にある通常の.test.ts／.test.tsxをパス順で返す。ディレクトリがなければ空とする。 */
export function listTestFiles(rootDirectory: string): TestFile[] {
  const files: TestFile[] = [];
  /** 下位ディレクトリを辿り、実行対象の通常ファイルだけ相対パスとサイズを収集する。 */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
        files.push({
          relativePath: path
            .relative(rootDirectory, fullPath)
            .replace(/\\/g, "/"),
          size: statSync(fullPath).size,
        });
      }
    }
  }

  const directory = path.join(rootDirectory, "tests");
  if (existsSync(directory)) {
    visit(directory);
  }
  return files.sort(comparePaths);
}

/** 大きいファイルから合計バイト数が小さいシャードへ配分し、指定先の一覧をパス順で返す。範囲外の指定は拒否する。 */
export function selectShard(
  files: TestFile[],
  options: ShardOptions,
): TestFile[] {
  if (
    !Number.isSafeInteger(options.index) ||
    !Number.isSafeInteger(options.total) ||
    options.index < 1 ||
    options.total < 1 ||
    options.index > options.total
  ) {
    throw new Error(
      "Shard must contain positive integers with index <= total.",
    );
  }
  const buckets = Array.from({ length: options.total }, () => ({
    files: [] as TestFile[],
    totalSize: 0,
  }));
  const largestFirst = [...files].sort(
    (left, right) => right.size - left.size || comparePaths(left, right),
  );
  for (const file of largestFirst) {
    const target = buckets.reduce((smallest, bucket) =>
      bucket.totalSize < smallest.totalSize ? bucket : smallest,
    );
    target.files.push(file);
    target.totalSize += file.size;
  }
  return buckets[options.index - 1].files.sort(comparePaths);
}
