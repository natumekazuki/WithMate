import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { inspectValidationModelPreflight, VALIDATION_MODEL_SELECTION } from "./validation-model-preflight.mjs";
import {
  activeProcessOwners,
  assertOwnedSystemdUnitName,
  cleanupRecoveryTargetsForOwners,
  deleteTempAfterVerifiedProcessCleanup,
  emergencyStopOwnedProcesses,
  forgetOwnerAfterVerifiedCleanup,
  processHasExited,
  processIsAlive,
  processOwnerContractSelfTest,
  resolveCodexInvocation,
  spawnOwnedProcess,
  stopOwnedSystemdUnit,
  terminateAndReleaseProcessOwner,
  waitForObservedProcessesExit,
  waitForOwnedControllerExit,
  waitForProcessExit,
  waitForSpawn,
  waitForSystemdUnitInactiveOrAbsent,
} from "./probe-process-owner.mjs";

const CODEX_SCHEMA_BASELINE = "codex-cli 0.145.0";
const CODEX_PUBLIC_PROVIDER_ID = "codex";
const CODEX_INTERACTION_DEFINITION_VERSION = "codex-provider-v1";
const REQUEST_TIMEOUT_MS = 30_000;
const INTERACTION_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 90_000;
const TERMINAL_OBSERVATION_MS = 15_000;
const BOUNDED_WAIT_MS = 2_500;
const INTERRUPT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_GRACE_MS = 2_000;
const PROCESS_FORCE_RESERVE_MS = 10_000;
const PROCESS_FORCE_WAIT_MS = 3_000;
const CLEANUP_FILESYSTEM_RESERVE_MS = 5_000;
const MAX_APP_SERVER_EVENT_COUNT = 4_096;
const MAX_APP_SERVER_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_APP_SERVER_LINE_BYTES = 256 * 1024;
const MAX_MCP_AUDIT_EVENTS = 64;
const MAX_MCP_AUDIT_BYTES = 64 * 1024;
const MAX_TURNS = 10;
const MAX_PROBE_MS = 14 * 60_000;
const MAX_TOTAL_MS = 15 * 60_000;
const EXPECTED_MCP_LIFECYCLE = [
  "initialized",
  "tools_list",
  "tools_call_received",
  "elicitation_response_received",
  "tool_result_sent",
];
const MCP_TOOL_APPROVAL_KIND = "mcp_tool_call";
const MCP_TOOL_APPROVAL_REQUEST_TYPE = "approval_request";
const MCP_TOOL_DESCRIPTION = "Requests one bounded local form value.";
const PUBLIC_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall"]);
const PUBLIC_ITEM_STATUSES = new Set(["completed", "declined", "failed", "cancelled", "inProgress"]);
const PUBLIC_THREAD_STATUS_TYPES = new Set(["notLoaded", "idle", "active", "systemError"]);
const PUBLIC_THREAD_ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const PUBLIC_TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted"]);
const MCP_TOOL_APPROVAL_META_KEYS = new Set([
  "codex_approval_kind",
  "persist",
  "request_type",
  "tool_description",
  "tool_name",
  "tool_params",
]);
const PERMISSION_KEYS = new Set(["fileSystem", "network"]);
const FILE_SYSTEM_PERMISSION_KEYS = new Set(["entries", "globScanMaxDepth", "read", "write"]);
const MCP_SCHEMA_KEYS = new Set(["properties", "required", "type"]);
const MCP_SCHEMA_PROPERTY_KEYS = new Set(["choice"]);
const TARGET_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
const PROTOCOL_DECLINE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
]);
const MODE_FLAGS = new Set([
  "--approval-live",
  "--command-diagnostic",
  "--duplicate-after-resolved-live",
  "--disconnect-live",
  "--disconnect-resolved-live",
  "--follow-up",
  "--follow-up-live",
  "--follow-up-preflight",
  "--live",
  "--mcp-direct",
  "--mcp-turn-diagnostic",
  "--mcp-turn-warmup-diagnostic",
  "--multi-run-live",
  "--parallel-batch-live",
  "--phase-live",
  "--permission-live",
  "--race-interrupt-first-live",
  "--race-live",
  "--self-test",
  "--user-input-live",
]);
const SELF_TEST_CLEANUP_FAILURE_ENV = "WITHMATE_PROBE_SELF_TEST_CLEANUP_FAILURE";
const SELF_TEST_CLEANUP_AUDIT_ENV = "WITHMATE_PROBE_SELF_TEST_CLEANUP_AUDIT";

const scriptPath = fileURLToPath(import.meta.url);

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

function boundedSleep(requestedMs, deadlineAt, operation) {
  const timeoutMs = boundedTimeout(deadlineAt, requestedMs, operation);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

function withDeadline(promise, deadlineAt, operation) {
  const timeoutMs = boundedTimeout(deadlineAt, remainingMs(deadlineAt), operation);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new ProbeDeadlineError(operation)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function shouldAttemptGracefulStop(deadlineAt) {
  return remainingMs(deadlineAt) > PROCESS_EXIT_GRACE_MS + PROCESS_FORCE_RESERVE_MS;
}

function codexInvocation(deadlineAt) {
  return resolveCodexInvocation(boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex discovery"));
}

function eventBufferWouldOverflow(eventCount, eventBytes, nextLineBytes) {
  return (
    nextLineBytes > MAX_APP_SERVER_LINE_BYTES ||
    eventCount >= MAX_APP_SERVER_EVENT_COUNT ||
    eventBytes + nextLineBytes > MAX_APP_SERVER_EVENT_BYTES
  );
}

class RpcRequestError extends Error {
  constructor(method, message) {
    super(`${method} was rejected`);
    this.name = "RpcRequestError";
    this.method = method;
    this.code = message.error?.code ?? null;
  }
}

class AppServerClient {
  constructor(configOverrides, initializeCapabilities = null, deadlineAt) {
    this.nextId = 1;
    this.nextSequence = 1;
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.eventBytes = 0;
    this.stdoutLineChunks = [];
    this.stdoutLineBytes = 0;
    this.stopping = false;
    this.stderrBytes = 0;
    this.stderrTail = "";
    this.initializeCapabilities = initializeCapabilities;
    this.deadlineAt = deadlineAt;
    this.processError = null;

    const invocation = codexInvocation(deadlineAt);
    const args = [...invocation.prefixArgs, "app-server", "--stdio"];
    for (const override of configOverrides) args.push("-c", override);
    this.processOwner = spawnOwnedProcess(invocation.command, args, {
      env: { ...process.env, RUST_LOG: "codex_app_server=warn,codex_core=warn" },
    });
    this.process = this.processOwner.controller;
    this.processReady = this.processOwner.ready;
    this.process.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-65_536);
    });
    this.process.once("error", (error) => {
      this.fail(error);
    });
    this.process.stdout.on("data", (chunk) => this.acceptStdoutChunk(chunk));
    this.process.stdout.once("end", () => this.acceptStdoutEnd());
    this.process.stdout.once("error", (error) => this.fail(error));
    void this.processOwner.controllerExit.then(() => this.failOutstanding(new Error("app-server exited")));
  }

  acceptStdoutChunk(chunk) {
    if (this.processError !== null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (this.stdoutLineBytes + segment.length > MAX_APP_SERVER_LINE_BYTES) {
        this.failTransport(new Error("app-server JSONL line limit exceeded"));
        return;
      }
      if (segment.length > 0) {
        this.stdoutLineChunks.push(segment);
        this.stdoutLineBytes += segment.length;
      }
      if (newline === -1) return;
      let line = Buffer.concat(this.stdoutLineChunks, this.stdoutLineBytes);
      this.stdoutLineChunks = [];
      this.stdoutLineBytes = 0;
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      this.acceptLineBuffer(line);
      if (this.processError !== null) return;
      offset = newline + 1;
    }
  }

  acceptStdoutEnd() {
    if (this.processError !== null || this.stdoutLineBytes === 0) return;
    let line = Buffer.concat(this.stdoutLineChunks, this.stdoutLineBytes);
    this.stdoutLineChunks = [];
    this.stdoutLineBytes = 0;
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    this.acceptLineBuffer(line);
  }

  acceptLineBuffer(line) {
    if (this.processError !== null) return;
    const lineBytes = line.length;
    if (eventBufferWouldOverflow(this.events.length, this.eventBytes, lineBytes)) {
      this.failTransport(new Error("app-server event buffer limit exceeded"));
      return;
    }
    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      this.failTransport(new Error("invalid app-server JSONL message"));
      return;
    }
    if (!isPlainObject(message)) {
      this.failTransport(new Error("invalid app-server JSONL message"));
      return;
    }
    const event = { message, sequence: this.nextSequence++ };
    this.events.push(event);
    this.eventBytes += lineBytes;
    if (message.method === undefined && message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error === undefined) pending.resolve({ result: message.result, sequence: event.sequence });
      else pending.reject(new RpcRequestError(pending.method, message));
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  }

  fail(error) {
    if (this.processError !== null) return this.processError;
    this.processError = error;
    this.failOutstanding(error);
    return error;
  }

  failTransport(error) {
    const terminalError = this.fail(error);
    this.process.stdout.destroy();
    return terminalError;
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
    if (this.processOwner.hasControllerExited()) throw new Error("app-server exited");
    if (!this.process.stdin.writable) throw new Error("app-server stdin is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS, deadlineAt = this.deadlineAt) {
    const id = this.nextId++;
    const effectiveTimeoutMs = boundedTimeout(deadlineAt, timeoutMs, method);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out`));
      }, effectiveTimeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  respond(id, result) {
    const marker = { method: "<response-sent>", params: {} };
    const markerBytes = Buffer.byteLength(JSON.stringify(marker), "utf8");
    if (eventBufferWouldOverflow(this.events.length, this.eventBytes, markerBytes)) {
      throw this.failTransport(new Error("app-server event buffer limit exceeded"));
    }
    const sequence = this.nextSequence++;
    this.send({ id, result });
    this.events.push({ message: marker, sequence });
    this.eventBytes += markerBytes;
    return sequence;
  }

  waitFor(predicate, timeoutMs = TURN_TIMEOUT_MS, afterSequence = 0, deadlineAt = this.deadlineAt) {
    if (this.processError !== null) return Promise.reject(this.processError);
    const existing = this.events.find((event) => event.sequence > afterSequence && predicate(event.message));
    if (existing !== undefined) return Promise.resolve(existing);
    const effectiveTimeoutMs = boundedTimeout(deadlineAt, timeoutMs, "notification wait");
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { predicate, resolve: resolvePromise, reject: rejectPromise };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        rejectPromise(new Error("notification timed out"));
      }, effectiveTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  async initialize(deadlineAt = this.deadlineAt) {
    await withDeadline(this.processReady, deadlineAt, "app-server process launch");
    await this.request(
      "initialize",
      {
        clientInfo: { name: "withmate-interaction-contract-probe", version: "1.0.0" },
        capabilities: this.initializeCapabilities,
      },
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    this.send({ method: "initialized", params: {} });
  }

  diagnosticFlags() {
    const flags = [];
    if (this.stderrTail.includes("failed to submit ResolveElicitation")) {
      flags.push("submit_resolve_elicitation_failed");
    }
    if (this.stderrTail.includes("failed to resolve elicitation request in session")) {
      flags.push("session_resolve_elicitation_failed");
    }
    if (this.stderrTail.includes("failed to deserialize McpServerElicitationRequestResponse")) {
      flags.push("client_response_deserialize_failed");
    }
    if (/elicitation request not found/iu.test(this.stderrTail)) flags.push("elicitation_request_not_found");
    return flags;
  }

  async stop(deadlineAt = this.deadlineAt) {
    let forced = false;
    if (!this.processOwner.hasControllerExited()) {
      this.stopping = true;
      this.failOutstanding(new Error("app-server is stopping"));
      if (this.process.stdin.writable) this.process.stdin.end();
      if (shouldAttemptGracefulStop(deadlineAt)) {
        await waitForOwnedControllerExit(
          this.processOwner,
          PROCESS_EXIT_GRACE_MS,
          deadlineAt,
          "app-server graceful stop",
        );
      }
    }

    if (!this.processOwner.hasControllerExited()) {
      forced = true;
    }

    await this.processOwner.cleanup(deadlineAt, "app-server ownership cleanup confirmation");
    return { exitConfirmed: true, forced };
  }
}

function assertOwnedTempPath(path, prefix) {
  const root = resolve(tmpdir());
  const candidate = resolve(path);
  if (!isAbsolute(candidate) || candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("probe temp path escaped the OS temp directory");
  }
  if (!candidate.split(sep).at(-1)?.startsWith(prefix)) throw new Error("probe temp path has an unexpected prefix");
}

function createMcpLauncher(root) {
  const launcher = join(root, process.platform === "win32" ? "withmate-probe-mcp.cmd" : "withmate-probe-mcp.sh");
  const auditPath = join(root, "mcp-audit.log");
  if (process.platform === "win32") {
    const node = process.execPath.replaceAll("/", "\\");
    const script = scriptPath.replaceAll("/", "\\");
    const audit = auditPath.replaceAll("/", "\\");
    writeFileSync(launcher, `@echo off\r\n\"${node}\" \"${script}\" --mcp-fixture --audit-file \"${audit}\"\r\n`, {
      encoding: "utf8",
    });
  } else {
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec \"${process.execPath}\" \"${scriptPath}\" --mcp-fixture --audit-file \"${auditPath}\"\n`,
      { encoding: "utf8" },
    );
    chmodSync(launcher, 0o700);
  }
  return { auditPath, launcher };
}

const MCP_AUDIT_EVENTS = new Set([
  "initialized",
  "tools_list",
  "tools_call_received",
  "elicitation_response_received",
  "tool_result_sent",
]);

function parseBoundedMcpAudit(audit) {
  if (Buffer.byteLength(audit, "utf8") > MAX_MCP_AUDIT_BYTES) {
    throw new Error("MCP fixture audit byte limit exceeded");
  }
  const events = audit.split(/\r?\n/u).filter((event) => event.length > 0);
  if (events.length > MAX_MCP_AUDIT_EVENTS) throw new Error("MCP fixture audit event limit exceeded");
  return events;
}

function assertMcpAuditFileBounded(auditPath) {
  if (statSync(auditPath).size > MAX_MCP_AUDIT_BYTES) {
    throw new Error("MCP fixture audit byte limit exceeded");
  }
}

function publicMcpFixtureLifecycle(events) {
  return events.flatMap((event) => {
    if (MCP_AUDIT_EVENTS.has(event)) return [event];
    if (/^fixture_process:[1-9][0-9]*$/u.test(event)) return [];
    return ["other"];
  });
}

function readMcpFixtureLifecycle(auditPath) {
  if (auditPath === undefined || !existsSync(auditPath)) return [];
  assertMcpAuditFileBounded(auditPath);
  return publicMcpFixtureLifecycle(parseBoundedMcpAudit(readFileSync(auditPath, "utf8")));
}

function appendMcpAuditRecord(auditPath, event) {
  if (typeof event !== "string" || event.length === 0 || /[\r\n]/u.test(event)) {
    throw new Error("invalid MCP fixture audit event");
  }
  const lockPath = `${auditPath}.lock`;
  let lockFile;
  try {
    lockFile = openSync(lockPath, "wx", 0o600);
    const existingAudit = existsSync(auditPath)
      ? (assertMcpAuditFileBounded(auditPath), readFileSync(auditPath, "utf8"))
      : "";
    const existingEvents = parseBoundedMcpAudit(existingAudit);
    const record = `${event}\n`;
    const recordBytes = Buffer.byteLength(record, "utf8");
    if (
      existingEvents.length >= MAX_MCP_AUDIT_EVENTS ||
      Buffer.byteLength(existingAudit, "utf8") + recordBytes > MAX_MCP_AUDIT_BYTES
    ) {
      throw new Error("MCP fixture audit limit exceeded");
    }
    appendFileSync(auditPath, record, { encoding: "utf8" });
  } finally {
    if (lockFile !== undefined) {
      try {
        closeSync(lockFile);
      } finally {
        unlinkSync(lockPath);
      }
    }
  }
}

async function readMcpFixtureProcessIds(auditPath, deadlineAt) {
  if (auditPath === undefined || !existsSync(auditPath)) return [];
  assertMcpAuditFileBounded(auditPath);
  const audit = await withDeadline(readFile(auditPath, "utf8"), deadlineAt, "fixture process audit read");
  return parseBoundedMcpAudit(audit)
    .map((event) => /^fixture_process:(?<pid>[1-9][0-9]*)$/u.exec(event)?.groups?.pid)
    .filter((pid) => pid !== undefined)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isSafeInteger(pid));
}

function cleanupResourceDeadline(totalDeadlineAt, remainingOwners) {
  const available = remainingMs(totalDeadlineAt) - CLEANUP_FILESYSTEM_RESERVE_MS;
  if (available <= 0) throw new ProbeDeadlineError("process cleanup allocation");
  return Date.now() + Math.max(1, Math.floor(available / Math.max(1, remainingOwners)));
}

async function pathExists(path, deadlineAt) {
  try {
    await withDeadline(access(path), deadlineAt, "cleanup path verification");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function startThreadParams(workspace, approvalPolicy, sandbox, ephemeral = true) {
  return {
    model: VALIDATION_MODEL_SELECTION.model,
    cwd: workspace,
    ephemeral,
    approvalPolicy,
    sandbox,
    baseInstructions:
      "This is an isolated contract probe. Follow the requested single local tool action exactly. Never use network, credentials, or paths outside the current workspace.",
  };
}

function turnParams(threadId, approvalPolicy, sandboxPolicy, text) {
  return {
    threadId,
    input: [{ type: "text", text }],
    approvalPolicy,
    sandboxPolicy,
    model: VALIDATION_MODEL_SELECTION.model,
    effort: VALIDATION_MODEL_SELECTION.reasoningEffort,
  };
}

function granularApprovalPolicy(overrides = {}) {
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      mcp_elicitations: false,
      request_permissions: false,
      skill_approval: false,
      ...overrides,
    },
  };
}

function interactionBelongsToOwner(message, threadId, turnId) {
  return (
    TARGET_METHODS.has(message.method) && message.params?.threadId === threadId && message.params?.turnId === turnId
  );
}

function interactionFor(threadId, turnId) {
  return (message) => interactionBelongsToOwner(message, threadId, turnId);
}

function requestItemBelongsToOwner(client, requestEvent, threadId, turnId) {
  if (requestEvent.message.method === "mcpServer/elicitation/request") {
    return interactionBelongsToOwner(requestEvent.message, threadId, turnId);
  }
  const itemId = requestEvent.message.params?.itemId;
  if (typeof itemId !== "string") return false;
  if (
    !["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(requestEvent.message.method)
  ) {
    return true;
  }
  return client.events.some(
    (event) =>
      event.sequence <= requestEvent.sequence &&
      event.message.method === "item/started" &&
      event.message.params?.threadId === threadId &&
      event.message.params?.turnId === turnId &&
      event.message.params?.item?.id === itemId,
  );
}

function terminalFor(threadId, turnId) {
  return (message) =>
    message.method === "turn/completed" && message.params?.threadId === threadId && message.params?.turn?.id === turnId;
}

function resolvedFor(requestId, threadId) {
  return (message) =>
    message.method === "serverRequest/resolved" &&
    message.params?.requestId === requestId &&
    message.params?.threadId === threadId;
}

function responseFor(method, params, decision, workspace, userInputAnswer = "probe-choice") {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval":
      return decision === "accept"
        ? {
            permissions: {
              fileSystem: { entries: [{ access: "write", path: { type: "path", path: workspace } }] },
              network: null,
            },
            scope: "turn",
            strictAutoReview: null,
          }
        : { permissions: {}, scope: "turn", strictAutoReview: null };
    case "item/tool/requestUserInput": {
      if (decision !== "accept") throw new Error("user input cannot be answered by a decline decision");
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      const answers = {};
      for (const question of questions) {
        if (typeof question?.id === "string") answers[question.id] = { answers: [userInputAnswer] };
      }
      return { answers };
    }
    case "mcpServer/elicitation/request":
      if (decision !== "accept") return { action: decision, content: null };
      if (mcpInteractionKind(params) === "tool_approval") return { action: "accept", content: {} };
      if (mcpInteractionKind(params) === "server_form") {
        return { action: "accept", content: { choice: "probe-choice" } };
      }
      throw new Error("unsupported MCP interaction discriminator");
    default:
      throw new Error("unsupported probe response method");
  }
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function exactJson(left, right) {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return Object.is(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => exactJson(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return exactJson(leftKeys, rightKeys) && leftKeys.every((key) => exactJson(left[key], right[key]));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicObjectKeySummary(value, allowlist) {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  return {
    keyCount: keys.length,
    unknownKeyCount: keys.filter((key) => !allowlist.has(key)).length,
  };
}

function unicodeCodePointLength(value) {
  return Array.from(value).length;
}

function isBoundedString(value, maximum, minimum = 1) {
  if (typeof value !== "string") return false;
  const length = unicodeCodePointLength(value);
  return length >= minimum && length <= maximum;
}

function isSafeWorkspaceRelativeDisplayPath(value) {
  if (
    !isBoundedString(value, 512) ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    return false;
  }
  if (value.startsWith("/") || value === "~" || value.startsWith("~/") || value.endsWith("/")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isUnique(values) {
  return new Set(values).size === values.length;
}

function hasExactKeys(value, expectedKeys) {
  return isPlainObject(value) && exactJson(Object.keys(value).sort(), [...expectedKeys].sort());
}

function isAvailableCodexDecisionList(decisions) {
  if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 3 || !isUnique(decisions)) {
    return false;
  }
  return decisions.every(
    (decision) => ["accept", "decline", "cancel"].includes(decision) && typeof decision === "string",
  );
}

function isAnswerablePublicProjection(snapshot) {
  if (
    !isPlainObject(snapshot) ||
    !hasExactKeys(snapshot, ["interactionId", "providerId", "definitionVersion", "kind", "answerable", "display"]) ||
    !isBoundedString(snapshot.interactionId, 128) ||
    !/^[A-Za-z0-9_.:-]+$/u.test(snapshot.interactionId) ||
    snapshot.providerId !== CODEX_PUBLIC_PROVIDER_ID ||
    snapshot.definitionVersion !== CODEX_INTERACTION_DEFINITION_VERSION ||
    snapshot.answerable !== true ||
    !isPlainObject(snapshot.display)
  )
    return false;
  const display = snapshot.display;
  switch (snapshot.kind) {
    case "codex.command_approval":
      return (
        hasExactKeys(display, ["summary", "command", "availableDecisions"]) &&
        isBoundedString(display.summary, 512) &&
        isBoundedString(display.command, 2_048) &&
        isAvailableCodexDecisionList(display.availableDecisions)
      );
    case "codex.file_change_approval":
      return (
        isBoundedString(display.summary, 512) &&
        Array.isArray(display.changes) &&
        display.changes.length >= 1 &&
        display.changes.length <= 256 &&
        display.changes.every(
          (change) =>
            isPlainObject(change) &&
            isSafeWorkspaceRelativeDisplayPath(change.displayPath) &&
            ["add", "update", "delete", "move"].includes(change.changeKind),
        )
      );
    case "codex.permission_approval":
      return (
        isBoundedString(display.summary, 512) &&
        Array.isArray(display.permissions) &&
        display.permissions.length >= 1 &&
        display.permissions.length <= 8 &&
        isUnique(display.permissions) &&
        display.permissions.every((permission) => ["workspace_write", "network"].includes(permission))
      );
    case "codex.user_input": {
      if (!Array.isArray(display.questions) || display.questions.length < 1 || display.questions.length > 32) {
        return false;
      }
      const questionIds = display.questions.map((question) => question?.questionId);
      return (
        questionIds.every((questionId) => isBoundedString(questionId, 128)) &&
        isUnique(questionIds) &&
        display.questions.every((question) => {
          if (
            !isPlainObject(question) ||
            !hasExactKeys(question, ["questionId", "header", "prompt", "allowOther", "options"]) ||
            !isBoundedString(question.header, 512) ||
            !isBoundedString(question.prompt, 2_048) ||
            typeof question.allowOther !== "boolean" ||
            !Array.isArray(question.options) ||
            question.options.length < 2 ||
            question.options.length > 16
          ) {
            return false;
          }
          const labels = question.options.map((option) => option?.label);
          return (
            labels.every((label) => isBoundedString(label, 512)) &&
            isUnique(labels) &&
            question.options.every(
              (option) =>
                isPlainObject(option) && (option.description === undefined || isBoundedString(option.description, 512)),
            )
          );
        })
      );
    }
    case "codex.mcp_tool_approval":
      return (
        isBoundedString(display.server, 512) &&
        isBoundedString(display.tool, 512) &&
        isBoundedString(display.summary, 2_048)
      );
    case "codex.mcp_server_form": {
      if (
        !isBoundedString(display.server, 512) ||
        !isBoundedString(display.message, 2_048) ||
        !Array.isArray(display.fields) ||
        display.fields.length < 1 ||
        display.fields.length > 32
      ) {
        return false;
      }
      const fieldIds = display.fields.map((field) => field?.fieldId);
      return (
        fieldIds.every((fieldId) => isBoundedString(fieldId, 128)) &&
        isUnique(fieldIds) &&
        display.fields.every(
          (field) =>
            isPlainObject(field) &&
            isBoundedString(field.label, 512) &&
            field.inputType === "string" &&
            typeof field.required === "boolean" &&
            Number.isInteger(field.maxLength) &&
            field.maxLength >= 1 &&
            field.maxLength <= 4_096,
        )
      );
    }
    default:
      return false;
  }
}

function responseMatchesCurrentSnapshot(snapshot, response) {
  if (
    !isAnswerablePublicProjection(snapshot) ||
    !isPlainObject(response) ||
    !hasExactKeys(response, ["interactionId", "kind", "payload"]) ||
    response.interactionId !== snapshot.interactionId ||
    response.kind !== snapshot.kind ||
    !isPlainObject(response.payload)
  ) {
    return false;
  }

  if (
    [
      "codex.command_approval",
      "codex.file_change_approval",
      "codex.permission_approval",
      "codex.mcp_tool_approval",
    ].includes(snapshot.kind)
  ) {
    if (!hasExactKeys(response.payload, ["decision"])) {
      return false;
    }
    if (snapshot.kind === "codex.command_approval") {
      return snapshot.display.availableDecisions.includes(response.payload.decision);
    }
    return ["accept", "decline", "cancel"].includes(response.payload.decision);
  }

  if (snapshot.kind === "codex.user_input") {
    if (!hasExactKeys(response.payload, ["answers"]) || !isPlainObject(response.payload.answers)) return false;
    const questions = snapshot.display.questions;
    if (
      !hasExactKeys(
        response.payload.answers,
        questions.map((question) => question.questionId),
      )
    )
      return false;
    return questions.every((question) => {
      const selected = response.payload.answers[question.questionId];
      return (
        Array.isArray(selected) &&
        selected.length === 1 &&
        isBoundedString(selected[0], 2_048) &&
        (question.options.some((option) => option.label === selected[0]) || question.allowOther)
      );
    });
  }

  if (snapshot.kind === "codex.mcp_server_form") {
    const action = response.payload.action;
    if (action === "decline" || action === "cancel") return hasExactKeys(response.payload, ["action"]);
    if (action !== "accept" || !hasExactKeys(response.payload, ["action", "values"])) return false;
    const values = response.payload.values;
    if (!isPlainObject(values)) return false;
    const fields = snapshot.display.fields;
    const fieldById = new Map(fields.map((field) => [field.fieldId, field]));
    if (Object.keys(values).some((fieldId) => !fieldById.has(fieldId))) return false;
    if (fields.some((field) => field.required && !Object.hasOwn(values, field.fieldId))) return false;
    return Object.entries(values).every(([fieldId, value]) => {
      const field = fieldById.get(fieldId);
      return typeof value === "string" && unicodeCodePointLength(value) <= field.maxLength;
    });
  }

  return false;
}

function mcpFormProviderResponse(snapshot, response) {
  if (snapshot.kind !== "codex.mcp_server_form" || !responseMatchesCurrentSnapshot(snapshot, response)) {
    throw new Error("MCP form response does not match the current snapshot");
  }
  return response.payload.action === "accept"
    ? { action: "accept", content: response.payload.values }
    : { action: response.payload.action, content: null };
}

function mcpRequestMeta(params) {
  const meta = params?.meta ?? params?._meta;
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta : undefined;
}

function isMcpToolApproval(params) {
  return mcpInteractionKind(params) === "tool_approval";
}

function mcpInteractionKind(params) {
  const approvalKind = mcpRequestMeta(params)?.codex_approval_kind;
  if (approvalKind === MCP_TOOL_APPROVAL_KIND) return "tool_approval";
  if (approvalKind !== undefined) return "unsupported";
  return params?.mode === "form" ? "server_form" : "unsupported";
}

function mcpStageMatches(interactionIndex, params) {
  const expectedKind = interactionIndex === 0 ? "tool_approval" : "server_form";
  return mcpInteractionKind(params) === expectedKind;
}

function mcpFormFor(threadId, turnId) {
  const ownedInteraction = interactionFor(threadId, turnId);
  return (message) =>
    ownedInteraction(message) &&
    message.method === "mcpServer/elicitation/request" &&
    mcpInteractionKind(message.params) === "server_form";
}

function mcpApprovalBoundaryEvent(events, resolvedPredicate, formPredicate, afterSequence) {
  const event = events.find(
    (candidate) =>
      candidate.sequence > afterSequence && (resolvedPredicate(candidate.message) || formPredicate(candidate.message)),
  );
  if (event === undefined) return undefined;
  return { kind: resolvedPredicate(event.message) ? "resolved" : "premature_form", event };
}

function auditMcpRequestLifecycle(events, threadId, turnId, throughSequence = Number.POSITIVE_INFINITY) {
  const requests = events.filter(
    (event) => event.sequence <= throughSequence && interactionBelongsToOwner(event.message, threadId, turnId),
  );
  const requestIds = new Set(requests.map((event) => event.message.id));
  const resolved = events.filter(
    (event) =>
      event.sequence <= throughSequence &&
      event.message.method === "serverRequest/resolved" &&
      event.message.params?.threadId === threadId &&
      requestIds.has(event.message.params?.requestId),
  );
  const [toolApproval, serverForm] = requests;
  const toolResolved =
    toolApproval === undefined
      ? []
      : resolved.filter((event) => event.message.params?.requestId === toolApproval.message.id);
  const formResolved =
    serverForm === undefined
      ? []
      : resolved.filter((event) => event.message.params?.requestId === serverForm.message.id);
  const exact =
    requests.length === 2 &&
    requestIds.size === 2 &&
    toolApproval.message.method === "mcpServer/elicitation/request" &&
    serverForm.message.method === "mcpServer/elicitation/request" &&
    mcpInteractionKind(toolApproval.message.params) === "tool_approval" &&
    mcpInteractionKind(serverForm.message.params) === "server_form" &&
    toolResolved.length === 1 &&
    formResolved.length === 1 &&
    toolApproval.sequence < toolResolved[0].sequence &&
    toolResolved[0].sequence < serverForm.sequence &&
    serverForm.sequence < formResolved[0].sequence;
  return {
    exact,
    requestCount: requests.length,
    resolvedCount: resolved.length,
    pendingCount: requests.filter(
      (request) => !resolved.some((event) => event.message.params?.requestId === request.message.id),
    ).length,
  };
}

async function waitForMcpApprovalBoundary(client, requestId, threadId, turnId, afterSequence, deadlineAt) {
  const resolvedPredicate = resolvedFor(requestId, threadId);
  const formPredicate = mcpFormFor(threadId, turnId);
  const waitDeadlineAt = Math.min(deadlineAt, Date.now() + TURN_TIMEOUT_MS);
  while (remainingMs(waitDeadlineAt) > 0) {
    const boundary = mcpApprovalBoundaryEvent(client.events, resolvedPredicate, formPredicate, afterSequence);
    if (boundary !== undefined) return boundary;
    if (client.processError !== null) throw client.processError;
    if (client.processOwner.hasControllerExited()) throw new Error("app-server exited");
    await boundedSleep(25, waitDeadlineAt, "MCP tool approval boundary wait");
  }
  throw new ProbeDeadlineError("MCP tool approval boundary wait");
}

function validateMcpToolApproval(params) {
  const meta = mcpRequestMeta(params);
  const schema = params?.requestedSchema;
  const properties =
    typeof schema?.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
      ? schema.properties
      : undefined;
  const persist = meta?.persist;
  const persistAdvertisesKnownChoices =
    persist === undefined ||
    persist === "session" ||
    persist === "always" ||
    (Array.isArray(persist) && persist.length === 2 && persist[0] === "session" && persist[1] === "always");
  const toolParams = meta?.tool_params;
  const toolParamsExact = toolParams === undefined || exactJson(toolParams, {});
  const toolExact =
    meta?.tool_name === "collect" || (meta?.tool_name === undefined && meta?.tool_description === MCP_TOOL_DESCRIPTION);
  return {
    ok:
      params?.serverName === "withmate_probe" &&
      params?.mode === "form" &&
      schema?.type === "object" &&
      properties !== undefined &&
      Object.keys(properties).length === 0 &&
      (schema.required === undefined || exactJson(schema.required, [])) &&
      meta?.codex_approval_kind === MCP_TOOL_APPROVAL_KIND &&
      (meta.request_type === undefined || meta.request_type === MCP_TOOL_APPROVAL_REQUEST_TYPE) &&
      toolExact &&
      toolParamsExact &&
      persistAdvertisesKnownChoices,
    reason: "mcp_tool_approval_schema_mismatch",
    diagnostics: {
      serverExact: params?.serverName === "withmate_probe",
      modeExact: params?.mode === "form",
      schemaTypeExact: schema?.type === "object",
      emptySchema: properties !== undefined && Object.keys(properties).length === 0,
      kindExact: meta?.codex_approval_kind === MCP_TOOL_APPROVAL_KIND,
      requestTypeKnown: meta?.request_type === undefined || meta.request_type === MCP_TOOL_APPROVAL_REQUEST_TYPE,
      toolExact,
      toolNameState: meta?.tool_name === "collect" ? "exact" : meta?.tool_name === undefined ? "absent" : "other",
      toolDescriptionExact: meta?.tool_description === MCP_TOOL_DESCRIPTION,
      toolParamsExact,
      persistAdvertisesKnownChoices,
      metaKeyCount: publicObjectKeySummary(meta, MCP_TOOL_APPROVAL_META_KEYS).keyCount,
      unknownMetaKeyCount: publicObjectKeySummary(meta, MCP_TOOL_APPROVAL_META_KEYS).unknownKeyCount,
    },
  };
}

function fileChangePathsFor(client, requestEvent, workspace) {
  const itemId = requestEvent.message.params?.itemId;
  const paths = [];
  for (const event of client.events) {
    if (event.sequence > requestEvent.sequence) continue;
    const message = event.message;
    let changes;
    if (
      message.method === "item/started" &&
      message.params?.item?.id === itemId &&
      message.params?.item?.type === "fileChange"
    ) {
      changes = message.params.item.changes;
    } else if (message.method === "item/fileChange/patchUpdated" && message.params?.itemId === itemId) {
      changes = message.params?.changes;
    }
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (typeof change?.path !== "string") continue;
      paths.push(isAbsolute(change.path) ? resolve(change.path) : resolve(workspace, change.path));
    }
  }
  return paths;
}

function requestsWorkspaceWriteOnly(permissions, workspace) {
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return false;
  if (!Object.keys(permissions).every((key) => key === "fileSystem" || key === "network")) return false;
  const network = permissions.network;
  if (!(network === undefined || network === null || exactJson(network, { enabled: false }))) return false;
  const fileSystem = permissions.fileSystem;
  if (typeof fileSystem !== "object" || fileSystem === null || Array.isArray(fileSystem)) return false;
  if (!Object.keys(fileSystem).every((key) => ["entries", "write", "read", "globScanMaxDepth"].includes(key))) {
    return false;
  }
  if (!(fileSystem.globScanMaxDepth === undefined || fileSystem.globScanMaxDepth === null)) return false;
  const entryPaths = Array.isArray(fileSystem.entries)
    ? fileSystem.entries
        .filter((entry) => entry?.access === "write" && entry?.path?.type === "path")
        .map((entry) => entry.path.path)
    : [];
  const legacyPaths = Array.isArray(fileSystem.write) ? fileSystem.write : [];
  const legacyReadPaths = Array.isArray(fileSystem.read) ? fileSystem.read : [];
  const requestedPaths = [...entryPaths, ...legacyPaths, ...legacyReadPaths];
  const entryCount = Array.isArray(fileSystem.entries) ? fileSystem.entries.length : 0;
  return (
    requestedPaths.length > 0 &&
    entryCount === entryPaths.length &&
    requestedPaths.every((path) => samePath(path, workspace))
  );
}

function permissionDiagnostics(params, workspace) {
  const permissions = params?.permissions;
  const fileSystem =
    typeof permissions?.fileSystem === "object" && permissions.fileSystem !== null ? permissions.fileSystem : undefined;
  const entries = Array.isArray(fileSystem?.entries) ? fileSystem.entries : [];
  const legacyWrite = Array.isArray(fileSystem?.write) ? fileSystem.write : [];
  const legacyRead = Array.isArray(fileSystem?.read) ? fileSystem.read : [];
  const permissionKeySummary = publicObjectKeySummary(permissions, PERMISSION_KEYS);
  const fileSystemKeySummary = publicObjectKeySummary(fileSystem, FILE_SYSTEM_PERMISSION_KEYS);
  return {
    cwdExact: samePath(params?.cwd, workspace),
    permissionKeyCount: permissionKeySummary.keyCount,
    unknownPermissionKeyCount: permissionKeySummary.unknownKeyCount,
    fileSystemKeyCount: fileSystemKeySummary.keyCount,
    unknownFileSystemKeyCount: fileSystemKeySummary.unknownKeyCount,
    entryCount: entries.length,
    entriesAreWorkspaceWrite: entries.every(
      (entry) => entry?.access === "write" && entry?.path?.type === "path" && samePath(entry.path.path, workspace),
    ),
    legacyWriteCount: legacyWrite.length,
    legacyWritesAreWorkspace: legacyWrite.every((path) => samePath(path, workspace)),
    legacyReadCount: legacyRead.length,
    legacyReadsAreWorkspace: legacyRead.every((path) => samePath(path, workspace)),
    networkState:
      permissions?.network === undefined
        ? "absent"
        : permissions.network === null
          ? "null"
          : permissions.network?.enabled === false
            ? "disabled"
            : "other",
  };
}

const EXPECTED_MCP_SCHEMA = {
  type: "object",
  properties: { choice: { type: "string", title: "Choice", maxLength: 32 } },
  required: ["choice"],
};

function validateInteractionRequest(client, workspace, definition, requestEvent) {
  const request = requestEvent.message;
  const params = request.params;
  if (request.id === undefined || typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, reason: "request_shape_mismatch" };
  }
  if (
    (definition.expectedThreadId !== undefined && params.threadId !== definition.expectedThreadId) ||
    (definition.expectedTurnId !== undefined && params.turnId !== definition.expectedTurnId)
  ) {
    return { ok: false, reason: "interaction_owner_mismatch" };
  }
  if (
    (request.method.startsWith("item/") || request.method === "mcpServer/elicitation/request") &&
    definition.expectedThreadId !== undefined &&
    definition.expectedTurnId !== undefined &&
    !requestItemBelongsToOwner(client, requestEvent, definition.expectedThreadId, definition.expectedTurnId)
  ) {
    return { ok: false, reason: "interaction_item_owner_mismatch" };
  }
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const commandExact =
        typeof definition.expectedCommand === "string" && params.command === definition.expectedCommand;
      const commandPathNormalized =
        typeof definition.expectedCommand === "string" &&
        typeof params.command === "string" &&
        params.command.replaceAll("\\", "/") === definition.expectedCommand.replaceAll("\\", "/");
      const normalizedActual = typeof params.command === "string" ? params.command.replaceAll("\\", "/") : "";
      const normalizedExpected =
        typeof definition.expectedCommand === "string" ? definition.expectedCommand.replaceAll("\\", "/") : "";
      const actionCommands = Array.isArray(params.commandActions)
        ? params.commandActions.map((action) => action?.command).filter((command) => typeof command === "string")
        : [];
      const actionCommandPathNormalized = actionCommands.some(
        (command) => command.replaceAll("\\", "/") === normalizedExpected,
      );
      const cwdExact = samePath(params.cwd, workspace);
      const networkAbsent = params.networkApprovalContext === undefined || params.networkApprovalContext === null;
      const execPolicyAbsent =
        params.proposedExecpolicyAmendment === undefined || params.proposedExecpolicyAmendment === null;
      const networkPolicyAbsent =
        params.proposedNetworkPolicyAmendments === undefined || params.proposedNetworkPolicyAmendments === null;
      const execPolicyProposalBounded =
        execPolicyAbsent ||
        (Array.isArray(params.proposedExecpolicyAmendment) &&
          params.proposedExecpolicyAmendment.length <= 16 &&
          params.proposedExecpolicyAmendment.every(
            (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256,
          ));
      const executableMatch =
        /^\s*(?:&\s*)?(?:"(?<doubleQuoted>[^"]+)"|'(?<singleQuoted>[^']+)'|(?<bare>[^\s]+))/u.exec(
          normalizedActual,
        )?.groups;
      const executable = executableMatch?.doubleQuoted ?? executableMatch?.singleQuoted ?? executableMatch?.bare;
      const commandFamily = executable === undefined ? undefined : basename(executable);
      const safeWrappedAction =
        actionCommands.length === 1 &&
        actionCommandPathNormalized &&
        ["pwsh", "pwsh.exe", "powershell", "powershell.exe"].includes(commandFamily?.toLowerCase());
      const markerName = typeof definition.markerPath === "string" ? basename(definition.markerPath) : "";
      return {
        ok:
          (commandExact || commandPathNormalized || safeWrappedAction) &&
          cwdExact &&
          networkAbsent &&
          execPolicyProposalBounded &&
          networkPolicyAbsent,
        reason: "command_target_mismatch",
        diagnostics: {
          commandExact,
          commandPathNormalized,
          actionCommandPathNormalized,
          commandContainsExpected: normalizedExpected.length > 0 && normalizedActual.includes(normalizedExpected),
          expectedContainsCommand: normalizedActual.length > 0 && normalizedExpected.includes(normalizedActual),
          commandFamily:
            commandFamily === undefined
              ? "unknown"
              : ["node", "node.exe", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(
                    commandFamily.toLowerCase(),
                  )
                ? commandFamily.toLowerCase()
                : "other",
          commandActionCount: Array.isArray(params.commandActions) ? params.commandActions.length : 0,
          commandContainsMarkerName: markerName.length > 0 && normalizedActual.includes(markerName),
          actionContainsMarkerName:
            markerName.length > 0 && actionCommands.some((command) => command.includes(markerName)),
          commandUsesNodeWriteFile: normalizedActual.includes("writeFileSync"),
          actionUsesNodeWriteFile: actionCommands.some((command) => command.includes("writeFileSync")),
          cwdExact,
          networkAbsent,
          execPolicyAbsent,
          execPolicyProposalBounded,
          networkPolicyAbsent,
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const paths = fileChangePathsFor(client, requestEvent, workspace);
      return {
        ok:
          typeof definition.markerPath === "string" &&
          paths.length > 0 &&
          paths.every((path) => samePath(path, definition.markerPath)) &&
          (params.grantRoot === undefined || params.grantRoot === null),
        reason: "file_target_mismatch",
      };
    }
    case "item/permissions/requestApproval":
      return {
        ok: samePath(params.cwd, workspace) && requestsWorkspaceWriteOnly(params.permissions, workspace),
        reason: "permission_scope_mismatch",
        diagnostics: permissionDiagnostics(params, workspace),
      };
    case "item/tool/requestUserInput": {
      const question =
        Array.isArray(params.questions) && params.questions.length === 1 ? params.questions[0] : undefined;
      const labels = Array.isArray(question?.options) ? question.options.map((option) => option?.label) : [];
      return {
        ok:
          question?.id === "probe_choice" &&
          question?.header === "Probe" &&
          question?.question === "Choose" &&
          (question?.isSecret === undefined || question.isSecret === false) &&
          question?.isOther === true &&
          exactJson(labels, ["probe-choice", "probe-other"]),
        reason: "user_input_schema_mismatch",
        diagnostics: {
          questionCount: Array.isArray(params.questions) ? params.questions.length : 0,
          idExact: question?.id === "probe_choice",
          headerExact: question?.header === "Probe",
          questionExact: question?.question === "Choose",
          optionCount: labels.length,
          labelsExact: exactJson(labels, ["probe-choice", "probe-other"]),
          secretDisabled: question?.isSecret === undefined || question.isSecret === false,
          otherEnabled: question?.isOther === true,
        },
      };
    }
    case "mcpServer/elicitation/request": {
      const interactionKind = mcpInteractionKind(params);
      if (interactionKind === "tool_approval") return validateMcpToolApproval(params);
      if (interactionKind === "unsupported") {
        return { ok: false, reason: "unsupported_mcp_interaction_discriminator" };
      }
      return {
        ok:
          params.serverName === "withmate_probe" &&
          params.message === "Choose a probe value." &&
          params.mode === "form" &&
          exactJson(params.requestedSchema, EXPECTED_MCP_SCHEMA),
        reason: "mcp_elicitation_schema_mismatch",
        diagnostics: {
          serverExact: params.serverName === "withmate_probe",
          messageExact: params.message === "Choose a probe value.",
          modeExact: params.mode === "form",
          schemaExact: exactJson(params.requestedSchema, EXPECTED_MCP_SCHEMA),
          schemaKeyCount: publicObjectKeySummary(params.requestedSchema, MCP_SCHEMA_KEYS).keyCount,
          unknownSchemaKeyCount: publicObjectKeySummary(params.requestedSchema, MCP_SCHEMA_KEYS).unknownKeyCount,
          propertyKeyCount: publicObjectKeySummary(params.requestedSchema?.properties, MCP_SCHEMA_PROPERTY_KEYS)
            .keyCount,
          unknownPropertyKeyCount: publicObjectKeySummary(params.requestedSchema?.properties, MCP_SCHEMA_PROPERTY_KEYS)
            .unknownKeyCount,
          requiredExact: exactJson(params.requestedSchema?.required, ["choice"]),
        },
      };
    }
    default:
      return { ok: false, reason: "unsupported_interaction" };
  }
}

function fixtureLifecycleComplete(events) {
  const callLifecycle = EXPECTED_MCP_LIFECYCLE.slice(2);
  if (events.length < EXPECTED_MCP_LIFECYCLE.length) return false;
  if (!exactJson(events.slice(-callLifecycle.length), callLifecycle)) return false;
  const connectionLifecycle = events.slice(0, -callLifecycle.length);
  if (connectionLifecycle.length === 0 || connectionLifecycle.length % 2 !== 0) return false;
  for (let index = 0; index < connectionLifecycle.length; index += 2) {
    if (connectionLifecycle[index] !== "initialized" || connectionLifecycle[index + 1] !== "tools_list") {
      return false;
    }
  }
  return true;
}

async function waitForCompleteFixtureLifecycle(auditPath, deadlineAt) {
  const observationDeadline = Math.min(deadlineAt, Date.now() + BOUNDED_WAIT_MS);
  let lifecycle = readMcpFixtureLifecycle(auditPath);
  while (!fixtureLifecycleComplete(lifecycle) && remainingMs(observationDeadline) > 0) {
    await boundedSleep(
      Math.min(25, remainingMs(observationDeadline)),
      observationDeadline,
      "MCP fixture lifecycle observation",
    );
    lifecycle = readMcpFixtureLifecycle(auditPath);
  }
  return lifecycle;
}

function requestTerminalContractSatisfied(observedItems, request, decision, mcpExpected) {
  const itemId = request.params?.itemId;
  if (typeof itemId !== "string") return false;
  if (["item/permissions/requestApproval", "item/tool/requestUserInput"].includes(request.method)) {
    return true;
  }
  const terminal = observedItems.find((item) => item.event === "item/completed" && item.id === itemId);
  if (terminal === undefined) return false;
  if (mcpExpected) return terminal.type === "mcpToolCall" && terminal.status === "completed";
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
    const expectedStatus = ["decline", "cancel"].includes(decision) ? "declined" : "completed";
    return terminal.status === expectedStatus;
  }
  return false;
}

function verifySideEffect(workspace, definition) {
  const markerExists = definition.markerPath !== undefined && existsSync(definition.markerPath);
  const observed = markerExists ? "workspace_only" : "none";
  if (observed !== definition.sideEffect) return { observed, matches: false };
  if (markerExists && definition.markerContent !== undefined) {
    try {
      if (readFileSync(definition.markerPath, "utf8").trim() !== definition.markerContent) {
        return { observed, matches: false };
      }
    } catch {
      return { observed, matches: false };
    }
  }
  if (Array.isArray(definition.expectedWorkspaceFiles)) {
    const actualFiles = readdirSync(workspace).sort();
    if (!exactJson(actualFiles, [...definition.expectedWorkspaceFiles].sort())) {
      return { observed: "unexpected", matches: false };
    }
  }
  return { observed, matches: true };
}

function classifyRoundTrip({
  resolvedObserved,
  terminalStatus,
  sideEffectMatches,
  mcpExpected,
  mcpComplete,
  itemTerminal,
}) {
  const requestLifecycleStatus = resolvedObserved ? "resolved" : "unresolved";
  const roundTripComplete =
    resolvedObserved &&
    terminalStatus === "completed" &&
    sideEffectMatches &&
    itemTerminal &&
    (!mcpExpected || mcpComplete);
  return {
    status: roundTripComplete ? "pass" : "blocked",
    requestLifecycleStatus,
    roundTripStatus: roundTripComplete ? "completed" : "incomplete",
  };
}

function publicObservedItemSummary(observedItems) {
  const groups = new Map();
  for (const item of observedItems) {
    const event = item.event === "item/started" || item.event === "item/completed" ? item.event : "other";
    const type = PUBLIC_ITEM_TYPES.has(item.type) ? item.type : "other";
    const status =
      item.status === null ? "not_reported" : PUBLIC_ITEM_STATUSES.has(item.status) ? item.status : "other";
    const key = JSON.stringify([event, type, status]);
    const current = groups.get(key);
    if (current === undefined) groups.set(key, { event, type, status, count: 1 });
    else current.count += 1;
  }
  return [...groups.values()];
}

function publicValueSummary(values, allowlist, key) {
  const groups = new Map();
  for (const value of values) {
    const publicValue = allowlist.has(value) ? value : "other";
    groups.set(publicValue, (groups.get(publicValue) ?? 0) + 1);
  }
  return [...groups.entries()].map(([value, count]) => ({ [key]: value, count }));
}

function publicTurnStatus(value, missing = "not_observed") {
  if (value === undefined) return missing;
  return PUBLIC_TURN_STATUSES.has(value) ? value : "other";
}

function publicThreadSnapshot(thread, turnId) {
  const turn = Array.isArray(thread?.turns) ? thread.turns.find((candidate) => candidate?.id === turnId) : undefined;
  const threadStatusValue = isPlainObject(thread?.status) ? thread.status.type : thread?.status;
  const activeFlags =
    isPlainObject(thread?.status) && Array.isArray(thread.status.activeFlags) ? thread.status.activeFlags : [];
  const turnStatusValue = turn?.status;
  const itemSummary = publicObservedItemSummary(
    Array.isArray(turn?.items)
      ? turn.items.map((item) => ({ event: "other", type: item?.type ?? "unknown", status: item?.status ?? null }))
      : [],
  );
  return {
    threadStatus:
      threadStatusValue === undefined
        ? "not_observed"
        : PUBLIC_THREAD_STATUS_TYPES.has(threadStatusValue)
          ? threadStatusValue
          : "other",
    activeFlags: publicValueSummary(activeFlags, PUBLIC_THREAD_ACTIVE_FLAGS, "flag"),
    turnStatus: publicTurnStatus(turnStatusValue),
    itemSummary,
  };
}

async function failClosedTurnInteraction(
  client,
  workspace,
  definition,
  threadId,
  turnId,
  requestEvent,
  deadlineAt,
  reason,
  payloadDiagnostics,
) {
  const request = requestEvent.message;
  const canSendDecline = request.id !== undefined && PROTOCOL_DECLINE_METHODS.has(request.method);
  const decision = canSendDecline ? "decline" : "withheld";
  const responseDisposition = canSendDecline ? "sent" : "not_sent";
  const resolvedPromise =
    request.id === undefined
      ? Promise.resolve(undefined)
      : client
          .waitFor(resolvedFor(request.id, threadId), BOUNDED_WAIT_MS, requestEvent.sequence, deadlineAt)
          .catch(() => undefined);
  const terminalPromise = client
    .waitFor(terminalFor(threadId, turnId), BOUNDED_WAIT_MS, requestEvent.sequence, deadlineAt)
    .catch(() => undefined);
  let interruptStatus = "not_needed";

  if (canSendDecline) {
    client.respond(request.id, responseFor(request.method, request.params, "decline", workspace));
  } else {
    interruptStatus = await client
      .request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS, deadlineAt)
      .then(
        () => "accepted",
        () => "not_confirmed",
      );
  }

  let [resolvedEvent, initiallyObservedTerminal] = await Promise.all([resolvedPromise, terminalPromise]);
  let terminalEvent = initiallyObservedTerminal;
  if (canSendDecline && terminalEvent === undefined) {
    interruptStatus = await client
      .request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS, deadlineAt)
      .then(
        () => "accepted",
        () => "not_confirmed",
      );
  }
  if (terminalEvent === undefined) {
    terminalEvent = await waitTerminalQuietly(client, threadId, turnId, requestEvent.sequence, deadlineAt);
  }
  if (resolvedEvent === undefined && request.id !== undefined) {
    resolvedEvent = await client
      .waitFor(resolvedFor(request.id, threadId), BOUNDED_WAIT_MS, requestEvent.sequence, deadlineAt)
      .catch(() => undefined);
  }

  const lifecycleEntries = [
    ...(resolvedEvent === undefined ? [] : [{ label: "resolved", sequence: resolvedEvent.sequence }]),
    ...(initiallyObservedTerminal === undefined
      ? []
      : [{ label: "terminal", sequence: initiallyObservedTerminal.sequence }]),
  ]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.label);
  const order = ["request"];
  if (canSendDecline) order.push("decline_sent", ...lifecycleEntries);
  else order.push("interrupt", ...lifecycleEntries);
  if (interruptStatus !== "not_needed" && canSendDecline) order.push("interrupt");
  if (initiallyObservedTerminal === undefined && terminalEvent !== undefined) order.push("terminal");

  const sideEffect = verifySideEffect(workspace, definition).observed;
  return {
    ...blocked(definition.name, definition.expectedMethod, reason, request.method),
    decision,
    responseDisposition,
    order,
    requestLifecycleStatus:
      resolvedEvent !== undefined ? "resolved" : canSendDecline ? "unresolved_after_decline" : "pending_at_interrupt",
    roundTripStatus: terminalEvent === undefined ? "incomplete" : "terminal_observed",
    terminalStatus: publicTurnStatus(terminalEvent?.message?.params?.turn?.status),
    pendingCount: resolvedEvent === undefined ? 1 : 0,
    sideEffect,
    payloadValidation: "mismatch",
    ...(interruptStatus === "not_needed" ? {} : { interruptStatus }),
    ...(payloadDiagnostics === undefined ? {} : { payloadDiagnostics }),
    ...(definition.mcpAuditPath === undefined
      ? {}
      : { mcpFixtureLifecycle: readMcpFixtureLifecycle(definition.mcpAuditPath) }),
  };
}

async function runMcpTurnCase(client, workspace, definition, threadId, turnId, firstRequestEvent, deadlineAt) {
  const orderEntries = [];
  let requestEvent = firstRequestEvent;
  let formResponseSequence;
  let toolApprovalObserved = false;

  for (let interactionIndex = 0; interactionIndex < 2; interactionIndex += 1) {
    const request = requestEvent.message;
    if (request.method !== "mcpServer/elicitation/request") {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        "different_interaction_observed",
      );
    }
    const classifiedKind = mcpInteractionKind(request.params);
    const interactionKind = classifiedKind === "server_form" ? "form" : classifiedKind;
    const expectedKind = interactionIndex === 0 ? "tool_approval" : "form";
    if (!mcpStageMatches(interactionIndex, request.params)) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        `expected_${expectedKind}_observed_${interactionKind}`,
      );
    }
    const payloadValidation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadId, expectedTurnId: turnId },
      requestEvent,
    );
    if (!payloadValidation.ok) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        payloadValidation.reason,
        payloadValidation.diagnostics,
      );
    }

    orderEntries.push({ label: `${interactionKind}_request`, sequence: requestEvent.sequence });
    const responseSequence = client.respond(
      request.id,
      responseFor(request.method, request.params, "accept", workspace),
    );
    orderEntries.push({ label: `${interactionKind}_response_sent`, sequence: responseSequence });
    let resolvedEvent;
    if (interactionIndex === 0) {
      const boundary = await waitForMcpApprovalBoundary(
        client,
        request.id,
        threadId,
        turnId,
        requestEvent.sequence,
        deadlineAt,
      ).catch(() => undefined);
      if (boundary?.kind === "premature_form") {
        const prematureFormEvent = boundary.event;
        const prematureRequest = prematureFormEvent.message;
        orderEntries.push({
          label: "form_request_before_tool_approval_resolved",
          sequence: prematureFormEvent.sequence,
        });
        const declineSequence = client.respond(
          prematureRequest.id,
          responseFor(prematureRequest.method, prematureRequest.params, "decline", workspace),
        );
        orderEntries.push({ label: "form_decline_sent", sequence: declineSequence });
        await interruptQuietly(client, threadId, turnId, deadlineAt);
        return {
          ...blocked(definition.name, definition.expectedMethod, "mcp_form_before_tool_approval_resolved"),
          decision: "decline",
          order: orderEntries.sort((left, right) => left.sequence - right.sequence).map((entry) => entry.label),
          requestLifecycleStatus: "unresolved",
          roundTripStatus: "incomplete",
          pendingCount: 2,
          payloadValidation: "matched",
          persistentGrant: "not_applied",
          mcpFixtureLifecycle: readMcpFixtureLifecycle(definition.mcpAuditPath),
        };
      }
      resolvedEvent = boundary?.event;
    } else {
      resolvedEvent = await client
        .waitFor(resolvedFor(request.id, threadId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
        .catch(() => undefined);
    }
    if (resolvedEvent !== undefined) {
      orderEntries.push({ label: `${interactionKind}_resolved`, sequence: resolvedEvent.sequence });
    }
    if (resolvedEvent === undefined) {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
      return {
        ...blocked(definition.name, definition.expectedMethod, "resolved_not_observed"),
        decision: "accept",
        order: orderEntries.sort((left, right) => left.sequence - right.sequence).map((entry) => entry.label),
        requestLifecycleStatus: "unresolved",
        pendingCount: 1,
        payloadValidation: "matched",
        persistentGrant: "not_applied",
        mcpFixtureLifecycle: readMcpFixtureLifecycle(definition.mcpAuditPath),
      };
    }

    if (interactionKind === "form") {
      formResponseSequence = responseSequence;
      break;
    }
    toolApprovalObserved = true;
    requestEvent = await client
      .waitFor(mcpFormFor(threadId, turnId), INTERACTION_TIMEOUT_MS, resolvedEvent.sequence, deadlineAt)
      .catch(() => undefined);
    if (requestEvent === undefined) {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
      return {
        ...blocked(definition.name, definition.expectedMethod, "mcp_form_not_observed_after_tool_approval"),
        decision: "accept",
        order: orderEntries.sort((left, right) => left.sequence - right.sequence).map((entry) => entry.label),
        requestLifecycleStatus: "resolved",
        roundTripStatus: "incomplete",
        payloadValidation: "matched",
        persistentGrant: "not_applied",
        mcpFixtureLifecycle: readMcpFixtureLifecycle(definition.mcpAuditPath),
      };
    }
  }

  if (formResponseSequence === undefined) {
    await interruptQuietly(client, threadId, turnId, deadlineAt);
    return blocked(definition.name, definition.expectedMethod, "mcp_form_not_observed");
  }

  const terminalEvent = await client
    .waitFor(
      terminalFor(threadId, turnId),
      definition.terminalObservationMs ?? TURN_TIMEOUT_MS,
      formResponseSequence,
      deadlineAt,
    )
    .catch(() => undefined);
  if (terminalEvent !== undefined) {
    orderEntries.push({ label: "terminal", sequence: terminalEvent.sequence });
  }
  const observedItems = client.events
    .filter(
      (event) =>
        ["item/started", "item/completed"].includes(event.message.method) &&
        event.message.params?.threadId === threadId &&
        event.message.params?.turnId === turnId,
    )
    .map((event) => ({
      event: event.message.method,
      id: event.message.params?.item?.id ?? "unknown",
      type: event.message.params?.item?.type ?? "unknown",
      status: event.message.params?.item?.status ?? null,
    }));
  const mcpFixtureLifecycle = readMcpFixtureLifecycle(definition.mcpAuditPath);
  const mcpComplete = fixtureLifecycleComplete(mcpFixtureLifecycle);
  const itemTerminal = observedItems.some(
    (item) => item.event === "item/completed" && item.type === "mcpToolCall" && item.status === "completed",
  );
  const sideEffectVerification = verifySideEffect(workspace, definition);
  const mcpRequestLifecycle = auditMcpRequestLifecycle(client.events, threadId, turnId, terminalEvent?.sequence);
  const allRequestsResolved = mcpRequestLifecycle.exact;
  const classification = classifyRoundTrip({
    resolvedObserved: allRequestsResolved,
    terminalStatus: terminalEvent?.message?.params?.turn?.status,
    sideEffectMatches: sideEffectVerification.matches,
    mcpExpected: true,
    mcpComplete,
    itemTerminal: itemTerminal && toolApprovalObserved,
  });
  return {
    case: definition.name,
    status: classification.status,
    method: definition.expectedMethod,
    decision: "accept",
    interactionKinds: [...(toolApprovalObserved ? ["mcp_tool_approval"] : []), "mcp_server_form"],
    order: orderEntries.sort((left, right) => left.sequence - right.sequence).map((entry) => entry.label),
    requestLifecycleStatus: classification.requestLifecycleStatus,
    roundTripStatus: classification.roundTripStatus,
    terminalContract: "required_for_round_trip",
    terminalStatus: publicTurnStatus(terminalEvent?.message?.params?.turn?.status),
    pendingCount: mcpRequestLifecycle.pendingCount,
    requestAudit: mcpRequestLifecycle,
    sideEffect: sideEffectVerification.observed,
    observedItems: publicObservedItemSummary(observedItems),
    payloadValidation: "matched",
    persistentGrant: "not_applied",
    appServerDiagnostics: client.diagnosticFlags(),
    mcpFixtureLifecycle,
    duplicate: "not_tested",
    reason: !allRequestsResolved
      ? "mcp_request_lifecycle_mismatch"
      : terminalEvent === undefined
        ? "terminal_not_observed"
        : terminalEvent.message.params?.turn?.status !== "completed"
          ? "terminal_not_completed"
          : !sideEffectVerification.matches
            ? "side_effect_mismatch"
            : !mcpComplete
              ? "mcp_fixture_round_trip_incomplete"
              : !itemTerminal
                ? "mcp_item_terminal_not_observed"
                : "observed",
  };
}

async function runCase(client, workspace, definition, deadlineAt) {
  let threadId;
  let turnId;
  try {
    boundedTimeout(deadlineAt, 1, "case start");
    const threadResponse = await client.request(
      "thread/start",
      startThreadParams(workspace, definition.approvalPolicy, definition.threadSandbox),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadId = threadResponse.result?.thread?.id;
    if (typeof threadId !== "string") {
      return blocked(definition.name, definition.expectedMethod, "thread_start_invalid");
    }
    let prewarmStatus;
    if (definition.prewarm === true) {
      const prewarmFromSequence = client.nextSequence;
      const prewarmResponse = await client.request(
        "turn/start",
        turnParams(
          threadId,
          definition.approvalPolicy,
          definition.turnSandbox,
          "Reply with ready without using any tool.",
        ),
        REQUEST_TIMEOUT_MS,
        deadlineAt,
      );
      const prewarmTurnId = prewarmResponse.result?.turn?.id;
      if (typeof prewarmTurnId !== "string") {
        return blocked(definition.name, definition.expectedMethod, "prewarm_turn_start_invalid");
      }
      const prewarmTerminal = await client
        .waitFor(terminalFor(threadId, prewarmTurnId), TURN_TIMEOUT_MS, prewarmFromSequence, deadlineAt)
        .catch(() => undefined);
      prewarmStatus = prewarmTerminal?.message?.params?.turn?.status ?? "not_observed";
      if (prewarmStatus !== "completed") {
        await interruptQuietly(client, threadId, prewarmTurnId, deadlineAt);
        return {
          ...blocked(definition.name, definition.expectedMethod, "prewarm_terminal_not_completed"),
          prewarmStatus: publicTurnStatus(prewarmStatus),
        };
      }
    }
    boundedTimeout(deadlineAt, 1, "turn start");
    const fromSequence = client.nextSequence;
    const turnResponse = await client.request(
      "turn/start",
      turnParams(threadId, definition.approvalPolicy, definition.turnSandbox, definition.prompt),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnId = turnResponse.result?.turn?.id;
    if (typeof turnId !== "string") return blocked(definition.name, definition.expectedMethod, "turn_start_invalid");

    const requestEvent = await client
      .waitFor(interactionFor(threadId, turnId), INTERACTION_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    if (requestEvent === undefined) {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
      return blocked(definition.name, definition.expectedMethod, "request_not_observed");
    }
    if (definition.expectedMethod === "mcpServer/elicitation/request") {
      return runMcpTurnCase(client, workspace, definition, threadId, turnId, requestEvent, deadlineAt);
    }
    const request = requestEvent.message;
    if (request.method !== definition.expectedMethod) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        "different_interaction_observed",
      );
    }
    const payloadValidation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadId, expectedTurnId: turnId },
      requestEvent,
    );
    if (!payloadValidation.ok) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        payloadValidation.reason,
        payloadValidation.diagnostics,
      );
    }

    if (definition.withhold === true) {
      await boundedSleep(BOUNDED_WAIT_MS, deadlineAt, "bounded interaction wait");
      await interruptQuietly(client, threadId, turnId, deadlineAt);
      const sideEffect =
        definition.markerPath !== undefined && existsSync(definition.markerPath) ? "unexpected" : "none";
      return {
        case: definition.name,
        status: sideEffect === "none" ? "pass" : "blocked",
        method: request.method,
        decision: "withheld",
        order: ["request", "client_deadline", "interrupt"],
        requestLifecycleStatus: "pending_at_interrupt",
        roundTripStatus: "not_applicable",
        terminalStatus: "not_required",
        pendingCount: 1,
        sideEffect,
        payloadValidation: "matched",
        duplicate: "not_tested",
        reason: sideEffect === "none" ? "client_side_deadline_only" : "unexpected_side_effect",
      };
    }

    const response = responseFor(
      request.method,
      request.params,
      definition.decision,
      workspace,
      definition.userInputAnswer,
    );
    const responseSequence = client.respond(request.id, response);
    if (definition.duplicate === true) client.respond(request.id, response);
    const [resolvedEvent, terminalEvent] = await Promise.all([
      client
        .waitFor(resolvedFor(request.id, threadId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
        .catch(() => undefined),
      client
        .waitFor(
          terminalFor(threadId, turnId),
          definition.terminalObservationMs ?? TURN_TIMEOUT_MS,
          requestEvent.sequence,
          deadlineAt,
        )
        .catch(() => undefined),
    ]);
    const order = [
      { label: "request", sequence: requestEvent.sequence },
      { label: "response_sent", sequence: responseSequence },
      ...(resolvedEvent === undefined ? [] : [{ label: "resolved", sequence: resolvedEvent.sequence }]),
      ...(terminalEvent === undefined ? [] : [{ label: "terminal", sequence: terminalEvent.sequence }]),
    ]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.label);
    const sideEffectVerification = verifySideEffect(workspace, definition);
    const observedSideEffect = sideEffectVerification.observed;
    const sideEffectMatches = sideEffectVerification.matches;
    const postResponseEvents = client.events
      .filter(
        (event) =>
          event.sequence > responseSequence &&
          ["serverRequest/resolved", "item/completed", "turn/completed", "error"].includes(event.message.method),
      )
      .map((event) => event.message.method);
    const observedItems = client.events
      .filter(
        (event) =>
          ["item/started", "item/completed"].includes(event.message.method) &&
          event.message.params?.threadId === threadId &&
          event.message.params?.turnId === turnId,
      )
      .map((event) => ({
        event: event.message.method,
        id: event.message.params?.item?.id ?? "unknown",
        type: event.message.params?.item?.type ?? "unknown",
        status: event.message.params?.item?.status ?? null,
      }));
    const mcpFixtureLifecycle = readMcpFixtureLifecycle(definition.mcpAuditPath);
    const mcpExpected = definition.mcpAuditPath !== undefined;
    const mcpComplete = !mcpExpected || fixtureLifecycleComplete(mcpFixtureLifecycle);
    const itemTerminal = requestTerminalContractSatisfied(observedItems, request, definition.decision, mcpExpected);
    const classification = classifyRoundTrip({
      resolvedObserved: resolvedEvent !== undefined,
      terminalStatus: terminalEvent?.message?.params?.turn?.status,
      sideEffectMatches,
      mcpExpected,
      mcpComplete,
      itemTerminal,
    });
    let threadSnapshot;
    if (terminalEvent === undefined && definition.inspectThreadOnMissingTerminal === true) {
      const readResponse = await client
        .request("thread/read", { threadId, includeTurns: true }, REQUEST_TIMEOUT_MS, deadlineAt)
        .catch(() => undefined);
      const thread = readResponse?.result?.thread;
      threadSnapshot = publicThreadSnapshot(thread, turnId);
    }
    return {
      case: definition.name,
      status: classification.status,
      method: request.method,
      decision: definition.decision,
      order,
      requestLifecycleStatus: classification.requestLifecycleStatus,
      roundTripStatus: classification.roundTripStatus,
      terminalContract: "required_for_round_trip",
      terminalStatus: publicTurnStatus(terminalEvent?.message?.params?.turn?.status),
      pendingCount: resolvedEvent === undefined ? 1 : 0,
      sideEffect: observedSideEffect,
      postResponseEvents,
      observedItems: publicObservedItemSummary(observedItems),
      payloadValidation: "matched",
      ...(request.method === "item/tool/requestUserInput"
        ? {
            userInputAnswerKind: request.params.questions.some((question) =>
              question.options?.some((option) => option.label === (definition.userInputAnswer ?? "probe-choice")),
            )
              ? "option"
              : "other",
          }
        : {}),
      ...(request.method === "item/commandExecution/requestApproval" ? { persistentGrant: "not_applied" } : {}),
      appServerDiagnostics: client.diagnosticFlags(),
      ...(definition.mcpAuditPath === undefined ? {} : { mcpFixtureLifecycle }),
      ...(prewarmStatus === undefined ? {} : { prewarmStatus: publicTurnStatus(prewarmStatus) }),
      ...(threadSnapshot === undefined ? {} : { threadSnapshot }),
      duplicate: definition.duplicate === true ? "sent_for_observation" : "not_tested",
      reason:
        resolvedEvent === undefined
          ? "resolved_not_observed"
          : terminalEvent === undefined
            ? "terminal_not_observed"
            : terminalEvent.message?.params?.turn?.status !== "completed"
              ? "terminal_not_completed"
              : !sideEffectMatches
                ? "side_effect_mismatch"
                : !itemTerminal
                  ? "request_terminal_contract_incomplete"
                  : !mcpComplete
                    ? "mcp_fixture_round_trip_incomplete"
                    : "observed",
    };
  } catch (error) {
    if (typeof threadId === "string" && typeof turnId === "string") {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
    }
    return {
      ...blocked(
        definition.name,
        definition.expectedMethod,
        error instanceof ProbeDeadlineError ? "probe_deadline" : "case_failure",
      ),
      errorKind: error instanceof ProbeDeadlineError ? "deadline" : "runtime",
      ...(error instanceof RpcRequestError
        ? { errorDiagnostic: { type: "rpc_rejection", method: error.method, code: error.code } }
        : {}),
    };
  }
}

async function runDirectMcpCase(client, workspace, mcpAuditPath, deadlineAt) {
  const approvalPolicy = granularApprovalPolicy({ mcp_elicitations: true });
  const threadResponse = await client.request(
    "thread/start",
    startThreadParams(workspace, approvalPolicy, "read-only"),
    REQUEST_TIMEOUT_MS,
    deadlineAt,
  );
  const threadId = threadResponse.result?.thread?.id;
  if (typeof threadId !== "string") {
    return blocked("mcp_direct_call", "mcpServer/elicitation/request", "thread_start_invalid");
  }
  const fromSequence = client.nextSequence;
  const callPromise = client
    .request(
      "mcpServer/tool/call",
      { threadId, server: "withmate_probe", tool: "collect", arguments: {} },
      TURN_TIMEOUT_MS,
      deadlineAt,
    )
    .catch(() => undefined);
  const requestEvent = await client
    .waitFor(
      (message) => message.method === "mcpServer/elicitation/request" && message.params?.threadId === threadId,
      INTERACTION_TIMEOUT_MS,
      fromSequence,
      deadlineAt,
    )
    .catch(() => undefined);
  if (requestEvent === undefined) {
    await callPromise;
    return blocked("mcp_direct_call", "mcpServer/elicitation/request", "request_not_observed");
  }
  const payloadValidation = validateInteractionRequest(
    client,
    workspace,
    { expectedMethod: "mcpServer/elicitation/request" },
    requestEvent,
  );
  if (!payloadValidation.ok) {
    if (requestEvent.message.id === undefined) {
      return {
        ...blocked("mcp_direct_call", "mcpServer/elicitation/request", payloadValidation.reason),
        decision: "withheld",
        responseDisposition: "not_sent",
        order: ["request"],
        requestLifecycleStatus: "observed_unrespondable",
        roundTripStatus: "incomplete",
        pendingCount: 1,
        sideEffect: "none",
        payloadValidation: "mismatch",
        payloadDiagnostics: payloadValidation.diagnostics,
        directToolCallResponse: "pending",
        mcpFixtureLifecycle: readMcpFixtureLifecycle(mcpAuditPath),
      };
    }
    const responseSequence = client.respond(
      requestEvent.message.id,
      responseFor(requestEvent.message.method, requestEvent.message.params, "decline", workspace),
    );
    const [resolvedEvent, callResponse] = await Promise.all([
      client
        .waitFor(resolvedFor(requestEvent.message.id, threadId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
        .catch(() => undefined),
      callPromise,
    ]);
    return {
      ...blocked("mcp_direct_call", "mcpServer/elicitation/request", payloadValidation.reason),
      decision: "decline",
      responseDisposition: "sent",
      order: [
        { label: "request", sequence: requestEvent.sequence },
        { label: "decline_sent", sequence: responseSequence },
        ...(resolvedEvent === undefined ? [] : [{ label: "resolved", sequence: resolvedEvent.sequence }]),
      ]
        .sort((left, right) => left.sequence - right.sequence)
        .map((entry) => entry.label),
      requestLifecycleStatus: resolvedEvent === undefined ? "unresolved_after_decline" : "resolved",
      roundTripStatus: "incomplete",
      pendingCount: resolvedEvent === undefined ? 1 : 0,
      sideEffect: "none",
      payloadValidation: "mismatch",
      payloadDiagnostics: payloadValidation.diagnostics,
      directToolCallResponse: callResponse === undefined ? "not_observed" : "observed",
      mcpFixtureLifecycle: readMcpFixtureLifecycle(mcpAuditPath),
    };
  }
  const responseSequence = client.respond(
    requestEvent.message.id,
    responseFor(requestEvent.message.method, requestEvent.message.params, "accept", workspace),
  );
  const [resolvedEvent, callResponse] = await Promise.all([
    client
      .waitFor(resolvedFor(requestEvent.message.id, threadId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
      .catch(() => undefined),
    callPromise,
  ]);
  const mcpFixtureLifecycle =
    callResponse === undefined
      ? readMcpFixtureLifecycle(mcpAuditPath)
      : await waitForCompleteFixtureLifecycle(mcpAuditPath, deadlineAt);
  const directComplete =
    resolvedEvent !== undefined && callResponse !== undefined && fixtureLifecycleComplete(mcpFixtureLifecycle);
  return {
    case: "mcp_direct_call",
    status: directComplete ? "pass" : "blocked",
    method: requestEvent.message.method,
    decision: "accept",
    order: [
      { label: "request", sequence: requestEvent.sequence },
      { label: "response_sent", sequence: responseSequence },
      ...(resolvedEvent === undefined ? [] : [{ label: "resolved", sequence: resolvedEvent.sequence }]),
    ]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.label),
    directToolCallResponse: callResponse === undefined ? "not_observed" : "observed",
    requestLifecycleStatus: resolvedEvent === undefined ? "unresolved" : "resolved",
    roundTripStatus: directComplete ? "completed" : "incomplete",
    payloadValidation: "matched",
    mcpFixtureLifecycle,
    pendingCount: resolvedEvent === undefined ? 1 : 0,
    sideEffect: "none",
    reason:
      resolvedEvent === undefined
        ? "resolved_not_observed"
        : callResponse === undefined
          ? "tool_call_response_not_observed"
          : !fixtureLifecycleComplete(mcpFixtureLifecycle)
            ? "mcp_fixture_round_trip_incomplete"
            : "observed",
  };
}

async function interruptQuietly(client, threadId, turnId, deadlineAt) {
  await client.request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS, deadlineAt).catch(() => undefined);
  await waitTerminalQuietly(client, threadId, turnId, 0, deadlineAt);
}

async function waitTerminalQuietly(client, threadId, turnId, afterSequence, deadlineAt) {
  return client
    .waitFor(terminalFor(threadId, turnId), BOUNDED_WAIT_MS, afterSequence, deadlineAt)
    .catch(() => undefined);
}

function blocked(caseName, method, reason, observedMethod) {
  return {
    case: caseName,
    status: "blocked",
    method,
    decision: "not_sent",
    order: [],
    requestLifecycleStatus: "not_observed",
    roundTripStatus: "not_started",
    terminalStatus: "not_observed",
    pendingCount: 0,
    sideEffect: "none",
    duplicate: "not_tested",
    reason,
    ...(observedMethod === undefined ? {} : { observedMethod }),
  };
}

function cases(workspace, mcpAuditPath) {
  const commandMarker = join(workspace, "command-marker.txt");
  const fileMarker = join(workspace, "file-marker.txt");
  const waitMarker = join(workspace, "wait-marker.txt");
  const commandPromptPath = commandMarker.replaceAll("\\", "/");
  const filePromptPath = fileMarker.replaceAll("\\", "/");
  const waitPromptPath = waitMarker.replaceAll("\\", "/");
  const command = `node -e "require('node:fs').writeFileSync('${commandPromptPath}','ok')"`;
  const waitCommand = `node -e "require('node:fs').writeFileSync('${waitPromptPath}','wait')"`;
  return [
    {
      name: "command_decline",
      expectedMethod: "item/commandExecution/requestApproval",
      decision: "decline",
      approvalPolicy: "untrusted",
      threadSandbox: "workspace-write",
      turnSandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
      prompt: `Use the shell exactly once to run this exact command: ${command}. Do not use any other tool.`,
      expectedCommand: command,
      sideEffect: "none",
      markerPath: commandMarker,
      markerContent: "ok",
      expectedWorkspaceFiles: [".keep"],
    },
    {
      name: "command_accept",
      expectedMethod: "item/commandExecution/requestApproval",
      decision: "accept",
      approvalPolicy: "untrusted",
      threadSandbox: "workspace-write",
      turnSandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
      prompt: `Use the shell exactly once to run this exact command: ${command}. Do not use any other tool.`,
      expectedCommand: command,
      sideEffect: "workspace_only",
      markerPath: commandMarker,
      markerContent: "ok",
      expectedWorkspaceFiles: [".keep", "command-marker.txt"],
    },
    {
      name: "file_decline",
      expectedMethod: "item/fileChange/requestApproval",
      decision: "decline",
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt: `Use the file patch tool exactly once to create ${filePromptPath} with the text ok. Do not use shell or network.`,
      sideEffect: "none",
      markerPath: fileMarker,
      expectedWorkspaceFiles: [".keep", "command-marker.txt"],
    },
    {
      name: "file_accept",
      expectedMethod: "item/fileChange/requestApproval",
      decision: "accept",
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt: `Use the file patch tool exactly once to create ${filePromptPath} with the text ok. Do not use shell or network.`,
      sideEffect: "workspace_only",
      markerPath: fileMarker,
      markerContent: "ok",
      expectedWorkspaceFiles: [".keep", "command-marker.txt", "file-marker.txt"],
    },
    {
      name: "permission_turn_scope",
      expectedMethod: "item/permissions/requestApproval",
      decision: "accept",
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt:
        "Request write permission only for the current workspace and current turn. Do not execute a command or use network.",
      sideEffect: "none",
    },
    {
      name: "mcp_form_accept",
      expectedMethod: "mcpServer/elicitation/request",
      decision: "accept",
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt: "Call the withmate_probe collect tool exactly once. Do not use any other tool or network.",
      sideEffect: "none",
      terminalObservationMs: TERMINAL_OBSERVATION_MS,
      inspectThreadOnMissingTerminal: true,
      mcpAuditPath,
    },
    {
      name: "bounded_wait",
      expectedMethod: "item/commandExecution/requestApproval",
      withhold: true,
      approvalPolicy: "untrusted",
      threadSandbox: "workspace-write",
      turnSandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
      prompt: `Use the shell exactly once to run this exact command: ${waitCommand}. Do not use any other tool.`,
      expectedCommand: waitCommand,
      sideEffect: "none",
      markerPath: waitMarker,
    },
    {
      name: "user_input_duplicate",
      expectedMethod: "item/tool/requestUserInput",
      decision: "accept",
      duplicate: true,
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt:
        "Before answering, call request_user_input once with id probe_choice, header Probe, question Choose, and exactly two options labelled probe-choice and probe-other. Do not enable secret input. Use the answer and do not use other tools.",
      sideEffect: "none",
    },
  ];
}

function followUpCases(workspace, mcpAuditPath) {
  return [
    {
      name: "permission_turn_scope_flagged",
      expectedMethod: "item/permissions/requestApproval",
      decision: "accept",
      approvalPolicy: granularApprovalPolicy({ request_permissions: true }),
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt:
        "Call request_permissions once to request write access only to the current workspace. Do not execute a command or use network.",
      sideEffect: "none",
    },
    {
      name: "user_input_duplicate_flagged",
      expectedMethod: "item/tool/requestUserInput",
      decision: "accept",
      duplicate: true,
      approvalPolicy: "on-request",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt:
        "Before answering, call request_user_input once with id probe_choice, header Probe, question Choose, and exactly two options labelled probe-choice and probe-other. Do not enable secret input. Use the answer and do not use other tools.",
      sideEffect: "none",
    },
    {
      name: "mcp_form_accept_granular",
      expectedMethod: "mcpServer/elicitation/request",
      decision: "accept",
      approvalPolicy: granularApprovalPolicy({ mcp_elicitations: true }),
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly" },
      prompt: "Call the withmate_probe collect tool exactly once. Do not use any other tool or network.",
      sideEffect: "none",
      terminalObservationMs: TERMINAL_OBSERVATION_MS,
      inspectThreadOnMissingTerminal: true,
      mcpAuditPath,
    },
  ];
}

function advancedCommandDefinition(workspace, caseName) {
  const fileName = `${caseName}.txt`;
  const markerPath = join(workspace, fileName);
  const promptPath = markerPath.replaceAll("\\", "/");
  const command = `node -e "require('node:fs').writeFileSync('${promptPath}','ok')"`;
  return {
    name: caseName,
    expectedMethod: "item/commandExecution/requestApproval",
    decision: "accept",
    approvalPolicy: "untrusted",
    threadSandbox: "workspace-write",
    turnSandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
    prompt: `Use the shell exactly once to run this exact command: ${command}. Do not use any other tool.`,
    expectedCommand: command,
    markerPath,
    markerContent: "ok",
  };
}

function observedMarkerEffect(markerPath) {
  if (!existsSync(markerPath)) return "none";
  try {
    return readFileSync(markerPath, "utf8") === "ok" ? "workspace_only" : "unexpected";
  } catch {
    return "unexpected";
  }
}

function ownerEventCounts(client, threadId, turnId, afterSequence = 0) {
  const events = client.events.filter((event) => event.sequence > afterSequence);
  return {
    interactions: events.filter((event) => interactionBelongsToOwner(event.message, threadId, turnId)).length,
    resolved: events.filter(
      (event) => event.message.method === "serverRequest/resolved" && event.message.params?.threadId === threadId,
    ).length,
    terminals: events.filter((event) => terminalFor(threadId, turnId)(event.message)).length,
  };
}

function multiRunInteractionAudit(events, owners, afterSequence = 0) {
  const exactCounts = owners.map(() => 0);
  let unexpectedCount = 0;
  for (const event of events) {
    if (event.sequence <= afterSequence || !TARGET_METHODS.has(event.message.method)) continue;
    const params = event.message.params;
    const ownerIndex = owners.findIndex(
      (owner) =>
        typeof owner.itemId === "string" &&
        params?.threadId === owner.threadId &&
        params?.turnId === owner.turnId &&
        params?.itemId === owner.itemId,
    );
    if (ownerIndex === -1) unexpectedCount += 1;
    else exactCounts[ownerIndex] += 1;
  }
  return { exactCounts, unexpectedCount };
}

function itemTerminalCount(client, threadId, turnId, itemId, expectedStatus, afterSequence = 0) {
  return client.events.filter(
    (event) =>
      event.sequence > afterSequence &&
      event.message.method === "item/completed" &&
      event.message.params?.threadId === threadId &&
      event.message.params?.turnId === turnId &&
      event.message.params?.item?.id === itemId &&
      event.message.params?.item?.status === expectedStatus,
  ).length;
}

function resolvedRequestCounts(client, requestId, threadId, afterSequence = 0) {
  const matchingRequest = client.events.filter(
    (event) =>
      event.sequence > afterSequence &&
      event.message.method === "serverRequest/resolved" &&
      event.message.params?.requestId === requestId,
  );
  return {
    exact: matchingRequest.filter((event) => event.message.params?.threadId === threadId).length,
    wrongOwner: matchingRequest.filter((event) => event.message.params?.threadId !== threadId).length,
  };
}

function parallelNoToolObservationPassed(
  rawTerminalStatuses,
  terminalCounts,
  crossOwnerEvent,
  interactionAudit,
  concurrencyEvidence,
) {
  return (
    rawTerminalStatuses.length > 0 &&
    rawTerminalStatuses.every((status) => status === "completed") &&
    terminalCounts.length === rawTerminalStatuses.length &&
    terminalCounts.every((count) => count === 1) &&
    !crossOwnerEvent &&
    interactionAudit.unexpectedCount === 0 &&
    concurrencyEvidence.invalidCount === 0 &&
    concurrencyEvidence.startCounts.every((count) => count === 1) &&
    concurrencyEvidence.completionCounts.every((count) => count === 1) &&
    concurrencyEvidence.finalActive === 0 &&
    concurrencyEvidence.maximumActive === rawTerminalStatuses.length
  );
}

async function runDuplicateAfterResolvedCase(client, workspace, caseName, deadlineAt) {
  const definition = { ...advancedCommandDefinition(workspace, caseName), decision: "decline" };
  const fromSequence = client.nextSequence;
  let threadId;
  let turnId;
  let terminalObserved = false;
  try {
    const thread = await client.request(
      "thread/start",
      startThreadParams(workspace, definition.approvalPolicy, definition.threadSandbox),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadId = thread.result?.thread?.id;
    if (typeof threadId !== "string") return blocked(caseName, definition.expectedMethod, "thread_start_invalid");
    const turn = await client.request(
      "turn/start",
      turnParams(threadId, definition.approvalPolicy, definition.turnSandbox, definition.prompt),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnId = turn.result?.turn?.id;
    if (typeof turnId !== "string") return blocked(caseName, definition.expectedMethod, "turn_start_invalid");
    const requestEvent = await client
      .waitFor(interactionFor(threadId, turnId), INTERACTION_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    if (requestEvent === undefined) return blocked(caseName, definition.expectedMethod, "request_not_observed");
    if (requestEvent.message.method !== definition.expectedMethod) {
      const result = await failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        "different_interaction_observed",
      );
      terminalObserved = result.roundTripStatus === "terminal_observed";
      return result;
    }
    const validation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadId, expectedTurnId: turnId },
      requestEvent,
    );
    if (!validation.ok) {
      const result = await failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        validation.reason,
        validation.diagnostics,
      );
      terminalObserved = result.roundTripStatus === "terminal_observed";
      return result;
    }

    const response = responseFor(requestEvent.message.method, requestEvent.message.params, "decline", workspace);
    const responseSequence = client.respond(requestEvent.message.id, response);
    const resolvedEvent = await client
      .waitFor(resolvedFor(requestEvent.message.id, threadId), TURN_TIMEOUT_MS, responseSequence, deadlineAt)
      .catch(() => undefined);
    if (resolvedEvent === undefined) return blocked(caseName, definition.expectedMethod, "resolved_not_observed");
    const duplicateSequence = client.respond(requestEvent.message.id, response);
    const terminalEvent = await client
      .waitFor(terminalFor(threadId, turnId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
      .catch(() => undefined);
    terminalObserved = terminalEvent !== undefined;
    await boundedSleep(250, deadlineAt, "duplicate response observation");

    const itemId = requestEvent.message.params?.itemId;
    const resolvedCounts = resolvedRequestCounts(client, requestEvent.message.id, threadId, requestEvent.sequence);
    const terminalCount = client.events.filter(
      (event) => event.sequence > fromSequence && terminalFor(threadId, turnId)(event.message),
    ).length;
    const itemTerminal =
      typeof itemId === "string" ? itemTerminalCount(client, threadId, turnId, itemId, "declined", fromSequence) : 0;
    const errorNotificationCount = client.events.filter(
      (event) => event.sequence > duplicateSequence && event.message.method === "error",
    ).length;
    const sideEffect = observedMarkerEffect(definition.markerPath);
    const passed =
      terminalEvent?.message?.params?.turn?.status === "completed" &&
      resolvedCounts.exact === 1 &&
      resolvedCounts.wrongOwner === 0 &&
      terminalCount === 1 &&
      itemTerminal === 1 &&
      sideEffect === "none" &&
      client.processError === null;
    return {
      case: caseName,
      status: passed ? "pass" : "blocked",
      method: definition.expectedMethod,
      decision: "decline",
      order: ["request", "response_sent", "resolved", "duplicate_response_sent", "terminal"],
      requestLifecycleStatus: resolvedCounts.exact === 1 ? "resolved_once" : "unexpected_resolution_count",
      roundTripStatus: terminalObserved ? "terminal_observed" : "terminal_not_observed",
      terminalStatus: publicTurnStatus(terminalEvent?.message?.params?.turn?.status),
      pendingCount: 0,
      sideEffect,
      duplicate: "sent_after_resolved",
      duplicateDisposition: "not_independently_acknowledged_by_protocol",
      responseAcknowledgement: "serverRequest/resolved_only",
      resolvedCount: resolvedCounts.exact,
      wrongOwnerResolvedCount: resolvedCounts.wrongOwner,
      terminalCount,
      itemTerminalCount: itemTerminal,
      errorNotificationCount,
      appServerDiagnostics: client.diagnosticFlags(),
      reason: passed
        ? "single_resolution_and_terminal_observed_without_duplicate_ack"
        : "duplicate_observation_incomplete",
    };
  } catch (error) {
    return blocked(
      caseName,
      definition.expectedMethod,
      error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure",
    );
  } finally {
    if (typeof threadId === "string" && typeof turnId === "string" && !terminalObserved) {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
    }
  }
}

function pendingIsolationObservationPassed(observation) {
  return (
    observation.rawTerminalStatuses[0] === "completed" &&
    observation.rawTerminalStatuses[1] === "completed" &&
    observation.resolvedObserved &&
    !observation.resolvedBeforeResponse &&
    !observation.crossOwnerEvent &&
    observation.sideEffect === "none" &&
    observation.terminalCounts[0] === 1 &&
    observation.terminalCounts[1] === 1 &&
    observation.interactionAudit.exactCounts[0] === 1 &&
    observation.interactionAudit.exactCounts[1] === 0 &&
    observation.interactionAudit.unexpectedCount === 0 &&
    observation.itemTerminalCount === 1 &&
    observation.resolvedCounts.exact === 1 &&
    observation.resolvedCounts.wrongOwner === 0
  );
}

async function runDisconnectObservationCase(
  client,
  workspace,
  definition,
  disconnect,
  deadlineAt,
  totalDeadlineAt,
  ownedClients,
) {
  let threadId;
  let turnId;
  let requestEvent;
  let responseSent = false;
  let resolvedObserved = false;
  let stopped;
  let failure;
  let operation = "thread_start";
  try {
    const threadResponse = await client.request(
      "thread/start",
      startThreadParams(workspace, definition.approvalPolicy, definition.threadSandbox),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadId = threadResponse.result?.thread?.id;
    if (typeof threadId !== "string") {
      failure = "thread_start_invalid";
      return blocked(definition.name, definition.expectedMethod, failure);
    }
    operation = "turn_start";
    const fromSequence = client.nextSequence;
    const turnResponse = await client.request(
      "turn/start",
      turnParams(threadId, definition.approvalPolicy, definition.turnSandbox, definition.prompt),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnId = turnResponse.result?.turn?.id;
    if (typeof turnId !== "string") {
      failure = "turn_start_invalid";
      return blocked(definition.name, definition.expectedMethod, failure);
    }
    operation = "interaction_wait";
    requestEvent = await client
      .waitFor(interactionFor(threadId, turnId), INTERACTION_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    if (requestEvent === undefined) {
      failure = "request_not_observed";
      return blocked(definition.name, definition.expectedMethod, failure);
    }
    if (requestEvent.message.method !== definition.expectedMethod) {
      failure = "different_interaction_observed";
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        failure,
      );
    }
    operation = "payload_validation";
    const validation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadId, expectedTurnId: turnId },
      requestEvent,
    );
    if (!validation.ok) {
      failure = validation.reason;
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        failure,
        validation.diagnostics,
      );
    }
    operation = "response_write";
    client.respond(
      requestEvent.message.id,
      responseFor(requestEvent.message.method, requestEvent.message.params, definition.decision, workspace),
    );
    responseSent = true;
    if (disconnect.waitForResolved === true) {
      operation = "resolved_wait";
      resolvedObserved =
        (await client
          .waitFor(
            resolvedFor(requestEvent.message.id, threadId),
            TERMINAL_OBSERVATION_MS,
            requestEvent.sequence,
            deadlineAt,
          )
          .catch(() => undefined)) !== undefined;
    } else if (disconnect.delayMs > 0) {
      operation = "disconnect_delay";
      await boundedSleep(disconnect.delayMs, deadlineAt, "disconnect observation delay");
      resolvedObserved = client.events.some(
        (event) =>
          event.sequence > requestEvent.sequence && resolvedFor(requestEvent.message.id, threadId)(event.message),
      );
    }
  } catch (error) {
    failure = error instanceof ProbeDeadlineError ? "probe_deadline" : `${operation}_failed`;
  } finally {
    try {
      stopped = await client.stop(cleanupResourceDeadline(totalDeadlineAt, Math.max(1, ownedClients.size)));
      if (stopped.exitConfirmed) ownedClients.delete(client);
    } catch {
      failure = "process_stop_failed";
    }
  }
  const sideEffect = observedMarkerEffect(definition.markerPath);
  if (failure !== undefined || !responseSent || stopped?.exitConfirmed !== true || sideEffect === "unexpected") {
    return {
      ...blocked(definition.name, definition.expectedMethod, failure ?? "disconnect_observation_incomplete"),
      requestLifecycleStatus: resolvedObserved ? "resolved" : responseSent ? "write_attempted" : "not_observed",
      roundTripStatus: "not_confirmed",
      sideEffect,
    };
  }
  return {
    case: definition.name,
    status: "pass",
    method: definition.expectedMethod,
    decision: definition.decision,
    order: disconnect.waitForResolved
      ? ["request", "response_sent", "resolved", "client_disconnect"]
      : ["request", "response_sent", "client_disconnect"],
    requestLifecycleStatus: resolvedObserved ? "resolved" : "write_attempted",
    roundTripStatus: sideEffect === "workspace_only" ? "effect_observed_after_disconnect" : "no_effect_observed",
    terminalStatus: "not_observed",
    pendingCount: resolvedObserved ? 0 : 1,
    sideEffect,
    duplicate: "not_tested",
    disconnectMode: stopped.forced ? "forced_tree" : "stdio_close",
    disconnectDelayMs: disconnect.delayMs,
    reason: "observed",
  };
}

function raceEffectCertainty(sideEffect, resolvedObserved, terminalObserved) {
  if (sideEffect === "workspace_only") return "known_applied";
  if (sideEffect === "none" && resolvedObserved && terminalObserved) return "known_none";
  return "ambiguous";
}

function raceObservationPassed(rawTerminalStatus, interruptResult, counts, sideEffect) {
  return (
    ["completed", "interrupted", "failed"].includes(rawTerminalStatus) &&
    interruptResult !== "request_failed" &&
    counts.interactions === 1 &&
    counts.terminals === 1 &&
    counts.resolved <= 1 &&
    sideEffect !== "unexpected"
  );
}

async function runRaceCase(client, workspace, definition, interruptFirst, deadlineAt) {
  let threadId;
  let turnId;
  try {
    const threadResponse = await client.request(
      "thread/start",
      startThreadParams(workspace, definition.approvalPolicy, definition.threadSandbox),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadId = threadResponse.result?.thread?.id;
    if (typeof threadId !== "string")
      return blocked(definition.name, definition.expectedMethod, "thread_start_invalid");
    const fromSequence = client.nextSequence;
    const turnResponse = await client.request(
      "turn/start",
      turnParams(threadId, definition.approvalPolicy, definition.turnSandbox, definition.prompt),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnId = turnResponse.result?.turn?.id;
    if (typeof turnId !== "string") return blocked(definition.name, definition.expectedMethod, "turn_start_invalid");
    const requestEvent = await client
      .waitFor(interactionFor(threadId, turnId), INTERACTION_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    if (requestEvent === undefined) return blocked(definition.name, definition.expectedMethod, "request_not_observed");
    if (requestEvent.message.method !== definition.expectedMethod) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        "different_interaction_observed",
      );
    }
    const validation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadId, expectedTurnId: turnId },
      requestEvent,
    );
    if (!validation.ok) {
      return failClosedTurnInteraction(
        client,
        workspace,
        definition,
        threadId,
        turnId,
        requestEvent,
        deadlineAt,
        validation.reason,
        validation.diagnostics,
      );
    }

    let interruptPromise;
    const classifyInterruptResult = (error) => (error instanceof RpcRequestError ? "rpc_rejected" : "request_failed");
    if (interruptFirst) {
      interruptPromise = client
        .request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS, deadlineAt)
        .then(() => "accepted", classifyInterruptResult);
      client.respond(
        requestEvent.message.id,
        responseFor(requestEvent.message.method, requestEvent.message.params, definition.decision, workspace),
      );
    } else {
      client.respond(
        requestEvent.message.id,
        responseFor(requestEvent.message.method, requestEvent.message.params, definition.decision, workspace),
      );
      interruptPromise = client
        .request("turn/interrupt", { threadId, turnId }, INTERRUPT_TIMEOUT_MS, deadlineAt)
        .then(() => "accepted", classifyInterruptResult);
    }
    const [interruptResult, resolvedEvent, terminalEvent] = await Promise.all([
      interruptPromise,
      client
        .waitFor(
          resolvedFor(requestEvent.message.id, threadId),
          TERMINAL_OBSERVATION_MS,
          requestEvent.sequence,
          deadlineAt,
        )
        .catch(() => undefined),
      client
        .waitFor(terminalFor(threadId, turnId), TURN_TIMEOUT_MS, requestEvent.sequence, deadlineAt)
        .catch(() => undefined),
    ]);
    const counts = ownerEventCounts(client, threadId, turnId, fromSequence);
    const sideEffect = observedMarkerEffect(definition.markerPath);
    const rawTerminalStatus = terminalEvent?.message?.params?.turn?.status;
    const terminalStatus = publicTurnStatus(rawTerminalStatus);
    const effectCertainty = raceEffectCertainty(sideEffect, resolvedEvent !== undefined, terminalEvent !== undefined);
    const passed = raceObservationPassed(rawTerminalStatus, interruptResult, counts, sideEffect);
    return {
      case: definition.name,
      status: passed ? "pass" : "blocked",
      method: definition.expectedMethod,
      decision: definition.decision,
      order: interruptFirst
        ? ["request", "interrupt_sent", "response_sent"]
        : ["request", "response_sent", "interrupt_sent"],
      requestLifecycleStatus: resolvedEvent === undefined ? "write_attempted" : "resolved",
      roundTripStatus: terminalEvent === undefined ? "not_confirmed" : "terminal_observed",
      terminalStatus,
      pendingCount: resolvedEvent === undefined ? 1 : 0,
      sideEffect,
      effectCertainty,
      interruptResult,
      interactionCount: counts.interactions,
      resolvedCount: counts.resolved,
      terminalCount: counts.terminals,
      duplicate: "not_tested",
      appServerDiagnostics: client.diagnosticFlags(),
      reason: passed ? "observed" : "race_contract_incomplete",
    };
  } catch (error) {
    if (typeof threadId === "string" && typeof turnId === "string") {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
    }
    return blocked(
      definition.name,
      definition.expectedMethod,
      error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure",
    );
  }
}

const OWNER_SCOPED_LIFECYCLE_METHODS = new Set([
  ...TARGET_METHODS,
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
]);

function lifecycleOwnerTuple(message) {
  if (!OWNER_SCOPED_LIFECYCLE_METHODS.has(message.method)) return undefined;
  return {
    threadId: message.params?.threadId,
    turnId: message.params?.turnId ?? message.params?.turn?.id,
  };
}

function ownerTupleKey(threadId, turnId) {
  return `${threadId.length}:${threadId}${turnId.length}:${turnId}`;
}

function hasCrossOwnerEvent(events, pairs, afterSequence) {
  const ownerKeys = new Set(pairs.map((pair) => ownerTupleKey(pair.threadId, pair.turnId)));
  return events.some((event) => {
    if (event.sequence <= afterSequence) return false;
    const owner = lifecycleOwnerTuple(event.message);
    if (owner === undefined) return false;
    return (
      typeof owner.threadId !== "string" ||
      typeof owner.turnId !== "string" ||
      !ownerKeys.has(ownerTupleKey(owner.threadId, owner.turnId))
    );
  });
}

function activeTurnConcurrencyEvidence(events, owners, afterSequence) {
  const ownerIndexByKey = new Map(owners.map((owner, index) => [ownerTupleKey(owner.threadId, owner.turnId), index]));
  const startCounts = owners.map(() => 0);
  const completionCounts = owners.map(() => 0);
  let active = 0;
  let maximumActive = 0;
  let invalidCount = 0;

  for (const event of events) {
    if (event.sequence <= afterSequence || !["turn/started", "turn/completed"].includes(event.message.method)) {
      continue;
    }
    const owner = lifecycleOwnerTuple(event.message);
    const ownerIndex =
      owner !== undefined && typeof owner.threadId === "string" && typeof owner.turnId === "string"
        ? ownerIndexByKey.get(ownerTupleKey(owner.threadId, owner.turnId))
        : undefined;
    if (ownerIndex === undefined) {
      invalidCount += 1;
      continue;
    }
    if (event.message.method === "turn/started") {
      startCounts[ownerIndex] += 1;
      if (startCounts[ownerIndex] !== 1 || completionCounts[ownerIndex] !== 0) {
        invalidCount += 1;
        continue;
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      continue;
    }
    completionCounts[ownerIndex] += 1;
    if (startCounts[ownerIndex] !== 1 || completionCounts[ownerIndex] !== 1 || active < 1) {
      invalidCount += 1;
      continue;
    }
    active -= 1;
  }

  return { startCounts, completionCounts, maximumActive, finalActive: active, invalidCount };
}

async function runParallelNoToolPair(client, workspace, caseName, deadlineAt) {
  const fromSequence = client.nextSequence;
  let threadIdA;
  let threadIdB;
  let turnIdA;
  let turnIdB;
  let terminalObservedA = false;
  let terminalObservedB = false;
  try {
    const [threadA, threadB] = await Promise.all([
      client.request(
        "thread/start",
        startThreadParams(workspace, "never", "read-only"),
        REQUEST_TIMEOUT_MS,
        deadlineAt,
      ),
      client.request(
        "thread/start",
        startThreadParams(workspace, "never", "read-only"),
        REQUEST_TIMEOUT_MS,
        deadlineAt,
      ),
    ]);
    threadIdA = threadA.result?.thread?.id;
    threadIdB = threadB.result?.thread?.id;
    if (typeof threadIdA !== "string" || typeof threadIdB !== "string") {
      return blocked(caseName, "turn/start", "thread_start_invalid");
    }
    const [turnA, turnB] = await Promise.all([
      client.request(
        "turn/start",
        turnParams(threadIdA, "never", { type: "readOnly" }, "Reply with ready-a without using tools."),
        REQUEST_TIMEOUT_MS,
        deadlineAt,
      ),
      client.request(
        "turn/start",
        turnParams(threadIdB, "never", { type: "readOnly" }, "Reply with ready-b without using tools."),
        REQUEST_TIMEOUT_MS,
        deadlineAt,
      ),
    ]);
    turnIdA = turnA.result?.turn?.id;
    turnIdB = turnB.result?.turn?.id;
    if (typeof turnIdA !== "string" || typeof turnIdB !== "string") {
      return blocked(caseName, "turn/start", "turn_start_invalid");
    }
    const [terminalA, terminalB] = await Promise.all([
      client.waitFor(terminalFor(threadIdA, turnIdA), TURN_TIMEOUT_MS, fromSequence, deadlineAt).catch(() => undefined),
      client.waitFor(terminalFor(threadIdB, turnIdB), TURN_TIMEOUT_MS, fromSequence, deadlineAt).catch(() => undefined),
    ]);
    terminalObservedA = terminalA !== undefined;
    terminalObservedB = terminalB !== undefined;
    const terminalCountA = client.events.filter(
      (event) => event.sequence > fromSequence && terminalFor(threadIdA, turnIdA)(event.message),
    ).length;
    const terminalCountB = client.events.filter(
      (event) => event.sequence > fromSequence && terminalFor(threadIdB, turnIdB)(event.message),
    ).length;
    const crossOwnerEvent = hasCrossOwnerEvent(
      client.events,
      [
        { threadId: threadIdA, turnId: turnIdA },
        { threadId: threadIdB, turnId: turnIdB },
      ],
      fromSequence,
    );
    const interactionAudit = multiRunInteractionAudit(
      client.events,
      [
        { threadId: threadIdA, turnId: turnIdA },
        { threadId: threadIdB, turnId: turnIdB },
      ],
      fromSequence,
    );
    const owners = [
      { threadId: threadIdA, turnId: turnIdA },
      { threadId: threadIdB, turnId: turnIdB },
    ];
    const concurrencyEvidence = activeTurnConcurrencyEvidence(client.events, owners, fromSequence);
    const passed = parallelNoToolObservationPassed(
      [terminalA?.message?.params?.turn?.status, terminalB?.message?.params?.turn?.status],
      [terminalCountA, terminalCountB],
      crossOwnerEvent,
      interactionAudit,
      concurrencyEvidence,
    );
    return {
      case: caseName,
      status: passed ? "pass" : "blocked",
      method: "turn/start",
      turns: 2,
      terminalStatuses: [
        publicTurnStatus(terminalA?.message?.params?.turn?.status),
        publicTurnStatus(terminalB?.message?.params?.turn?.status),
      ],
      terminalCounts: [terminalCountA, terminalCountB],
      interactionCounts: interactionAudit.exactCounts,
      unexpectedInteractionCount: interactionAudit.unexpectedCount,
      crossOwnerEvent,
      observedConcurrencyLowerBound: concurrencyEvidence.maximumActive,
      startCounts: concurrencyEvidence.startCounts,
      reason: passed ? "observed" : "parallel_owner_contract_incomplete",
    };
  } catch (error) {
    return blocked(caseName, "turn/start", error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure");
  } finally {
    if (typeof threadIdA === "string" && typeof turnIdA === "string" && !terminalObservedA) {
      await interruptQuietly(client, threadIdA, turnIdA, deadlineAt);
    }
    if (typeof threadIdB === "string" && typeof turnIdB === "string" && !terminalObservedB) {
      await interruptQuietly(client, threadIdB, turnIdB, deadlineAt);
    }
  }
}

async function runParallelNoToolBatch(client, workspace, caseName, turnCount, deadlineAt) {
  if (!Number.isSafeInteger(turnCount) || turnCount < 1 || turnCount > MAX_TURNS) {
    throw new Error("parallel batch turn count is out of bounds");
  }
  const fromSequence = client.nextSequence;
  const owners = [];
  const terminalObserved = new Set();
  try {
    const threadResponses = await Promise.all(
      Array.from({ length: turnCount }, () =>
        client.request(
          "thread/start",
          startThreadParams(workspace, "never", "read-only"),
          REQUEST_TIMEOUT_MS,
          deadlineAt,
        ),
      ),
    );
    const threadIds = threadResponses.map((response) => response.result?.thread?.id);
    if (threadIds.some((threadId) => typeof threadId !== "string") || !isUnique(threadIds)) {
      return blocked(caseName, "thread/start", "thread_start_invalid");
    }
    const turnResponses = await Promise.all(
      threadIds.map((threadId, index) =>
        client.request(
          "turn/start",
          turnParams(
            threadId,
            "never",
            { type: "readOnly" },
            `Reply with exactly ready-${index + 1} without using tools.`,
          ),
          REQUEST_TIMEOUT_MS,
          deadlineAt,
        ),
      ),
    );
    const turnIds = turnResponses.map((response) => response.result?.turn?.id);
    if (turnIds.some((turnId) => typeof turnId !== "string") || !isUnique(turnIds)) {
      return blocked(caseName, "turn/start", "turn_start_invalid");
    }
    for (let index = 0; index < turnCount; index += 1) {
      owners.push({ threadId: threadIds[index], turnId: turnIds[index] });
    }
    const terminals = await Promise.all(
      turnIds.map((turnId, index) =>
        client
          .waitFor(terminalFor(threadIds[index], turnId), TURN_TIMEOUT_MS, fromSequence, deadlineAt)
          .catch(() => undefined),
      ),
    );
    terminals.forEach((terminal, index) => {
      if (terminal !== undefined) terminalObserved.add(turnIds[index]);
    });
    const terminalStatuses = terminals.map((terminal) => terminal?.message?.params?.turn?.status);
    const terminalCounts = turnIds.map(
      (turnId, index) =>
        client.events.filter(
          (event) => event.sequence > fromSequence && terminalFor(threadIds[index], turnId)(event.message),
        ).length,
    );
    const crossOwnerEvent = hasCrossOwnerEvent(client.events, owners, fromSequence);
    const interactionAudit = multiRunInteractionAudit(client.events, owners, fromSequence);
    const concurrencyEvidence = activeTurnConcurrencyEvidence(client.events, owners, fromSequence);
    const passed = parallelNoToolObservationPassed(
      terminalStatuses,
      terminalCounts,
      crossOwnerEvent,
      interactionAudit,
      concurrencyEvidence,
    );
    return {
      case: caseName,
      status: passed ? "pass" : "blocked",
      method: "turn/start",
      turns: turnCount,
      terminalStatuses: terminalStatuses.map((status) => publicTurnStatus(status)),
      terminalCounts,
      interactionCounts: interactionAudit.exactCounts,
      unexpectedInteractionCount: interactionAudit.unexpectedCount,
      crossOwnerEvent,
      observedConcurrencyLowerBound: concurrencyEvidence.maximumActive,
      startCounts: concurrencyEvidence.startCounts,
      absoluteProviderLimit: "not_claimed",
      reason: passed ? "bounded_parallel_batch_observed" : "parallel_owner_contract_incomplete",
    };
  } catch (error) {
    return blocked(caseName, "turn/start", error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure");
  } finally {
    for (const owner of owners) {
      if (!terminalObserved.has(owner.turnId)) {
        await interruptQuietly(client, owner.threadId, owner.turnId, deadlineAt);
      }
    }
  }
}

function completedAgentMessagePhases(client, threadId, turnId, afterSequence) {
  const counts = { commentary: 0, final_answer: 0, null: 0, other: 0 };
  let explicitFinalContainsExpectedText = false;
  for (const event of client.events) {
    if (
      event.sequence <= afterSequence ||
      event.message.method !== "item/completed" ||
      event.message.params?.threadId !== threadId ||
      event.message.params?.turnId !== turnId ||
      event.message.params?.item?.type !== "agentMessage"
    ) {
      continue;
    }
    const item = event.message.params.item;
    if (item.phase === "commentary") counts.commentary += 1;
    else if (item.phase === "final_answer") {
      counts.final_answer += 1;
      if (typeof item.text === "string" && item.text.includes("PHASE_FINAL_OK")) {
        explicitFinalContainsExpectedText = true;
      }
    } else if (item.phase === null || item.phase === undefined) counts.null += 1;
    else counts.other += 1;
  }
  return { counts, explicitFinalContainsExpectedText };
}

async function runAssistantPhaseObservation(client, workspace, caseName, deadlineAt) {
  const fromSequence = client.nextSequence;
  let threadId;
  let turnId;
  let terminalObserved = false;
  try {
    const thread = await client.request(
      "thread/start",
      startThreadParams(workspace, "never", "read-only"),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadId = thread.result?.thread?.id;
    if (typeof threadId !== "string") return blocked(caseName, "thread/start", "thread_start_invalid");
    const turn = await client.request(
      "turn/start",
      turnParams(
        threadId,
        "never",
        { type: "readOnly" },
        "Without using tools, first send one brief commentary progress update. Then send a final answer containing exactly: PHASE_FINAL_OK",
      ),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnId = turn.result?.turn?.id;
    if (typeof turnId !== "string") return blocked(caseName, "turn/start", "turn_start_invalid");
    const terminal = await client
      .waitFor(terminalFor(threadId, turnId), TURN_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    terminalObserved = terminal !== undefined;
    const phaseEvidence = completedAgentMessagePhases(client, threadId, turnId, fromSequence);
    const passed =
      terminal?.message?.params?.turn?.status === "completed" &&
      phaseEvidence.counts.commentary >= 1 &&
      phaseEvidence.counts.final_answer >= 1 &&
      phaseEvidence.counts.other === 0 &&
      phaseEvidence.explicitFinalContainsExpectedText;
    return {
      case: caseName,
      status: passed ? "pass" : "blocked",
      method: "item/completed",
      turns: 1,
      terminalStatus: publicTurnStatus(terminal?.message?.params?.turn?.status),
      completedAgentMessagePhases: phaseEvidence.counts,
      explicitFinalContainsExpectedText: phaseEvidence.explicitFinalContainsExpectedText,
      nullablePhaseSchemaContract: "required_fallback",
      reason: passed ? "explicit_commentary_and_final_phases_observed" : "assistant_phase_contract_incomplete",
    };
  } catch (error) {
    return blocked(
      caseName,
      "item/completed",
      error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure",
    );
  } finally {
    if (typeof threadId === "string" && typeof turnId === "string" && !terminalObserved) {
      await interruptQuietly(client, threadId, turnId, deadlineAt);
    }
  }
}

async function runPendingApprovalIsolationPair(client, workspace, caseName, deadlineAt) {
  const definition = advancedCommandDefinition(workspace, `${caseName}-pending`);
  const fromSequence = client.nextSequence;
  let threadIdA;
  let turnIdA;
  let threadIdB;
  let turnIdB;
  let terminalObservedA = false;
  let terminalObservedB = false;
  try {
    const threadA = await client.request(
      "thread/start",
      startThreadParams(workspace, definition.approvalPolicy, definition.threadSandbox),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadIdA = threadA.result?.thread?.id;
    if (typeof threadIdA !== "string") return blocked(caseName, definition.expectedMethod, "thread_start_invalid");
    const turnA = await client.request(
      "turn/start",
      turnParams(threadIdA, definition.approvalPolicy, definition.turnSandbox, definition.prompt),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnIdA = turnA.result?.turn?.id;
    if (typeof turnIdA !== "string") return blocked(caseName, definition.expectedMethod, "turn_start_invalid");
    const requestA = await client
      .waitFor(interactionFor(threadIdA, turnIdA), INTERACTION_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    if (requestA === undefined) return blocked(caseName, definition.expectedMethod, "request_not_observed");
    if (requestA.message.method !== definition.expectedMethod) {
      const result = await failClosedTurnInteraction(
        client,
        workspace,
        { ...definition, name: caseName },
        threadIdA,
        turnIdA,
        requestA,
        deadlineAt,
        "different_interaction_observed",
      );
      terminalObservedA = result.roundTripStatus === "terminal_observed";
      return result;
    }
    const validation = validateInteractionRequest(
      client,
      workspace,
      { ...definition, expectedThreadId: threadIdA, expectedTurnId: turnIdA },
      requestA,
    );
    if (!validation.ok) {
      const result = await failClosedTurnInteraction(
        client,
        workspace,
        { ...definition, name: caseName },
        threadIdA,
        turnIdA,
        requestA,
        deadlineAt,
        validation.reason,
        validation.diagnostics,
      );
      terminalObservedA = result.roundTripStatus === "terminal_observed";
      return result;
    }

    const threadB = await client.request(
      "thread/start",
      startThreadParams(workspace, "never", "read-only"),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    threadIdB = threadB.result?.thread?.id;
    if (typeof threadIdB !== "string") return blocked(caseName, "turn/start", "thread_start_invalid");
    const turnB = await client.request(
      "turn/start",
      turnParams(threadIdB, "never", { type: "readOnly" }, "Reply with ready-b without using tools."),
      REQUEST_TIMEOUT_MS,
      deadlineAt,
    );
    turnIdB = turnB.result?.turn?.id;
    if (typeof turnIdB !== "string") return blocked(caseName, "turn/start", "turn_start_invalid");
    const terminalB = await client
      .waitFor(terminalFor(threadIdB, turnIdB), TURN_TIMEOUT_MS, fromSequence, deadlineAt)
      .catch(() => undefined);
    terminalObservedB = terminalB !== undefined;
    const resolvedBeforeResponse = client.events.some((event) =>
      resolvedFor(requestA.message.id, threadIdA)(event.message),
    );
    client.respond(
      requestA.message.id,
      responseFor(requestA.message.method, requestA.message.params, "decline", workspace),
    );
    const [resolvedA, terminalA] = await Promise.all([
      client
        .waitFor(resolvedFor(requestA.message.id, threadIdA), TURN_TIMEOUT_MS, requestA.sequence, deadlineAt)
        .catch(() => undefined),
      client
        .waitFor(terminalFor(threadIdA, turnIdA), TURN_TIMEOUT_MS, requestA.sequence, deadlineAt)
        .catch(() => undefined),
    ]);
    terminalObservedA = terminalA !== undefined;
    const crossOwnerEvent = hasCrossOwnerEvent(
      client.events,
      [
        { threadId: threadIdA, turnId: turnIdA },
        { threadId: threadIdB, turnId: turnIdB },
      ],
      fromSequence,
    );
    const sideEffect = observedMarkerEffect(definition.markerPath);
    const itemIdA = requestA.message.params?.itemId;
    const interactionAudit = multiRunInteractionAudit(
      client.events,
      [
        { threadId: threadIdA, turnId: turnIdA, itemId: itemIdA },
        { threadId: threadIdB, turnId: turnIdB },
      ],
      fromSequence,
    );
    const terminalCountA = client.events.filter(
      (event) => event.sequence > fromSequence && terminalFor(threadIdA, turnIdA)(event.message),
    ).length;
    const terminalCountB = client.events.filter(
      (event) => event.sequence > fromSequence && terminalFor(threadIdB, turnIdB)(event.message),
    ).length;
    const itemTerminalCountA =
      typeof itemIdA === "string"
        ? itemTerminalCount(client, threadIdA, turnIdA, itemIdA, "declined", fromSequence)
        : 0;
    const resolvedCountsA = resolvedRequestCounts(client, requestA.message.id, threadIdA, requestA.sequence);
    const passed = pendingIsolationObservationPassed({
      rawTerminalStatuses: [terminalA?.message?.params?.turn?.status, terminalB?.message?.params?.turn?.status],
      resolvedObserved: resolvedA !== undefined,
      resolvedBeforeResponse,
      crossOwnerEvent,
      sideEffect,
      terminalCounts: [terminalCountA, terminalCountB],
      interactionAudit,
      itemTerminalCount: itemTerminalCountA,
      resolvedCounts: resolvedCountsA,
    });
    return {
      case: caseName,
      status: passed ? "pass" : "blocked",
      method: definition.expectedMethod,
      turns: 2,
      pendingApprovalSurvivedSiblingTurn: !resolvedBeforeResponse,
      terminalStatuses: [
        publicTurnStatus(terminalA?.message?.params?.turn?.status),
        publicTurnStatus(terminalB?.message?.params?.turn?.status),
      ],
      terminalCounts: [terminalCountA, terminalCountB],
      interactionCounts: interactionAudit.exactCounts,
      unexpectedInteractionCount: interactionAudit.unexpectedCount,
      itemTerminalCount: itemTerminalCountA,
      resolvedCount: resolvedCountsA.exact,
      wrongOwnerResolvedCount: resolvedCountsA.wrongOwner,
      crossOwnerEvent,
      sideEffect,
      reason: passed ? "observed" : "pending_owner_isolation_incomplete",
    };
  } catch (error) {
    return blocked(
      caseName,
      definition.expectedMethod,
      error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure",
    );
  } finally {
    if (typeof threadIdA === "string" && typeof turnIdA === "string" && !terminalObservedA) {
      await interruptQuietly(client, threadIdA, turnIdA, deadlineAt);
    }
    if (typeof threadIdB === "string" && typeof turnIdB === "string" && !terminalObservedB) {
      await interruptQuietly(client, threadIdB, turnIdB, deadlineAt);
    }
  }
}

function validateDryRunDefinitions(definitions) {
  const turnCount = definitions.reduce((count, definition) => count + (definition.prewarm === true ? 2 : 1), 0);
  if (turnCount > MAX_TURNS) throw new Error("probe turn budget exceeded");
  for (const definition of definitions) {
    if (!TARGET_METHODS.has(definition.expectedMethod)) throw new Error("unknown probe method");
    if (definition.decision === "acceptForSession" || definition.scope === "session") {
      throw new Error("persistent grant is forbidden");
    }
    if (definition.prompt.toLowerCase().includes("http://") || definition.prompt.toLowerCase().includes("https://")) {
      throw new Error("network prompt is forbidden");
    }
  }
}

function configOverrides(launcher, disabledServerNames, enableFollowUpFeatures) {
  const normalizedLauncher = launcher.replaceAll("\\", "/");
  return [
    "hooks={}",
    "mcp_servers={}",
    ...disabledServerNames.map((name) => `mcp_servers.${name}.enabled=false`),
    `mcp_servers.withmate_probe.command=${normalizedLauncher}`,
    "mcp_servers.withmate_probe.enabled=true",
    ...(enableFollowUpFeatures
      ? ["features.request_permissions_tool=true", "features.default_mode_request_user_input=true"]
      : []),
  ];
}

async function inspectConfig(client, workspace, deadlineAt = client.deadlineAt) {
  const response = await client.request(
    "config/read",
    { cwd: workspace, includeLayers: false },
    REQUEST_TIMEOUT_MS,
    deadlineAt,
  );
  const config = response.result?.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return { hooksIsolated: false, servers: undefined };
  }
  const hooks = config.hooks;
  const servers = config.mcp_servers ?? config.mcpServers;
  const hooksIsolated =
    typeof hooks === "object" &&
    hooks !== null &&
    !Array.isArray(hooks) &&
    Object.entries(hooks).every(([key, value]) => key === "state" || (Array.isArray(value) && value.length === 0));
  return {
    hooksIsolated,
    servers: typeof servers === "object" && servers !== null && !Array.isArray(servers) ? servers : undefined,
    features:
      typeof config.features === "object" && config.features !== null && !Array.isArray(config.features)
        ? config.features
        : undefined,
  };
}

async function inspectProviderPreflight(client, deadlineAt = client.deadlineAt) {
  return inspectValidationModelPreflight(async (method, params) => {
    const response = await client.request(method, params, REQUEST_TIMEOUT_MS, deadlineAt);
    return response.result;
  });
}

async function discoverExistingServers(workspace, deadlineAt, totalDeadlineAt, ownedClients, transportClients) {
  const client = new AppServerClient(["hooks={}", "mcp_servers={}"], null, totalDeadlineAt);
  ownedClients.add(client);
  transportClients.add(client);
  try {
    await client.initialize(deadlineAt);
    const inspection = await inspectConfig(client, workspace, deadlineAt);
    if (!inspection.hooksIsolated || inspection.servers === undefined) return undefined;
    const names = Object.keys(inspection.servers);
    if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name) || name === "withmate_probe")) return undefined;
    return names;
  } finally {
    await client.stop(totalDeadlineAt);
    ownedClients.delete(client);
  }
}

function overallProbeStatus(casesResult, cleanup, transport = "verified") {
  return cleanup === "verified" &&
    transport === "verified" &&
    casesResult.length > 0 &&
    casesResult.every((item) => item.status === "pass")
    ? "pass"
    : "blocked";
}

function transportStatusFor(clients) {
  return [...clients].every((client) => client.processError === null) ? "verified" : "failed";
}

async function verifyIsolatedConfig(client, workspace, disabledServerNames, requireFollowUpFeatures, deadlineAt) {
  const inspection = await inspectConfig(client, workspace, deadlineAt);
  if (!inspection.hooksIsolated || inspection.servers === undefined) return false;
  const names = Object.keys(inspection.servers);
  if (!names.includes("withmate_probe")) return false;
  for (const name of disabledServerNames) {
    if (inspection.servers[name]?.enabled !== false) return false;
  }
  if (!names.every((name) => name === "withmate_probe" || disabledServerNames.includes(name))) return false;
  if (!requireFollowUpFeatures) return true;
  return (
    inspection.features?.request_permissions_tool === true &&
    inspection.features?.default_mode_request_user_input === true
  );
}

async function createIsolatedClient(
  workspace,
  launcher,
  disabledServerNames,
  enableFollowUpFeatures,
  deadlineAt,
  totalDeadlineAt,
  ownedClients,
  transportClients,
) {
  const client = new AppServerClient(
    configOverrides(launcher, disabledServerNames, enableFollowUpFeatures),
    enableFollowUpFeatures ? { experimentalApi: true, mcpServerOpenaiFormElicitation: true } : null,
    totalDeadlineAt,
  );
  ownedClients.add(client);
  transportClients.add(client);
  await client.initialize(deadlineAt);
  if (!(await verifyIsolatedConfig(client, workspace, disabledServerNames, enableFollowUpFeatures, deadlineAt))) {
    throw new Error("isolation_not_proven");
  }
  return client;
}

function dryRunReport(followUp = false) {
  const workspace = join(resolve(tmpdir()), "withmate-codex-interactions-dry-run");
  const auditPath = join(workspace, "mcp-audit.log");
  const definitions = followUp ? followUpCases(workspace, auditPath) : cases(workspace, auditPath);
  validateDryRunDefinitions(definitions);
  return {
    mode: followUp ? "follow_up_dry_run" : "dry_run",
    environment: {
      codexVersion: "not_observed",
      schemaBaseline: CODEX_SCHEMA_BASELINE,
      nodeVersion: process.version,
      platform: process.platform,
      transport: "stdio_jsonl",
      workspace: "<workspace>",
      hooks: "disabled",
      mcp: "local_stdio_only",
      model: VALIDATION_MODEL_SELECTION.model,
      reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
      modelCatalog: "not_observed",
      externalTurns: 0,
    },
    cases: definitions.map((definition) => ({ case: definition.name, method: definition.expectedMethod })),
    limits: {
      maxTurns: MAX_TURNS,
      maxProbeMs: MAX_PROBE_MS,
      maxTotalMs: MAX_TOTAL_MS,
      boundedWaitMs: BOUNDED_WAIT_MS,
    },
    stdioClientDisconnect: "blocked",
  };
}

async function liveReport(
  followUp = false,
  preflightOnly = false,
  directMcp = false,
  mcpTurnOnly = false,
  mcpTurnWarmupOnly = false,
  approvalOnly = false,
  commandOnly = false,
  advancedMode = null,
) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + MAX_PROBE_MS;
  const totalDeadlineAt = startedAt + MAX_TOTAL_MS;
  const report = {
    mode:
      advancedMode ??
      (directMcp
        ? "mcp_direct"
        : mcpTurnWarmupOnly
          ? "mcp_turn_warmup_diagnostic"
          : mcpTurnOnly
            ? "mcp_turn_diagnostic"
            : approvalOnly
              ? "approval_live"
              : commandOnly
                ? "command_diagnostic"
                : preflightOnly
                  ? "follow_up_preflight"
                  : followUp
                    ? "follow_up_live"
                    : "live"),
    environment: {
      codexVersion: "not_observed",
      schemaBaseline: CODEX_SCHEMA_BASELINE,
      nodeVersion: process.version,
      platform: process.platform,
      transport: "stdio_jsonl",
      workspace: "<workspace>",
      hooks: "disabled",
      mcp: "local_stdio_only",
      model: VALIDATION_MODEL_SELECTION.model,
      reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort,
      modelCatalog: "pending",
      externalTurns: 0,
    },
    cases: [],
    limits: {
      maxTurns: MAX_TURNS,
      maxProbeMs: MAX_PROBE_MS,
      maxTotalMs: MAX_TOTAL_MS,
      boundedWaitMs: BOUNDED_WAIT_MS,
    },
    stdioClientDisconnect: advancedMode?.startsWith("disconnect_") ? "under_observation" : "blocked",
    transport: "pending",
    cleanup: "pending",
  };
  const root = mkdtempSync(join(tmpdir(), "withmate-codex-interactions-"));
  const ownedClients = new Set();
  const transportClients = new Set();
  let client;
  let mcpAuditPath;
  let workspace;
  try {
    assertOwnedTempPath(root, "withmate-codex-interactions-");
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    const { auditPath, launcher } = createMcpLauncher(root);
    mcpAuditPath = auditPath;
    writeFileSync(join(root, "sentinel.txt"), "withmate-interaction-probe", { encoding: "utf8" });
    writeFileSync(join(workspace, ".keep"), "", { encoding: "utf8", flag: "w" });
    const invocation = codexInvocation(deadlineAt);
    const versionResult = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: boundedTimeout(deadlineAt, REQUEST_TIMEOUT_MS, "codex version"),
    });
    if (versionResult.error !== undefined || versionResult.status !== 0) throw new Error("codex version failed");
    const version = versionResult.stdout.trim();
    report.environment.codexVersion = version;
    const disabledServerNames = await discoverExistingServers(
      workspace,
      deadlineAt,
      totalDeadlineAt,
      ownedClients,
      transportClients,
    );
    if (disabledServerNames === undefined) {
      report.cases.push(blocked("preflight", "config/read", "isolation_not_proven"));
      return report;
    }
    client = await createIsolatedClient(
      workspace,
      launcher,
      disabledServerNames,
      followUp,
      deadlineAt,
      totalDeadlineAt,
      ownedClients,
      transportClients,
    );
    const providerPreflight = await inspectProviderPreflight(client, deadlineAt);
    if (providerPreflight === undefined) {
      report.environment.modelCatalog = "unavailable";
      report.cases.push(
        blocked(
          "preflight",
          "modelProvider/capabilities/read+model/list",
          "provider_capabilities_or_validation_model_tuple_unavailable",
        ),
      );
      return report;
    }
    report.environment.modelCatalog = "verified";
    report.environment.modelId = providerPreflight.model.modelId;
    report.environment.defaultReasoningEffort = providerPreflight.model.defaultReasoningEffort;
    report.environment.supportedReasoningEfforts = providerPreflight.model.supportedReasoningEfforts;
    report.environment.modelVisibility = providerPreflight.visibility;
    report.environment.modelProviderCapabilities = providerPreflight.providerCapabilities;
    if (preflightOnly) {
      report.cases.push({
        case: "preflight",
        status: "pass",
        method: "config/read+modelProvider/capabilities/read+model/list",
        reason: "isolation_provider_capabilities_visibility_and_model_tuple_verified",
      });
      return report;
    }
    if (directMcp) {
      report.cases.push(await runDirectMcpCase(client, workspace, auditPath, deadlineAt));
      return report;
    }
    if (advancedMode === "permission_live" || advancedMode === "user_input_live") {
      const targetName =
        advancedMode === "permission_live" ? "permission_turn_scope_flagged" : "user_input_duplicate_flagged";
      const target = followUpCases(workspace, auditPath).find((definition) => definition.name === targetName);
      if (target === undefined) throw new Error("targeted follow-up definition missing");
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        report.environment.externalTurns += 1;
        const result = await runCase(
          client,
          workspace,
          {
            ...target,
            name: `${target.name}-${ordinal}`,
            ...(advancedMode === "user_input_live" && ordinal === 2
              ? { userInputAnswer: "probe-free-form-answer" }
              : {}),
          },
          deadlineAt,
        );
        report.cases.push(result);
        if (result.status !== "pass") break;
      }
      return report;
    }
    if (advancedMode === "disconnect_live" || advancedMode === "disconnect_resolved_live") {
      const observations =
        advancedMode === "disconnect_resolved_live"
          ? [
              { label: "after_resolved_a", delayMs: 0, waitForResolved: true },
              { label: "after_resolved_b", delayMs: 0, waitForResolved: true },
            ]
          : [
              { label: "immediate_a", delayMs: 0, waitForResolved: false },
              { label: "immediate_b", delayMs: 0, waitForResolved: false },
              { label: "delay_25ms_a", delayMs: 25, waitForResolved: false },
              { label: "delay_25ms_b", delayMs: 25, waitForResolved: false },
              { label: "delay_250ms_a", delayMs: 250, waitForResolved: false },
              { label: "delay_250ms_b", delayMs: 250, waitForResolved: false },
            ];
      for (const [index, observation] of observations.entries()) {
        if (index > 0) {
          client = await createIsolatedClient(
            workspace,
            launcher,
            disabledServerNames,
            false,
            deadlineAt,
            totalDeadlineAt,
            ownedClients,
            transportClients,
          );
        }
        const definition = advancedCommandDefinition(workspace, `disconnect-${observation.label}`);
        report.environment.externalTurns += 1;
        const result = await runDisconnectObservationCase(
          client,
          workspace,
          definition,
          observation,
          deadlineAt,
          totalDeadlineAt,
          ownedClients,
        );
        report.cases.push(result);
        if (result.status !== "pass") break;
      }
      return report;
    }
    if (advancedMode === "race_live" || advancedMode === "race_interrupt_first_live") {
      const raceOrderCases =
        advancedMode === "race_interrupt_first_live"
          ? [true, true, true]
          : [false, false, false, false, true, true, true, true];
      for (const interruptFirst of raceOrderCases) {
        const order = interruptFirst ? "interrupt-first" : "response-first";
        const ordinal = report.cases.filter((item) => item.case.startsWith(`race-${order}`)).length + 1;
        const definition = advancedCommandDefinition(workspace, `race-${order}-${ordinal}`);
        report.environment.externalTurns += 1;
        const result = await runRaceCase(client, workspace, definition, interruptFirst, deadlineAt);
        report.cases.push(result);
        if (result.status !== "pass") break;
      }
      return report;
    }
    if (advancedMode === "duplicate_after_resolved_live") {
      report.environment.externalTurns += 1;
      report.cases.push(await runDuplicateAfterResolvedCase(client, workspace, "duplicate-after-resolved", deadlineAt));
      return report;
    }
    if (advancedMode === "parallel_batch_live") {
      report.environment.externalTurns += MAX_TURNS;
      report.cases.push(
        await runParallelNoToolBatch(
          client,
          workspace,
          "parallel-no-tool-batch-max-probe-bound",
          MAX_TURNS,
          deadlineAt,
        ),
      );
      return report;
    }
    if (advancedMode === "phase_live") {
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        report.environment.externalTurns += 1;
        const result = await runAssistantPhaseObservation(client, workspace, `assistant-phase-${ordinal}`, deadlineAt);
        report.cases.push(result);
        if (result.status !== "pass") break;
      }
      return report;
    }
    if (advancedMode === "multi_run_live") {
      for (const caseDefinition of [
        { name: "parallel-no-tool-1", kind: "no_tool" },
        { name: "parallel-no-tool-2", kind: "no_tool" },
        { name: "pending-approval-isolation-1", kind: "pending" },
        { name: "pending-approval-isolation-2", kind: "pending" },
      ]) {
        report.environment.externalTurns += 2;
        const result =
          caseDefinition.kind === "no_tool"
            ? await runParallelNoToolPair(client, workspace, caseDefinition.name, deadlineAt)
            : await runPendingApprovalIsolationPair(client, workspace, caseDefinition.name, deadlineAt);
        report.cases.push(result);
        if (result.status !== "pass") break;
      }
      return report;
    }
    const definitions = mcpTurnWarmupOnly
      ? followUpCases(workspace, auditPath)
          .filter((definition) => definition.name === "mcp_form_accept_granular")
          .map((definition) => ({ ...definition, prewarm: true }))
      : mcpTurnOnly
        ? followUpCases(workspace, auditPath).filter((definition) => definition.name === "mcp_form_accept_granular")
        : commandOnly
          ? cases(workspace, auditPath).filter((definition) => definition.name === "command_decline")
          : approvalOnly
            ? cases(workspace, auditPath).filter((definition) =>
                ["command_decline", "command_accept", "file_decline", "file_accept"].includes(definition.name),
              )
            : followUp
              ? followUpCases(workspace, auditPath)
              : cases(workspace, auditPath);
    validateDryRunDefinitions(definitions);
    for (const definition of definitions) {
      if (remainingMs(deadlineAt) <= 0) {
        report.cases.push(blocked(definition.name, definition.expectedMethod, "probe_deadline"));
        break;
      }
      report.environment.externalTurns += definition.prewarm === true ? 2 : 1;
      report.cases.push(await runCase(client, workspace, definition, deadlineAt));
    }
    return report;
  } catch (error) {
    report.cases.push(
      blocked("probe", "internal", error instanceof ProbeDeadlineError ? "probe_deadline" : "probe_failure"),
    );
    return report;
  } finally {
    const cleanupFailures = [];
    const failedProcessOwners = [];
    const clients = [...ownedClients];
    for (const [index, ownedClient] of clients.entries()) {
      try {
        const stopped = await ownedClient.stop(cleanupResourceDeadline(totalDeadlineAt, clients.length - index));
        if (!stopped.exitConfirmed) {
          cleanupFailures.push("process_exit_unconfirmed");
          failedProcessOwners.push(ownedClient.processOwner);
        } else ownedClients.delete(ownedClient);
      } catch {
        cleanupFailures.push("process_stop_failed");
        failedProcessOwners.push(ownedClient.processOwner);
      }
    }
    report.transport = transportStatusFor(transportClients);
    if (report.transport === "failed") {
      report.cases.push(blocked("probe", "app-server/stdio", "transport_failure"));
    }
    try {
      const fixtureProcessIds = await readMcpFixtureProcessIds(mcpAuditPath, totalDeadlineAt);
      for (const pid of fixtureProcessIds) {
        if (processIsAlive(pid)) cleanupFailures.push("fixture_process_exit_unconfirmed");
      }
    } catch {
      cleanupFailures.push("fixture_process_audit_failed");
    }
    const processCleanupVerified = cleanupFailures.length === 0;
    try {
      const sentinel = await withDeadline(
        readFile(join(root, "sentinel.txt"), "utf8"),
        totalDeadlineAt,
        "sentinel read",
      );
      if (sentinel !== "withmate-interaction-probe") cleanupFailures.push("sentinel_changed");
    } catch {
      cleanupFailures.push("sentinel_unreadable");
    }
    if (processCleanupVerified) {
      try {
        await deleteTempAfterVerifiedProcessCleanup(processCleanupVerified, async () => {
          assertOwnedTempPath(root, "withmate-codex-interactions-");
          await withDeadline(rm(root, { recursive: true, force: true }), totalDeadlineAt, "temp root deletion");
        });
      } catch {
        cleanupFailures.push("temp_delete_failed");
      }
      try {
        if (await pathExists(root, totalDeadlineAt)) cleanupFailures.push("temp_root_still_exists");
      } catch {
        cleanupFailures.push("temp_root_state_unconfirmed");
      }
    } else {
      cleanupFailures.push("temp_delete_skipped_unverified_process_cleanup");
    }
    report.cleanup = cleanupFailures.length === 0 ? "verified" : "failed";
    if (cleanupFailures.length > 0) report.cleanupFailures = cleanupFailures;
    const cleanupRecovery = cleanupRecoveryTargetsForOwners(failedProcessOwners);
    if (cleanupRecovery.length > 0) report.cleanupRecovery = cleanupRecovery;
    report.status = overallProbeStatus(report.cases, report.cleanup, report.transport);
  }
}

function runMcpFixture() {
  const auditArgumentIndex = process.argv.indexOf("--audit-file");
  const auditPath = auditArgumentIndex === -1 ? undefined : process.argv[auditArgumentIndex + 1];
  if (auditPath === undefined) throw new Error("MCP fixture audit path was not provided");
  const auditParent = dirname(resolve(auditPath));
  assertOwnedTempPath(auditParent, "withmate-codex-interactions-");
  if (resolve(auditPath) !== join(auditParent, "mcp-audit.log")) {
    throw new Error("MCP fixture audit path has an unexpected filename");
  }
  const audit = (event) => appendMcpAuditRecord(auditPath, event);
  audit(`fixture_process:${process.pid}`);
  let nextRequestId = 1_000;
  let pendingToolCall;
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "initialize") {
      writeMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "withmate-probe", version: "1.0.0" },
        },
      });
      audit("initialized");
      return;
    }
    if (message.method === "tools/list") {
      writeMcp({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "collect",
              description: MCP_TOOL_DESCRIPTION,
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      });
      audit("tools_list");
      return;
    }
    if (message.method === "tools/call") {
      audit("tools_call_received");
      const requestId = nextRequestId++;
      pendingToolCall = { toolCallId: message.id, requestId };
      writeMcp({
        jsonrpc: "2.0",
        id: requestId,
        method: "elicitation/create",
        params: {
          message: "Choose a probe value.",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { choice: { type: "string", title: "Choice", maxLength: 32 } },
            required: ["choice"],
          },
        },
      });
      return;
    }
    if (pendingToolCall !== undefined && message.id === pendingToolCall.requestId) {
      audit("elicitation_response_received");
      writeMcp({
        jsonrpc: "2.0",
        id: pendingToolCall.toolCallId,
        result: { content: [{ type: "text", text: "elicitation completed" }], isError: false },
      });
      audit("tool_result_sent");
      pendingToolCall = undefined;
    }
  });
}

function writeMcp(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requireSelfTest(condition, name) {
  if (!condition) throw new Error(`self-test failed: ${name}`);
}

async function eventBufferFailureSelfTest() {
  const client = Object.create(AppServerClient.prototype);
  client.nextSequence = 1;
  client.pending = new Map();
  client.waiters = [];
  client.events = [];
  client.eventBytes = 0;
  client.stdoutLineChunks = [];
  client.stdoutLineBytes = 0;
  client.deadlineAt = Date.now() + 5_000;
  client.processError = null;
  let stdoutDestroyed = false;
  client.process = { stdout: { destroy: () => (stdoutDestroyed = true) } };

  client.acceptLineBuffer(Buffer.from(JSON.stringify({ method: "turn/completed", params: {} }), "utf8"));
  const settle = (promise) =>
    promise.then(
      () => "fulfilled",
      () => "rejected",
    );
  const existingWaiter = settle(client.waitFor((message) => message.method === "never", 5_000));
  const pendingRequest = settle(
    new Promise((resolvePromise, rejectPromise) => {
      client.pending.set(99, {
        method: "self-test",
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: setTimeout(() => rejectPromise(new Error("self-test pending request timed out")), 5_000),
      });
    }),
  );

  client.acceptStdoutChunk(Buffer.alloc(MAX_APP_SERVER_LINE_BYTES + 1, 0x78));
  const bufferedMatch = settle(client.waitFor((message) => message.method === "turn/completed", 5_000));
  const futureWaiter = settle(client.waitFor((message) => message.method === "future", 5_000));
  const futureRequest = settle(client.request("self-test-after-failure", {}, 5_000));
  const results = await Promise.all([existingWaiter, pendingRequest, bufferedMatch, futureWaiter, futureRequest]);
  return (
    stdoutDestroyed &&
    client.processError instanceof Error &&
    client.pending.size === 0 &&
    client.waiters.length === 0 &&
    results.every((result) => result === "rejected")
  );
}

async function discoveryTransportFailureSelfTest() {
  const client = Object.create(AppServerClient.prototype);
  client.nextSequence = 1;
  client.pending = new Map();
  client.waiters = [];
  client.events = [];
  client.eventBytes = 0;
  client.stdoutLineChunks = [];
  client.stdoutLineBytes = 0;
  client.deadlineAt = Date.now() + 5_000;
  client.processError = null;
  let stdoutDestroyed = false;
  client.process = { stdout: { destroy: () => (stdoutDestroyed = true) } };

  const responseOutcome = new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise("timed_out"), 5_000);
    client.pending.set(7, {
      method: "config/read",
      resolve: () => resolvePromise("fulfilled"),
      reject: () => resolvePromise("rejected"),
      timer,
    });
  });
  const response = Buffer.from(JSON.stringify({ id: 7, result: { config: {} } }) + "\n", "utf8");
  client.acceptStdoutChunk(Buffer.concat([response, Buffer.alloc(MAX_APP_SERVER_LINE_BYTES + 1, 0x78)]));
  const outcome = await responseOutcome;
  const cleanupOwners = new Set([client]);
  const transportClients = new Set([client]);
  cleanupOwners.delete(client);
  return (
    outcome === "fulfilled" &&
    stdoutDestroyed &&
    cleanupOwners.size === 0 &&
    transportStatusFor(transportClients) === "failed" &&
    overallProbeStatus([{ status: "pass" }], "verified", transportStatusFor(transportClients)) === "blocked"
  );
}

function unknownNotificationSelfTest() {
  const client = Object.create(AppServerClient.prototype);
  client.nextSequence = 1;
  client.pending = new Map();
  client.waiters = [];
  client.events = [];
  client.eventBytes = 0;
  client.stdoutLineChunks = [];
  client.stdoutLineBytes = 0;
  client.deadlineAt = Date.now() + 5_000;
  client.processError = null;
  client.process = { stdout: { destroy: () => undefined } };

  client.acceptLineBuffer(
    Buffer.from(JSON.stringify({ method: "future/unknownNotification", params: { privateValue: "redacted" } }), "utf8"),
  );
  client.acceptLineBuffer(
    Buffer.from(
      JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } }),
      "utf8",
    ),
  );
  const diagnosticKinds = client.events.map((event) =>
    event.message.method === "turn/completed" ? "turn/completed" : "other",
  );
  return (
    client.processError === null &&
    client.events.length === 2 &&
    client.events[0].sequence < client.events[1].sequence &&
    exactJson(diagnosticKinds, ["other", "turn/completed"]) &&
    !JSON.stringify(diagnosticKinds).includes("privateValue")
  );
}

async function mcpAuditWriterBoundSelfTest() {
  const root = mkdtempSync(join(tmpdir(), "withmate-codex-interactions-audit-self-test-"));
  try {
    assertOwnedTempPath(root, "withmate-codex-interactions-audit-self-test-");
    const countAuditPath = join(root, "mcp-audit.log");
    for (let index = 0; index < MAX_MCP_AUDIT_EVENTS; index += 1) {
      appendMcpAuditRecord(countAuditPath, "tools_list");
    }
    let countLimitRejected = false;
    try {
      appendMcpAuditRecord(countAuditPath, "tools_list");
    } catch {
      countLimitRejected = true;
    }

    const byteRoot = mkdtempSync(join(tmpdir(), "withmate-codex-interactions-audit-self-test-"));
    try {
      assertOwnedTempPath(byteRoot, "withmate-codex-interactions-audit-self-test-");
      const byteAuditPath = join(byteRoot, "mcp-audit.log");
      appendMcpAuditRecord(byteAuditPath, "x".repeat(MAX_MCP_AUDIT_BYTES - 1));
      let byteLimitRejected = false;
      try {
        appendMcpAuditRecord(byteAuditPath, "x");
      } catch {
        byteLimitRejected = true;
      }
      return (
        countLimitRejected &&
        parseBoundedMcpAudit(readFileSync(countAuditPath, "utf8")).length === MAX_MCP_AUDIT_EVENTS &&
        byteLimitRejected &&
        statSync(byteAuditPath).size === MAX_MCP_AUDIT_BYTES
      );
    } finally {
      await rm(byteRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sanitizedFailureProjectionSelfTest() {
  const privateValue = "private-C:/sensitive-path";
  const workspace = resolve(tmpdir(), "withmate-projection-self-test");
  const toolApproval = validateMcpToolApproval({
    serverName: "withmate_probe",
    mode: "form",
    requestedSchema: { type: "object", properties: {} },
    meta: {
      codex_approval_kind: MCP_TOOL_APPROVAL_KIND,
      tool_name: "collect",
      tool_params: {},
      [privateValue]: true,
    },
  });
  const permission = permissionDiagnostics(
    {
      cwd: workspace,
      permissions: { fileSystem: { entries: [], [privateValue]: true }, [privateValue]: true },
    },
    workspace,
  );
  const command = validateInteractionRequest(
    { events: [] },
    workspace,
    { expectedCommand: "expected-command" },
    {
      message: {
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: {
          command: "different-command",
          commandActions: [{ type: privateValue, command: "different-command" }],
          cwd: workspace,
        },
      },
    },
  );
  const form = validateInteractionRequest(
    { events: [] },
    workspace,
    {},
    {
      message: {
        id: 2,
        method: "mcpServer/elicitation/request",
        params: {
          serverName: "withmate_probe",
          message: "Choose a probe value.",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { choice: EXPECTED_MCP_SCHEMA.properties.choice, [privateValue]: {} },
            required: ["choice"],
            [privateValue]: true,
          },
        },
      },
    },
  );
  const projection = {
    terminalStatus: publicTurnStatus(privateValue),
    prewarmStatus: publicTurnStatus(privateValue),
    diagnostics: [toolApproval.diagnostics, permission, command.diagnostics, form.diagnostics],
  };
  const serialized = JSON.stringify(projection);
  return (
    projection.terminalStatus === "other" &&
    projection.prewarmStatus === "other" &&
    toolApproval.diagnostics.unknownMetaKeyCount === 1 &&
    permission.unknownPermissionKeyCount === 1 &&
    permission.unknownFileSystemKeyCount === 1 &&
    form.diagnostics.unknownSchemaKeyCount === 1 &&
    form.diagnostics.unknownPropertyKeyCount === 1 &&
    !serialized.includes(privateValue) &&
    !serialized.includes("sensitive-path")
  );
}

async function linuxSetupFailureSelfTest(ownershipTestHooks, operation) {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const owner = spawnOwnedProcess(
    process.execPath,
    ["--eval", "setInterval(() => {}, 1000)"],
    { env: process.env },
    ownershipTestHooks,
  );
  let rejected = false;
  try {
    try {
      await owner.ready;
    } catch {
      rejected = true;
    }
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, `${operation} wrapper exit`);
    await waitForSystemdUnitInactiveOrAbsent(owner.unitName, deadlineAt, `${operation} unit cleanup`);
    return rejected && processHasExited(owner.child) && !activeProcessOwners.has(owner);
  } finally {
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(owner, [owner.subjectPid], deadlineAt, `${operation} final cleanup`);
    }
  }
}

async function linuxCgroupKillFallbackSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const guard = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
`;
  const owner = spawnOwnedProcess(
    process.execPath,
    ["--eval", childSource],
    { env: process.env },
    {
      writeLinuxCgroupKill() {
        throw new Error("simulated delegated cgroup kill failure");
      },
    },
  );
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("cgroup fallback fixture closed before reporting")));
  });
  let descendantPid;
  try {
    await withDeadline(Promise.all([waitForSpawn(guard), owner.ready]), deadlineAt, "cgroup fallback fixtures launch");
    descendantPid = JSON.parse(
      await withDeadline(firstLine, deadlineAt, "cgroup fallback descendant identity"),
    ).descendantPid;
    const stopped = terminateAndReleaseProcessOwner(owner);
    if (stopped.terminationError === undefined || stopped.releaseError !== undefined) return false;
    const cleanupConfirmed = await forgetOwnerAfterVerifiedCleanup(
      owner,
      [owner.supervisorPid, owner.subjectPid, descendantPid],
      deadlineAt,
      "exact systemd unit fallback cleanup confirmation",
    );
    return cleanupConfirmed && processIsAlive(guard.pid);
  } finally {
    lineReader.close();
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.supervisorPid, owner.subjectPid, descendantPid],
        deadlineAt,
        "exact systemd unit fallback final cleanup confirmation",
      );
    }
    if (!processHasExited(guard)) {
      guard.kill("SIGKILL");
      await waitForProcessExit(guard, PROCESS_FORCE_WAIT_MS, deadlineAt, "cgroup fallback guard exit");
    }
  }
}

async function posixLeaderFirstExitSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n", () => process.exit(0));
  `;
  const owner = spawnOwnedProcess(process.execPath, ["--eval", childSource], { env: process.env });
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("leader-first fixture closed before reporting")));
  });
  let descendantPid;
  try {
    await withDeadline(owner.ready, deadlineAt, "leader-first fixture launch");
    descendantPid = JSON.parse(
      await withDeadline(firstLine, deadlineAt, "leader-first descendant identity"),
    ).descendantPid;
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, "leader-first systemd unit exit");
    await boundedSleep(100, deadlineAt, "leader-first descendant exit observation");
    const stopped = terminateAndReleaseProcessOwner(owner);
    if (stopped.terminationError !== undefined || stopped.releaseError !== undefined) return false;
    return await forgetOwnerAfterVerifiedCleanup(
      owner,
      [owner.subjectPid, descendantPid],
      deadlineAt,
      "leader-first cleanup confirmation",
    );
  } finally {
    lineReader.close();
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.subjectPid, descendantPid],
        deadlineAt,
        "leader-first final cleanup confirmation",
      );
    }
  }
}

async function posixExitedSubjectNonInterferenceSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const guard = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const owner = spawnOwnedProcess(process.execPath, ["--eval", "process.exit(0)"], { env: process.env });
  try {
    await withDeadline(Promise.all([waitForSpawn(guard), owner.ready]), deadlineAt, "non-interference fixtures launch");
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, "short-lived systemd unit exit");
    if (!processHasExited(owner.child) || !processIsAlive(guard.pid)) return false;
    for (let index = 0; index < 64; index += 1) {
      const churn = spawnSync(process.execPath, ["--eval", ""], { stdio: "ignore", timeout: 1_000 });
      if (churn.error !== undefined || churn.status !== 0) return false;
    }
    const stopped = terminateAndReleaseProcessOwner(owner);
    if (stopped.terminationError !== undefined || stopped.releaseError !== undefined) return false;
    const cleanupConfirmed = await forgetOwnerAfterVerifiedCleanup(
      owner,
      [owner.subjectPid],
      deadlineAt,
      "short-lived subject cleanup confirmation",
    );
    return cleanupConfirmed && processIsAlive(guard.pid);
  } finally {
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.subjectPid],
        deadlineAt,
        "short-lived subject final cleanup confirmation",
      );
    }
    if (!processHasExited(guard)) {
      guard.kill("SIGKILL");
      await waitForProcessExit(guard, PROCESS_FORCE_WAIT_MS, deadlineAt, "non-interference guard exit");
    }
  }
}

async function linuxSupervisorFirstExitSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const guard = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
`;
  const owner = spawnOwnedProcess(
    process.execPath,
    ["--eval", childSource],
    { env: process.env },
    { terminateSupervisorAfterSpawnMs: 250 },
  );
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("supervisor-first fixture closed before reporting")));
  });
  let descendantPid;
  try {
    await withDeadline(Promise.all([waitForSpawn(guard), owner.ready]), deadlineAt, "supervisor-first fixtures launch");
    descendantPid = JSON.parse(
      await withDeadline(firstLine, deadlineAt, "supervisor-first descendant identity"),
    ).descendantPid;
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, "supervisor-first systemd unit exit");
    await boundedSleep(100, deadlineAt, "supervisor-first tree exit observation");
    const stopped = terminateAndReleaseProcessOwner(owner);
    if (stopped.terminationError !== undefined || stopped.releaseError !== undefined) return false;
    const cleanupConfirmed = await forgetOwnerAfterVerifiedCleanup(
      owner,
      [owner.supervisorPid, owner.subjectPid, descendantPid],
      deadlineAt,
      "supervisor-first cleanup confirmation",
    );
    return cleanupConfirmed && processIsAlive(guard.pid);
  } finally {
    lineReader.close();
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.supervisorPid, owner.subjectPid, descendantPid],
        deadlineAt,
        "supervisor-first final cleanup confirmation",
      );
    }
    if (!processHasExited(guard)) {
      guard.kill("SIGKILL");
      await waitForProcessExit(guard, PROCESS_FORCE_WAIT_MS, deadlineAt, "supervisor-first guard exit");
    }
  }
}

async function linuxWrapperLossSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const guard = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
`;
  const owner = spawnOwnedProcess(process.execPath, ["--eval", childSource], { env: process.env });
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("wrapper-loss fixture closed before reporting")));
  });
  let descendantPid;
  try {
    await withDeadline(Promise.all([waitForSpawn(guard), owner.ready]), deadlineAt, "wrapper-loss fixtures launch");
    descendantPid = JSON.parse(
      await withDeadline(firstLine, deadlineAt, "wrapper-loss descendant identity"),
    ).descendantPid;
    owner.child.kill("SIGKILL");
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, "systemd-run wrapper exit");
    const stopped = terminateAndReleaseProcessOwner(owner);
    if (stopped.terminationError !== undefined || stopped.releaseError !== undefined) return false;
    const cleanupConfirmed = await forgetOwnerAfterVerifiedCleanup(
      owner,
      [owner.supervisorPid, owner.subjectPid, descendantPid],
      deadlineAt,
      "wrapper-loss cleanup confirmation",
    );
    return cleanupConfirmed && processIsAlive(guard.pid);
  } finally {
    lineReader.close();
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.supervisorPid, owner.subjectPid, descendantPid],
        deadlineAt,
        "wrapper-loss final cleanup confirmation",
      );
    }
    if (!processHasExited(guard)) {
      guard.kill("SIGKILL");
      await waitForProcessExit(guard, PROCESS_FORCE_WAIT_MS, deadlineAt, "wrapper-loss guard exit");
    }
  }
}

async function linuxAppServerClientWrapperLossSelfTest() {
  if (process.platform === "win32") return true;
  const deadlineAt = Date.now() + 10_000;
  const guard = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
`;
  const owner = spawnOwnedProcess(process.execPath, ["--eval", childSource], { env: process.env });
  const client = Object.create(AppServerClient.prototype);
  client.processOwner = owner;
  client.process = owner.controller;
  client.deadlineAt = deadlineAt;
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("App Server client fixture closed before reporting")));
  });
  let descendantPid;
  try {
    await withDeadline(
      Promise.all([waitForSpawn(guard), owner.ready]),
      deadlineAt,
      "App Server client wrapper-loss fixtures launch",
    );
    descendantPid = JSON.parse(
      await withDeadline(firstLine, deadlineAt, "App Server client wrapper-loss descendant identity"),
    ).descendantPid;
    owner.child.kill("SIGKILL");
    await waitForProcessExit(owner.child, PROCESS_FORCE_WAIT_MS, deadlineAt, "App Server systemd-run wrapper exit");
    const stopped = await client.stop(deadlineAt);
    return (
      stopped.exitConfirmed &&
      !activeProcessOwners.has(owner) &&
      [owner.supervisorPid, owner.subjectPid, descendantPid].every((pid) => !processIsAlive(pid)) &&
      processIsAlive(guard.pid)
    );
  } finally {
    lineReader.close();
    if (activeProcessOwners.has(owner)) {
      terminateAndReleaseProcessOwner(owner);
      await forgetOwnerAfterVerifiedCleanup(
        owner,
        [owner.supervisorPid, owner.subjectPid, descendantPid],
        deadlineAt,
        "App Server client wrapper-loss final cleanup confirmation",
      );
    }
    if (!processHasExited(guard)) {
      guard.kill("SIGKILL");
      await waitForProcessExit(guard, PROCESS_FORCE_WAIT_MS, deadlineAt, "App Server client guard exit");
    }
  }
}

async function injectedSelfTestCleanupFailure() {
  const auditPath = process.env[SELF_TEST_CLEANUP_AUDIT_ENV];
  if (auditPath === undefined) throw new Error("cleanup failure audit path was not provided");
  const auditParent = dirname(resolve(auditPath));
  assertOwnedTempPath(auditParent, "withmate-codex-self-test-failure-");
  if (resolve(auditPath) !== join(auditParent, "owner.json")) {
    throw new Error("cleanup failure audit path has an unexpected filename");
  }
  const childSource = String.raw`
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\n");
setInterval(() => {}, 1000);
  `;
  const owner = spawnOwnedProcess(process.execPath, ["--eval", childSource], { env: process.env });
  writeFileSync(auditPath, JSON.stringify({ wrapperPid: owner.child.pid, unitName: owner.unitName }), {
    encoding: "utf8",
  });
  const lineReader = createInterface({ input: owner.child.stdout });
  const firstLine = new Promise((resolvePromise, rejectPromise) => {
    lineReader.once("line", resolvePromise);
    lineReader.once("close", () => rejectPromise(new Error("cleanup failure fixture closed before reporting")));
  });
  await owner.ready;
  const { descendantPid } = JSON.parse(await firstLine);
  lineReader.close();
  writeFileSync(
    auditPath,
    JSON.stringify({
      wrapperPid: owner.child.pid,
      supervisorPid: owner.supervisorPid,
      subjectPid: owner.subjectPid,
      descendantPid,
      unitName: owner.unitName,
    }),
    { encoding: "utf8" },
  );
  if (process.platform !== "win32") {
    owner.child.kill("SIGKILL");
    await waitForProcessExit(
      owner.child,
      PROCESS_FORCE_WAIT_MS,
      Date.now() + PROCESS_FORCE_WAIT_MS,
      "injected systemd-run wrapper loss",
    );
  }
  owner.terminate = () => {
    throw new Error("simulated owner termination failure");
  };
  owner.release = () => {
    throw new Error("simulated owner release failure");
  };
  throw new Error("simulated self-test cleanup failure");
}

async function cleanupAuditedProcessOwner(audit, deadlineAt) {
  const ownedPids = [audit.wrapperPid, audit.supervisorPid, audit.subjectPid, audit.descendantPid].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
  if (process.platform !== "win32") {
    assertOwnedSystemdUnitName(audit.unitName);
    stopOwnedSystemdUnit(audit.unitName);
    await waitForSystemdUnitInactiveOrAbsent(audit.unitName, deadlineAt, "audited systemd unit cleanup confirmation");
  }
  await waitForObservedProcessesExit(ownedPids, deadlineAt);
  return ownedPids;
}

async function cleanupFailureWatchdogSelfTest() {
  const root = mkdtempSync(join(tmpdir(), "withmate-codex-self-test-failure-"));
  const auditPath = join(root, "owner.json");
  const deadlineAt = Date.now() + 5_000;
  const startedAt = Date.now();
  const child = spawn(process.execPath, [scriptPath, "--self-test"], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      [SELF_TEST_CLEANUP_FAILURE_ENV]: "1",
      [SELF_TEST_CLEANUP_AUDIT_ENV]: auditPath,
    },
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  let audit;
  let ownedPids = [];
  try {
    await waitForSpawn(child);
    await waitForProcessExit(child, 3_000, deadlineAt, "cleanup failure self-test exit");
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
    ownedPids = [audit.wrapperPid, audit.supervisorPid, audit.subjectPid, audit.descendantPid];
    if (ownedPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) return false;
    ownedPids = await cleanupAuditedProcessOwner(audit, deadlineAt);
    return (
      processHasExited(child) &&
      child.exitCode === 124 &&
      Date.now() - startedAt <= 3_000 &&
      ownedPids.every((pid) => !processIsAlive(pid))
    );
  } finally {
    if (!processHasExited(child)) {
      child.kill("SIGKILL");
      await waitForProcessExit(child, PROCESS_FORCE_WAIT_MS, deadlineAt, "cleanup failure test process exit");
    }
    if (audit === undefined && existsSync(auditPath)) audit = JSON.parse(readFileSync(auditPath, "utf8"));
    if (audit !== undefined) {
      ownedPids = await cleanupAuditedProcessOwner(audit, deadlineAt);
      if (ownedPids.some((pid) => processIsAlive(pid))) {
        throw new Error("audited process owner cleanup was not confirmed");
      }
    }
    assertOwnedTempPath(root, "withmate-codex-self-test-failure-");
    await rm(root, { recursive: true, force: true });
  }
}

function validateCommandLineArguments(argumentsList) {
  if (argumentsList.length === 0) return;
  if (argumentsList[0] === "--mcp-fixture") {
    if (argumentsList.length === 3 && argumentsList[1] === "--audit-file" && argumentsList[2].length > 0) return;
    throw new Error("invalid MCP fixture arguments");
  }
  if (argumentsList.length !== 1 || !MODE_FLAGS.has(argumentsList[0])) {
    throw new Error("unknown or conflicting probe arguments");
  }
}

function syntheticFailClosedClient(requestEvent, threadId, turnId) {
  const calls = { responses: [], requests: [] };
  const events = [];
  const waiters = [];
  let nextSequence = requestEvent.sequence + 1;
  const emit = (message) => {
    const event = { message, sequence: nextSequence++ };
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
    return event;
  };
  const settleRejectedInteraction = (terminalStatus) => {
    if (requestEvent.message.id !== undefined) {
      emit({
        method: "serverRequest/resolved",
        params: { requestId: requestEvent.message.id, threadId },
      });
    }
    emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: terminalStatus } },
    });
  };
  return {
    calls,
    events,
    respond(id, result) {
      calls.responses.push({ id, result });
      const responseSequence = nextSequence++;
      settleRejectedInteraction("completed");
      return responseSequence;
    },
    request(method, params) {
      calls.requests.push({ method, params });
      if (method === "turn/interrupt") settleRejectedInteraction("interrupted");
      return Promise.resolve({ result: {} });
    },
    waitFor(predicate) {
      const existing = events.find((event) => predicate(event.message));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolvePromise) => {
        waiters.push({ predicate, resolve: resolvePromise });
      });
    },
  };
}

async function failClosedInteractionSelfTest(workspace) {
  const threadId = "thread-fail-closed";
  const turnId = "turn-fail-closed";
  const markerPath = join(workspace, "fail-closed-marker.txt");
  const fixtures = [
    {
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "command-item", command: "node -e unexpected", cwd: workspace },
      definition: { expectedCommand: "node -e expected" },
      events: [
        {
          sequence: 1,
          message: {
            method: "item/started",
            params: { threadId, turnId, item: { id: "command-item", type: "commandExecution" } },
          },
        },
      ],
    },
    {
      method: "item/fileChange/requestApproval",
      params: { threadId, turnId, itemId: "file-item", grantRoot: null },
      definition: { markerPath },
      events: [
        {
          sequence: 1,
          message: {
            method: "item/started",
            params: {
              threadId,
              turnId,
              item: { id: "file-item", type: "fileChange", changes: [{ path: "different.txt" }] },
            },
          },
        },
      ],
    },
    {
      method: "item/permissions/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "permission-item",
        cwd: workspace,
        permissions: { network: { enabled: true } },
      },
      definition: {},
      events: [],
    },
    {
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId,
        itemId: "user-input-item",
        questions: [
          {
            id: "probe_choice",
            header: "Probe",
            question: "Choose",
            isSecret: true,
            isOther: true,
            options: [{ label: "probe-choice" }, { label: "probe-other" }],
          },
        ],
      },
      definition: {},
      events: [],
    },
    {
      method: "mcpServer/elicitation/request",
      params: {
        threadId,
        turnId,
        serverName: "withmate_probe",
        message: "Unexpected form",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      },
      definition: {},
      events: [],
    },
  ];
  const deadlineAt = Date.now() + 5_000;

  let userInputDeclineRejected = false;
  try {
    responseFor("item/tool/requestUserInput", fixtures[3].params, "decline", workspace);
  } catch {
    userInputDeclineRejected = true;
  }
  requireSelfTest(userInputDeclineRejected, "user input decline cannot synthesize answers");

  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const requestEvent = {
      sequence: 2,
      message: { id: index + 1, method: fixture.method, params: fixture.params },
    };
    const definition = {
      name: `synthetic_invalid_${index}`,
      expectedMethod: fixture.method,
      expectedThreadId: threadId,
      expectedTurnId: turnId,
      sideEffect: "none",
      ...fixture.definition,
    };
    const validation = validateInteractionRequest({ events: fixture.events }, workspace, definition, requestEvent);
    requireSelfTest(!validation.ok, `${fixture.method} synthetic invalid payload is rejected`);

    const invalidClient = syntheticFailClosedClient(requestEvent, threadId, turnId);
    const invalidResult = await failClosedTurnInteraction(
      invalidClient,
      workspace,
      definition,
      threadId,
      turnId,
      requestEvent,
      deadlineAt,
      validation.reason,
      validation.diagnostics,
    );
    const expectedResponse =
      fixture.method === "item/tool/requestUserInput"
        ? undefined
        : responseFor(fixture.method, fixture.params, "decline", workspace);
    requireSelfTest(
      expectedResponse === undefined
        ? invalidClient.calls.responses.length === 0 &&
            invalidClient.calls.requests.length === 1 &&
            invalidClient.calls.requests[0].method === "turn/interrupt" &&
            exactJson(invalidClient.calls.requests[0].params, { threadId, turnId }) &&
            invalidResult.decision === "withheld" &&
            invalidResult.responseDisposition === "not_sent"
        : invalidClient.calls.responses.length === 1 &&
            exactJson(invalidClient.calls.responses[0].result, expectedResponse) &&
            invalidResult.decision === "decline" &&
            invalidResult.responseDisposition === "sent",
      `${fixture.method} invalid payload follows its fail-closed disposition`,
    );
    requireSelfTest(
      invalidResult.requestLifecycleStatus === "resolved" &&
        invalidResult.roundTripStatus === "terminal_observed" &&
        invalidResult.pendingCount === 0 &&
        invalidResult.sideEffect === "none" &&
        invalidResult.observedMethod === fixture.method,
      `${fixture.method} invalid payload reports observed lifecycle and effect evidence`,
    );

    const wrongKindDefinition = {
      ...definition,
      name: `synthetic_wrong_kind_${index}`,
      expectedMethod: fixtures[(index + 1) % fixtures.length].method,
    };
    const wrongKindClient = syntheticFailClosedClient(requestEvent, threadId, turnId);
    const wrongKindResult = await failClosedTurnInteraction(
      wrongKindClient,
      workspace,
      wrongKindDefinition,
      threadId,
      turnId,
      requestEvent,
      deadlineAt,
      "different_interaction_observed",
    );
    requireSelfTest(
      expectedResponse === undefined
        ? wrongKindClient.calls.responses.length === 0 &&
            wrongKindResult.decision === "withheld" &&
            wrongKindResult.responseDisposition === "not_sent"
        : wrongKindClient.calls.responses.length === 1 &&
            exactJson(wrongKindClient.calls.responses[0].result, expectedResponse) &&
            wrongKindResult.decision === "decline" &&
            wrongKindResult.responseDisposition === "sent",
      `${fixture.method} wrong-kind observation follows its fail-closed disposition`,
    );
    requireSelfTest(
      wrongKindResult.requestLifecycleStatus === "resolved" &&
        wrongKindResult.roundTripStatus === "terminal_observed" &&
        wrongKindResult.pendingCount === 0 &&
        wrongKindResult.sideEffect === "none" &&
        wrongKindResult.observedMethod === fixture.method,
      `${fixture.method} wrong-kind observation reports observed lifecycle and effect evidence`,
    );
  }
}

async function selfTestReport() {
  if (process.env[SELF_TEST_CLEANUP_FAILURE_ENV] === "1") {
    await injectedSelfTestCleanupFailure();
  }
  const workspace = resolve(tmpdir(), "withmate-codex-interactions-self-test", "workspace");
  await failClosedInteractionSelfTest(workspace);
  const selectionThreadParams = startThreadParams(workspace, "never", "read-only");
  const selectionTurnParams = turnParams(
    "thread-model-selection",
    "never",
    { type: "readOnly" },
    "Reply without using tools.",
  );
  requireSelfTest(
    selectionThreadParams.model === VALIDATION_MODEL_SELECTION.model &&
      selectionTurnParams.model === VALIDATION_MODEL_SELECTION.model &&
      selectionTurnParams.effort === VALIDATION_MODEL_SELECTION.reasoningEffort &&
      VALIDATION_MODEL_SELECTION.reasoningEffort !== "ultra",
    "every model Turn uses the requested Luna and non-ultra reasoning tuple",
  );
  const validationCatalogEntry = {
    id: VALIDATION_MODEL_SELECTION.model,
    model: VALIDATION_MODEL_SELECTION.model,
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: VALIDATION_MODEL_SELECTION.reasoningEffort },
    ],
  };
  requireSelfTest(
    (
      await inspectValidationModelPreflight(async (method, params) => {
        if (method === "modelProvider/capabilities/read") {
          return { imageGeneration: true, namespaceTools: true, webSearch: true };
        }
        if (method === "model/list") {
          return { data: params.includeHidden ? [validationCatalogEntry] : [validationCatalogEntry], nextCursor: null };
        }
        throw new Error("unexpected validation model self-test request");
      })
    )?.model.reasoningEffort === VALIDATION_MODEL_SELECTION.reasoningEffort,
    "Luna and reasoning effort must be advertised by one exact model catalog entry",
  );
  const missingEffortCatalogEntry = structuredClone(validationCatalogEntry);
  missingEffortCatalogEntry.supportedReasoningEfforts = [{ reasoningEffort: "medium" }];
  requireSelfTest(
    (await inspectValidationModelPreflight(async (method) => {
      if (method === "modelProvider/capabilities/read") {
        return { imageGeneration: true, namespaceTools: true, webSearch: true };
      }
      if (method === "model/list") return { data: [missingEffortCatalogEntry], nextCursor: null };
      throw new Error("unexpected validation model self-test request");
    })) === undefined,
    "unsupported Luna and reasoning effort tuple fails closed",
  );
  const markerPath = join(workspace, "marker.txt");
  const commandEvent = {
    sequence: 2,
    message: {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { command: "node -e malicious", cwd: workspace },
    },
  };
  const commandResult = validateInteractionRequest(
    { events: [] },
    workspace,
    { expectedCommand: "node -e expected" },
    commandEvent,
  );
  requireSelfTest(!commandResult.ok && commandResult.reason === "command_target_mismatch", "wrong command rejected");

  const fileEvent = {
    sequence: 2,
    message: {
      id: 2,
      method: "item/fileChange/requestApproval",
      params: { itemId: "file-item", grantRoot: null },
    },
  };
  const fileResult = validateInteractionRequest(
    {
      events: [
        {
          sequence: 1,
          message: {
            method: "item/started",
            params: {
              item: { id: "file-item", type: "fileChange", changes: [{ path: "different.txt" }] },
            },
          },
        },
      ],
    },
    workspace,
    { markerPath },
    fileEvent,
  );
  requireSelfTest(!fileResult.ok && fileResult.reason === "file_target_mismatch", "wrong file target rejected");

  const mcpToolApprovalEvent = {
    sequence: 3,
    message: {
      id: 3,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread",
        turnId: "turn",
        serverName: "withmate_probe",
        mode: "form",
        message: "Approve collect",
        requestedSchema: { type: "object", properties: {} },
        meta: {
          request_type: MCP_TOOL_APPROVAL_REQUEST_TYPE,
          codex_approval_kind: MCP_TOOL_APPROVAL_KIND,
          tool_name: "collect",
          tool_params: {},
          persist: ["session", "always"],
        },
      },
    },
  };
  const mcpToolApprovalResult = validateInteractionRequest(
    { events: [] },
    workspace,
    { expectedMethod: "mcpServer/elicitation/request" },
    mcpToolApprovalEvent,
  );
  requireSelfTest(mcpToolApprovalResult.ok, "MCP tool approval recognized");
  for (const persist of [undefined, "session", "always", ["session", "always"]]) {
    const supportedPersist = structuredClone(mcpToolApprovalEvent);
    if (persist === undefined) delete supportedPersist.message.params.meta.persist;
    else supportedPersist.message.params.meta.persist = persist;
    requireSelfTest(
      validateInteractionRequest(
        { events: [] },
        workspace,
        { expectedMethod: "mcpServer/elicitation/request" },
        supportedPersist,
      ).ok,
      `supported MCP tool approval persist ${JSON.stringify(persist)}`,
    );
  }
  const stableMcpMetadataAlias = structuredClone(mcpToolApprovalEvent);
  stableMcpMetadataAlias.message.params._meta = stableMcpMetadataAlias.message.params.meta;
  delete stableMcpMetadataAlias.message.params.meta;
  requireSelfTest(
    validateInteractionRequest(
      { events: [] },
      workspace,
      { expectedMethod: "mcpServer/elicitation/request" },
      stableMcpMetadataAlias,
    ).ok,
    "stable MCP tool approval metadata alias preserves the persist allowlist",
  );
  for (const persist of [
    [],
    ["future"],
    ["session", "session"],
    ["always", "session"],
    ["session", "always", "future"],
  ]) {
    const unsupportedPersist = structuredClone(mcpToolApprovalEvent);
    unsupportedPersist.message.params.meta.persist = persist;
    requireSelfTest(
      !validateInteractionRequest(
        { events: [] },
        workspace,
        { expectedMethod: "mcpServer/elicitation/request" },
        unsupportedPersist,
      ).ok,
      `unsupported MCP tool approval persist ${JSON.stringify(persist)}`,
    );
  }
  const mcpToolApprovalWithoutName = structuredClone(mcpToolApprovalEvent);
  delete mcpToolApprovalWithoutName.message.params.meta.tool_name;
  mcpToolApprovalWithoutName.message.params.meta.tool_description = MCP_TOOL_DESCRIPTION;
  requireSelfTest(
    validateInteractionRequest(
      { events: [] },
      workspace,
      { expectedMethod: "mcpServer/elicitation/request" },
      mcpToolApprovalWithoutName,
    ).ok,
    "MCP tool approval recognized by isolated server description when tool name is absent",
  );
  requireSelfTest(
    exactJson(
      responseFor(mcpToolApprovalEvent.message.method, mcpToolApprovalEvent.message.params, "accept", workspace),
      { action: "accept", content: {} },
    ),
    "MCP tool approval response does not select a persistent grant",
  );
  const wrongMcpToolApproval = structuredClone(mcpToolApprovalEvent);
  wrongMcpToolApproval.message.params.meta.tool_name = "different";
  requireSelfTest(
    !validateInteractionRequest(
      { events: [] },
      workspace,
      { expectedMethod: "mcpServer/elicitation/request" },
      wrongMcpToolApproval,
    ).ok,
    "wrong MCP tool approval rejected",
  );
  requireSelfTest(
    !validateInteractionRequest(
      { events: [] },
      workspace,
      {
        expectedMethod: "mcpServer/elicitation/request",
        expectedThreadId: "thread",
        expectedTurnId: "different-turn",
      },
      mcpToolApprovalEvent,
    ).ok,
    "wrong MCP interaction owner rejected",
  );

  const unknownMcpInteraction = structuredClone(mcpToolApprovalEvent);
  unknownMcpInteraction.message.params.meta.codex_approval_kind = "future_kind";
  const unknownMcpResult = validateInteractionRequest(
    { events: [] },
    workspace,
    { expectedMethod: "mcpServer/elicitation/request" },
    unknownMcpInteraction,
  );
  requireSelfTest(
    !unknownMcpResult.ok && unknownMcpResult.reason === "unsupported_mcp_interaction_discriminator",
    "unknown MCP discriminator rejected",
  );

  const mcpFormEvent = structuredClone(mcpToolApprovalEvent);
  delete mcpFormEvent.message.params.meta;
  mcpFormEvent.message.params.message = "Choose a probe value.";
  mcpFormEvent.message.params.requestedSchema = EXPECTED_MCP_SCHEMA;
  requireSelfTest(
    !mcpStageMatches(0, mcpFormEvent.message.params) && mcpStageMatches(1, mcpFormEvent.message.params),
    "MCP form cannot satisfy the tool approval stage",
  );
  const mcpResolvedMessage = {
    method: "serverRequest/resolved",
    params: { requestId: 3, threadId: "thread" },
  };
  const prematureMcpForm = mcpApprovalBoundaryEvent(
    [
      { sequence: 4, message: mcpFormEvent.message },
      { sequence: 5, message: mcpResolvedMessage },
    ],
    resolvedFor(3, "thread"),
    mcpFormFor("thread", "turn"),
    3,
  );
  const resolvedFirst = mcpApprovalBoundaryEvent(
    [
      { sequence: 4, message: mcpResolvedMessage },
      { sequence: 5, message: mcpFormEvent.message },
    ],
    resolvedFor(3, "thread"),
    mcpFormFor("thread", "turn"),
    3,
  );
  requireSelfTest(
    prematureMcpForm?.kind === "premature_form" &&
      prematureMcpForm.event.sequence === 4 &&
      resolvedFirst?.kind === "resolved" &&
      resolvedFirst.event.sequence === 4,
    "MCP form must follow the tool approval resolved boundary",
  );
  const formRequestMessage = { ...mcpFormEvent.message, id: 4 };
  const exactMcpRequestLifecycle = [
    { sequence: 1, message: mcpToolApprovalEvent.message },
    { sequence: 2, message: mcpResolvedMessage },
    { sequence: 3, message: formRequestMessage },
    { sequence: 4, message: { ...mcpResolvedMessage, params: { requestId: 4, threadId: "thread" } } },
  ];
  requireSelfTest(
    auditMcpRequestLifecycle(exactMcpRequestLifecycle, "thread", "turn", 4).exact,
    "exact MCP request lifecycle accepted",
  );
  const duplicateFormLifecycle = [
    ...exactMcpRequestLifecycle.slice(0, 3),
    { sequence: 4, message: formRequestMessage },
    { sequence: 5, message: { ...mcpResolvedMessage, params: { requestId: 4, threadId: "thread" } } },
  ];
  const additionalRequestLifecycle = [
    ...exactMcpRequestLifecycle,
    { sequence: 5, message: { ...formRequestMessage, id: 5 } },
  ];
  const duplicateResolvedLifecycle = [
    ...exactMcpRequestLifecycle,
    { sequence: 5, message: { ...mcpResolvedMessage, params: { requestId: 4, threadId: "thread" } } },
  ];
  const additionalOtherKindLifecycle = [
    ...exactMcpRequestLifecycle,
    {
      sequence: 5,
      message: {
        id: 5,
        method: "item/tool/requestUserInput",
        params: { threadId: "thread", turnId: "turn", questions: [] },
      },
    },
  ];
  const additionalMcpOwnerVariantLifecycle = [
    ...exactMcpRequestLifecycle,
    {
      sequence: 5,
      message: {
        ...formRequestMessage,
        id: 5,
        params: { ...formRequestMessage.params, turnId: "different-turn" },
      },
    },
  ];
  requireSelfTest(
    !auditMcpRequestLifecycle(duplicateFormLifecycle, "thread", "turn", 5).exact &&
      !auditMcpRequestLifecycle(additionalRequestLifecycle, "thread", "turn", 5).exact &&
      !auditMcpRequestLifecycle(duplicateResolvedLifecycle, "thread", "turn", 5).exact &&
      !auditMcpRequestLifecycle(additionalOtherKindLifecycle, "thread", "turn", 5).exact &&
      auditMcpRequestLifecycle(additionalMcpOwnerVariantLifecycle, "thread", "turn", 5).exact,
    "same-owner duplicate or additional request lifecycle is rejected while another Turn remains isolated",
  );

  const userInputWithOther = {
    sequence: 4,
    message: {
      id: 4,
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          {
            id: "probe_choice",
            header: "Probe",
            question: "Choose",
            isOther: true,
            options: [{ label: "probe-choice" }, { label: "probe-other" }],
          },
        ],
      },
    },
  };
  requireSelfTest(
    validateInteractionRequest(
      { events: [] },
      workspace,
      { expectedMethod: "item/tool/requestUserInput" },
      userInputWithOther,
    ).ok,
    "user input with Provider-advertised free-form other accepted",
  );
  const userInputWithoutOther = structuredClone(userInputWithOther);
  userInputWithoutOther.message.params.questions[0].isOther = false;
  requireSelfTest(
    !validateInteractionRequest(
      { events: [] },
      workspace,
      { expectedMethod: "item/tool/requestUserInput" },
      userInputWithoutOther,
    ).ok,
    "user input missing Provider-advertised free-form other rejected",
  );

  const partial = classifyRoundTrip({
    resolvedObserved: true,
    terminalStatus: "failed",
    sideEffectMatches: true,
    mcpExpected: true,
    mcpComplete: true,
    itemTerminal: true,
  });
  requireSelfTest(
    partial.status === "blocked" &&
      partial.requestLifecycleStatus === "resolved" &&
      partial.roundTripStatus === "incomplete",
    "request lifecycle is not a completed round trip",
  );
  requireSelfTest(fixtureLifecycleComplete(EXPECTED_MCP_LIFECYCLE), "complete MCP lifecycle accepted");
  requireSelfTest(
    fixtureLifecycleComplete([
      "initialized",
      "tools_list",
      "initialized",
      "tools_list",
      ...EXPECTED_MCP_LIFECYCLE.slice(2),
    ]),
    "repeated MCP connection setup before one exact call lifecycle accepted",
  );
  requireSelfTest(!fixtureLifecycleComplete(EXPECTED_MCP_LIFECYCLE.slice(0, -1)), "partial MCP lifecycle rejected");
  requireSelfTest(
    !fixtureLifecycleComplete([...EXPECTED_MCP_LIFECYCLE, "tools_list"]),
    "extra MCP fixture lifecycle event rejected",
  );
  const publicFixtureLifecycle = publicMcpFixtureLifecycle([
    "fixture_process:123",
    ...EXPECTED_MCP_LIFECYCLE,
    "private-unexpected-event",
  ]);
  requireSelfTest(
    !fixtureLifecycleComplete(publicFixtureLifecycle) &&
      publicFixtureLifecycle.at(-1) === "other" &&
      !JSON.stringify(publicFixtureLifecycle).includes("private-unexpected-event"),
    "unknown MCP fixture audit event blocks exact lifecycle without raw output",
  );
  requireSelfTest(
    classifyRoundTrip({
      resolvedObserved: true,
      terminalStatus: "completed",
      sideEffectMatches: true,
      mcpExpected: false,
      mcpComplete: true,
      itemTerminal: false,
    }).status === "blocked",
    "missing item terminal blocks completion",
  );
  const noDedicatedTerminalItems = [];
  requireSelfTest(
    requestTerminalContractSatisfied(
      noDedicatedTerminalItems,
      { method: "item/permissions/requestApproval", params: { itemId: "item" } },
      "accept",
      false,
    ) &&
      requestTerminalContractSatisfied(
        noDedicatedTerminalItems,
        { method: "item/tool/requestUserInput", params: { itemId: "item" } },
        "accept",
        false,
      ) &&
      !requestTerminalContractSatisfied(
        noDedicatedTerminalItems,
        { method: "item/commandExecution/requestApproval", params: { itemId: "item" } },
        "accept",
        false,
      ),
    "dedicated item terminal is optional only for methods without a ThreadItem variant",
  );
  requireSelfTest(
    overallProbeStatus([{ status: "pass" }], "verified") === "pass" &&
      overallProbeStatus([{ status: "blocked" }], "verified") === "blocked" &&
      overallProbeStatus([{ status: "pass" }], "failed") === "blocked" &&
      overallProbeStatus([{ status: "pass" }], "verified", "failed") === "blocked",
    "overall status includes cases, transport, and cleanup",
  );
  const overBudgetDefinitions = Array.from({ length: MAX_TURNS }, (_, index) => ({
    expectedMethod: "item/tool/requestUserInput",
    decision: "accept",
    prompt: `probe-${index}`,
    ...(index === 0 ? { prewarm: true } : {}),
  }));
  let overBudgetRejected = false;
  try {
    validateDryRunDefinitions(overBudgetDefinitions);
  } catch {
    overBudgetRejected = true;
  }
  requireSelfTest(overBudgetRejected, "prewarm turn counts against the total turn budget");
  requireSelfTest(
    !shouldAttemptGracefulStop(Date.now() + PROCESS_EXIT_GRACE_MS + PROCESS_FORCE_RESERVE_MS) &&
      shouldAttemptGracefulStop(Date.now() + PROCESS_EXIT_GRACE_MS + PROCESS_FORCE_RESERVE_MS + 5_000),
    "cleanup reserve skips graceful stop near the deadline",
  );
  const clamped = boundedTimeout(Date.now() + 1_000, 5_000, "self-test");
  requireSelfTest(clamped > 0 && clamped <= 1_000, "deadline clamps timeout");
  requireSelfTest(
    !eventBufferWouldOverflow(MAX_APP_SERVER_EVENT_COUNT - 1, 0, MAX_APP_SERVER_LINE_BYTES) &&
      eventBufferWouldOverflow(MAX_APP_SERVER_EVENT_COUNT, 0, 1) &&
      eventBufferWouldOverflow(0, 0, MAX_APP_SERVER_LINE_BYTES + 1) &&
      eventBufferWouldOverflow(1, MAX_APP_SERVER_EVENT_BYTES, 1),
    "app-server event buffer limits fail closed",
  );
  requireSelfTest(await eventBufferFailureSelfTest(), "event buffer failure is monotonic across all wait paths");
  requireSelfTest(
    await discoveryTransportFailureSelfTest(),
    "discovery transport failure remains visible after cleanup ownership release",
  );
  requireSelfTest(
    unknownNotificationSelfTest(),
    "unknown notifications remain bounded diagnostics and do not stop later events",
  );
  let oversizedMcpAuditRejected = false;
  try {
    parseBoundedMcpAudit("tools_list\n".repeat(MAX_MCP_AUDIT_EVENTS + 1));
  } catch {
    oversizedMcpAuditRejected = true;
  }
  requireSelfTest(oversizedMcpAuditRejected, "MCP fixture audit event limit fails closed");
  requireSelfTest(await mcpAuditWriterBoundSelfTest(), "MCP fixture audit writer enforces aggregate limits");
  requireSelfTest(sanitizedFailureProjectionSelfTest(), "failure diagnostics use fixed public projections");
  const publicItemSummary = publicObservedItemSummary([
    { event: "item/completed", id: "private-provider-item-id", type: "mcpToolCall", status: "completed" },
    { event: "item/completed", id: "another-private-id", type: "mcpToolCall", status: "completed" },
  ]);
  requireSelfTest(
    exactJson(publicItemSummary, [{ event: "item/completed", type: "mcpToolCall", status: "completed", count: 2 }]) &&
      !JSON.stringify(publicItemSummary).includes("private-provider-item-id") &&
      publicItemSummary.every((item) => !Object.hasOwn(item, "id")),
    "public item summary removes Provider item identifiers",
  );
  const sanitizedThreadSnapshot = publicThreadSnapshot(
    {
      status: { type: "private-thread-status", activeFlags: ["waitingOnApproval", "private-active-flag"] },
      turns: [
        {
          id: "turn",
          status: "private-turn-status",
          items: [{ id: "private-provider-item-id", type: "private-item-type", status: "private-item-status" }],
        },
      ],
    },
    "turn",
  );
  const serializedThreadSnapshot = JSON.stringify(sanitizedThreadSnapshot);
  requireSelfTest(
    sanitizedThreadSnapshot.threadStatus === "other" &&
      sanitizedThreadSnapshot.turnStatus === "other" &&
      exactJson(sanitizedThreadSnapshot.activeFlags, [
        { flag: "waitingOnApproval", count: 1 },
        { flag: "other", count: 1 },
      ]) &&
      exactJson(sanitizedThreadSnapshot.itemSummary, [{ event: "other", type: "other", status: "other", count: 1 }]) &&
      !serializedThreadSnapshot.includes("private-") &&
      !serializedThreadSnapshot.includes("private-provider-item-id"),
    "missing-terminal thread snapshot uses the public aggregation boundary",
  );

  const userInputSnapshot = {
    interactionId: "interaction-user-input",
    providerId: CODEX_PUBLIC_PROVIDER_ID,
    definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
    kind: "codex.user_input",
    answerable: true,
    display: {
      questions: [
        {
          questionId: "choice",
          header: "Choice",
          prompt: "Choose one",
          allowOther: true,
          options: [{ label: "alpha" }, { label: "beta" }],
        },
      ],
    },
  };
  const userInputResponse = {
    interactionId: userInputSnapshot.interactionId,
    kind: userInputSnapshot.kind,
    payload: { answers: { choice: ["alpha"] } },
  };
  requireSelfTest(
    isAnswerablePublicProjection(userInputSnapshot) &&
      responseMatchesCurrentSnapshot(userInputSnapshot, userInputResponse),
    "current user input option accepted",
  );
  const duplicateQuestion = structuredClone(userInputSnapshot);
  duplicateQuestion.display.questions.push(structuredClone(duplicateQuestion.display.questions[0]));
  requireSelfTest(!isAnswerablePublicProjection(duplicateQuestion), "duplicate question identifier rejected");
  const duplicateOption = structuredClone(userInputSnapshot);
  duplicateOption.display.questions[0].options[1].label = "alpha";
  requireSelfTest(!isAnswerablePublicProjection(duplicateOption), "duplicate option label rejected");
  const unknownOption = structuredClone(userInputResponse);
  unknownOption.payload.answers.choice = ["gamma"];
  requireSelfTest(responseMatchesCurrentSnapshot(userInputSnapshot, unknownOption), "allowed free-form other accepted");
  const noOtherSnapshot = structuredClone(userInputSnapshot);
  noOtherSnapshot.display.questions[0].allowOther = false;
  requireSelfTest(
    !responseMatchesCurrentSnapshot(noOtherSnapshot, unknownOption),
    "unadvertised free-form answer rejected",
  );
  const oversizedOther = structuredClone(unknownOption);
  oversizedOther.payload.answers.choice = ["x".repeat(2_049)];
  requireSelfTest(
    !responseMatchesCurrentSnapshot(userInputSnapshot, oversizedOther),
    "oversized free-form answer rejected",
  );
  const missingOtherFlag = structuredClone(userInputSnapshot);
  delete missingOtherFlag.display.questions[0].allowOther;
  requireSelfTest(!isAnswerablePublicProjection(missingOtherFlag), "missing free-form capability flag rejected");
  const repeatedAnswers = structuredClone(userInputResponse);
  repeatedAnswers.payload.answers.choice = ["alpha", "beta"];
  requireSelfTest(!responseMatchesCurrentSnapshot(userInputSnapshot, repeatedAnswers), "multiple answers rejected");
  const missingQuestionSnapshot = structuredClone(userInputSnapshot);
  missingQuestionSnapshot.display.questions.push({
    questionId: "second",
    header: "Second",
    prompt: "Choose another",
    allowOther: false,
    options: [{ label: "one" }, { label: "two" }],
  });
  requireSelfTest(
    !responseMatchesCurrentSnapshot(missingQuestionSnapshot, userInputResponse),
    "missing question answer rejected",
  );
  const wrongDefinitionSnapshot = structuredClone(userInputSnapshot);
  wrongDefinitionSnapshot.definitionVersion = "codex-app-server-unknown";
  requireSelfTest(
    !responseMatchesCurrentSnapshot(wrongDefinitionSnapshot, userInputResponse),
    "stale Provider definition snapshot rejected",
  );
  const decisionSnapshots = [
    {
      interactionId: "interaction-command",
      providerId: CODEX_PUBLIC_PROVIDER_ID,
      definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
      kind: "codex.command_approval",
      answerable: true,
      display: { summary: "Command", command: "Write-Output probe", availableDecisions: ["accept", "decline", "cancel"] },
    },
    {
      interactionId: "interaction-file",
      providerId: CODEX_PUBLIC_PROVIDER_ID,
      definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
      kind: "codex.file_change_approval",
      answerable: true,
      display: { summary: "File", changes: [{ displayPath: "marker.txt", changeKind: "add" }] },
    },
    {
      interactionId: "interaction-permission",
      providerId: CODEX_PUBLIC_PROVIDER_ID,
      definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
      kind: "codex.permission_approval",
      answerable: true,
      display: { summary: "Permission", permissions: ["workspace_write"] },
    },
    {
      interactionId: "interaction-mcp-tool",
      providerId: CODEX_PUBLIC_PROVIDER_ID,
      definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
      kind: "codex.mcp_tool_approval",
      answerable: true,
      display: { server: "withmate_probe", tool: "collect", summary: "Collect one value" },
    },
  ];
  for (const decisionSnapshot of decisionSnapshots) {
    const validDecision = {
      interactionId: decisionSnapshot.interactionId,
      kind: decisionSnapshot.kind,
      payload: {
        decision:
          decisionSnapshot.kind === "codex.command_approval"
            ? decisionSnapshot.display.availableDecisions[0]
            : "accept",
      },
    };
    requireSelfTest(
      responseMatchesCurrentSnapshot(decisionSnapshot, validDecision),
      `${decisionSnapshot.kind} accepts a closed decision payload`,
    );
    const invalidDecision = structuredClone(validDecision);
    invalidDecision.payload.decision = "bogus";
    requireSelfTest(
      !responseMatchesCurrentSnapshot(decisionSnapshot, invalidDecision),
      `${decisionSnapshot.kind} rejects an unknown decision`,
    );
    const unknownPayload = structuredClone(validDecision);
    unknownPayload.payload.extra = true;
    requireSelfTest(
      !responseMatchesCurrentSnapshot(decisionSnapshot, unknownPayload),
      `${decisionSnapshot.kind} rejects an unknown payload property`,
    );
    const unknownResponse = structuredClone(validDecision);
    unknownResponse.extra = true;
    requireSelfTest(
      !responseMatchesCurrentSnapshot(decisionSnapshot, unknownResponse),
      `${decisionSnapshot.kind} rejects an unknown response property`,
    );
  }
  const commandSubsetSnapshot = {
    interactionId: "interaction-command-subset",
    providerId: CODEX_PUBLIC_PROVIDER_ID,
    definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
    kind: "codex.command_approval",
    answerable: true,
    display: { summary: "Command", command: "Write-Output probe", availableDecisions: ["decline", "cancel"] },
  };
  const commandSubsetDecision = {
    interactionId: commandSubsetSnapshot.interactionId,
    kind: commandSubsetSnapshot.kind,
    payload: { decision: "cancel" },
  };
  requireSelfTest(
    responseMatchesCurrentSnapshot(commandSubsetSnapshot, commandSubsetDecision),
    "command approval accepts request-scoped decision",
  );
  const commandSubsetRejectedDecision = {
    ...commandSubsetDecision,
    payload: { decision: "accept" },
  };
  requireSelfTest(
    !responseMatchesCurrentSnapshot(commandSubsetSnapshot, commandSubsetRejectedDecision),
    "command approval rejects decision not advertised by request",
  );
  const commandSubsetMissingDecisionSet = structuredClone(commandSubsetSnapshot);
  delete commandSubsetMissingDecisionSet.display.availableDecisions;
  const commandSubsetMissingDecisionSetResponse = {
    interactionId: commandSubsetMissingDecisionSet.interactionId,
    kind: commandSubsetMissingDecisionSet.kind,
    payload: { decision: "cancel" },
  };
  requireSelfTest(
    !responseMatchesCurrentSnapshot(commandSubsetMissingDecisionSet, commandSubsetMissingDecisionSetResponse),
    "command approval rejects missing availableDecisions",
  );

  const optionalFormSnapshot = {
    interactionId: "interaction-form",
    providerId: CODEX_PUBLIC_PROVIDER_ID,
    definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
    kind: "codex.mcp_server_form",
    answerable: true,
    display: {
      server: "withmate_probe",
      message: "Optional value",
      fields: [{ fieldId: "choice", label: "Choice", inputType: "string", required: false, maxLength: 8 }],
    },
  };
  const emptyFormAccept = {
    interactionId: optionalFormSnapshot.interactionId,
    kind: optionalFormSnapshot.kind,
    payload: { action: "accept", values: {} },
  };
  requireSelfTest(
    isAnswerablePublicProjection(optionalFormSnapshot) &&
      responseMatchesCurrentSnapshot(optionalFormSnapshot, emptyFormAccept),
    "optional-only form accepts empty values",
  );
  const requiredFormSnapshot = structuredClone(optionalFormSnapshot);
  requiredFormSnapshot.display.fields[0].required = true;
  requireSelfTest(
    !responseMatchesCurrentSnapshot(requiredFormSnapshot, emptyFormAccept),
    "required form field cannot be omitted",
  );
  for (const prototypeFieldId of ["toString", "constructor", "__proto__"]) {
    const prototypeFieldSnapshot = structuredClone(requiredFormSnapshot);
    prototypeFieldSnapshot.display.fields[0].fieldId = prototypeFieldId;
    requireSelfTest(
      !responseMatchesCurrentSnapshot(prototypeFieldSnapshot, emptyFormAccept),
      `required prototype field ${prototypeFieldId} cannot be omitted`,
    );
  }
  const duplicateFieldSnapshot = structuredClone(optionalFormSnapshot);
  duplicateFieldSnapshot.display.fields.push(structuredClone(duplicateFieldSnapshot.display.fields[0]));
  requireSelfTest(!isAnswerablePublicProjection(duplicateFieldSnapshot), "duplicate form field identifier rejected");
  const unknownFormField = structuredClone(emptyFormAccept);
  unknownFormField.payload.values.other = "value";
  requireSelfTest(
    !responseMatchesCurrentSnapshot(optionalFormSnapshot, unknownFormField),
    "snapshot-external form field rejected",
  );
  const oversizedFormValue = structuredClone(emptyFormAccept);
  oversizedFormValue.payload.values.choice = "123456789";
  requireSelfTest(
    !responseMatchesCurrentSnapshot(optionalFormSnapshot, oversizedFormValue),
    "snapshot-specific form limit enforced",
  );
  const unicodeFormSnapshot = structuredClone(optionalFormSnapshot);
  unicodeFormSnapshot.display.fields[0].maxLength = 1;
  const unicodeFormValue = structuredClone(emptyFormAccept);
  unicodeFormValue.payload.values.choice = "😀";
  requireSelfTest(
    responseMatchesCurrentSnapshot(unicodeFormSnapshot, unicodeFormValue),
    "form limit counts Unicode code points",
  );
  unicodeFormValue.payload.values.choice = "😀😀";
  requireSelfTest(
    !responseMatchesCurrentSnapshot(unicodeFormSnapshot, unicodeFormValue),
    "form Unicode code point limit rejects one over",
  );
  const formDecline = {
    interactionId: optionalFormSnapshot.interactionId,
    kind: optionalFormSnapshot.kind,
    payload: { action: "decline" },
  };
  requireSelfTest(
    responseMatchesCurrentSnapshot(optionalFormSnapshot, formDecline) &&
      exactJson(mcpFormProviderResponse(optionalFormSnapshot, formDecline), {
        action: "decline",
        content: null,
      }),
    "MCP form decline maps without values",
  );
  const declineWithValues = structuredClone(formDecline);
  declineWithValues.payload.values = {};
  requireSelfTest(
    !responseMatchesCurrentSnapshot(optionalFormSnapshot, declineWithValues),
    "MCP form decline rejects values",
  );
  requireSelfTest(
    exactJson(mcpFormProviderResponse(optionalFormSnapshot, emptyFormAccept), {
      action: "accept",
      content: {},
    }),
    "MCP form accept maps values to Provider content",
  );

  const commandProjection = {
    interactionId: "interaction-command-limit",
    providerId: CODEX_PUBLIC_PROVIDER_ID,
    definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
    kind: "codex.command_approval",
    answerable: true,
    display: { summary: "Command", command: "x".repeat(2_049), availableDecisions: ["accept", "decline", "cancel"] },
  };
  const commandProjectionWithoutDecisions = structuredClone(commandProjection);
  delete commandProjectionWithoutDecisions.display.availableDecisions;
  requireSelfTest(
    !isAnswerablePublicProjection(commandProjectionWithoutDecisions),
    "command snapshot without availableDecisions rejected",
  );
  requireSelfTest(!isAnswerablePublicProjection(commandProjection), "oversized command projection rejected");
  commandProjection.display.command = "😀".repeat(2_048);
  requireSelfTest(isAnswerablePublicProjection(commandProjection), "snapshot limit counts Unicode code points");
  commandProjection.display.command += "😀";
  requireSelfTest(
    !isAnswerablePublicProjection(commandProjection),
    "snapshot Unicode code point limit rejects one over",
  );
  const fileProjection = {
    interactionId: "interaction-file-limit",
    providerId: CODEX_PUBLIC_PROVIDER_ID,
    definitionVersion: CODEX_INTERACTION_DEFINITION_VERSION,
    kind: "codex.file_change_approval",
    answerable: true,
    display: {
      summary: "Changes",
      changes: Array.from({ length: 257 }, (_, index) => ({
        displayPath: `file-${index}.txt`,
        changeKind: "update",
      })),
    },
  };
  requireSelfTest(!isAnswerablePublicProjection(fileProjection), "257th file change projection rejected");
  fileProjection.display.changes = [{ displayPath: "x".repeat(513), changeKind: "update" }];
  requireSelfTest(!isAnswerablePublicProjection(fileProjection), "oversized path projection rejected");
  fileProjection.display.changes = [{ displayPath: "src/file.ts", changeKind: "update" }];
  requireSelfTest(isAnswerablePublicProjection(fileProjection), "safe workspace-relative path projection accepted");
  for (const displayPath of [
    "/private/file.ts",
    "C:/private/file.ts",
    "../private/file.ts",
    "src\\file.ts",
    "src//file.ts",
    "src/\0file.ts",
    "src/\nfile.ts",
    "src/\u0085file.ts",
    "src/\u009b31mfile.ts",
    "src/\u202efile.ts",
  ]) {
    fileProjection.display.changes = [{ displayPath, changeKind: "update" }];
    requireSelfTest(!isAnswerablePublicProjection(fileProjection), `unsafe file display path ${displayPath} rejected`);
  }
  fileProjection.display.changes = [{ displayPath: "src/file.ts", changeKind: "unknown" }];
  requireSelfTest(!isAnswerablePublicProjection(fileProjection), "unknown file change kind is unavailable");
  const oversizedFormProjection = structuredClone(optionalFormSnapshot);
  oversizedFormProjection.display.message = "x".repeat(2_049);
  requireSelfTest(!isAnswerablePublicProjection(oversizedFormProjection), "oversized form projection rejected");
  oversizedFormProjection.display.message = "Optional value";
  oversizedFormProjection.display.fields[0].maxLength = 4_097;
  requireSelfTest(!isAnswerablePublicProjection(oversizedFormProjection), "oversized form field limit rejected");

  let unknownArgumentRejected = false;
  try {
    validateCommandLineArguments(["--follow-up-dry-run"]);
  } catch {
    unknownArgumentRejected = true;
  }
  requireSelfTest(unknownArgumentRejected, "unknown CLI argument rejected");
  for (const advancedFlag of [
    "--duplicate-after-resolved-live",
    "--disconnect-live",
    "--disconnect-resolved-live",
    "--parallel-batch-live",
    "--phase-live",
    "--permission-live",
    "--race-interrupt-first-live",
    "--race-live",
    "--multi-run-live",
    "--user-input-live",
  ]) {
    validateCommandLineArguments([advancedFlag]);
  }
  const advancedOwnerEvents = [
    {
      sequence: 1,
      message: {
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a", turnId: "turn-a" },
      },
    },
    {
      sequence: 2,
      message: {
        method: "serverRequest/resolved",
        params: { threadId: "thread-a", requestId: 1 },
      },
    },
    {
      sequence: 3,
      message: {
        method: "turn/completed",
        params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } },
      },
    },
  ];
  const advancedOwnerCounts = ownerEventCounts({ events: advancedOwnerEvents }, "thread-a", "turn-a");
  requireSelfTest(
    advancedOwnerCounts.interactions === 1 && advancedOwnerCounts.resolved === 1 && advancedOwnerCounts.terminals === 1,
    "advanced owner event counts remain correlated",
  );
  requireSelfTest(
    terminalFor("thread-a", "turn-a")(advancedOwnerEvents[2].message) &&
      !terminalFor("thread-b", "turn-a")(advancedOwnerEvents[2].message) &&
      !terminalFor("thread-a", "turn-b")(advancedOwnerEvents[2].message) &&
      !terminalFor(
        "thread-a",
        "turn-a",
      )({
        method: "turn/completed",
        params: { turn: { id: "turn-a", status: "completed" } },
      }),
    "Turn terminal requires the exact Thread and Turn owner tuple",
  );
  requireSelfTest(
    !hasCrossOwnerEvent(
      advancedOwnerEvents,
      [
        { threadId: "thread-a", turnId: "turn-a" },
        { threadId: "thread-b", turnId: "turn-b" },
      ],
      0,
    ) &&
      hasCrossOwnerEvent(
        [
          ...advancedOwnerEvents,
          {
            sequence: 4,
            message: {
              method: "item/completed",
              params: { threadId: "thread-a", turnId: "turn-b" },
            },
          },
        ],
        [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-b", turnId: "turn-b" },
        ],
        0,
      ),
    "advanced cross-owner events fail closed",
  );
  requireSelfTest(
    hasCrossOwnerEvent(
      [
        ...advancedOwnerEvents,
        {
          sequence: 4,
          message: {
            method: "turn/completed",
            params: { threadId: "unknown-thread", turn: { id: "turn-a", status: "completed" } },
          },
        },
      ],
      [
        { threadId: "thread-a", turnId: "turn-a" },
        { threadId: "thread-b", turnId: "turn-b" },
      ],
      0,
    ) &&
      hasCrossOwnerEvent(
        [
          ...advancedOwnerEvents,
          {
            sequence: 4,
            message: { method: "turn/completed", params: { turn: { id: "turn-a", status: "completed" } } },
          },
        ],
        [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-b", turnId: "turn-b" },
        ],
        0,
      ),
    "unknown or missing Thread owner fails closed",
  );
  const concurrencyOwners = [
    { threadId: "thread-a", turnId: "turn-a" },
    { threadId: "thread-b", turnId: "turn-b" },
  ];
  const turnLifecycleEvent = (sequence, method, threadId, turnId) => ({
    sequence,
    message: {
      method,
      params: { threadId, turn: { id: turnId, status: method === "turn/completed" ? "completed" : "inProgress" } },
    },
  });
  const overlappingConcurrency = activeTurnConcurrencyEvidence(
    [
      turnLifecycleEvent(1, "turn/started", "thread-a", "turn-a"),
      turnLifecycleEvent(2, "turn/started", "thread-b", "turn-b"),
      turnLifecycleEvent(3, "turn/completed", "thread-a", "turn-a"),
      turnLifecycleEvent(4, "turn/completed", "thread-b", "turn-b"),
    ],
    concurrencyOwners,
    0,
  );
  const serialConcurrency = activeTurnConcurrencyEvidence(
    [
      turnLifecycleEvent(1, "turn/started", "thread-a", "turn-a"),
      turnLifecycleEvent(2, "turn/completed", "thread-a", "turn-a"),
      turnLifecycleEvent(3, "turn/started", "thread-b", "turn-b"),
      turnLifecycleEvent(4, "turn/completed", "thread-b", "turn-b"),
    ],
    concurrencyOwners,
    0,
  );
  requireSelfTest(
    overlappingConcurrency.maximumActive === 2 &&
      overlappingConcurrency.invalidCount === 0 &&
      overlappingConcurrency.finalActive === 0 &&
      serialConcurrency.maximumActive === 1,
    "parallel lower bound is derived from overlapping exact owner lifecycles",
  );
  const itemOwnerRequest = {
    sequence: 2,
    message: {
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a" },
    },
  };
  const itemOwnerClient = {
    events: [
      {
        sequence: 1,
        message: {
          method: "item/started",
          params: { threadId: "thread-a", turnId: "turn-a", item: { id: "item-a" } },
        },
      },
    ],
  };
  requireSelfTest(
    requestItemBelongsToOwner(itemOwnerClient, itemOwnerRequest, "thread-a", "turn-a") &&
      !requestItemBelongsToOwner(itemOwnerClient, itemOwnerRequest, "thread-a", "turn-b"),
    "advanced item owner tuple remains exact",
  );
  const deferredItemLifecycleRequest = {
    sequence: 1,
    message: {
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-input" },
    },
  };
  const missingItemIdRequest = structuredClone(deferredItemLifecycleRequest);
  delete missingItemIdRequest.message.params.itemId;
  requireSelfTest(
    requestItemBelongsToOwner({ events: [] }, deferredItemLifecycleRequest, "thread-a", "turn-a") &&
      !requestItemBelongsToOwner({ events: [] }, missingItemIdRequest, "thread-a", "turn-a"),
    "advanced deferred item lifecycle still requires the protocol item identifier",
  );
  const mcpItemOwnerRequest = {
    sequence: 1,
    message: {
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-a", turnId: "turn-a", mode: "form" },
    },
  };
  requireSelfTest(
    interactionBelongsToOwner(mcpItemOwnerRequest.message, "thread-a", "turn-a") &&
      !interactionBelongsToOwner(mcpItemOwnerRequest.message, "thread-a", "turn-b") &&
      requestItemBelongsToOwner({ events: [] }, mcpItemOwnerRequest, "thread-a", "turn-a") &&
      !requestItemBelongsToOwner({ events: [] }, mcpItemOwnerRequest, "thread-a", "turn-b"),
    "MCP request is bound through its exact Thread and Turn without inventing an item identifier",
  );
  const multiRunEvents = [
    itemOwnerRequest,
    {
      sequence: 3,
      message: {
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-other" },
      },
    },
  ];
  const multiRunAudit = multiRunInteractionAudit(
    multiRunEvents,
    [
      { threadId: "thread-a", turnId: "turn-a", itemId: "item-a" },
      { threadId: "thread-b", turnId: "turn-b" },
    ],
    0,
  );
  requireSelfTest(
    multiRunAudit.exactCounts[0] === 1 && multiRunAudit.exactCounts[1] === 0 && multiRunAudit.unexpectedCount === 1,
    "advanced multi-run interaction audit rejects wrong items",
  );
  const cleanMultiRunAudit = { exactCounts: [1, 0], unexpectedCount: 0 };
  requireSelfTest(
    parallelNoToolObservationPassed(
      ["completed", "completed"],
      [1, 1],
      false,
      { exactCounts: [0, 0], unexpectedCount: 0 },
      overlappingConcurrency,
    ) &&
      !parallelNoToolObservationPassed(
        ["completed", "completed"],
        [2, 1],
        false,
        { exactCounts: [0, 0], unexpectedCount: 0 },
        overlappingConcurrency,
      ) &&
      !parallelNoToolObservationPassed(
        ["completed", "completed"],
        [1, 1],
        false,
        { exactCounts: [0, 0], unexpectedCount: 0 },
        serialConcurrency,
      ) &&
      pendingIsolationObservationPassed({
        rawTerminalStatuses: ["completed", "completed"],
        resolvedObserved: true,
        resolvedBeforeResponse: false,
        crossOwnerEvent: false,
        sideEffect: "none",
        terminalCounts: [1, 1],
        interactionAudit: cleanMultiRunAudit,
        itemTerminalCount: 1,
        resolvedCounts: { exact: 1, wrongOwner: 0 },
      }) &&
      !pendingIsolationObservationPassed({
        rawTerminalStatuses: ["completed", "completed"],
        resolvedObserved: true,
        resolvedBeforeResponse: false,
        crossOwnerEvent: false,
        sideEffect: "none",
        terminalCounts: [2, 1],
        interactionAudit: cleanMultiRunAudit,
        itemTerminalCount: 1,
        resolvedCounts: { exact: 1, wrongOwner: 0 },
      }),
    "advanced multi-run result integrity requires exact terminal counts",
  );
  const completeRaceCounts = { interactions: 1, resolved: 1, terminals: 1 };
  requireSelfTest(
    raceObservationPassed("interrupted", "accepted", completeRaceCounts, "none") &&
      raceObservationPassed("completed", "rpc_rejected", completeRaceCounts, "workspace_only") &&
      !raceObservationPassed("future_status", "accepted", completeRaceCounts, "none") &&
      !raceObservationPassed("interrupted", "request_failed", completeRaceCounts, "none"),
    "race observation rejects request failures and unknown terminal states",
  );
  requireSelfTest(
    raceEffectCertainty("none", false, true) === "ambiguous" &&
      raceEffectCertainty("none", true, true) === "known_none" &&
      raceEffectCertainty("workspace_only", false, false) === "known_applied",
    "race effect certainty requires resolved and terminal evidence for known-none",
  );
  const cleanupDeadline = Date.now() + 20_000;
  requireSelfTest(
    cleanupResourceDeadline(cleanupDeadline, 2) <= cleanupDeadline - CLEANUP_FILESYSTEM_RESERVE_MS,
    "aggregate cleanup budget preserves filesystem reserve",
  );
  const validRecoveryUnit = "withmate-probe-0123456789abcdef0123456789abcdef.service";
  const privateRecoveryValue = "../../private-owner-token";
  const cleanupRecoveryProjection = cleanupRecoveryTargetsForOwners([
    { unitName: validRecoveryUnit },
    { unitName: privateRecoveryValue },
    { unitName: validRecoveryUnit },
    {},
  ]);
  requireSelfTest(
    cleanupRecoveryProjection.length === 1 &&
      cleanupRecoveryProjection[0]?.kind === "systemd_user_unit" &&
      cleanupRecoveryProjection[0]?.unitName === validRecoveryUnit &&
      !JSON.stringify(cleanupRecoveryProjection).includes(privateRecoveryValue),
    "cleanup recovery projection exposes only exact owned systemd units",
  );
  const processOwnerContract = await processOwnerContractSelfTest();
  requireSelfTest(processOwnerContract.normalCleanup, "owned process tree exits without PID-based termination");
  requireSelfTest(
    processOwnerContract.controllerFirstCleanup,
    "controller-first exit preserves process tree ownership until verified cleanup",
  );
  requireSelfTest(processOwnerContract.cleanupFailureUnverified, "cleanup failure is not reported as verified");
  const tempDeletionOrder = [];
  const skippedTempDeletion = await deleteTempAfterVerifiedProcessCleanup(false, async () => {
    tempDeletionOrder.push("deleted-before-cleanup");
  });
  tempDeletionOrder.push("cleanup-verified");
  const completedTempDeletion = await deleteTempAfterVerifiedProcessCleanup(true, async () => {
    tempDeletionOrder.push("temp-deleted");
  });
  requireSelfTest(
    !skippedTempDeletion && completedTempDeletion && exactJson(tempDeletionOrder, ["cleanup-verified", "temp-deleted"]),
    "temp deletion occurs only after verified process cleanup",
  );
  const linuxCgroupOpenFailureRecovered = await linuxSetupFailureSelfTest(
    {
      openLinuxCgroupKill() {
        throw new Error("simulated delegated cgroup open failure");
      },
    },
    "delegated cgroup open failure",
  );
  const linuxBeforeLaunchFailureRecovered = await linuxSetupFailureSelfTest(
    { failLinuxBeforeLaunch: true },
    "post-cgroup pre-launch failure",
  );
  const linuxCgroupKillFallbackRecovered = await linuxCgroupKillFallbackSelfTest();
  const posixLeaderFirstDescendantRecovered = await posixLeaderFirstExitSelfTest();
  const posixExitedSubjectNonInterference = await posixExitedSubjectNonInterferenceSelfTest();
  const linuxSupervisorFirstTreeRecovered = await linuxSupervisorFirstExitSelfTest();
  const linuxWrapperLossTreeRecovered = await linuxWrapperLossSelfTest();
  const linuxAppServerClientWrapperLossRecovered = await linuxAppServerClientWrapperLossSelfTest();
  const cleanupFailureDeadlineEnforced = await cleanupFailureWatchdogSelfTest();
  requireSelfTest(processOwnerContract.assignmentFailure, "Windows assignment failure recovers the supervisor");
  requireSelfTest(linuxCgroupOpenFailureRecovered, "Linux cgroup open failure recovers the systemd unit");
  requireSelfTest(linuxBeforeLaunchFailureRecovered, "Linux pre-launch failure recovers the delegated cgroup");
  requireSelfTest(linuxCgroupKillFallbackRecovered, "Linux cgroup kill failure uses the exact systemd unit fallback");
  requireSelfTest(posixLeaderFirstDescendantRecovered, "Linux subject-first exit recovers descendants");
  requireSelfTest(posixExitedSubjectNonInterference, "Linux exited subject cannot retarget its cgroup owner");
  requireSelfTest(linuxSupervisorFirstTreeRecovered, "Linux supervisor-first exit recovers its process tree");
  requireSelfTest(linuxWrapperLossTreeRecovered, "Linux wrapper loss preserves exact cgroup cleanup");
  requireSelfTest(
    linuxAppServerClientWrapperLossRecovered,
    "Linux App Server client wrapper loss preserves verified cleanup",
  );
  requireSelfTest(cleanupFailureDeadlineEnforced, "cleanup failure remains bounded by the self-test watchdog");

  return {
    mode: "self_test",
    status: "pass",
    externalTurns: 0,
    cases: [
      "luna_non_ultra_tuple_explicit",
      "luna_catalog_tuple_exactness",
      "unsupported_luna_effort_tuple_rejected",
      "interaction_wrong_kind_fail_closed_matrix",
      "interaction_invalid_payload_fail_closed_matrix",
      "secret_user_input_response_withheld",
      "wrong_command_rejected",
      "wrong_file_target_rejected",
      "mcp_tool_approval_recognized",
      "mcp_tool_persist_allowlist_exactness",
      "mcp_tool_approval_without_name_recognized",
      "wrong_mcp_tool_approval_rejected",
      "wrong_mcp_interaction_owner_rejected",
      "unknown_mcp_discriminator_rejected",
      "mcp_form_cannot_satisfy_tool_approval",
      "mcp_form_before_resolved_rejected",
      "mcp_request_lifecycle_exactness",
      "mcp_request_owner_scope_exactness",
      "user_input_provider_other_accepted",
      "user_input_provider_other_required",
      "mcp_tool_approval_no_persistent_grant",
      "failed_turn_blocked",
      "missing_item_terminal_blocked",
      "dedicated_item_terminal_method_contract",
      "mcp_lifecycle_exactness",
      "mcp_repeated_connection_setup_accepted",
      "mcp_unknown_audit_event_blocked",
      "overall_status_includes_cleanup",
      "prewarm_turn_budget_counted",
      "cleanup_reserve_preserved",
      "deadline_clamped",
      "event_buffer_bounded",
      "event_buffer_failure_monotonic",
      "discovery_transport_failure_persisted",
      "unknown_notification_fail_open_sanitized",
      "mcp_fixture_audit_bounded",
      "mcp_fixture_audit_writer_aggregate_bounded",
      "failure_diagnostics_sanitized",
      "public_item_identifiers_redacted",
      "missing_terminal_projection_sanitized",
      "user_input_snapshot_exactness",
      "user_input_other_capability_exactness",
      "user_input_other_length_bound",
      "simple_decision_response_exactness",
      "provider_definition_snapshot_exactness",
      "mcp_form_snapshot_exactness",
      "mcp_form_action_mapping",
      "oversized_projection_fail_closed",
      "unsafe_file_projection_unavailable",
      "unknown_cli_argument_rejected",
      "advanced_cli_modes_recognized",
      "advanced_owner_event_counts_correlated",
      "advanced_cross_owner_event_rejected",
      "turn_terminal_owner_tuple_exactness",
      "unknown_or_missing_terminal_owner_rejected",
      "parallel_active_interval_lower_bound",
      "advanced_item_owner_tuple_exactness",
      "advanced_deferred_item_owner_tuple_exactness",
      "mcp_item_owner_tuple_exactness",
      "advanced_multi_run_interaction_audit",
      "advanced_multi_run_result_integrity",
      "race_result_integrity",
      "race_effect_certainty",
      "aggregate_cleanup_budgeted",
      "cleanup_recovery_projection_sanitized",
      "owned_process_tree_recovered",
      "controller_first_process_tree_recovered",
      "temp_delete_after_process_cleanup",
      "cleanup_failure_deadline_enforced",
      ...(process.platform === "win32"
        ? ["windows_assignment_failure_recovered"]
        : [
            "linux_subject_first_descendant_recovered",
            "linux_exited_subject_non_interference",
            "linux_supervisor_first_tree_recovered",
            "linux_wrapper_loss_tree_recovered",
            "linux_app_server_client_wrapper_loss_recovered",
            "linux_cgroup_open_failure_recovered",
            "linux_before_launch_failure_recovered",
            "linux_cgroup_kill_fallback_recovered",
          ]),
    ],
    platformCases: {
      windowsAssignmentFailure: process.platform === "win32" ? "pass" : "not_run",
      linuxSubjectFirstDescendant: process.platform === "win32" ? "not_run" : "pass",
      linuxExitedSubjectNonInterference: process.platform === "win32" ? "not_run" : "pass",
      linuxSupervisorFirstTree: process.platform === "win32" ? "not_run" : "pass",
      linuxWrapperLossTree: process.platform === "win32" ? "not_run" : "pass",
      linuxAppServerClientWrapperLoss: process.platform === "win32" ? "not_run" : "pass",
      linuxCgroupOpenFailure: process.platform === "win32" ? "not_run" : "pass",
      linuxBeforeLaunchFailure: process.platform === "win32" ? "not_run" : "pass",
      linuxCgroupKillFallback: process.platform === "win32" ? "not_run" : "pass",
    },
  };
}

async function writeLiveReport(...argumentsList) {
  const hardDeadline = setTimeout(() => {
    const cleanupRecovery = cleanupRecoveryTargetsForOwners(activeProcessOwners);
    emergencyStopOwnedProcesses();
    const failure = { status: "failed", error: { kind: "total_deadline" } };
    if (cleanupRecovery.length > 0) failure.cleanupRecovery = cleanupRecovery;
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exit(124);
  }, MAX_TOTAL_MS);
  try {
    const report = await liveReport(...argumentsList);
    if (report.status !== "pass") emergencyStopOwnedProcesses();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } finally {
    if (activeProcessOwners.size === 0) clearTimeout(hardDeadline);
  }
}

async function main() {
  validateCommandLineArguments(process.argv.slice(2));
  if (process.argv.includes("--mcp-fixture")) {
    runMcpFixture();
    return;
  }
  if (process.argv.includes("--follow-up-preflight")) {
    await writeLiveReport(true, true);
    return;
  }
  if (process.argv.includes("--self-test")) {
    const selfTestDeadlineMs = process.env[SELF_TEST_CLEANUP_FAILURE_ENV] === "1" ? 1_000 : 20_000;
    const selfTestDeadline = setTimeout(() => {
      emergencyStopOwnedProcesses();
      process.stderr.write(`${JSON.stringify({ status: "failed", error: { kind: "self_test_deadline" } })}\n`);
      process.exit(124);
    }, selfTestDeadlineMs);
    try {
      process.stdout.write(`${JSON.stringify(await selfTestReport(), null, 2)}\n`);
    } finally {
      if (activeProcessOwners.size === 0) clearTimeout(selfTestDeadline);
    }
    return;
  }
  if (process.argv.includes("--mcp-direct")) {
    await writeLiveReport(true, false, true);
    return;
  }
  if (process.argv.includes("--disconnect-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "disconnect_live");
    return;
  }
  if (process.argv.includes("--disconnect-resolved-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "disconnect_resolved_live");
    return;
  }
  if (process.argv.includes("--race-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "race_live");
    return;
  }
  if (process.argv.includes("--race-interrupt-first-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "race_interrupt_first_live");
    return;
  }
  if (process.argv.includes("--duplicate-after-resolved-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "duplicate_after_resolved_live");
    return;
  }
  if (process.argv.includes("--parallel-batch-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "parallel_batch_live");
    return;
  }
  if (process.argv.includes("--phase-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "phase_live");
    return;
  }
  if (process.argv.includes("--multi-run-live")) {
    await writeLiveReport(false, false, false, false, false, false, false, "multi_run_live");
    return;
  }
  if (process.argv.includes("--permission-live")) {
    await writeLiveReport(true, false, false, false, false, false, false, "permission_live");
    return;
  }
  if (process.argv.includes("--user-input-live")) {
    await writeLiveReport(true, false, false, false, false, false, false, "user_input_live");
    return;
  }
  if (process.argv.includes("--mcp-turn-diagnostic")) {
    await writeLiveReport(true, false, false, true);
    return;
  }
  if (process.argv.includes("--mcp-turn-warmup-diagnostic")) {
    await writeLiveReport(true, false, false, false, true);
    return;
  }
  if (process.argv.includes("--follow-up-live")) {
    await writeLiveReport(true);
    return;
  }
  if (process.argv.includes("--approval-live")) {
    await writeLiveReport(false, false, false, false, false, true);
    return;
  }
  if (process.argv.includes("--command-diagnostic")) {
    await writeLiveReport(false, false, false, false, false, false, true);
    return;
  }
  if (process.argv.includes("--follow-up")) {
    process.stdout.write(`${JSON.stringify(dryRunReport(true), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--live")) {
    await writeLiveReport();
    return;
  }
  process.stdout.write(`${JSON.stringify(dryRunReport(), null, 2)}\n`);
}

main().catch((error) => {
  const kind = error instanceof RpcRequestError ? "rpc_rejection" : "probe_failure";
  process.stderr.write(`${JSON.stringify({ status: "failed", error: { kind } })}\n`);
  process.exitCode = 1;
});
