import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from "electron";

import type { ImageFilePickerPurpose } from "../../src-shared/window/withmate-window-types.js";

const IMAGE_FILE_FILTER = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
];
const CHARACTER_ICON_FILE_FILTER = [
  { name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] },
];

export type WindowDialogServiceDeps = {
  showOpenDialog(
    targetWindow: BrowserWindow | undefined,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
};

function buildDefaultPathOption(defaultPath: string | null | undefined): { defaultPath?: string } {
  return defaultPath ? { defaultPath } : {};
}

export class WindowDialogService {
  constructor(private readonly deps: WindowDialogServiceDeps) {}

  async pickDirectory(targetWindow?: BrowserWindow | null, initialPath?: string | null): Promise<string | null> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openDirectory"],
      title: "Select Working Directory",
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
      title: "Select File",
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

  async pickFiles(targetWindow?: BrowserWindow | null, initialPath?: string | null): Promise<string[]> {
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openFile", "multiSelections"],
      title: "Select Files",
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return [...result.filePaths];
  }

  async pickImageFile(
    targetWindow?: BrowserWindow | null,
    initialPath?: string | null,
    purpose: ImageFilePickerPurpose = "general",
  ): Promise<string | null> {
    const characterIcon = purpose === "character-icon";
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openFile"],
      title: characterIcon ? "Select Character Icon" : "Select Image",
      filters: [...(characterIcon ? CHARACTER_ICON_FILE_FILTER : IMAGE_FILE_FILTER)],
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

}
