import { fileURLToPath } from "node:url";
import { TerminalActivityTracker } from "./terminal-activity.js";
import type { TerminalActivity, TerminalWorkerCommand, TerminalWorkerEvent } from "./terminal-worker-protocol.js";

type Disposable = { dispose(): void };

export type TerminalPty = {
  getActivity(): TerminalActivity;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  onError(listener: (error: Error) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
};

export async function createUtilityTerminalPty(file: string, cwd: string, cols: number, rows: number, signal: AbortSignal): Promise<TerminalPty> {
  if (signal.aborted) return Promise.reject(new Error("Terminal creation was cancelled."));
  const { utilityProcess } = await import("electron");
  if (signal.aborted) return Promise.reject(new Error("Terminal creation was cancelled."));
  const host = utilityProcess.fork(fileURLToPath(new URL("./terminal-worker.js", import.meta.url)), [], {
    serviceName: "WithMate Terminal",
    stdio: "ignore",
  });
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  let stopped = false;
  let terminalExited = false;
  let settled = false;
  const activity = new TerminalActivityTracker();
  let forceStopTimer: ReturnType<typeof setTimeout> | null = null;

  const post = (command: TerminalWorkerCommand) => {
    if (!stopped && host.pid !== undefined) host.postMessage(command);
  };
  const pty: TerminalPty = {
    getActivity: () => activity.getActivity(),
    onData(listener) { dataListeners.add(listener); return { dispose: () => { dataListeners.delete(listener); } }; },
    onExit(listener) { exitListeners.add(listener); return { dispose: () => { exitListeners.delete(listener); } }; },
    onError(listener) { errorListeners.add(listener); return { dispose: () => { errorListeners.delete(listener); } }; },
    write(data) {
      activity.onInput(data);
      post({ type: "write", data });
    },
    resize(nextCols, nextRows) { post({ type: "resize", cols: nextCols, rows: nextRows }); },
    pause() { post({ type: "pause" }); },
    resume() { post({ type: "resume" }); },
    kill() {
      if (stopped) return;
      stopped = true;
      if (host.pid !== undefined) {
        try { host.postMessage({ type: "stop" } satisfies TerminalWorkerCommand); }
        catch { host.kill(); }
      }
      forceStopTimer = setTimeout(() => { if (host.pid !== undefined) host.kill(); }, 2_000);
      forceStopTimer.unref?.();
    },
  };

  return new Promise<TerminalPty>((resolve, reject) => {
    const cancel = () => {
      if (settled) return;
      settled = true;
      stopped = true;
      host.kill();
      reject(new Error("Terminal creation was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    host.on("spawn", () => {
      if (stopped) { host.kill(); return; }
      host.postMessage({ type: "start", file, cwd, cols, rows } satisfies TerminalWorkerCommand);
    });
    host.on("message", (message: TerminalWorkerEvent) => {
      if (!message || typeof message !== "object" || stopped) return;
      if (message.type === "started") {
        if (!settled) { settled = true; signal.removeEventListener("abort", cancel); resolve(pty); }
      } else if (message.type === "activity") {
        activity.onActivity(message.activity);
      } else if (message.type === "data" && typeof message.data === "string") {
        for (const listener of dataListeners) listener(message.data);
      } else if (message.type === "terminal-exit") {
        terminalExited = true;
        for (const listener of exitListeners) listener({ exitCode: message.exitCode, signal: message.signal });
      } else if (message.type === "failed") {
        const error = new Error(message.message);
        if (!settled) { settled = true; signal.removeEventListener("abort", cancel); reject(error); }
        else for (const listener of errorListeners) listener(error);
      }
    });
    host.on("error", () => {
      // Electron also emits exit. That event is the single failure signal.
    });
    host.on("exit", (code) => {
      if (forceStopTimer) clearTimeout(forceStopTimer);
      if (stopped || terminalExited) return;
      const error = new Error(`Terminal host exited unexpectedly (code ${code}).`);
      if (!settled) { settled = true; signal.removeEventListener("abort", cancel); reject(error); }
      else for (const listener of errorListeners) listener(error);
    });
  });
}
