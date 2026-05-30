import assert from "node:assert/strict";
import test from "node:test";

import {
  pickComposerReferencePath,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
} from "../../src/session-composer-paths.js";

test("resolvePickedPathBaseDirectory は file picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("file", "C:\\workspace\\project\\src\\App.tsx"),
    "C:\\workspace\\project\\src",
  );
});

test("resolvePickedPathBaseDirectory は image picker の選択 path から親 directory を返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("image", "/workspace/project/assets/icon.png"),
    "/workspace/project/assets",
  );
});

test("resolvePickedPathBaseDirectory は folder picker の選択 path をそのまま返す", () => {
  assert.equal(
    resolvePickedPathBaseDirectory("folder", "/workspace/project/docs"),
    "/workspace/project/docs",
  );
});

test("pickComposerReferencePath は kind に対応する picker API を呼び分ける", async () => {
  const calls: Array<{ method: string; initialPath: string | null }> = [];
  const picker = {
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickDirectory", initialPath: initialPath ?? null });
      return "folder-result";
    },
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickFile", initialPath: initialPath ?? null });
      return "file-result";
    },
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push({ method: "pickImageFile", initialPath: initialPath ?? null });
      return "image-result";
    },
  };

  const inputs: Array<{ kind: ComposerPathPickerKind; expectedPath: string; method: string }> = [
    { kind: "file", expectedPath: "file-result", method: "pickFile" },
    { kind: "folder", expectedPath: "folder-result", method: "pickDirectory" },
    { kind: "image", expectedPath: "image-result", method: "pickImageFile" },
  ];

  for (const input of inputs) {
    assert.equal(
      await pickComposerReferencePath(input.kind, "C:\\workspace", picker),
      input.expectedPath,
    );
    assert.deepEqual(calls.at(-1), { method: input.method, initialPath: "C:\\workspace" });
  }
});

test("pickComposerReferencePath は null initialPath を picker API にそのまま渡す", async () => {
  const calls: Array<string | null> = [];
  const picker = {
    async pickDirectory(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    async pickFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
    async pickImageFile(initialPath?: string | null): Promise<string | null> {
      calls.push(initialPath ?? null);
      return null;
    },
  };

  assert.equal(await pickComposerReferencePath("file", null, picker), null);
  assert.deepEqual(calls, [null]);
});
