import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveSessionFile } from "../../src-electron/files/session-files.js";
import { collectPastedSessionAttachments } from "../../src/chat/composer-paste-handlers.js";

// @test-value v2
// kind = "contract"
// claim = "同名同内容は再利用を通知し、別内容は確認・取消・コピーで保存と参照を分ける"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "無確認置換する、取消fileを挿入する、再利用を通知しない、コピー時に元画像を上書きする"
// observable = "確認対象名と回数、通知対象名、添付path/presentation、実保存内容とfile一覧"
// observation_boundary = "consumer"
// scope = "clipboard collector and actual session-file storage"
// lifecycle = "permanent"
// impact = "必要な添付参照の欠落と既存添付の無断変更を防ぐ"
// distinction = "storage単体では同一paste内の順序と確認・挿入の結合を検証できず、mock保存では同内容再利用を保証できない"
// @end-test-value
test("paste collector integrates reuse, replace and per-file cancel with real storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-integration-"));
  try {
    let prevented = false;
    const confirmations: string[] = [];
    const reused: string[][] = [];
    const file = (name: string, content: string) => ({ name, arrayBuffer: async () => new TextEncoder().encode(content).buffer });
    const attachments = await collectPastedSessionAttachments({
      isFileBacked: () => true,
      sessionId: "session",
      clipboardData: { files: [
        file("note.txt", "first"), file("note.txt", "first"),
        file("note.txt", "replace"), file("note.txt", "canceled"),
        { ...file("image.png", "image"), type: "image/png" },
        { ...file("image.png", "other-image"), type: "image/png" },
      ], items: [] },
      currentTimestampLabel: () => "now",
      preventDefault: () => { prevented = true; },
      savePastedSessionFile: (request) => saveSessionFile(root, { ...request, data: new Uint8Array(request.data) }),
      confirmReplacement: async (conflict) => {
        confirmations.push(conflict.fileName);
        return confirmations.length === 1 ? "replace" : confirmations.length === 2 ? "cancel" : "copy";
      },
      onReuse: (fileNames) => reused.push(fileNames),
    });
    assert.equal(prevented, true);
    assert.deepEqual(confirmations, ["note.txt", "note.txt", "image.png"]);
    assert.deepEqual(reused, [["note.txt"]]);
    const directory = path.join(root, "session-files", "session");
    assert.deepEqual(attachments, [
      ...Array.from({ length: 3 }, () => ({ path: path.join(directory, "note.txt"), presentation: "path" })),
      { path: path.join(directory, "image.png"), presentation: "image" },
      { path: path.join(directory, "image-2.png"), presentation: "image" },
    ]);
    assert.equal(await readFile(path.join(directory, "note.txt"), "utf8"), "replace");
    assert.equal(await readFile(path.join(directory, "image.png"), "utf8"), "image");
    assert.equal(await readFile(path.join(directory, "image-2.png"), "utf8"), "other-image");
    assert.deepEqual((await readdir(directory)).sort(), ["image-2.png", "image.png", "note.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "再確認が必要な保存結果は最新hashで再度確認し、全取消では参照を追加しない"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: 確認中の変更とCancel" }
// fault = "再確認を自動承認する、古いhashで再送する、または取消後に保存・挿入する"
// observable = "確認されたhash列、保存要求のhash列、取消時の空添付配列"
// observation_boundary = "consumer"
// scope = "paste confirmation retry and cancellation"
// lifecycle = "permanent"
// @end-test-value
test("paste collector repeats confirmation for a changed file and allows cancel", async () => {
  const confirmed: string[] = [];
  const requests: Array<string | undefined> = [];
  const attachments = await collectPastedSessionAttachments({
    isFileBacked: () => true,
    sessionId: "session",
    clipboardData: { files: [{ name: "note.txt", arrayBuffer: async () => new ArrayBuffer(1) }], items: [] },
    currentTimestampLabel: () => "now",
    preventDefault() {},
    savePastedSessionFile: async (request) => {
      requests.push(request.replaceExistingHash);
      return { status: "conflict", fileName: request.fileName, existingHash: requests.length === 1 ? "old" : "new" };
    },
    confirmReplacement: async (conflict) => { confirmed.push(conflict.existingHash); return confirmed.length === 1 ? "replace" : "cancel"; },
  });
  assert.deepEqual(confirmed, ["old", "new"]);
  assert.deepEqual(requests, [undefined, "old"]);
  assert.deepEqual(attachments, []);
});

// @test-value v2
// kind = "contract"
// claim = "実ファイルでない画像は同じ仮名・日時でも別内容は別保存し、明示名の画像は同名確認と再利用を維持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "仮名画像の確認を繰り返す、既存画像を書き換える、または実ファイルの同名確認を迂回する"
// observable = "添付pathとpresentation、確認対象名、再利用通知、各保存先と既存image.pngの内容"
// observation_boundary = "consumer"
// scope = "clipboard image naming and actual session-file storage"
// lifecycle = "permanent"
// impact = "連続画像pasteを妨げず、過去メッセージと明示名fileの参照内容を保護する"
// distinction = "通常fileの衝突testだけでは画像の由来別命名と同日時名の保護を検出できず、実描画確認より低コストで継続検証できる"
// @end-test-value
test("clipboard images get independent names while file-backed images keep conflict handling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-paste-image-"));
  try {
    const image = (content: string, native = false) => ({
      name: "image.png", type: "image/png", native,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    });
    const directory = path.join(root, "session-files", "session");
    await saveSessionFile(root, { sessionId: "session", fileName: "image.png", data: new TextEncoder().encode("original") });
    const confirmations: string[] = [];
    const reused: string[][] = [];
    const paste = (files: ReturnType<typeof image>[]) => collectPastedSessionAttachments({
      sessionId: "session",
      clipboardData: { files, items: [] },
      isFileBacked: (file) => files.find((candidate) => candidate === file)!.native,
      currentTimestampLabel: () => "2026-10-29T13:00:00.000Z",
      preventDefault() {},
      savePastedSessionFile: (request) => saveSessionFile(root, { ...request, data: new Uint8Array(request.data) }),
      confirmReplacement: async (conflict) => { confirmations.push(conflict.fileName); return "cancel"; },
      onReuse: (names) => reused.push(names),
    });
    const first = await paste([image("first")]);
    const second = await paste([image("second")]);
    const batch = await paste([
      image("third"),
      { ...image("fourth"), name: "clipboard.jpeg", type: "image/jpeg" },
    ]);
    const generated = [...first, ...second, ...batch];
    assert.equal(new Set(generated.map((attachment) => attachment.path)).size, 4);
    assert.deepEqual(await Promise.all(generated.map((attachment) => readFile(attachment.path, "utf8"))), ["first", "second", "third", "fourth"]);
    assert.ok(generated.every((attachment) => attachment.presentation === "image"));
    assert.equal(path.basename(first[0]!.path), "pasted-2026-10-29T13-00-00.000Z.png");
    assert.equal(path.extname(batch[1]!.path), ".jpg");
    assert.deepEqual(confirmations, []);
    assert.deepEqual(await paste([image("different", true)]), []);
    assert.deepEqual(confirmations, ["image.png"]);
    assert.deepEqual(await paste([image("original", true)]), [{ path: path.join(directory, "image.png"), presentation: "image" }]);
    assert.deepEqual(reused, [["image.png"]]);
    assert.equal(await readFile(path.join(directory, "image.png"), "utf8"), "original");
    assert.equal((await readdir(directory)).length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});
