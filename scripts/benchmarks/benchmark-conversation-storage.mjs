import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const sourceRoot = resolve(arg("--source-root", "."));
const outputDir = resolve(arg("--output-dir", "."));
const label = arg("--label", "storage");
const mode = arg("--mode", "full");
process.env.WITHMATE_BENCHMARK_SOURCE_ROOT = sourceRoot;
const load = path => import(pathToFileURL(resolve(sourceRoot, path)).href);
const { createV6StorageWorkerBundle } = await load("src-electron/storage/storage-worker-bundle.ts");
const { createOrVerifyV6FreshDatabase } = await load("src-electron/storage/app-database-v6-bootstrap.ts");
const { buildNewSession } = await load("src-shared/session/session-state.ts");
const userDataPath = resolve(outputDir, `${label}-sqlite-data`);
mkdirSync(userDataPath, { recursive: true });
const bootstrap = await createOrVerifyV6FreshDatabase(userDataPath);
const bundle = createV6StorageWorkerBundle({ dbPath: bootstrap.dbPath, userDataPath,
  bundledModelCatalogPath: resolve(sourceRoot, "public/model-catalog.json"),
  handlerModule: new URL("./benchmark-conversation-storage-worker.mjs", import.meta.url),
});
const body = id => Array.from({ length: 6000 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `${id}-${index} ` + "x".repeat(1024 - `${id}-${index} `.length) }));
const memory = async () => ({ main: process.memoryUsage(), storageWorker: await bundle.client.call("benchmark.memory", null), note: "Worker is a thread: RSS is shared process RSS, heapUsed is isolate-specific; no forced GC" });
try {
  await bundle.initialize();
  const parent = buildNewSession({ id: "benchmark-main", taskTitle: "Conversation benchmark", workspaceLabel: "fixture", workspacePath: "fixture", branch: "fixture", characterId: "benchmark-character", character: "Benchmark", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "never" });
  parent.messages = body(parent.id);
  await bundle.stores.session.upsertSession(parent);
  for (let index = 1; index <= 20; index++) {
    await bundle.stores.auxiliary.upsertAuxiliarySession({ id: `benchmark-aux-${index}`, parentSessionId: parent.id, status: "active", runState: "idle", title: `Auxiliary ${index}`, provider: parent.provider, catalogRevision: parent.catalogRevision, model: parent.model, reasoningEffort: parent.reasoningEffort, approvalMode: parent.approvalMode, codexSandboxMode: parent.codexSandboxMode, codexSpeed: parent.codexSpeed, codexReviewer: parent.codexReviewer, customAgentName: "", allowedAdditionalDirectories: [], threadId: "", composerDraft: "", messages: body(`benchmark-aux-${index}`), displayAfterMessageIndex: null, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", closedAt: "", characterId: parent.characterId, characterRuntimeSnapshot: parent.characterRuntimeSnapshot, characterIconPath: "" });
  }
  const generatedMemory = await memory();
  const reads = [];
  const read = async (owner, id) => {
    const started = performance.now();
    const value = owner === "main"
      ? await bundle.stores.session[mode === "view" ? "getSessionView" : "getSession"](id)
      : await bundle.stores.auxiliary[mode === "view" ? "getAuxiliarySessionView" : "getAuxiliarySession"](id);
    reads.push({ owner, id, durationMs: performance.now() - started, messageCount: value.messages.length, totalCount: value.messageCount, bodyUtf8Bytes: value.messages.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0), responseJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(value)) });
  };
  await read("main", parent.id);
  const afterMain = await memory();
  await read("auxiliary", "benchmark-aux-1");
  const afterAuxiliary = await memory();
  for (let index = 0; index < 40; index++) await read("auxiliary", `benchmark-aux-${(index + 1) % 20 + 1}`);
  const afterSwitches = await memory();
  writeFileSync(resolve(outputDir, `${label}-sqlite.json`), JSON.stringify({ label, mode, sourceRoot, measurement: "real SQLite V6 stores via production Storage Worker; synthetic persisted data, 6000x1024B Main and each of20 Auxiliary; not app main cache or renderer", conditions: { messages: 6000, bodyBytes: 1024, auxiliaryCount: 20 }, generatedMemory, afterMain, afterAuxiliary, afterSwitches, reads }, null, 2));
  console.log(JSON.stringify({ label, mode, initialReads: reads.slice(0, 2), memory: afterSwitches }));
} finally {
  await bundle.client.close();
}
