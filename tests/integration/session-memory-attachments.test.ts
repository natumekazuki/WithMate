import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { captureSessionMemoryFileAccess } from "../../src-electron/memory/memory-file-access.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "../../src-electron/memory/memory-protected-object-exporter.js";
import { inspectMemoryProtectedObjectInputFile, prepareMemoryProtectedObjectFile } from "../../src-electron/memory/memory-protected-object-importer.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory/memory-protected-object-store.js";
import { getMemoryV6AgentRuntimeOperations } from "../../src-electron/memory/memory-v6-http-server.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { backgroundHistoryFixture as fixture, owner } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
const target = { kind: "user-global" } as const;
const payload = "authorized attachment bytes";
let cliDirectory: string;
let cliArtifact: string;
before(async () => {
  cliDirectory = await mkdtemp(join(tmpdir(), "withmate-session-file-cli-"));
  cliArtifact = await buildWithMateMemoryCli(cliDirectory);
});
after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

async function setup(withScope = true) {
  let sessionFolder = "";
  let keyReads = 0;
  const f = await fixture(undefined, undefined, undefined, undefined, (directory) => {
    const objectStore = MemoryProtectedObjectStore.fromUserDataPath(join(directory, "objects"));
    const key = { keyId: "a".repeat(32), key: Buffer.alloc(32, 17) };
    const keyStore = {
      async getOrCreateActiveKey() { keyReads++; return key; },
      async readKey() { keyReads++; return key; },
    };
    return {
      protectedObjectImporter: { inspect: inspectMemoryProtectedObjectInputFile,
        prepare: (input) => prepareMemoryProtectedObjectFile({ keyStore, objectStore }, input),
        discardPrepared: async ({ objectId }) => { await objectStore.deleteObject(objectId); } },
      protectedObjectExporter: {
        exportFile: (input) => exportMemoryProtectedObjectFile({ keyStore, objectStore }, input),
        exportFiles: (input) => exportMemoryProtectedObjectFiles({ keyStore, objectStore }, input),
      },
    };
  }, withScope ? (session, outputPath) => captureSessionMemoryFileAccess(session, sessionFolder, outputPath) : undefined);
  const workspace = join(f.directory, "workspace"), additional = join(f.directory, "additional");
  sessionFolder = join(f.directory, "parent-session-folder");
  const auxWorkspace = join(f.directory, "aux-workspace"), outside = join(f.directory, "outside");
  for (const directory of [workspace, additional, sessionFolder, auxWorkspace, outside]) {
    await mkdir(directory);
    await writeFile(join(directory, "evidence.txt"), payload);
  }
  Object.assign(f.sessions.get("main")!, { workspacePath: workspace, allowedAdditionalDirectories: [additional], codexSandboxMode: "workspace-write" });
  Object.assign(f.sessions.get("aux")!, { workspacePath: auxWorkspace, allowedAdditionalDirectories: [], codexSandboxMode: "workspace-write" });
  return { f, workspace, additional, sessionFolder, auxWorkspace, outside, keyReads: () => keyReads };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function normal(s: Setup, id = "main") {
  const { f } = s;
  const binding = f.bindings.issueOrReuse({ actorSessionId: id, providerId: "codex", actorSource: f.scope(id).history.source,
    authoritySnapshot: { userId: "local-user", characterId: "character", allowedProjectIds: [] },
    operationGrants: getMemoryV6AgentRuntimeOperations() });
  const handle = f.turns.begin({ actorSessionId: id, providerId: "codex" });
  const projected = { ...binding, turnCapability: handle.capability, memoryRuntimeOwner: owner };
  return { handle, binding: { ...projected, managedMcp: f.host.issue(projected, handle) } };
}
function append(key: string, inputPath?: string) {
  return { target, kind: "note", title: key, body: `Retained result ${key}`, preview: key, tags: [], idempotencyKey: key,
    ...(inputPath ? { files: [{ path: inputPath, summary: "Experiment evidence" }] } : {}) };
}
async function cli(s: Setup, binding: ReturnType<typeof normal>["binding"], command: string, input: Record<string, unknown>) {
  const result = await execFileAsync(process.execPath, [cliArtifact, command, "--json", JSON.stringify(input)], {
    cwd: s.f.directory, env: s.f.cliEnv(binding), windowsHide: true, timeout: 15_000,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }));
  return { code: result.code, value: JSON.parse(result.stdout) as Record<string, any> };
}

// @test-value v2
// kind = "security"
// claim = "通常SessionのMCPと配布CLIは許可三root内で実添付を保存・復元しroot外とjunction逃避をI/O前に拒否する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#agent-bound-memoryのfile認可" }
// fault = "通常principalからfile scopeが落ちるか許可rootを越えたpayload読取・復号・出力を行う"
// observable = "公開tool/CLI結果、復元bytes、拒否前後のkey読取数とDB件数、root外directory内容"
// observation_boundary = "public-boundary"
// scope = "normal binding managed MCP and bundled CLI through real crypto/object store/Memory Worker"
// lifecycle = "permanent"
// impact = "ElectronによるSession権限外のhost file収集と復元を防ぐ"
// distinction = "背景scopeとpath helperのtestでは通常principal生成時の認可欠落を検出しない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("通常Memory添付のMCP/CLIは許可rootの実体だけに到達する", async () => {
  const s = await setup(); const { f } = s;
  try {
    const active = normal(s), { binding } = active;
    const { client } = await f.connect(binding, "memoryUrl");
    for (const [index, root] of [s.workspace, s.additional, s.sessionFolder].entries()) {
      const saved = await client.callTool({ name: "memory.append", arguments: append(`mcp-${index}`, join(root, "evidence.txt")) });
      assert.equal(saved.isError, undefined, JSON.stringify(saved));
      const entry = (saved.structuredContent as any).entry;
      const cliSaved = await cli(s, binding, "append", append(`cli-${index}`, join(root, "evidence.txt")));
      assert.equal(cliSaved.code, 0, JSON.stringify(cliSaved.value));
      assert.equal((await f.memoryWorker.storage.getEntry(entry.id))!.files![0].originalBytes, Buffer.byteLength(payload));
      const outputPath = join(root, "new", "restored.txt");
      const restored = await client.callTool({ name: "memory.get_file", arguments: { target, objectId: entry.files[0].objectId, outputPath } });
      assert.equal(restored.isError, undefined, JSON.stringify(restored));
      assert.equal(await readFile(outputPath, "utf8"), payload);
      const batch = await cli(s, binding, "export-files", { target, entryId: cliSaved.value.entry.id, outputDirectoryPath: join(root, "batch") });
      assert.equal(batch.code, 0, JSON.stringify(batch.value));
      assert.equal(await readFile(batch.value.files[0].outputPath, "utf8"), payload);
    }
    await symlink(s.outside, join(s.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    const before = s.keyReads();
    for (const root of [s.outside, join(s.workspace, "escape")]) {
      const input = append(`denied-${root.length}`, join(root, "evidence.txt"));
      assert.equal((await client.callTool({ name: "memory.append", arguments: input })).isError, true);
      assert.notEqual((await cli(s, binding, "append", input)).code, 0);
    }
    const entry = f.db.prepare("SELECT id FROM memory_entries_v6 LIMIT 1").get()!;
    const object = f.db.prepare("SELECT object_id FROM memory_protected_objects_v6 LIMIT 1").get()!;
    for (const root of [s.outside, join(s.workspace, "escape")]) {
      const outputPath = join(root, "missing", "denied.txt");
      assert.equal((await client.callTool({ name: "memory.get_file", arguments: { target, objectId: object.object_id, outputPath } })).isError, true);
      assert.notEqual((await cli(s, binding, "get-file", { target, objectId: object.object_id, outputPath })).code, 0);
      assert.notEqual((await cli(s, binding, "export-files", { target, entryId: entry.id, outputDirectoryPath: join(root, "missing-batch") })).code, 0);
    }
    assert.equal(s.keyReads(), before);
    assert.equal(Number(f.db.prepare("SELECT COUNT(*) AS n FROM memory_entries_v6").get()!.n), 6);
    assert.deepEqual(await readdir(s.outside), ["evidence.txt"]);
    f.turns.end(active.handle);
    assert.notEqual((await cli(s, binding, "get-file", { target, objectId: object.object_id, outputPath: join(s.workspace, "expired.txt") })).code, 0);
    assert.equal(s.keyReads(), before);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "Auxiliaryのfile認可は自身の設定と親SessionFolderを使いplan/read-onlyではMemory本文を保ったまま復元だけ拒否する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#agent-bound-memoryのfile認可" }
// fault = "Auxiliaryが親Workspaceを借用するか実行設定を無視して復元する"
// observable = "MCP/CLIの保存・拒否結果、親folder復元bytes、key読取数と本文保存結果"
// observation_boundary = "public-boundary"
// scope = "auxiliary normal binding with production Session file-scope capture and protected object I/O"
// lifecycle = "permanent"
// impact = "親Sessionの権限をAuxiliaryへ暗黙継承しない"
// distinction = "Main正常系と背景captureではAuxiliary固有root・実行設定を確認できない"
// risk_tags = ["authorization"]
// @end-test-value
test("Auxiliaryの自身rootと親SessionFolderおよびread-only/planを守る", async () => {
  const s = await setup(); const { f } = s;
  try {
    const { binding } = normal(s, "aux"); const { client } = await f.connect(binding, "memoryUrl");
    const saved = await cli(s, binding, "append", append("aux-own", join(s.auxWorkspace, "evidence.txt")));
    assert.equal(saved.code, 0, JSON.stringify(saved.value));
    assert.equal((await client.callTool({ name: "memory.append", arguments: append("parent-forbidden", join(s.workspace, "evidence.txt")) })).isError, true);
    const objectId = saved.value.entry.files[0].objectId;
    const outputPath = join(s.sessionFolder, "aux-restored.txt");
    assert.equal((await client.callTool({ name: "memory.get_file", arguments: { target, objectId, outputPath } })).isError, undefined);
    assert.equal(await readFile(outputPath, "utf8"), payload);
    for (const mode of ["read-only", "plan"] as const) {
      Object.assign(f.sessions.get("aux")!, { codexSandboxMode: mode === "read-only" ? mode : "workspace-write", approvalMode: mode === "plan" ? mode : "on-request" });
      const before = s.keyReads();
      const output = { target, objectId, outputPath: join(s.sessionFolder, `${mode}.txt`) };
      assert.equal((await client.callTool({ name: "memory.get_file", arguments: output })).isError, true);
      assert.notEqual((await cli(s, binding, "export-files", { target, entryId: saved.value.entry.id, outputDirectoryPath: join(s.sessionFolder, mode) })).code, 0);
      assert.equal(s.keyReads(), before);
      assert.equal((await cli(s, binding, "append", append(`text-${mode}`))).code, 0);
      assert.equal((await cli(s, binding, "append", append(`read-${mode}`, join(s.sessionFolder, "evidence.txt")))).code, 0);
    }
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "file scopeのない通常bindingは添付・復元を拒否するが本文保存とtrusted operatorの任意path操作を妨げない"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#agent-bound-memoryのfile認可" }
// fault = "scope欠落時にhost権限へfallbackするかlocal_userまでSession限定する"
// observable = "公開結果、key読取数、operatorによるroot外保存と復元bytes"
// observation_boundary = "public-boundary"
// scope = "normal binding fail-closed versus trusted local_user service access"
// lifecycle = "permanent"
// impact = "未配線時のfail-openとoperator操作の意図しない退行を防ぐ"
// distinction = "正規scopeでのroot外拒否だけではscope欠落を検出しない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("通常bindingのscope欠落はfail closedでoperatorは維持する", async () => {
  const s = await setup(false); const { f } = s;
  try {
    const { binding } = normal(s); const { client } = await f.connect(binding, "memoryUrl");
    assert.equal((await client.callTool({ name: "memory.append", arguments: append("unscoped", join(s.workspace, "evidence.txt")) })).isError, true);
    assert.equal(s.keyReads(), 0);
    assert.equal((await cli(s, binding, "append", append("text-only"))).code, 0);
    const operator = createLocalUserMemoryPrincipal();
    const operatorTarget = { owner: "user", scope: "global" } as const;
    const saved = await f.memory.append(operator, { ...append("operator", join(s.outside, "evidence.txt")), target: operatorTarget, schemaVersion: MEMORY_V6_SCHEMA_VERSION });
    assert.ok(!("error" in saved), JSON.stringify(saved));
    const outputPath = join(s.outside, "operator.txt"), objectId = saved.entry.files![0].objectId;
    const before = s.keyReads();
    assert.notEqual((await cli(s, binding, "get-file", { target, objectId, outputPath })).code, 0);
    assert.equal(s.keyReads(), before);
    const restored = await f.memory.getFile(operator, { schemaVersion: MEMORY_V6_SCHEMA_VERSION, target: operatorTarget, objectId, outputPath });
    assert.ok(!("error" in restored), JSON.stringify(restored));
    assert.equal(await readFile(outputPath, "utf8"), payload);
  } finally { await f.close(); }
});
