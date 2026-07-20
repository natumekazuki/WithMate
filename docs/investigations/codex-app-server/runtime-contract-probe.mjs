import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const PROCESS_EXIT_GRACE_MS = 2_000;

class RpcRequestError extends Error {
  constructor(method, response) {
    super(`${method} was rejected`);
    this.name = "RpcRequestError";
    this.method = method;
    this.code = response.error?.code ?? null;
    this.category = classifyRpcError(response.error?.message);
    this.responseSequence = response.sequence;
  }
}

class AppServerClient {
  constructor() {
    this.nextId = 1;
    this.nextSequence = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.stopping = false;

    const command = codexCommand(["app-server", "--stdio"]);
    this.process = spawn(command.file, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      const event = { message, sequence: this.nextSequence++ };
      this.events.push(event);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new RpcRequestError(pending.method, { ...message, ...event }));
        else pending.resolve({ result: message.result, sequence: event.sequence });
      }

      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    });

    this.process.once("exit", () => {
      if (this.stopping) return;
      const error = new Error("app-server exited before the probe completed");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters = [];
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
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
    const existing = this.events.find((event) => predicate(event.message));
    if (existing !== undefined) return Promise.resolve(existing);
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
      clientInfo: { name: "withmate-runtime-contract-probe", version: "1.0.0" },
      capabilities: null,
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop() {
    if (this.process.exitCode !== null) return;
    this.stopping = true;
    this.process.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.process.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_GRACE_MS)),
    ]);
    if (this.process.exitCode !== null) return;

    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(this.process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      this.process.kill("SIGKILL");
    }
  }
}

function codexCommand(args) {
  if (process.platform !== "win32") return { file: "codex", args };
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `codex ${args.join(" ")}`],
  };
}

function runCodex(args) {
  const command = codexCommand(args);
  return spawnSync(command.file, command.args, {
    encoding: "utf8",
    windowsHide: true,
  });
}

function classifyRpcError(message) {
  if (typeof message !== "string") return "rpc_error";
  const normalized = message.toLowerCase();
  if (normalized.includes("expected") && normalized.includes("turn")) return "expected_turn_mismatch";
  if (normalized.includes("no active turn")) return "no_active_turn";
  if (normalized.includes("not steerable")) return "active_turn_not_steerable";
  return "rpc_error";
}

function startParams(cwd, ephemeral) {
  return {
    cwd,
    ephemeral,
    sandbox: "read-only",
    approvalPolicy: "never",
    baseInstructions: "Do not use tools, commands, files, or network access. Follow the user text literally.",
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
  return (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId;
}

function firstAgentDeltaFor(threadId, turnId) {
  return (message) =>
    message.method === "item/agentMessage/delta" &&
    message.params?.threadId === threadId &&
    message.params?.turnId === turnId;
}

function summarizeLifecycle(events, fromSequence, throughSequence) {
  return events
    .filter((event) => event.sequence >= fromSequence && event.sequence <= throughSequence)
    .map((event) => summarizeLifecycleMessage(event.message))
    .filter((summary) => summary !== null);
}

function summarizeLifecycleMessage(message) {
  if (message.method === "thread/status/changed") {
    return `thread/status/changed(${statusValue(message.params?.status ?? message.params?.thread?.status)})`;
  }
  if (message.method === "item/completed") {
    const item = message.params?.item;
    if (item?.type !== "agentMessage") return `item/completed(${item?.type ?? "unknown"})`;
    return `item/completed(agentMessage:${item.phase ?? "null"})`;
  }
  if (message.method === "turn/completed") {
    return `turn/completed(${statusValue(message.params?.turn?.status)})`;
  }
  if (message.id !== undefined) return "turn/interrupt:response";
  return null;
}

function statusValue(value) {
  if (typeof value === "string") return value;
  if (typeof value?.type === "string") return value.type;
  return "unknown";
}

function completedAgentMessages(client, threadId, turnId) {
  return client.events
    .map((event) => event.message)
    .filter(
      (message) =>
        message.method === "item/completed" &&
        message.params?.threadId === threadId &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === "agentMessage",
    )
    .map((message) => message.params.item);
}

function countByPhase(items) {
  const result = { commentary: 0, final_answer: 0, null: 0, unexpected: 0 };
  for (const item of items) {
    if (item.phase === "commentary") result.commentary += 1;
    else if (item.phase === "final_answer") result.final_answer += 1;
    else if (item.phase === null || item.phase === undefined) result.null += 1;
    else result.unexpected += 1;
  }
  return result;
}

function containsString(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, expected));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsString(entry, expected));
}

async function expectRpcError(operation) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof RpcRequestError) {
      return { code: error.code, category: error.category, sequence: error.responseSequence };
    }
    throw error;
  }
  throw new Error("request unexpectedly succeeded");
}

async function probeInterrupt(workspace) {
  const client = new AppServerClient();
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, true));
    const threadId = started.result.thread.id;
    const turn = await client.request(
      "turn/start",
      turnParams(
        threadId,
        "Without using tools, output the integers from 1 through 100000, one integer per line, and nothing else.",
      ),
    );
    const turnId = turn.result.turn.id;
    const firstDelta = await client.waitFor(firstAgentDeltaFor(threadId, turnId));
    const interruptPromise = client.request("turn/interrupt", { threadId, turnId });
    const terminalPromise = client.waitFor(terminalFor(turnId));
    const [interrupt, terminal] = await Promise.all([interruptPromise, terminalPromise]);
    const terminalStatus = terminal.message.params.turn.status;
    const responseIsEmptyObject =
      typeof interrupt.result === "object" &&
      interrupt.result !== null &&
      !Array.isArray(interrupt.result) &&
      Object.keys(interrupt.result).length === 0;
    const pass = responseIsEmptyObject && terminalStatus === "interrupted";
    if (!pass) throw new Error("CAS-009 contract assertion failed");

    return {
      status: "pass",
      interruptResponse: "empty_object",
      terminalStatus,
      responseBeforeTerminal: interrupt.sequence < terminal.sequence,
      observedOrder: summarizeLifecycle(client.events, firstDelta.sequence + 1, terminal.sequence),
    };
  } finally {
    await client.stop();
  }
}

async function probeSteer(workspace) {
  const client = new AppServerClient();
  const supplementalText = "Stop the current response and reply with exactly: STEERED_OK";
  const mismatchedText = "This mismatched input must be rejected.";
  const terminalText = "This terminal input must be rejected.";
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, false));
    const threadId = started.result.thread.id;
    const turn = await client.request(
      "turn/start",
      turnParams(
        threadId,
        "Without using tools, output the integers from 1 through 100000, one integer per line, and nothing else.",
      ),
    );
    const turnId = turn.result.turn.id;
    await client.waitFor(firstAgentDeltaFor(threadId, turnId));

    const mismatch = await expectRpcError(
      client.request("turn/steer", {
        threadId,
        expectedTurnId: "probe-mismatched-turn-id",
        input: [{ type: "text", text: mismatchedText }],
      }),
    );
    const steer = await client.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: supplementalText }],
    });
    const terminal = await client.waitFor(terminalFor(turnId));
    const read = await client.request("thread/read", { threadId, includeTurns: true });
    const storedTurn = read.result.thread.turns.find((candidate) => candidate.id === turnId);
    const userMessages = storedTurn?.items.filter((item) => item.type === "userMessage") ?? [];
    const supplementalInputCount = userMessages.filter((item) => containsString(item, supplementalText)).length;
    const noActiveTurn = await expectRpcError(
      client.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: terminalText }],
      }),
    );
    const reread = await client.request("thread/read", { threadId, includeTurns: true });
    const rereadTurn = reread.result.thread.turns.find((candidate) => candidate.id === turnId);
    const rereadUserMessages = rereadTurn?.items.filter((item) => item.type === "userMessage") ?? [];
    const rejectedInputsAbsentFromHistory =
      !rereadUserMessages.some((item) => containsString(item, mismatchedText)) &&
      !rereadUserMessages.some((item) => containsString(item, terminalText));
    const terminalStatus = terminal.message.params.turn.status;
    const acceptedSameTurn = steer.result.turnId === turnId;
    const pass =
      mismatch.category === "expected_turn_mismatch" &&
      acceptedSameTurn &&
      terminalStatus === "completed" &&
      supplementalInputCount === 1 &&
      noActiveTurn.category === "no_active_turn" &&
      rereadUserMessages.length === userMessages.length &&
      rejectedInputsAbsentFromHistory;
    if (!pass) throw new Error("CAS-010 contract assertion failed");

    return {
      status: "pass",
      expectedTurnMismatch: { rejected: true, code: mismatch.code, category: mismatch.category },
      acceptedSameTurn,
      terminalStatus,
      history: {
        userMessageCount: rereadUserMessages.length,
        supplementalInputCount,
        rejectedInputsAbsentFromHistory,
      },
      afterTerminal: { rejected: true, code: noActiveTurn.code, category: noActiveTurn.category },
    };
  } finally {
    await client.stop();
  }
}

async function probeAssistantPhase(workspace) {
  const client = new AppServerClient();
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, true));
    const threadId = started.result.thread.id;
    const turn = await client.request(
      "turn/start",
      turnParams(
        threadId,
        "Without using tools, first send one brief commentary progress update. Then send a final answer containing exactly: PHASE_FINAL_OK",
      ),
    );
    const turnId = turn.result.turn.id;
    const terminal = await client.waitFor(terminalFor(turnId));
    const items = completedAgentMessages(client, threadId, turnId);
    const phaseCounts = countByPhase(items);
    const explicitFinalContainsExpectedText = items.some(
      (item) => item.phase === "final_answer" && containsString(item, "PHASE_FINAL_OK"),
    );
    const terminalStatus = terminal.message.params.turn.status;
    const pass =
      terminalStatus === "completed" &&
      phaseCounts.commentary >= 1 &&
      phaseCounts.final_answer >= 1 &&
      phaseCounts.unexpected === 0 &&
      explicitFinalContainsExpectedText;
    if (!pass) throw new Error("CAS-016 contract assertion failed");

    return {
      status: "pass",
      terminalStatus,
      completedAgentMessagePhases: phaseCounts,
      explicitFinalContainsExpectedText,
      finalClassification: "explicit_final_answer",
      nullFallbackUsed: false,
    };
  } finally {
    await client.stop();
  }
}

function inspectDaemonSupport() {
  const result = runCodex(["app-server", "daemon", "version"]);
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (result.status !== 0 && combined.includes("only supported on unix")) {
    return {
      status: "blocked",
      reason: "daemon_lifecycle_unsupported_on_windows",
      existingDaemonChanged: false,
    };
  }
  return {
    status: "not_run",
    reason: "existing_daemon_was_not_started_stopped_or_reconfigured",
    existingDaemonChanged: false,
  };
}

function safeFailure(error) {
  if (error instanceof RpcRequestError) {
    return { kind: "rpc_rejection", method: error.method, code: error.code, category: error.category };
  }
  if (error instanceof Error && error.message.endsWith(" timed out")) {
    return { kind: "timeout", operation: error.message.slice(0, -" timed out".length) };
  }
  return { kind: "probe_assertion_or_process_failure" };
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "withmate-codex-runtime-contract-"));
  const versionResult = runCodex(["--version"]);
  const report = {
    environment: {
      codexVersion: versionResult.stdout.trim(),
      nodeVersion: process.version,
      platform: process.platform,
      transport: "stdio_jsonl",
      workspace: "<workspace>",
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    cas009: null,
    cas010: null,
    cas016: null,
    cas017: inspectDaemonSupport(),
  };

  try {
    report.cas009 = await probeInterrupt(workspace);
    report.cas010 = await probeSteer(workspace);
    report.cas016 = await probeAssistantPhase(workspace);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: safeFailure(error) })}\n`);
  process.exitCode = 1;
});
