import assert from "node:assert/strict";
import test from "node:test";

import { WindowDialogService } from "../../src-electron/windows/window-dialog-service.js";

// @test-value v2
// kind = "contract"
// claim = "WindowDialogServiceがdirectory、file、image pickerへ役割に合うtitleを付け、選択結果を返す"
// oracle = { type = "contract", ref = "src-electron/windows/window-dialog-service.ts" }
// fault = "dialogのtitleを取り違えるか、選択pathを変換・欠落させる"
// observable = "dialogのtitleを含む呼出し引数と各pickerの戻り値"
// observation_boundary = "public-boundary"
// scope = "window-dialog-service"
// lifecycle = "permanent"
// @end-test-value
test("WindowDialogService は directory / file / image picker の選択結果を返す", async () => {
  const calls: Array<{ kind: "open"; options: unknown }> = [];
  const service = new WindowDialogService({
    async showOpenDialog(_targetWindow, options) {
      calls.push({ kind: "open", options });
      if ((options as { title?: string }).title === "Select Working Directory") {
        return { canceled: false, filePaths: ["C:/workspace"] };
      }
      const title = (options as { title?: string }).title;
      if (title?.includes("Icon") || title === "Select Image") {
        return { canceled: false, filePaths: ["C:/images/a.png"] };
      }
      if ((options as { properties?: string[] }).properties?.includes("multiSelections")) {
        return { canceled: false, filePaths: ["C:/file-a.txt", "C:/file-b.txt"] };
      }
      return { canceled: false, filePaths: ["C:/file.txt"] };
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
    "Select Working Directory",
    "Select File",
    "Select Files",
    "Select Image",
    "Select Character Icon",
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
// claim = "WindowDialogServiceはopen dialogのcancelをnullまたは空配列へ変換する"
// oracle = { type = "contract", ref = "src-electron/windows/window-dialog-service.ts picker cancellation" }
// fault = "cancel結果を選択済みpathとして返す"
// observable = "各pickerのcancel戻り値"
// observation_boundary = "public-boundary"
// scope = "window-dialog-service-cancel"
// lifecycle = "permanent"
// @end-test-value
test("WindowDialogService は open dialog の cancel を null として返す", async () => {
  const service = new WindowDialogService({
    async showOpenDialog() {
      return { canceled: true, filePaths: [] };
    },
  });

  assert.equal(await service.pickDirectory(undefined, "C:/seed"), null);
  assert.equal(await service.pickFile(), null);
  assert.deepEqual(await service.pickFiles(), []);
  assert.equal(await service.pickImageFile(), null);
});
