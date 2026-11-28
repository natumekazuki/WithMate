import type {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  WebContents,
} from "electron";

import type {
  SessionFileDescriptor,
  SessionFilePreviewImageContextMenuResult,
  SessionFilePreviewImageCopyResult,
  SessionFilePreviewImagePoint,
  SessionImageResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

/** 表示中の画像を座標でコピーし、破棄済みかも確認できるコンテンツ。 */
type ImageCopyWebContents = Pick<WebContents, "copyImageAt" | "isDestroyed">;
/** 画像の座標に表示できるネイティブメニュー。 */
type ImageCopyMenu = Pick<Menu, "popup">;

/** ネイティブメニューと、パスをコピーする際のファイル確認・書き込みの依存先。 */
export type SessionFilePreviewImageCopyServiceDeps = {
  /** 画像またはパスをコピーするためのメニューを構築する。 */
  buildMenu(template: MenuItemConstructorOptions[]): ImageCopyMenu;
  /** 画像リソースからファイルの種別と絶対パスを解決する。 */
  inspectImage(
    request: SessionImageResourceRequest,
  ): Promise<Pick<SessionFileDescriptor, "kind" | "absoluteFilePath">>;
  /** 解決したパスをクリップボードのテキストとして書き込む。 */
  writeText(targetPath: string): void;
};

/** パスの解決に必要な画像リソースと、要求元を再確認する手段。 */
type ImagePathCopy = {
  request: SessionImageResourceRequest;
  /** この画像のパスを要求できる送信元であることを操作時に再確認する。 */
  assertSender(): Promise<void>;
};

const IMAGE_COPY_FAILED_MESSAGE = "Image could not be copied.";
const IMAGE_CONTEXT_MENU_FAILED_MESSAGE =
  "Image context menu could not be opened.";

/** 表示画像のコピーと、元ファイルのパスを文字列としてコピーする操作を区別して提供する。 */
export class SessionFilePreviewImageCopyService {
  /** メニューを開く処理と、画像のパスを検査して書き込む依存先を受け取る。 */
  constructor(private readonly deps: SessionFilePreviewImageCopyServiceDeps) {}

  /** 生存しているコンテンツ内の指定座標から画像をコピーし、Electron の例外は失敗結果に変換する。 */
  copyImage(
    webContents: ImageCopyWebContents,
    point: SessionFilePreviewImagePoint,
  ): SessionFilePreviewImageCopyResult {
    if (webContents.isDestroyed()) {
      return { status: "failed", message: IMAGE_COPY_FAILED_MESSAGE };
    }
    try {
      webContents.copyImageAt(point.x, point.y);
      return { status: "copied" };
    } catch {
      return { status: "failed", message: IMAGE_COPY_FAILED_MESSAGE };
    }
  }

  /** 画像コピーを提示し、元リソースが渡された場合はパスコピーも選べるようにする。 */
  showContextMenu(
    window: BrowserWindow | null,
    webContents: ImageCopyWebContents,
    point: SessionFilePreviewImagePoint,
    pathCopy?: ImagePathCopy,
  ): Promise<SessionFilePreviewImageContextMenuResult> {
    if (!window || webContents.isDestroyed()) {
      return Promise.resolve({
        status: "failed",
        message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE,
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let selectionStarted = false;
      /** 選択結果・取消・表示失敗のいずれかで一度だけ応答する。 */
      const settle = (result: SessionFilePreviewImageContextMenuResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      /** 最初の選択だけを実行し、非同期の結果が得られるまでメニュー閉鎖と区別する。 */
      const select = (
        action: () =>
          | SessionFilePreviewImageContextMenuResult
          | Promise<SessionFilePreviewImageContextMenuResult>,
      ) => {
        if (settled || selectionStarted) return;
        selectionStarted = true;
        void Promise.resolve(action()).then(settle);
      };

      try {
        const template: MenuItemConstructorOptions[] = [
          {
            label: "Copy Image",
            /** メニューを開いた位置の表示画像をコピーする。 */
            click: () => select(() => this.copyImage(webContents, point)),
          },
        ];
        if (pathCopy) {
          template.push({
            label: "Copy Path",
            /** 現在の画像リソースを再確認して絶対パスをコピーする。 */
            click: () =>
              select(() => this.copyImagePath(webContents, pathCopy)),
          });
        }
        const menu = this.deps.buildMenu(template);
        menu.popup({
          window,
          x: point.x,
          y: point.y,
          /** 操作が始まっていないメニュー閉鎖だけを取消として返す。 */
          callback: () => {
            if (!selectionStarted) settle({ status: "dismissed" });
          },
        });
      } catch {
        settle({
          status: "failed",
          message: IMAGE_CONTEXT_MENU_FAILED_MESSAGE,
        });
      }
    });
  }

  /** 画像の種別とパスを検査し、解決後も送信元とウィンドウが有効な場合にだけ書き込む。 */
  private async copyImagePath(
    webContents: ImageCopyWebContents,
    { request, assertSender }: ImagePathCopy,
  ): Promise<SessionFilePreviewImageContextMenuResult> {
    try {
      await assertSender();
      const descriptor = await this.deps.inspectImage(request);
      if (
        (descriptor.kind !== "image" && descriptor.kind !== "svg") ||
        /[\u0000-\u001f\u007f]/.test(descriptor.absoluteFilePath)
      ) {
        throw new Error("Image path is invalid.");
      }
      await assertSender();
      if (webContents.isDestroyed())
        throw new Error("Image window was closed.");
      this.deps.writeText(descriptor.absoluteFilePath);
      return { status: "copied-path" };
    } catch {
      return { status: "failed", message: "Image path could not be copied." };
    }
  }
}
