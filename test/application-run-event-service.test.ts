import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationRunEventService,
  type ApplicationRunEventReadPort,
  type ApplicationRunEventWritePort,
} from "../src/main/application-run-event-service.js";
import { ApplicationRunDispatchService } from "../src/main/application-run-dispatch-service.js";
import type {
  ApplicationRunBindingOwnership,
  ApplicationRunDispatchControl,
  ApplicationRunPreparedDispatch,
  ApplicationRunProviderAdapterPort,
} from "../src/main/application-run-runtime-service.js";
import { PersistenceClientError } from "../src/main/persistence-worker-client.js";
import type {
  RunDispatchResolutionCommand,
  RunInputBeginCommand,
  RunInputResolutionCommand,
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

test("supplemental input sends once only after a fresh durable begin and persists the accepted outcome", async () => {
  const fixture = eventFixture();
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);

  fixture.service.handoff(inputHandoff(reservation, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 1);
  assert.deepEqual(fixture.steerInputs[0], {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    contentBlocks: [{ type: "text", text: "follow up" }],
  });
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, { kind: "accepted" });
});

test("supplemental input preserves an ephemeral Binding owner token through every Repository Gate", async () => {
  const fixture = eventFixture();
  await activateInputOwner(
    fixture,
    dispatch({
      persistenceMode: "ephemeral",
      ephemeralOwnerToken: EPHEMERAL_OWNER_TOKEN,
    }),
  );
  const reservation = await reserveInput(fixture);

  assert.equal(fixture.resolutions[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(reservation.persistenceMode, "ephemeral");
  assert.equal(reservation.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);

  fixture.service.handoff(inputHandoff(reservation, "input-message-ephemeral", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(fixture.inputResolutions[0]?.ephemeralOwnerToken, EPHEMERAL_OWNER_TOKEN);
  assert.equal(fixture.steerInputs.length, 1);
});

test("a replayed earlier ordinal unblocks a retryable later input without losing its live delivery owner", async () => {
  const fixture = eventFixture({
    async inputBeginOperation(command, call) {
      if (command.messageId === "input-message-later" && call === 1) {
        return {
          ok: false,
          error: {
            code: "lifecycle_conflict",
            message: "An earlier supplemental input is unresolved.",
            retryable: true,
          },
          replayed: false,
        };
      }
      return {
        ok: true,
        replayed: false,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching",
          dispatchingAt: 15,
          sendAllowed: true,
        },
      };
    },
  });
  await activateInputOwner(fixture);

  const later = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(later, "input-message-later", 3, "later"));
  await waitFor(() => fixture.inputBegins.length === 1);

  const earlierReplay = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(earlierReplay, "input-message-earlier", 2, "earlier"));
  await waitFor(() => fixture.steerInputs.length === 2);

  assert.deepEqual(
    fixture.inputBegins.map((command) => command.messageId),
    ["input-message-later", "input-message-earlier", "input-message-later"],
  );
  assert.deepEqual(
    fixture.steerInputs.map((input) => input.contentBlocks),
    [[{ type: "text", text: "earlier" }], [{ type: "text", text: "later" }]],
  );
  assert.deepEqual(
    fixture.inputResolutions.map((command) => command.messageId),
    ["input-message-earlier", "input-message-later"],
  );
});

test("begin replay never sends and converges the dispatching Delivery to ambiguous", async () => {
  for (const options of [{ inputBeginAlreadyCommitted: true }, { inputBeginReplayWithSendAllowed: true }]) {
    const fixture = eventFixture(options);
    await activateInputOwner(fixture);
    const reservation = await reserveInput(fixture);

    fixture.service.handoff(inputHandoff(reservation, "input-message-1", 2));
    await waitFor(() => fixture.inputResolutions.length === 1);

    assert.equal(fixture.steerInputs.length, 0);
    assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
      kind: "ambiguous",
      resolutionCode: "process_unknown",
    });
  }
});

test("duplicate pending handoff is deduplicated while the frozen resolution retries without another Provider call", async () => {
  const fixture = eventFixture({ inputResolutionUnknownCount: 6 });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(first, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length >= 2);

  const replay = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(replay, "input-message-1", 2));
  await waitFor(() => fixture.inputResolutions.length === 7);

  assert.equal(fixture.steerInputs.length, 1);
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("supplemental input maps bounded Provider outcomes without retaining raw Provider codes", async () => {
  const cases = [
    {
      result: { kind: "rejected", effect: "none", code: -32_000 } as const,
      expected: { kind: "rejected", resolutionCode: "provider_rejected" } as const,
    },
    {
      result: { kind: "not_sent", effect: "none", code: "capability_unavailable" } as const,
      expected: { kind: "rejected", resolutionCode: "delivery_not_sent" } as const,
    },
    {
      result: { kind: "ambiguous", effect: "unknown", code: "connection_lost" } as const,
      expected: { kind: "ambiguous", resolutionCode: "transport_unknown" } as const,
    },
    {
      result: { kind: "connection_failure", effect: "unknown", code: "process_exited" } as const,
      expected: { kind: "ambiguous", resolutionCode: "process_unknown" } as const,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const fixture = eventFixture({ steerResult: entry.result });
    await activateInputOwner(fixture);
    const reservation = await reserveInput(fixture);
    fixture.service.handoff(inputHandoff(reservation, `input-message-${index}`, index + 2));
    await waitFor(() => fixture.inputResolutions.length === 1);

    assert.deepEqual(fixture.inputResolutions[0]?.outcome, entry.expected);
    assert.equal(JSON.stringify(fixture.inputResolutions).includes(String(entry.result.code)), false);
  }
});

test("stale owner, waiting promotion, reservation abort, and capacity bounds never transfer input", async () => {
  let current = true;
  const fixture = eventFixture({
    isCurrent: () => current,
    limits: { maxPendingInputsPerAttempt: 1, maxTrackedInputs: 1 },
  });
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);
  const full = await fixture.service.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.error.code, "capacity_exceeded");

  fixture.service.release(reservation);
  const abort = new AbortController();
  const released = await reserveInput(fixture, abort.signal);
  abort.abort();
  const next = await reserveInput(fixture);
  fixture.service.release(next);

  const stale = await reserveInput(fixture);
  current = false;
  fixture.service.handoff(inputHandoff(stale, "input-message-stale", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(released.token === next.token, false);
  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 0);
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
    kind: "rejected",
    resolutionCode: "delivery_not_sent",
  });
  current = true;
  const afterStale = await reserveInput(fixture);
  fixture.service.release(afterStale);

  let promotionCurrent = true;
  const promotion = eventFixture({
    isCurrent: () => promotionCurrent,
    limits: { maxPendingInputsPerAttempt: 2, maxTrackedInputs: 2 },
  });
  await activateInputOwner(promotion);
  const promotionFirst = await reserveInput(promotion);
  const promotionWaiting = promotion.service.preflight({ sessionId: "session-1", runId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  promotionCurrent = false;
  promotion.service.release(promotionFirst);
  const stalePromotion = await promotionWaiting;
  assert.equal(stalePromotion.ok, false);
  assert.equal(!stalePromotion.ok && stalePromotion.error.code, "lifecycle_conflict");
  assert.equal(promotion.inputBegins.length, 0);
  assert.equal(promotion.steerInputs.length, 0);

  promotionCurrent = true;
  const promotionRecovered = await reserveInput(promotion);
  promotion.service.release(promotionRecovered);
});

test("terminal ordering before handoff or after an unresolved send never creates a second external effect", async () => {
  const beforeHandoff = eventFixture();
  const beforeHandle = beforeHandoff.service.register(dispatch(), beforeHandoff.control);
  assert.ok(beforeHandle);
  await beforeHandle.settleStartTurn(acceptedTurn("turn-1"));
  const reserved = await reserveInput(beforeHandoff);
  const waiting = beforeHandoff.service.preflight({ sessionId: "session-1", runId: "run-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await beforeHandoff.service.accept("codex-1", terminalEvent());
  await beforeHandle.done;
  const waitingAfterTerminal = await waiting;
  assert.equal(waitingAfterTerminal.ok, false);
  assert.equal(!waitingAfterTerminal.ok && waitingAfterTerminal.error.code, "lifecycle_conflict");
  beforeHandoff.service.handoff(inputHandoff(reserved, "input-message-before", 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beforeHandoff.inputBegins.length, 0);
  assert.equal(beforeHandoff.steerInputs.length, 0);

  let settleSteer!: (value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>) => void;
  const afterBegin = eventFixture({
    inputResolutionUnknownCount: 100,
    steerOperation: () =>
      new Promise((resolve) => {
        settleSteer = resolve;
      }),
  });
  const afterHandle = afterBegin.service.register(dispatch(), afterBegin.control);
  assert.ok(afterHandle);
  await afterHandle.settleStartTurn(acceptedTurn("turn-1"));
  const afterReservation = await reserveInput(afterBegin);
  afterBegin.service.handoff(inputHandoff(afterReservation, "input-message-after", 2));
  await waitFor(() => afterBegin.steerInputs.length === 1);
  const terminal = afterBegin.service.accept("codex-1", terminalEvent());
  settleSteer({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await terminal;
  await afterHandle.done;
  const resolutionAttempts = afterBegin.inputResolutions.length;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(afterBegin.steerInputs.length, 1);
  assert.equal(afterBegin.inputResolutions.length, resolutionAttempts);
  assert.ok(
    afterBegin.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(afterBegin.inputResolutions[0]),
    ),
  );

  let releaseLeading!: (
    value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>,
  ) => void;
  let queuedSteerCalls = 0;
  const queuedTerminal = eventFixture({
    terminalUnknownCount: 2,
    steerOperation: (input) => {
      queuedSteerCalls += 1;
      if (queuedSteerCalls === 1) {
        return new Promise((resolve) => {
          releaseLeading = resolve;
        });
      }
      return Promise.resolve({
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.expectedTurnId },
      });
    },
  });
  const queuedHandle = queuedTerminal.service.register(dispatch(), queuedTerminal.control);
  assert.ok(queuedHandle);
  await queuedHandle.settleStartTurn(acceptedTurn("turn-1"));
  const leading = await reserveInput(queuedTerminal);
  const followingReservation = reserveInput(queuedTerminal);
  await new Promise((resolve) => setImmediate(resolve));
  queuedTerminal.service.handoff(inputHandoff(leading, "input-message-leading", 2, "leading"));
  const following = await followingReservation;
  queuedTerminal.service.handoff(inputHandoff(following, "input-message-following", 3, "following"));
  await waitFor(() => queuedTerminal.steerInputs.length === 1);
  const queuedTerminalEvent = queuedTerminal.service.accept("codex-1", terminalEvent());
  releaseLeading({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await queuedTerminalEvent;
  const afterTerminalPreflight = await queuedTerminal.service.preflight({
    sessionId: "session-1",
    runId: "run-1",
  });
  assert.equal(afterTerminalPreflight.ok, false);
  assert.equal(!afterTerminalPreflight.ok && afterTerminalPreflight.error.code, "lifecycle_conflict");
  await queuedHandle.done;

  assert.deepEqual(
    queuedTerminal.inputBegins.map((command) => command.messageId),
    ["input-message-leading"],
  );
  assert.equal(queuedTerminal.steerInputs.length, 1);
  assert.equal(queuedTerminal.terminals.length, 3);
  assert.ok(
    queuedTerminal.terminals.every(
      (command) => JSON.stringify(command) === JSON.stringify(queuedTerminal.terminals[0]),
    ),
  );
});

test("terminal convergence preserves an accepted input after its resolution response is lost", async () => {
  let terminal!: Promise<void>;
  let fixture!: ReturnType<typeof eventFixture>;
  fixture = eventFixture({
    inputResolutionOperation(command, call) {
      if (call === 1) {
        terminal = fixture.service.accept("codex-1", terminalEvent());
      }
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve(
        success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: command.outcome.kind,
          resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
          resolvedAt: 16,
        }),
      );
    },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-accepted-before-terminal", 2));

  await terminal;
  await handle.done;

  assert.equal(fixture.steerInputs.length, 1);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.inputDeliveryStates.get("input-message-accepted-before-terminal"), "accepted");
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("terminal convergence persists a not-sent resolution created by a retried begin", async () => {
  let terminal!: Promise<void>;
  let fixture!: ReturnType<typeof eventFixture>;
  fixture = eventFixture({
    inputBeginOperation(command, call) {
      fixture.inputDeliveryStates.set(command.messageId, "dispatching");
      if (call === 1) {
        terminal = fixture.service.accept("codex-1", terminalEvent());
      }
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve({
        ok: true,
        replayed: false,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching",
          dispatchingAt: 15,
          sendAllowed: true,
        },
      });
    },
    inputResolutionOperation(command, call) {
      if (call <= 2) {
        throw unknownPersistenceFailure();
      }
      return Promise.resolve(
        success({
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: command.outcome.kind,
          resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
          resolvedAt: 16,
        }),
      );
    },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-retried-begin-before-terminal", 2));

  await waitFor(() => fixture.inputBegins.length >= 1);
  await terminal;
  await handle.done;

  assert.equal(fixture.steerInputs.length, 0);
  assert.equal(fixture.terminals.length, 1);
  assert.equal(fixture.inputDeliveryStates.get("input-message-retried-begin-before-terminal"), "rejected");
  assert.ok(
    fixture.inputResolutions.every(
      (command) =>
        command.outcome.kind === "rejected" &&
        command.outcome.resolutionCode === "delivery_not_sent" &&
        JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );
});

test("parallel supplemental inputs serialize admission before Message ordinals and release their bounded slots", async () => {
  let releaseFirst!: (value: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>) => void;
  let steerCalls = 0;
  const fixture = eventFixture({
    steerOperation: (input) => {
      steerCalls += 1;
      if (steerCalls === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        kind: "accepted",
        effect: "present",
        value: { threadId: input.threadId, turnId: input.expectedTurnId },
      });
    },
    limits: { maxPendingInputsPerAttempt: 2 },
  });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  const waitingAbort = new AbortController();
  const abortedReservation = fixture.service.preflight(
    { sessionId: "session-1", runId: "run-1" },
    { signal: waitingAbort.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  waitingAbort.abort();
  const aborted = await abortedReservation;
  assert.equal(aborted.ok, false);
  assert.equal(!aborted.ok && aborted.error.code, "lifecycle_conflict");

  let secondReady = false;
  const secondReservation = reserveInput(fixture).then((reservation) => {
    secondReady = true;
    return reservation;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondReady, false);

  fixture.service.handoff(inputHandoff(first, "input-message-1", 2, "first"));
  const second = await secondReservation;
  fixture.service.handoff(inputHandoff(second, "input-message-2", 3, "second"));
  await waitFor(() => fixture.steerInputs.length === 1);
  assert.equal(fixture.steerInputs[0]?.contentBlocks[0]?.text, "first");
  releaseFirst({
    kind: "accepted",
    effect: "present",
    value: { threadId: "thread-1", turnId: "turn-1" },
  });
  await waitFor(() => fixture.steerInputs.length === 2);
  assert.equal(fixture.steerInputs[1]?.contentBlocks[0]?.text, "second");

  const availableAgain = await reserveInput(fixture);
  fixture.service.release(availableAgain);
});

test("a settled supplemental input releases a single pending slot for the next preflight", async () => {
  const fixture = eventFixture({
    limits: { maxPendingInputsPerAttempt: 1 },
  });
  await activateInputOwner(fixture);
  const first = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(first, "input-message-1", 2, "first"));
  await waitFor(() => fixture.inputResolutions.length === 1);

  const second = await reserveInput(fixture);
  fixture.service.release(second);
});

test("a non-terminal input resolution failure retains its pending slot until the Attempt closes", async () => {
  const fixture = eventFixture({
    inputResolutionOperation: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "lifecycle_conflict",
          message: "Run input resolution state changed.",
          retryable: false,
        },
        replayed: false,
      }),
    limits: { maxPendingInputsPerAttempt: 1 },
  });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-blocked", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  const full = await fixture.service.preflight({ sessionId: "session-1", runId: "run-1" });
  assert.equal(full.ok, false);
  assert.equal(!full.ok && full.error.code, "capacity_exceeded");
  if (full.ok || full.error.code !== "capacity_exceeded") throw new Error("input capacity was not preserved");
  assert.equal(full.error.details.current, 1);

  await fixture.service.accept("codex-1", terminalEvent());
  await handle.done;
  assert.equal(fixture.terminals.length, 1);
});

test("a stale owner detected after durable begin resolves not-sent without calling Provider", async () => {
  let current = true;
  const fixture = eventFixture({
    isCurrent: () => current,
    afterInputBegin: () => {
      current = false;
    },
  });
  await activateInputOwner(fixture);
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-stale-after-begin", 2));
  await waitFor(() => fixture.inputResolutions.length === 1);

  assert.equal(fixture.inputBegins.length, 1);
  assert.equal(fixture.steerInputs.length, 0);
  assert.deepEqual(fixture.inputResolutions[0]?.outcome, {
    kind: "rejected",
    resolutionCode: "delivery_not_sent",
  });
});

test("generation release retains a frozen input resolution until persistence closure succeeds", async () => {
  const fixture = eventFixture({ inputResolutionUnknownCount: 4 });
  const handle = fixture.service.register(dispatch(), fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
  const reservation = await reserveInput(fixture);
  fixture.service.handoff(inputHandoff(reservation, "input-message-shutdown", 2));
  await waitFor(() => fixture.inputResolutions.length === 2);

  await assert.rejects(
    fixture.service.releaseGeneration("codex-1", { kind: "shutdown" }),
    /persistence outcome is still unknown/u,
  );
  await waitFor(() => fixture.inputResolutions.length === 5);
  assert.equal(fixture.steerInputs.length, 1);
  assert.ok(
    fixture.inputResolutions.every(
      (command) => JSON.stringify(command) === JSON.stringify(fixture.inputResolutions[0]),
    ),
  );

  await waitFor(() => fixture.terminals.length === 1);
  await handle.done;
  assert.equal(fixture.terminals.length, 1);
});

async function activateInputOwner(
  fixture: ReturnType<typeof eventFixture>,
  preparedDispatch = dispatch(),
): Promise<void> {
  const handle = fixture.service.register(preparedDispatch, fixture.control);
  assert.ok(handle);
  await handle.settleStartTurn(acceptedTurn("turn-1"));
}

async function reserveInput(fixture: ReturnType<typeof eventFixture>, signal?: AbortSignal) {
  const result = await fixture.service.preflight(
    { sessionId: "session-1", runId: "run-1" },
    signal === undefined ? undefined : { signal },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("input reservation failed");
  return result.value;
}

function inputHandoff(
  reservation: Awaited<ReturnType<typeof reserveInput>>,
  messageId: string,
  messageOrdinal: number,
  text = "follow up",
) {
  return {
    reservation,
    sessionId: reservation.sessionId,
    runId: reservation.runId,
    attemptId: reservation.attemptId,
    messageId,
    messageOrdinal,
    bindingId: reservation.bindingId,
    admittedAt: 10,
    contentBlocks: [{ type: "text", text }] as const,
  };
}

function terminalEvent() {
  return {
    kind: "turn_terminal",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAssistantMessage: null,
    contentFailure: null,
  } as const;
}

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
    inputBeginAlreadyCommitted?: boolean;
    inputBeginReplayWithSendAllowed?: boolean;
    inputBeginUnknownCount?: number;
    inputBeginOperation?: (
      command: RunInputBeginCommand,
      call: number,
    ) => ReturnType<ApplicationRunEventWritePort["beginRunInput"]>;
    inputResolutionUnknownCount?: number;
    inputResolutionOperation?: (
      command: RunInputResolutionCommand,
      call: number,
    ) => ReturnType<ApplicationRunEventWritePort["resolveRunInput"]>;
    steerResult?: Awaited<ReturnType<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>>;
    steerOperation?: NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>;
    isCurrent?: () => boolean;
    afterInputBegin?: () => void;
    limits?: Readonly<{
      maxTrackedAttempts?: number;
      maxBufferedEventsPerAttempt?: number;
      maxPersistedOutputsPerAttempt?: number;
      maxPendingInputsPerAttempt?: number;
      maxTrackedInputs?: number;
    }>;
  }> = {},
) {
  const resolutions: RunDispatchResolutionCommand[] = [];
  const outputs: RunOutputAppendCommand[] = [];
  const inputBegins: RunInputBeginCommand[] = [];
  const inputResolutions: RunInputResolutionCommand[] = [];
  const inputDeliveryStates = new Map<string, "dispatching" | RunInputResolutionCommand["outcome"]["kind"]>();
  const terminals: RunTerminalCommand[] = [];
  const terminalized: Parameters<ApplicationRunDispatchControl["terminalize"]>[0][] = [];
  let terminalCalls = 0;
  let terminalizeCalls = 0;
  let outputCalls = 0;
  let resolutionCalls = 0;
  let inputBeginCalls = 0;
  const committedInputMessages = new Set<string>();
  let inputResolutionCalls = 0;
  const steerInputs: Parameters<NonNullable<ApplicationRunProviderAdapterPort["steerTurn"]>>[0][] = [];
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
    async beginRunInput(command) {
      inputBegins.push(command);
      inputBeginCalls += 1;
      if (options.inputBeginOperation !== undefined) {
        return options.inputBeginOperation(command, inputBeginCalls);
      }
      if (inputBeginCalls <= (options.inputBeginUnknownCount ?? 0)) {
        committedInputMessages.add(command.messageId);
        throw unknownPersistenceFailure();
      }
      const sendAllowed = options.inputBeginAlreadyCommitted !== true && !committedInputMessages.has(command.messageId);
      committedInputMessages.add(command.messageId);
      inputDeliveryStates.set(command.messageId, "dispatching");
      options.afterInputBegin?.();
      return {
        ok: true,
        replayed: options.inputBeginReplayWithSendAllowed === true || !sendAllowed,
        value: {
          sessionId: command.sessionId,
          runId: command.runId,
          attemptId: command.attemptId,
          messageId: command.messageId,
          bindingId: command.bindingId,
          deliveryState: "dispatching" as const,
          dispatchingAt: 15,
          sendAllowed: options.inputBeginReplayWithSendAllowed === true || sendAllowed,
        },
      } as const;
    },
    async resolveRunInput(command) {
      inputResolutions.push(command);
      inputResolutionCalls += 1;
      if (options.inputResolutionOperation !== undefined) {
        const result = await options.inputResolutionOperation(command, inputResolutionCalls);
        if (result.ok) inputDeliveryStates.set(command.messageId, command.outcome.kind);
        return result;
      }
      if (inputResolutionCalls <= (options.inputResolutionUnknownCount ?? 0)) throw unknownPersistenceFailure();
      inputDeliveryStates.set(command.messageId, command.outcome.kind);
      return success({
        sessionId: command.sessionId,
        runId: command.runId,
        attemptId: command.attemptId,
        messageId: command.messageId,
        bindingId: command.bindingId,
        deliveryState: command.outcome.kind,
        resolutionCode: command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode,
        resolvedAt: 16,
      });
    },
    async completeRun(command) {
      terminals.push(command);
      terminalCalls += 1;
      for (const [messageId, state] of inputDeliveryStates) {
        if (state === "dispatching") inputDeliveryStates.set(messageId, "ambiguous");
      }
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
    adapter: {
      async steerTurn(input) {
        steerInputs.push(input);
        if (options.steerOperation !== undefined) return options.steerOperation(input);
        return (
          options.steerResult ?? {
            kind: "accepted",
            effect: "present",
            value: { threadId: input.threadId, turnId: input.expectedTurnId },
          }
        );
      },
    } as ApplicationRunProviderAdapterPort,
    signal: new AbortController().signal,
    isCurrent: options.isCurrent ?? (() => true),
    async terminalize(failure) {
      terminalizeCalls += 1;
      terminalized.push(failure);
      if (options.terminalizeRejectOnce === true && terminalizeCalls === 1) {
        throw new Error("terminal persistence failed");
      }
      return true;
    },
  };
  return {
    service,
    control,
    writes,
    resolutions,
    inputBegins,
    inputResolutions,
    inputDeliveryStates,
    steerInputs,
    outputs,
    terminals,
    terminalized,
  };
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

function dispatch(
  ownership: ApplicationRunBindingOwnership = { persistenceMode: "persistent", ephemeralOwnerToken: null },
): ApplicationRunPreparedDispatch {
  const prepared: Omit<ApplicationRunPreparedDispatch, "persistenceMode" | "ephemeralOwnerToken"> = {
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
  return ownership.persistenceMode === "persistent"
    ? { ...prepared, persistenceMode: "persistent", ephemeralOwnerToken: null }
    : {
        ...prepared,
        persistenceMode: "ephemeral",
        ephemeralOwnerToken: ownership.ephemeralOwnerToken,
      };
}

const EPHEMERAL_OWNER_TOKEN = "018f1f4e-7f0a-7000-8000-000000000901";

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
