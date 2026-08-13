import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionInteraction } from "../../src/session-interaction.js";
import {
  tryRespondToExternalApprovalInteraction,
  tryRespondToExternalElicitationInteraction,
} from "../../src-electron/session-interaction-gui-bridge.js";

function createPending(kind: "approval" | "elicitation"): SessionInteraction {
  return {
    sequence: 1,
    id: `interaction-${kind}`,
    sessionId: "session-1",
    executionId: "execution-1",
    kind,
    state: "pending",
    publicPayload: kind === "approval"
      ? { title: "Approve", summary: "Run command" }
      : { mode: "form", message: "Provide input", fields: [] },
    response: null,
    expiryReason: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    resolvedAt: null,
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("Session interaction GUI bridge", () => {
  it("EXT-INTERACTION-11: matching requestだけをdurable approval responseへ渡す", () => {
    const responses: unknown[] = [];
    const deps = {
      interactionService: {
        getPendingForExecution: () => createPending("approval"),
        respond: (input: unknown) => { responses.push(input); return {} as never; },
      },
      currentTimestamp: () => "2026-08-13T00:01:00.000Z",
      resolveIdempotencyExpiresAt: () => "2026-08-14T00:01:00.000Z",
    };

    assert.equal(tryRespondToExternalApprovalInteraction({
      sessionId: "session-1", executionId: "execution-1", requestId: "stale", liveRequestId: "current",
    }, "approve", deps), false);
    assert.equal(responses.length, 0);
    assert.equal(tryRespondToExternalApprovalInteraction({
      sessionId: "session-1", executionId: "execution-1", requestId: "current", liveRequestId: "current",
    }, "approve", deps), true);
    assert.deepEqual(responses, [{
      sessionId: "session-1",
      executionId: "execution-1",
      interactionId: "interaction-approval",
      response: { kind: "approval", decision: "approve" },
      idempotencyKey: "gui:interaction-approval",
      respondedAt: "2026-08-13T00:01:00.000Z",
      expiresAt: "2026-08-14T00:01:00.000Z",
    }]);
  });

  it("EXT-INTERACTION-11: elicitation responseをexact unionのままdurable responseへ渡す", () => {
    const responses: Array<{ response: unknown }> = [];
    const deps = {
      interactionService: {
        getPendingForExecution: () => createPending("elicitation"),
        respond: (input: { response: unknown }) => { responses.push(input); return {} as never; },
      },
      currentTimestamp: () => "2026-08-13T00:01:00.000Z",
      resolveIdempotencyExpiresAt: () => "2026-08-14T00:01:00.000Z",
    };

    assert.equal(tryRespondToExternalElicitationInteraction({
      sessionId: "session-1", executionId: "execution-1", requestId: "request-1", liveRequestId: "request-1",
    }, { action: "accept", content: { value: "secret" } }, deps), true);
    assert.deepEqual(responses[0]?.response, {
      kind: "elicitation",
      action: "accept",
      content: { value: "secret" },
    });
  });
});
