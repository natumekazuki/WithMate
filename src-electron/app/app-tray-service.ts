/** トレイメニューを構成する実行項目または区切り。 */
export type AppTrayMenuItem =
  | {
      label: string;
      click: () => void;
    }
  | {
      type: "separator";
    };

/** トレイ操作から既存の Home を前面に戻すためのウィンドウ操作。 */
export type AppTrayWindowLike = {
  /** 非同期で Home を取得した後、まだ操作できるか判定する。 */
  isDestroyed(): boolean;
  /** 表示前に最小化を解除する必要があるか判定する。 */
  isMinimized(): boolean;
  /** 最小化された Home を通常の表示状態に戻す。 */
  restore(): void;
  /** Home を可視にする。 */
  show(): void;
  /** 表示済みの Home に入力フォーカスを移す。 */
  focus(): void;
};

/** トレイの表示、ユーザー操作の受信、解放に使うネイティブ操作。 */
export type AppTrayLike = {
  /** ポインターを合わせた際の製品名を設定する。 */
  setToolTip(toolTip: string): void;
  /** Home 表示と終了に使うコンテキストメニューを設定する。 */
  setContextMenu(menu: unknown): void;
  /** トレイアイコンのクリックまたはダブルクリックにリスナーを登録する。 */
  on(event: "click" | "double-click", listener: () => void): void;
  /** ネイティブのトレイアイコンとイベント登録を解放する。 */
  destroy(): void;
  /** トレイが外部で既に解放されているか確認する。未提供の場合はこの確認を省く。 */
  isDestroyed?(): boolean;
};

/** OS の判定とトレイの組み立てに使う設定、および Home と終了のアプリ操作。 */
export type AppTrayServiceDeps = {
  platform: NodeJS.Platform;
  iconPath: string;
  /** 指定したアイコンを表示するネイティブトレイを作る。 */
  createTray(iconPath: string): AppTrayLike;
  /** アプリのメニュー項目をネイティブトレイに渡せるメニューへ変換する。 */
  buildMenu(items: AppTrayMenuItem[]): unknown;
  /** Home を開き、前面表示できるウィンドウがある場合に返す。 */
  openHomeWindow(): Promise<AppTrayWindowLike | null | undefined>;
  /** トレイから通常のアプリ終了経路に入る。 */
  quitApp(): void;
};

/** Windows でトレイアイコンを一つ保持し、Home の再表示とアプリ終了を受け付ける。 */
export class AppTrayService {
  private tray: AppTrayLike | null = null;

  /** トレイの生成とアプリ操作を受け取る。アイコンは初期化まで作らない。 */
  constructor(private readonly deps: AppTrayServiceDeps) {}

  /** Windows で未作成の場合にだけ、アイコン、メニュー、クリック処理を組み立てる。 */
  initialize(): void {
    if (this.deps.platform !== "win32" || this.tray) {
      return;
    }

    const tray = this.deps.createTray(this.deps.iconPath);
    tray.setToolTip("WithMate");
    tray.setContextMenu(
      this.deps.buildMenu([
        {
          label: "Show WithMate",
          /** メニュー操作で Home の前面表示を開始する。 */
          click: () => {
            void this.showHomeWindow();
          },
        },
        { type: "separator" },
        {
          label: "Quit",
          /** トレイだけを消さず、アプリ全体の終了を要求する。 */
          click: () => {
            this.deps.quitApp();
          },
        },
      ]),
    );
    tray.on("click", () => {
      void this.showHomeWindow();
    });
    tray.on("double-click", () => {
      void this.showHomeWindow();
    });
    this.tray = tray;
  }

  /** 現在のトレイを手放す。作成前や既に破棄済みの場合はネイティブを操作しない。 */
  dispose(): void {
    const tray = this.tray;
    this.tray = null;
    if (!tray || tray.isDestroyed?.()) {
      return;
    }

    tray.destroy();
  }

  /** 操作可能な Home を取得し、最小化を解除してから表示とフォーカスを行う。 */
  private async showHomeWindow(): Promise<void> {
    const window = await this.deps.openHomeWindow();
    if (!window || window.isDestroyed()) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
}
