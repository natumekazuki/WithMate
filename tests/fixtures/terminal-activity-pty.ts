import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node-pty";
import { createPowerShellActivityIntegration, TerminalActivityParser, TerminalActivityTracker } from "../../src-electron/terminal/terminal-activity.js";
import { TerminalService, type TerminalOwner } from "../../src-electron/terminal/terminal-service.js";

const integration = createPowerShellActivityIntegration();
// Keep the test independent of user profiles and do not persist test commands in history.
const script = "Import-Module PSReadLine; Set-PSReadLineOption -HistorySaveStyle SaveNothing;\n"
  + Buffer.from(integration.args[2], "base64").toString("utf16le");
const pty = spawn(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  ["-NoProfile", "-NoExit", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { cwd: tmpdir(), cols: 120, rows: 24, env: process.env });
const tracker = new TerminalActivityTracker();
const activities: string[] = [];
let output = "";
let exited = false;
let kills = 0;
let confirmations = 0;
const owner: TerminalOwner = {
  id: 1, isDestroyed: () => false, on() {},
  webContents: { isDestroyed: () => false, send() {}, on() {} },
};
const terminalId = "87263983-5b1d-4b5d-8f08-2b04899dbb8d";
const parser = new TerminalActivityParser(integration.marker, (activity) => {
  activities.push(activity);
  tracker.onActivity(activity);
});
const service = new TerminalService({
  resolveOwner: () => ({ window: owner, sessionId: "test", workspacePath: tmpdir() }),
  confirmClose: async () => { confirmations++; return false; },
  sendEvent() {},
  resolveShell: async () => ({ file: "powershell.exe", shellName: "PowerShell" }),
  spawn: async () => ({
    getActivity: () => tracker.getActivity(),
    onData: (listener) => pty.onData((data) => listener(parser.push(data))),
    onExit: (listener) => pty.onExit(listener),
    onError: () => ({ dispose() {} }),
    write(data) { tracker.onInput(data); pty.write(data); },
    resize: (cols, rows) => pty.resize(cols, rows),
    pause: () => pty.pause(), resume: () => pty.resume(),
    kill() { kills++; },
  }),
});
pty.onExit(() => { exited = true; });
pty.onData((data) => {
  output += data;
  if (data.includes("\x1b[6n")) pty.write("\x1b[1;1R");
});
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && !exited && Date.now() < deadline) await sleep(20);
  assert.ok(predicate(), `${label}: ${tracker.getActivity()}, ${JSON.stringify(output.slice(-2000))}`);
}
function write(data: string) { service.write(owner, terminalId, data); }
async function complete(command: string) {
  activities.length = 0;
  write(command + "\r");
  await until(() => activities.includes("busy") && tracker.getActivity() === "idle", "command completion");
}
try {
  await service.create(owner, { terminalId, cols: 120, rows: 24 });
  await until(() => tracker.getActivity() === "idle", "initial empty prompt");
  assert.equal(service.countRequiringCloseConfirmation(owner), 0);
  for (const chunks of [["\rWrite-Output unfinished"], ["\r\rWrite-Output unfinished"], ["\r", "Write-Output unfinished"]]) {
    activities.length = 0;
    output = "";
    for (const chunk of chunks) write(chunk);
    await until(() => activities.includes("busy") && output.includes("unfinished"), "pasted trailing edit");
    // Observe several PSReadLine idle intervals while the trailing line remains unsubmitted.
    await sleep(1000);
    assert.equal(tracker.getActivity(), "unknown", JSON.stringify(chunks));
    assert.equal(service.countRequiringCloseConfirmation(owner), 1);
    const before = confirmations;
    assert.equal(await service.close(owner, terminalId), false);
    assert.equal(confirmations, before + 1);
    assert.equal(kills, 0);
    await complete("");
    assert.equal(service.countRequiringCloseConfirmation(owner), 0);
  }
  await complete("Start-Sleep -Milliseconds 300");
  assert.equal(await service.close(owner, terminalId), true);
  assert.equal(confirmations, 3);
  assert.equal(kills, 1);
  pty.write("exit\r");
  await until(() => exited, "PTY shutdown");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!exited) pty.kill();
  // ConPTY keeps native helper handles alive; isolate their lifetime in this child process.
  await sleep(500);
  process.exit(process.exitCode ?? 0);
}
