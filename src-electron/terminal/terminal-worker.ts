import type { ParentPort } from "electron";
import type { IPty } from "node-pty";
import type { TerminalWorkerCommand, TerminalWorkerEvent } from "./terminal-worker-protocol.js";

let terminal: IPty | null = null;
let stopping = false;
const parentPort = (process as typeof process & { parentPort: ParentPort }).parentPort;

function send(event: TerminalWorkerEvent): void {
  parentPort.postMessage(event);
}

parentPort.on("message", async ({ data }: { data: TerminalWorkerCommand }) => {
  if (!data || typeof data !== "object") return;
  if (data.type === "start") {
    if (terminal || stopping) return;
    try {
      const pty = await import("node-pty");
      if (stopping) return;
      const started = pty.spawn(data.file, [], {
        cwd: data.cwd,
        cols: data.cols,
        rows: data.rows,
        env: process.env,
      });
      if (stopping) { started.kill(); return; }
      terminal = started;
      started.onData((value) => send({ type: "data", data: value }));
      started.onExit(({ exitCode, signal }) => {
        terminal = null;
        send({ type: "terminal-exit", exitCode, ...(signal === undefined ? {} : { signal }) });
        setTimeout(() => process.exit(0), 250);
      });
      send({ type: "started" });
    } catch (error) {
      send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      setTimeout(() => process.exit(1), 250);
    }
    return;
  }
  if (data.type === "stop") {
    stopping = true;
    if (terminal) terminal.kill();
    else process.exit(0);
    setTimeout(() => process.exit(1), 1_500);
    return;
  }
  if (!terminal || stopping) return;
  try {
    if (data.type === "write") terminal.write(data.data);
    else if (data.type === "resize") terminal.resize(data.cols, data.rows);
    else if (data.type === "pause") terminal.pause();
    else if (data.type === "resume") terminal.resume();
  } catch (error) {
    send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    stopping = true;
    terminal.kill();
    setTimeout(() => process.exit(1), 1_500);
  }
});
