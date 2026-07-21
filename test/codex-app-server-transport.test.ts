import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CODEX_APP_SERVER_ARGUMENTS,
  CodexAppServerTransport,
  CodexTransportError,
  CODEX_TRANSPORT_LIMITS,
  type CodexAppServerTransportOptions,
} from "../src/main/providers/codex/index.js";
import { CodexWireWriteError } from "../src/main/providers/codex/transport-error.js";
import { CodexStdioWireWriter } from "../src/main/providers/codex/stdio-wire-writer.js";
import { observeEmitterErrors, replaceWithLateErrorGuard } from "../src/main/providers/codex/process-error-boundary.js";

const fixturePath = fileURLToPath(new URL("./fixtures/codex-app-server-fixture.mjs", import.meta.url));
const NODE_TIMER_MAX_MS = 2_147_483_647;

test("production transport rejects invalid resource limits before spawning", () => {
  assert.throws(
    () =>
      createTransport("normal", {
        limits: { ...CODEX_TRANSPORT_LIMITS, maxPendingRequests: 0 },
      }),
    /maxPendingRequests must be a positive safe integer/u,
  );
});

test("production transport validates clientInfo before process creation", () => {
  assert.throws(
    () =>
      createTransport("ignore-all-input", {
        clientInfo: { name: "", version: "1.0.0" },
      }),
    /clientInfo name and version are required/u,
  );
  for (const limits of [
    { ...CODEX_TRANSPORT_LIMITS, maxLineBytes: 32 },
    { ...CODEX_TRANSPORT_LIMITS, maxQueuedWriteBytes: 32 },
  ]) {
    assert.throws(
      () =>
        createTransport("ignore-all-input", {
          clientInfo: { name: "withmate-test-with-a-long-client-name", version: "1.0.0" },
          limits,
        }),
      /initialization frame/u,
    );
  }
});

test("production transport rejects non-array, sparse, and non-string arguments before process creation", () => {
  for (const arguments_ of [null, { 0: "value", length: 1 }, Array(1), ["value", 1]] as const) {
    assert.throws(
      () => createTransport("ignore-all-input", { arguments: arguments_ as never }),
      /arguments must be a dense array of strings/u,
    );
  }
});

test("production transport snapshots each argument once and never reuses a later options getter value", () => {
  const changingArguments = ["initial"];
  let elementReads = 0;
  Object.defineProperty(changingArguments, 0, {
    configurable: true,
    enumerable: true,
    get: () => {
      elementReads += 1;
      return elementReads === 1 ? "validated" : 7;
    },
  });
  const elementTransport = createTransport("ignore-all-input", { arguments: changingArguments });
  assert.equal(elementReads, 1);
  assert.deepEqual(elementTransport.options.arguments, ["validated"]);

  let optionReads = 0;
  const options = {
    executable: "node",
    get arguments(): readonly string[] | undefined {
      optionReads += 1;
      return optionReads === 1 ? undefined : ([9] as never);
    },
    clientInfo: { name: "withmate-test", version: "1.0.0" },
  };
  const defaultTransport = new CodexAppServerTransport(options as unknown as CodexAppServerTransportOptions);
  assert.equal(optionReads, 1);
  assert.deepEqual(defaultTransport.options.arguments, CODEX_APP_SERVER_ARGUMENTS);
});

test("production transport enforces the Node timer ceiling before process creation", () => {
  const exact = createTransport("ignore-all-input", {
    startupTimeoutMs: NODE_TIMER_MAX_MS,
    closeTimeoutMs: NODE_TIMER_MAX_MS,
  });
  assert.equal(exact.state, "idle");

  for (const option of [{ startupTimeoutMs: NODE_TIMER_MAX_MS + 1 }, { closeTimeoutMs: NODE_TIMER_MAX_MS + 1 }]) {
    assert.throws(() => createTransport("ignore-all-input", option), /must be between 1 and 2147483647/u);
  }
});

test("startup keeps an exact maximum timeout within the Node timer ceiling after wall-clock rollback", async () => {
  const transport = createTransport("normal", {
    startupTimeoutMs: NODE_TIMER_MAX_MS,
    closeTimeoutMs: 500,
  });
  const realNow = Date.now;
  const now = 2_000_000_000_000;
  const readings = [now, now - 1];
  Date.now = () => readings.shift() ?? now;
  try {
    await transport.start();
    assert.equal(transport.state, "ready");
  } finally {
    Date.now = realNow;
    await transport.close();
  }
});

test("transport owns a real child through start, handshake, request, and idempotent close", async () => {
  const transport = createTransport("normal");
  const connectionInfo = await transport.start();
  assert.equal(transport.state, "ready");
  assert.deepEqual(connectionInfo, {
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform,
    userAgent: "codex-fixture/1.0",
  });

  assert.deepEqual(await transport.request("echo", { value: "ok" }), { value: "ok" });
  const firstClose = transport.close();
  const secondClose = transport.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.equal(transport.state, "closed");
  await assert.rejects(transport.request("echo", {}), isFailure("request_not_sent", "not_ready"));
});

test("real process responses can arrive in reverse order", async () => {
  const transport = createTransport("reverse");
  await transport.start();
  const first = transport.request("reverse", { order: 1 });
  const second = transport.request("reverse", { order: 2 });

  assert.deepEqual(await second, { order: 2 });
  assert.deepEqual(await first, { order: 1 });
  await transport.close();
});

test("real stdout routes unknown notification and server request beside a response", async () => {
  const transport = createTransport("events");
  await transport.start();
  const response = transport.request("exercise", {});

  assert.deepEqual(await response, { done: true });
  assert.deepEqual(await transport.nextEvent(), {
    kind: "notification",
    method: "future/notification",
    params: { source: "fixture" },
  });
  const event = await transport.nextEvent();
  if (event.kind !== "serverRequest") assert.fail("expected server request");
  assert.deepEqual(
    { id: event.request.id, method: event.request.method, params: event.request.params },
    { id: "server-1", method: "future/request", params: { prompt: "fixture" } },
  );
  await event.request.respond({ accepted: true });
  await transport.close();
});

test("spawn and early-exit failures are connection failures without process detail", async () => {
  const missing = new CodexAppServerTransport({
    executable: `${fixturePath}.missing`,
    arguments: [],
    clientInfo: { name: "withmate-test", version: "1.0.0" },
    startupTimeoutMs: 500,
    closeTimeoutMs: 200,
  });
  await assert.rejects(missing.start(), safeFailure("connection_failure", "spawn_failed"));
  assert.equal(missing.state, "failed");

  const early = createTransport("early-exit");
  await assert.rejects(early.start(), safeFailure("connection_failure", "process_exited"));
  assert.equal(early.state, "failed");
});

test("malformed, partial, oversized, and invalid UTF-8 stdout fail handshake", async () => {
  const cases = [
    { scenario: "malformed-handshake", limits: CODEX_TRANSPORT_LIMITS },
    { scenario: "partial-handshake", limits: CODEX_TRANSPORT_LIMITS },
    {
      scenario: "oversized-handshake",
      limits: { ...CODEX_TRANSPORT_LIMITS, maxLineBytes: 192 },
    },
    { scenario: "invalid-utf8-handshake", limits: CODEX_TRANSPORT_LIMITS },
  ] as const;

  for (const candidate of cases) {
    const transport = createTransport(candidate.scenario, { limits: candidate.limits });
    await assert.rejects(transport.start(), safeFailure("connection_failure", "protocol_failed", candidate.scenario));
    assert.equal(transport.state, "failed");
  }
});

test("connection failure preserves a notification accepted before a malformed sibling line", async () => {
  const transport = createTransport("event-then-malformed");
  await transport.start();
  const pending = transport.request("exercise", {});

  await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
  assert.deepEqual(await transport.nextEvent(), {
    kind: "notification",
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  await assert.rejects(transport.nextEvent(), isFailure("connection_failure", "protocol_failed"));
  await transport.close();
});

test("unexpected child exit drains a final descendant stdout frame before failing", async () => {
  const transport = createTransport("exit-after-final-event");
  await transport.start();
  const pending = transport.request("exercise", {});

  await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
  assert.deepEqual(await transport.nextEvent(), {
    kind: "notification",
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  await assert.rejects(transport.nextEvent(), isFailure("connection_failure", "process_exited"));
  await transport.close();
});

test("child crash and clean exit reject a pending request exactly once", async () => {
  for (const scenario of ["crash-on-request", "clean-exit-on-request"] as const) {
    const transport = createTransport(scenario);
    await transport.start();
    let rejectionCount = 0;
    const pending = transport.request("hold", {}).catch((error: unknown) => {
      rejectionCount += 1;
      throw error;
    });

    await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
    await waitFor(() => transport.state === "failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rejectionCount, 1);
    assert.equal(transport.pendingRequestCount, 0);
    await transport.close();
  }
});

test("child exit after handshake converges a sent pending request without retry", async () => {
  const transport = createTransport("exit-after-initialized");
  await transport.start();
  const pending = transport.request("hold", {});

  await assert.rejects(
    pending,
    (error: unknown) =>
      isFailure("response_unknown", "write_failed")(error) || isFailure("response_unknown", "connection_lost")(error),
  );
  await waitFor(() => transport.state === "failed");
  assert.equal(transport.pendingRequestCount, 0);
  await transport.close();
});

test("stdin stream close makes an active write unknown and rejects later writes before send", async () => {
  let fatalFailures = 0;
  const stream = new HeldWritable();
  const writer = new CodexStdioWireWriter(stream, () => {
    fatalFailures += 1;
  });
  const active = writer.write({ id: 1, method: "hold", params: {} }, () => undefined);

  stream.destroy();

  await assert.rejects(active, isWireWriteFailure("unknown", "stream_unavailable"));
  await assert.rejects(
    writer.write({ id: 2, method: "later", params: {} }, () => undefined),
    isWireWriteFailure("not_sent", "stream_unavailable"),
  );
  assert.equal(fatalFailures, 1);
  assert.equal(writer.queuedBytes, 0);
});

test("an asynchronous write callback failure keeps writes not passed to the stream as not-sent", async () => {
  let fatalFailures = 0;
  const stream = new AsyncCallbackErrorWritable();
  const writer = new CodexStdioWireWriter(stream, () => {
    fatalFailures += 1;
  });
  const active = writer.write({ id: 1, method: "active", params: {} }, () => undefined);
  const queued = writer.write({ id: 2, method: "queued", params: {} }, () => undefined);

  await assert.rejects(active, isWireWriteFailure("unknown", "stream_unavailable"));
  await assert.rejects(queued, isWireWriteFailure("not_sent", "stream_unavailable"));
  await waitFor(() => fatalFailures === 1);
  assert.equal(stream.underlyingWriteCount, 1);
  assert.equal(writer.queuedBytes, 0);
});

test("request timeout reports unknown and a late response becomes an anomaly", async () => {
  const transport = createTransport("delayed-response");
  await transport.start();
  await assert.rejects(transport.request("delayed", {}, { timeoutMs: 5 }), isFailure("response_unknown", "timeout"));
  assert.deepEqual(await transport.nextEvent(), {
    kind: "protocolAnomaly",
    code: "duplicate_or_late_response_id",
    responseIdType: "number",
  });
  assert.equal(transport.state, "ready");
  await transport.close();
});

test("stderr diagnostics are bounded and omit all child content", async () => {
  const transport = createTransport("stderr", {
    limits: { ...CODEX_TRANSPORT_LIMITS, maxStderrBytes: 32 },
  });
  await transport.start();
  await waitFor(() => transport.diagnostics().stderr.observedBytes > 32);

  const diagnostic = transport.diagnostics();
  assert.equal(diagnostic.stderr.retainedBytes, 32);
  assert.equal(diagnostic.stderr.truncated, true);
  assert.equal(diagnostic.stderr.redaction, "content_omitted");
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|Users|person|account@example|private\.txt/u);
  await transport.close();
});

test("stderr errors are observed while owned and remain handled after resource release", () => {
  const stderr = new PassThrough();
  let observed = 0;
  observeEmitterErrors(stderr, () => {
    observed += 1;
  });

  stderr.emit("error", new Error("owned stream failure"));
  assert.equal(observed, 1);

  replaceWithLateErrorGuard(stderr);
  assert.equal(stderr.listenerCount("error"), 1);
  assert.doesNotThrow(() => stderr.emit("error", new Error("late stream failure")));
  assert.equal(observed, 1);
});

test("a stopped stdin consumer cannot grow the write queue beyond its byte limit", async () => {
  const transport = createTransport("ignore-input", {
    limits: { ...CODEX_TRANSPORT_LIMITS, maxQueuedWriteBytes: 950_000 },
    closeTimeoutMs: 200,
  });
  await transport.start();
  const large = "x".repeat(900_000);
  const first = transport.request("hold", { large });
  const firstRejection = assert.rejects(first, isFailure("response_unknown", "write_failed"));
  await waitFor(() => transport.queuedWriteBytes > 0);

  await assert.rejects(transport.request("hold", { large }), isFailure("request_not_sent", "write_rejected"));
  assert.ok(transport.queuedWriteBytes <= 950_000);
  await transport.close();
  await firstRejection;
});

test("close preserves active unknown versus queued not-sent outcomes", async () => {
  const transport = createTransport("ignore-input", {
    limits: { ...CODEX_TRANSPORT_LIMITS, maxQueuedWriteBytes: 950_000 },
    closeTimeoutMs: 200,
  });
  await transport.start();
  const activeOutcome = transport.request("hold", { large: "a".repeat(600_000) }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => transport.queuedWriteBytes > 0);
  const queuedOutcome = transport.request("hold", { large: "b".repeat(300_000) }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => transport.queuedWriteBytes > 850_000);

  await transport.close();
  assert.ok(isFailure("response_unknown", "write_failed")(await activeOutcome));
  assert.ok(isFailure("request_not_sent", "write_rejected")(await queuedOutcome));
  assert.equal(transport.pendingRequestCount, 0);
  assert.equal(transport.state, "closed");
});

test("close racing startup shares one bounded child termination", async () => {
  const transport = createTransport("ignore-all-input", {
    closeTimeoutMs: 100,
  });
  const startOutcome = transport.start().then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => transport.state === "starting");

  const firstClose = transport.close();
  assert.equal(transport.close(), firstClose);
  await firstClose;

  assert.ok(isFailure("response_unknown", "connection_lost")(await startOutcome));
  assert.equal(transport.pendingRequestCount, 0);
  assert.equal(transport.state, "closed");
});

test("forced close terminates the owned descendant process tree", async () => {
  const transport = createTransport("ignore-input-with-descendant", {
    closeTimeoutMs: 100,
  });
  await transport.start();
  const event = await transport.nextEvent();
  if (event.kind !== "notification" || event.method !== "fixture/descendant") {
    assert.fail("expected descendant notification");
  }
  const pid = (event.params as { pid?: unknown } | undefined)?.pid;
  assert.equal(typeof pid, "number");
  if (typeof pid !== "number") assert.fail("expected descendant pid");

  try {
    await transport.close();
    await waitFor(() => !isProcessAlive(pid));
    assert.equal(isProcessAlive(pid), false);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitFor(() => !isProcessAlive(pid));
    }
  }
});

test("graceful root exit during close still terminates its owned long-lived descendant", async () => {
  const transport = createTransport("close-with-descendant", {
    closeTimeoutMs: 1_500,
  });
  await transport.start();
  const event = await transport.nextEvent();
  if (event.kind !== "notification" || event.method !== "fixture/descendant") {
    assert.fail("expected descendant notification");
  }
  const pid = (event.params as { pid?: unknown } | undefined)?.pid;
  assert.equal(typeof pid, "number");
  if (typeof pid !== "number") assert.fail("expected descendant pid");

  try {
    await transport.close();
    await waitFor(() => !isProcessAlive(pid));
    assert.equal(isProcessAlive(pid), false);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitFor(() => !isProcessAlive(pid));
    }
  }
});

test("unexpected root exit still terminates its owned long-lived descendant", async () => {
  const transport = createTransport("exit-with-descendant", {
    closeTimeoutMs: 1_500,
  });
  await transport.start();
  const pending = transport.request("exercise", {});
  const event = await transport.nextEvent();
  if (event.kind !== "notification" || event.method !== "fixture/descendant") {
    assert.fail("expected descendant notification");
  }
  const pid = (event.params as { pid?: unknown } | undefined)?.pid;
  assert.equal(typeof pid, "number");
  if (typeof pid !== "number") assert.fail("expected descendant pid");

  try {
    await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
    await transport.close();
    await waitFor(() => !isProcessAlive(pid));
    assert.equal(isProcessAlive(pid), false);
  } finally {
    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitFor(() => !isProcessAlive(pid));
    }
  }
});

test(
  "Windows ownership survives an intermediate launcher exit before the detached grandchild",
  { skip: process.platform !== "win32" },
  async () => {
    const transport = createTransport("exit-with-orphaned-grandchild", {
      closeTimeoutMs: 1_500,
    });
    await transport.start();
    const pending = transport.request("exercise", {});
    const event = await transport.nextEvent();
    if (event.kind !== "notification" || event.method !== "fixture/descendant") {
      assert.fail("expected descendant notification");
    }
    const pid = (event.params as { pid?: unknown } | undefined)?.pid;
    assert.equal(typeof pid, "number");
    if (typeof pid !== "number") assert.fail("expected descendant pid");

    try {
      await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
      await transport.close();
      await waitFor(() => !isProcessAlive(pid));
      assert.equal(isProcessAlive(pid), false);
    } finally {
      if (isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
        await waitFor(() => !isProcessAlive(pid));
      }
    }
  },
);

test(
  "Windows transport termination does not target an unrelated process",
  { skip: process.platform !== "win32" },
  async () => {
    const unrelated = spawn(process.execPath, ["--eval", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    const unrelatedPid = unrelated.pid;
    if (unrelatedPid === undefined) assert.fail("expected unrelated process pid");

    const transport = createTransport("ignore-input", { closeTimeoutMs: 100 });
    try {
      await transport.start();
      await transport.close();
      assert.equal(isProcessAlive(unrelatedPid), true);
    } finally {
      unrelated.kill("SIGKILL");
      await waitFor(() => !isProcessAlive(unrelatedPid));
    }
  },
);

test("close racing a response settles the request once and leaves no child owner", async () => {
  const transport = createTransport("delayed-response");
  await transport.start();
  let rejectionCount = 0;
  const pending = transport.request("delayed", {}).catch((error: unknown) => {
    rejectionCount += 1;
    throw error;
  });
  const close = transport.close();

  await assert.rejects(pending, isFailure("response_unknown", "write_failed"));
  await close;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rejectionCount, 1);
  assert.equal(transport.pendingRequestCount, 0);
  assert.equal(transport.state, "closed");
});

function createTransport(
  scenario: string,
  overrides: Partial<CodexAppServerTransportOptions> = {},
): CodexAppServerTransport {
  return new CodexAppServerTransport({
    executable: "node",
    arguments: [fixturePath, scenario],
    clientInfo: { name: "withmate-test", version: "1.0.0" },
    startupTimeoutMs: 1_000,
    closeTimeoutMs: 500,
    ...overrides,
  });
}

function isFailure(kind: string, code?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!(error instanceof CodexTransportError) || error.failure.kind !== kind) return false;
    return code === undefined || ("code" in error.failure && error.failure.code === code);
  };
}

function isWireWriteFailure(outcome: string, code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof CodexWireWriteError && error.failure.outcome === outcome && error.failure.code === code;
}

function safeFailure(kind: string, code: string, context?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(
      isFailure(kind, code)(error),
      `${context ?? "failure"}: ${error instanceof CodexTransportError ? JSON.stringify(error.failure) : "unexpected"}`,
    );
    assert.ok(error instanceof CodexTransportError);
    assert.doesNotMatch(error.message, /fixture|missing|pid|signal|exit|private/u);
    return true;
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not met");
}

class HeldWritable extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, _callback: (error?: Error | null) => void): void {}
}

class AsyncCallbackErrorWritable extends Writable {
  underlyingWriteCount = 0;

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.underlyingWriteCount += 1;
    setImmediate(() => callback(new Error("fixture write failure")));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
