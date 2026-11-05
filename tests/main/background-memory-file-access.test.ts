import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  BackgroundMemoryFileAccessError,
  captureBackgroundMemoryFileAccess,
  resolveBackgroundMemoryExportPath,
} from "../../src-electron/memory/background-memory-file-access.js";
import { inspectMemoryProtectedObjectInputFile, MemoryProtectedObjectImportError, prepareMemoryProtectedObjectFile } from "../../src-electron/memory/memory-protected-object-importer.js";
import { exportMemoryProtectedObjectFile, exportMemoryProtectedObjectFiles } from "../../src-electron/memory/memory-protected-object-exporter.js";
import { MemoryProtectedObjectStore } from "../../src-electron/memory/memory-protected-object-store.js";
import { runWithRuntimeTurnAdmission, RuntimeTurnInactiveError } from "../../src-electron/platform/memory/runtime-turn-admission.js";

// @test-value v2
// kind = "invariant"
// claim = "背景scopeは存在する許可rootのみ捕捉し、副作用なく欠落rootを除外し、許可内欠落入力は読取エラーを保つ"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "欠落rootを許可するか捕捉だけでexport directoryを作る"
// observable = "捕捉scopeのroots/exportRoot、SessionFolder内容と欠落入力のdomain error"
// observation_boundary = "component-behavior"
// scope = "background-memory-file-access"
// lifecycle = "permanent"
// @end-test-value
it("captures available roots without creating export directories", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-background-roots-"));
  try {
    const missing = path.join(directory, "missing");
    const scope = await captureBackgroundMemoryFileAccess({ readRoots: [directory, missing], sessionFolderPath: directory, writable: true });
    assert.deepEqual(scope.readRoots, [await realpath(directory)]);
    assert.equal(scope.exportRoot, path.join(await realpath(directory), "memory-exports"));
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(() => inspectMemoryProtectedObjectInputFile({ path: path.join(directory, "missing.txt"), summary: "missing" }, scope),
      (error: unknown) => error instanceof MemoryProtectedObjectImportError && error.code === "MEMORY_INVALID_FIELD" && /not readable/.test(error.message));
    const unavailable = await captureBackgroundMemoryFileAccess({ readRoots: [missing], sessionFolderPath: missing, writable: true });
    assert.deepEqual(unavailable, { readRoots: [], exportRoot: null });
    const readOnly = await captureBackgroundMemoryFileAccess({ readRoots: [], sessionFolderPath: directory, writable: false });
    await assert.rejects(() => resolveBackgroundMemoryExportPath(path.join(directory, "memory-exports", "out.txt"), readOnly), BackgroundMemoryFileAccessError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "背景添付は既存暗号化objectからSessionFolder内へ復元でき、上書きを防ぎ、directory作成後の取消を無効果と偽らない"
// oracle = { type = "contract", ref = "docs/design/v6-memory-protected-objects.md" }
// fault = "暗号化復元が壊れるか既存fileを上書きするかdirectory作成後の取消をRuntimeTurnInactiveErrorとして返す"
// observable = "復元byte列、出力path、再復元のEEXISTとdirectory作成後取消のerror cause"
// observation_boundary = "public-boundary"
// scope = "protected-object-background-io"
// lifecycle = "permanent"
// @end-test-value
it("round-trips scoped attachments through existing encrypted objects without overwrite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-background-roundtrip-"));
  try {
    const source = path.join(directory, "source.txt");
    const plaintext = Buffer.from("background attachment");
    await writeFile(source, plaintext);
    const fileAccess = await captureBackgroundMemoryFileAccess({ readRoots: [directory], sessionFolderPath: directory, writable: true });
    const key = { keyId: "b".repeat(32), key: randomBytes(32) };
    const objectStore = MemoryProtectedObjectStore.fromUserDataPath(directory);
    const object = await prepareMemoryProtectedObjectFile({ keyStore: { getOrCreateActiveKey: async () => key }, objectStore }, {
      entryId: "mem-background-file", file: { path: source, summary: "source", displayName: "source.txt" }, fileAccess,
    });
    const metadata = { ...object, entryId: "mem-background-file", contentType: object.contentType ?? "", displayName: object.displayName ?? "" };
    const dependencies = { keyStore: { readKey: async () => key }, objectStore };
    const outputPath = path.join(fileAccess.exportRoot!, "single", "out.txt");
    await exportMemoryProtectedObjectFile(dependencies, { metadata, outputPath, fileAccess });
    assert.deepEqual(await readFile(outputPath), plaintext);
    await assert.rejects(() => exportMemoryProtectedObjectFile(dependencies, { metadata, outputPath, fileAccess }), /EEXIST/);
    assert.deepEqual(await readFile(outputPath), plaintext);
    const batch = await exportMemoryProtectedObjectFiles(dependencies, {
      metadata: [metadata], outputDirectoryPath: path.join(fileAccess.exportRoot!, "batch"), fileAccess,
    });
    assert.equal(batch.files.length, 1);
    assert.deepEqual(await readFile(batch.files[0].outputPath), plaintext);
    assert.ok(batch.files[0].outputPath.startsWith(fileAccess.exportRoot!));
    const canceledDirectory = path.join(fileAccess.exportRoot!, "canceled");
    await assert.rejects(() => runWithRuntimeTurnAdmission({
      state: new SharedArrayBuffer(4), isCurrent: () => !existsSync(canceledDirectory),
    }, () => exportMemoryProtectedObjectFile(dependencies, {
      metadata, outputPath: path.join(canceledDirectory, "out.txt"), fileAccess,
    })), (error: unknown) => error instanceof Error && !(error instanceof RuntimeTurnInactiveError) && error.cause instanceof RuntimeTurnInactiveError);
    assert.deepEqual(await readdir(canceledDirectory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "背景取込と単体・複数復元は許可外pathおよびjunctionによる範囲外アクセスをI/O前に拒否する"
// oracle = { type = "contract", ref = "docs/design/background-execution.md" }
// fault = "字句pathだけで許可し実体の範囲外fileを読むか出力する"
// observable = "各境界のBackgroundMemoryFileAccessErrorと未変更の許可外directory"
// observation_boundary = "public-boundary"
// scope = "protected-object-background-file-authorization"
// lifecycle = "permanent"
// risk_tags = ["authorization", "privacy"]
// impact = "範囲外の秘密fileの添付や許可外fileの作成を防ぐ"
// distinction = "型検査では検出できない実filesystemのjunction解決を最小fixtureで確認する"
// @end-test-value
it("rejects outside and junction-escaping input and output at the I/O boundaries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-background-paths-"));
  try {
    const allowed = path.join(directory, "allowed");
    const outside = path.join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const source = path.join(outside, "secret.txt");
    await writeFile(source, "private");
    const fileAccess = await captureBackgroundMemoryFileAccess({ readRoots: [allowed], sessionFolderPath: allowed, writable: true });
    await symlink(outside, path.join(allowed, "linked"), "junction");
    for (const filePath of [source, path.join(allowed, "linked", "secret.txt")]) {
      await assert.rejects(() => inspectMemoryProtectedObjectInputFile({ path: filePath, summary: "not permitted" }, fileAccess), BackgroundMemoryFileAccessError);
    }
    let reads = 0;
    const dependencies = { keyStore: { readKey: async () => { reads++; return null; } }, objectStore: { readObject: async () => { reads++; return Buffer.alloc(0); } } };
    const metadata = { objectId: "a".repeat(32), entryId: "mem-denied", keyId: "b".repeat(32), originalBytes: 0, storedBytes: 0, sha256: "", contentType: "", displayName: "" };
    const outputPath = path.join(outside, "out.txt");
    await assert.rejects(() => exportMemoryProtectedObjectFile(dependencies, { metadata, outputPath, fileAccess }), BackgroundMemoryFileAccessError);
    await symlink(outside, fileAccess.exportRoot!, "junction");
    await assert.rejects(() => exportMemoryProtectedObjectFile(dependencies, { metadata, outputPath: path.join(fileAccess.exportRoot!, "out.txt"), fileAccess }), BackgroundMemoryFileAccessError);
    await assert.rejects(() => exportMemoryProtectedObjectFiles(dependencies, { metadata: [metadata], outputDirectoryPath: path.join(fileAccess.exportRoot!, "batch"), fileAccess }), BackgroundMemoryFileAccessError);
    assert.equal(reads, 0);
    assert.deepEqual(await readdir(outside), ["secret.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
