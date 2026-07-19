import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { dispatchCliRunCommand } from "../src/cli/run-dispatch.js";
import type { ApplicationRunOperations, ApplicationRunOutputOperations } from "../src/main/index.js";

type Authorization = Readonly<{ transport: "test" }>;
type Operations = ApplicationRunOperations<Authorization>;
type OutputOperations = ApplicationRunOutputOperations<Authorization>;

const authorization: Authorization = { transport: "test" };
const outputOperations = runOutputOperations();

test("Run status and events dispatch only validated Application requests", async () => {
  const calls: unknown[] = [];
  const operations = runOperations({
    status: async (request, options) => {
      calls.push(["status", request, options]);
      return success(activeStatus());
    },
    events: async (request, options) => {
      calls.push(["events", request, options]);
      return success(eventPage());
    },
  });
  const controller = new AbortController();
  const status = await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "status" },
      sessionId: "session-1",
      runId: "run-1",
      timeoutMs: 500,
    },
    { operations, outputOperations, authorization, signal: controller.signal },
  );
  const events = await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "events" },
      sessionId: "session-1",
      runId: "run-1",
      cursor: "opaque",
      limit: 10,
    },
    { operations, outputOperations, authorization },
  );
  assert.equal(status.ok, true);
  assert.equal(events.ok, true);
  assert.deepEqual(calls, [
    [
      "status",
      { context: { authorization }, sessionId: "session-1", runId: "run-1" },
      { timeoutMs: 500, signal: controller.signal },
    ],
    ["events", { context: { authorization }, sessionId: "session-1", runId: "run-1", cursor: "opaque", limit: 10 }, {}],
  ]);
});

test("Run follow keeps application wait separate from the CLI hard timeout", async () => {
  let call: unknown;
  const operations = runOperations({
    follow: async (request, options) => {
      call = [request, options];
      return success({ reason: "deadline", status: activeStatus(), events: eventPage() });
    },
  });
  const result = await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "follow" },
      sessionId: "session-1",
      runId: "run-1",
      cursor: "opaque",
      limit: 20,
      waitMs: 1_000,
      pollMs: 50,
      timeoutMs: 2_000,
    },
    { operations, outputOperations, authorization },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(call, [
    {
      context: { authorization },
      sessionId: "session-1",
      runId: "run-1",
      cursor: "opaque",
      limit: 20,
      waitMs: 1_000,
      pollMs: 50,
    },
    { timeoutMs: 2_000 },
  ]);
});

test("Run output commands dispatch bounded requests and an explicit CLI export grant", async () => {
  const calls: unknown[] = [];
  const bytes = Uint8Array.from(Buffer.from("llo", "utf8")).buffer;
  const outputOperations = runOutputOperations({
    outputCounts: async (request, options) => {
      calls.push(["output-counts", request, options]);
      return success({
        sessionId: "session-1",
        runId: "run-1",
        totalCount: 0,
        partialCount: 0,
        byCategory: {
          assistant_detail: 0,
          operation: 0,
          interaction: 0,
          telemetry: 0,
          diagnostic: 0,
          provider_metadata: 0,
        },
      });
    },
    outputs: async (request, options) => {
      calls.push(["outputs", request, options]);
      return success({ sessionId: "session-1", runId: "run-1", items: [] });
    },
    outputPreview: async (request, options) => {
      calls.push(["output-preview", request, options]);
      return success({
        sessionId: "session-1",
        runId: "run-1",
        outputItemId: "output-1",
        format: "text",
        storedByteLength: 5,
        contentSha256: "a".repeat(64),
        preview: "hello",
        previewByteLength: 5,
        truncated: false,
      });
    },
    outputChunk: async (request, options) => {
      calls.push(["output-chunk", request, options]);
      return success({
        sessionId: "session-1",
        runId: "run-1",
        outputItemId: "output-1",
        format: "text",
        offset: 2,
        totalBytes: 5,
        byteLength: 3,
        bytes,
        eof: true,
      });
    },
    outputExport: async (request, options) => {
      calls.push(["output-export", request, options]);
      return {
        overallStatus: "success",
        value: {
          sessionId: "session-1",
          runId: "run-1",
          outputItemId: "output-1",
          format: "text",
          storedByteLength: 5,
          contentSha256: "a".repeat(64),
        },
        publication: { status: "published" },
        persistence: { status: "read", effect: "none" },
      };
    },
  });
  const destination = path.resolve("export.txt");
  const controller = new AbortController();
  const common = { context: { authorization }, sessionId: "session-1", runId: "run-1" } as const;
  const dependencies = {
    operations: runOperations({}),
    outputOperations,
    authorization,
    signal: controller.signal,
    timeoutMs: 4_000,
  } as const;

  await dispatchCliRunCommand(
    { identity: { namespace: "run", operation: "output-counts" }, sessionId: "session-1", runId: "run-1" },
    dependencies,
  );
  await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "outputs" },
      sessionId: "session-1",
      runId: "run-1",
      category: "operation",
      cursor: "opaque",
      limit: 3,
    },
    dependencies,
  );
  await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "output-preview" },
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      maxBytes: 64,
    },
    dependencies,
  );
  await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "output-chunk" },
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      offset: 2,
      maxBytes: 3,
    },
    dependencies,
  );
  await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "output-export" },
      sessionId: "session-1",
      runId: "run-1",
      outputItemId: "output-1",
      destination,
    },
    dependencies,
  );

  const options = { timeoutMs: 4_000, signal: controller.signal };
  assert.deepEqual(calls, [
    ["output-counts", common, options],
    ["outputs", { ...common, category: "operation", cursor: "opaque", limit: 3 }, options],
    ["output-preview", { ...common, outputItemId: "output-1", maxBytes: 64 }, options],
    ["output-chunk", { ...common, outputItemId: "output-1", offset: 2, maxBytes: 3 }, options],
    [
      "output-export",
      {
        ...common,
        outputItemId: "output-1",
        destinationGrant: {
          kind: "explicit_absolute_path",
          authority: "cli_user_selection",
          absolutePath: destination,
        },
      },
      options,
    ],
  ]);
});

test("unexpected Run operation rejection is a sanitized runtime failure", async () => {
  const result = await dispatchCliRunCommand(
    { identity: { namespace: "run", operation: "status" }, sessionId: "session-1", runId: "run-1" },
    {
      operations: runOperations({
        status: async () => {
          throw new Error("secret");
        },
      }),
      outputOperations,
      authorization,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.output.error.code, "internal_failure");
    assert.equal(JSON.stringify(result.output).includes("secret"), false);
  }
});

function runOperations(overrides: Partial<Operations>): Operations {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected operation");
  };
  return {
    status: overrides.status ?? unsupported,
    events: overrides.events ?? unsupported,
    follow: overrides.follow ?? unsupported,
  };
}

function runOutputOperations(overrides: Partial<OutputOperations> = {}): OutputOperations {
  const unsupported = async (): Promise<never> => {
    throw new Error("unexpected output operation");
  };
  return {
    outputCounts: overrides.outputCounts ?? unsupported,
    outputs: overrides.outputs ?? unsupported,
    outputPreview: overrides.outputPreview ?? unsupported,
    outputChunk: overrides.outputChunk ?? unsupported,
    outputExport: overrides.outputExport ?? unsupported,
  };
}

function success<TValue>(value: TValue) {
  return { overallStatus: "success", value, persistence: { status: "read", effect: "none" } } as const;
}

function activeStatus() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    phase: "active" as const,
    liveActivity: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function eventPage() {
  return { sessionId: "session-1", runId: "run-1", items: [], nextCursor: "opaque" };
}
