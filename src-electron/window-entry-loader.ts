import path from "node:path";

export type WindowLike = {
  loadURL(url: string): Promise<unknown>;
  loadFile(filePath: string, options?: { search?: string }): Promise<unknown>;
};

export type HomeEntryMode = "home" | "monitor" | "settings" | "memory-review";
export type ChatEntryMode =
  | { kind: "agent"; sessionId: string }
  | { kind: "companion"; sessionId: string };

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

  async loadBootEntry(window: WindowLike): Promise<void> {
    await this.load(window, "boot.html", "");
  }

  async loadDiffEntry(window: WindowLike, token: string): Promise<void> {
    const search = `?token=${encodeURIComponent(token)}`;
    await this.load(window, "diff.html", search);
  }

  async loadChatEntry(window: WindowLike, mode: ChatEntryMode): Promise<void> {
    await this.load(window, "session.html", buildChatEntrySearch(mode));
  }

  async loadCompanionMergeReviewEntry(window: WindowLike, sessionId: string): Promise<void> {
    const search = `?companionSessionId=${encodeURIComponent(sessionId)}&view=merge`;
    await this.load(window, "review.html", search);
  }

  async loadCharacterEditorEntry(window: WindowLike, characterId?: string | null): Promise<void> {
    const normalizedCharacterId = characterId?.trim() ?? "";
    const search = normalizedCharacterId ? `?characterId=${encodeURIComponent(normalizedCharacterId)}` : "";
    await this.load(window, "character-editor.html", search);
  }

  private async load(window: WindowLike, entryFileName: string, search: string): Promise<void> {
    const { devServerUrl } = this.deps;
    if (devServerUrl) {
      const entryPath = entryFileName === "index.html" ? "" : `/${entryFileName}`;
      await window.loadURL(`${devServerUrl}${entryPath}${search}`);
      return;
    }

    const rendererDistPath = this.deps.rendererDistPath.trim();
    const filePath =
      /^[a-zA-Z]:[\\/]/.test(rendererDistPath) || /^\\\\[^\\]+\\[^\\]+/.test(rendererDistPath)
        ? path.win32.resolve(rendererDistPath, entryFileName)
        : path.resolve(rendererDistPath, entryFileName);
    await window.loadFile(filePath, search ? { search } : undefined);
  }
}

export function buildChatEntrySearch(mode: ChatEntryMode): string {
  if (mode.kind === "agent") {
    return `?sessionId=${encodeURIComponent(mode.sessionId)}`;
  }
  if (mode.kind === "companion") {
    return `?companionSessionId=${encodeURIComponent(mode.sessionId)}&mode=companion`;
  }
  throw new Error(`Unsupported chat entry mode: ${(mode as { kind: string }).kind}`);
}
