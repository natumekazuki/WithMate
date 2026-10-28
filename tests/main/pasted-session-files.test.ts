import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSessionFilesDirectory, saveSessionFile } from "../../src-electron/files/session-files.js";

// @test-value v2
// kind = "contract"
// claim = "同名同内容は既存fileを無変更で再利用し、別内容は確認まで保持して承認後だけ同じpathへ保存する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "同内容を再保存・採番する、別内容を無確認で上書きする、または承認後も古い内容を返す"
// observable = "再利用statusとpath/conflict、保存file内容・mtime・directory entry"
// observation_boundary = "public-boundary"
// scope = "paste storage same-name hash and replacement"
// lifecycle = "permanent"
// impact = "既存添付の無断変更または不要なコピーを防ぎ、承認済みの内容を参照へ渡す"
// distinction = "型やrenderer mockでは実filesystemの非書込み・hash比較・rename結果を保証できない"
// @end-test-value
test("paste storage reuses equal contents and replaces different contents only after confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-"));
  try {
    const input = { sessionId: "session", fileName: "note.bin", data: Buffer.alloc(150_000, 7) };
    const destination = await saveSessionFile(root, input);
    assert.equal(typeof destination, "string");
    if (typeof destination !== "string") throw new Error("Expected saved path");
    await utimes(destination, new Date(1000), new Date(1000));
    const before = await stat(destination);
    assert.deepEqual(await saveSessionFile(root, input), { status: "reused", path: destination });
    assert.equal((await stat(destination)).mtimeMs, before.mtimeMs);
    const different = { ...input, data: Buffer.alloc(150_000, 8) };
    const conflict = await saveSessionFile(root, different);
    assert.notEqual(typeof conflict, "string");
    if (typeof conflict === "string" || conflict.status !== "conflict") throw new Error("Expected conflict");
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.fileName, "note.bin");
    assert.deepEqual(await readFile(destination), input.data);
    assert.deepEqual(await readdir(path.dirname(destination)), ["note.bin"]);
    assert.equal(await saveSessionFile(root, { ...different, replaceExistingHash: conflict.existingHash }), destination);
    assert.deepEqual(await readFile(destination), different.data);
    assert.deepEqual(await readdir(path.dirname(destination)), ["note.bin"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "確認後に既存内容が変化した場合は古い確認で上書きせず新しい内容への確認を要求する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 確認中に既存内容が変わった場合" }
// fault = "古いhashに対する確認を新しいfileにも適用する"
// observable = "再確認のhash、保持された既存内容、最新確認後の保存内容"
// observation_boundary = "public-boundary"
// scope = "paste replacement confirmation freshness"
// lifecycle = "permanent"
// @end-test-value
test("paste storage asks again when contents changed during confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-"));
  try {
    const input = { sessionId: "session", fileName: "note.txt", data: Buffer.from("original") };
    const destination = await saveSessionFile(root, input);
    if (typeof destination !== "string") throw new Error("Expected saved path");
    const changed = { ...input, data: Buffer.from("replacement") };
    const conflict = await saveSessionFile(root, changed);
    if (typeof conflict === "string" || conflict.status !== "conflict") throw new Error("Expected conflict");
    await writeFile(destination, "edited while deciding");
    const refreshed = await saveSessionFile(root, { ...changed, replaceExistingHash: conflict.existingHash });
    if (typeof refreshed === "string" || refreshed.status !== "conflict") throw new Error("Expected renewed conflict");
    assert.notEqual(refreshed.existingHash, conflict.existingHash);
    assert.equal(await readFile(destination, "utf8"), "edited while deciding");
    assert.equal(await saveSessionFile(root, { ...changed, replaceExistingHash: refreshed.existingHash }), destination);
    assert.equal(await readFile(destination, "utf8"), "replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "paste比較はfilesystem上の同名だけに限定し別名・別Sessionを再利用せず、同名directoryをfileとして扱わない"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 同名の判定と比較範囲" }
// fault = "caseを一律同一化する、別名や別Sessionの内容を再利用する、またはdirectoryを置換する"
// observable = "同名case差のfilesystem照合結果、返却path/conflict、別名・別Session・directoryの実体"
// observation_boundary = "public-boundary"
// scope = "paste name and filesystem boundary"
// lifecycle = "permanent"
// @end-test-value
test("paste storage respects actual filename semantics and keeps its comparison local", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-"));
  try {
    const input = { sessionId: "session", fileName: "Note.txt", data: Buffer.from("first") };
    const destination = await saveSessionFile(root, input);
    if (typeof destination !== "string") throw new Error("Expected saved path");
    const lowerPath = path.join(path.dirname(destination), "note.txt");
    const lowerExists = await stat(lowerPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
    const lower = await saveSessionFile(root, { ...input, fileName: "note.txt", data: Buffer.from("other") });
    assert.equal(typeof lower === "string", !lowerExists);
    assert.equal(await readFile(destination, "utf8"), "first");
    const renamed = await saveSessionFile(root, { ...input, fileName: "renamed.txt" });
    assert.equal(renamed, path.join(path.dirname(destination), "renamed.txt"));
    const otherSession = await saveSessionFile(root, { ...input, sessionId: "another" });
    assert.equal(otherSession, path.join(resolveSessionFilesDirectory(root, "another"), "Note.txt"));
    const directory = path.join(path.dirname(destination), "folder.txt");
    await mkdir(directory);
    await assert.rejects(saveSessionFile(root, { ...input, fileName: "folder.txt" }), /not a regular file/);
    assert.equal((await stat(directory)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
