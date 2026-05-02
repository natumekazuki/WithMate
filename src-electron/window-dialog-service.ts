import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from "electron";

import type { ModelCatalogDocument, ModelCatalogSnapshot } from "../src/model-catalog.js";

const MODEL_CATALOG_JSON_FILTER = [{ name: "JSON", extensions: ["json"] }];
const IMAGE_FILE_FILTER = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
];

export type WindowDialogServiceDeps = {
  showOpenDialog(
    targetWindow: BrowserWindow | undefined,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
  showSaveDialog(
    targetWindow: BrowserWindow | undefined,
    options: SaveDialogOptions,
  ): Promise<SaveDialogReturnValue>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  importModelCatalogDocument(document: ModelCatalogDocument): Promise<ModelCatalogSnapshot>;
  exportModelCatalogDocument(revision?: number | null): ModelCatalogDocument | null;
};

function buildDefaultPathOption(defaultPath: string | null | undefined): { defaultPath?: string } {
  return defaultPath ? { defaultPath } : {};
}

export class WindowDialogService {
  constructor(private readonly deps: WindowDialogServiceDeps) {}

  async pickDirectory(targetWindow?: BrowserWindow | null, initialPath?: string | null): Promise<string | null> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openDirectory"],
      title: "作業ディレクトリを選択",
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

  async pickFile(targetWindow?: BrowserWindow | null, initialPath?: string | null): Promise<string | null> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openFile"],
      title: "ファイルを選択",
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

  async pickImageFile(targetWindow?: BrowserWindow | null, initialPath?: string | null): Promise<string | null> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openFile"],
      title: "画像を選択",
      filters: [...IMAGE_FILE_FILTER],
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

  async importModelCatalogFromFile(targetWindow?: BrowserWindow | null): Promise<ModelCatalogSnapshot | null> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      title: "model catalog を読み込む",
      properties: ["openFile"],
      filters: [...MODEL_CATALOG_JSON_FILTER],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const raw = await this.deps.readTextFile(result.filePaths[0]);
    const document = JSON.parse(raw) as ModelCatalogDocument;
    return await this.deps.importModelCatalogDocument(document);
  }

  async exportModelCatalogToFile(
    revision: number | null | undefined,
    targetWindow?: BrowserWindow | null,
  ): Promise<string | null> {
    const document = this.deps.exportModelCatalogDocument(revision);
    if (!document) {
      return null;
    }

    const result = await this.deps.showSaveDialog(targetWindow ?? undefined, {
      title: "model catalog を保存",
      defaultPath: "model-catalog.json",
      filters: [...MODEL_CATALOG_JSON_FILTER],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }

    await this.deps.writeTextFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`);
    return result.filePath;
  }
}
