import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { release } from "node:os";
import type {
  CreateTerminalRequest,
  CreateTerminalResult,
  TerminalEvent,
} from "../../src-shared/terminal/terminal-contract.js";
import { TERMINAL_MAX_DIMENSION } from "../../src-shared/terminal/terminal-contract.js";
import {
  createUtilityTerminalPty,
  type TerminalPty,
} from "./utility-terminal-pty.js";

const OUTPUT_HIGH_WATER = 100_000;
const OUTPUT_LOW_WATER = 20_000;

/** PTY を所有できる Session ウィンドウと、その renderer に通知する操作。 */
export type TerminalOwner = {
  id: number;
  /** ウィンドウが端末を操作できる状態かを確認する。 */
  isDestroyed(): boolean;
  webContents: {
    /** 通知や端末操作に使う WebContents がまだ存在するか確認する。 */
    isDestroyed(): boolean;
    /** Session の所有 renderer に端末イベントを渡す。 */
    send(channel: string, event: TerminalEvent): void;
    /** renderer の喪失や文書の置き換えを監視し、既存端末の所有権を解放できるようにする。 */
    on(
      event: "destroyed" | "render-process-gone" | "did-start-navigation",
      listener: (details: {
        isMainFrame?: boolean;
        isSameDocument?: boolean;
      }) => void,
    ): void;
  };
  /** ウィンドウの閉鎖後に端末と監視登録を片付ける。 */
  on(event: "closed", listener: () => void): void;
};

/** Session 所有者の解決、ネイティブ確認、シェル選択と PTY 起動への接続口。 */
export type TerminalServiceDeps<TWindow extends TerminalOwner> = {
  /** IPC の送信元に対応する Session ウィンドウと起動ディレクトリを解決する。 */
  resolveOwner(
    sender: unknown,
  ): { window: TWindow; sessionId: string; workspacePath: string } | null;
  /** 端末の作業が失われる可能性がある場合に閉鎖の可否をユーザーへ尋ねる。 */
  confirmClose(window: TWindow, signal: AbortSignal): Promise<boolean>;
  /** 作成された端末からのデータや終端を、指定の所有ウィンドウへ配送する。 */
  sendEvent(window: TWindow, event: TerminalEvent): void;
  /** 選んだシェルと作業ディレクトリで、取り消し可能な PTY を起動する。 */
  spawn(
    file: string,
    cwd: string,
    cols: number,
    rows: number,
    signal: AbortSignal,
  ): Promise<TerminalPty>;
  /** OS と環境に対応する実行可能シェルと、表示用情報を取得する。 */
  resolveShell(): Promise<CreateTerminalResult & { file: string }>;
};

/** ウィンドウに紐付く一つの端末の起動段階、購読、出力待機量と閉鎖試行を保持する。 */
type TerminalEntry<TWindow extends TerminalOwner> = {
  id: string;
  window: TWindow;
  sessionId: string;
  pty: TerminalPty | null;
  phase: "starting" | "running" | "exited" | "failed";
  subscriptions: Array<{
    /** この端末に登録した購読だけを解除する。 */ dispose(): void;
  }>;
  startAbort: AbortController;
  pendingCharacters: number;
  paused: boolean;
  closing: Promise<boolean> | null;
};

/** Session ウィンドウが所有する端末を登録し、入出力・終了確認と寿命を管理する。 */
export class TerminalService<TWindow extends TerminalOwner> {
  private readonly terminals = new Map<string, TerminalEntry<TWindow>>();
  private readonly watchedWindows = new Set<TWindow>();

  /** 所有者照合と PTY の生成・確認に使う接続を保持する。 */
  constructor(private readonly deps: TerminalServiceDeps<TWindow>) {}

  /** ID と寸法を検証して起動待ちの登録を作る。非同期起動中に所有者や登録が失効した端末は残さない。 */
  async create(
    sender: unknown,
    request: CreateTerminalRequest,
  ): Promise<CreateTerminalResult> {
    if (
      !request ||
      !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        request.terminalId,
      )
    ) {
      throw new TypeError("Terminal ID must be a UUID.");
    }
    this.assertSize(request.cols, request.rows);
    const owner = this.requireOwner(sender);
    if (this.terminals.has(request.terminalId))
      throw new Error("Terminal ID already exists.");
    const entry: TerminalEntry<TWindow> = {
      id: request.terminalId,
      window: owner.window,
      sessionId: owner.sessionId,
      pty: null,
      phase: "starting",
      pendingCharacters: 0,
      paused: false,
      closing: null,
      subscriptions: [],
      startAbort: new AbortController(),
    };
    this.terminals.set(entry.id, entry);
    this.watchWindow(owner.window);
    try {
      const shell = await this.deps.resolveShell();
      if (!this.isCurrent(entry, sender))
        throw new Error("Terminal creation was cancelled.");
      const pty = await this.deps.spawn(
        shell.file,
        owner.workspacePath,
        request.cols,
        request.rows,
        entry.startAbort.signal,
      );
      if (!this.isCurrent(entry, sender)) {
        pty.kill();
        throw new Error("Terminal creation was cancelled.");
      }
      entry.pty = pty;
      entry.phase = "running";
      entry.subscriptions.push(pty.onData((data) => this.onData(entry, data)));
      entry.subscriptions.push(
        pty.onExit(({ exitCode, signal }) =>
          this.onExit(entry, exitCode, signal),
        ),
      );
      entry.subscriptions.push(pty.onError((error) => this.fail(entry, error)));
      return {
        shellName: shell.shellName,
        ...(shell.windowsPty ? { windowsPty: shell.windowsPty } : {}),
      };
    } catch (error) {
      if (this.terminals.get(entry.id) === entry) entry.phase = "failed";
      throw error;
    }
  }

  /** 所有者と入力の上限を検証し、実行中の端末だけにキー入力を送る。 */
  write(sender: unknown, terminalId: string, data: string): void {
    const entry = this.requireEntry(sender, terminalId);
    if (typeof data !== "string" || data.length > 65_536)
      throw new TypeError("Terminal input is invalid.");
    if (entry.phase === "running") {
      try {
        entry.pty?.write(data);
      } catch (error) {
        this.fail(entry, error);
      }
    }
  }

  /** 寸法と所有者を検証し、実行中の端末の表示行・列を更新する。 */
  resize(
    sender: unknown,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    this.assertSize(cols, rows);
    const entry = this.requireEntry(sender, terminalId);
    if (entry.phase === "running") {
      try {
        entry.pty?.resize(cols, rows);
      } catch (error) {
        this.fail(entry, error);
      }
    }
  }

  /** 受信確認した出力の文字数を減らし、待ちが下限まで減った場合に停止していた出力を再開する。 */
  acknowledge(sender: unknown, terminalId: string, characters: number): void {
    const entry = this.requireEntry(sender, terminalId);
    if (
      !Number.isSafeInteger(characters) ||
      characters < 0 ||
      characters > entry.pendingCharacters
    ) {
      throw new TypeError("Terminal output acknowledgment is invalid.");
    }
    entry.pendingCharacters -= characters;
    if (entry.paused && entry.pendingCharacters <= OUTPUT_LOW_WATER) {
      entry.paused = false;
      try {
        entry.pty?.resume();
      } catch (error) {
        this.fail(entry, error);
      }
    }
  }

  /** 重複する閉鎖要求で確認を共有する。対象がない場合は既に閉鎖済みとして扱う。 */
  async close(sender: unknown, terminalId: string): Promise<boolean> {
    const entry = this.findEntry(sender, terminalId);
    if (!entry) return true;
    if (entry.closing) return entry.closing;
    const closing = this.closeEntry(entry);
    entry.closing = closing;
    try {
      return await closing;
    } finally {
      entry.closing = null;
    }
  }

  /** 入力待ちと確定できない現役端末では確認を待ち、許可された場合だけ解放する。 */
  private async closeEntry(entry: TerminalEntry<TWindow>): Promise<boolean> {
    if (
      this.requiresCloseConfirmation(entry) &&
      !(await this.deps.confirmClose(entry.window, entry.startAbort.signal))
    )
      return false;
    this.releaseEntry(entry);
    return true;
  }

  /** 起動中または実行中で明確な入力待ちではない端末は、閉鎖に確認を要する。 */
  private requiresCloseConfirmation(entry: TerminalEntry<TWindow>): boolean {
    return (
      entry.phase === "starting" ||
      (entry.phase === "running" && entry.pty?.getActivity() !== "idle")
    );
  }

  /** 所有ウィンドウによる明示的な解放を受け、対話的な閉鎖確認なしで端末を片付ける。 */
  release(sender: unknown, terminalId: string): void {
    const entry = this.findEntry(sender, terminalId);
    if (entry) this.releaseEntry(entry);
  }

  /** 指定ウィンドウに属する端末を解放する。個別の停止失敗で後続を打ち切らない。 */
  releaseWindow(window: TWindow): void {
    for (const entry of this.terminals.values()) {
      if (entry.window === window) {
        try {
          this.releaseEntry(entry);
        } catch (error) {
          console.error(
            "Terminal PTY failed to stop on Window cleanup:",
            error,
          );
        }
      }
    }
  }

  /** 指定 Session に属する端末だけを解放し、別 Session の端末を維持する。 */
  releaseSession(sessionId: string): void {
    for (const entry of this.terminals.values()) {
      if (entry.sessionId === sessionId) {
        try {
          this.releaseEntry(entry);
        } catch (error) {
          console.error(
            "Terminal PTY failed to stop on Session cleanup:",
            error,
          );
        }
      }
    }
  }

  /** アプリの終了時に、保持している端末すべての解放を試みる。 */
  releaseAll(): void {
    for (const entry of this.terminals.values()) {
      try {
        this.releaseEntry(entry);
      } catch (error) {
        console.error("Terminal PTY failed to stop on app exit:", error);
      }
    }
  }

  /** 指定ウィンドウで起動中または実行中の端末を数える。 */
  countLive(window: TWindow): number {
    let count = 0;
    for (const entry of this.terminals.values()) {
      if (
        entry.window === window &&
        (entry.phase === "starting" || entry.phase === "running")
      )
        count++;
    }
    return count;
  }

  /** 一括閉鎖前に比較できるよう、起動中・実行中の端末の識別子と確認要否を返す。 */
  getWindowCloseImpacts(
    window: TWindow,
  ): { identity: object; requiresConfirmation: boolean }[] {
    return [...this.terminals.values()].flatMap((entry) =>
      entry.window === window &&
      (entry.phase === "starting" || entry.phase === "running")
        ? [
            {
              identity: entry.startAbort,
              requiresConfirmation: this.requiresCloseConfirmation(entry),
            },
          ]
        : [],
    );
  }

  /** 所有ウィンドウのうち、閉鎖確認が必要な端末だけを数える。 */
  countRequiringCloseConfirmation(window: TWindow): number {
    let count = 0;
    for (const entry of this.terminals.values()) {
      if (entry.window === window && this.requiresCloseConfirmation(entry))
        count++;
    }
    return count;
  }

  /** 現在の所有 renderer へ出力し、未確認文字数が上限に達したら出力を保留する。 */
  private onData(entry: TerminalEntry<TWindow>, data: string): void {
    if (
      this.terminals.get(entry.id) !== entry ||
      entry.window.webContents.isDestroyed()
    )
      return;
    entry.pendingCharacters += data.length;
    try {
      this.deps.sendEvent(entry.window, {
        type: "data",
        terminalId: entry.id,
        data,
      });
    } catch (error) {
      this.fail(entry, error);
      return;
    }
    if (entry.pendingCharacters >= OUTPUT_HIGH_WATER && !entry.paused) {
      entry.paused = true;
      try {
        entry.pty?.pause();
      } catch (error) {
        this.fail(entry, error);
      }
    }
  }

  /** 終了した現在の端末から PTY と購読を外し、renderer が残っていれば終了結果を伝える。 */
  private onExit(
    entry: TerminalEntry<TWindow>,
    exitCode: number,
    signal?: number,
  ): void {
    if (this.terminals.get(entry.id) !== entry) return;
    entry.phase = "exited";
    entry.pty = null;
    entry.paused = false;
    this.disposeSubscriptions(entry);
    if (!entry.window.webContents.isDestroyed()) {
      this.deps.sendEvent(entry.window, {
        type: "exit",
        terminalId: entry.id,
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  /** 登録が一致する場合だけ起動を取り消し、PTY と購読を解放して登録を除く。 */
  private releaseEntry(entry: TerminalEntry<TWindow>): void {
    if (this.terminals.get(entry.id) !== entry) return;
    const pty = entry.pty;
    entry.startAbort.abort();
    if (pty) pty.kill();
    this.terminals.delete(entry.id);
    entry.pty = null;
    this.disposeSubscriptions(entry);
  }

  /** 送信元に対応する有効な Session ウィンドウがなければ IPC を拒否する。 */
  private requireOwner(sender: unknown) {
    const owner = this.deps.resolveOwner(sender);
    if (
      !owner ||
      owner.window.isDestroyed() ||
      owner.window.webContents.isDestroyed()
    ) {
      throw new Error("Terminal IPC requires an owning Session Window.");
    }
    return owner;
  }

  /** 所有端末を必須とする操作で、端末が既にない場合も拒否する。 */
  private requireEntry(
    sender: unknown,
    terminalId: string,
  ): TerminalEntry<TWindow> {
    const entry = this.findEntry(sender, terminalId);
    if (!entry) {
      throw new Error("Terminal does not belong to this Session Window.");
    }
    return entry;
  }

  /** 端末がなければ null を返す。ただし登録が別ウィンドウや Session のものなら拒否する。 */
  private findEntry(
    sender: unknown,
    terminalId: string,
  ): TerminalEntry<TWindow> | null {
    const owner = this.requireOwner(sender);
    const entry = this.terminals.get(terminalId);
    if (!entry) return null;
    if (entry.window !== owner.window || entry.sessionId !== owner.sessionId) {
      throw new Error("Terminal does not belong to this Session Window.");
    }
    return entry;
  }

  /** 現在の端末を失敗状態に移し、購読と PTY を片付けて所有 renderer にエラーを通知する。 */
  private fail(entry: TerminalEntry<TWindow>, error: unknown): void {
    if (this.terminals.get(entry.id) !== entry) return;
    const pty = entry.pty;
    entry.pty = null;
    entry.phase = "failed";
    this.disposeSubscriptions(entry);
    if (pty) {
      try {
        pty.kill();
      } catch (killError) {
        console.error("Terminal PTY failed to stop after an error:", killError);
      }
    }
    if (!entry.window.webContents.isDestroyed()) {
      this.deps.sendEvent(entry.window, {
        type: "error",
        terminalId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 端末に紐付く購読を取り除き、同じ購読の解除を重ねない。 */
  private disposeSubscriptions(entry: TerminalEntry<TWindow>): void {
    for (const subscription of entry.subscriptions.splice(0))
      subscription.dispose();
  }

  /** 非同期起動後も、端末の登録と送信元のウィンドウ・Session の対応が維持されているか照合する。 */
  private isCurrent(entry: TerminalEntry<TWindow>, sender: unknown): boolean {
    if (this.terminals.get(entry.id) !== entry) return false;
    const owner = this.deps.resolveOwner(sender);
    return (
      owner?.window === entry.window &&
      owner.sessionId === entry.sessionId &&
      !entry.window.isDestroyed() &&
      !entry.window.webContents.isDestroyed()
    );
  }

  /** 監視を一度だけ登録し、閉鎖や renderer の喪失、メインフレーム文書の遷移時に所有端末を解放する。 */
  private watchWindow(window: TWindow): void {
    if (this.watchedWindows.has(window)) return;
    this.watchedWindows.add(window);
    window.on("closed", () => {
      this.releaseWindow(window);
      this.watchedWindows.delete(window);
    });
    window.webContents.on("destroyed", () => this.releaseWindow(window));
    window.webContents.on("render-process-gone", () =>
      this.releaseWindow(window),
    );
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument)
        this.releaseWindow(window);
    });
  }

  /** 行と列が許容範囲にある整数か確認し、不正な寸法を PTY に渡さない。 */
  private assertSize(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      cols < 1 ||
      cols > TERMINAL_MAX_DIMENSION ||
      !Number.isInteger(rows) ||
      rows < 1 ||
      rows > TERMINAL_MAX_DIMENSION
    ) {
      throw new TypeError("Terminal size is invalid.");
    }
  }
}

/** ドライブのない Windows のルート付きパスを除外し、完全修飾された絶対パスだけを認める。 */
function isFullyQualifiedWindowsPath(directory: string): boolean {
  // isAbsolute は、区切り文字だけをルートとする現在のドライブ上のパスも受け付ける。
  return (
    path.win32.isAbsolute(directory) &&
    path.win32.parse(directory).root.length > 1
  );
}

/** Windows では PowerShell 7 を優先し、候補がない場合に限り Windows PowerShell へ進む。macOS では zsh を使う。 */
export async function resolveTerminalShell(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  accessFile: typeof access = access,
): Promise<CreateTerminalResult & { file: string }> {
  if (platform === "win32") {
    const candidates = (env.PATH ?? env.Path ?? "")
      .split(";")
      .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
      .filter(isFullyQualifiedWindowsPath)
      .map((directory) => path.win32.join(directory, "pwsh.exe"));
    if (env.ProgramFiles && isFullyQualifiedWindowsPath(env.ProgramFiles)) {
      candidates.push(
        path.win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"),
      );
    }
    if (env.SystemRoot && isFullyQualifiedWindowsPath(env.SystemRoot)) {
      candidates.push(
        path.win32.join(
          env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      );
    }
    for (const file of candidates) {
      try {
        await accessFile(file, constants.X_OK);
        return {
          file,
          shellName: "PowerShell",
          windowsPty: { buildNumber: Number(release().split(".")[2]) },
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    throw new Error(
      "Neither PowerShell 7 (pwsh.exe) nor Windows PowerShell (powershell.exe) was found.",
    );
  }
  if (platform === "darwin") {
    await accessFile("/bin/zsh", constants.X_OK);
    return { file: "/bin/zsh", shellName: "zsh" };
  }
  throw new Error(`Embedded Terminal is not supported on ${platform}.`);
}

/** 選択したシェルを、指定寸法・ディレクトリと取消シグナルで端末用の子プロセスに起動させる。 */
export async function spawnTerminalPty(
  file: string,
  cwd: string,
  cols: number,
  rows: number,
  signal: AbortSignal,
): Promise<TerminalPty> {
  return createUtilityTerminalPty(file, cwd, cols, rows, signal);
}
