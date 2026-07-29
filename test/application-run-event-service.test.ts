import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunEventService,
  type ApplicationRunEventReadPort,
  type ApplicationRunEventWritePort,
} from "../src/main/application-run-event-service.js";
import { ApplicationRunDispatchService } from "../src/main/application-run-dispatch-service.js";
import type {
  ApplicationRunDispatchControl,
  ApplicationRunPreparedDispatch,
} from "../src/main/application-run-runtime-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type {
  RunDispatchResolutionCommand,
  RunOutputAppendCommand,
  RunTerminalCommand,
} from "../src/shared/repository-write-model.js";

test("accepted Provider events persist safe output once, expose versioned live state, and terminalize exactly", async () => {
  const fixture = eventFixture({
    resolutionUnknownOnce: true,
    outputUnknownOnce: true,
    terminalUnknownOnce: true,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  assert.deepEqual(fixture.resolutions[0], fixture.resolutions[1]);
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), {
    sessionId: "session-1",
    runId: "run-1",
    runVersion: 7,
    activity: "running",
  });

  const output = {
    kind: "item_output",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    output: {
      category: "assistant_detail",
      kind: "reasoning",
      summary: "bounded detail",
      completionState: "complete",
      payload: {
        kind: "text",
        text: "must not be persisted",
        originalByteLength: 21,
        redaction: "undetermined",
      },
    },
  } as const;
  await fixture.service.accept("codex-1", output);
  await fixture.service.accept("codex-1", output);

  assert.equal(fixture.outputs.length, 2);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[0]?.item.payload, {
    state: "omitted_redaction",
    originalByteLength: 21,
  });
  assert.equal(JSON.stringify(fixture.outputs).includes("must not be persisted"), false);

  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: { contentBlocks: [{ type: "text", text: "done" }] },
    contentFailure: { code: "size_limit" },
  });
  await handle.done;

  assert.equal(fixture.terminals.length, 2);
  assert.deepEqual(fixture.terminals[0], fixture.terminals[1]);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "completed" && fixture.terminals[0].outcome.finalAssistantMessage,
    null,
  );
  assert.equal(fixture.terminals[0]?.outputs[0]?.kind, "assistant_content_failure");
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  await fixture.service.accept("codex-1", output);
  assert.equal(fixture.outputs.length, 2);
});

test("persistence-only ownership automatically retries accepted resolution and terminal commands", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 2,
    terminalUnknownCount: 2,
    recoveryUnavailableCount: 1,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await waitFor(() => fixture.resolutions.length === 3);
  assert.equal((await fixture.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");

  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  await waitFor(() => fixture.terminals.length === 3);
  await handle.done;

  assert.ok(fixture.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(fixture.resolutions[0])));
  assert.ok(fixture.terminals.every((command) => JSON.stringify(command) === JSON.stringify(fixture.terminals[0])));
});

test("not-sent and rejected Provider results resolve rejected before their bounded terminal", async () => {
  for (const result of [
    { kind: "not_sent", effect: "none", code: "invalid_input" },
    { kind: "rejected", effect: "none", code: -32_000 },
  ] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(result);
    await handle.done;
    assert.deepEqual(
      fixture.resolutions.map((command) => command.outcome.kind),
      ["rejected"],
    );
    assert.equal(fixture.terminalized.length, 1);
    assert.equal(fixture.terminalized[0]?.outcomeKind, "failed");
    assert.equal(fixture.terminalized[0]?.failureOrigin, result.kind === "rejected" ? "provider" : "application");
  }
});

test("a queued operation rejection retains the exact startTurn result and Attempt owner", async () => {
  const fixture = eventFixture({ terminalizeRejectOnce: true });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  const result = { kind: "not_sent", effect: "none", code: "invalid_input" } as const;

  await assert.rejects(handle.settleStartTurn(result), /terminal persistence failed/u);
  assert.equal(await isSettled(handle.done), false);
  assert.equal(await fixture.service.retryRun("run-1"), true);
  await handle.done;

  assert.equal(fixture.terminalized.length, 2);
  assert.deepEqual(fixture.terminalized[0], fixture.terminalized[1]);
  assert.equal(fixture.resolutions.length, 2);
  assert.deepEqual(fixture.resolutions[0], fixture.resolutions[1]);
});

test("Turn failure code distinguishes deterministic input from shutdown abort", async () => {
  for (const expected of [
    {
      result: { kind: "not_sent", effect: "none", code: "aborted" },
      outcomeKind: "interrupted",
      failureOrigin: "application",
    },
    {
      result: { kind: "not_sent", effect: "none", code: "invalid_input" },
      outcomeKind: "failed",
      failureOrigin: "application",
    },
  ] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);

    await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
    await handle.settleStartTurn(expected.result);
    await handle.done;

    assert.deepEqual(
      fixture.resolutions.map((command) => command.outcome.kind),
      ["rejected"],
    );
    assert.equal(fixture.terminalized.length, 1);
    assert.equal(fixture.terminalized[0]?.outcomeKind, expected.outcomeKind);
    assert.equal(fixture.terminalized[0]?.failureOrigin, expected.failureOrigin);
  }
});

test("event-first connection failure keeps a later not-sent Turn result as a transport interruption", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await handle.settleStartTurn({
    kind: "not_sent",
    effect: "none",
    code: "process_exited",
  });
  await handle.done;

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["rejected"],
  );
  assert.equal(fixture.terminalized.length, 1);
  assert.equal(fixture.terminalized[0]?.outcomeKind, "interrupted");
  assert.equal(fixture.terminalized[0]?.failureOrigin, "transport");
});

test("event-first acceptance is buffered, while an ambiguous response needs new post-response evidence", async () => {
  const accepted = eventFixture();
  const acceptedHandle = accepted.service.register(dispatch(), accepted.control);
  assert.ok(acceptedHandle);
  await accepted.service.accept("codex-1", turnStarted("turn-1"));
  await acceptedHandle.settleStartTurn(acceptedTurn("turn-1"));
  assert.equal(accepted.resolutions[0]?.outcome.kind, "accepted");

  const ambiguous = eventFixture();
  const ambiguousHandle = ambiguous.service.register(dispatch(), ambiguous.control);
  assert.ok(ambiguousHandle);
  await ambiguous.service.accept("codex-1", turnStarted("turn-conflicted"));
  await ambiguousHandle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await ambiguous.service.accept("codex-1", turnStarted("turn-conflicted"));
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous"],
  );
  assert.deepEqual(await ambiguous.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  await ambiguous.service.accept("codex-1", turnStarted("turn-late"));
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "accepted"],
  );
  assert.equal((await ambiguous.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
});

test("generation loss terminalizes accepted and ambiguous execution without claiming ambiguous delivery was absent", async () => {
  const accepted = eventFixture();
  const acceptedHandle = accepted.service.register(dispatch(), accepted.control);
  assert.ok(acceptedHandle);
  await accepted.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await acceptedHandle.settleStartTurn(acceptedTurn("turn-1"));
  await acceptedHandle.done;
  assert.equal(accepted.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    accepted.terminals[0]?.outcome.kind === "interrupted" && accepted.terminals[0].outcome.failureOrigin,
    "transport",
  );

  const ambiguous = eventFixture({
    terminalUnknownCount: 2,
    limits: { maxBufferedEventsPerAttempt: 1 },
  });
  const ambiguousHandle = ambiguous.service.register(dispatch(), ambiguous.control);
  assert.ok(ambiguousHandle);
  await ambiguous.service.accept("codex-1", {
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "active",
  });
  await ambiguous.service.accept("codex-1", {
    kind: "thread_status_observed",
    threadId: "thread-1",
    status: "idle",
  });
  await ambiguousHandle.settleStartTurn({
    kind: "connection_failure",
    effect: "unknown",
    code: "process_exited",
  });
  await assert.rejects(
    ambiguous.service.releaseGeneration("codex-1", {
      kind: "connection_failure",
      code: "process_exited",
    }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(await isSettled(ambiguousHandle.done), false);
  assert.equal(await ambiguous.service.retryRun("run-1"), true);
  await ambiguousHandle.done;
  assert.equal(ambiguous.terminals.length, 3);
  assert.deepEqual(ambiguous.terminals[0], ambiguous.terminals[1]);
  assert.deepEqual(ambiguous.terminals[1], ambiguous.terminals[2]);
  assert.equal(ambiguous.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(ambiguous.terminals[0]?.preDispatchResolution.kind, "dispatch_ambiguous");
  assert.equal(ambiguous.terminals[0]?.providerExecution, null);
  assert.deepEqual(
    ambiguous.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
  assert.deepEqual(
    ambiguous.resolutions.map((command) => command.outcome.kind),
    ["ambiguous"],
  );
});

test("generation release waits for an in-flight startTurn result before closing the attempt", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await fixture.service.releaseGeneration("codex-1", {
    kind: "connection_failure",
    code: "process_exited",
  });
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await handle.done;

  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.equal(
    fixture.terminals[0]?.outcome.kind === "interrupted" && fixture.terminals[0].outcome.failureOrigin,
    "transport",
  );
});

test("output-bearing metadata requires exact Turn correlation", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const output = {
    category: "provider_metadata" as const,
    kind: "provider/progress",
    summary: "progress",
    completionState: "complete" as const,
    payload: { kind: "none" as const, redaction: "not_required" as const },
  };
  await fixture.service.accept("codex-1", {
    kind: "provider_metadata",
    correlation: { threadId: "thread-1" },
    output,
  });
  await fixture.service.accept("codex-1", {
    kind: "diagnostic",
    diagnostic: {
      code: "provider_warning",
      summary: "notice",
      correlation: { threadId: "thread-1" },
      redaction: "not_required",
    },
  });
  assert.equal(fixture.outputs.length, 0);

  await fixture.service.accept("codex-1", {
    kind: "provider_metadata",
    correlation: { threadId: "thread-1", turnId: "turn-1" },
    output,
  });
  assert.equal(fixture.outputs.length, 1);
});

test("unknown output writes reserve the count bound and retry only the same frozen command", async () => {
  const fixture = eventFixture({
    outputUnknownCount: 2,
    limits: { maxPersistedOutputsPerAttempt: 1 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  const first = itemOutput("item-1", "first", "first");
  await fixture.service.accept("codex-1", first);
  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));
  assert.equal(fixture.outputs.length, 2);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(fixture.outputs.length, 3);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[1], fixture.outputs[2]);

  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));
  assert.equal(fixture.outputs.length, 3);
});

test("an unknown output remains ahead of later outputs until its exact command is confirmed", async () => {
  const fixture = eventFixture({ outputUnknownCount: 2 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  await fixture.service.accept("codex-1", itemOutput("item-1", "first", "first"));
  await fixture.service.accept("codex-1", itemOutput("item-2", "second", "second"));

  assert.equal(fixture.outputs.length, 4);
  assert.deepEqual(fixture.outputs[0], fixture.outputs[1]);
  assert.deepEqual(fixture.outputs[1], fixture.outputs[2]);
  assert.equal(fixture.outputs[2]?.item.providerItemId, "item-1");
  assert.equal(fixture.outputs[3]?.item.providerItemId, "item-2");

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;
});

test("accepted Dispatch resolution keeps its exact persistence owner through retry and generation release", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 6,
    recoveryUnavailableCount: 3,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  assert.equal(await isSettled(handle.done), false);
  assert.deepEqual(await fixture.service.read({ sessionId: "session-1", runId: "run-1" }), null);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(await isSettled(handle.done), false);

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;
  assert.equal(fixture.resolutions.length, 7);
  assert.ok(fixture.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(fixture.resolutions[0])));
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
});

test("events received while an accepted resolution is unknown are replayed after exact confirmation", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 4,
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await fixture.service.accept("codex-1", itemOutput("item-1", "pending", "pending"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.outputs.length, 0);
  assert.equal(fixture.terminals.length, 0);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), true);
  await handle.done;

  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.ok(fixture.resolutions.every((command) => command.outcome.kind === "accepted"));
});

test("post-response terminal evidence survives an unknown ambiguous resolution and corrects it to accepted", async () => {
  const fixture = eventFixture({
    resolutionUnknownCount: 4,
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-late",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.terminals.length, 0);

  assert.equal(await fixture.service.retryRun("run-1"), true);
  assert.equal(await isSettled(handle.done), false);
  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "ambiguous", "ambiguous", "ambiguous", "ambiguous", "accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
});

test("ordered output and terminal evidence survive consecutive unknown ambiguous and accepted resolutions", async () => {
  const fixture = eventFixture({
    resolutionUnknownCountByOutcome: {
      ambiguous: 2,
      accepted: 2,
    },
    recoveryUnavailableCount: 2,
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);

  await handle.settleStartTurn({
    kind: "ambiguous",
    effect: "unknown",
    code: "connection_lost",
  });
  await fixture.service.accept("codex-1", itemOutput("item-late", "pending", "pending", "turn-late"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-late",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });

  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal(fixture.terminals.length, 0);
  assert.equal(await isSettled(handle.done), false);

  await fixture.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await handle.done;

  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.outputs[0]?.item.providerItemId, "item-late");
  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["ambiguous", "ambiguous", "ambiguous", "accepted", "accepted", "accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.terminals[0]?.outcome.kind, "completed");
});

test("terminal persistence waits until every frozen output command is confirmed", async () => {
  const fixture = eventFixture({ outputUnknownCount: 4 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));

  await fixture.service.accept("codex-1", itemOutput("item-1", "pending", "pending"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  assert.equal(fixture.outputs.length, 4);
  assert.equal(fixture.terminals.length, 0);

  await handle.done;
  assert.equal(fixture.outputs.length, 5);
  assert.ok(fixture.outputs.every((command) => JSON.stringify(command) === JSON.stringify(fixture.outputs[0])));
  assert.equal(fixture.terminals.length, 1);
});

test("unconfirmed terminal and rejected resolution retain their exact retry owner", async () => {
  const terminal = eventFixture({ terminalUnknownCount: 2 });
  const terminalHandle = terminal.service.register(dispatch(), terminal.control);
  assert.ok(terminalHandle);
  await terminalHandle.settleStartTurn(acceptedTurn("turn-1"));
  await assert.rejects(
    terminal.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  assert.equal((await terminal.service.read({ sessionId: "session-1", runId: "run-1" }))?.activity, "running");
  assert.equal(await isSettled(terminalHandle.done), false);

  await terminal.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await terminalHandle.done;
  assert.equal(terminal.terminals.length, 3);
  assert.deepEqual(terminal.terminals[0], terminal.terminals[1]);
  assert.deepEqual(terminal.terminals[1], terminal.terminals[2]);

  const rejected = eventFixture({ resolutionUnknownCount: 2 });
  const rejectedHandle = rejected.service.register(dispatch(), rejected.control);
  assert.ok(rejectedHandle);
  await rejectedHandle.settleStartTurn({ kind: "not_sent", effect: "none", code: "capability_unavailable" });
  assert.equal(await isSettled(rejectedHandle.done), false);
  await rejected.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await rejectedHandle.done;
  assert.equal(rejected.resolutions.length, 4);
  assert.ok(
    rejected.resolutions.every((command) => JSON.stringify(command) === JSON.stringify(rejected.resolutions[0])),
  );
  assert.equal(rejected.terminalized.length, 1);
  assert.equal(rejected.terminalized[0]?.outcomeKind, "failed");
  assert.equal(rejected.terminalized[0]?.failureOrigin, "application");
});

test("failed and interrupted terminal events never create a final Message", async () => {
  for (const status of ["failed", "interrupted"] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));
    await fixture.service.accept("codex-1", {
      kind: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
      status,
      finalAssistantMessage: { contentBlocks: [{ type: "text", text: "ignored" }] },
      contentFailure: null,
    });
    await handle.done;
    assert.equal(fixture.terminals[0]?.outcome.kind, status);
    assert.equal(JSON.stringify(fixture.terminals).includes("ignored"), false);
  }
});

test("event bounds preserve terminal progress and safely map exact and overflowing output metadata", async () => {
  const fixture = eventFixture({
    limits: { maxBufferedEventsPerAttempt: 2, maxPersistedOutputsPerAttempt: 2 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await fixture.service.accept("codex-1", itemOutput("item-dropped", "dropped by the bound", "kind"));
  await fixture.service.accept("codex-1", itemOutput("item-survivor", "retained before terminal", "kind"));
  await fixture.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  });
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  await handle.done;
  assert.equal(fixture.outputs.length, 1);
  assert.equal(fixture.outputs[0]?.item.providerItemId, "item-survivor");
  assert.equal(fixture.terminals.length, 1);
  assert.deepEqual(
    fixture.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );

  const metadata = eventFixture({
    limits: { maxPersistedOutputsPerAttempt: 2 },
  });
  const metadataHandle = metadata.service.register(dispatch(), metadata.control);
  assert.ok(metadataHandle);
  await metadataHandle.settleStartTurn(acceptedTurn("turn-1"));
  await metadata.service.accept("codex-1", itemOutput("item-exact", "s".repeat(4_096), "k".repeat(64)));
  await metadata.service.accept("codex-1", itemOutput("item-over", "s".repeat(4_097), "k".repeat(65)));
  await metadata.service.accept("codex-1", itemOutput("item-dropped", "third", "third"));
  assert.equal(metadata.outputs.length, 2);
  assert.equal(metadata.outputs[0]?.item.summary.length, 4_096);
  assert.equal(metadata.outputs[0]?.item.kind.length, 64);
  assert.equal(metadata.outputs[1]?.item.summary, "Provider output summary exceeded the persistence limit.");
  assert.equal(metadata.outputs[1]?.item.kind, "provider_output");
  await metadata.service.releaseGeneration("codex-1", { kind: "shutdown" });
  await metadataHandle.done;
  assert.deepEqual(
    metadata.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );

  const adapterOverflow = eventFixture();
  const adapterOverflowHandle = adapterOverflow.service.register(dispatch(), adapterOverflow.control);
  assert.ok(adapterOverflowHandle);
  await adapterOverflowHandle.settleStartTurn(acceptedTurn("turn-1"));
  await adapterOverflow.service.accept("codex-1", {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
    resourceLimitExceeded: true,
  });
  await adapterOverflowHandle.done;
  assert.equal(adapterOverflow.terminals[0]?.outcome.kind, "completed");
  assert.deepEqual(
    adapterOverflow.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
});

test("Provider resource failures terminalize accepted execution with a resource diagnostic", async () => {
  for (const code of ["adapter_resource_limit", "event_queue_overflow"] as const) {
    const fixture = eventFixture();
    const handle = fixture.service.register(dispatch(), fixture.control);
    assert.ok(handle);
    await handle.settleStartTurn(acceptedTurn("turn-1"));

    await fixture.service.accept("codex-1", {
      kind: "connection_failure",
      code,
    });
    await handle.done;

    assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
    assert.deepEqual(
      fixture.terminals[0]?.outputs.map((output) => output.kind),
      ["runtime_resource_limit"],
    );
  }
});

test("transport event queue overflow preserves a resource diagnostic for ambiguous execution", async () => {
  const fixture = eventFixture();
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn({
    kind: "connection_failure",
    effect: "unknown",
    code: "event_queue_overflow",
  });

  await fixture.service.accept("codex-1", {
    kind: "connection_failure",
    code: "event_queue_overflow",
  });
  await handle.done;

  assert.equal(fixture.terminals[0]?.outcome.kind, "interrupted");
  assert.deepEqual(
    fixture.terminals[0]?.outputs.map((output) => output.kind),
    ["runtime_resource_limit"],
  );
});

test("Dispatch registration keeps runtime work owned until the Provider terminal event is durable", async () => {
  const fixture = eventFixture();
  const service = new ApplicationRunDispatchService({
    writes: {
      async beginRunDispatch(command) {
        return success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          bindingId: command.bindingId,
          runPhase: "starting",
          dispatchState: "dispatching",
          dispatchingAt: 5,
          sendAllowed: true,
        });
      },
      resolveRunDispatch: fixture.writes.resolveRunDispatch,
    },
    attempts: fixture.service,
  });
  const control: ApplicationRunDispatchControl = {
    ...fixture.control,
    adapter: {
      async startTurn() {
        setImmediate(() => {
          void fixture.service.accept("codex-1", {
            kind: "turn_terminal",
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            finalAssistantMessage: null,
            contentFailure: null,
          });
        });
        return acceptedTurn("turn-1");
      },
    } as never,
  };

  await service.ready(dispatch(), control);

  assert.deepEqual(
    fixture.resolutions.map((command) => command.outcome.kind),
    ["accepted"],
  );
  assert.equal(fixture.terminals.length, 1);
});

function eventFixture(
  options: Readonly<{
    resolutionUnknownOnce?: boolean;
    outputUnknownOnce?: boolean;
    terminalUnknownOnce?: boolean;
    resolutionUnknownCount?: number;
    resolutionUnknownCountByOutcome?: Readonly<
      Partial<Record<RunDispatchResolutionCommand["outcome"]["kind"], number>>
    >;
    outputUnknownCount?: number;
    terminalUnknownCount?: number;
    recoveryUnavailableCount?: number;
    terminalizeRejectOnce?: boolean;
    limits?: Readonly<{
      maxTrackedAttempts?: number;
      maxBufferedEventsPerAttempt?: number;
      maxPersistedOutputsPerAttempt?: number;
    }>;
  }> = {},
) {
  const resolutions: RunDispatchResolutionCommand[] = [];
  const outputs: RunOutputAppendCommand[] = [];
  const terminals: RunTerminalCommand[] = [];
  const terminalized: Parameters<ApplicationRunDispatchControl["terminalize"]>[0][] = [];
  let terminalCalls = 0;
  let terminalizeCalls = 0;
  let outputCalls = 0;
  let resolutionCalls = 0;
  const resolutionCallsByOutcome: Record<RunDispatchResolutionCommand["outcome"]["kind"], number> = {
    accepted: 0,
    rejected: 0,
    ambiguous: 0,
  };
  let recoveryCalls = 0;
  const reads: ApplicationRunEventReadPort = {
    async recoveryGet(input) {
      recoveryCalls += 1;
      if (recoveryCalls <= (options.recoveryUnavailableCount ?? 0)) {
        throw new Error("recovery unavailable");
      }
      return {
        runId: input.runId,
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        runPhase: "active",
        runUpdatedAt: 1,
        attemptId: "attempt-1",
        attemptOrdinal: 1,
        attemptState: "active",
        externalExecutionId: "turn-1",
        bindingId: "binding-1",
        providerId: "codex",
        persistenceMode: "persistent",
        bindingState: "active",
        externalConversationId: "thread-1",
        dispatchState: "accepted",
        providerIdempotencyKey: null,
      };
    },
    async runGet(input) {
      return {
        sessionId: input.sessionId,
        workspaceKey: input.workspaceKey,
        run: {
          id: input.runId,
          sessionId: input.sessionId,
          phase: "active",
          version: 7,
        },
      } as never;
    },
  };
  const writes: ApplicationRunEventWritePort = {
    async resolveRunDispatch(command) {
      resolutions.push(command);
      resolutionCalls += 1;
      resolutionCallsByOutcome[command.outcome.kind] += 1;
      if (
        (options.resolutionUnknownOnce === true && resolutionCalls === 1) ||
        resolutionCalls <= (options.resolutionUnknownCount ?? 0) ||
        resolutionCallsByOutcome[command.outcome.kind] <=
          (options.resolutionUnknownCountByOutcome?.[command.outcome.kind] ?? 0)
      )
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        bindingId: command.bindingId,
        dispatchState: command.outcome.kind,
        externalExecutionId: command.outcome.kind === "accepted" ? command.outcome.externalExecutionId : null,
        resolvedAt: 10,
      });
    },
    async appendRunOutput(command) {
      outputs.push(command);
      outputCalls += 1;
      if ((options.outputUnknownOnce === true && outputCalls === 1) || outputCalls <= (options.outputUnknownCount ?? 0))
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        outputItemId: command.item.id,
        ordinal: outputs.length,
        payloadState: command.item.payload.state,
        storedByteLength: null,
        createdAt: 20,
      });
    },
    async completeRun(command) {
      terminals.push(command);
      terminalCalls += 1;
      if (
        (options.terminalUnknownOnce === true && terminalCalls === 1) ||
        terminalCalls <= (options.terminalUnknownCount ?? 0)
      )
        throw unknownPersistenceFailure();
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        phase: command.outcome.kind,
        finalAssistantMessageId:
          command.outcome.kind === "completed" ? (command.outcome.finalAssistantMessage?.id ?? null) : null,
        terminalEventId: command.terminalEvent.id,
        childDeliveryId: null,
        delegationState: null,
        terminalAt: 30,
      });
    },
  };
  const service = new ApplicationRunEventService({
    reads,
    writes,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const control: ApplicationRunDispatchControl = {
    adapter: {} as never,
    signal: new AbortController().signal,
    isCurrent: () => true,
    async terminalize(failure) {
      terminalizeCalls += 1;
      terminalized.push(failure);
      if (options.terminalizeRejectOnce === true && terminalizeCalls === 1) {
        throw new Error("terminal persistence failed");
      }
      return true;
    },
  };
  return { service, control, writes, resolutions, outputs, terminals, terminalized };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function dispatch(): ApplicationRunPreparedDispatch {
  return {
    admission: {
      sessionId: "session-1",
      runId: "run-1",
      messageId: "message-1",
      attemptId: "attempt-1",
      bindingId: "binding-1",
      runPhase: "starting",
      bindingState: "active",
      dispatchState: "pending",
      admittedAt: 1,
    },
    workspaceKey: "workspace-1",
    providerId: "codex",
    threadId: "thread-1",
    generationId: "codex-1",
    executionSnapshot: {
      providerId: "codex",
      model: "gpt-5.6",
      modelSelection: "explicit",
      reasoning: { effort: "high" },
      approval: { policy: "never" },
      sandbox: { mode: "workspace-write", networkAccess: false },
      workspace: {
        key: "workspace-1",
        path: process.cwd(),
        allowedAdditionalDirectories: [],
      },
      character: null,
    },
    contentBlocks: [{ type: "text", text: "hello" }],
  };
}

function acceptedTurn(turnId: string) {
  return {
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId, status: "in_progress" },
  } as const;
}

function turnStarted(turnId: string) {
  return {
    kind: "turn_started",
    turn: { threadId: "thread-1", turnId, status: "in_progress" },
  } as const;
}

function itemOutput(itemId: string, summary: string, kind: string, turnId: string = "turn-1") {
  return {
    kind: "item_output",
    threadId: "thread-1",
    turnId,
    itemId,
    output: {
      category: "operation",
      kind,
      summary,
      completionState: "complete",
      payload: { kind: "none", redaction: "not_required" },
    },
  } as const;
}

function success<T>(value: T) {
  return { ok: true, value, replayed: false } as const;
}

function unknownPersistenceFailure(): PersistenceClientError {
  return new PersistenceClientError({
    code: "request_timeout",
    message: "response lost",
    retryable: true,
    effect: "unknown",
  });
}
