import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogDocument } from "../../src/model-catalog.js";
import { WindowDialogService } from "../../src-electron/window-dialog-service.js";

test("WindowDialogService は directory / file / image picker の選択結果を返す", async () => {
  const calls: Array<{ kind: "open" | "save"; options: unknown }> = [];
  const service = new WindowDialogService({
    async showOpenDialog(_targetWindow, options) {
      calls.push({ kind: "open", options });
      if ((options as { title?: string }).title === "作業ディレクトリを選択") {
        return { canceled: false, filePaths: ["C:/workspace"] };
      }
      if ((options as { title?: string }).title === "画像を選択") {
        return { canceled: false, filePaths: ["C:/images/a.png"] };
      }
      return { canceled: false, filePaths: ["C:/file.txt"] };
    },
    async showSaveDialog() {
      throw new Error("save dialog should not be used");
    },
    async readTextFile() {
      throw new Error("readTextFile should not be used");
    },
    async writeTextFile() {
      throw new Error("writeTextFile should not be used");
    },
    importModelCatalogDocument() {
      throw new Error("importModelCatalogDocument should not be used");
    },
    exportModelCatalogDocument() {
      return null;
    },
  });

  const directory = await service.pickDirectory(undefined, "C:/seed");
  const file = await service.pickFile(undefined, "C:/seed.txt");
  const image = await service.pickImageFile();

  assert.equal(directory, "C:/workspace");
  assert.equal(file, "C:/file.txt");
  assert.equal(image, "C:/images/a.png");
  assert.deepEqual(calls.map((entry) => (entry.options as { title?: string }).title), [
    "作業ディレクトリを選択",
    "ファイルを選択",
    "画像を選択",
  ]);
});

test("WindowDialogService は model catalog import/export を file I/O と接続する", async () => {
  const importedDocuments: ModelCatalogDocument[] = [];
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const service = new WindowDialogService({
    async showOpenDialog(_targetWindow, options) {
      assert.equal(options.title, "model catalog を読み込む");
      return { canceled: false, filePaths: ["C:/tmp/catalog.json"] };
    },
    async showSaveDialog(_targetWindow, options) {
      assert.equal(options.title, "model catalog を保存");
      return { canceled: false, filePath: "C:/tmp/export.json" };
    },
    async readTextFile(filePath) {
      assert.equal(filePath, "C:/tmp/catalog.json");
      return JSON.stringify({
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "gpt-5.4",
            defaultReasoningEffort: "high",
            models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
          },
        ],
      });
    },
    async writeTextFile(filePath, content) {
      writtenFiles.push({ filePath, content });
    },
    importModelCatalogDocument(document) {
      importedDocuments.push(document);
      return { revision: 4, providers: document.providers };
    },
    exportModelCatalogDocument() {
      return {
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "gpt-5.4",
            defaultReasoningEffort: "high",
            models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
          },
        ],
      };
    },
  });

  const imported = await service.importModelCatalogFromFile();
  const exported = await service.exportModelCatalogToFile(4);

  assert.equal(imported?.revision, 4);
  assert.equal(importedDocuments.length, 1);
  assert.equal(exported, "C:/tmp/export.json");
  assert.deepEqual(writtenFiles, [
    {
      filePath: "C:/tmp/export.json",
      content:
        `${JSON.stringify(
          {
            providers: [
              {
                id: "codex",
                label: "Codex",
                defaultModelId: "gpt-5.4",
                defaultReasoningEffort: "high",
                models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
              },
            ],
          },
          null,
          2,
        )}\n`,
    },
  ]);
});
