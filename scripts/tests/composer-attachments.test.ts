import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveComposerPreview } from "../../src-electron/composer-attachments.js";
import { formatMarkdownImageReference } from "../../src/composer-image-reference.js";

test("resolveComposerPreview はMarkdown画像をprovider画像添付として解決する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-markdown-image-"));
  const workspacePath = path.join(root, "workspace");
  const sessionFilesPath = path.join(root, "session-files");
  const imagePath = path.join(sessionFilesPath, "pasted image (1).png");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sessionFilesPath, { recursive: true });
  await writeFile(imagePath, new Uint8Array([1, 2, 3]));

  try {
    const preview = await resolveComposerPreview(
      { workspacePath, allowedAdditionalDirectories: [sessionFilesPath] },
      formatMarkdownImageReference(imagePath),
    );

    assert.deepEqual(preview.errors, []);
    assert.equal(preview.attachments.length, 1);
    assert.equal(preview.attachments[0]?.kind, "image");
    assert.equal(preview.attachments[0]?.source, "markdown-image");
    assert.equal(preview.attachments[0]?.absolutePath, imagePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveComposerPreview は同じ画像のMarkdownと@pathを一つの添付へ集約する", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "withmate-markdown-image-dedupe-"));
  const workspacePath = path.join(root, "workspace");
  const imagePath = path.join(workspacePath, "image.png");
  await mkdir(workspacePath, { recursive: true });
  await writeFile(imagePath, new Uint8Array([1]));

  try {
    const preview = await resolveComposerPreview(
      { workspacePath, allowedAdditionalDirectories: [] },
      `${formatMarkdownImageReference(imagePath)} @image.png`,
    );
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.attachments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
