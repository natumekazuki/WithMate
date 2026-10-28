import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveSessionFile } from "../../src-electron/files/session-files.js";
import { collectPastedSessionAttachments } from "../../src/chat/composer-paste-handlers.js";

// @test-value v2
// kind = "contract"
// claim = "同一paste内の同名同内容は既存参照を使い、別内容は確認・取消で保存と挿入を分け、画像の参照形式も保持する"
// oracle = { type = "contract", ref = "docs/design/session-local-files.md: Composerと保存" }
// fault = "同名を採番または無確認置換する、取消fileを挿入する、同内容再利用を添付自体の省略にする"
// observable = "確認対象名と回数、添付path/presentation、実保存内容とfile一覧"
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
    const file = (name: string, content: string) => ({ name, arrayBuffer: async () => new TextEncoder().encode(content).buffer });
    const attachments = await collectPastedSessionAttachments({
      sessionId: "session",
      clipboardData: { files: [
        file("note.txt", "first"), file("note.txt", "first"),
        file("note.txt", "replace"), file("note.txt", "canceled"),
        { ...file("image.png", "image"), type: "image/png" },
      ], items: [] },
      currentTimestampLabel: () => "now",
      preventDefault: () => { prevented = true; },
      savePastedSessionFile: (request) => saveSessionFile(root, { ...request, data: new Uint8Array(request.data) }),
      confirmReplacement: async (conflict) => { confirmations.push(conflict.fileName); return confirmations.length === 1; },
    });
    assert.equal(prevented, true);
    assert.deepEqual(confirmations, ["note.txt", "note.txt"]);
    const directory = path.join(root, "session-files", "session");
    assert.deepEqual(attachments, [
      ...Array.from({ length: 3 }, () => ({ path: path.join(directory, "note.txt"), presentation: "path" })),
      { path: path.join(directory, "image.png"), presentation: "image" },
    ]);
    assert.equal(await readFile(path.join(directory, "note.txt"), "utf8"), "replace");
    assert.deepEqual((await readdir(directory)).sort(), ["image.png", "note.txt"]);
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
    sessionId: "session",
    clipboardData: { files: [{ name: "note.txt", arrayBuffer: async () => new ArrayBuffer(1) }], items: [] },
    currentTimestampLabel: () => "now",
    preventDefault() {},
    savePastedSessionFile: async (request) => {
      requests.push(request.replaceExistingHash);
      return { status: "conflict", fileName: request.fileName, existingHash: requests.length === 1 ? "old" : "new" };
    },
    confirmReplacement: async (conflict) => { confirmed.push(conflict.existingHash); return confirmed.length === 1; },
  });
  assert.deepEqual(confirmed, ["old", "new"]);
  assert.deepEqual(requests, [undefined, "old"]);
  assert.deepEqual(attachments, []);
});
