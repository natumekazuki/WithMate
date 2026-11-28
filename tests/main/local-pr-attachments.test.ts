import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveLocalPrClipboardImage } from "../../src-electron/local-pr/local-pr-attachments.js";

/** Clipboard images survive independently of Session Files and never overwrite earlier bytes. */
test("PR clipboard images are stored in the PR attachment directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-pr-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Uint8Array.from([1, 2, 3]);
  const first = await saveLocalPrClipboardImage(root, { mimeType: "image/png", data: bytes.buffer });
  const second = await saveLocalPrClipboardImage(root, { mimeType: "image/png", data: bytes.buffer });
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join(root, "local-pr-attachments"));
  assert.deepEqual(await readFile(first), Buffer.from(bytes));
  await assert.rejects(() => saveLocalPrClipboardImage(root, { mimeType: "application/octet-stream", data: bytes.buffer }));
});
