import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CoordinationEventValidationError,
  validateCoordinationEventOptions,
  validateCoordinationEventPayload,
  initialCoordinationEventState,
} from "../../src/coordination-event.js";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";

describe("Coordination event contract", () => {
  it("COORD-EVENT-01: kindごとのfield組合せとunknown fieldをstrictに検証する", () => {
    assert.deepEqual(parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "progress",
      payload: { summary: "検証を開始した" },
      idempotencyKey: "create-1",
    }), {
      kind: "progress",
      payload: { summary: "検証を開始した" },
      idempotencyKey: "create-1",
    });
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "progress",
      payload: { summary: "検証を開始した" },
      targetSessionId: "session-parent",
      idempotencyKey: "create-2",
    }), /targetSessionId/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "user_decision_required",
      payload: { summary: "方針を選んでください" },
      idempotencyKey: "create-3",
    }), /options/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "progress",
      payload: { summary: "検証を開始した", rawLog: "private" },
      idempotencyKey: "create-4",
    }), /Unknown field/);
    assert.throws(() => parseSessionRuntimeOperationInput("coordination.event.get", {
      eventId: "event-1",
      idempotencyKey: "create-1",
    }), /Exactly one/);
    for (const kind of ["progress", "decision", "blocker", "result"] as const) {
      const parsed = parseSessionRuntimeOperationInput("coordination.event.create", {
        kind, payload: { summary: kind }, idempotencyKey: `create-${kind}`,
      }) as { kind: string };
      assert.equal(parsed.kind, kind);
    }
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "escalation", payload: { summary: "escalate" }, targetSessionId: "ancestor-1", idempotencyKey: "escalate",
    }) as { kind: string }).kind, "escalation");
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.create", {
      kind: "user_decision_required", payload: { summary: "choose" },
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], idempotencyKey: "choose",
    }) as { kind: string }).kind, "user_decision_required");
    assert.equal((parseSessionRuntimeOperationInput("coordination.event.correct", {
      eventId: "event-1", payload: { summary: "corrected" }, idempotencyKey: "correct",
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
        kind: "progress",
        payload: { summary: "key=-----BEGIN ENCRYPTED PRIVATE KEY-----" },
        idempotencyKey: "encrypted-key",
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
    assert.throws(
      () => parseSessionRuntimeOperationInput("coordination.event.create", {
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
        note: "[local](C:\\Users\\someone\\secret.txt)",
        idempotencyKey: "note-path",
      }),
      (error) => error instanceof CoordinationEventValidationError && error.code === "SENSITIVE_CONTENT_REJECTED",
    );
  });
});
