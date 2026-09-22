import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type TestFile = {
  relativePath: string;
  size: number;
};

export type ShardOptions = {
  index: number;
  total: number;
};

function comparePaths(left: TestFile, right: TestFile): number {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

export function listTestFiles(rootDirectory: string): TestFile[] {
  const files: TestFile[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
        files.push({
          relativePath: path.relative(rootDirectory, fullPath).replace(/\\/g, "/"),
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

export function selectShard(files: TestFile[], options: ShardOptions): TestFile[] {
  if (!Number.isSafeInteger(options.index) || !Number.isSafeInteger(options.total)
    || options.index < 1 || options.total < 1 || options.index > options.total) {
    throw new Error("Shard must contain positive integers with index <= total.");
  }
  const buckets = Array.from({ length: options.total }, () => ({ files: [] as TestFile[], totalSize: 0 }));
  const largestFirst = [...files].sort((left, right) => right.size - left.size || comparePaths(left, right));
  for (const file of largestFirst) {
    const target = buckets.reduce((smallest, bucket) => bucket.totalSize < smallest.totalSize ? bucket : smallest);
    target.files.push(file);
    target.totalSize += file.size;
  }
  return buckets[options.index - 1].files.sort(comparePaths);
}
