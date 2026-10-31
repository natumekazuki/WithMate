import { spawnSync } from "node:child_process";
import { listTestFiles, selectShard, type ShardOptions } from "./test-files.js";

function readShardOptions(args: string[]): { shard: ShardOptions | null; list: boolean; nodeArgs: string[] } {
  let index = process.env.TEST_SHARD_INDEX;
  let total = process.env.TEST_SHARD_TOTAL;
  let list = false;
  const nodeArgs: string[] = [];
  for (let position = 0; position < args.length; position += 1) {
    const arg = args[position];
    if (arg === "--list") {
      list = true;
    } else if (arg.startsWith("--shard=")) {
      const value = arg.slice("--shard=".length);
      if (!/^\d+\/\d+$/.test(value)) {
        throw new Error("Expected --shard=index/total.");
      }
      [index, total] = value.split("/");
    } else if (arg === "--shard-index" || arg === "--shard-total") {
      const value = args[++position];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--shard-index") index = value;
      else total = value;
    } else if (arg.startsWith("--shard-index=")) {
      index = arg.slice("--shard-index=".length);
    } else if (arg.startsWith("--shard-total=")) {
      total = arg.slice("--shard-total=".length);
    } else {
      nodeArgs.push(arg);
    }
  }
  if (index === undefined && total === undefined) return { shard: null, list, nodeArgs };
  if (!/^\d+$/.test(index ?? "1") || !/^\d+$/.test(total ?? "1")) {
    throw new Error("Shard index and total must be positive integers.");
  }
  return { shard: { index: Number(index ?? "1"), total: Number(total ?? "1") }, list, nodeArgs };
}

const options = readShardOptions(process.argv.slice(2));
const rootDirectory = process.cwd();
const allFiles = listTestFiles(rootDirectory);
const files = options.shard ? selectShard(allFiles, options.shard) : allFiles;
if (files.length === 0) {
  throw new Error("No test files selected.");
}
if (options.list) {
  console.log(JSON.stringify(files.map((file) => file.relativePath), null, 2));
} else {
  console.log(options.shard
    ? `Running test shard ${options.shard.index}/${options.shard.total}: ${files.length} of ${allFiles.length} files`
    : `Running ${files.length} test files`);
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", ...options.nodeArgs, ...files.map((file) => file.relativePath)], {
    cwd: rootDirectory,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
