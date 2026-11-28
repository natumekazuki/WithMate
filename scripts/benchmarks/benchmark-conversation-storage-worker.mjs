import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = await import(
  pathToFileURL(
    resolve(
      process.env.WITHMATE_BENCHMARK_SOURCE_ROOT,
      "src-electron/storage/storage-worker-bundle.ts",
    ),
  ).href
);
/** 対象ビルドのストレージ処理に、Worker自身のメモリ計測だけを追加する。 */
export async function createStorageWorkerCommandHandlers(data) {
  return {
    ...(await source.createStorageWorkerCommandHandlers(data)),
    /** Worker側でメモリ使用量を読み取る。RSSはメインと同じプロセスの値。 */
    "benchmark.memory": () => process.memoryUsage(),
  };
}
/** 正規のWorker終了処理をそのまま使い、測定後にストレージを閉じる。 */
export const closeStorageWorker = source.closeStorageWorker;
