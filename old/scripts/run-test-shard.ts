import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

type TestFile = {
  relativePath: string;
  size: number;
};

type ShardOptions = {
  index: number;
  total: number;
};

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseShardOptions(args: string[]): ShardOptions {
  let indexValue = process.env.TEST_SHARD_INDEX;
  let totalValue = process.env.TEST_SHARD_TOTAL;

  for (let position = 0; position < args.length; position += 1) {
    const arg = args[position];
    if (arg.startsWith("--shard=")) {
      const [, shardValue] = arg.split("=", 2);
      const [index, total] = shardValue.split("/", 2);
      indexValue = index;
      totalValue = total;
      continue;
    }
    if (arg === "--shard-index") {
      indexValue = args[position + 1];
      position += 1;
      continue;
    }
    if (arg.startsWith("--shard-index=")) {
      indexValue = arg.split("=", 2)[1];
      continue;
    }
    if (arg === "--shard-total") {
      totalValue = args[position + 1];
      position += 1;
      continue;
    }
    if (arg.startsWith("--shard-total=")) {
      totalValue = arg.split("=", 2)[1];
      continue;
    }
  }

  const index = parsePositiveInteger(indexValue ?? "1", "shard index");
  const total = parsePositiveInteger(totalValue ?? "1", "shard total");
  if (index > total) {
    throw new Error(`shard index must be <= shard total. Received ${index}/${total}.`);
  }
  return { index, total };
}

function listTestFiles(rootDirectory: string): TestFile[] {
  const testsDirectory = path.join(rootDirectory, "scripts", "tests");
  return readdirSync(testsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.tsx?$/.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(testsDirectory, entry.name);
      return {
        relativePath: path.relative(rootDirectory, fullPath).replace(/\\/g, "/"),
        size: statSync(fullPath).size,
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function selectShard(files: TestFile[], options: ShardOptions): TestFile[] {
  const buckets = Array.from({ length: options.total }, () => ({
    files: [] as TestFile[],
    totalSize: 0,
  }));
  const largestFirst = [...files].sort((left, right) => {
    const sizeDiff = right.size - left.size;
    return sizeDiff === 0 ? left.relativePath.localeCompare(right.relativePath) : sizeDiff;
  });

  for (const file of largestFirst) {
    const target = buckets.reduce((smallest, bucket) => (bucket.totalSize < smallest.totalSize ? bucket : smallest));
    target.files.push(file);
    target.totalSize += file.size;
  }

  return buckets[options.index - 1].files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function main(): void {
  const options = parseShardOptions(process.argv.slice(2));
  const rootDirectory = process.cwd();
  const allFiles = listTestFiles(rootDirectory);
  const shardFiles = selectShard(allFiles, options);

  if (shardFiles.length === 0) {
    throw new Error(`No test files selected for shard ${options.index}/${options.total}.`);
  }

  console.log(`Running test shard ${options.index}/${options.total}: ${shardFiles.length} of ${allFiles.length} files`);
  for (const file of shardFiles) {
    console.log(`- ${file.relativePath}`);
  }

  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...shardFiles.map((file) => file.relativePath)], {
    cwd: rootDirectory,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

main();
