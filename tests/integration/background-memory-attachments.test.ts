import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildWithMateMemoryCli } from "../../scripts/build/build-withmate-memory-cli.js";
import type { BackgroundExecutionScope, BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS, getBackgroundMemoryFileOperations } from "../../src-shared/agent-runtime/background-operations.js";
import { MEMORY_FILE_QUOTA_MIN_BYTES } from "../../src-shared/settings/provider-settings-state.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../../src-shared/memory/memory-contract.js";
import { backgroundMemoryRegistrationHandlers } from "../../src-electron/memory/background-memory-registration.js";
import { captureBackgroundMemoryFileAccess } from "../../src-electron/memory/memory-file-access.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "../../src-electron/memory/memory-protected-object-exporter.js";
import { inspectMemoryProtectedObjectInputFile, prepareMemoryProtectedObjectFile } from "../../src-electron/memory/memory-protected-object-importer.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory/memory-protected-object-store.js";
import { createLocalUserMemoryPrincipal } from "../../src-electron/memory/memory-v6-permission.js";
import { callWithMateMemoryRuntime } from "../../src-electron/platform/mcp/withmate-memory-runtime-client.js";
import { backgroundHistoryFixture as fixture } from "../helpers/background-history-fixture.js";

const execFileAsync = promisify(execFile);
const target = { owner: "user", scope: "global" } as const;
const publicTarget = { kind: "user-global" } as const;
const payload = "attachment bytes: retained evidence, not a Memory body";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = ReturnType<Fixture["project"]>;
let cliDirectory: string;
let cliArtifact: string;
before(async () => {
  cliDirectory = await mkdtemp(join(tmpdir(), "withmate-attachments-cli-"));
  cliArtifact = await buildWithMateMemoryCli(cliDirectory);
});
after(async () => { await rm(cliDirectory, { recursive: true, force: true }); });

async function setup() {
  let failImport = false;
  let onAfterExport: (() => void) | undefined;
  const f = await fixture(undefined, backgroundMemoryRegistrationHandlers, undefined, undefined, (directory) => {
    const objectStore = MemoryProtectedObjectStore.fromUserDataPath(join(directory, "object-store"));
    const key = { keyId: "a".repeat(32), key: Buffer.alloc(32, 17) };
    const keyStore = {
      async getOrCreateActiveKey() { if (failImport) throw new Error("injected key I/O failure"); return key; },
      async readKey(id: string) { return id === key.keyId ? key : null; },
    };
    return {
      getMemoryFileQuotaBytes: () => MEMORY_FILE_QUOTA_MIN_BYTES,
      protectedObjectImporter: {
        inspect: inspectMemoryProtectedObjectInputFile,
        prepare: (input) => prepareMemoryProtectedObjectFile({ keyStore, objectStore }, input),
        discardPrepared: async ({ objectId }) => { await objectStore.deleteObject(objectId); },
      },
      protectedObjectExporter: {
        exportFile: async (input) => {
          const result = await exportMemoryProtectedObjectFile({ keyStore, objectStore }, input);
          onAfterExport?.();
          return result;
        },
        exportFiles: async (input) => {
          const result = await exportMemoryProtectedObjectFiles({ keyStore, objectStore }, input);
          onAfterExport?.();
          return result;
        },
      },
    };
  });
  f.db.prepare(`INSERT INTO session_turns_v6(id,session_id,phase,assistant_message_seq,started_at,completed_at,updated_at)
    VALUES (1,'main','completed',1,'now','now','now')`).run();
  const workspace = join(f.directory, "workspace");
  const additional = join(f.directory, "additional");
  const sessionFolder = join(f.directory, "session-folder");
  const outside = join(f.directory, "outside");
  for (const dir of [workspace, additional, sessionFolder, outside]) await mkdir(dir);
  const fileAccess = await captureBackgroundMemoryFileAccess({ readRoots: [workspace, additional, sessionFolder], sessionFolderPath: sessionFolder, writable: true });
  assert.ok(fileAccess.exportRoot);
  const inputPath = join(workspace, "evidence.txt");
  await writeFile(inputPath, payload);
  return { f, workspace, additional, sessionFolder, outside, inputPath, fileAccess,
    failImport: (fail: boolean) => { failImport = fail; },
    afterExport: (hook: () => void) => { onAfterExport = hook; } };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function start(s: Setup, purpose: BackgroundPurpose = "target-memory", fileAccess: BackgroundExecutionScope["fileAccess"] = s.fileAccess) {
  return s.f.started("main", "claude", purpose, undefined,
    [...getBackgroundMemoryReadOperations(), ...getBackgroundMemoryFileOperations(), BACKGROUND_REGISTRATION_OPERATIONS[purpose].operation],
    { memoryTargets: [target], ...(fileAccess ? { fileAccess } : {}) });
}
function append(key: string, inputPath?: string) {
  return { target: publicTarget, kind: "note", title: key, body: `Retain the experiment result and why it matters: ${key}.`,
    preview: key, tags: [], idempotencyKey: key,
    ...(inputPath ? { files: [{ path: inputPath, summary: "Evidence supporting the retained result", role: "evidence" }] } : {}) };
}
async function cli(f: Fixture, binding: Binding, command: string, input: Record<string, unknown>) {
  const child = await execFileAsync(process.execPath, [cliArtifact, command, "--json", JSON.stringify(input)], {
    cwd: f.directory, env: f.cliEnv(binding), windowsHide: true, timeout: 15_000,
  }).then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => {
    assert.equal(typeof error.code, "number", error.stderr);
    return { code: error.code, stdout: error.stdout };
  });
  return { code: child.code, value: JSON.parse(child.stdout) as Record<string, any> };
}
function counts(f: Fixture) {
  return ["memory_entries_v6", "memory_protected_objects_v6"].map((table) => f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
}
async function denied(client: Client, name: string, args: Record<string, unknown>) {
  await client.callTool({ name, arguments: args }).then(
    (result) => { assert.equal(result.isError, true, JSON.stringify(result)); },
    (error: { code: number }) => { assert.equal(error.code, 403); },
  );
}

// @test-value v2
// kind = "contract"
// claim = "target-memoryのMCPと配布CLI登録は実暗号化添付と本文を保存し、MCPはscope内復元を案内し、三用途が明示復元だけで同じbytesを取得する"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md" }
// fault = "背景の公開schema・grant・principal・実import/export接続が欠けるか、initializeが許可済み復元を否定するか、検索で実体または秘密pathを自動公開する"
// observable = "MCP initialize instructionsと公開tool、両入口の登録応答、Worker保存本文・添付metadata、三用途の復元file bytes、検索と本文取得の公開JSON"
// observation_boundary = "public-boundary"
// scope = "managed HTTP MCP and bundled CLI through production background registration and real protected object crypto/store/Worker"
// lifecycle = "permanent"
// distinction = "通常Memoryと個別I/O単体testでは背景scopeから公開二入口・実暗号化保存・三用途復元の連結を検出しない"
// @end-test-value
test("背景添付の登録と三用途の必要時復元がMCPと配布CLIで実体へ到達する", async () => {
  const s = await setup(); const { f } = s;
  try {
    const execution = start(s); const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    assert.match(client.getInstructions()!, /File restoration is a local write and is available only when its tools are published/);
    assert.match(client.getInstructions()!, /No other write or fallback authority is provided/);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some((tool) => tool.name === "memory.append" && JSON.stringify(tool.inputSchema).includes('"files"')));
    for (const tool of ["memory.get_file", "memory.export_files"]) assert.ok(tools.some((item) => item.name === tool));
    const mcpInput = append("mcp-evidence", s.inputPath);
    const mcp = await client.callTool({ name: "memory.append", arguments: mcpInput });
    assert.equal(mcp.isError, undefined, JSON.stringify(mcp));
    const first = (mcp.structuredContent as any).entry;
    const additionalPath = join(s.additional, "additional.txt"); await writeFile(additionalPath, payload);
    const childInput = append("cli-evidence", additionalPath);
    const child = await cli(f, binding, "append", childInput);
    assert.equal(child.code, 0, JSON.stringify(child.value));
    for (const [entry, input] of [[first, mcpInput], [child.value.entry, childInput]] as const) {
      const saved = await f.memoryWorker.storage.getEntry(entry.id);
      assert.equal(saved!.body, input.body);
      assert.equal(saved!.files!.length, 1);
      assert.equal(saved!.files![0].summary, input.files![0].summary);
      assert.equal(saved!.files![0].originalBytes, Buffer.byteLength(payload));
    }
    const nofiles = await cli(f, binding, "append", append("ordinary-note"));
    assert.equal(nofiles.code, 0, JSON.stringify(nofiles.value));
    f.executions.finish(execution);
    for (const purpose of ["target-memory", "character-memory", "affect"] as const) {
      const current = start(s, purpose); const currentBinding = f.project(current);
      const { client: reader } = await f.connect(currentBinding, "memoryUrl");
      for (const operation of [
        { tool: "memory.search", input: { targets: [publicTarget], query: "mcp-evidence" } },
        { tool: "memory.get_entry", input: { target: publicTarget, entryId: first.id } },
      ]) {
        const read = await reader.callTool({ name: operation.tool, arguments: operation.input });
        assert.equal(read.isError, undefined, JSON.stringify(read));
        assert.doesNotMatch(JSON.stringify(read.structuredContent), /attachment bytes:|outputPath|keyId|sha256|memory-objects/);
        assert.ok(JSON.stringify(read.structuredContent).includes(first.files[0].objectId));
        assert.ok(!JSON.stringify(read.structuredContent).includes(s.inputPath));
      }
      const outputPath = join(s.fileAccess.exportRoot!, `${purpose}.txt`);
      const restored = await reader.callTool({ name: "memory.get_file", arguments: { target: publicTarget, objectId: first.files[0].objectId, outputPath } });
      assert.equal(restored.isError, undefined, JSON.stringify(restored));
      assert.equal(await readFile(outputPath, "utf8"), payload);
      const exported = await cli(f, currentBinding, "export-files", { target: publicTarget, entryId: child.value.entry.id,
        outputDirectoryPath: join(s.fileAccess.exportRoot!, purpose) });
      assert.equal(exported.code, 0, JSON.stringify(exported.value));
      assert.equal(exported.value.exportedCount, 1);
      assert.equal(await readFile(exported.value.files[0].outputPath, "utf8"), payload);
      if (purpose !== "target-memory") {
        await denied(reader, "memory.append", append(`wrong-${purpose}`, s.inputPath));
        assert.notEqual((await cli(f, currentBinding, "append", append(`wrong-cli-${purpose}`, s.inputPath))).code, 0);
      }
      f.executions.finish(current);
    }
    assert.deepEqual(counts(f), [3, 2]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "security"
// claim = "背景添付はtarget・object所属、捕捉rootと実体path、書込可否、既存出力保護を両入口で強制する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "外部object・root外またはjunction先へアクセスし、scopeなしやread-onlyでも復元するか既存fileを上書きする"
// observable = "MCP isError・CLI非zero、拒否前後のDB件数、出力一覧、既存file bytes"
// observation_boundary = "public-boundary"
// scope = "background binding and scoped protected object access over managed MCP and bundled CLI"
// lifecycle = "permanent"
// impact = "許可外fileの収集・復号とsource環境の書換えを防ぐ"
// distinction = "path helper単体testでは公開routeがscopeを失ったり通常principalへ降格する欠陥を検出できない"
// risk_tags = ["authorization", "privacy"]
// @end-test-value
test("背景添付はtarget・実体path・read-only・上書きの境界を越えない", async () => {
  const s = await setup(); const { f } = s;
  try {
    const foreign = await f.memory.append(createLocalUserMemoryPrincipal(), {
      ...append("foreign", s.inputPath), schemaVersion: MEMORY_V6_SCHEMA_VERSION,
      target: { owner: "character", scope: "character", character: { type: "id", id: "character" } },
    });
    assert.ok(!("error" in foreign), JSON.stringify(foreign));
    const execution = start(s); const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    const saved = await cli(f, binding, "append", append("saved", s.inputPath));
    assert.equal(saved.code, 0, JSON.stringify(saved.value));
    const objectId = saved.value.entry.files[0].objectId;
    const outsideInput = join(s.outside, "secret.txt"); await writeFile(outsideInput, "outside");
    await mkdir(s.fileAccess.exportRoot!);
    await symlink(s.outside, join(s.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    await symlink(s.outside, join(s.fileAccess.exportRoot!, "escape"), process.platform === "win32" ? "junction" : "dir");
    for (const inputPath of [outsideInput, join(s.workspace, "escape", "secret.txt")]) {
      const input = append(`reject-${inputPath.length}`, inputPath);
      assert.equal((await client.callTool({ name: "memory.append", arguments: input })).isError, true);
      assert.notEqual((await cli(f, binding, "append", input)).code, 0);
      assert.deepEqual(counts(f), [2, 2]);
    }
    const existing = join(s.fileAccess.exportRoot!, "existing.txt"); await writeFile(existing, "keep");
    for (const outputPath of [join(s.outside, "denied.txt"), join(s.fileAccess.exportRoot!, "escape", "denied.txt"), existing]) {
      const input = { target: publicTarget, objectId, outputPath };
      assert.equal((await client.callTool({ name: "memory.get_file", arguments: input })).isError, true);
      assert.notEqual((await cli(f, binding, "get-file", input)).code, 0);
    }
    for (const input of [
      { target: { kind: "character" }, objectId, outputPath: join(s.fileAccess.exportRoot!, "wrong-target.txt") },
      { target: publicTarget, objectId: foreign.entry.files![0].objectId, outputPath: join(s.fileAccess.exportRoot!, "wrong-object.txt") },
    ]) {
      assert.equal((await client.callTool({ name: "memory.get_file", arguments: input })).isError, true);
      assert.notEqual((await cli(f, binding, "get-file", input)).code, 0);
    }
    for (const input of [
      { target: publicTarget, entryId: foreign.entry.id, outputDirectoryPath: join(s.fileAccess.exportRoot!, "wrong-entry") },
      { target: publicTarget, entryId: saved.value.entry.id, outputDirectoryPath: s.outside },
      { target: publicTarget, entryId: saved.value.entry.id, outputDirectoryPath: join(s.fileAccess.exportRoot!, "escape") },
    ]) {
      await denied(client, "memory.export_files", input);
      assert.notEqual((await cli(f, binding, "export-files", input)).code, 0);
    }
    assert.equal(await readFile(existing, "utf8"), "keep");
    assert.deepEqual(await readdir(s.outside), ["secret.txt"]);
    f.executions.finish(execution);
    for (const access of [undefined, { ...s.fileAccess, exportRoot: null }]) {
      // Explicit undefined represents no captured file scope, not the helper's default.
      const blockedExecution = f.started("main", "claude", "target-memory", undefined,
        [...getBackgroundMemoryReadOperations(), ...getBackgroundMemoryFileOperations(), BACKGROUND_REGISTRATION_OPERATIONS["target-memory"].operation],
        { memoryTargets: [target], ...(access ? { fileAccess: access } : {}) });
      const deniedBinding = f.project(blockedExecution); const { client: reader } = await f.connect(deniedBinding, "memoryUrl");
      const input = { target: publicTarget, objectId, outputPath: join(s.fileAccess.exportRoot!, "read-only.txt") };
      await denied(reader, "memory.get_file", input);
      assert.notEqual((await cli(f, deniedBinding, "get-file", input)).code, 0);
      if (!access) {
        assert.equal((await reader.callTool({ name: "memory.append", arguments: append("missing-scope", s.inputPath) })).isError, true);
        assert.notEqual((await cli(f, deniedBinding, "append", append("missing-scope-cli", s.inputPath))).code, 0);
      }
      f.executions.finish(blockedExecution);
    }
    assert.deepEqual(counts(f), [2, 2]);
    assert.deepEqual((await readdir(s.fileAccess.exportRoot!)).sort(), ["escape", "existing.txt"]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "append再送と失敗は確定保存を保護し、次呼出は現在権限だけを使い、復元完了後の失効でも確定出力を失敗へ変えない"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md#failure-policy" }
// fault = "冪等再送で再取込する、添付失敗を本文成功へ救済する、旧bindingを次呼出で許容する、確定済み保存・復元を未実行扱いする"
// observable = "MCP/CLI登録結果と保存ID、実Worker件数、旧接続拒否と新接続成功、get_file/export_filesの出力直後失効後のHTTP成功応答と実bytes"
// observation_boundary = "public-boundary"
// scope = "production background handler, Worker idempotency, real importer failure and per-call admission"
// lifecycle = "permanent"
// distinction = "通常service testでは背景の現在binding・production登録handlerと公開両入口までの原子性を確認できない"
// @end-test-value
test("背景添付の再送・失敗・次呼出が確定済み保存と現在権限を維持する", async () => {
  const s = await setup(); const { f } = s;
  try {
    const execution = start(s); const binding = f.project(execution);
    const { client } = await f.connect(binding, "memoryUrl");
    const input = append("idempotent", s.inputPath);
    const first = await cli(f, binding, "append", input); assert.equal(first.code, 0, JSON.stringify(first.value));
    await rm(s.inputPath);
    const replay = await client.callTool({ name: "memory.append", arguments: input });
    assert.equal(replay.isError, undefined, JSON.stringify(replay));
    assert.equal((replay.structuredContent as any).entry.id, first.value.entry.id);
    assert.equal((await cli(f, binding, "append", input)).value.entry.id, first.value.entry.id);
    await writeFile(s.inputPath, payload);
    for (const failure of ["invalid", "missing", "key-io", "quota"] as const) {
      const invalid = append(`failure-${failure}`, failure === "missing" ? join(s.workspace, "missing.txt") : s.inputPath);
      if (failure === "invalid") invalid.files![0].summary = "";
      s.failImport(failure === "key-io");
      if (failure === "quota") {
        const largePath = join(s.workspace, "large.bin"); const file = await open(largePath, "w");
        try { await file.truncate(MEMORY_FILE_QUOTA_MIN_BYTES); } finally { await file.close(); }
        invalid.files!.push({ path: largePath, role: "evidence", summary: "Quota validation evidence" });
      }
      const rejected = await client.callTool({ name: "memory.append", arguments: invalid });
      assert.equal(rejected.isError, true, JSON.stringify(rejected));
      const child = await cli(f, binding, "append", invalid); assert.notEqual(child.code, 0);
      if (failure === "quota") assert.equal(child.value.error.code, "MEMORY_FILE_QUOTA_EXCEEDED");
      assert.deepEqual(counts(f), [1, 1]);
    }
    s.failImport(false);
    f.executions.finish(execution);
    const nextAccess = await captureBackgroundMemoryFileAccess({ readRoots: [s.sessionFolder], sessionFolderPath: s.sessionFolder, writable: true });
    const next = start(s, "target-memory", nextAccess); const current = f.project(next);
    assert.notEqual(current.bindingReference, binding.bindingReference);
    const objectId = first.value.entry.files[0].objectId;
    const outputPath = join(s.fileAccess.exportRoot!, "current.txt");
    assert.notEqual((await cli(f, binding, "get-file", { target: publicTarget, objectId, outputPath })).code, 0);
    assert.notEqual((await cli(f, binding, "append", append("old-credential", s.inputPath))).code, 0);
    await assert.rejects(() => client.callTool({ name: "memory.get_file", arguments: { target: publicTarget, objectId, outputPath } }));
    const { client: resumed } = await f.connect(current, "memoryUrl");
    const restored = await resumed.callTool({ name: "memory.get_file", arguments: { target: publicTarget, objectId, outputPath } });
    assert.equal(restored.isError, undefined, JSON.stringify(restored));
    assert.equal(await readFile(outputPath, "utf8"), payload);
    assert.deepEqual(counts(f), [1, 1]);
    await denied(resumed, "memory.append", append("old-root", s.inputPath));
    const currentInput = join(s.sessionFolder, "current-input.txt"); await writeFile(currentInput, payload);
    const currentSaved = await cli(f, current, "append", append("current-credential", currentInput));
    assert.equal(currentSaved.code, 0, JSON.stringify(currentSaved.value));
    assert.deepEqual(counts(f), [2, 2]);
    f.executions.finish(next);
    for (const route of ["get_file", "export_files"] as const) {
      const finishing = start(s); const finishingBinding = f.project(finishing);
      let completedExports = 0;
      s.afterExport(() => { completedExports++; f.executions.finish(finishing); });
      const exportPath = join(s.fileAccess.exportRoot!, `finished-${route}`);
      const result = await callWithMateMemoryRuntime(f.connection, {
        method: "POST", path: `/v1/${route}`, body: { schemaVersion: MEMORY_V6_SCHEMA_VERSION, target: publicTarget,
          ...(route === "get_file" ? { objectId, outputPath: exportPath }
            : { entryId: first.value.entry.id, outputDirectoryPath: exportPath }) },
      }, { bindingReference: finishingBinding.bindingReference, turnCapability: finishingBinding.turnCapability,
        signal: AbortSignal.timeout(5_000) });
      assert.equal(completedExports, 1);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      const value = result.value as Record<string, any>;
      assert.equal(value.error, undefined, JSON.stringify(value));
      const restoredPath = route === "get_file" ? value.outputPath : value.files[0].outputPath;
      assert.equal(route === "get_file" ? value.bytesWritten : value.files[0].bytesWritten, Buffer.byteLength(payload));
      assert.equal(await readFile(restoredPath, "utf8"), payload);
    }
    assert.deepEqual(counts(f), [2, 2]);
  } finally { await f.close(); }
});
