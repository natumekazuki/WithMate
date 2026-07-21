import assert from "node:assert/strict";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  CodexProtocolSession,
  type CodexClientWireMessage,
  type CodexProtocolSessionOptions,
  type CodexWireWriter,
} from "../src/main/providers/codex/protocol-session.js";
import { CodexTransportError, CodexWireWriteError } from "../src/main/providers/codex/transport-error.js";
import { CODEX_TRANSPORT_LIMITS } from "../src/main/providers/codex/transport-limits.js";
import { CodexStdioWireWriter } from "../src/main/providers/codex/stdio-wire-writer.js";

const initializeResult = {
  codexHome: path.resolve("codex-home"),
  platformFamily: "windows",
  platformOs: "windows",
  userAgent: "codex-cli/test",
};
const NODE_TIMER_MAX_MS = 2_147_483_647;

test("handshake gates operations until initialize response validation and initialized write", async () => {
  const writer = new RecordingWriter();
  const session = createSession(writer);

  const start = session.start();
  await waitFor(() => writer.messages.length === 1);
  assert.deepEqual(writer.messages[0], {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "withmate", version: "1.0.0" },
      capabilities: null,
    },
  });
  await assert.rejects(session.request("model/list", {}), isFailure("request_not_sent", "not_ready"));

  session.accept({ kind: "response", id: 1, result: initializeResult });
  await start;

  assert.deepEqual(writer.messages[1], { method: "initialized", params: {} });
  assert.equal(session.state, "ready");
  assert.deepEqual(session.connectionInfo, {
    platformFamily: "windows",
    platformOs: "windows",
    userAgent: "codex-cli/test",
  });
  assert.equal("codexHome" in (session.connectionInfo ?? {}), false);
});

test("ready remains gated while the initialized write is pending", async () => {
  const writer = new DeferredInitializedWriter();
  const session = createSession(writer);
  const start = session.start();
  await waitFor(() => writer.messages.length === 1);
  session.accept({ kind: "response", id: 1, result: initializeResult });
  await waitFor(() => writer.messages.length === 2);

  assert.equal(session.state, "initializing");
  await assert.rejects(session.request("model/list", {}), isFailure("request_not_sent", "not_ready"));
  writer.completeInitialized();
  await start;
  assert.equal(session.state, "ready");
});

test("handshake deadline and abort cover the initialized notification write", async () => {
  const timeoutWriter = new DeferredInitializedWriter();
  const timeoutSession = createSession(timeoutWriter);
  const timedStart = timeoutSession.start({ timeoutMs: 10 });
  await waitFor(() => timeoutWriter.messages.length === 1);
  timeoutSession.accept({ kind: "response", id: 1, result: initializeResult });
  await waitFor(() => timeoutWriter.messages.length === 2);
  const timeoutOutcome = await settleWithin(timedStart, 100);
  timeoutWriter.completeInitialized();
  assert.ok(isFailure("response_unknown", "timeout")(timeoutOutcome));
  assert.equal(timeoutSession.state, "failed");

  const abortWriter = new DeferredInitializedWriter();
  const abortSession = createSession(abortWriter);
  const controller = new AbortController();
  const abortedStart = abortSession.start({ timeoutMs: 1_000, signal: controller.signal });
  await waitFor(() => abortWriter.messages.length === 1);
  abortSession.accept({ kind: "response", id: 1, result: initializeResult });
  await waitFor(() => abortWriter.messages.length === 2);
  controller.abort();
  const abortOutcome = await settleWithin(abortedStart, 100);
  abortWriter.completeInitialized();
  assert.ok(isFailure("response_unknown", "aborted")(abortOutcome));
  assert.equal(abortSession.state, "failed");
});

test("handshake defaults, start options, and request options enforce the Node timer ceiling", async () => {
  assert.throws(
    () => createSession(new RecordingWriter(), { defaultRequestTimeoutMs: NODE_TIMER_MAX_MS + 1 }),
    /timeout must be between 1 and 2147483647/u,
  );

  const invalidStart = createSession(new RecordingWriter());
  await assert.rejects(
    invalidStart.start({ timeoutMs: NODE_TIMER_MAX_MS + 1 }),
    isFailure("request_not_sent", "invalid_request"),
  );

  const writer = new RecordingWriter();
  const session = createSession(writer, { defaultRequestTimeoutMs: NODE_TIMER_MAX_MS });
  const start = session.start({ timeoutMs: NODE_TIMER_MAX_MS });
  await waitFor(() => writer.messages.length === 1);
  session.accept({ kind: "response", id: 1, result: initializeResult });
  await start;

  await assert.rejects(
    session.request("invalid-timeout", {}, { timeoutMs: NODE_TIMER_MAX_MS + 1 }),
    isFailure("request_not_sent", "invalid_request"),
  );
  const exact = session.request("exact-timeout", {}, { timeoutMs: NODE_TIMER_MAX_MS });
  await waitFor(() => writer.messages.length === 3);
  session.accept({ kind: "response", id: 2, result: "accepted" });
  assert.equal(await exact, "accepted");
});

test("out-of-order responses settle only their matching pending request", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  const first = session.request<string>("first", {});
  const second = session.request<string>("second", {});
  await waitFor(() => writer.messages.length === 4);

  session.accept({ kind: "response", id: 3, result: "second-result" });
  session.accept({ kind: "response", id: 2, result: "first-result" });

  assert.equal(await second, "second-result");
  assert.equal(await first, "first-result");
  assert.equal(session.pendingRequestCount, 0);
});

test("notifications and server requests are delivered without blocking a response", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  const response = session.request<string>("operation", {});
  await waitFor(() => writer.messages.length === 3);

  session.accept({ kind: "notification", method: "future/notification", params: { value: 1 } });
  session.accept({ kind: "serverRequest", id: "server-1", method: "future/request", params: { prompt: "x" } });
  session.accept({ kind: "response", id: 2, result: "done" });

  assert.equal(await response, "done");
  const notification = await session.nextEvent();
  assert.deepEqual(notification, {
    kind: "notification",
    method: "future/notification",
    params: { value: 1 },
  });
  const event = await session.nextEvent();
  assert.equal(event.kind, "serverRequest");
  if (event.kind !== "serverRequest") assert.fail("expected server request");
  assert.deepEqual(
    { id: event.request.id, method: event.request.method, params: event.request.params },
    { id: "server-1", method: "future/request", params: { prompt: "x" } },
  );
  await event.request.respond({ accepted: true });
  assert.deepEqual(writer.messages.at(-1), { id: "server-1", result: { accepted: true } });
  await assert.rejects(
    event.request.respond({ accepted: false }),
    isFailure("request_not_sent", "server_request_settled"),
  );
});

test("duplicate, late, and unknown response IDs become bounded anomalies", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  const request = session.request<string>("operation", {});
  await waitFor(() => writer.messages.length === 3);
  session.accept({ kind: "response", id: 2, result: "done" });
  assert.equal(await request, "done");

  session.accept({ kind: "response", id: 2, result: "duplicate" });
  session.accept({ kind: "response", id: "other", result: "unknown" });
  assert.deepEqual(await session.nextEvent(), {
    kind: "protocolAnomaly",
    code: "duplicate_or_late_response_id",
    responseIdType: "number",
  });
  assert.deepEqual(await session.nextEvent(), {
    kind: "protocolAnomaly",
    code: "unknown_response_id",
    responseIdType: "string",
  });
});

test("remote error, timeout, and abort keep their distinct outcome contracts", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);

  const remote = session.request("remote", {});
  await waitFor(() => writer.messages.length === 3);
  session.accept({ kind: "errorResponse", id: 2, error: { code: -32600, message: "provider detail" } });
  await assert.rejects(remote, isFailure("remote_error"));

  const timedOut = session.request("timeout", {}, { timeoutMs: 1 });
  await assert.rejects(timedOut, isFailure("response_unknown", "timeout"));
  session.accept({ kind: "response", id: 3, result: "late" });
  assert.deepEqual(await session.nextEvent(), {
    kind: "protocolAnomaly",
    code: "duplicate_or_late_response_id",
    responseIdType: "number",
  });

  const beforeSend = new AbortController();
  beforeSend.abort();
  await assert.rejects(
    session.request("aborted", {}, { signal: beforeSend.signal }),
    isFailure("request_not_sent", "aborted"),
  );

  const afterSend = new AbortController();
  const aborted = session.request("aborted", {}, { signal: afterSend.signal });
  await waitFor(() => writer.messages.length === 5);
  afterSend.abort();
  await assert.rejects(aborted, isFailure("response_unknown", "aborted"));
  session.accept({ kind: "response", id: 4, result: "late" });
  assert.deepEqual(await session.nextEvent(), {
    kind: "protocolAnomaly",
    code: "duplicate_or_late_response_id",
    responseIdType: "number",
  });
});

test("timeout and abort retire a queued unsent ID and reject a later response as a protocol failure", async () => {
  for (const trigger of ["timeout", "abort"] as const) {
    const stream = new HoldAtWriteWritable(3);
    const writer = new CodexStdioWireWriter(stream, () => undefined);
    const session = createSession(writer);
    const start = session.start();
    await waitFor(() => stream.underlyingWriteCount === 1);
    session.accept({ kind: "response", id: 1, result: initializeResult });
    await start;
    assert.equal(stream.underlyingWriteCount, 2);

    const active = session.request<string>("active", {});
    await waitFor(() => stream.underlyingWriteCount === 3);
    const controller = new AbortController();
    const queued = session.request(
      "queued",
      {},
      {
        timeoutMs: trigger === "timeout" ? 5 : 1_000,
        ...(trigger === "abort" ? { signal: controller.signal } : {}),
      },
    );
    if (trigger === "abort") controller.abort();
    const queuedOutcome = await queued.then(
      () => undefined,
      (error: unknown) => error,
    );

    stream.releaseHeldWrite();
    await new Promise((resolve) => setImmediate(resolve));
    session.accept({ kind: "response", id: 2, result: "done" });
    assert.equal(await active, "done");

    assert.ok(isFailure("request_not_sent", trigger === "timeout" ? "timeout" : "aborted")(queuedOutcome));
    assert.equal(stream.underlyingWriteCount, 3);
    session.accept({ kind: "response", id: 3, result: "must-not-be-accepted" });
    assert.equal(session.state, "failed");
    await assert.rejects(session.nextEvent(), isFailure("connection_failure", "protocol_failed"));
    writer.shutdown();
  }
});

test("a pre-send write rejection retires its request ID", async () => {
  const writer = new FailAtWriteWriter(3, new CodexWireWriteError({ outcome: "not_sent", code: "queue_full" }));
  const session = await readySession(writer);

  await assert.rejects(session.request("operation", {}), isFailure("request_not_sent", "write_rejected"));
  session.accept({ kind: "response", id: 2, result: "must-not-be-accepted" });

  assert.equal(session.state, "failed");
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "protocol_failed"));
});

test("retired unsent request correlation is bounded by a connection failure", async () => {
  const stream = new HoldAtWriteWritable(3);
  const writer = new CodexStdioWireWriter(stream, () => undefined);
  const session = createSession(writer, {
    limits: { ...CODEX_TRANSPORT_LIMITS, maxRetiredUnsentRequestIds: 1 },
  });
  const start = session.start();
  await waitFor(() => stream.underlyingWriteCount === 1);
  session.accept({ kind: "response", id: 1, result: initializeResult });
  await start;

  const active = session.request("active", {}).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => stream.underlyingWriteCount === 3);
  await assert.rejects(session.request("first", {}, { timeoutMs: 1 }), isFailure("request_not_sent", "timeout"));
  await assert.rejects(session.request("second", {}, { timeoutMs: 1 }), isFailure("request_not_sent", "timeout"));

  assert.equal(session.state, "failed");
  assert.ok(isFailure("response_unknown", "connection_lost")(await active));
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "protocol_failed"));
  stream.releaseHeldWrite();
  writer.shutdown();
});

test("a response for a request still queued before the underlying stream fails the protocol", async () => {
  const stream = new HoldAtWriteWritable(3);
  const writer = new CodexStdioWireWriter(stream, () => undefined);
  const session = createSession(writer);
  const start = session.start();
  await waitFor(() => stream.underlyingWriteCount === 1);
  session.accept({ kind: "response", id: 1, result: initializeResult });
  await start;

  const active = session.request<string>("active", {}).then(
    () => undefined,
    (error: unknown) => error,
  );
  await waitFor(() => stream.underlyingWriteCount === 3);
  const queued = session.request("queued", {}).then(
    (value: unknown) => value,
    (error: unknown) => error,
  );

  session.accept({ kind: "response", id: 3, result: { accepted: true } });
  const queuedOutcome = await queued;
  stream.releaseHeldWrite();
  await new Promise((resolve) => setImmediate(resolve));
  session.accept({ kind: "response", id: 2, result: "done" });
  const activeOutcome = await active;
  writer.shutdown();

  assert.ok(isFailure("request_not_sent", "write_rejected")(queuedOutcome));
  assert.ok(isFailure("response_unknown", "connection_lost")(activeOutcome));
  assert.equal(session.state, "failed");
  assert.equal(stream.underlyingWriteCount, 3);
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "protocol_failed"));
});

test("a response wins exactly once when a later abort races settlement", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  const controller = new AbortController();
  const request = session.request<string>("operation", {}, { signal: controller.signal });
  await waitFor(() => writer.messages.length === 3);

  session.accept({ kind: "response", id: 2, result: "done" });
  controller.abort();
  assert.equal(await request, "done");
  assert.equal(session.pendingRequestCount, 0);
});

test("pending request and stopped-consumer event limits fail boundedly", async () => {
  const limits = { ...CODEX_TRANSPORT_LIMITS, maxPendingRequests: 1, maxQueuedEvents: 1 };
  const writer = new RecordingWriter();
  const session = await readySession(writer, { limits });
  const pending = session.request("one", {});
  await waitFor(() => writer.messages.length === 3);
  await assert.rejects(session.request("two", {}), isFailure("request_not_sent", "pending_limit"));

  session.accept({ kind: "notification", method: "one" });
  session.accept({ kind: "notification", method: "two" });
  assert.equal(session.state, "failed");
  await assert.rejects(pending, isFailure("response_unknown", "connection_lost"));
  assert.deepEqual(await session.nextEvent(), { kind: "notification", method: "one" });
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "event_queue_overflow"));
});

test("duplicate server request IDs fail the connection before double delivery", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: 7, method: "first" });
  session.accept({ kind: "serverRequest", id: 7, method: "second" });

  assert.equal(session.state, "failed");
  assert.equal(session.outstandingServerRequestCount, 0);
  const first = await session.nextEvent();
  if (first.kind !== "serverRequest") assert.fail("expected preserved server request");
  await assert.rejects(first.request.respond({ ok: true }), isFailure("request_not_sent", "server_request_settled"));
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "duplicate_server_request"));
});

test("a settled server request ID can be reused by a later request", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: 7, method: "first" });
  const event = await session.nextEvent();
  if (event.kind !== "serverRequest") assert.fail("expected server request");
  await event.request.respond({ ok: true });

  session.accept({ kind: "serverRequest", id: 7, method: "second" });
  const reused = await session.nextEvent();
  if (reused.kind !== "serverRequest") assert.fail("expected reused server request ID");
  await reused.request.respond({ ok: true });

  assert.equal(session.state, "ready");
  assert.equal(session.outstandingServerRequestCount, 0);
});

test("server response pre-send rejection permits one explicit retry without automatic retry", async () => {
  const writer = new FailAtWriteWriter(3, new CodexWireWriteError({ outcome: "not_sent", code: "queue_full" }));
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: "server", method: "request" });
  const event = await session.nextEvent();
  if (event.kind !== "serverRequest") assert.fail("expected server request");
  await assert.rejects(event.request.respond({ ok: true }), isFailure("request_not_sent", "write_rejected"));
  assert.equal(session.state, "ready");
  assert.equal(session.outstandingServerRequestCount, 1);
  assert.equal(writer.messages.length, 3);

  await event.request.respond({ ok: true });
  assert.equal(session.outstandingServerRequestCount, 0);
  assert.equal(writer.messages.length, 4);
  await assert.rejects(event.request.respond({ ok: true }), isFailure("request_not_sent", "server_request_settled"));
});

test("server error responses validate and copy only the transport-owned shape", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: "server", method: "request" });
  const event = await session.nextEvent();
  if (event.kind !== "serverRequest") assert.fail("expected server request");

  await assert.rejects(
    event.request.respondError({ code: 1, message: "no", extra: "raw" } as never),
    isFailure("request_not_sent", "invalid_request"),
  );
  await event.request.respondError({ code: 1, message: "no", data: { safe: true } });
  assert.deepEqual(writer.messages.at(-1), {
    id: "server",
    error: { code: 1, message: "no", data: { safe: true } },
  });
});

test("server success and error responses preserve an explicit JSON-RPC 2.0 request version", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: "success", method: "request", jsonrpc: "2.0" });
  const success = await session.nextEvent();
  if (success.kind !== "serverRequest") assert.fail("expected server request");
  await success.request.respond({ ok: true });
  assert.deepEqual(writer.messages.at(-1), {
    id: "success",
    result: { ok: true },
    jsonrpc: "2.0",
  });

  session.accept({ kind: "serverRequest", id: "error", method: "request", jsonrpc: "2.0" });
  const failure = await session.nextEvent();
  if (failure.kind !== "serverRequest") assert.fail("expected server request");
  await failure.request.respondError({ code: -32_000, message: "rejected" });
  assert.deepEqual(writer.messages.at(-1), {
    id: "error",
    error: { code: -32_000, message: "rejected" },
    jsonrpc: "2.0",
  });
});

test("settled server request IDs do not consume a connection-lifetime allowance", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  for (let index = 0; index <= 4_096; index += 1) {
    session.accept({ kind: "serverRequest", id: `request-${index}`, method: "request" });
    const event = await session.nextEvent();
    if (event.kind !== "serverRequest") assert.fail("expected server request");
    await event.request.respond({ ok: true });
  }

  assert.equal(session.state, "ready");
  assert.equal(session.outstandingServerRequestCount, 0);
});

test("outstanding server request IDs have an aggregate byte limit", async () => {
  const exactBoundaryId = "識別";
  const writer = new RecordingWriter();
  const session = await readySession(writer, {
    limits: {
      ...CODEX_TRANSPORT_LIMITS,
      maxOutstandingServerRequestIdBytes: Buffer.byteLength(`string:${exactBoundaryId}`, "utf8"),
    },
  });
  session.accept({ kind: "serverRequest", id: exactBoundaryId, method: "first" });
  assert.equal((await session.nextEvent()).kind, "serverRequest");
  session.accept({ kind: "serverRequest", id: "x", method: "second" });

  assert.equal(session.state, "failed");
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "server_request_limit"));
});

test("unknown request write outcome fails the connection and all sibling pending requests", async () => {
  const writer = new FailAtWriteWriter(3, new CodexWireWriteError({ outcome: "unknown", code: "stream_unavailable" }));
  const session = await readySession(writer);
  const request = session.request("operation", {});

  await assert.rejects(request, isFailure("response_unknown", "write_failed"));
  assert.equal(session.state, "failed");
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "stdin_failed"));
});

test("unknown server response write outcome fails the connection", async () => {
  const writer = new FailAtWriteWriter(3, new CodexWireWriteError({ outcome: "unknown", code: "stream_unavailable" }));
  const session = await readySession(writer);
  session.accept({ kind: "serverRequest", id: "server", method: "request" });
  const event = await session.nextEvent();
  if (event.kind !== "serverRequest") assert.fail("expected server request");

  await assert.rejects(event.request.respond({ ok: true }), isFailure("response_unknown", "write_failed"));
  assert.equal(session.state, "failed");
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "stdin_failed"));
});

test("invalid initialize response fails without projecting codexHome", async () => {
  const writer = new RecordingWriter();
  const session = createSession(writer);
  const start = session.start();
  await waitFor(() => writer.messages.length === 1);
  session.accept({
    kind: "response",
    id: 1,
    result: { ...initializeResult, codexHome: "relative/private/path" },
  });

  await assert.rejects(start, (error: unknown) => {
    assert.ok(error instanceof CodexTransportError);
    assert.deepEqual(error.failure, { kind: "connection_failure", code: "handshake_invalid" });
    assert.doesNotMatch(error.message, /private|codexHome/u);
    return true;
  });
  assert.equal(session.state, "failed");
  assert.equal(writer.messages.length, 1);
});

test("initialize remote error exposes only its code", async () => {
  const writer = new RecordingWriter();
  const session = createSession(writer);
  const start = session.start();
  await waitFor(() => writer.messages.length === 1);
  session.accept({
    kind: "errorResponse",
    id: 1,
    error: {
      code: -32600,
      message: "private C:\\Users\\person\\token.txt",
      data: { token: "secret" },
    },
  });

  await assert.rejects(start, (error: unknown) => {
    assert.ok(error instanceof CodexTransportError);
    assert.deepEqual(error.failure, { kind: "remote_error", code: -32600 });
    assert.doesNotMatch(JSON.stringify(error.failure), /Users|person|token|secret/u);
    return true;
  });
  assert.equal(session.state, "failed");
  await assert.rejects(session.nextEvent(), isFailure("remote_error"));
});

test("initialize pre-send abort and response timeout remain the terminal failure", async () => {
  const abortedWriter = new RecordingWriter();
  const abortedSession = createSession(abortedWriter);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortedSession.start({ signal: controller.signal }), isFailure("request_not_sent", "aborted"));
  await assert.rejects(abortedSession.nextEvent(), isFailure("request_not_sent", "aborted"));
  assert.equal(abortedWriter.messages.length, 0);

  const timeoutWriter = new RecordingWriter();
  const timeoutSession = createSession(timeoutWriter);
  await assert.rejects(timeoutSession.start({ timeoutMs: 1 }), isFailure("response_unknown", "timeout"));
  await assert.rejects(timeoutSession.nextEvent(), isFailure("response_unknown", "timeout"));
  assert.equal(timeoutWriter.messages.length, 1);
});

test("initialized sync throw and async rejection are handshake write failures", async () => {
  for (const mode of ["throw", "reject"] as const) {
    const writer = new FailInitializedWriter(mode);
    const session = createSession(writer);
    const start = session.start();
    await waitFor(() => writer.messages.length === 1);
    session.accept({ kind: "response", id: 1, result: initializeResult });
    await assert.rejects(start, isFailure("connection_failure", "handshake_write_failed"));
    assert.equal(session.state, "failed");
  }
});

test("connection failure rejects one waiting event consumer and future waits", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  const waiting = session.nextEvent();
  session.fail("stdout_failed");

  await assert.rejects(waiting, isFailure("connection_failure", "stdout_failed"));
  await assert.rejects(session.nextEvent(), isFailure("connection_failure", "stdout_failed"));
});

test("explicit close preserves already accepted events before the closing error", async () => {
  const writer = new RecordingWriter();
  const session = await readySession(writer);
  session.accept({ kind: "notification", method: "turn/completed", params: { status: "completed" } });

  session.prepareClose();

  assert.deepEqual(await session.nextEvent(), {
    kind: "notification",
    method: "turn/completed",
    params: { status: "completed" },
  });
  await assert.rejects(session.nextEvent(), isFailure("request_not_sent", "closing"));
});

class RecordingWriter implements CodexWireWriter {
  readonly messages: CodexClientWireMessage[] = [];

  write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void> {
    onWriteStarted();
    this.messages.push(message);
    return Promise.resolve();
  }
}

class DeferredInitializedWriter extends RecordingWriter {
  #resolveInitialized: (() => void) | undefined;

  override write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void> {
    onWriteStarted();
    this.messages.push(message);
    if (!("method" in message) || message.method !== "initialized") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#resolveInitialized = resolve;
    });
  }

  completeInitialized(): void {
    this.#resolveInitialized?.();
  }
}

class FailInitializedWriter extends RecordingWriter {
  constructor(readonly mode: "throw" | "reject") {
    super();
  }

  override write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void> {
    onWriteStarted();
    this.messages.push(message);
    if (!("method" in message) || message.method !== "initialized") return Promise.resolve();
    if (this.mode === "throw") throw new Error("private writer detail");
    return Promise.reject(new Error("private writer detail"));
  }
}

class FailAtWriteWriter extends RecordingWriter {
  constructor(
    readonly writeNumber: number,
    readonly failure: Error,
  ) {
    super();
  }

  override write(message: CodexClientWireMessage, onWriteStarted: () => void): Promise<void> {
    const writeWillFail = this.messages.length + 1 === this.writeNumber;
    if (
      !writeWillFail ||
      !(this.failure instanceof CodexWireWriteError) ||
      this.failure.failure.outcome === "unknown"
    ) {
      onWriteStarted();
    }
    this.messages.push(message);
    return this.messages.length === this.writeNumber ? Promise.reject(this.failure) : Promise.resolve();
  }
}

class HoldAtWriteWritable extends Writable {
  underlyingWriteCount = 0;
  #heldCallback: ((error?: Error | null) => void) | undefined;

  constructor(readonly heldWriteNumber: number) {
    super();
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.underlyingWriteCount += 1;
    if (this.underlyingWriteCount === this.heldWriteNumber) {
      this.#heldCallback = callback;
      return;
    }
    callback();
  }

  releaseHeldWrite(): void {
    const callback = this.#heldCallback;
    this.#heldCallback = undefined;
    callback?.();
  }
}

function createSession(writer: CodexWireWriter, overrides: Partial<CodexProtocolSessionOptions> = {}) {
  return new CodexProtocolSession({
    clientInfo: { name: "withmate", version: "1.0.0" },
    writer,
    ...overrides,
  });
}

async function readySession(
  writer: RecordingWriter,
  overrides: Partial<CodexProtocolSessionOptions> = {},
): Promise<CodexProtocolSession> {
  const session = createSession(writer, overrides);
  const start = session.start();
  await waitFor(() => writer.messages.length === 1);
  session.accept({ kind: "response", id: 1, result: initializeResult });
  await start;
  return session;
}

function isFailure(kind: string, code?: string): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!(error instanceof CodexTransportError) || error.failure.kind !== kind) return false;
    return code === undefined || ("code" in error.failure && error.failure.code === code);
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met");
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  return Promise.race([
    operation.then(
      (value) => value,
      (error: unknown) => error,
    ),
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), timeoutMs)),
  ]);
}
