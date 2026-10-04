import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = await import(pathToFileURL(resolve(process.env.WITHMATE_BENCHMARK_SOURCE_ROOT, "src-electron/storage/storage-worker-bundle.ts")).href);
export async function createStorageWorkerCommandHandlers(data) {
  return { ...await source.createStorageWorkerCommandHandlers(data), "benchmark.memory": () => process.memoryUsage() };
}
export const closeStorageWorker = source.closeStorageWorker;
