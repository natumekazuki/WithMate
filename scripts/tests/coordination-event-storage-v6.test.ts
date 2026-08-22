import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import {
  CoordinationEventPublicationError,
  CoordinationEventService,
} from "../../src-electron/coordination-event-service.js";
import {
  CoordinationEventIdempotencyConflictError,
  CoordinationEventNotFoundError,
  CoordinationEventStateConflictError,
  CoordinationEventStorageV6,
  type CoordinationMutationPrincipal,
} from "../../src-electron/coordination-event-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-08-21T12:00:00.000Z";

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-coordination-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  for (const id of ["root-a", "task-a", "executor-a", "root-b"]) {
    db.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, provider_id, catalog_revision, model_id, approval_mode,
        created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'codex', 1, 'gpt-5', 'on-request', ?, ?, ?)
    `).run(id, id, NOW, NOW, NOW);
  }
  db.prepare(`INSERT INTO session_role_bindings_v6 VALUES (?, ?, 1, ?, ?, ?)`)
    .run("root-a", "overall-coordinator", "root-a", null, 0);
  db.prepare(`INSERT INTO session_role_bindings_v6 VALUES (?, ?, 1, ?, ?, ?)`)
    .run("task-a", "task-coordinator", "root-a", "root-a", 1);
  db.prepare(`INSERT INTO session_role_bindings_v6 VALUES (?, ?, 1, ?, ?, ?)`)
    .run("executor-a", "executor", "root-a", "task-a", 2);
  db.prepare(`INSERT INTO session_role_bindings_v6 VALUES (?, ?, 1, ?, ?, ?)`)
    .run("root-b", "overall-coordinator", "root-b", null, 0);
  db.prepare(`
    INSERT INTO session_executions_v6 (
      id, session_id, operation, state, request_json, error_code, reason,
      created_at, updated_at
    ) VALUES ('execution-a', 'executor-a', 'turn.run', 'running', '{}', '', '', ?, ?)
  `).run(NOW, NOW);
  db.close();
  return { directory, dbPath, storage: new CoordinationEventStorageV6(dbPath) };
}

function principal(
  sessionId: "root-a" | "task-a" | "executor-a" | "root-b",
  actorType: "session" | "trusted_gui" = "session",
): CoordinationMutationPrincipal {
  const values = {
    "root-a": { sessionRole: "overall-coordinator", rootSessionId: "root-a", parentSessionId: null, delegationDepth: 0 },
    "task-a": { sessionRole: "task-coordinator", rootSessionId: "root-a", parentSessionId: "root-a", delegationDepth: 1 },
    "executor-a": { sessionRole: "executor", rootSessionId: "root-a", parentSessionId: "task-a", delegationDepth: 2 },
    "root-b": { sessionRole: "overall-coordinator", rootSessionId: "root-b", parentSessionId: null, delegationDepth: 0 },
  } as const;
  return { sessionId, actorType, roleBinding: { ...values[sessionId], roleContractRevision: 1 } };
}

function binding(sessionId: "root-a" | "task-a" | "executor-a" | "root-b"): ResolvedAgentRuntimeBinding {
  const value = principal(sessionId);
  return {
    bindingId: `binding-${sessionId}`,
    bindingIdHash: `hash-${sessionId}`,
    actorSessionId: sessionId,
    providerId: "codex",
    executionGeneration: "generation-1",
    authoritySnapshot: { sessionKind: "default", sessionRoleBinding: value.roleBinding },
    operationGrants: ["session.runtime.invoke"],
    createdAt: NOW,
    expiresAt: null,
  };
}

function create(storage: CoordinationEventStorageV6, input: Partial<Parameters<CoordinationEventStorageV6["create"]>[0]> = {}) {
  return storage.create({
    principal: principal("executor-a"),
    kind: "progress",
    payload: { summary: "作業を開始した" },
    executionId: "execution-a",
    targetSessionId: null,
    options: [],
    idempotencyKey: "create-1",
    requestFingerprint: "fingerprint-1",
    createdAt: NOW,
    ...input,
  });
}

describe("CoordinationEventStorageV6", () => {
  it("COORD-EVENT-01: standaloneとtree leafのbulk削除はCoordination historyも同じtransactionで削除する", async () => {
    const fixture = await createFixture();
    let storageClosed = false;
    try {
      const rootEvent = create(fixture.storage, {
        principal: principal("root-b"),
        executionId: null,
        idempotencyKey: "root-b-event",
        requestFingerprint: "root-b-event",
      }).event;
      fixture.storage.correct({
        principal: principal("root-b"),
        eventId: rootEvent.eventId,
        payload: { summary: "root-b訂正" },
        executionId: null,
        idempotencyKey: "root-b-correction",
        requestFingerprint: "root-b-correction",
        createdAt: NOW,
      });
      create(fixture.storage, {
        idempotencyKey: "executor-event",
        requestFingerprint: "executor-event",
      });
      fixture.storage.close();
      storageClosed = true;
      const sessionStorage = new SessionStorageV6(fixture.dbPath);
      try {
        sessionStorage.deleteSessions(["root-b", "executor-a"]);
      } finally {
        sessionStorage.close();
      }
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM coordination_events_v6 WHERE actor_session_id IN (?, ?)").get("root-b", "executor-a") as { count: number }).count, 0);
      } finally {
        db.close();
      }
    } finally {
      if (!storageClosed) fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-IDEM-01: principal scopeのreplay、conflict、execution ownerをeffect-noneで閉じる", async () => {
    const fixture = await createFixture();
    try {
      const first = create(fixture.storage);
      const replay = create(fixture.storage);
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(replay.event.eventId, first.event.eventId);
      assert.equal(
        fixture.storage.getByIdempotencyKey(principal("executor-a"), "create-1").eventId,
        first.event.eventId,
      );
      assert.throws(
        () => create(fixture.storage, { requestFingerprint: "different" }),
        (error) => error instanceof CoordinationEventIdempotencyConflictError,
      );
      const otherRoot = create(fixture.storage, {
        principal: principal("root-b"), executionId: null, idempotencyKey: "create-1",
      });
      assert.notEqual(otherRoot.event.eventId, first.event.eventId);
      assert.throws(
        () => create(fixture.storage, { principal: principal("task-a"), idempotencyKey: "wrong-execution" }),
        (error) => error instanceof CoordinationEventNotFoundError,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-AUTH-01: self/subtree/ancestor/cross-rootとresolution authorityを一つのRole matrixで守る", async () => {
    const fixture = await createFixture();
    try {
      const escalation = create(fixture.storage, {
        kind: "escalation",
        targetSessionId: "root-a",
        executionId: null,
        idempotencyKey: "escalate-1",
        requestFingerprint: "escalate-fingerprint",
      }).event;
      assert.equal(fixture.storage.list(principal("executor-a"), { scope: "self", limit: 50 }, null).items.length, 1);
      assert.equal(fixture.storage.list(principal("task-a"), { scope: "subtree", limit: 50 }, null).items.length, 1);
      assert.equal(fixture.storage.list(principal("root-a"), { scope: "subtree", limit: 50 }, null).items.length, 1);
      assert.equal(fixture.storage.list(principal("root-b"), { scope: "subtree", limit: 50 }, null).items.length, 0);
      assert.throws(() => fixture.storage.list(principal("executor-a"), { scope: "subtree", limit: 50 }, null));
      assert.throws(() => fixture.storage.getVisible(principal("root-b"), escalation.eventId));
      assert.throws(() => create(fixture.storage, {
        kind: "escalation", targetSessionId: "root-b", executionId: null,
        idempotencyKey: "cross-root-escalation", requestFingerprint: "cross-root-escalation",
      }));
      assert.throws(() => fixture.storage.resolve({
        principal: principal("task-a"), eventId: escalation.eventId, optionId: null, note: null,
        idempotencyKey: "resolve-wrong", requestFingerprint: "resolve-wrong", createdAt: NOW,
      }));
      const resolved = fixture.storage.resolve({
        principal: principal("root-a"), eventId: escalation.eventId, optionId: null, note: "確認済み",
        idempotencyKey: "resolve-ok", requestFingerprint: "resolve-ok", createdAt: NOW,
      });
      assert.equal(resolved.event.state, "resolved");
      assert.equal(resolved.event.actions[0]?.note, "確認済み");
      assert.throws(
        () => fixture.storage.resolve({
          principal: principal("root-b"), eventId: escalation.eventId, optionId: null, note: null,
          idempotencyKey: "cross-root-resolved", requestFingerprint: "cross-root-resolved", createdAt: NOW,
        }),
        (error) => error instanceof CoordinationEventNotFoundError,
      );

      const blocker = create(fixture.storage, {
        kind: "blocker", executionId: null, idempotencyKey: "blocker-1", requestFingerprint: "blocker-1",
      }).event;
      assert.throws(() => fixture.storage.cancel({
        principal: principal("task-a"), eventId: blocker.eventId, optionId: null, note: null,
        idempotencyKey: "cancel-wrong", requestFingerprint: "cancel-wrong", createdAt: NOW,
      }));
      assert.equal(fixture.storage.cancel({
        principal: principal("root-a", "trusted_gui"), eventId: blocker.eventId, optionId: null, note: null,
        idempotencyKey: "cancel-gui", requestFingerprint: "cancel-gui", createdAt: NOW,
      }).event.state, "cancelled");
      assert.throws(
        () => fixture.storage.cancel({
          principal: principal("root-b", "trusted_gui"), eventId: blocker.eventId, optionId: null, note: null,
          idempotencyKey: "cross-root-cancelled", requestFingerprint: "cross-root-cancelled", createdAt: NOW,
        }),
        (error) => error instanceof CoordinationEventNotFoundError,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-EVENT-01: user decisionはtrusted GUIがoptionか自由回答の片方だけでresolveできる", async () => {
    const fixture = await createFixture();
    try {
      const event = create(fixture.storage, {
        kind: "user_decision_required",
        executionId: null,
        options: [{ id: "keep", label: "維持" }, { id: "change", label: "変更" }],
        idempotencyKey: "decision-1",
        requestFingerprint: "decision-fingerprint",
      }).event;
      assert.throws(() => fixture.storage.resolve({
        principal: principal("executor-a"), eventId: event.eventId, optionId: "keep", note: null,
        idempotencyKey: "agent-resolve", requestFingerprint: "agent-resolve", createdAt: NOW,
      }));
      assert.throws(() => fixture.storage.resolve({
        principal: principal("root-b", "trusted_gui"), eventId: event.eventId, optionId: "keep", note: null,
        idempotencyKey: "cross-root-gui", requestFingerprint: "cross-root-gui", createdAt: NOW,
      }));
      assert.throws(() => fixture.storage.resolve({
        principal: principal("root-a", "trusted_gui"), eventId: event.eventId, optionId: "keep", note: "両方は不可",
        idempotencyKey: "both-answer-kinds", requestFingerprint: "both-answer-kinds", createdAt: NOW,
      }));
      assert.throws(() => fixture.storage.resolve({
        principal: principal("root-a", "trusted_gui"), eventId: event.eventId, optionId: null, note: "   ",
        idempotencyKey: "blank-custom-answer", requestFingerprint: "blank-custom-answer", createdAt: NOW,
      }));
      const resolved = fixture.storage.resolve({
        principal: principal("root-a", "trusted_gui"), eventId: event.eventId, optionId: "change", note: null,
        idempotencyKey: "gui-resolve", requestFingerprint: "gui-resolve", createdAt: NOW,
      }).event;
      assert.equal(resolved.state, "resolved");
      assert.equal(resolved.actions[0]?.optionId, "change");
      assert.deepEqual(resolved.payload, event.payload);
      assert.deepEqual(fixture.storage.listPendingAnswers(principal("executor-a")), [{
        eventId: event.eventId,
        question: "作業を開始した",
        answer: { kind: "option", optionId: "change", label: "変更" },
        resolvedAt: NOW,
        consumption: "pending",
      }]);
      assert.throws(
        () => fixture.storage.consume({
          principal: principal("task-a"), eventId: event.eventId,
          idempotencyKey: "consume-wrong", requestFingerprint: "consume-wrong", createdAt: NOW,
        }),
        (error) => error instanceof CoordinationEventNotFoundError,
      );
      const consumed = fixture.storage.consume({
        principal: principal("executor-a"), eventId: event.eventId,
        idempotencyKey: "consume-decision", requestFingerprint: "consume-decision", createdAt: NOW,
      });
      assert.equal(consumed.event.state, "resolved");
      assert.equal(consumed.event.actions.at(-1)?.type, "consumed");
      assert.deepEqual(fixture.storage.listPendingAnswers(principal("executor-a")), []);
      assert.equal(fixture.storage.consume({
        principal: principal("executor-a"), eventId: event.eventId,
        idempotencyKey: "consume-decision", requestFingerprint: "consume-decision", createdAt: NOW,
      }).replayed, true);
      assert.throws(
        () => fixture.storage.consume({
          principal: principal("executor-a"), eventId: event.eventId,
          idempotencyKey: "consume-twice", requestFingerprint: "consume-twice", createdAt: NOW,
        }),
        (error) => error instanceof CoordinationEventStateConflictError,
      );

      const customEvent = create(fixture.storage, {
        kind: "user_decision_required",
        executionId: null,
        options: [{ id: "keep", label: "維持" }, { id: "change", label: "変更" }],
        idempotencyKey: "decision-custom",
        requestFingerprint: "decision-custom",
      }).event;
      const customResolved = fixture.storage.resolve({
        principal: principal("root-a", "trusted_gui"), eventId: customEvent.eventId, optionId: null, note: "段階的に変更する",
        idempotencyKey: "custom-answer", requestFingerprint: "custom-answer", createdAt: NOW,
      }).event;
      assert.equal(customResolved.actions[0]?.optionId, null);
      assert.equal(customResolved.actions[0]?.note, "段階的に変更する");
      assert.deepEqual(fixture.storage.listPendingAnswers(principal("executor-a")), [{
        eventId: customEvent.eventId,
        question: "作業を開始した",
        answer: { kind: "text", text: "段階的に変更する" },
        resolvedAt: NOW,
        consumption: "pending",
      }]);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-FEED-02: trusted GUI queryは全rootを既定表示しSession filterをDBへ適用する", async () => {
    const fixture = await createFixture();
    try {
      const rootA = create(fixture.storage, {
        principal: principal("root-a"), executionId: null,
        idempotencyKey: "trusted-root-a", requestFingerprint: "trusted-root-a",
      }).event;
      const rootB = create(fixture.storage, {
        principal: principal("root-b"), executionId: null,
        idempotencyKey: "trusted-root-b", requestFingerprint: "trusted-root-b",
      }).event;
      const service = new CoordinationEventService({ storage: fixture.storage, publishCommitted() {} });

      const firstPage = service.listAllFromTrustedGui({ limit: 1 });
      assert.equal(firstPage.items.length, 1);
      assert.ok(firstPage.nextCursor);
      const secondPage = service.listAllFromTrustedGui({ limit: 1, cursor: firstPage.nextCursor });
      assert.deepEqual(
        new Set([...firstPage.items, ...secondPage.items].map((event) => event.eventId)),
        new Set([rootA.eventId, rootB.eventId]),
      );

      const filtered = service.listAllFromTrustedGui({ sessionId: "root-a", limit: 50 });
      assert.deepEqual(filtered.items.map((event) => event.eventId), [rootA.eventId]);
      assert.throws(() => service.listAllFromTrustedGui({
        sessionId: "root-a",
        limit: 1,
        cursor: firstPage.nextCursor,
      }));
      assert.throws(() => service.listAllFromTrustedGui({
        kind: "result",
        limit: 1,
        cursor: firstPage.nextCursor,
      }));
      assert.throws(() => service.listAllFromTrustedGui({
        state: "open",
        limit: 1,
        cursor: firstPage.nextCursor,
      }));
      assert.equal(service.list({ scope: "subtree", limit: 50 }, binding("root-a")).items.some(
        (event) => event.eventId === rootB.eventId,
      ), false);
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-IDEM-01: correctionのevent作成とsuperseded actionは中間失敗時にrollbackする", async () => {
    const fixture = await createFixture();
    try {
      const target = create(fixture.storage).event;
      const db = new DatabaseSync(fixture.dbPath);
      db.exec(`
        CREATE TRIGGER fail_coordination_supersede
        BEFORE INSERT ON coordination_event_actions_v6
        WHEN NEW.action_type = 'superseded'
        BEGIN SELECT RAISE(ABORT, 'injected correction failure'); END;
      `);
      db.close();
      assert.throws(() => fixture.storage.correct({
        principal: principal("executor-a"), eventId: target.eventId,
        payload: { summary: "訂正後" }, executionId: null,
        idempotencyKey: "correct-1", requestFingerprint: "correct-fingerprint", createdAt: NOW,
      }), /injected correction failure/);
      const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        assert.equal((check.prepare("SELECT COUNT(*) AS count FROM coordination_events_v6").get() as { count: number }).count, 1);
        assert.equal((check.prepare("SELECT COUNT(*) AS count FROM coordination_event_actions_v6").get() as { count: number }).count, 0);
        assert.equal((check.prepare("SELECT COUNT(*) AS count FROM coordination_event_idempotency_v6 WHERE idempotency_key = 'correct-1'").get() as { count: number }).count, 0);
      } finally {
        check.close();
      }
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-EVENT-01: restart後も本文とaction履歴から同じprojectionを復元する", async () => {
    const fixture = await createFixture();
    let reopened: CoordinationEventStorageV6 | null = null;
    let originalClosed = false;
    try {
      const target = create(fixture.storage).event;
      const corrected = fixture.storage.correct({
        principal: principal("executor-a"), eventId: target.eventId,
        payload: { summary: "訂正後" }, executionId: null,
        idempotencyKey: "correct-restart", requestFingerprint: "correct-restart", createdAt: NOW,
      });
      fixture.storage.close();
      originalClosed = true;
      reopened = new CoordinationEventStorageV6(fixture.dbPath);
      assert.equal(reopened.getVisible(principal("executor-a"), target.eventId).state, "superseded");
      assert.equal(reopened.getVisible(principal("executor-a"), corrected.result.correction.eventId).state, "recorded");
      assert.equal(reopened.getVisible(principal("executor-a"), target.eventId).payload.summary, "作業を開始した");
    } finally {
      if (!originalClosed) fixture.storage.close();
      reopened?.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-IDEM-01: commit後publication failureをreplayで回収しcursorをprincipalとfilterへ束縛する", async () => {
    const fixture = await createFixture();
    let publishCalls = 0;
    try {
      const service = new CoordinationEventService({
        storage: fixture.storage,
        now: () => new Date(NOW),
        getSessionRoleBinding: (sessionId) => sessionId === "root-a" ? principal("root-a").roleBinding : null,
        publishCommitted() {
          publishCalls += 1;
          if (publishCalls === 1) throw new Error("publication failed");
        },
      });
      const input = { kind: "progress" as const, payload: { summary: "committed" }, idempotencyKey: "publish-1" };
      assert.throws(() => service.create(input, binding("executor-a")), CoordinationEventPublicationError);
      const replay = service.create(input, binding("executor-a"));
      assert.equal(replay.summary, "committed");
      assert.equal(publishCalls, 2);
      service.create({ kind: "result", payload: { summary: "done" }, idempotencyKey: "publish-2" }, binding("executor-a"));
      const page = service.list({ scope: "self", limit: 1 }, binding("executor-a"));
      assert.ok(page.nextCursor);
      assert.throws(() => service.list({ scope: "self", state: "recorded", limit: 1, cursor: page.nextCursor }, binding("executor-a")));
      assert.throws(() => service.list({ scope: "subtree", limit: 1, cursor: page.nextCursor }, binding("root-a")));
      const decision = service.create({
        kind: "user_decision_required",
        payload: { summary: "choose" },
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        idempotencyKey: "decision-service",
      }, binding("root-a"));
      const resolution = { eventId: decision.eventId, optionId: "a", idempotencyKey: "shared-surface-key" };
      service.resolveFromCoordinationWindow(resolution);
      assert.throws(
        () => service.resolve(resolution, binding("root-a")),
        CoordinationEventIdempotencyConflictError,
      );
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("COORD-WINDOW-01: 専用Windowはevent ownerの現行bindingで全rootの判断を取得・回答できる", async () => {
    const fixture = await createFixture();
    try {
      const service = new CoordinationEventService({
        storage: fixture.storage,
        now: () => new Date(NOW),
        getSessionRoleBinding: (sessionId) => sessionId === "root-b" ? principal("root-b").roleBinding : null,
        publishCommitted() {},
      });
      const decision = service.create({
        kind: "user_decision_required",
        payload: { summary: "別rootの判断" },
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        idempotencyKey: "global-decision",
      }, binding("root-b"));

      assert.equal(service.getFromCoordinationWindow(decision.eventId).rootSessionId, "root-b");
      const staleBindingService = new CoordinationEventService({
        storage: fixture.storage,
        now: () => new Date(NOW),
        getSessionRoleBinding: () => principal("root-a").roleBinding,
        publishCommitted() {},
      });
      assert.throws(() => staleBindingService.resolveFromCoordinationWindow({
        eventId: decision.eventId,
        note: "不正なbinding",
        idempotencyKey: "stale-binding-resolution",
      }), CoordinationEventNotFoundError);
      const resolved = service.resolveFromCoordinationWindow({
        eventId: decision.eventId,
        note: "自由回答",
        idempotencyKey: "global-resolution",
      });
      assert.equal(resolved.state, "resolved");
      assert.deepEqual(resolved.actions.at(-1), {
        sequence: resolved.actions.at(-1)?.sequence,
        type: "resolved",
        actorType: "trusted_gui",
        actorSessionId: null,
        optionId: null,
        note: "自由回答",
        relatedEventId: null,
        createdAt: NOW,
      });
    } finally {
      fixture.storage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

});
