import type {
  BrowserWindow,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";

import type { ImageFilePickerPurpose } from "../../src-shared/window/withmate-window-types.js";

const IMAGE_FILE_FILTER = [
  {
    name: "Images",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
  },
];
const CHARACTER_ICON_FILE_FILTER = [
  { name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] },
];

/** ファイルやディレクトリを選ぶネイティブダイアログへの接続口。 */
export type WindowDialogServiceDeps = {
  /** 選択条件を渡してダイアログを開く。所有ウィンドウを省略することもできる。 */
  showOpenDialog(
    targetWindow: BrowserWindow | undefined,
    options: OpenDialogOptions,
  ): Promise<OpenDialogReturnValue>;
};

/** 空の初期パスでは defaultPath を指定せず、ネイティブダイアログの既定に任せる。 */
function buildDefaultPathOption(defaultPath: string | null | undefined): {
  defaultPath?: string;
} {
  return defaultPath ? { defaultPath } : {};
}

/** 選ぶ対象ごとのネイティブダイアログを開き、キャンセル時は選択結果を返さない。 */
export class WindowDialogService {
  /** 呼び出し先のダイアログ実装を保持する。 */
  constructor(private readonly deps: WindowDialogServiceDeps) {}

  /** 作業ディレクトリを一つ選ぶ。キャンセルや空の選択では null を返す。 */
  async pickDirectory(
    targetWindow?: BrowserWindow | null,
    initialPath?: string | null,
  ): Promise<string | null> {
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

  /** ファイルを一つ選ぶ。キャンセルや空の選択では null を返す。 */
  async pickFile(
    targetWindow?: BrowserWindow | null,
    initialPath?: string | null,
  ): Promise<string | null> {
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

  /** 複数ファイルの選択を許可し、キャンセル時は空配列を返す。 */
  async pickFiles(
    targetWindow?: BrowserWindow | null,
    initialPath?: string | null,
  ): Promise<string[]> {
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

  /** 用途別の画像フィルターで一つ選ぶ。Character アイコン用は PNG と JPEG に絞る。 */
  async pickImageFile(
    targetWindow?: BrowserWindow | null,
    initialPath?: string | null,
    purpose: ImageFilePickerPurpose = "general",
  ): Promise<string | null> {
    const characterIcon = purpose === "character-icon";
    const result = await this.deps.showOpenDialog(targetWindow ?? undefined, {
      properties: ["openFile"],
      title: characterIcon ? "Select Character Icon" : "Select Image",
      filters: [
        ...(characterIcon ? CHARACTER_ICON_FILE_FILTER : IMAGE_FILE_FILTER),
      ],
      ...buildDefaultPathOption(initialPath),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }
}
