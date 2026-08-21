import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import {
  fingerprintSessionInteractionResponse,
  SessionInteractionService,
} from "../../src-electron/session-interaction-service.js";
import { SessionInteractionStorageV6 } from "../../src-electron/session-interaction-storage-v6.js";
import { insertStandaloneRoleBindingsForSessions } from "./session-role-binding-fixture.js";

const CREATED_AT = "2026-08-13T00:00:00.000Z";
const EXPIRES_AT = "2026-08-14T00:00:00.000Z";

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-interaction-service-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        created_at, updated_at, last_active_at
      ) VALUES ('session-1', 'Session 1', 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `).run(CREATED_AT, CREATED_AT, CREATED_AT);
    insertStandaloneRoleBindingsForSessions(db);
  } finally {
    db.close();
  }
  const executions = new SessionExecutionStorageV6(dbPath);
  try {
    executions.startImmediate({
      id: "execution-1",
      sessionId: "session-1",
      request: {},
      idempotencyKey: "run-1",
      requestFingerprint: "run-fingerprint-1",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
  } finally {
    executions.close();
  }
  const storage = new SessionInteractionStorageV6(dbPath);
  return {
    directory,
    dbPath,
    storage,
    service: new SessionInteractionService(storage),
  };
}

describe("SessionInteractionService", () => {
  it("post-commit observer exception does not fail response or duplicate provider continuation", async () => {
    const fixture = await createFixture();
    try {
      let continuationCount = 0;
      fixture.service.registerApproval({
        id: "interaction-observer-throws",
        sessionId: "session-1",
        executionId: "execution-1",
        publicPayload: { title: "実行を許可する？", summary: "provider action" },
        createdAt: CREATED_AT,
        continueWith: () => {
          continuationCount += 1;
        },
      });
      fixture.service.subscribeExecution("execution-1", () => {
        throw new Error("renderer disconnected");
      });

      const result = fixture.service.respond({
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-observer-throws",
        response: { kind: "approval", decision: "approve" },
        idempotencyKey: "respond-observer-throws",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      });
      const replay = fixture.service.respond({
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-observer-throws",
        response: { kind: "approval", decision: "approve" },
        idempotencyKey: "respond-observer-throws",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      });

      assert.equal(result.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(result.interaction.state, "answered");
      assert.equal(continuationCount, 1);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: answer commit後にcontinuationを一度だけresolveし、入力値を永続化しない", async () => {
    const fixture = await createFixture();
    try {
      const continuationResponses: unknown[] = [];
      let durableStateAtContinuation = "";
      const observations: string[] = [];
      fixture.service.subscribeExecution("execution-1", () => {
        observations.push(fixture.storage.get("interaction-1")?.state ?? "missing");
      });
      fixture.service.registerElicitation({
        id: "interaction-1",
        sessionId: "session-1",
        executionId: "execution-1",
        publicPayload: {
          mode: "form",
          message: "tokenを入力してね",
          fields: [
            { name: "token", title: "Token", type: "text", required: true },
            { name: "enabled", title: "Enabled", type: "boolean", required: true },
          ],
        },
        createdAt: CREATED_AT,
        continueWith: (response) => {
          durableStateAtContinuation = fixture.storage.get("interaction-1")?.state ?? "missing";
          continuationResponses.push(response);
        },
      });

      const input = {
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-1",
        response: {
          kind: "elicitation" as const,
          action: "accept" as const,
          content: { token: "top-secret-value", enabled: true },
        },
        idempotencyKey: "respond-1",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      };
      const answered = fixture.service.respond(input);
      const replay = fixture.service.respond(input);

      assert.equal(answered.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(durableStateAtContinuation, "answered");
      assert.deepEqual(continuationResponses, [{
        action: "accept",
        content: { token: "top-secret-value", enabled: true },
      }]);
      assert.deepEqual(observations, ["pending", "answered"]);
      assert.deepEqual(answered.interaction.response, {
        action: "accept",
        submittedFields: ["enabled", "token"],
      });
      assert.equal("responseFingerprint" in answered.interaction, false);

      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const interaction = db.prepare(`
          SELECT response_action, response_submitted_fields_json, response_fingerprint
          FROM session_interactions_v6 WHERE id = 'interaction-1'
        `).get() as Record<string, unknown>;
        const idempotency = db.prepare(`
          SELECT request_fingerprint
          FROM session_interaction_idempotency_v6 WHERE idempotency_key = 'respond-1'
        `).get() as Record<string, unknown>;
        const persisted = JSON.stringify({ interaction, idempotency });
        assert.equal(persisted.includes("top-secret-value"), false);
        assert.equal(persisted.includes("token"), true);
      } finally {
        db.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: shutdown expiryをcommitしてからapproval continuationをdenyで解放する", async () => {
    const fixture = await createFixture();
    try {
      const decisions: string[] = [];
      let durableStateAtContinuation = "";
      fixture.service.registerApproval({
        id: "interaction-approval",
        sessionId: "session-1",
        executionId: "execution-1",
        publicPayload: { title: "実行を許可する？", summary: "provider action" },
        createdAt: CREATED_AT,
        continueWith: (decision) => {
          durableStateAtContinuation = fixture.storage.get("interaction-approval")?.state ?? "missing";
          decisions.push(decision);
        },
      });
      const expired = fixture.service.expirePendingForShutdown("2026-08-13T00:02:00.000Z");
      assert.equal(expired[0]?.state, "expired");
      assert.equal(durableStateAtContinuation, "expired");
      assert.deepEqual(decisions, ["deny"]);
      assert.deepEqual(fixture.service.expirePendingForShutdown("2026-08-13T00:03:00.000Z"), []);
      assert.deepEqual(decisions, ["deny"]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("EXT-INTERACTION-11: response fingerprintはdelivery値を含めずresponse key順に依存しない", () => {
    const first = fingerprintSessionInteractionResponse({
      sessionId: "session-1",
      executionId: "execution-1",
      interactionId: "interaction-1",
      response: { kind: "elicitation", action: "accept", content: { b: true, a: "x" } },
    });
    const second = fingerprintSessionInteractionResponse({
      sessionId: "session-1",
      executionId: "execution-1",
      interactionId: "interaction-1",
      response: { kind: "elicitation", action: "accept", content: { a: "x", b: true } },
    });
    assert.equal(first, second);
  });

  it("EXT-INTERACTION-11: elicitation field schemaとresponse値を完全検証する", async () => {
    const fixture = await createFixture();
    try {
      assert.throws(() => fixture.service.registerElicitation({
        id: "invalid-interaction",
        sessionId: "session-1",
        executionId: "execution-1",
        publicPayload: {
          mode: "form",
          message: "choose",
          fields: [{
            name: "choice", title: "Choice", type: "select", required: true,
            options: [{ value: "a", label: "A" }], defaultValue: "missing",
          }],
        },
        createdAt: CREATED_AT,
        continueWith() {},
      }), TypeError);

      fixture.service.registerElicitation({
        id: "interaction-choice",
        sessionId: "session-1",
        executionId: "execution-1",
        publicPayload: {
          mode: "form",
          message: "choose",
          fields: [{
            name: "choice", title: "Choice", type: "select", required: true,
            options: [{ value: "a", label: "A" }],
          }],
        },
        createdAt: CREATED_AT,
        continueWith() {},
      });
      assert.throws(() => fixture.service.respond({
        sessionId: "session-1",
        executionId: "execution-1",
        interactionId: "interaction-choice",
        response: { kind: "elicitation", action: "accept", content: { choice: "missing" } },
        idempotencyKey: "respond-invalid",
        respondedAt: "2026-08-13T00:01:00.000Z",
        expiresAt: EXPIRES_AT,
      }), TypeError);
      assert.equal(fixture.storage.get("interaction-choice")?.state, "pending");
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
