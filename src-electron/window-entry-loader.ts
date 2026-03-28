import path from "node:path";

export type WindowLike = {
  loadURL(url: string): Promise<unknown>;
  loadFile(filePath: string, options?: { search?: string }): Promise<unknown>;
};

export type HomeEntryMode = "home" | "monitor" | "settings";

export type WindowEntryLoaderDeps = {
  devServerUrl?: string | null;
  rendererDistPath: string;
};

export class WindowEntryLoader {
  constructor(private readonly deps: WindowEntryLoaderDeps) {}

  async loadHomeEntry(window: WindowLike, mode: HomeEntryMode = "home"): Promise<void> {
    const search = mode === "home" ? "" : `?mode=${mode}`;
    await this.load(window, "index.html", search);
  }

  async loadSessionEntry(window: WindowLike, sessionId: string): Promise<void> {
    const search = `?sessionId=${encodeURIComponent(sessionId)}`;
    await this.load(window, "session.html", search);
  }

  async loadCharacterEntry(window: WindowLike, characterId?: string | null): Promise<void> {
    const search = characterId
      ? `?characterId=${encodeURIComponent(characterId)}`
      : "?mode=create";
    await this.load(window, "character.html", search);
  }

  async loadDiffEntry(window: WindowLike, token: string): Promise<void> {
    const search = `?token=${encodeURIComponent(token)}`;
    await this.load(window, "diff.html", search);
  }

  private async load(window: WindowLike, entryFileName: string, search: string): Promise<void> {
    const { devServerUrl } = this.deps;
    if (devServerUrl) {
      const entryPath = entryFileName === "index.html" ? "" : `/${entryFileName}`;
      await window.loadURL(`${devServerUrl}${entryPath}${search}`);
      return;
    }

    const filePath = path.resolve(this.deps.rendererDistPath, entryFileName);
    await window.loadFile(filePath, search ? { search: search.slice(1) } : undefined);
  }
}
