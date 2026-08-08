import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { inspectValidationModelPreflight, VALIDATION_MODEL_SELECTION } from "./validation-model-preflight.mjs";
import {
  activeProcessOwners,
  cleanupRecoveryTargetsForOwners,
  deleteTempAfterVerifiedProcessCleanup,
  emergencyStopOwnedProcesses,
  processHasExited,
  processOwnerContractSelfTest,
  resolveCodexInvocation,
  spawnOwnedProcess,
  waitForOwnedControllerExit,
  waitForProcessOwnerReady,
} from "./probe-process-owner.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;
const PROCESS_EXIT_GRACE_MS = 2_000;
const PROCESS_FORCE_RESERVE_MS = 10_000;
const MAX_PROBE_MS = 14 * 60_000;
const MAX_TOTAL_MS = 15 * 60_000;
const SELF_TEST_STALLED_DELETE_ENV = "WITHMATE_RECOVERY_PROBE_SELF_TEST_STALLED_DELETE";
let activeDeadlineOperations = 0;
const MAX_APP_SERVER_LINE_BYTES = 1_048_576;
const MAX_APP_SERVER_EVENT_COUNT = 10_000;
const MAX_APP_SERVER_EVENT_BYTES = 16_777_216;
const PUBLIC_EVENT_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
]);
const PUBLIC_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall"]);
const PUBLIC_THREAD_STATUS_TYPES = new Set(["notLoaded", "idle", "active", "systemError"]);
const PUBLIC_TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted"]);

class ProbeDeadlineError extends Error {}
class NotificationTimeoutError extends Error {}
class RequestTimeoutError extends Error {}
class RecoveryContractError extends Error {
  constructor(stage) {
    super("recovery contract assertion failed");
    this.stage = stage;
  }
}

class RpcRequestError extends Error {
  constructor(method) {
    super(`${method} was rejected`);
  }
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function boundedTimeout(deadlineAt, requestedMs, operation) {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new ProbeDeadlineError(`${operation} exceeded the probe deadline`);
  return Math.min(requestedMs, remaining);
}

function withDeadline(startOperation, deadlineAt, operation) {
  const timeoutMs = boundedTimeout(deadlineAt, remainingMs(deadlineAt), operation);
  activeDeadlineOperations += 1;
  const operationPromise = Promise.resolve().then(startOperation);
  let operationSettled = false;
  const markOperationSettled = () => {
    if (operationSettled) return;
    operationSettled = true;
    activeDeadlineOperations -= 1;
  };
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new ProbeDeadlineError(`${operation} exceeded the probe deadline`)),
      timeoutMs,
    );
    operationPromise.then(
      (value) => {
        clearTimeout(timer);
        markOperationSettled();
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        markOperationSettled();
        rejectPromise(error);
      },
    );
  });
}

function canClearHardDeadline() {
  return activeProcessOwners.size === 0 && activeDeadlineOperations === 0;
}

function shouldAttemptGracefulStop(deadlineAt) {
  return remainingMs(deadlineAt) > PROCESS_EXIT_GRACE_MS + PROCESS_FORCE_RESERVE_MS;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AppServerClient {
  constructor(label, deadlineAt, cleanupDeadlineAt) {
    this.label = label;
    this.deadlineAt = deadlineAt;
    this.cleanupDeadlineAt = cleanupDeadlineAt;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.eventBytes = 0;
    this.modelPreflightChecks = 0;
    this.processError = null;
    const invocation = resolveCodexInvocation(boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex discovery"));
    this.processOwner = spawnOwnedProcess(invocation.command, [...invocation.prefixArgs, "app-server", "--stdio"]);
    this.process = this.processOwner.controller;
    this.processReady = this.processOwner.ready;
    this.process.stderr.resume();
    this.process.once("error", (error) => this.fail(error));
    this.process.once("exit", () => this.fail(new Error("app-server exited")));

    createInterface({ input: this.process.stdout }).on("line", (line) => {
      if (this.processError !== null) return;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        lineBytes > MAX_APP_SERVER_LINE_BYTES ||
        this.events.length >= MAX_APP_SERVER_EVENT_COUNT ||
        this.eventBytes + lineBytes > MAX_APP_SERVER_EVENT_BYTES
      ) {
        this.fail(new Error("app-server event buffer limit exceeded"));
        this.process.stdout.destroy();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("invalid app-server JSONL message"));
        this.process.stdout.destroy();
        return;
      }
      if (!isPlainObject(message)) {
        this.fail(new Error("invalid app-server JSONL message"));
        this.process.stdout.destroy();
        return;
      }
      this.events.push(message);
      this.eventBytes += lineBytes;
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { method, resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new RpcRequestError(method));
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

  fail(error) {
    if (this.processError !== null) return;
    this.processError = error;
    this.failOutstanding(error);
  }

  failOutstanding(error) {
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
  }

  send(message) {
    if (this.processError !== null) throw this.processError;
    if (!this.process.stdin.writable) throw new Error("app-server stdin is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const effectiveTimeoutMs = boundedTimeout(this.deadlineAt, timeoutMs, method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(`${method} timed out`));
      }, effectiveTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS) {
    if (this.processError !== null) return Promise.reject(this.processError);
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    const effectiveTimeoutMs = boundedTimeout(this.deadlineAt, timeoutMs, "notification wait");
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new NotificationTimeoutError("notification timed out"));
      }, effectiveTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    await waitForProcessOwnerReady(this.processOwner, this.deadlineAt, "app-server process launch");
    await this.request("initialize", {
      clientInfo: { name: "withmate-recovery-probe", version: "1.0.0" },
      capabilities: null,
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop(force = false) {
    const deadlineAt = this.cleanupDeadlineAt;
    if (!force && !this.hasExited()) {
      this.process.stdin.end();
      if (shouldAttemptGracefulStop(deadlineAt)) {
        await waitForOwnedControllerExit(
          this.processOwner,
          PROCESS_EXIT_GRACE_MS,
          deadlineAt,
          "app-server graceful stop",
        );
      }
    }
    await this.processOwner.cleanup(deadlineAt, "app-server ownership cleanup confirmation");
  }

  hasExited() {
    return processHasExited(this.process);
  }
}

function startParams(cwd) {
  return {
    model: VALIDATION_MODEL_SELECTION.model,
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
    model: VALIDATION_MODEL_SELECTION.model,
    effort: VALIDATION_MODEL_SELECTION.reasoningEffort,
  };
}

function resumeParams(threadId, cwd) {
  return {
    threadId,
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    model: VALIDATION_MODEL_SELECTION.model,
  };
}

function terminalFor(threadId, turnId) {
  return (message) =>
    message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId;
}

function publicTurnStatus(status) {
  return PUBLIC_TURN_STATUSES.has(status) ? status : status === undefined ? "not_observed" : "other";
}

function publicThreadStatus(status) {
  const value = isPlainObject(status) ? status.type : status;
  return PUBLIC_THREAD_STATUS_TYPES.has(value) ? value : value === undefined ? "not_observed" : "other";
}

function publicItemTypeSummary(items) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const type = PUBLIC_ITEM_TYPES.has(item?.type) ? item.type : "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}

function requireThreadHistory(
  response,
  expectedThreadId,
  expectedThreadStatuses,
  expectedTurnId,
  expectedTurnStatuses,
  operation = "recovery",
) {
  const thread = response?.thread;
  if (!isPlainObject(thread) || thread.id !== expectedThreadId || !Array.isArray(thread.turns)) {
    throw new RecoveryContractError(`${operation}_thread_identity_or_history`);
  }
  const threadStatus = publicThreadStatus(thread.status);
  if (!expectedThreadStatuses.includes(threadStatus)) {
    throw new RecoveryContractError(`${operation}_thread_status`);
  }
  const matchingTurns = thread.turns.filter((candidate) => candidate?.id === expectedTurnId);
  if (
    thread.turns.length !== 1 ||
    matchingTurns.length !== 1 ||
    !expectedTurnStatuses.includes(publicTurnStatus(matchingTurns[0]?.status))
  ) {
    throw new RecoveryContractError(`${operation}_turn_history_or_status`);
  }
  return thread;
}

function requireTerminalStatus(event, threadId, turnId, expectedStatus, operation) {
  if (!terminalFor(threadId, turnId)(event) || publicTurnStatus(event.params.turn.status) !== expectedStatus) {
    throw new RecoveryContractError(`${operation}_terminal_owner_or_status`);
  }
  return event.params.turn;
}

function recoveryContractRejects(operation) {
  try {
    operation();
    return false;
  } catch {
    return true;
  }
}

function summarize(client) {
  const counts = new Map();
  for (const event of client.events) {
    if (typeof event.method !== "string") continue;
    const method = PUBLIC_EVENT_METHODS.has(event.method) ? event.method : "other";
    const rawStatus = event.params?.turn?.status ?? event.params?.thread?.status;
    const status = event.params?.turn
      ? publicTurnStatus(rawStatus)
      : rawStatus === undefined
        ? "not_observed"
        : publicThreadStatus(rawStatus);
    const key = JSON.stringify([method, status]);
    const current = counts.get(key);
    if (current === undefined) counts.set(key, { method, status, count: 1 });
    else current.count += 1;
  }
  return [...counts.values()];
}

async function inspectProviderPreflight(client) {
  return inspectValidationModelPreflight((method, params) => client.request(method, params));
}

async function startModelTurn(client, threadId, text) {
  const preflight = await inspectProviderPreflight(client);
  if (preflight === undefined) throw new Error("validation model preflight failed");
  client.modelPreflightChecks += 1;
  return client.request("turn/start", turnParams(threadId, text));
}

function requireSelfTest(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

async function selfTestReport() {
  if (process.env[SELF_TEST_STALLED_DELETE_ENV] === "1") {
    await withDeadline(() => new Promise(() => {}), Date.now() + 10, "stalled temp deletion");
    throw new Error("stalled temp deletion unexpectedly settled");
  }
  const calls = [];
  const lunaEntry = {
    id: VALIDATION_MODEL_SELECTION.model,
    model: VALIDATION_MODEL_SELECTION.model,
    hidden: false,
    defaultReasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium" },
      { reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort },
    ],
  };
  const client = {
    modelPreflightChecks: 0,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: false, namespaceTools: true, webSearch: true };
      }
      if (method === "model/list") return { data: [lunaEntry], nextCursor: null };
      if (method === "turn/start") return { turn: { id: "turn-a" } };
      throw new Error("unexpected self-test request");
    },
  };
  await startModelTurn(client, "thread-a", "probe");
  requireSelfTest(
    calls.map((call) => call.method).join(",") === "modelProvider/capabilities/read,model/list,model/list,turn/start" &&
      calls[1]?.params?.includeHidden === false &&
      calls[2]?.params?.includeHidden === true,
    "Turn starts only after the complete provider preflight",
  );
  requireSelfTest(
    calls.at(-1)?.params?.model === VALIDATION_MODEL_SELECTION.model &&
      calls.at(-1)?.params?.effort === VALIDATION_MODEL_SELECTION.reasoningEffort &&
      calls.at(-1)?.params?.effort !== "ultra",
    "Turn carries the exact Luna and non-ultra reasoning tuple",
  );
  requireSelfTest(startParams("<workspace>").model === VALIDATION_MODEL_SELECTION.model, "thread/start carries Luna");
  requireSelfTest(
    resumeParams("thread-a", "<workspace>").model === VALIDATION_MODEL_SELECTION.model,
    "thread/resume carries Luna",
  );
  const exactTerminal = {
    method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } },
  };
  requireSelfTest(terminalFor("thread-a", "turn-a")(exactTerminal), "exact terminal owner is accepted");
  requireSelfTest(
    !terminalFor("thread-b", "turn-a")(exactTerminal) &&
      !terminalFor("thread-a", "turn-b")(exactTerminal) &&
      !terminalFor(
        "thread-a",
        "turn-a",
      )({
        method: "turn/completed",
        params: { turn: { id: "turn-a", status: "completed" } },
      }),
    "cross-owner and missing-owner terminals are rejected",
  );
  const completedHistory = {
    thread: {
      id: "thread-a",
      status: { type: "notLoaded" },
      turns: [{ id: "turn-a", status: "completed", items: [] }],
    },
  };
  requireSelfTest(
    requireThreadHistory(completedHistory, "thread-a", ["notLoaded"], "turn-a", ["completed"]) ===
      completedHistory.thread,
    "completed read requires the exact unloaded Thread, Turn, history, and status",
  );
  requireSelfTest(
    recoveryContractRejects(() =>
      requireThreadHistory(completedHistory, "thread-b", ["notLoaded"], "turn-a", ["completed"]),
    ) &&
      recoveryContractRejects(() =>
        requireThreadHistory(completedHistory, "thread-a", ["notLoaded"], "turn-a", ["failed"]),
      ) &&
      recoveryContractRejects(() =>
        requireThreadHistory(
          { thread: { ...completedHistory.thread, turns: [] } },
          "thread-a",
          ["notLoaded"],
          "turn-a",
          ["completed"],
        ),
      ) &&
      recoveryContractRejects(() =>
        requireThreadHistory(
          {
            thread: {
              ...completedHistory.thread,
              turns: [...completedHistory.thread.turns, { id: "turn-phantom", status: "completed", items: [] }],
            },
          },
          "thread-a",
          ["notLoaded"],
          "turn-a",
          ["completed"],
        ),
      ),
    "cross-Thread, wrong-terminal, missing-history, and extra-Turn recovery results fail closed",
  );
  requireSelfTest(
    (await inspectValidationModelPreflight(async (method) => {
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: false, namespaceTools: true, webSearch: true };
      }
      if (method === "model/list") {
        return {
          data: [{ ...lunaEntry, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
          nextCursor: null,
        };
      }
      throw new Error("unexpected validation model self-test request");
    })) === undefined,
    "catalogs without the exact Luna and high tuple fail closed",
  );
  const processOwnerContract = await processOwnerContractSelfTest();
  requireSelfTest(
    Object.values(processOwnerContract).every((result) => result === true),
    "shared process owner handles normal, assignment, controller-first, and cleanup-failure paths",
  );
  let tempDeleted = false;
  requireSelfTest(
    !(await deleteTempAfterVerifiedProcessCleanup(false, async () => {
      tempDeleted = true;
    })) && !tempDeleted,
    "temp deletion is skipped when process cleanup is unverified",
  );
  requireSelfTest(
    (await deleteTempAfterVerifiedProcessCleanup(true, async () => {
      tempDeleted = true;
    })) && tempDeleted,
    "temp deletion follows verified process cleanup",
  );
  let tempDeletionDeadlineRejected = false;
  let releasePendingTempDeletion;
  const pendingTempDeletion = new Promise((resolvePromise) => {
    releasePendingTempDeletion = resolvePromise;
  });
  try {
    await withDeadline(() => pendingTempDeletion, Date.now() + 10, "temp deletion self-test");
  } catch (error) {
    tempDeletionDeadlineRejected = error instanceof ProbeDeadlineError;
  }
  requireSelfTest(
    tempDeletionDeadlineRejected && activeDeadlineOperations === 1 && !canClearHardDeadline(),
    "a timed-out temp deletion keeps the total watchdog armed until filesystem I/O settles",
  );
  releasePendingTempDeletion();
  await pendingTempDeletion;
  await Promise.resolve();
  requireSelfTest(
    activeDeadlineOperations === 0 && canClearHardDeadline(),
    "a settled temp deletion permits total watchdog cleanup",
  );
  const stalledDeleteResult = spawnSync(process.execPath, [process.argv[1], "--self-test"], {
    encoding: "utf8",
    env: { ...process.env, [SELF_TEST_STALLED_DELETE_ENV]: "1" },
    timeout: 2_000,
    windowsHide: true,
  });
  requireSelfTest(
    stalledDeleteResult.error === undefined &&
      stalledDeleteResult.status === 124 &&
      !stalledDeleteResult.stdout.includes('"status": "pass"'),
    "owner-zero pending temp deletion exits through the total watchdog without reporting pass",
  );
  let unknownArgumentRejected = false;
  try {
    probeMode(["--unknown"]);
  } catch {
    unknownArgumentRejected = true;
  }
  requireSelfTest(
    unknownArgumentRejected && probeMode([]) === "live" && probeMode(["--preflight-only"]) === "preflight",
    "unknown or conflicting command-line arguments fail closed",
  );
  return {
    mode: "self_test",
    status: "pass",
    assertions: [
      "turn_preflight_order",
      "luna_high_tuple_explicit",
      "unsupported_luna_high_tuple_rejected",
      "thread_model_explicit",
      "turn_terminal_owner_tuple_exact",
      "recovery_thread_turn_history_exact",
      "recovery_wrong_owner_status_history_rejected",
      "process_owner_readiness_deadline_cleanup",
      "temp_deletion_total_deadline",
      "temp_deletion_owner_zero_watchdog",
      "unknown_cli_argument_rejected",
    ],
    externalTurns: 0,
  };
}

async function recoveryReport(preflightOnly = false, startedAt = Date.now()) {
  const deadlineAt = startedAt + MAX_PROBE_MS;
  const cleanupDeadlineAt = startedAt + MAX_TOTAL_MS;
  const workspace = mkdtempSync(join(tmpdir(), "withmate-codex-recovery-"));
  const report = {
    mode: preflightOnly ? "preflight" : "live",
    environment: {
      codexVersion: "not_observed",
      transport: "stdio",
      workspace: "<workspace>",
      model: VALIDATION_MODEL_SELECTION.model,
      reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
      externalTurns: 0,
      successfulModelPreflightChecks: 0,
    },
    completedTurnResume: {},
    activeTurnDisconnect: {},
  };
  const clients = [];

  try {
    const invocation = resolveCodexInvocation(boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex discovery"));
    const versionResult = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex version"),
    });
    if (versionResult.error !== undefined || versionResult.status !== 0) {
      throw new Error("codex version failed");
    }
    report.environment.codexVersion = versionResult.stdout.trim();

    if (preflightOnly) {
      const preflight = new AppServerClient("preflight", deadlineAt, cleanupDeadlineAt);
      clients.push(preflight);
      await preflight.initialize();
      const evidence = await inspectProviderPreflight(preflight);
      if (evidence === undefined) throw new Error("validation model preflight failed");
      report.environment.modelCatalog = "verified";
      report.environment.modelVisibility = evidence.model.hidden ? "hidden" : "visible";
      report.environment.modelProviderCapabilities = evidence.providerCapabilities;
      report.environment.visibleCatalogPages = evidence.visibility.visiblePages;
      report.environment.completeCatalogPages = evidence.visibility.completePages;
      await preflight.stop();
      report.status = "pass";
      return report;
    }

    const first = new AppServerClient("completed-origin", deadlineAt, cleanupDeadlineAt);
    clients.push(first);
    await first.initialize();
    const started = await first.request("thread/start", startParams(workspace));
    const threadId = started.thread.id;
    const turn = await startModelTurn(first, threadId, "Reply with exactly: RECOVERY_BASELINE_OK");
    report.environment.externalTurns += 1;
    const completed = await first.waitFor(terminalFor(threadId, turn.turn.id));
    const completedTurn = requireTerminalStatus(completed, threadId, turn.turn.id, "completed", "origin");
    report.completedTurnResume.originStatus = publicTurnStatus(completedTurn.status);
    report.completedTurnResume.originSequence = summarize(first);
    await first.stop();

    const resumed = new AppServerClient("completed-resume", deadlineAt, cleanupDeadlineAt);
    clients.push(resumed);
    await resumed.initialize();
    const read = await resumed.request("thread/read", { threadId, includeTurns: true });
    const resume = await resumed.request("thread/resume", resumeParams(threadId, workspace));
    const readThread = requireThreadHistory(
      read,
      threadId,
      ["notLoaded"],
      turn.turn.id,
      ["completed"],
      "completed_read",
    );
    const resumedThread = requireThreadHistory(
      resume,
      threadId,
      ["idle"],
      turn.turn.id,
      ["completed"],
      "completed_resume",
    );
    report.completedTurnResume.readStatus = publicThreadStatus(readThread.status);
    report.completedTurnResume.readTurnCount = readThread.turns.length;
    report.completedTurnResume.readLastTurnStatus = publicTurnStatus(readThread.turns.at(-1)?.status);
    report.completedTurnResume.resumeStatus = publicThreadStatus(resumedThread.status);
    report.completedTurnResume.resumeTurnCount = resumedThread.turns.length;
    report.completedTurnResume.resumeLastTurnItemTypes = publicItemTypeSummary(resumedThread.turns.at(-1)?.items);
    const continuedTurn = await startModelTurn(resumed, threadId, "Reply with exactly: RECOVERY_RESUME_OK");
    report.environment.externalTurns += 1;
    const continuedCompleted = await resumed.waitFor(terminalFor(threadId, continuedTurn.turn.id));
    const completedContinuation = requireTerminalStatus(
      continuedCompleted,
      threadId,
      continuedTurn.turn.id,
      "completed",
      "continued",
    );
    report.completedTurnResume.continuedTurnStatus = publicTurnStatus(completedContinuation.status);
    await resumed.stop();

    const active = new AppServerClient("active-origin", deadlineAt, cleanupDeadlineAt);
    clients.push(active);
    await active.initialize();
    const activeThread = await active.request("thread/start", startParams(workspace));
    const activeThreadId = activeThread.thread.id;
    const activeTurn = await startModelTurn(
      active,
      activeThreadId,
      "Without using tools, output the integers from 1 through 2000, one integer per line, and nothing else.",
    );
    report.environment.externalTurns += 1;
    const activeTurnId = activeTurn.turn.id;
    await active.waitFor(
      (message) =>
        message.method === "item/agentMessage/delta" &&
        message.params?.threadId === activeThreadId &&
        message.params?.turnId === activeTurnId,
    );
    report.activeTurnDisconnect.beforeDisconnectSequence = summarize(active);
    await active.stop(true);

    const recovery = new AppServerClient("active-recovery", deadlineAt, cleanupDeadlineAt);
    clients.push(recovery);
    await recovery.initialize();
    const recovered = await recovery.request("thread/resume", resumeParams(activeThreadId, workspace));
    const recoveredThread = requireThreadHistory(
      recovered,
      activeThreadId,
      ["active", "idle"],
      activeTurnId,
      ["inProgress", "interrupted"],
      "active_resume",
    );
    report.activeTurnDisconnect.resumeStatus = publicThreadStatus(recoveredThread.status);
    report.activeTurnDisconnect.resumeTurnCount = recoveredThread.turns.length;
    report.activeTurnDisconnect.resumeLastTurnStatus = publicTurnStatus(recoveredThread.turns.at(-1)?.status);
    report.activeTurnDisconnect.resumeLastTurnItemTypes = publicItemTypeSummary(recoveredThread.turns.at(-1)?.items);

    let recoveredTerminal = recoveredThread.turns.find((candidate) => candidate.id === activeTurnId);
    if (!recoveredTerminal || recoveredTerminal.status === "inProgress") {
      try {
        const terminal = await recovery.waitFor(terminalFor(activeThreadId, activeTurnId), 120_000);
        recoveredTerminal = terminal.params.turn;
      } catch (error) {
        if (!(error instanceof NotificationTimeoutError)) throw error;
        const reread = await recovery.request("thread/read", {
          threadId: activeThreadId,
          includeTurns: true,
        });
        const rereadThread = requireThreadHistory(
          reread,
          activeThreadId,
          ["idle"],
          activeTurnId,
          ["interrupted"],
          "active_timeout_reread",
        );
        recoveredTerminal = rereadThread.turns.find((candidate) => candidate.id === activeTurnId);
      }
    }
    if (recoveredTerminal?.id !== activeTurnId || publicTurnStatus(recoveredTerminal.status) !== "interrupted") {
      throw new RecoveryContractError("active_final_terminal_status");
    }
    const finalRead = await recovery.request("thread/read", {
      threadId: activeThreadId,
      includeTurns: true,
    });
    const finalThread = requireThreadHistory(
      finalRead,
      activeThreadId,
      ["idle"],
      activeTurnId,
      ["interrupted"],
      "active_final_read",
    );
    report.activeTurnDisconnect.finalObservedStatus = publicTurnStatus(recoveredTerminal?.status);
    report.activeTurnDisconnect.finalReadStatus = publicThreadStatus(finalThread.status);
    report.activeTurnDisconnect.recoverySequence = summarize(recovery);
    report.environment.successfulModelPreflightChecks = clients.reduce(
      (count, client) => count + client.modelPreflightChecks,
      0,
    );
    if (report.environment.successfulModelPreflightChecks !== report.environment.externalTurns) {
      throw new Error("model preflight count did not match actual Turn count");
    }
    await recovery.stop();
    report.status = "pass";
  } finally {
    const cleanupErrors = [];
    for (const client of clients) {
      try {
        await client.stop(true);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      const processCleanupVerified = cleanupErrors.length === 0 && activeProcessOwners.size === 0;
      await deleteTempAfterVerifiedProcessCleanup(processCleanupVerified, async () => {
        await withDeadline(
          () => rm(workspace, { recursive: true, force: true }),
          cleanupDeadlineAt,
          "temp workspace deletion",
        );
      });
      if (!processCleanupVerified) cleanupErrors.push(new Error("probe process cleanup was not verified"));
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "probe cleanup failed");
    report.cleanup = "verified";
  }

  return report;
}

function probeMode(argumentsList) {
  if (argumentsList.length === 0) return "live";
  if (argumentsList.length === 1 && argumentsList[0] === "--self-test") return "self_test";
  if (argumentsList.length === 1 && argumentsList[0] === "--preflight-only") return "preflight";
  throw new Error("unknown or conflicting probe arguments");
}

async function main(mode, startedAt) {
  if (mode === "self_test") return selfTestReport();
  return recoveryReport(mode === "preflight", startedAt);
}

async function writeReport() {
  const startedAt = Date.now();
  const mode = probeMode(process.argv.slice(2));
  const hardDeadlineMs =
    mode === "self_test" && process.env[SELF_TEST_STALLED_DELETE_ENV] === "1"
      ? 250
      : mode === "self_test"
        ? 30_000
        : MAX_TOTAL_MS;
  const hardDeadlineAt = startedAt + hardDeadlineMs;
  const hardDeadline = setTimeout(
    () => {
      const cleanupRecovery = cleanupRecoveryTargetsForOwners(activeProcessOwners);
      emergencyStopOwnedProcesses();
      const failure = { status: "failed", error: { kind: "total_deadline" } };
      if (cleanupRecovery.length > 0) failure.cleanupRecovery = cleanupRecovery;
      process.stderr.write(`${JSON.stringify(failure)}\n`);
      process.exit(124);
    },
    Math.max(1, hardDeadlineAt - Date.now()),
  );
  try {
    const report = await main(mode, startedAt);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (canClearHardDeadline()) clearTimeout(hardDeadline);
  }
}

writeReport().catch((error) => {
  const kind =
    error instanceof ProbeDeadlineError
      ? "probe_deadline"
      : error instanceof NotificationTimeoutError
        ? "notification_timeout"
        : error instanceof RequestTimeoutError
          ? "request_timeout"
          : error instanceof RpcRequestError
            ? "rpc_rejection"
            : "probe_failure";
  const failure = { status: "failed", error: { kind } };
  if (error instanceof RecoveryContractError) failure.error.stage = error.stage;
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
});
