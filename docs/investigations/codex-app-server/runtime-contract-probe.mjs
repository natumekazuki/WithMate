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
const PROVIDER_PREFLIGHT_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;
const PROCESS_EXIT_GRACE_MS = 2_000;
const PROCESS_FORCE_RESERVE_MS = 10_000;
const MAX_PROBE_MS = 14 * 60_000;
const MAX_TOTAL_MS = 15 * 60_000;
const SELF_TEST_STALLED_DELETE_ENV = "WITHMATE_RUNTIME_PROBE_SELF_TEST_STALLED_DELETE";
let activeDeadlineOperations = 0;

class ProbeDeadlineError extends Error {
  constructor(operation) {
    super(`${operation} exceeded the probe deadline`);
    this.name = "ProbeDeadlineError";
  }
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function boundedTimeout(deadlineAt, requestedMs, operation) {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) throw new ProbeDeadlineError(operation);
  return Math.max(1, Math.min(requestedMs, remaining));
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
    const timer = setTimeout(() => rejectPromise(new ProbeDeadlineError(operation)), timeoutMs);
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

class ProviderPreflightError extends Error {
  constructor() {
    super("provider preflight failed");
    this.name = "ProviderPreflightError";
  }
}

class AppServerClient {
  constructor(deadlineAt, cleanupDeadlineAt) {
    this.deadlineAt = deadlineAt;
    this.cleanupDeadlineAt = cleanupDeadlineAt;
    this.nextId = 1;
    this.nextSequence = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.stopping = false;

    const invocation = resolveCodexInvocation(boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex discovery"));
    this.processOwner = spawnOwnedProcess(invocation.command, [...invocation.prefixArgs, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = this.processOwner.controller;
    this.processReady = this.processOwner.ready;
    this.process.stderr.resume();

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
        if (event.sequence <= waiter.afterSequence || !waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    });

    this.process.once("exit", () => {
      const error = new Error(
        this.stopping
          ? "app-server stopped before an operation completed"
          : "app-server exited before the probe completed",
      );
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
    const effectiveTimeoutMs = boundedTimeout(this.deadlineAt, timeoutMs, method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, effectiveTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS, afterSequence = 0) {
    const existing = this.events.find((event) => event.sequence > afterSequence && predicate(event.message));
    if (existing !== undefined) return Promise.resolve(existing);
    const effectiveTimeoutMs = boundedTimeout(this.deadlineAt, timeoutMs, "notification wait");
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, afterSequence };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("notification timed out"));
      }, effectiveTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize() {
    await waitForProcessOwnerReady(this.processOwner, this.deadlineAt, "app-server process launch");
    await this.request("initialize", {
      clientInfo: { name: "withmate-runtime-contract-probe", version: "1.0.0" },
      capabilities: null,
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop() {
    const deadlineAt = this.cleanupDeadlineAt;
    if (!processHasExited(this.process)) {
      this.stopping = true;
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
}

function runCodex(args, deadlineAt) {
  const invocation = resolveCodexInvocation(boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex discovery"));
  return spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex command"),
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
    model: VALIDATION_MODEL_SELECTION.model,
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
    model: VALIDATION_MODEL_SELECTION.model,
    effort: VALIDATION_MODEL_SELECTION.reasoningEffort,
  };
}

function terminalFor(threadId, turnId) {
  return (message) =>
    message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId;
}

function turnErrorFor(threadId, turnId) {
  return (message) =>
    message.method === "error" && message.params?.threadId === threadId && message.params?.turnId === turnId;
}

function terminalOrErrorFor(threadId, turnId) {
  return (message) => terminalFor(threadId, turnId)(message) || turnErrorFor(threadId, turnId)(message);
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

function preflightTimeout(deadlineAt) {
  return boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "provider preflight");
}

async function inspectProviderPreflight(client) {
  const deadlineAt = Math.min(client.deadlineAt, Date.now() + PROVIDER_PREFLIGHT_TIMEOUT_MS);
  const evidence = await inspectValidationModelPreflight(async (method, params) => {
    const response = await client.request(method, params, preflightTimeout(deadlineAt));
    return response.result;
  });
  if (evidence === undefined) return undefined;
  const model = {
    model: evidence.model.model,
    modelId: evidence.model.modelId,
    hidden: evidence.model.hidden,
    reasoningEffort: evidence.model.reasoningEffort,
    supportedReasoningEfforts: evidence.model.supportedReasoningEfforts,
  };
  return { ...evidence, model };
}

async function startValidatedTurn(client, threadId, text) {
  const preflight = await inspectProviderPreflight(client);
  if (preflight === undefined) throw new ProviderPreflightError();
  const response = await client.request("turn/start", turnParams(threadId, text));
  return { response, preflight };
}

async function waitForTerminal(client, threadId, turnId) {
  const deadlineAt = Math.min(client.deadlineAt, Date.now() + TURN_TIMEOUT_MS);
  let afterSequence = 0;
  for (;;) {
    const availableMs = remainingMs(deadlineAt);
    if (availableMs <= 0) throw new ProbeDeadlineError("terminal notification");
    const event = await client.waitFor(terminalOrErrorFor(threadId, turnId), availableMs, afterSequence);
    if (terminalFor(threadId, turnId)(event.message)) return event;
    if (event.message.params?.willRetry !== true) throw new Error("Turn failed before terminal notification");
    afterSequence = event.sequence;
  }
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

async function probeInterrupt(workspace, deadlineAt, cleanupDeadlineAt) {
  const client = new AppServerClient(deadlineAt, cleanupDeadlineAt);
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, true));
    const threadId = started.result.thread.id;
    const validatedTurn = await startValidatedTurn(
      client,
      threadId,
      "Without using tools, output the integers from 1 through 100000, one integer per line, and nothing else.",
    );
    const turnId = validatedTurn.response.result.turn.id;
    const firstDelta = await client.waitFor(firstAgentDeltaFor(threadId, turnId));
    const interruptPromise = client.request("turn/interrupt", { threadId, turnId });
    const terminalPromise = waitForTerminal(client, threadId, turnId);
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
      modelSelection: validatedTurn.preflight,
    };
  } finally {
    await client.stop();
  }
}

async function probeSteer(workspace, deadlineAt, cleanupDeadlineAt) {
  const client = new AppServerClient(deadlineAt, cleanupDeadlineAt);
  const supplementalText = "Stop the current response and reply with exactly: STEERED_OK";
  const mismatchedText = "This mismatched input must be rejected.";
  const terminalText = "This terminal input must be rejected.";
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, false));
    const threadId = started.result.thread.id;
    const validatedTurn = await startValidatedTurn(
      client,
      threadId,
      "Without using tools, output the integers from 1 through 100000, one integer per line, and nothing else.",
    );
    const turnId = validatedTurn.response.result.turn.id;
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
    const terminal = await waitForTerminal(client, threadId, turnId);
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
      modelSelection: validatedTurn.preflight,
    };
  } finally {
    await client.stop();
  }
}

async function probeAssistantPhase(workspace, deadlineAt, cleanupDeadlineAt) {
  const client = new AppServerClient(deadlineAt, cleanupDeadlineAt);
  try {
    await client.initialize();
    const started = await client.request("thread/start", startParams(workspace, true));
    const threadId = started.result.thread.id;
    const validatedTurn = await startValidatedTurn(
      client,
      threadId,
      "Without using tools, first send one brief commentary progress update. Then send a final answer containing exactly: PHASE_FINAL_OK",
    );
    const turnId = validatedTurn.response.result.turn.id;
    const terminal = await waitForTerminal(client, threadId, turnId);
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
      modelSelection: validatedTurn.preflight,
    };
  } finally {
    await client.stop();
  }
}

function inspectDaemonSupport(deadlineAt) {
  const result = runCodex(["app-server", "daemon", "version"], deadlineAt);
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
  if (error instanceof ProviderPreflightError) return { kind: "provider_preflight_failed" };
  if (error instanceof ProbeDeadlineError) return { kind: "probe_deadline" };
  if (error instanceof Error && error.message.endsWith(" timed out")) {
    return { kind: "timeout", operation: error.message.slice(0, -" timed out".length) };
  }
  return { kind: "probe_assertion_or_process_failure" };
}

function requireSelfTest(condition, name) {
  if (!condition) throw new Error(`self-test failed: ${name}`);
}

function syntheticModelEntry({
  hidden = false,
  efforts = ["low", "medium", VALIDATION_MODEL_SELECTION.reasoningEffort],
} = {}) {
  return {
    id: VALIDATION_MODEL_SELECTION.model,
    model: VALIDATION_MODEL_SELECTION.model,
    hidden,
    defaultReasoningEffort: efforts.includes(VALIDATION_MODEL_SELECTION.reasoningEffort)
      ? VALIDATION_MODEL_SELECTION.reasoningEffort
      : efforts[0],
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  };
}

function syntheticPreflightClient({ efforts, hideValidationModel = false } = {}) {
  const requests = [];
  return {
    requests,
    async request(method, params) {
      requests.push({ method, params });
      if (method === "modelProvider/capabilities/read") {
        return { result: { imageGeneration: true, namespaceTools: true, webSearch: true } };
      }
      if (method === "model/list") {
        const validationModel = syntheticModelEntry({ hidden: hideValidationModel, efforts });
        return {
          result: {
            data:
              params.includeHidden === true
                ? [validationModel, { id: "hidden-model", model: "hidden-model", hidden: true }]
                : hideValidationModel
                  ? []
                  : [validationModel],
            nextCursor: null,
          },
        };
      }
      if (method === "turn/start") return { result: { turn: { id: "turn-self-test" } } };
      throw new Error("unexpected synthetic request");
    },
  };
}

async function selfTestReport() {
  if (process.env[SELF_TEST_STALLED_DELETE_ENV] === "1") {
    await withDeadline(() => new Promise(() => {}), Date.now() + 10, "stalled temp deletion");
    throw new Error("stalled temp deletion unexpectedly settled");
  }
  const thread = startParams("<workspace>", true);
  const turn = turnParams("thread-a", "probe");
  requireSelfTest(
    thread.model === VALIDATION_MODEL_SELECTION.model &&
      turn.model === VALIDATION_MODEL_SELECTION.model &&
      turn.effort === VALIDATION_MODEL_SELECTION.reasoningEffort &&
      VALIDATION_MODEL_SELECTION.reasoningEffort !== "ultra",
    "all model entrances select Luna with non-ultra high reasoning",
  );
  const terminal = { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a" } } };
  const error = { method: "error", params: { threadId: "thread-a", turnId: "turn-a", willRetry: false } };
  requireSelfTest(
    terminalFor("thread-a", "turn-a")(terminal) &&
      !terminalFor("thread-b", "turn-a")(terminal) &&
      !terminalFor("thread-a", "turn-b")(terminal) &&
      turnErrorFor("thread-a", "turn-a")(error) &&
      !turnErrorFor("thread-b", "turn-a")(error) &&
      !turnErrorFor("thread-a", "turn-b")(error),
    "terminal and error signals require the exact Thread and Turn owner tuple",
  );
  const bufferedSignals = [
    { sequence: 1, message: { ...terminal, params: { ...terminal.params, threadId: "thread-b" } } },
    { sequence: 2, message: { ...error, params: { ...error.params, willRetry: true } } },
    { sequence: 3, message: terminal },
  ];
  const terminalAfterRetry = await waitForTerminal(
    {
      events: bufferedSignals,
      waitFor: async (predicate, _timeoutMs, afterSequence) =>
        bufferedSignals.find((event) => event.sequence > afterSequence && predicate(event.message)),
    },
    "thread-a",
    "turn-a",
  );
  requireSelfTest(
    terminalAfterRetry?.sequence === 3,
    "wrong-owner terminal is ignored and a retryable exact-owner error does not terminate the wait",
  );

  const client = syntheticPreflightClient();
  const validatedTurn = await startValidatedTurn(client, "thread-a", "probe");
  requireSelfTest(
    validatedTurn.preflight.model.model === VALIDATION_MODEL_SELECTION.model &&
      validatedTurn.preflight.model.reasoningEffort === VALIDATION_MODEL_SELECTION.reasoningEffort &&
      validatedTurn.preflight.visibility.includeHiddenContract === "verified",
    "current capabilities and both model catalogs support the exact tuple",
  );
  requireSelfTest(
    client.requests.map((request) => request.method).join(",") ===
      "modelProvider/capabilities/read,model/list,model/list,turn/start" &&
      client.requests[1].params.includeHidden === false &&
      client.requests[2].params.includeHidden === true,
    "provider preflight immediately precedes every synthetic Turn",
  );
  requireSelfTest(
    (await inspectProviderPreflight(syntheticPreflightClient({ efforts: ["medium"] }))) === undefined,
    "an unsupported reasoning tuple fails closed",
  );
  requireSelfTest(
    (await inspectProviderPreflight(syntheticPreflightClient({ hideValidationModel: true })))?.model.hidden === true,
    "a hidden Luna model is accepted only through the complete catalog",
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
  return { mode: "self_test", status: "pass", externalTurns: 0 };
}

async function preflightReport(workspace, version, deadlineAt, cleanupDeadlineAt) {
  const client = new AppServerClient(deadlineAt, cleanupDeadlineAt);
  try {
    await client.initialize();
    const preflight = await inspectProviderPreflight(client);
    if (preflight === undefined) throw new ProviderPreflightError();
    return {
      mode: "preflight",
      status: "pass",
      environment: {
        codexVersion: version,
        nodeVersion: process.version,
        platform: process.platform,
        transport: "stdio_jsonl",
        workspace: "<workspace>",
        externalTurns: 0,
      },
      modelSelection: preflight,
    };
  } finally {
    await client.stop();
  }
}

function validateArguments(argumentsList) {
  if (argumentsList.length === 0) return "live";
  if (argumentsList.length === 1 && argumentsList[0] === "--preflight") return "preflight";
  if (argumentsList.length === 1 && argumentsList[0] === "--self-test") return "self_test";
  throw new Error("unknown or conflicting probe arguments");
}

async function main(mode, startedAt) {
  if (mode === "self_test") {
    return selfTestReport();
  }
  const deadlineAt = startedAt + MAX_PROBE_MS;
  const cleanupDeadlineAt = startedAt + MAX_TOTAL_MS;
  const workspace = mkdtempSync(join(tmpdir(), "withmate-codex-runtime-contract-"));
  try {
    const versionResult = runCodex(["--version"], deadlineAt);
    if (versionResult.error !== undefined || versionResult.status !== 0) {
      throw new Error("codex version failed");
    }
    const codexVersion = versionResult.stdout.trim();
    if (mode === "preflight") {
      return await preflightReport(workspace, codexVersion, deadlineAt, cleanupDeadlineAt);
    }
    const report = {
      environment: {
        codexVersion,
        nodeVersion: process.version,
        platform: process.platform,
        transport: "stdio_jsonl",
        workspace: "<workspace>",
        sandbox: "read-only",
        approvalPolicy: "never",
        model: VALIDATION_MODEL_SELECTION.model,
        reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
      },
      cas009: null,
      cas010: null,
      cas016: null,
      cas017: inspectDaemonSupport(deadlineAt),
    };

    report.cas009 = await probeInterrupt(workspace, deadlineAt, cleanupDeadlineAt);
    report.cas010 = await probeSteer(workspace, deadlineAt, cleanupDeadlineAt);
    report.cas016 = await probeAssistantPhase(workspace, deadlineAt, cleanupDeadlineAt);
    return report;
  } finally {
    const processCleanupVerified = activeProcessOwners.size === 0;
    await deleteTempAfterVerifiedProcessCleanup(processCleanupVerified, async () =>
      withDeadline(() => rm(workspace, { recursive: true, force: true }), cleanupDeadlineAt, "temp workspace deletion"),
    );
    if (!processCleanupVerified) throw new Error("probe process cleanup was not verified");
  }
}

async function writeReport() {
  const startedAt = Date.now();
  const mode = validateArguments(process.argv.slice(2));
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
  process.stderr.write(`${JSON.stringify({ status: "failed", error: safeFailure(error) })}\n`);
  process.exitCode = 1;
});
