import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogDocument } from "../../src-shared/settings/model-catalog.js";
import { WindowDialogService } from "../../src-electron/windows/window-dialog-service.js";

// @test-value v2
// kind = "contract"
// claim = "WindowDialogServiceがdirectory、file、image pickerの選択結果を対応するdialogへ委譲する"
// oracle = { type = "contract", ref = "src-electron/windows/window-dialog-service.ts" }
// fault = "dialogの選択pathを変換・欠落させる"
// observable = "dialog呼出し引数と各pickerの戻り値"
// observation_boundary = "public-boundary"
// scope = "window-dialog-service"
// lifecycle = "permanent"
// @end-test-value
test("WindowDialogService は directory / file / image picker の選択結果を返す", async () => {
  const calls: Array<{ kind: "open" | "save"; options: unknown }> = [];
  const service = new WindowDialogService({
    async showOpenDialog(_targetWindow, options) {
      calls.push({ kind: "open", options });
      if ((options as { title?: string }).title === "作業ディレクトリを選択") {
        return { canceled: false, filePaths: ["C:/workspace"] };
      }
      const title = (options as { title?: string }).title;
      if (title?.includes("icon") || title === "画像を選択") {
        return { canceled: false, filePaths: ["C:/images/a.png"] };
      }
      if ((options as { properties?: string[] }).properties?.includes("multiSelections")) {
        return { canceled: false, filePaths: ["C:/file-a.txt", "C:/file-b.txt"] };
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
  const files = await service.pickFiles(undefined, "C:/seed.txt");
  const image = await service.pickImageFile();
  const characterIcon = await service.pickImageFile(undefined, undefined, "character-icon");

  assert.equal(directory, "C:/workspace");
  assert.equal(file, "C:/file.txt");
  assert.deepEqual(files, ["C:/file-a.txt", "C:/file-b.txt"]);
  assert.equal(image, "C:/images/a.png");
  assert.equal(characterIcon, "C:/images/a.png");
  assert.deepEqual(calls.map((entry) => (entry.options as { title?: string }).title), [
    "作業ディレクトリを選択",
    "ファイルを選択",
    "ファイルを選択",
    "画像を選択",
    "Character icon を選択",
  ]);
  assert.equal((calls[0]?.options as { defaultPath?: string }).defaultPath, "C:/seed");
  assert.equal((calls[1]?.options as { defaultPath?: string }).defaultPath, "C:/seed.txt");
  assert.equal((calls[2]?.options as { defaultPath?: string }).defaultPath, "C:/seed.txt");
  assert.deepEqual((calls[2]?.options as { properties?: string[] }).properties, ["openFile", "multiSelections"]);
  assert.deepEqual((calls[3]?.options as { filters?: unknown }).filters, [
    { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
  ]);
  assert.deepEqual((calls[4]?.options as { filters?: unknown }).filters, [
    { name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "WindowDialogServiceはopen/save dialogのcancelをnullまたは空配列へ変換する"
// oracle = { type = "contract", ref = "src-electron/windows/window-dialog-service.ts picker cancellation" }
// fault = "cancel結果を未選択pathとして扱わず後続file I/Oを実行する"
// observable = "各pickerおよびmodel catalog import/exportのcancel戻り値とI/O不在"
// observation_boundary = "public-boundary"
// scope = "window-dialog-service-cancel"
// lifecycle = "permanent"
// @end-test-value
test("WindowDialogService は open/save dialog の cancel を null として返す", async () => {
  const service = new WindowDialogService({
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
    async showSaveDialog() {
      return { canceled: true, filePath: "" };
    },
    async readTextFile() {
      throw new Error("readTextFile should not be used");
    },
    async writeTextFile() {
      throw new Error("writeTextFile should not be used");
    },
    async importModelCatalogDocument() {
      throw new Error("importModelCatalogDocument should not be used");
    },
    exportModelCatalogDocument() {
      return { providers: [] };
    },
  });

  assert.equal(await service.pickDirectory(undefined, "C:/seed"), null);
  assert.equal(await service.pickFile(), null);
  assert.deepEqual(await service.pickFiles(), []);
  assert.equal(await service.pickImageFile(), null);
  assert.equal(await service.importModelCatalogFromFile(), null);
  assert.equal(await service.exportModelCatalogToFile(7), null);
});

// @test-value v2
// kind = "contract"
// claim = "model catalog import/exportはdialogで選択したfile pathとJSON内容を既存のfile I/Oおよびcatalog serviceへ接続する"
// oracle = { type = "contract", ref = "src-electron/windows/window-dialog-service.ts model catalog import/export" }
// fault = "選択pathを無視する、catalog JSONを変換して保存する、またはimport/export serviceを呼ばない"
// observable = "read/write file pathとcontent、catalog serviceへ渡されたdocument、export path"
// observation_boundary = "public-boundary"
// scope = "window-dialog-service-model-catalog"
// lifecycle = "permanent"
// @end-test-value
test("WindowDialogService は model catalog import/export を file I/O と接続する", async () => {
  const importedDocuments: ModelCatalogDocument[] = [];
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const exportRevisions: Array<number | null | undefined> = [];
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
    async importModelCatalogDocument(document) {
      importedDocuments.push(document);
      return { revision: 4, providers: document.providers };
    },
    exportModelCatalogDocument(revision) {
      exportRevisions.push(revision);
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
  assert.deepEqual(importedDocuments, [{
    providers: [{
      id: "codex",
      label: "Codex",
      defaultModelId: "gpt-5.4",
      defaultReasoningEffort: "high",
      models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
    }],
  }]);
  assert.deepEqual(exportRevisions, [4]);
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
