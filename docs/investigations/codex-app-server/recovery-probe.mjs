import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;

class AppServerClient {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.process = spawn(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "codex app-server --stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.events.push(message);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("notification timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "withmate-recovery-probe", version: "1.0.0" },
      capabilities: null,
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop(force = false) {
    if (this.process.exitCode !== null) return;
    if (!force) {
      this.process.stdin.end();
      await Promise.race([
        new Promise((resolve) => this.process.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (this.process.exitCode === null) {
      spawnSync("taskkill", ["/PID", String(this.process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  }
}

function startParams(cwd) {
  return {
    cwd,
    ephemeral: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "Do not use tools or access files. Follow the user text literally.",
  };
}

function turnParams(threadId, text) {
  return {
    threadId,
    input: [{ type: "text", text }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
  };
}

function terminalFor(turnId) {
  return (message) =>
    message.method === "turn/completed" && message.params?.turn?.id === turnId;
}

function summarize(client) {
  return client.events
    .filter((event) => event.method)
    .map((event) => {
      const rawStatus = event.params?.turn?.status ?? event.params?.thread?.status;
      const status =
        typeof rawStatus === "string" ? rawStatus : rawStatus?.type ?? null;
      return status ? `${event.method}(${status})` : event.method;
    });
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "withmate-codex-recovery-"));
  const version = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "codex --version"],
    { encoding: "utf8", windowsHide: true },
  ).stdout.trim();
  const report = {
    environment: { codexVersion: version, transport: "stdio", workspace: "<workspace>" },
    completedTurnResume: {},
    activeTurnDisconnect: {},
  };
  const clients = [];

  try {
    const first = new AppServerClient("completed-origin");
    clients.push(first);
    await first.initialize();
    const started = await first.request("thread/start", startParams(workspace));
    const threadId = started.thread.id;
    const turn = await first.request(
      "turn/start",
      turnParams(threadId, "Reply with exactly: RECOVERY_BASELINE_OK"),
    );
    const completed = await first.waitFor(terminalFor(turn.turn.id));
    report.completedTurnResume.originStatus = completed.params.turn.status;
    report.completedTurnResume.originSequence = summarize(first);
    await first.stop();

    const resumed = new AppServerClient("completed-resume");
    clients.push(resumed);
    await resumed.initialize();
    const read = await resumed.request("thread/read", { threadId, includeTurns: true });
    const resume = await resumed.request("thread/resume", {
      threadId,
      cwd: workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    report.completedTurnResume.readStatus = read.thread.status;
    report.completedTurnResume.readTurnCount = read.thread.turns.length;
    report.completedTurnResume.readLastTurnStatus = read.thread.turns.at(-1)?.status ?? null;
    report.completedTurnResume.resumeStatus = resume.thread.status;
    report.completedTurnResume.resumeTurnCount = resume.thread.turns.length;
    report.completedTurnResume.resumeLastTurnItemTypes =
      resume.thread.turns.at(-1)?.items.map((item) => item.type) ?? [];
    const continuedTurn = await resumed.request(
      "turn/start",
      turnParams(threadId, "Reply with exactly: RECOVERY_RESUME_OK"),
    );
    const continuedCompleted = await resumed.waitFor(terminalFor(continuedTurn.turn.id));
    report.completedTurnResume.continuedTurnStatus =
      continuedCompleted.params.turn.status;
    await resumed.stop();

    const active = new AppServerClient("active-origin");
    clients.push(active);
    await active.initialize();
    const activeThread = await active.request("thread/start", startParams(workspace));
    const activeThreadId = activeThread.thread.id;
    const activeTurn = await active.request(
      "turn/start",
      turnParams(
        activeThreadId,
        "Without using tools, output the integers from 1 through 2000, one integer per line, and nothing else.",
      ),
    );
    const activeTurnId = activeTurn.turn.id;
    await active.waitFor(
      (message) =>
        message.method === "item/agentMessage/delta" &&
        message.params?.threadId === activeThreadId &&
        message.params?.turnId === activeTurnId,
    );
    report.activeTurnDisconnect.beforeDisconnectSequence = summarize(active);
    await active.stop(true);

    const recovery = new AppServerClient("active-recovery");
    clients.push(recovery);
    await recovery.initialize();
    const recovered = await recovery.request("thread/resume", {
      threadId: activeThreadId,
      cwd: workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    report.activeTurnDisconnect.resumeStatus = recovered.thread.status;
    report.activeTurnDisconnect.resumeTurnCount = recovered.thread.turns.length;
    report.activeTurnDisconnect.resumeLastTurnStatus = recovered.thread.turns.at(-1)?.status ?? null;
    report.activeTurnDisconnect.resumeLastTurnItemTypes =
      recovered.thread.turns.at(-1)?.items.map((item) => item.type) ?? [];

    let recoveredTerminal = recovered.thread.turns.find((candidate) => candidate.id === activeTurnId);
    if (!recoveredTerminal || recoveredTerminal.status === "inProgress") {
      try {
        const terminal = await recovery.waitFor(terminalFor(activeTurnId), 120_000);
        recoveredTerminal = terminal.params.turn;
      } catch {
        const reread = await recovery.request("thread/read", {
          threadId: activeThreadId,
          includeTurns: true,
        });
        recoveredTerminal = reread.thread.turns.find((candidate) => candidate.id === activeTurnId);
      }
    }
    report.activeTurnDisconnect.finalObservedStatus = recoveredTerminal?.status ?? null;
    report.activeTurnDisconnect.recoverySequence = summarize(recovery);
    await recovery.stop();
  } finally {
    for (const client of clients) await client.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
