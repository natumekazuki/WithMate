import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { release } from "node:os";
import type { CreateTerminalRequest, CreateTerminalResult, TerminalEvent } from "../../src-shared/terminal/terminal-contract.js";
import { createUtilityTerminalPty, type TerminalPty } from "./utility-terminal-pty.js";

const OUTPUT_HIGH_WATER = 100_000;
const OUTPUT_LOW_WATER = 20_000;

export type TerminalOwner = {
  id: number;
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, event: TerminalEvent): void;
    on(event: "destroyed" | "render-process-gone" | "did-start-navigation", listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): void;
  };
  on(event: "closed", listener: () => void): void;
};

export type TerminalServiceDeps<TWindow extends TerminalOwner> = {
  resolveOwner(sender: unknown): { window: TWindow; sessionId: string; workspacePath: string } | null;
  confirmClose(window: TWindow): boolean;
  sendEvent(window: TWindow, event: TerminalEvent): void;
  spawn(file: string, cwd: string, cols: number, rows: number, signal: AbortSignal): Promise<TerminalPty>;
  resolveShell(): Promise<CreateTerminalResult & { file: string }>;
};

type TerminalEntry<TWindow extends TerminalOwner> = {
  id: string;
  window: TWindow;
  sessionId: string;
  pty: TerminalPty | null;
  phase: "starting" | "running" | "exited" | "failed";
  subscriptions: Array<{ dispose(): void }>;
  startAbort: AbortController;
  pendingCharacters: number;
  paused: boolean;
};

export class TerminalService<TWindow extends TerminalOwner> {
  private readonly terminals = new Map<string, TerminalEntry<TWindow>>();
  private readonly watchedWindows = new Set<TWindow>();

  constructor(private readonly deps: TerminalServiceDeps<TWindow>) {}

  async create(sender: unknown, request: CreateTerminalRequest): Promise<CreateTerminalResult> {
    if (!request || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(request.terminalId)) {
      throw new TypeError("Terminal ID must be a UUID.");
    }
    this.assertSize(request.cols, request.rows);
    const owner = this.requireOwner(sender);
    if (this.terminals.has(request.terminalId)) throw new Error("Terminal ID already exists.");
    const entry: TerminalEntry<TWindow> = {
      id: request.terminalId,
      window: owner.window,
      sessionId: owner.sessionId,
      pty: null,
      phase: "starting",
      pendingCharacters: 0,
      paused: false,
      subscriptions: [],
      startAbort: new AbortController(),
    };
    this.terminals.set(entry.id, entry);
    this.watchWindow(owner.window);
    try {
      const shell = await this.deps.resolveShell();
      if (!this.isCurrent(entry, sender)) throw new Error("Terminal creation was cancelled.");
      const pty = await this.deps.spawn(shell.file, owner.workspacePath, request.cols, request.rows, entry.startAbort.signal);
      if (!this.isCurrent(entry, sender)) {
        pty.kill();
        throw new Error("Terminal creation was cancelled.");
      }
      entry.pty = pty;
      entry.phase = "running";
      entry.subscriptions.push(pty.onData((data) => this.onData(entry, data)));
      entry.subscriptions.push(pty.onExit(({ exitCode, signal }) => this.onExit(entry, exitCode, signal)));
      entry.subscriptions.push(pty.onError((error) => this.fail(entry, error)));
      return { shellName: shell.shellName, ...(shell.windowsPty ? { windowsPty: shell.windowsPty } : {}) };
    } catch (error) {
      if (this.terminals.get(entry.id) === entry) entry.phase = "failed";
      throw error;
    }
  }

  write(sender: unknown, terminalId: string, data: string): void {
    const entry = this.requireEntry(sender, terminalId);
    if (typeof data !== "string" || data.length > 65_536) throw new TypeError("Terminal input is invalid.");
    if (entry.phase === "running") {
      try { entry.pty?.write(data); }
      catch (error) { this.fail(entry, error); }
    }
  }

  resize(sender: unknown, terminalId: string, cols: number, rows: number): void {
    this.assertSize(cols, rows);
    const entry = this.requireEntry(sender, terminalId);
    if (entry.phase === "running") {
      try { entry.pty?.resize(cols, rows); }
      catch (error) { this.fail(entry, error); }
    }
  }

  acknowledge(sender: unknown, terminalId: string, characters: number): void {
    const entry = this.requireEntry(sender, terminalId);
    if (!Number.isSafeInteger(characters) || characters < 0 || characters > entry.pendingCharacters) {
      throw new TypeError("Terminal output acknowledgment is invalid.");
    }
    entry.pendingCharacters -= characters;
    if (entry.paused && entry.pendingCharacters <= OUTPUT_LOW_WATER) {
      entry.paused = false;
      try { entry.pty?.resume(); }
      catch (error) { this.fail(entry, error); }
    }
  }

  close(sender: unknown, terminalId: string): boolean {
    const entry = this.findEntry(sender, terminalId);
    if (!entry) return true;
    if ((entry.phase === "running" || entry.phase === "starting") && !this.deps.confirmClose(entry.window)) return false;
    this.releaseEntry(entry);
    return true;
  }

  release(sender: unknown, terminalId: string): void {
    const entry = this.findEntry(sender, terminalId);
    if (entry) this.releaseEntry(entry);
  }

  releaseWindow(window: TWindow): void {
    for (const entry of this.terminals.values()) {
      if (entry.window === window) {
        try { this.releaseEntry(entry); }
        catch (error) { console.error("Terminal PTY failed to stop on Window cleanup:", error); }
      }
    }
  }

  releaseSession(sessionId: string): void {
    for (const entry of this.terminals.values()) {
      if (entry.sessionId === sessionId) {
        try { this.releaseEntry(entry); }
        catch (error) { console.error("Terminal PTY failed to stop on Session cleanup:", error); }
      }
    }
  }

  releaseAll(): void {
    for (const entry of this.terminals.values()) {
      try { this.releaseEntry(entry); }
      catch (error) { console.error("Terminal PTY failed to stop on app exit:", error); }
    }
  }

  countLive(window: TWindow): number {
    let count = 0;
    for (const entry of this.terminals.values()) {
      if (entry.window === window && (entry.phase === "starting" || entry.phase === "running")) count++;
    }
    return count;
  }

  private onData(entry: TerminalEntry<TWindow>, data: string): void {
    if (this.terminals.get(entry.id) !== entry || entry.window.webContents.isDestroyed()) return;
    entry.pendingCharacters += data.length;
    try {
      this.deps.sendEvent(entry.window, { type: "data", terminalId: entry.id, data });
    } catch (error) {
      this.fail(entry, error);
      return;
    }
    if (entry.pendingCharacters >= OUTPUT_HIGH_WATER && !entry.paused) {
      entry.paused = true;
      try { entry.pty?.pause(); }
      catch (error) { this.fail(entry, error); }
    }
  }

  private onExit(entry: TerminalEntry<TWindow>, exitCode: number, signal?: number): void {
    if (this.terminals.get(entry.id) !== entry) return;
    entry.phase = "exited";
    entry.pty = null;
    entry.paused = false;
    this.disposeSubscriptions(entry);
    if (!entry.window.webContents.isDestroyed()) {
      this.deps.sendEvent(entry.window, { type: "exit", terminalId: entry.id, exitCode, ...(signal === undefined ? {} : { signal }) });
    }
  }

  private releaseEntry(entry: TerminalEntry<TWindow>): void {
    if (this.terminals.get(entry.id) !== entry) return;
    const pty = entry.pty;
    entry.startAbort.abort();
    if (pty) pty.kill();
    this.terminals.delete(entry.id);
    entry.pty = null;
    this.disposeSubscriptions(entry);
  }

  private requireOwner(sender: unknown) {
    const owner = this.deps.resolveOwner(sender);
    if (!owner || owner.window.isDestroyed() || owner.window.webContents.isDestroyed()) {
      throw new Error("Terminal IPC requires an owning Session Window.");
    }
    return owner;
  }

  private requireEntry(sender: unknown, terminalId: string): TerminalEntry<TWindow> {
    const entry = this.findEntry(sender, terminalId);
    if (!entry) {
      throw new Error("Terminal does not belong to this Session Window.");
    }
    return entry;
  }

  private findEntry(sender: unknown, terminalId: string): TerminalEntry<TWindow> | null {
    const owner = this.requireOwner(sender);
    const entry = this.terminals.get(terminalId);
    if (!entry) return null;
    if (entry.window !== owner.window || entry.sessionId !== owner.sessionId) {
      throw new Error("Terminal does not belong to this Session Window.");
    }
    return entry;
  }

  private fail(entry: TerminalEntry<TWindow>, error: unknown): void {
    if (this.terminals.get(entry.id) !== entry) return;
    const pty = entry.pty;
    entry.pty = null;
    entry.phase = "failed";
    this.disposeSubscriptions(entry);
    if (pty) {
      try { pty.kill(); }
      catch (killError) {
        console.error("Terminal PTY failed to stop after an error:", killError);
      }
    }
    if (!entry.window.webContents.isDestroyed()) {
      this.deps.sendEvent(entry.window, {
        type: "error", terminalId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private disposeSubscriptions(entry: TerminalEntry<TWindow>): void {
    for (const subscription of entry.subscriptions.splice(0)) subscription.dispose();
  }

  private isCurrent(entry: TerminalEntry<TWindow>, sender: unknown): boolean {
    if (this.terminals.get(entry.id) !== entry) return false;
    const owner = this.deps.resolveOwner(sender);
    return owner?.window === entry.window && owner.sessionId === entry.sessionId && !entry.window.isDestroyed() && !entry.window.webContents.isDestroyed();
  }

  private watchWindow(window: TWindow): void {
    if (this.watchedWindows.has(window)) return;
    this.watchedWindows.add(window);
    window.on("closed", () => {
      this.releaseWindow(window);
      this.watchedWindows.delete(window);
    });
    window.webContents.on("destroyed", () => this.releaseWindow(window));
    window.webContents.on("render-process-gone", () => this.releaseWindow(window));
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.releaseWindow(window);
    });
  }

  private assertSize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || cols < 1 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) {
      throw new TypeError("Terminal size is invalid.");
    }
  }
}

export async function resolveTerminalShell(platform = process.platform): Promise<CreateTerminalResult & { file: string }> {
  if (platform === "win32") {
    const windowsRoot = process.env.SystemRoot;
    if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw new Error("Windows system directory is unavailable.");
    const file = path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await access(file, constants.X_OK);
    return { file, shellName: "PowerShell", windowsPty: { buildNumber: Number(release().split(".")[2]) } };
  }
  if (platform === "darwin") {
    await access("/bin/zsh", constants.X_OK);
    return { file: "/bin/zsh", shellName: "zsh" };
  }
  throw new Error(`Embedded Terminal is not supported on ${platform}.`);
}

export async function spawnTerminalPty(file: string, cwd: string, cols: number, rows: number, signal: AbortSignal): Promise<TerminalPty> {
  return createUtilityTerminalPty(file, cwd, cols, rows, signal);
}
