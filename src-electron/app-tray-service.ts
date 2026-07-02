export type AppTrayMenuItem =
  | {
      label: string;
      click: () => void;
    }
  | {
      type: "separator";
    };

export type AppTrayWindowLike = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export type AppTrayLike = {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click" | "double-click", listener: () => void): void;
  destroy(): void;
  isDestroyed?(): boolean;
};

export type AppTrayServiceDeps = {
  platform: NodeJS.Platform;
  iconPath: string;
  createTray(iconPath: string): AppTrayLike;
  buildMenu(items: AppTrayMenuItem[]): unknown;
  openHomeWindow(): Promise<AppTrayWindowLike | null | undefined>;
  quitApp(): void;
};

export class AppTrayService {
  private tray: AppTrayLike | null = null;

  constructor(private readonly deps: AppTrayServiceDeps) {}

  initialize(): void {
    if (this.deps.platform !== "win32" || this.tray) {
      return;
    }

    const tray = this.deps.createTray(this.deps.iconPath);
    tray.setToolTip("WithMate");
    tray.setContextMenu(this.deps.buildMenu([
      {
        label: "WithMate を表示",
        click: () => {
          void this.showHomeWindow();
        },
      },
      { type: "separator" },
      {
        label: "終了",
        click: () => {
          this.deps.quitApp();
        },
      },
    ]));
    tray.on("click", () => {
      void this.showHomeWindow();
    });
    tray.on("double-click", () => {
      void this.showHomeWindow();
    });
    this.tray = tray;
  }

  dispose(): void {
    const tray = this.tray;
    this.tray = null;
    if (!tray || tray.isDestroyed?.()) {
      return;
    }

    tray.destroy();
  }

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
