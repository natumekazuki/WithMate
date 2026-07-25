import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_ADAPTER_LIMITS, type CodexAdapterEvent } from "../src/main/providers/codex/index.js";
import { CodexAdapterItemMapper } from "../src/main/providers/codex/codex-adapter-items.js";
import type { CodexValidatedItem } from "../src/main/providers/codex/codex-adapter-validation.js";
import { assertBoundedPublicSummary } from "./codex-adapter-test-support.js";

test("completed agent text is authoritative and commentary becomes assistant detail", () => {
  const mapper = readyMapper();
  mapper.acceptItemStarted("thread-1", "turn-1", agent("item-1", "", "commentary"));
  mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "draft");

  const completed = mapper.acceptItemCompleted("thread-1", "turn-1", agent("item-1", "authoritative", "commentary"));
  assert.deepEqual(eventKinds(completed.events), ["diagnostic", "item_output"]);
  assert.equal(diagnosticCodes(completed.events)[0], "draft_mismatch");
  const output = itemOutputs(completed.events)[0];
  assert.ok(output);
  const { summary, ...assistantDetail } = output.output;
  assertBoundedPublicSummary(summary);
  assert.deepEqual(assistantDetail, {
    category: "assistant_detail",
    kind: "agent_commentary",
    completionState: "complete",
    payload: {
      kind: "text",
      text: "authoritative",
      originalByteLength: 13,
      redaction: "undetermined",
    },
  });
  assert.equal(mapper.snapshot().retainedTextBytes, 0);
});

test("agent deltas concatenate in arrival order without a mismatch when completion agrees", () => {
  const mapper = readyMapper();
  mapper.acceptItemStarted("thread-1", "turn-1", agent("item-1", "", "commentary"));
  mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "first ");
  mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "second");

  const completed = mapper.acceptItemCompleted("thread-1", "turn-1", agent("item-1", "first second", "commentary"));
  assert.deepEqual(diagnosticCodes(completed.events), []);
  assert.equal(itemOutputs(completed.events)[0]?.output.payload.kind, "text");
});

test("multiple explicit final items preserve content block boundaries until successful terminal", () => {
  const mapper = readyMapper();
  completeAgent(mapper, "final-1", "first", "final_answer");
  completeAgent(mapper, "final-2", "second", "final_answer");
  assert.equal(mapper.snapshot().retainedTextBytes, 11);

  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.deepEqual(terminal.finalAssistantMessage, {
    contentBlocks: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  });
  assert.equal(terminal.contentFailure, null);
  assert.deepEqual(terminal.events, []);
  assert.deepEqual(mapper.snapshot(), {
    failed: false,
    trackedThreads: 0,
    trackedTurns: 0,
    trackedItems: 0,
    retainedTextBytes: 0,
  });
});

test("explicit final wins over phase-null items and null items remain details", () => {
  const mapper = readyMapper();
  completeAgent(mapper, "unknown", "unknown detail", null);
  completeAgent(mapper, "explicit", "explicit final", "final_answer");

  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.deepEqual(terminal.finalAssistantMessage, {
    contentBlocks: [{ type: "text", text: "explicit final" }],
  });
  assert.deepEqual(eventKinds(terminal.events), ["item_output"]);
  assert.equal(itemOutputs(terminal.events)[0]?.itemId, "unknown");
  assert.deepEqual(diagnosticCodes(terminal.events), []);
});

test("phase-null fallback selects only the last non-empty item and records version/model", () => {
  const mapper = readyMapper();
  completeAgent(mapper, "unknown-1", "detail one", null);
  completeAgent(mapper, "empty", "", null);
  completeAgent(mapper, "unknown-2", "detail two", null);
  completeAgent(mapper, "unknown-3", "final fallback", null);

  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.deepEqual(terminal.finalAssistantMessage, {
    contentBlocks: [{ type: "text", text: "final fallback" }],
  });
  assert.deepEqual(
    itemOutputs(terminal.events).map((event) => event.itemId),
    ["unknown-1", "unknown-2"],
  );
  const fallback = terminal.events.find((event) => event.kind === "diagnostic");
  assert.equal(fallback?.kind, "diagnostic");
  if (fallback?.kind !== "diagnostic") assert.fail("expected phase fallback diagnostic");
  const { summary: fallbackSummary, ...diagnostic } = fallback.diagnostic;
  assertBoundedPublicSummary(fallbackSummary);
  assert.deepEqual(diagnostic, {
    code: "phase_fallback",
    cliVersion: "0.145.0",
    model: "gpt-5.4",
    redaction: "not_required",
  });
});

test("empty or absent phase-null content does not create a final message or fallback diagnostic", () => {
  const empty = readyMapper();
  completeAgent(empty, "empty", "", null);
  const emptyTerminal = empty.completeTurn("thread-1", "turn-1", "completed");
  assert.equal(emptyTerminal.finalAssistantMessage, null);
  assert.deepEqual(emptyTerminal.events, []);

  const absent = readyMapper();
  const absentTerminal = absent.completeTurn("thread-1", "turn-1", "completed");
  assert.equal(absentTerminal.finalAssistantMessage, null);
  assert.deepEqual(absentTerminal.events, []);
});

test("failed and interrupted Turns demote every final candidate to partial detail", () => {
  for (const status of ["failed", "interrupted"] as const) {
    const mapper = readyMapper();
    completeAgent(mapper, "explicit", "not final", "final_answer");
    completeAgent(mapper, "unknown", "also partial", null);
    const terminal = mapper.completeTurn("thread-1", "turn-1", status);
    assert.equal(terminal.finalAssistantMessage, null);
    assert.deepEqual(
      itemOutputs(terminal.events).map((event) => event.output.completionState),
      ["partial", "partial"],
    );
  }
});

test("started, delta, and completed ordering violations never mutate another item or Turn", () => {
  const mapper = readyMapper();
  mapper.beginTurn("thread-2", "turn-2", "0.145.0", "gpt-5.4");
  assert.equal(
    diagnosticCodes(mapper.acceptAgentDelta("thread-1", "turn-1", "missing", "delta").events)[0],
    "out_of_order_event",
  );
  assert.equal(
    diagnosticCodes(mapper.acceptItemCompleted("thread-1", "turn-1", agent("missing", "text", "commentary")).events)[0],
    "out_of_order_event",
  );

  mapper.acceptItemStarted("thread-1", "turn-1", agent("item-1", "", null));
  assert.equal(
    diagnosticCodes(mapper.acceptAgentDelta("thread-2", "turn-2", "item-1", "wrong turn").events)[0],
    "out_of_order_event",
  );
  mapper.acceptItemCompleted("thread-1", "turn-1", agent("item-1", "done", null));
  assert.equal(
    diagnosticCodes(mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "late").events)[0],
    "out_of_order_event",
  );
  assert.equal(
    diagnosticCodes(mapper.acceptItemCompleted("thread-1", "turn-1", agent("item-1", "done", null)).events)[0],
    "duplicate_event",
  );
  assert.equal(mapper.snapshot().retainedTextBytes, 4);
});

test("plan, reasoning, operation, and unsupported items map without raw operation payloads", () => {
  const mapper = readyMapper();
  const items: CodexValidatedItem[] = [
    { classification: "plan", id: "plan", text: "plan text" },
    { classification: "reasoning", id: "reasoning", summary: ["summary"], content: ["detail"] },
    {
      classification: "operation",
      id: "operation",
      itemType: "commandExecution",
      status: "completed",
    },
    { classification: "unsupported", id: "future", itemType: "futureItem" },
  ];
  const events: CodexAdapterEvent[] = [];
  for (const item of items) {
    mapper.acceptItemStarted("thread-1", "turn-1", item);
    events.push(...mapper.acceptItemCompleted("thread-1", "turn-1", item).events);
  }
  const outputs = itemOutputs(events);
  assert.deepEqual(
    outputs.map((event) => event.output.category),
    ["assistant_detail", "assistant_detail", "operation", "provider_metadata"],
  );
  assert.deepEqual(outputs[2]?.output.payload, { kind: "none", redaction: "not_required" });
  assert.doesNotMatch(JSON.stringify(outputs[2]), /command output|private|secret|Users/u);
  assert.deepEqual(diagnosticCodes(events), ["unknown_item"]);
  const unknownDiagnostic = events.find(
    (event): event is Extract<CodexAdapterEvent, { kind: "diagnostic" }> =>
      event.kind === "diagnostic" && event.diagnostic.code === "unknown_item",
  );
  assert.deepEqual(unknownDiagnostic?.diagnostic.correlation, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "future",
  });
});

test("draft overflow releases retained text and authoritative completion may still win", () => {
  const mapper = readyMapper();
  mapper.acceptItemStarted("thread-1", "turn-1", agent("item-1", "", null));
  assert.deepEqual(
    mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes)),
    { events: [], fatal: false },
  );
  const overflow = mapper.acceptAgentDelta("thread-1", "turn-1", "item-1", "x");
  assert.equal(diagnosticCodes(overflow.events)[0], "resource_limit");
  assert.equal(mapper.snapshot().retainedTextBytes, 0);

  mapper.acceptItemCompleted("thread-1", "turn-1", agent("item-1", "authoritative", null));
  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.deepEqual(terminal.finalAssistantMessage, {
    contentBlocks: [{ type: "text", text: "authoritative" }],
  });
});

test("final Message JSON overflow reports content failure without truncation", () => {
  const mapper = readyMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 4; index += 1) completeAgent(mapper, `item-${index}`, chunk, "final_answer");
  assert.equal(mapper.snapshot().retainedTextBytes, CODEX_ADAPTER_LIMITS.maxTurnTextBytes);

  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.equal(terminal.finalAssistantMessage, null);
  assert.deepEqual(terminal.contentFailure, { code: "size_limit" });
  assert.equal(itemOutputs(terminal.events).length, 4);
  assert.ok(itemOutputs(terminal.events).every((event) => event.output.payload.kind === "omitted"));
});

test("Turn aggregate overflow omits candidates and preserves Provider terminal separately", () => {
  const mapper = readyMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 4; index += 1) completeAgent(mapper, `item-${index}`, chunk, "final_answer");
  mapper.acceptItemStarted("thread-1", "turn-1", agent("overflow", "", "final_answer"));
  const overflow = mapper.acceptItemCompleted("thread-1", "turn-1", agent("overflow", "y", "final_answer"));
  assert.equal(diagnosticCodes(overflow.events)[0], "resource_limit");
  assert.equal(mapper.snapshot().retainedTextBytes, 0);

  const terminal = mapper.completeTurn("thread-1", "turn-1", "completed");
  assert.equal(terminal.finalAssistantMessage, null);
  assert.deepEqual(terminal.contentFailure, { code: "size_limit" });
});

test("Turn output aggregate remains cumulative after commentary events leave the mapper", () => {
  const mapper = readyMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 4; index += 1) {
    const itemId = `commentary-${index}`;
    mapper.acceptItemStarted("thread-1", "turn-1", agent(itemId, "", "commentary"));
    const completed = mapper.acceptItemCompleted("thread-1", "turn-1", agent(itemId, chunk, "commentary"));
    assert.equal(itemOutputs(completed.events)[0]?.output.payload.kind, "text");
  }

  mapper.acceptItemStarted("thread-1", "turn-1", agent("overflow", "", "commentary"));
  const overflow = mapper.acceptItemCompleted("thread-1", "turn-1", agent("overflow", "y", "commentary"));
  assert.equal(itemOutputs(overflow.events)[0]?.output.payload.kind, "omitted");
  assert.deepEqual(diagnosticCodes(overflow.events), ["resource_limit"]);

  mapper.acceptItemStarted("thread-1", "turn-1", agent("draft", "", "final_answer"));
  assert.deepEqual(diagnosticCodes(mapper.acceptAgentDelta("thread-1", "turn-1", "draft", "z").events), [
    "resource_limit",
  ]);
});

test("plan and reasoning outputs share the cumulative Turn text budget", () => {
  const mapper = readyMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 3; index += 1) {
    const itemId = `commentary-${index}`;
    mapper.acceptItemStarted("thread-1", "turn-1", agent(itemId, "", "commentary"));
    mapper.acceptItemCompleted("thread-1", "turn-1", agent(itemId, chunk, "commentary"));
  }
  const plan: CodexValidatedItem = { classification: "plan", id: "plan", text: chunk };
  mapper.acceptItemStarted("thread-1", "turn-1", plan);
  assert.equal(
    itemOutputs(mapper.acceptItemCompleted("thread-1", "turn-1", plan).events)[0]?.output.payload.kind,
    "text",
  );

  const reasoning: CodexValidatedItem = {
    classification: "reasoning",
    id: "reasoning",
    summary: ["overflow"],
    content: [],
  };
  mapper.acceptItemStarted("thread-1", "turn-1", reasoning);
  const overflow = mapper.acceptItemCompleted("thread-1", "turn-1", reasoning);
  assert.equal(itemOutputs(overflow.events)[0]?.output.payload.kind, "omitted");
  assert.deepEqual(diagnosticCodes(overflow.events), ["resource_limit"]);
});

test("connection text overflow is fatal and release clears every item owner", () => {
  const mapper = new CodexAdapterItemMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 32; index += 1) {
    const threadId = `thread-${index}`;
    const turnId = `turn-${index}`;
    mapper.beginTurn(threadId, turnId, "0.145.0", "gpt-5.4");
    mapper.acceptItemStarted(threadId, turnId, agent("item", "", "final_answer"));
    assert.equal(mapper.acceptItemCompleted(threadId, turnId, agent("item", chunk, "final_answer")).fatal, false);
  }
  mapper.beginTurn("thread-overflow", "turn-overflow", "0.145.0", "gpt-5.4");
  mapper.acceptItemStarted("thread-overflow", "turn-overflow", agent("item", "", "final_answer"));
  const overflow = mapper.acceptItemCompleted("thread-overflow", "turn-overflow", agent("item", chunk, "final_answer"));
  assert.equal(overflow.fatal, true);
  assert.deepEqual(eventKinds(overflow.events), ["diagnostic", "connection_failure"]);
  assert.equal(mapper.snapshot().retainedTextBytes, CODEX_ADAPTER_LIMITS.maxConnectionTextBytes);

  mapper.release();
  assert.deepEqual(mapper.snapshot(), {
    failed: true,
    trackedThreads: 0,
    trackedTurns: 0,
    trackedItems: 0,
    retainedTextBytes: 0,
  });
});

test("Turn overflow releases its candidates before the connection limit is evaluated", () => {
  const mapper = new CodexAdapterItemMapper();
  const chunk = "x".repeat(CODEX_ADAPTER_LIMITS.maxItemTextBytes);
  for (let index = 0; index < 7; index += 1) {
    const threadId = `other-thread-${index}`;
    const turnId = `other-turn-${index}`;
    mapper.beginTurn(threadId, turnId, "0.145.0", "gpt-5.4");
    for (let itemIndex = 0; itemIndex < 4; itemIndex += 1) {
      const itemId = `item-${itemIndex}`;
      mapper.acceptItemStarted(threadId, turnId, agent(itemId, "", "final_answer"));
      mapper.acceptItemCompleted(threadId, turnId, agent(itemId, chunk, "final_answer"));
    }
  }
  mapper.beginTurn("target-thread", "target-turn", "0.145.0", "gpt-5.4");
  for (let itemIndex = 0; itemIndex < 4; itemIndex += 1) {
    const itemId = `target-${itemIndex}`;
    mapper.acceptItemStarted("target-thread", "target-turn", agent(itemId, "", "final_answer"));
    mapper.acceptItemCompleted("target-thread", "target-turn", agent(itemId, chunk, "final_answer"));
  }
  mapper.acceptItemStarted("target-thread", "target-turn", agent("overflow", "", "final_answer"));

  const overflow = mapper.acceptItemCompleted("target-thread", "target-turn", agent("overflow", "y", "final_answer"));
  assert.equal(overflow.fatal, false);
  assert.equal(diagnosticCodes(overflow.events)[0], "resource_limit");
  assert.equal(mapper.snapshot().retainedTextBytes, 7 * CODEX_ADAPTER_LIMITS.maxTurnTextBytes);
  assert.deepEqual(mapper.completeTurn("target-thread", "target-turn", "completed").contentFailure, {
    code: "size_limit",
  });
});

function readyMapper(): CodexAdapterItemMapper {
  const mapper = new CodexAdapterItemMapper();
  mapper.beginTurn("thread-1", "turn-1", "0.145.0", "gpt-5.4");
  return mapper;
}

function completeAgent(
  mapper: CodexAdapterItemMapper,
  id: string,
  text: string,
  phase: "commentary" | "final_answer" | null,
): void {
  mapper.acceptItemStarted("thread-1", "turn-1", agent(id, "", phase));
  mapper.acceptItemCompleted("thread-1", "turn-1", agent(id, text, phase));
}

function agent(
  id: string,
  text: string,
  phase: "commentary" | "final_answer" | null,
): Extract<CodexValidatedItem, { classification: "agentMessage" }> {
  return Object.freeze({ classification: "agentMessage", id, text, phase });
}

function eventKinds(events: readonly CodexAdapterEvent[]): string[] {
  return events.map((event) => event.kind);
}

function diagnosticCodes(events: readonly CodexAdapterEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "diagnostic" ? [event.diagnostic.code] : []));
}

function itemOutputs(events: readonly CodexAdapterEvent[]): Array<Extract<CodexAdapterEvent, { kind: "item_output" }>> {
  return events.filter(
    (event): event is Extract<CodexAdapterEvent, { kind: "item_output" }> => event.kind === "item_output",
  );
}
