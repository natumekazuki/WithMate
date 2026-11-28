import path from "node:path";

/** renderer を開くために必要な Electron ウィンドウの読み込み操作。 */
export type WindowLike = {
  /** 開発サーバーの URL とクエリからページを読み込む。 */
  loadURL(url: string): Promise<unknown>;
  /** ビルド済みのファイルを読み込み、必要ならクエリを渡す。 */
  loadFile(filePath: string, options?: { search?: string }): Promise<unknown>;
};

/** index.html を Home、監視、設定のいずれとして開くかを指定する。 */
export type HomeEntryMode = "home" | "monitor" | "settings";
/** 会話画面が開く Main Session と、必要に応じて選択する Auxiliary の ID。 */
export type ChatEntryMode = {
  kind: "agent";
  sessionId: string;
  auxiliarySessionId?: string | null;
};

/** 開発用 URL がある場合はそれを使い、なければ renderer の配布ディレクトリから読み込むための設定。 */
export type WindowEntryLoaderDeps = {
  devServerUrl?: string | null;
  rendererDistPath: string;
};

/** 各ウィンドウで開く renderer 文書と、その初期表示を指定するクエリを組み立てる。 */
export class WindowEntryLoader {
  /** 読み込み先の設定を保持する。この時点では文書を開かない。 */
  constructor(private readonly deps: WindowEntryLoaderDeps) {}

  /** index.html を開く。監視と設定では mode を渡し、既定の Home では省略する。 */
  async loadHomeEntry(
    window: WindowLike,
    mode: HomeEntryMode = "home",
  ): Promise<void> {
    const search = mode === "home" ? "" : `?mode=${mode}`;
    await this.load(window, "index.html", search);
  }

  /** 通常画面とは別の起動進捗ページを、クエリなしで開く。 */
  async loadBootEntry(window: WindowLike): Promise<void> {
    await this.load(window, "boot.html", "");
  }

  /** 比較対象の本文を URL に含めず、差分参照のトークンを渡して開く。 */
  async loadDiffEntry(window: WindowLike, token: string): Promise<void> {
    const search = `?token=${encodeURIComponent(token)}`;
    await this.load(window, "diff.html", search);
  }

  /** ファイルプレビューに、表示データの参照に使うトークンを渡す。 */
  async loadFilePreviewEntry(window: WindowLike, token: string): Promise<void> {
    const search = `?token=${encodeURIComponent(token)}`;
    await this.load(window, "file-preview.html", search);
  }

  /** リポジトリや実行主体の識別情報を URL に渡さず、隔離された PR renderer を読み込む。 */
  async loadLocalPrEntry(window: WindowLike): Promise<void> {
    await this.load(window, "local-pr.html", "");
  }

  /** Session ページを開き、指定された Main と Auxiliary の表示先をクエリで渡す。 */
  async loadChatEntry(window: WindowLike, mode: ChatEntryMode): Promise<void> {
    await this.load(window, "session.html", buildChatEntrySearch(mode));
  }

  /** Character エディターを開く。ID を指定した編集モードでだけクエリを付ける。 */
  async loadCharacterEditorEntry(
    window: WindowLike,
    characterId?: string | null,
  ): Promise<void> {
    const normalizedCharacterId = characterId?.trim() ?? "";
    const search = normalizedCharacterId
      ? `?characterId=${encodeURIComponent(normalizedCharacterId)}`
      : "";
    await this.load(window, "character-editor.html", search);
  }

  /** 開発時はサーバーの URL、配布時はローカルファイルを使う。Windows の絶対パスは Windows の規則で解決する。 */
  private async load(
    window: WindowLike,
    entryFileName: string,
    search: string,
  ): Promise<void> {
    const { devServerUrl } = this.deps;
    if (devServerUrl) {
      const entryPath =
        entryFileName === "index.html" ? "" : `/${entryFileName}`;
      await window.loadURL(`${devServerUrl}${entryPath}${search}`);
      return;
    }

    const rendererDistPath = this.deps.rendererDistPath.trim();
    const filePath =
      /^[a-zA-Z]:[\\/]/.test(rendererDistPath) ||
      /^\\\\[^\\]+\\[^\\]+/.test(rendererDistPath)
        ? path.win32.resolve(rendererDistPath, entryFileName)
        : path.resolve(rendererDistPath, entryFileName);
    await window.loadFile(filePath, search ? { search } : undefined);
  }
}

/** Main Session の ID をエンコードし、空でない Auxiliary ID があればクエリに追加する。 */
export function buildChatEntrySearch(mode: ChatEntryMode): string {
  const auxiliarySessionQuery = mode.auxiliarySessionId?.trim()
    ? `&auxiliarySessionId=${encodeURIComponent(mode.auxiliarySessionId.trim())}`
    : "";
  if (mode.kind === "agent") {
    return `?sessionId=${encodeURIComponent(mode.sessionId)}${auxiliarySessionQuery}`;
  }
  return `?sessionId=${encodeURIComponent(mode.sessionId)}${auxiliarySessionQuery}`;
}
