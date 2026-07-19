import assert from "node:assert/strict";
import test from "node:test";

import { dispatchCliRunCommand } from "../src/cli/run-dispatch.js";
import type { ApplicationRunOperations } from "../src/main/index.js";

type Authorization = Readonly<{ transport: "test" }>;
type Operations = ApplicationRunOperations<Authorization>;

const authorization: Authorization = { transport: "test" };

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
    { operations, authorization, signal: controller.signal },
  );
  const events = await dispatchCliRunCommand(
    {
      identity: { namespace: "run", operation: "events" },
      sessionId: "session-1",
      runId: "run-1",
      cursor: "opaque",
      limit: 10,
    },
    { operations, authorization },
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
    { operations, authorization },
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

test("unexpected Run operation rejection is a sanitized runtime failure", async () => {
  const result = await dispatchCliRunCommand(
    { identity: { namespace: "run", operation: "status" }, sessionId: "session-1", runId: "run-1" },
    {
      operations: runOperations({
        status: async () => {
          throw new Error("secret");
        },
      }),
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
