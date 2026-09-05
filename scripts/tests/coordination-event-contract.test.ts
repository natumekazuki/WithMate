import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CoordinationEventValidationError,
  validateCoordinationEventOptions,
  validateCoordinationEventPayload,
  initialCoordinationEventState,
  parseCoordinationEventTrustedResolveInput,
  parseCoordinationEventTrustedListInput,
} from "../../src/coordination-event.js";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";

describe("Coordination event contract", () => {
  // @test-value v1
  // kind = "contract"
  // claim = "Agent向けCoordination operationはrevisionを含むstrict inputとkind固有fieldを検証する"
  // oracle = { type = "contract", ref = "AUTONOMY-MUTATION-05" }
  // failure_mode = "createまたはmutationがrevisionなしで通る、またはkind外fieldとunknown fieldを受理する"
  // scope = "session runtime coordination input parser"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-EVENT-01: kindごとのfield組合せとunknown fieldをstrictに検証する", () => {
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1,
      kind: "progress",
      payload: { summary: "検証を開始した" },
      idempotencyKey: "create-1",
    }), {
      expectedContainerRevision: 1,
      kind: "progress",
      payload: { summary: "検証を開始した" },
      idempotencyKey: "create-1",
    });
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1,
      kind: "progress",
      payload: { summary: "検証を開始した" },
      targetSessionId: "session-parent",
      idempotencyKey: "create-2",
    }), /targetSessionId/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1,
      kind: "user_decision_required",
      payload: { summary: "方針を選んでください" },
      idempotencyKey: "create-3",
    }), /options/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1,
      kind: "progress",
      payload: { summary: "検証を開始した", rawLog: "private" },
      idempotencyKey: "create-4",
    }), /Unknown field/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.get", {
      eventId: "event-1",
      idempotencyKey: "create-1",
    }), /Exactly one/);
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.resolve", {
      eventId: "event-1",
      expectedRevision: 0,
      idempotencyKey: "resolve-1",
    }), { eventId: "event-1", expectedRevision: 0, idempotencyKey: "resolve-1" });
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.resolve", {
      eventId: "event-1",
      expectedRevision: 0,
      optionId: "a",
      idempotencyKey: "resolve-2",
    }), /Unknown field/);
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.resolve", {
      eventId: "event-1",
      expectedRevision: 0,
      note: "自由回答",
      idempotencyKey: "resolve-3",
    }), { eventId: "event-1", expectedRevision: 0, note: "自由回答", idempotencyKey: "resolve-3" });
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.consume", {
      eventId: "event-1",
      expectedResolutionSequence: 7,
      idempotencyKey: "consume-1",
    }), { eventId: "event-1", expectedResolutionSequence: 7, idempotencyKey: "consume-1" });
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.consume", {
      eventId: "event-1",
      expectedResolutionSequence: 7,
      note: "unknown",
      idempotencyKey: "consume-2",
    }), /Unknown field/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.consume", {
      eventId: "event-1",
      idempotencyKey: "consume-3",
    }), /expectedResolutionSequence/);
    for (const kind of ["progress", "decision", "blocker", "result"] as const) {
      const parsed = parseSessionRuntimeOperationInput("coordination.event.create", {
        expectedContainerRevision: 1, kind, payload: { summary: kind }, idempotencyKey: `create-${kind}`,
      }) as { kind: string };
      assert.equal(parsed.kind, kind);
    }
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1, kind: "escalation", payload: { summary: "escalate" }, targetSessionId: "ancestor-1", idempotencyKey: "escalate",
    }) as { kind: string }).kind, "escalation");
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.create", {
      expectedContainerRevision: 1, kind: "user_decision_required", payload: { summary: "choose" },
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], idempotencyKey: "choose",
    }) as { kind: string }).kind, "user_decision_required");
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.correct", {
      eventId: "event-1", expectedRevision: 0, payload: { summary: "corrected" }, idempotencyKey: "correct",
    }) as { eventId: string }).eventId, "event-1");
    assert.deepEqual([
      initialCoordinationEventState("progress"),
      initialCoordinationEventState("decision"),
      initialCoordinationEventState("result"),
      initialCoordinationEventState("correction"),
      initialCoordinationEventState("escalation"),
      initialCoordinationEventState("user_decision_required"),
      initialCoordinationEventState("blocker"),
    ], ["recorded", "recorded", "recorded", "recorded", "open", "open", "open"]);
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.list", { scope: "self" }) as { limit: number }).limit, 50);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.list", { scope: "self", limit: 101 }), /limit/i);
  });

  // @test-value v1
  // kind = "security"
  // claim = "Coordination payload、option、noteはcanonical validatorでsecret、private path、size超過を拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260821-coordination-event-api/plan.md#COORD-EVENT-01" }
  // failure_mode = "Agent/GUI境界からsecretやprivate pathをCoordination履歴へ永続化する"
  // scope = "coordination content validation"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-EVENT-01: payload、option、secret/pathの上限をcanonical validatorで拒否する", () => {
    assert.throws(
      () => validateCoordinationEventPayload({ summary: "x".repeat(241) }),
      (error) => error instanceof CoordinationEventValidationError,
    );
    assert.throws(
      () => validateCoordinationEventPayload({ summary: "C:\\Users\\someone\\private.txt を確認" }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
    assert.throws(
      () => validateCoordinationEventPayload({
        summary: "上限確認",
        facts: Array.from({ length: 8 }, () => "あ".repeat(500)),
        assumptions: Array.from({ length: 8 }, () => "い".repeat(500)),
        impact: "う".repeat(1_000),
        recommendation: "え".repeat(1_000),
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "CONTENT_TOO_LARGE",
    );
    assert.throws(() => validateCoordinationEventOptions([
      { id: "same", label: "A" },
      { id: "same", label: "B" },
    ]), /unique/);
    for (const secret of [
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      "password=correct-horse-battery-staple",
      "client_secret: confidential-value",
      "AWS_SECRET_ACCESS_KEY=plain-value",
      "OPENAI_API_KEY=plain-value",
      "F:\\Company\\Client-X\\secret.txt",
      "\\\\server\\private-share\\file.txt",
      "//server/private-share/file.txt",
      "path=//server/private-share/file.txt",
      "\\\\?\\UNC\\server\\private-share\\file.txt",
    ]) {
      assert.throws(
        () => validateCoordinationEventPayload({ summary: secret }),
        (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
      );
    }
    assert.deepEqual(
      validateCoordinationEventPayload({
        summary: "https://server.example/share/file.txt と tokenization=enabled、TOKEN_POLICY=enabled、PASSWORD_POLICY=strict を確認",
      }),
      {
        summary: "https://server.example/share/file.txt と tokenization=enabled、TOKEN_POLICY=enabled、PASSWORD_POLICY=strict を確認",
      },
    );
    assert.throws(
      () => validateCoordinationEventOptions([
        { id: "safe", label: "C:\\Users\\someone\\private.txt" },
        { id: "other", label: "安全側" },
      ]),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
    assert.throws(
      () => parseSessionRuntimeOperationInput("coordination.event.create", {
        expectedContainerRevision: 1,
        kind: "progress",
        payload: { summary: "key=-----BEGIN ENCRYPTED PRIVATE KEY-----" },
        idempotencyKey: "encrypted-key",
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
    assert.throws(
      () => parseSessionRuntimeOperationInput("coordination.event.create", {
        expectedContainerRevision: 1,
        kind: "user_decision_required",
        payload: { summary: "選択" },
        options: [
          { id: "private", label: "private", description: "path=C:\\Users\\someone\\secret.txt" },
          { id: "safe", label: "安全側" },
        ],
        idempotencyKey: "option-path",
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
    assert.throws(
      () => parseSessionRuntimeOperationInput("coordination.event.cancel", {
        eventId: "event-1",
        expectedRevision: 0,
        note: "[local](C:\\Users\\someone\\secret.txt)",
        idempotencyKey: "note-path",
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
  });

  // @test-value v1
  // kind = "contract"
  // claim = "trusted GUI listは全Session既定とserver-side filterを保持し、Agent scope fieldを受理しない"
  // oracle = { type = "contract", ref = "docs/adr/027-coordination-event-api.md" }
  // failure_mode = "GUI feedがAgent scopeへ狭まり、別rootの回答待ちを表示できない"
  // scope = "trusted Coordination list parser"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-FEED-02: trusted GUI listは全Sessionを既定にし、server-side Session filterを検証する", () => {
    assert.deepEqual(parseCoordinationEventTrustedListInput({}), { limit: 50 });
    assert.deepEqual(parseCoordinationEventTrustedListInput({ sessionId: "session-a", state: "open", limit: 25 }), {
      sessionId: "session-a",
      state: "open",
      limit: 25,
    });
    assert.deepEqual(parseCoordinationEventTrustedListInput({ category: "needs_answer" }), {
      category: "needs_answer",
      limit: 50,
    });
    assert.throws(() => parseCoordinationEventTrustedListInput({ category: "needs_answer", state: "open" }), /cannot be combined/);
    assert.throws(() => parseCoordinationEventTrustedListInput({ category: "actionable" }), /category is invalid/);
    assert.throws(() => parseCoordinationEventTrustedListInput({ scope: "subtree" }), /Unknown field/);
    assert.throws(() => parseCoordinationEventTrustedListInput({ limit: 101 }), /limit/i);
  });

  // @test-value v1
  // kind = "security"
  // claim = "Agent resolveとtrusted GUI user responseはrevision付きの別入力surfaceとして検証する"
  // oracle = { type = "contract", ref = "AUTONOMY-USER-01 / AUTONOMY-MUTATION-05" }
  // failure_mode = "Agent surfaceからoption回答を作る、またはstale GUI回答をrevisionなしで受理する"
  // scope = "coordination resolve input parsers"
  // lifecycle = "permanent"
  // @end-test-value
  it("COORD-RESOLVE-SURFACE-01: agent解決とtrusted GUI回答の入力契約を分離する", () => {
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.resolve", {
      eventId: "blocker-1",
      expectedRevision: 0,
      idempotencyKey: "resolve-blocker-1",
    }), {
      eventId: "blocker-1",
      expectedRevision: 0,
      idempotencyKey: "resolve-blocker-1",
    });
    assert.deepEqual(parseCoordinationEventTrustedResolveInput({
      eventId: "decision-1",
      expectedRevision: 0,
      optionId: "continue",
      idempotencyKey: "resolve-decision-1",
    }), {
      eventId: "decision-1",
      expectedRevision: 0,
      optionId: "continue",
      idempotencyKey: "resolve-decision-1",
    });
    assert.throws(() => parseCoordinationEventTrustedResolveInput({
      eventId: "decision-1",
      expectedRevision: 0,
      idempotencyKey: "resolve-decision-2",
    }), /Exactly one/);
  });
});
