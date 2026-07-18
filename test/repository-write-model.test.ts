import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createRepositoryWriteOperations,
  RUN_OUTPUT_SQLITE_WRITE_MARGIN_BYTES,
} from "../src/persistence-worker/repository-write-model.js";
import { PersistenceWorkerRuntime } from "../src/persistence-worker/worker-runtime.js";
import { PERSISTENCE_PROTOCOL_VERSION, type WorkerToMainMessage } from "../src/shared/persistence-protocol.js";
import { REPOSITORY_WRITE_OPERATIONS } from "../src/shared/repository-write-model.js";
import { resolveWorkspaceIdentity } from "../src/shared/workspace-path.js";

const repositoryTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;
const TEST_WORKSPACE = requiredWorkspaceIdentity(path.resolve("workspace"));
const OTHER_TEST_WORKSPACE = requiredWorkspaceIdentity(path.resolve("other-workspace"));

function requiredWorkspaceIdentity(value: string): NonNullable<ReturnType<typeof resolveWorkspaceIdentity>> {
  const workspace = resolveWorkspaceIdentity(value);
  assert.ok(workspace);
  return workspace;
}

repositoryTest("session create commits a completed idempotency record and replays exactly", () => {
  withDatabase((database) => {
    const execute = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000101", "session-1");
    const first = execute(command) as CommandResult;
    const replay = execute(command) as CommandResult;
    const reorderedReplay = execute({
      session: {
        maxConcurrentChildRuns: command.session.maxConcurrentChildRuns,
        defaultCharacterId: command.session.defaultCharacterId,
        allowedAdditionalDirectories: command.session.allowedAdditionalDirectories,
        workspaceKey: command.session.workspaceKey,
        workspacePath: command.session.workspacePath,
        providerId: command.session.providerId,
        id: command.session.id,
      },
      idempotencyKey: command.idempotencyKey,
    }) as CommandResult;

    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(reorderedReplay.ok && reorderedReplay.replayed, true);
    assert.deepEqual(replay.ok && replay.value, first.ok && first.value);
    assert.equal(count(database, "sessions"), 1);
    assert.equal(count(database, "idempotency_records"), 1);
    const record = database.prepare("SELECT record_state, response_ref_type FROM idempotency_records").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...record }, { record_state: "completed", response_ref_type: "session" });
  });
});

repositoryTest("malformed create and reused keys with a different fingerprint make no domain mutation", () => {
  withDatabase((database) => {
    const execute = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const malformed = execute({
      ...sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000102", "session-1"),
      unexpected: true,
    }) as CommandResult;
    assert.equal(!malformed.ok && malformed.error.code, "request_invalid");
    assert.equal(count(database, "sessions"), 0);

    const mismatchedWorkspace = sessionCreateCommand(
      "018f1f4e-7f0a-7000-8000-000000000119",
      "session-workspace-mismatch",
    );
    mismatchedWorkspace.session.workspaceKey = "workspace-key-for-another-path";
    const mismatchedWorkspaceResult = execute(mismatchedWorkspace) as CommandResult;
    assert.equal(!mismatchedWorkspaceResult.ok && mismatchedWorkspaceResult.error.code, "request_invalid");
    assert.equal(count(database, "sessions"), 0);

    const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000103", "session-1");
    assert.equal((execute(command) as CommandResult).ok, true);
    const conflict = execute({
      ...command,
      session: {
        ...command.session,
        workspaceKey: OTHER_TEST_WORKSPACE.workspaceKey,
        workspacePath: OTHER_TEST_WORKSPACE.workspacePath,
      },
    }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
    assert.equal(count(database, "sessions"), 1);
  });
});

repositoryTest("session create rejects sparse and relative directory arrays and normalizes redundant paths", () => {
  withDatabase((database) => {
    const execute = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const sparse = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000114", "session-sparse");
    sparse.session.allowedAdditionalDirectories = new Array<string>(1);
    const sparseResult = execute(sparse) as CommandResult;
    assert.equal(!sparseResult.ok && sparseResult.error.code, "request_invalid");

    const relative = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000115", "session-relative");
    relative.session.allowedAdditionalDirectories = ["workspace/shared"];
    const relativeResult = execute(relative) as CommandResult;
    assert.equal(!relativeResult.ok && relativeResult.error.code, "request_invalid");

    const foreignHostPath = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000117", "session-foreign-host-path");
    foreignHostPath.session.allowedAdditionalDirectories =
      process.platform === "win32" ? ["/home/user"] : ["C:\\workspace\\shared"];
    const foreignHostPathResult = execute(foreignHostPath) as CommandResult;
    assert.equal(!foreignHostPathResult.ok && foreignHostPathResult.error.code, "request_invalid");

    if (process.platform === "win32") {
      const rootRelative = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000118", "session-root-relative");
      rootRelative.session.allowedAdditionalDirectories = ["\\secret"];
      const rootRelativeResult = execute(rootRelative) as CommandResult;
      assert.equal(!rootRelativeResult.ok && rootRelativeResult.error.code, "request_invalid");
    }

    const normalized = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000116", "session-normalized");
    normalized.session.allowedAdditionalDirectories = [
      "C:/workspace/shared/child",
      "C:\\workspace\\shared",
      "c:/WORKSPACE/shared/",
      "D:/workspace/shared",
    ];
    assert.equal((execute(normalized) as CommandResult).ok, true);
    const stored = database
      .prepare("SELECT allowed_additional_directories_json FROM sessions WHERE id = ?")
      .get("session-normalized") as { allowed_additional_directories_json: string };
    assert.deepEqual(JSON.parse(stored.allowed_additional_directories_json), [
      "C:\\workspace\\shared",
      "D:\\workspace\\shared",
    ]);
    assert.equal(count(database, "sessions"), 1);
  });
});

repositoryTest("Session create and child start reject child Run limits above the durable maximum", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const session = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000119", "session-over-limit");
    session.session.maxConcurrentChildRuns = 1_025;
    const sessionResult = create(session) as CommandResult;
    assert.equal(!sessionResult.ok && sessionResult.error.code, "request_invalid");

    const startChild = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childStart, () => 200);
    const child = childStartCommand("018f1f4e-7f0a-7000-8000-000000000120", "over-limit");
    child.childSession.maxConcurrentChildRuns = 1_025;
    const childResult = startChild(child) as CommandResult;
    assert.equal(!childResult.ok && childResult.error.code, "request_invalid");
    assert.equal(count(database, "sessions"), 0);
  });
});

repositoryTest("Session create and child start accept the exact durable child Run maximum", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const session = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000121", "session-exact-limit");
    session.session.maxConcurrentChildRuns = 1_024;
    assert.equal((create(session) as CommandResult).ok, true);
  });

  withDatabase((database) => {
    activatePersistentRun(database);
    const startChild = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childStart, () => 600);
    const child = childStartCommand("018f1f4e-7f0a-7000-8000-000000000122", "exact-limit");
    child.childSession.maxConcurrentChildRuns = 1_024;
    assert.equal((startChild(child) as CommandResult).ok, true);
  });
});

repositoryTest("session transitions enforce expected state and reject archive while a Run is active", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const transition = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionTransition, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000104", "session-1")) as CommandResult).ok,
      true,
    );
    insertActiveRun(database, "session-1");
    const busy = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000105",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;
    assert.equal(!busy.ok && busy.error.code, "session_busy");
    assert.equal(count(database, "idempotency_records"), 1);
    assert.equal(readLifecycle(database, "session-1"), "active");

    database.exec("DELETE FROM run_dispatches; DELETE FROM run_attempts; DELETE FROM runs; DELETE FROM messages;");
    const archived = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000106",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;
    assert.equal(archived.ok, true);
    const replay = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000106",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;
    assert.equal(replay.ok && replay.replayed, true);
    const conflict = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000106",
      expectedLifecycleStatus: "archived",
      targetLifecycleStatus: "closed",
    }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
    const foreignSessionConflict = transition({
      sessionId: "session-does-not-exist",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000106",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;
    assert.equal(!foreignSessionConflict.ok && foreignSessionConflict.error.code, "idempotency_conflict");
    const stale = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000107",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "closed",
    }) as CommandResult;
    assert.equal(!stale.ok && stale.error.code, "lifecycle_conflict");
    assert.equal(readLifecycle(database, "session-1"), "archived");
  });
});

repositoryTest("expired transition keys are scrubbed before a cross-Session conflict", () => {
  withDatabase((database) => {
    let now = 100;
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now);
    const transition = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionTransition, () => now, 1);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000119", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000120", "session-2")) as CommandResult).ok,
      true,
    );
    const idempotencyKey = "018f1f4e-7f0a-7000-8000-000000000121";
    assert.equal(
      (
        transition({
          sessionId: "session-1",
          idempotencyKey,
          expectedLifecycleStatus: "active",
          targetLifecycleStatus: "archived",
        }) as CommandResult
      ).ok,
      true,
    );

    now = 101;
    const conflict = transition({
      sessionId: "session-2",
      idempotencyKey,
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;

    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
    assert.deepEqual(
      {
        ...(database
          .prepare(
            "SELECT record_state, response_kind, response_ref_type, response_ref_id, response_envelope_json FROM idempotency_records WHERE idempotency_key = ?",
          )
          .get(idempotencyKey) as Readonly<Record<string, unknown>>),
      },
      {
        record_state: "expired",
        response_kind: null,
        response_ref_type: null,
        response_ref_id: null,
        response_envelope_json: null,
      },
    );
  });
});

repositoryTest("expired idempotency keys become tombstones and missing replay references are rejected", () => {
  withDatabase((database) => {
    let now = 100;
    const execute = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now, 1);
    const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000108", "session-1");
    assert.equal((execute(command) as CommandResult).ok, true);
    now = 101;
    const expired = execute(command) as CommandResult;
    assert.equal(!expired.ok && expired.error.code, "idempotency_expired");
    assert.equal(
      (database.prepare("SELECT record_state FROM idempotency_records").get() as { record_state: string }).record_state,
      "expired",
    );

    const second = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000109", "session-2");
    now = 200;
    const longLived = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now, 1_000);
    assert.equal((longLived(second) as CommandResult).ok, true);
    database.exec("PRAGMA foreign_keys = OFF;");
    database.prepare("DELETE FROM sessions WHERE id = 'session-2'").run();
    const invalidReference = longLived(second) as CommandResult;
    assert.equal(!invalidReference.ok && invalidReference.error.code, "reference_invalid");
  });
});

repositoryTest("expired idempotency responses are scrubbed before reporting a fingerprint conflict", () => {
  withDatabase((database) => {
    let now = 100;
    const execute = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now, 1);
    const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000117", "session-1");
    assert.equal((execute(command) as CommandResult).ok, true);
    now = 101;
    const conflict = execute({
      ...command,
      session: {
        ...command.session,
        workspaceKey: OTHER_TEST_WORKSPACE.workspaceKey,
        workspacePath: OTHER_TEST_WORKSPACE.workspacePath,
      },
    }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
    const record = database
      .prepare(
        `
        SELECT record_state, response_ref_type, response_ref_id, response_envelope_json
        FROM idempotency_records WHERE idempotency_key = ?
      `,
      )
      .get(command.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual(
      { ...record },
      {
        record_state: "expired",
        response_ref_type: null,
        response_ref_id: null,
        response_envelope_json: null,
      },
    );
  });
});

repositoryTest("unarchive rejects an open ProviderBinding for a different Provider", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const transition = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionTransition, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000110", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (
        transition({
          sessionId: "session-1",
          idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000111",
          expectedLifecycleStatus: "active",
          targetLifecycleStatus: "archived",
        }) as CommandResult
      ).ok,
      true,
    );
    database.exec("PRAGMA foreign_keys = OFF;");
    database
      .prepare(
        `
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
        binding_state, created_by_run_attempt_id, created_at
      ) VALUES ('binding-1', 'session-1', 1, 'other-provider', 'external', 'persistent',
        'active', 'missing-attempt', 1)
    `,
      )
      .run();
    database.exec("PRAGMA foreign_keys = ON;");
    const result = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000112",
      expectedLifecycleStatus: "archived",
      targetLifecycleStatus: "active",
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "reference_invalid");
    assert.equal(readLifecycle(database, "session-1"), "archived");

    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("DELETE FROM provider_bindings;");
    database
      .prepare(
        `
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, persistence_mode,
        binding_state, created_by_run_attempt_id, created_at
      ) VALUES ('binding-2', 'session-1', 1, 'provider', 'persistent',
        'creating', 'missing-attempt', 1)
    `,
      )
      .run();
    database.exec("PRAGMA foreign_keys = ON;");
    const creating = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000113",
      expectedLifecycleStatus: "archived",
      targetLifecycleStatus: "active",
    }) as CommandResult;
    assert.equal(!creating.ok && creating.error.code, "reference_invalid");

    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("DELETE FROM provider_bindings;");
    database
      .prepare(
        `
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
        binding_state, created_by_run_attempt_id, created_at
      ) VALUES ('binding-3', 'session-1', 1, 'provider', 'external', 'ephemeral',
        'active', 'missing-attempt', 1)
    `,
      )
      .run();
    database.exec("PRAGMA foreign_keys = ON;");
    const ephemeral = transition({
      sessionId: "session-1",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000118",
      expectedLifecycleStatus: "archived",
      targetLifecycleStatus: "active",
    }) as CommandResult;
    assert.equal(!ephemeral.ok && ephemeral.error.code, "reference_invalid");
  });
});

repositoryTest("normal Run admission atomically creates Message, Run, Attempt, Dispatch, and Binding intent", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000120", "session-1")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000121", "run-1", "create");
    const first = admit(command) as CommandResult;
    const replay = admit({
      ...command,
      dispatch: {
        ...command.dispatch,
        providerRequest: { prompt: "hello", options: { z: 1, a: true } },
      },
    }) as CommandResult;

    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(count(database, "messages"), 1);
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "run_attempts"), 1);
    assert.equal(count(database, "run_dispatches"), 1);
    assert.equal(count(database, "provider_bindings"), 1);
    assert.equal(count(database, "idempotency_records"), 2);
    const attempt = database.prepare("SELECT provider_binding_id, attempt_state FROM run_attempts").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...attempt }, { provider_binding_id: null, attempt_state: "preparing" });
    const dispatch = database.prepare("SELECT dispatch_state, request_fingerprint FROM run_dispatches").get() as {
      dispatch_state: string;
      request_fingerprint: string;
    };
    assert.equal(dispatch.dispatch_state, "pending");
    assert.match(dispatch.request_fingerprint, /^[0-9a-f]{64}$/u);
  });
});

repositoryTest("normal Run admission reuses only the selected active Binding", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000122", "session-1")) as CommandResult).ok,
      true,
    );
    const first = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000123", "run-1", "create");
    assert.equal((admit(first) as CommandResult).ok, true);
    database
      .prepare(
        `
        UPDATE provider_bindings SET binding_state = 'active', external_conversation_id = 'external-1'
        WHERE id = 'binding-run-1'
      `,
      )
      .run();
    database
      .prepare(
        `
        UPDATE run_attempts SET provider_binding_id = 'binding-run-1', attempt_state = 'failed',
          failure_origin = 'provider', terminal_at = 201 WHERE id = 'attempt-run-1'
      `,
      )
      .run();
    database
      .prepare(
        `
        UPDATE runs SET phase = 'failed', failure_origin = 'provider', terminal_at = 201,
          updated_at = 201, version = 1 WHERE id = 'run-1'
      `,
      )
      .run();

    const second = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000124", "run-2", "reuse");
    database.prepare("UPDATE provider_bindings SET persistence_mode = 'ephemeral' WHERE id = 'binding-run-1'").run();
    const ephemeral = admit(second) as CommandResult;
    assert.equal(!ephemeral.ok && ephemeral.error.code, "reference_invalid");
    assert.equal(count(database, "runs"), 1);
    database.prepare("UPDATE provider_bindings SET persistence_mode = 'persistent' WHERE id = 'binding-run-1'").run();
    const result = admit(second) as CommandResult;
    assert.equal(result.ok, true);
    assert.equal(count(database, "provider_bindings"), 1);
    const attempt = database
      .prepare("SELECT provider_binding_id FROM run_attempts WHERE id = 'attempt-run-2'")
      .get() as {
      provider_binding_id: string;
    };
    assert.equal(attempt.provider_binding_id, "binding-run-1");
  });
});

repositoryTest("normal Run admission rejects a reused Binding created by another Session", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000125", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000126", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (
        admit({
          ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000127", "run-2", "create"),
          sessionId: "session-2",
        }) as CommandResult
      ).ok,
      true,
    );
    database.exec(`
      UPDATE provider_bindings
      SET session_id = 'session-1', binding_state = 'active', external_conversation_id = 'foreign-conversation'
      WHERE id = 'binding-run-2';
      UPDATE run_attempts
      SET provider_binding_id = 'binding-run-2', attempt_state = 'failed',
          failure_origin = 'provider', terminal_at = 225
      WHERE id = 'attempt-run-2';
      UPDATE runs
      SET phase = 'failed', failure_origin = 'provider', terminal_at = 225, updated_at = 225, version = version + 1
      WHERE id = 'run-2';
    `);

    const result = admit({
      ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000128", "run-1", "reuse"),
      bindingIntent: { kind: "reuse", bindingId: "binding-run-2" },
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "reference_invalid");
    assert.equal(
      (
        database.prepare("SELECT COUNT(*) AS count FROM runs WHERE session_id = 'session-1'").get() as {
          count: number;
        }
      ).count,
      0,
    );
  });
});

repositoryTest("normal Run admission replay rejects a Binding whose creator moved to another Session", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000129", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-00000000012a", "session-2")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-00000000012b", "run-1", "create");
    assert.equal((admit(command) as CommandResult).ok, true);
    assert.equal(
      (
        admit({
          ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-00000000012c", "run-2", "create"),
          sessionId: "session-2",
        }) as CommandResult
      ).ok,
      true,
    );
    database
      .prepare("UPDATE provider_bindings SET created_by_run_attempt_id = 'attempt-run-2' WHERE id = 'binding-run-1'")
      .run();

    const replay = admit(command) as CommandResult;
    assert.equal(!replay.ok && replay.error.code, "reference_invalid");
  });
});

repositoryTest("retry Run admission replay rejects a Binding whose creator moved to another Session", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-00000000012d", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-00000000012e", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-00000000012f", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);
    const command = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000130", "run-retry", "run-1", "reuse");
    assert.equal((retry(command) as CommandResult).ok, true);
    assert.equal(
      (
        admit({
          ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000131", "run-foreign", "create"),
          sessionId: "session-2",
        }) as CommandResult
      ).ok,
      true,
    );
    database
      .prepare(
        "UPDATE provider_bindings SET created_by_run_attempt_id = 'attempt-run-foreign' WHERE id = 'binding-run-1'",
      )
      .run();

    const replay = retry(command) as CommandResult;
    assert.equal(!replay.ok && replay.error.code, "reference_invalid");
  });
});

repositoryTest("normal Run admission replay rejects a changed Binding persistence mode", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000751", "session-1")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000752", "run-1", "create");
    assert.equal((admit(command) as CommandResult).ok, true);
    database.prepare("UPDATE provider_bindings SET persistence_mode = 'ephemeral' WHERE id = 'binding-run-1'").run();

    const replay = admit(command) as CommandResult;
    assert.equal(!replay.ok && replay.error.code, "reference_invalid");
  });
});

repositoryTest("retry Run admission replay rejects a changed Binding persistence mode", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000753", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000754", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);
    database
      .prepare(
        `
        UPDATE provider_bindings SET binding_state = 'invalidated', external_conversation_id = NULL,
          invalidated_at = 260, invalidation_reason = 'test replacement'
        WHERE id = 'binding-run-1'
      `,
      )
      .run();
    const command = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000755", "run-retry", "run-1", "create");
    assert.equal((retry(command) as CommandResult).ok, true);
    database
      .prepare("UPDATE provider_bindings SET persistence_mode = 'ephemeral' WHERE id = 'binding-run-retry'")
      .run();

    const replay = retry(command) as CommandResult;
    assert.equal(!replay.ok && replay.error.code, "reference_invalid");
  });
});

repositoryTest("normal Run admission enforces app capacity and the execution snapshot Provider", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200, undefined, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProvider: 1,
    });
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000130", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000131", "session-2")) as CommandResult).ok,
      true,
    );
    const mismatched = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000132", "run-mismatch", "create");
    mismatched.run.executionSnapshot.providerId = "other-provider";
    const mismatchResult = admit(mismatched) as CommandResult;
    assert.equal(!mismatchResult.ok && mismatchResult.error.code, "reference_invalid");
    assert.equal(count(database, "runs"), 0);

    const first = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000133", "run-1", "create");
    assert.equal((admit(first) as CommandResult).ok, true);
    const second = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000134", "run-2", "create");
    second.sessionId = "session-2";
    const capacity = admit(second) as CommandResult;
    assert.equal(!capacity.ok && capacity.error.code, "capacity_exceeded");
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "messages"), 1);
  });
});

repositoryTest("normal Run admission enforces Provider capacity across Sessions", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200, undefined, {
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerProvider: 1,
    });
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000135", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000136", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000137", "run-1", "create")) as CommandResult).ok,
      true,
    );
    const second = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000138", "run-2", "create");
    second.sessionId = "session-2";
    const result = admit(second) as CommandResult;
    assert.equal(!result.ok && result.error.code, "capacity_exceeded");
    assert.equal(count(database, "runs"), 1);
  });
});

repositoryTest("normal Run admission rejects inactive or busy Sessions without partial rows", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const transition = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionTransition, () => 150);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000125", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (
        transition({
          sessionId: "session-1",
          idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000126",
          expectedLifecycleStatus: "active",
          targetLifecycleStatus: "archived",
        }) as CommandResult
      ).ok,
      true,
    );
    const archived = admit(
      normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000127", "run-1", "create"),
    ) as CommandResult;
    assert.equal(!archived.ok && archived.error.code, "lifecycle_conflict");
    assert.equal(count(database, "runs"), 0);

    database.prepare("UPDATE sessions SET lifecycle_status = 'active' WHERE id = 'session-1'").run();
    const first = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000128", "run-1", "create");
    assert.equal((admit(first) as CommandResult).ok, true);
    const busy = admit(
      normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000129", "run-2", "create"),
    ) as CommandResult;
    assert.equal(!busy.ok && busy.error.code, "session_busy");
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "messages"), 1);
  });
});

repositoryTest("Run admission idempotency directly rejects conflicts, expiry, and missing Run references", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000139", "session-1")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000140", "run-1", "create");
    assert.equal((admit(command) as CommandResult).ok, true);
    const conflict = admit({
      ...command,
      dispatch: { ...command.dispatch, providerRequest: { prompt: "different" } },
    }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
  });

  withDatabase((database) => {
    let now = 100;
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => now, 1);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000141", "session-1")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000142", "run-1", "create");
    assert.equal((admit(command) as CommandResult).ok, true);
    now = 101;
    const expired = admit(command) as CommandResult;
    assert.equal(!expired.ok && expired.error.code, "idempotency_expired");
    const record = database
      .prepare(
        `
        SELECT record_state, response_ref_type, response_ref_id, response_envelope_json
        FROM idempotency_records WHERE idempotency_key = ?
      `,
      )
      .get(command.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual(
      { ...record },
      {
        record_state: "expired",
        response_ref_type: null,
        response_ref_id: null,
        response_envelope_json: null,
      },
    );
  });

  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000143", "session-1")) as CommandResult).ok,
      true,
    );
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000144", "run-1", "create");
    assert.equal((admit(command) as CommandResult).ok, true);
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(
      "DELETE FROM run_dispatches; DELETE FROM provider_bindings; DELETE FROM run_attempts; DELETE FROM runs;",
    );
    const missing = admit(command) as CommandResult;
    assert.equal(!missing.ok && missing.error.code, "reference_invalid");
  });
});

repositoryTest("Run admission rolls back every inserted row when a late constraint aborts", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000145", "session-1")) as CommandResult).ok,
      true,
    );
    database.exec(`
      CREATE TRIGGER test_abort_dispatch BEFORE INSERT ON run_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'injected dispatch failure');
      END;
    `);
    const command = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000146", "run-1", "create");
    assert.throws(() => admit(command), /injected dispatch failure/u);
    assert.equal(count(database, "messages"), 0);
    assert.equal(count(database, "runs"), 0);
    assert.equal(count(database, "run_attempts"), 0);
    assert.equal(count(database, "provider_bindings"), 0);
    assert.equal(count(database, "run_dispatches"), 0);
    assert.equal(count(database, "idempotency_records"), 1);
  });
});

repositoryTest("retry Run admission reuses the source Message and preserves the direct retry chain", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    let now = 300;
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => now);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000211", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000212", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);

    const firstCommand = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000213", "run-2", "run-1", "reuse");
    const first = retry(firstCommand) as CommandResult;
    const replay = retry({
      ...firstCommand,
      dispatch: {
        ...firstCommand.dispatch,
        providerRequest: { prompt: "hello", options: { z: 1, a: true } },
      },
    }) as CommandResult;
    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(count(database, "messages"), 1);
    assert.equal(count(database, "runs"), 2);
    assert.equal(count(database, "run_attempts"), 2);
    assert.equal(count(database, "run_dispatches"), 2);
    const admitted = database
      .prepare(
        `
        SELECT initiating_message_id, retry_of_run_id, ordinal, phase
        FROM runs WHERE id = 'run-2'
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...admitted },
      { initiating_message_id: "message-run-1", retry_of_run_id: "run-1", ordinal: 2, phase: "queued" },
    );
    assert.equal(first.ok && first.value.messageId, "message-run-1");
    assert.equal(first.ok && first.value.retryOfRunId, "run-1");
    const activity = database
      .prepare("SELECT updated_at, last_activity_at FROM sessions WHERE id = 'session-1'")
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...activity }, { updated_at: 300, last_activity_at: 300 });

    now = 400;
    database
      .prepare(
        `
        UPDATE run_attempts SET attempt_state = 'failed', failure_origin = 'provider', terminal_at = ?
        WHERE id = 'attempt-run-2'
      `,
      )
      .run(now);
    database
      .prepare(
        `
        UPDATE runs SET phase = 'failed', failure_origin = 'provider', terminal_at = ?, updated_at = ?, version = 1
        WHERE id = 'run-2'
      `,
      )
      .run(now, now);
    const chained = retry(
      retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000214", "run-3", "run-2", "reuse"),
    ) as CommandResult;
    assert.equal(chained.ok, true);
    const chain = database
      .prepare("SELECT initiating_message_id, retry_of_run_id FROM runs WHERE id = 'run-3'")
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...chain }, { initiating_message_id: "message-run-1", retry_of_run_id: "run-2" });
    assert.equal(count(database, "messages"), 1);
  });
});

repositoryTest("retry Run admission enforces shared app capacity", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const constrainedRetry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 400, undefined, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProvider: 1,
    });
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000231", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000232", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000233", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);

    const source2 = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000234", "run-source-2", "create");
    source2.sessionId = "session-2";
    assert.equal((admit(source2) as CommandResult).ok, true);
    makeRunRetryable(database, "run-source-2", "attempt-run-source-2", "binding-run-source-2", 260);
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000235", "run-active", "reuse")) as CommandResult)
        .ok,
      true,
    );

    const command = retryRunAdmissionCommand(
      "018f1f4e-7f0a-7000-8000-000000000236",
      "run-retry",
      "run-source-2",
      "reuse",
    );
    command.sessionId = "session-2";
    const result = constrainedRetry(command) as CommandResult;
    assert.equal(!result.ok && result.error.code, "capacity_exceeded");
    assert.equal(count(database, "runs"), 3);
  });
});

repositoryTest("retry Run admission enforces shared Provider capacity independently", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const constrainedRetry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 400, undefined, {
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerProvider: 1,
    });
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000237", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000238", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (
        admit(
          normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000239", "run-source", "create"),
        ) as CommandResult
      ).ok,
      true,
    );
    makeRunRetryable(database, "run-source", "attempt-run-source", "binding-run-source", 250);

    const active = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000240", "run-active-provider", "create");
    active.sessionId = "session-2";
    assert.equal((admit(active) as CommandResult).ok, true);

    const command = retryRunAdmissionCommand(
      "018f1f4e-7f0a-7000-8000-000000000241",
      "run-retry-provider",
      "run-source",
      "reuse",
    );
    const result = constrainedRetry(command) as CommandResult;
    assert.equal(!result.ok && result.error.code, "capacity_exceeded");
    assert.equal(count(database, "runs"), 2);
  });
});

repositoryTest("retry Run admission rejects invalid sources and mismatched execution scope without mutation", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000215", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000216", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000217", "run-1", "create")) as CommandResult).ok,
      true,
    );

    const nonTerminal = retry(
      retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000218", "run-2", "run-1", "create"),
    ) as CommandResult;
    assert.equal(!nonTerminal.ok && nonTerminal.error.code, "lifecycle_conflict");
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);

    const otherSession = retryRunAdmissionCommand(
      "018f1f4e-7f0a-7000-8000-000000000219",
      "run-other",
      "run-1",
      "create",
    );
    otherSession.sessionId = "session-2";
    const crossScope = retry(otherSession) as CommandResult;
    assert.equal(!crossScope.ok && crossScope.error.code, "reference_invalid");

    const providerMismatch = retryRunAdmissionCommand(
      "018f1f4e-7f0a-7000-8000-000000000220",
      "run-provider",
      "run-1",
      "reuse",
    );
    providerMismatch.run.executionSnapshot.providerId = "other-provider";
    const wrongProvider = retry(providerMismatch) as CommandResult;
    assert.equal(!wrongProvider.ok && wrongProvider.error.code, "reference_invalid");

    database.prepare("UPDATE messages SET role = 'assistant' WHERE id = 'message-run-1'").run();
    const wrongRole = retry(
      retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000221", "run-role", "run-1", "reuse"),
    ) as CommandResult;
    assert.equal(!wrongRole.ok && wrongRole.error.code, "reference_invalid");
    assert.equal(count(database, "messages"), 1);
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "run_attempts"), 1);
  });
});

repositoryTest("retry Run admission directly enforces idempotency expiry and response references", () => {
  withDatabase((database) => {
    let now = 100;
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => now);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => now, 1);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000222", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000223", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);
    now = 300;
    const command = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000224", "run-2", "run-1", "reuse");
    assert.equal((retry(command) as CommandResult).ok, true);
    const conflict = retry({ ...command, retryOfRunId: "different-run" }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
    now = 301;
    const expired = retry(command) as CommandResult;
    assert.equal(!expired.ok && expired.error.code, "idempotency_expired");
    const record = database
      .prepare("SELECT record_state, response_envelope_json FROM idempotency_records WHERE idempotency_key = ?")
      .get(command.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual({ ...record }, { record_state: "expired", response_envelope_json: null });
  });

  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000225", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000226", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);
    const command = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000227", "run-2", "run-1", "reuse");
    assert.equal((retry(command) as CommandResult).ok, true);
    database.exec("PRAGMA foreign_keys = OFF;");
    database.prepare("DELETE FROM run_dispatches WHERE run_attempt_id = 'attempt-run-2'").run();
    database.prepare("DELETE FROM run_attempts WHERE id = 'attempt-run-2'").run();
    database.prepare("DELETE FROM runs WHERE id = 'run-2'").run();
    const missing = retry(command) as CommandResult;
    assert.equal(!missing.ok && missing.error.code, "reference_invalid");
  });
});

repositoryTest("retry Run admission rolls back new rows while preserving its source history", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000228", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000229", "run-1", "create")) as CommandResult).ok,
      true,
    );
    makeRunRetryable(database, "run-1", "attempt-run-1", "binding-run-1", 250);
    database
      .prepare(
        `
        UPDATE provider_bindings SET binding_state = 'invalidated', external_conversation_id = NULL,
          invalidated_at = 260, invalidation_reason = 'test replacement'
        WHERE id = 'binding-run-1'
      `,
      )
      .run();
    database.exec(`
      CREATE TRIGGER test_abort_retry_dispatch BEFORE INSERT ON run_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'injected retry dispatch failure');
      END;
    `);
    const command = retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000230", "run-2", "run-1", "create");
    assert.throws(() => retry(command), /injected retry dispatch failure/u);
    assert.equal(count(database, "messages"), 1);
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "run_attempts"), 1);
    assert.equal(count(database, "run_dispatches"), 1);
    assert.equal(count(database, "provider_bindings"), 1);
    assert.equal(count(database, "idempotency_records"), 2);
  });
});

repositoryTest("initial child admission atomically creates its tree, Run, Delivery, and replay handle", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const startChild = operationFor(database, "repository.child.start", () => 600);
    const command = childStartCommand("018f1f4e-7f0a-7000-8000-000000000324", "one");
    const first = startChild(command) as CommandResult;
    const replay = startChild(reverseObjectKeyOrder(command) as Readonly<Record<string, unknown>>) as CommandResult;

    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(replay.ok && replay.value, first.ok && first.value);
    assert.equal(count(database, "sessions"), 2);
    assert.equal(count(database, "messages"), 2);
    assert.equal(count(database, "runs"), 2);
    assert.equal(count(database, "run_attempts"), 2);
    assert.equal(count(database, "run_dispatches"), 2);
    assert.equal(count(database, "provider_bindings"), 2);
    assert.equal(count(database, "session_relations"), 1);
    assert.equal(count(database, "delegations"), 1);
    assert.equal(count(database, "child_result_deliveries"), 1);
    const relation = database
      .prepare(
        `
        SELECT parent_session_id, child_session_id, orchestration_root_session_id,
          created_by_parent_run_id, correlation_id
        FROM session_relations
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...relation },
      {
        parent_session_id: "session-1",
        child_session_id: "child-session-one",
        orchestration_root_session_id: "session-1",
        created_by_parent_run_id: "run-1",
        correlation_id: "correlation-one",
      },
    );
    const record = database
      .prepare(
        `
        SELECT scope_session_id, operation, response_ref_type, response_ref_id
        FROM idempotency_records WHERE idempotency_key = ?
      `,
      )
      .get(command.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual(
      { ...record },
      {
        scope_session_id: "session-1",
        operation: "repository.child.start",
        response_ref_type: "delivery",
        response_ref_id: "delivery-one",
      },
    );
    database
      .prepare("UPDATE provider_bindings SET provider_id = 'other-provider' WHERE id = 'child-binding-one'")
      .run();
    const foreignReplay = startChild(command) as CommandResult;
    assert.equal(!foreignReplay.ok && foreignReplay.error.code, "reference_invalid");
  });
});

repositoryTest("child admission inherits nested root capacity and leaves no rejected rows", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    database.prepare("UPDATE sessions SET max_concurrent_child_runs = 1 WHERE id = 'session-1'").run();
    const startChild = operationFor(database, "repository.child.start", () => 600);
    const first = childStartCommand("018f1f4e-7f0a-7000-8000-000000000325", "one");
    assert.equal((startChild(first) as CommandResult).ok, true);

    database
      .prepare(
        `
        UPDATE provider_bindings SET binding_state = 'active', external_conversation_id = 'child-conversation'
        WHERE id = 'child-binding-one'
      `,
      )
      .run();
    database
      .prepare(
        `
      UPDATE run_attempts
      SET provider_binding_id = 'child-binding-one',
          attempt_state = 'active',
          external_execution_id = 'child-execution',
          started_at = 601
      WHERE id = 'child-attempt-one'
      `,
      )
      .run();
    database
      .prepare(
        "UPDATE run_dispatches SET dispatch_state = 'accepted', dispatching_at = 601, resolved_at = 601 WHERE run_attempt_id = 'child-attempt-one'",
      )
      .run();
    database
      .prepare("UPDATE runs SET phase = 'active', started_at = 601, updated_at = 601 WHERE id = 'child-run-one'")
      .run();

    const nested = childStartCommand(
      "018f1f4e-7f0a-7000-8000-000000000326",
      "nested",
      "child-session-one",
      "child-run-one",
    );
    const rejected = startChild(nested) as CommandResult;
    assert.equal(!rejected.ok && rejected.error.code, "capacity_exceeded");
    assert.deepEqual(!rejected.ok && rejected.error.details, {
      scope: "root",
      rootSessionId: "session-1",
      current: 1,
      limit: 1,
    });
    assert.equal(count(database, "sessions"), 2);
    assert.equal(count(database, "session_relations"), 1);
    assert.equal(count(database, "delegations"), 1);
    assert.equal(count(database, "child_result_deliveries"), 1);
  });
});

repositoryTest("child admission reports application and Provider capacity details", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const startChild = operationFor(database, "repository.child.start", () => 600, undefined, {
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerProvider: 4,
    });
    const result = startChild(
      childStartCommand("018f1f4e-7f0a-7000-8000-000000000328", "app-capacity"),
    ) as CommandResult;
    assert.equal(!result.ok && result.error.code, "capacity_exceeded");
    assert.deepEqual(!result.ok && result.error.details, { scope: "application", current: 1, limit: 1 });
    assert.equal(count(database, "sessions"), 1);
  });

  withDatabase((database) => {
    activatePersistentRun(database);
    const startChild = operationFor(database, "repository.child.start", () => 600, undefined, {
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerProvider: 1,
    });
    const result = startChild(
      childStartCommand("018f1f4e-7f0a-7000-8000-000000000329", "provider-capacity"),
    ) as CommandResult;
    assert.equal(!result.ok && result.error.code, "capacity_exceeded");
    assert.deepEqual(!result.ok && result.error.details, {
      scope: "provider",
      providerId: "provider",
      current: 1,
      limit: 1,
    });
    assert.equal(count(database, "sessions"), 1);
  });
});

repositoryTest("child admission rolls back every new row when Delivery publication fails", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    database.exec(`
      CREATE TRIGGER fail_child_delivery BEFORE INSERT ON child_result_deliveries
      BEGIN SELECT RAISE(ABORT, 'child admission fault injection'); END;
    `);
    const startChild = operationFor(database, "repository.child.start", () => 600);
    const command = childStartCommand("018f1f4e-7f0a-7000-8000-000000000327", "fault");
    assert.throws(() => startChild(command), /child admission fault injection/u);
    assert.equal(count(database, "sessions"), 1);
    assert.equal(count(database, "messages"), 1);
    assert.equal(count(database, "runs"), 1);
    assert.equal(count(database, "session_relations"), 0);
    assert.equal(count(database, "delegations"), 0);
    assert.equal(count(database, "child_result_deliveries"), 0);
    const idempotencyCount = database
      .prepare("SELECT count(*) AS count FROM idempotency_records WHERE idempotency_key = ?")
      .get(command.idempotencyKey) as { count: number };
    assert.equal(idempotencyCount.count, 0);
  });
});

repositoryTest("Provider Binding activation atomically links its creating Attempt and replays exactly", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000147", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000148", "run-1", "create")) as CommandResult).ok,
      true,
    );
    const command = bindingResolutionCommand("active");
    const first = resolve(command) as CommandResult;
    const replay = resolve(command) as CommandResult;
    const conflict = resolve({
      ...command,
      resolution: { ...command.resolution, externalConversationId: "external-other" },
    }) as CommandResult;

    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(!conflict.ok && conflict.error.code, "lifecycle_conflict");
    const binding = database
      .prepare(
        `
        SELECT b.binding_state, b.external_conversation_id, r.external_side_effect_state
        FROM provider_bindings b JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
        JOIN runs r ON r.id = a.run_id WHERE b.id = 'binding-run-1'
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...binding },
      {
        binding_state: "active",
        external_conversation_id: "external-1",
        external_side_effect_state: "present",
      },
    );
    const attempt = database.prepare("SELECT provider_binding_id, attempt_state FROM run_attempts").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...attempt }, { provider_binding_id: "binding-run-1", attempt_state: "preparing" });
  });
});

repositoryTest("binding.resolve rejects ambiguous creation so run.terminal owns the terminal transition", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000149", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000150", "run-1", "create")) as CommandResult).ok,
      true,
    );
    const ambiguous = resolve(ambiguousBindingResolutionPayload()) as CommandResult;
    assert.equal(!ambiguous.ok && ambiguous.error.code, "request_invalid");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, a.attempt_state, r.phase, d.dispatch_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
            JOIN runs r ON r.id = a.run_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
          `,
          )
          .get(),
      },
      { binding_state: "creating", attempt_state: "preparing", phase: "queued", dispatch_state: "pending" },
    );

    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    const command = preparingRunTerminalCommand("binding_creation_ambiguous", "interrupted");
    const first = terminal(command) as CommandResult;
    const replay = terminal(command) as CommandResult;
    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    const state = database
      .prepare(
        `
        SELECT b.binding_state, b.invalidation_reason, a.attempt_state, r.phase,
          r.external_side_effect_state, d.dispatch_state, s.last_activity_at
        FROM provider_bindings b
        JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
        JOIN runs r ON r.id = a.run_id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
        JOIN sessions s ON s.id = r.session_id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...state },
      {
        binding_state: "invalidated",
        invalidation_reason: "conversation_start_ambiguous",
        attempt_state: "interrupted",
        phase: "interrupted",
        external_side_effect_state: "unknown",
        dispatch_state: "aborted",
        last_activity_at: 300,
      },
    );
    assert.equal(count(database, "run_events"), 1);
  });
});

repositoryTest("pending Dispatch cannot start after its Run begins canceling", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000162", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000163", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    database.prepare("UPDATE runs SET phase = 'canceling', cancel_requested_at = 350 WHERE id = 'run-1'").run();

    const result = begin(dispatchBeginCommand()) as CommandResult;
    assert.equal(!result.ok && result.error.code, "lifecycle_conflict");
    const state = database
      .prepare(
        `
        SELECT r.phase, d.dispatch_state, d.dispatching_at
        FROM runs r JOIN run_attempts a ON a.run_id = r.id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...state }, { phase: "canceling", dispatch_state: "pending", dispatching_at: null });
  });
});

repositoryTest("Dispatch begin applies the common Gate and never re-allows send after response loss", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000151", "session-1")) as CommandResult).ok,
      true,
    );
    const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000152", "run-1", "create");
    assert.equal((admit(admission) as CommandResult).ok, true);
    const premature = begin(dispatchBeginCommand()) as CommandResult;
    assert.equal(!premature.ok && premature.error.code, "reference_invalid");
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);

    const first = begin(dispatchBeginCommand()) as CommandResult;
    const replay = begin(dispatchBeginCommand()) as CommandResult;
    database.prepare("UPDATE runs SET phase = 'canceling', cancel_requested_at = 450 WHERE id = 'run-1'").run();
    const cancelingReplay = begin(dispatchBeginCommand()) as CommandResult;
    const mismatch = begin({ ...dispatchBeginCommand(), providerRequest: { prompt: "different" } }) as CommandResult;
    assert.equal(first.ok && first.value.sendAllowed, true);
    assert.equal(replay.ok && replay.replayed && !replay.value.sendAllowed, true);
    assert.equal(cancelingReplay.ok && cancelingReplay.replayed && !cancelingReplay.value.sendAllowed, true);
    assert.equal(!mismatch.ok && mismatch.error.code, "idempotency_conflict");
    const state = database
      .prepare(
        `
        SELECT r.phase, d.dispatch_state, d.dispatching_at
        FROM runs r JOIN run_attempts a ON a.run_id = r.id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...state }, { phase: "canceling", dispatch_state: "dispatching", dispatching_at: 400 });
  });
});

repositoryTest("accepted Dispatch resolution atomically activates Attempt and Run and is terminal", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => 500);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000153", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000154", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    assert.equal((begin(dispatchBeginCommand()) as CommandResult).ok, true);
    const command = dispatchResolutionCommand("accepted");
    const first = resolveDispatch(command) as CommandResult;
    const replay = resolveDispatch(command) as CommandResult;
    const conflict = resolveDispatch({
      ...command,
      outcome: { kind: "accepted", externalExecutionId: "execution-other" },
    }) as CommandResult;
    assert.equal(first.ok && !first.replayed, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(!conflict.ok && conflict.error.code, "lifecycle_conflict");
    const state = database
      .prepare(
        `
        SELECT r.phase, r.started_at, r.external_side_effect_state, a.attempt_state, a.external_execution_id,
          d.dispatch_state, d.resolved_at
        FROM runs r JOIN run_attempts a ON a.run_id = r.id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...state },
      {
        phase: "active",
        started_at: 500,
        external_side_effect_state: "present",
        attempt_state: "active",
        external_execution_id: "execution-1",
        dispatch_state: "accepted",
        resolved_at: 500,
      },
    );
    database
      .prepare("UPDATE run_attempts SET attempt_state = 'succeeded', terminal_at = 600 WHERE id = 'attempt-run-1'")
      .run();
    database
      .prepare("UPDATE runs SET phase = 'completed', terminal_at = 600, updated_at = 600 WHERE id = 'run-1'")
      .run();
    const replayAfterCompletion = resolveDispatch(command) as CommandResult;
    assert.equal(replayAfterCompletion.ok && replayAfterCompletion.replayed, true);
    const bindingReplayAfterCompletion = resolveBinding(bindingResolutionCommand("active")) as CommandResult;
    assert.equal(bindingReplayAfterCompletion.ok && bindingReplayAfterCompletion.replayed, true);
    assert.equal(
      bindingReplayAfterCompletion.ok && bindingReplayAfterCompletion.value.externalConversationId,
      "external-1",
    );
  });
});

repositoryTest("an ambiguous Dispatch can converge to an accepted external execution without resending", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    let now = 500;
    const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => now);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000164", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000165", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    assert.equal((begin(dispatchBeginCommand()) as CommandResult).ok, true);
    assert.equal((resolveDispatch(dispatchResolutionCommand("ambiguous")) as CommandResult).ok, true);

    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 550);
    const premature = terminal(preparingRunTerminalCommand("not_applicable", "interrupted")) as CommandResult;
    assert.equal(!premature.ok && premature.error.code, "lifecycle_conflict");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, a.attempt_state, r.phase, r.external_side_effect_state, d.dispatch_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.provider_binding_id = b.id
            JOIN runs r ON r.id = a.run_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
          `,
          )
          .get(),
      },
      {
        binding_state: "active",
        attempt_state: "preparing",
        phase: "starting",
        external_side_effect_state: "present",
        dispatch_state: "ambiguous",
      },
    );
    assert.equal(count(database, "run_events"), 0);

    database.prepare("UPDATE runs SET phase = 'canceling', cancel_requested_at = 550 WHERE id = 'run-1'").run();
    now = 600;
    const corrected = resolveDispatch(dispatchResolutionCommand("accepted")) as CommandResult;
    const replay = resolveDispatch(dispatchResolutionCommand("accepted")) as CommandResult;
    assert.equal(corrected.ok && !corrected.replayed && corrected.value.resolvedAt, 600);
    assert.equal(replay.ok && replay.replayed, true);
    const state = database
      .prepare(
        `
        SELECT r.phase, r.external_side_effect_state, a.attempt_state, a.external_execution_id,
          d.dispatch_state, d.resolved_at
        FROM runs r JOIN run_attempts a ON a.run_id = r.id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...state },
      {
        phase: "canceling",
        external_side_effect_state: "present",
        attempt_state: "active",
        external_execution_id: "execution-1",
        dispatch_state: "accepted",
        resolved_at: 600,
      },
    );
  });
});

repositoryTest("an ambiguous Dispatch on a reused Binding records an unknown Run side effect", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => 500);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000166", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000167", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    database.exec(`
      UPDATE run_attempts SET attempt_state = 'interrupted', failure_origin = 'application', terminal_at = 350
        WHERE id = 'attempt-run-1';
      UPDATE run_dispatches SET dispatch_state = 'aborted', resolved_at = 350 WHERE run_attempt_id = 'attempt-run-1';
      UPDATE runs SET phase = 'interrupted', failure_origin = 'application', terminal_at = 350,
        updated_at = 350 WHERE id = 'run-1';
    `);
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000168", "run-2", "reuse")) as CommandResult).ok,
      true,
    );
    const run2Begin = { ...dispatchBeginCommand(), runId: "run-2", attemptId: "attempt-run-2" };
    const run2Resolution = {
      ...dispatchResolutionCommand("ambiguous"),
      runId: "run-2",
      attemptId: "attempt-run-2",
    };
    assert.equal((begin(run2Begin) as CommandResult).ok, true);
    assert.equal((resolveDispatch(run2Resolution) as CommandResult).ok, true);
    const run = database.prepare("SELECT external_side_effect_state FROM runs WHERE id = 'run-2'").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...run }, { external_side_effect_state: "unknown" });
  });
});

repositoryTest("accepted Dispatch resolution rolls back Attempt and Dispatch when Run activation aborts", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
    const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => 500);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000160", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000161", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    assert.equal((begin(dispatchBeginCommand()) as CommandResult).ok, true);
    database.exec(`
      CREATE TRIGGER test_abort_run_activation BEFORE UPDATE OF phase ON runs
      WHEN NEW.phase = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'injected Run activation failure');
      END;
    `);
    assert.throws(() => resolveDispatch(dispatchResolutionCommand("accepted")), /injected Run activation failure/u);
    const state = database
      .prepare(
        `
        SELECT r.phase, a.attempt_state, a.external_execution_id,
          d.dispatch_state, d.resolved_at
        FROM runs r JOIN run_attempts a ON a.run_id = r.id
        JOIN run_dispatches d ON d.run_attempt_id = a.id
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...state },
      {
        phase: "starting",
        attempt_state: "preparing",
        external_execution_id: null,
        dispatch_state: "dispatching",
        resolved_at: null,
      },
    );
  });
});

for (const outcome of ["rejected", "ambiguous"] as const) {
  repositoryTest(`${outcome} Dispatch resolution leaves Attempt and Run available for recovery policy`, () => {
    withDatabase((database) => {
      const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
      const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
      const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
      const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
      const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => 500);
      assert.equal(
        (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000155", "session-1")) as CommandResult).ok,
        true,
      );
      assert.equal(
        (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000156", "run-1", "create")) as CommandResult)
          .ok,
        true,
      );
      assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
      assert.equal((begin(dispatchBeginCommand()) as CommandResult).ok, true);
      const command = dispatchResolutionCommand(outcome);
      assert.equal((resolveDispatch(command) as CommandResult).ok, true);
      const replay = resolveDispatch(command) as CommandResult;
      assert.equal(replay.ok && replay.replayed, true);
      const state = database
        .prepare(
          `
          SELECT r.phase, a.attempt_state, d.dispatch_state
          FROM runs r JOIN run_attempts a ON a.run_id = r.id
          JOIN run_dispatches d ON d.run_attempt_id = a.id
        `,
        )
        .get() as Record<string, unknown>;
      assert.deepEqual({ ...state }, { phase: "starting", attempt_state: "preparing", dispatch_state: outcome });
      database
        .prepare(
          `
          UPDATE run_attempts SET attempt_state = 'failed', failure_origin = 'provider', terminal_at = 600
          WHERE id = 'attempt-run-1'
        `,
        )
        .run();
      database
        .prepare(
          `
          UPDATE runs SET phase = 'failed', failure_origin = 'provider', terminal_at = 600, updated_at = 600
          WHERE id = 'run-1'
        `,
        )
        .run();
      const replayAfterFailure = resolveDispatch(command) as CommandResult;
      assert.equal(replayAfterFailure.ok && replayAfterFailure.replayed, true);

      database
        .prepare(
          `
          UPDATE provider_bindings SET binding_state = 'invalidated', invalidated_at = 601,
            invalidation_reason = 'test replacement' WHERE id = 'binding-run-1'
        `,
        )
        .run();
      database
        .prepare(
          `
          INSERT INTO provider_bindings (
            id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
            binding_state, created_by_run_attempt_id, created_at
          ) VALUES ('binding-replacement', 'session-1', 2, 'provider', 'external-replacement',
            'persistent', 'active', 'attempt-run-1', 601)
        `,
        )
        .run();
      const wrongBinding = resolveDispatch({ ...command, bindingId: "binding-replacement" }) as CommandResult;
      assert.equal(!wrongBinding.ok && wrongBinding.error.code, "lifecycle_conflict");
    });
  });
}

repositoryTest("ephemeral Binding ownership permits dispatch only in the activating Worker generation", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000157", "session-1"),
      ).ok,
      true,
    );
    now = 200;
    const baseAdmission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000158", "run-1", "create");
    const admission = {
      ...baseAdmission,
      bindingIntent: { kind: "create", bindingId: "binding-run-1", persistenceMode: "ephemeral" },
    } as const;
    assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, admission).ok, true);
    now = 300;
    const ownerToken = "018f1f4e-7f0a-7000-8000-000000000159";
    const resolution = {
      ...bindingResolutionCommand("active"),
      resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
    } as const;
    const activated = execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, resolution);
    assert.equal(activated.ok && activated.value.ephemeralOwnership, "registered");

    const restartedOperations = createRepositoryWriteOperations(database, { clock: () => 400 });
    const restartedResolve = restartedOperations.get(REPOSITORY_WRITE_OPERATIONS.bindingResolve);
    const restartedBegin = restartedOperations.get(REPOSITORY_WRITE_OPERATIONS.dispatchBegin);
    assert.ok(restartedResolve && restartedBegin);
    const replay = restartedResolve.execute(resolution).result as CommandResult;
    assert.equal(replay.ok && replay.value.ephemeralOwnership, "unavailable");
    const rejected = restartedBegin.execute(dispatchBeginCommand(ownerToken)).result as CommandResult;
    assert.equal(!rejected.ok && rejected.error.code, "reference_invalid");

    now = 500;
    const allowed = execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(ownerToken));
    assert.equal(allowed.ok && allowed.value.sendAllowed, true);
  });
});

repositoryTest("ephemeral Dispatch resolution remains available after Worker restart", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000182", "session-1"),
      ).ok,
      true,
    );
    now = 200;
    const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000183", "run-1", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...admission,
        bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    const ownerToken = "018f1f4e-7f0a-7000-8000-000000000184";
    now = 300;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
      }).ok,
      true,
    );
    now = 400;
    assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(ownerToken)).ok, true);
    now = 500;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.dispatchResolve, dispatchResolutionCommand("ambiguous", ownerToken)).ok,
      true,
    );

    now = 600;
    const restarted = createRepositoryWriteOperations(database, { clock: () => now });
    const repair = restarted.get(REPOSITORY_WRITE_OPERATIONS.startupRepair);
    const resolve = restarted.get(REPOSITORY_WRITE_OPERATIONS.dispatchResolve);
    const terminal = restarted.get(REPOSITORY_WRITE_OPERATIONS.runTerminal);
    assert.ok(repair && resolve && terminal);
    const inspection = repair.execute({}).result as CommandResult;
    assert.equal(
      inspection.ok && (inspection.value.inspection as Readonly<Record<string, unknown>>).providerDispatchCandidates,
      1,
    );
    assert.equal(
      inspection.ok && (inspection.value.inspection as Readonly<Record<string, unknown>>).ephemeralResumeBlockedRuns,
      1,
    );
    const staleOwner = resolve.execute(dispatchResolutionCommand("accepted", ownerToken)).result as CommandResult;
    assert.equal(!staleOwner.ok && staleOwner.error.code, "reference_invalid");
    const accepted = resolve.execute(dispatchResolutionCommand("accepted", null)).result as CommandResult;
    assert.equal(accepted.ok && accepted.value.dispatchState, "accepted");
    const staleReplay = resolve.execute(dispatchResolutionCommand("accepted", ownerToken)).result as CommandResult;
    assert.equal(!staleReplay.ok && staleReplay.error.code, "reference_invalid");
    const recoveredReplay = resolve.execute(dispatchResolutionCommand("accepted", null)).result as CommandResult;
    assert.equal(recoveredReplay.ok && recoveredReplay.replayed, true);
    now = 700;
    const completed = terminal.execute(runTerminalCommand()).result as CommandResult;
    assert.equal(completed.ok && completed.value.phase, "completed");
  });
});

repositoryTest("ephemeral Binding ownership cannot move to another Attempt in the same Session", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-00000000015a", "session-1"),
      ).ok,
      true,
    );
    now = 200;
    const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-00000000015b", "run-1", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...admission,
        bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    now = 250;
    const ownerToken = "018f1f4e-7f0a-7000-8000-00000000015c";
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
      }).ok,
      true,
    );
    database.exec(`
      UPDATE run_dispatches SET dispatch_state = 'aborted', resolved_at = 275
      WHERE run_attempt_id = 'attempt-run-1';
      UPDATE run_attempts
      SET attempt_state = 'interrupted', failure_origin = 'application', terminal_at = 275
      WHERE id = 'attempt-run-1';
      UPDATE runs
      SET phase = 'canceled', terminal_at = 275, updated_at = 275, version = version + 1
      WHERE id = 'run-1';
      INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at)
      VALUES ('message-run-2', 'session-1', 2, 'user', '[]', 300);
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, updated_at, version
      ) VALUES ('run-2', 'session-1', 2, 'message-run-2', 'queued', '{}', 'none', 300, 300, 0);
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
      ) VALUES ('attempt-run-2', 'run-2', 1, 'binding-run-1', 'initial', 'preparing', 300);
      INSERT INTO run_dispatches (
        run_attempt_id, dispatch_state, request_fingerprint, provider_idempotency_key, created_at
      ) SELECT 'attempt-run-2', 'pending', request_fingerprint, provider_idempotency_key, 300
        FROM run_dispatches WHERE run_attempt_id = 'attempt-run-1';
    `);

    now = 325;
    const begin = execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, {
      ...dispatchBeginCommand(ownerToken),
      runId: "run-2",
      attemptId: "attempt-run-2",
    });
    assert.equal(!begin.ok && begin.error.code, "not_found");

    database
      .prepare(
        `
        UPDATE run_dispatches
        SET dispatch_state = 'ambiguous', dispatching_at = 325, resolved_at = 350
        WHERE run_attempt_id = 'attempt-run-2'
      `,
      )
      .run();
    now = 400;
    const repair = execute(REPOSITORY_WRITE_OPERATIONS.startupRepair, {});
    assert.equal(
      repair.ok && (repair.value.inspection as Readonly<Record<string, unknown>>).providerDispatchCandidates,
      0,
    );
  });
});

repositoryTest(
  "supplemental input admission atomically creates a user Message, pending Delivery, and replay record",
  () => {
    withDatabase((database) => {
      activatePersistentRun(database);
      const admitInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => 600);
      const command = runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000169");
      const first = admitInput(command) as CommandResult;
      const replay = admitInput(command) as CommandResult;
      const conflict = admitInput({
        ...command,
        message: { ...command.message, contentBlocks: [{ type: "text", text: "different" }] },
      }) as CommandResult;

      assert.equal(first.ok && !first.replayed && first.value.deliveryState, "pending");
      assert.equal(replay.ok && replay.replayed, true);
      assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");
      const state = database
        .prepare(
          `
        SELECT m.role, m.content_blocks_json, i.delivery_state, i.created_at,
          r.response_ref_type, r.response_ref_id, s.last_activity_at
        FROM messages m
        JOIN run_input_deliveries i ON i.message_id = m.id
        JOIN idempotency_records r ON r.idempotency_key = ?
        JOIN sessions s ON s.id = m.session_id
        WHERE m.id = ?
      `,
        )
        .get(command.idempotencyKey, command.message.id) as Record<string, unknown>;
      assert.deepEqual(
        { ...state },
        {
          role: "user",
          content_blocks_json: '[{"text":"more","type":"text"}]',
          delivery_state: "pending",
          created_at: 600,
          response_ref_type: "delivery",
          response_ref_id: "message-input-1",
          last_activity_at: 600,
        },
      );
      const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 650);
      const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 650);
      assert.equal(
        (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000168", "session-2")) as CommandResult).ok,
        true,
      );
      assert.equal(
        (
          admit({
            ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000167", "run-2", "create"),
            sessionId: "session-2",
          }) as CommandResult
        ).ok,
        true,
      );
      database
        .prepare("UPDATE provider_bindings SET created_by_run_attempt_id = 'attempt-run-2' WHERE id = 'binding-run-1'")
        .run();
      const foreignReplay = admitInput(command) as CommandResult;
      assert.equal(!foreignReplay.ok && foreignReplay.error.code, "reference_invalid");
    });
  },
);

repositoryTest("supplemental input admission rejects stale Gate state and rolls back injected Delivery failure", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const admitInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => 600);
    database.prepare("UPDATE runs SET phase = 'canceling', cancel_requested_at = 550 WHERE id = 'run-1'").run();
    const stale = admitInput(runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000170")) as CommandResult;
    assert.equal(!stale.ok && stale.error.code, "lifecycle_conflict");
    assert.equal(database.prepare("SELECT 1 FROM messages WHERE id = 'message-input-1'").get(), undefined);

    database.prepare("UPDATE runs SET phase = 'active', cancel_requested_at = NULL WHERE id = 'run-1'").run();
    database.exec(`
      CREATE TRIGGER test_abort_input_delivery BEFORE INSERT ON run_input_deliveries
      BEGIN
        SELECT RAISE(ABORT, 'injected input delivery failure');
      END;
    `);
    assert.throws(
      () => admitInput(runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000171")),
      /injected input delivery failure/u,
    );
    assert.equal(database.prepare("SELECT 1 FROM messages WHERE id = 'message-input-1'").get(), undefined);
    assert.equal(
      database
        .prepare("SELECT 1 FROM idempotency_records WHERE idempotency_key = ?")
        .get("018f1f4e-7f0a-7000-8000-000000000171"),
      undefined,
    );
  });
});

repositoryTest("supplemental input admission directly enforces idempotency expiry and Delivery references", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    let now = 600;
    const expiring = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => now, 1);
    const expiredCommand = runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000179");
    assert.equal((expiring(expiredCommand) as CommandResult).ok, true);
    now = 601;
    const expired = expiring(expiredCommand) as CommandResult;
    assert.equal(!expired.ok && expired.error.code, "idempotency_expired");
    const tombstone = database
      .prepare(
        `
        SELECT record_state, response_ref_type, response_ref_id, response_envelope_json
        FROM idempotency_records WHERE idempotency_key = ?
      `,
      )
      .get(expiredCommand.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual(
      { ...tombstone },
      { record_state: "expired", response_ref_type: null, response_ref_id: null, response_envelope_json: null },
    );

    now = 700;
    const longLived = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => now, 1_000);
    const missingCommand = {
      ...runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000180"),
      message: { id: "message-input-2", contentBlocks: [{ type: "text", text: "again" }] },
    };
    assert.equal((longLived(missingCommand) as CommandResult).ok, true);
    database.exec("PRAGMA foreign_keys = OFF;");
    database.prepare("DELETE FROM run_input_deliveries WHERE message_id = 'message-input-2'").run();
    const missing = longLived(missingCommand) as CommandResult;
    assert.equal(!missing.ok && missing.error.code, "reference_invalid");
  });
});

for (const outcome of ["accepted", "rejected", "ambiguous"] as const) {
  repositoryTest(`supplemental input ${outcome} resolution is terminal and never re-allows send`, () => {
    withDatabase((database) => {
      activatePersistentRun(database);
      const admitInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => 600);
      const beginInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputBegin, () => 700);
      const resolveInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputResolve, () => 800);
      assert.equal(
        (admitInput(runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000172")) as CommandResult).ok,
        true,
      );
      const beginCommand = runInputBeginCommand();
      const firstBegin = beginInput(beginCommand) as CommandResult;
      const beginReplay = beginInput(beginCommand) as CommandResult;
      assert.equal(firstBegin.ok && firstBegin.value.sendAllowed, true);
      assert.equal(beginReplay.ok && beginReplay.replayed && !beginReplay.value.sendAllowed, true);
      const inFlightAdmissionReplay = admitInput(
        runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000172"),
      ) as CommandResult;
      assert.equal(inFlightAdmissionReplay.ok && inFlightAdmissionReplay.replayed, true);
      assert.equal(inFlightAdmissionReplay.ok && inFlightAdmissionReplay.value.deliveryState, "pending");

      database
        .prepare("UPDATE runs SET phase = 'completed', terminal_at = 750, updated_at = 750 WHERE id = 'run-1'")
        .run();
      database
        .prepare("UPDATE run_attempts SET attempt_state = 'succeeded', terminal_at = 750 WHERE id = 'attempt-run-1'")
        .run();
      const resolutionCommand = runInputResolutionCommand(outcome);
      const firstResolution = resolveInput(resolutionCommand) as CommandResult;
      const replay = resolveInput(resolutionCommand) as CommandResult;
      const conflict = resolveInput(
        runInputResolutionCommand(outcome === "accepted" ? "rejected" : "accepted"),
      ) as CommandResult;
      assert.equal(firstResolution.ok && !firstResolution.replayed, true);
      assert.equal(replay.ok && replay.replayed, true);
      assert.equal(!conflict.ok && conflict.error.code, "lifecycle_conflict");
      const admissionReplay = admitInput(
        runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000172"),
      ) as CommandResult;
      assert.equal(admissionReplay.ok && admissionReplay.replayed, true);
      assert.equal(admissionReplay.ok && admissionReplay.value.deliveryState, outcome);
      const row = database
        .prepare("SELECT delivery_state, resolution_code, dispatching_at, resolved_at FROM run_input_deliveries")
        .get() as Record<string, unknown>;
      assert.deepEqual(
        { ...row },
        {
          delivery_state: outcome,
          resolution_code:
            outcome === "accepted" ? null : outcome === "rejected" ? "provider_rejected" : "transport_unknown",
          dispatching_at: 700,
          resolved_at: 800,
        },
      );
    });
  });
}

repositoryTest("ephemeral supplemental input cannot begin after Worker ownership is lost", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000173", "session-1"),
      ).ok,
      true,
    );
    now = 200;
    const baseAdmission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000174", "run-1", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...baseAdmission,
        bindingIntent: { kind: "create", bindingId: "binding-run-1", persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    const ownerToken = "018f1f4e-7f0a-7000-8000-000000000175";
    now = 300;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
      }).ok,
      true,
    );
    now = 400;
    assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(ownerToken)).ok, true);
    now = 500;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.dispatchResolve, dispatchResolutionCommand("accepted", ownerToken)).ok,
      true,
    );
    now = 600;
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.runInputAdmit,
        runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000176", ownerToken),
      ).ok,
      true,
    );

    const restarted = createRepositoryWriteOperations(database, { clock: () => 700 });
    const restartedAdmit = restarted.get(REPOSITORY_WRITE_OPERATIONS.runInputAdmit);
    const restartedBegin = restarted.get(REPOSITORY_WRITE_OPERATIONS.runInputBegin);
    const restartedResolve = restarted.get(REPOSITORY_WRITE_OPERATIONS.runInputResolve);
    assert.ok(restartedAdmit && restartedBegin && restartedResolve);
    const undeliverable = restartedAdmit.execute({
      ...runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000181", ownerToken),
      message: { id: "message-input-after-restart", contentBlocks: [{ type: "text", text: "later" }] },
    }).result as CommandResult;
    assert.equal(!undeliverable.ok && undeliverable.error.code, "reference_invalid");
    assert.equal(database.prepare("SELECT 1 FROM messages WHERE id = 'message-input-after-restart'").get(), undefined);
    const rejected = restartedBegin.execute(runInputBeginCommand(ownerToken)).result as CommandResult;
    assert.equal(!rejected.ok && rejected.error.code, "reference_invalid");
    const allowed = execute(REPOSITORY_WRITE_OPERATIONS.runInputBegin, runInputBeginCommand(ownerToken));
    assert.equal(allowed.ok && allowed.value.sendAllowed, true);
    const staleOwner = restartedResolve.execute(runInputResolutionCommand("accepted", ownerToken))
      .result as CommandResult;
    assert.equal(!staleOwner.ok && staleOwner.error.code, "reference_invalid");
    const recovered = restartedResolve.execute(runInputResolutionCommand("accepted", null)).result as CommandResult;
    assert.equal(recovered.ok && recovered.value.deliveryState, "accepted");
    const staleReplay = restartedResolve.execute(runInputResolutionCommand("accepted", ownerToken))
      .result as CommandResult;
    assert.equal(!staleReplay.ok && staleReplay.error.code, "reference_invalid");
    const recoveredReplay = restartedResolve.execute(runInputResolutionCommand("accepted", null))
      .result as CommandResult;
    assert.equal(recoveredReplay.ok && recoveredReplay.replayed, true);
  });
});

repositoryTest("supplemental input resolution rejects undefined reason codes", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const resolveInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputResolve, () => 800);
    const invalid = resolveInput({
      ...runInputResolutionCommand("ambiguous"),
      outcome: { kind: "ambiguous", resolutionCode: "raw_provider_error" },
    }) as CommandResult;
    assert.equal(!invalid.ok && invalid.error.code, "request_invalid");
  });
});

repositoryTest("Run output stores item and prepared payload atomically and replays Provider identity", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const append = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runOutputAppend, () => 600);
    const command = runOutputAppendCommand("output-1", "provider-output-1", "hello");
    const first = append(command) as CommandResult;
    const replay = append(command) as CommandResult;

    assert.equal(first.ok && first.value.payloadState, "stored");
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(count(database, "run_output_items"), 1);
    assert.equal(count(database, "run_output_payloads"), 1);
    const row = database
      .prepare(
        `
        SELECT o.ordinal, o.payload_state, o.stored_payload_id, p.byte_length, p.content_sha256
        FROM run_output_items o JOIN run_output_payloads p ON p.output_item_id = o.id
        WHERE o.id = 'output-1'
      `,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      {
        ordinal: 1,
        payload_state: "stored",
        stored_payload_id: "output-1",
        byte_length: 5,
        content_sha256: createHash("sha256").update("hello").digest("hex"),
      },
    );

    const conflict = append({ ...command, item: { ...command.item, summary: "changed" } }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "lifecycle_conflict");
  });
});

repositoryTest("Run output quota omission and payload insert failure never leave a stored item alone", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const limited = createRepositoryWriteOperations(database, {
      clock: () => 600,
      payloadLimits: { itemBytes: 4, runBytes: 4, sessionBytes: 4, appBytes: 4, minimumReserveBytes: 0 },
      diskCapacity: () => ({ availableBytes: 100, totalBytes: 100 }),
    }).get(REPOSITORY_WRITE_OPERATIONS.runOutputAppend);
    assert.ok(limited);
    const omitted = limited.execute(runOutputAppendCommand("output-big", null, "hello")).result as CommandResult;
    assert.equal(omitted.ok && omitted.value.payloadState, "omitted_size_limit");
    assert.equal(count(database, "run_output_payloads"), 0);

    database.exec(`
      CREATE TRIGGER fail_output_payload BEFORE INSERT ON run_output_payloads
      BEGIN SELECT RAISE(ABORT, 'fault injection'); END;
    `);
    const append = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runOutputAppend, () => 700);
    assert.throws(() => append(runOutputAppendCommand("output-fault", null, "ok")), /fault injection/);
    assert.equal(database.prepare("SELECT 1 FROM run_output_items WHERE id = 'output-fault'").get(), undefined);
  });
});

repositoryTest("Run output disk reserve includes conservative SQLite write overhead", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const content = "ok";
    const requiredBytes = new TextEncoder().encode(content).byteLength;
    const options = {
      clock: () => 600,
      payloadLimits: { minimumReserveBytes: 10 },
    };
    const omitted = createRepositoryWriteOperations(database, {
      ...options,
      diskCapacity: () => ({
        availableBytes: requiredBytes + RUN_OUTPUT_SQLITE_WRITE_MARGIN_BYTES + 9,
        totalBytes: 100,
      }),
    }).get(REPOSITORY_WRITE_OPERATIONS.runOutputAppend);
    assert.ok(omitted);
    const omittedResult = omitted.execute(runOutputAppendCommand("output-margin-omitted", null, content))
      .result as CommandResult;
    assert.equal(omittedResult.ok && omittedResult.value.payloadState, "omitted_size_limit");

    const stored = createRepositoryWriteOperations(database, {
      ...options,
      diskCapacity: () => ({
        availableBytes: requiredBytes + RUN_OUTPUT_SQLITE_WRITE_MARGIN_BYTES + 10,
        totalBytes: 100,
      }),
    }).get(REPOSITORY_WRITE_OPERATIONS.runOutputAppend);
    assert.ok(stored);
    const storedResult = stored.execute(runOutputAppendCommand("output-margin-stored", null, content))
      .result as CommandResult;
    assert.equal(storedResult.ok && storedResult.value.payloadState, "stored");
  });
});

repositoryTest("Run output independently enforces Run, Session, and app cumulative quotas", () => {
  for (const quota of ["run", "session", "app"] as const) {
    withDatabase((database) => {
      activatePersistentRun(database);
      if (quota === "run") {
        insertStoredQuotaFixture(database, "run-1", "output-run-quota-seed", "abc");
      } else if (quota === "session") {
        insertQuotaHistoryRun(database, "session-1", "run-session-quota-history", "message-session-quota-history");
        insertStoredQuotaFixture(database, "run-session-quota-history", "output-session-quota-seed", "abc");
      } else {
        database
          .prepare(
            `
            INSERT INTO sessions (
              id, provider_id, workspace_key, workspace_path, allowed_additional_directories_json,
              default_character_id, max_concurrent_child_runs, lifecycle_status,
              created_at, updated_at, last_activity_at
            ) VALUES ('session-app-quota-history', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 1, 1)
          `,
          )
          .run();
        insertQuotaHistoryRun(
          database,
          "session-app-quota-history",
          "run-app-quota-history",
          "message-app-quota-history",
        );
        insertStoredQuotaFixture(database, "run-app-quota-history", "output-app-quota-seed", "abc");
      }

      const append = createRepositoryWriteOperations(database, {
        clock: () => 600,
        payloadLimits: {
          itemBytes: 10,
          runBytes: quota === "run" ? 4 : 100,
          sessionBytes: quota === "session" ? 4 : 100,
          appBytes: quota === "app" ? 4 : 100,
          minimumReserveBytes: 0,
        },
      }).get(REPOSITORY_WRITE_OPERATIONS.runOutputAppend);
      assert.ok(append);
      const result = append.execute(runOutputAppendCommand(`output-${quota}-quota`, null, "ok"))
        .result as CommandResult;
      assert.equal(result.ok && result.value.payloadState, "omitted_size_limit", `${quota} quota must omit payload`);
    });
  }
});

repositoryTest("Run output rejects malformed prepared JSON before opening its transaction", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const append = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runOutputAppend, () => 600);
    const command = runOutputAppendCommand("output-json", null, "{not-json");
    command.item.payload.payloadFormat = "json";
    const result = append(command) as CommandResult;
    assert.equal(!result.ok && result.error.code, "request_invalid");
    assert.equal(count(database, "run_output_items"), 0);
  });
});

repositoryTest(
  "Run terminal commits Attempt, final Message, event, pending output, and Session activity together",
  () => {
    withDatabase((database) => {
      activatePersistentRun(database);
      const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
      const command = runTerminalCommand();
      const first = terminal(command) as CommandResult;
      const replay = terminal(command) as CommandResult;
      assert.equal(first.ok && first.value.phase, "completed");
      assert.equal(replay.ok && replay.replayed, true);
      const changedReplay = terminal({ ...command, outputs: [] }) as CommandResult;
      assert.equal(!changedReplay.ok && changedReplay.error.code, "lifecycle_conflict");

      const run = database
        .prepare("SELECT phase, final_assistant_message_id, terminal_at FROM runs WHERE id = 'run-1'")
        .get() as Record<string, unknown>;
      assert.deepEqual(
        { ...run },
        { phase: "completed", final_assistant_message_id: "message-final-1", terminal_at: 700 },
      );
      assert.equal(
        (
          database.prepare("SELECT attempt_state FROM run_attempts WHERE id = 'attempt-run-1'").get() as {
            attempt_state: string;
          }
        ).attempt_state,
        "succeeded",
      );
      assert.equal(count(database, "messages"), 2);
      assert.equal(count(database, "run_events"), 1);
      assert.equal(
        (
          database.prepare("SELECT summary FROM run_events WHERE id = 'terminal-event-1'").get() as {
            summary: string | null;
          }
        ).summary,
        null,
      );
      assert.equal(
        (
          database.prepare("SELECT payload_state FROM run_output_items WHERE id = 'output-pending-1'").get() as {
            payload_state: string;
          }
        ).payload_state,
        "pending",
      );
      assert.equal(
        (
          database.prepare("SELECT last_activity_at FROM sessions WHERE id = 'session-1'").get() as {
            last_activity_at: number;
          }
        ).last_activity_at,
        700,
      );
    });
  },
);

repositoryTest("pre-dispatch terminal rejects unresolved intent and releases a Session without startup repair", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000700", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000701", "run-1", "create")) as CommandResult).ok,
      true,
    );

    const unresolved = terminal(preparingRunTerminalCommand("not_applicable", "canceled")) as CommandResult;
    assert.equal(!unresolved.ok && unresolved.error.code, "lifecycle_conflict");

    const command = preparingRunTerminalCommand("binding_creation_not_sent", "canceled");
    const first = terminal(command) as CommandResult;
    const replay = terminal(command) as CommandResult;
    assert.equal(first.ok && first.value.phase, "canceled");
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, b.invalidation_reason, a.attempt_state, d.dispatch_state,
                   r.phase, r.external_side_effect_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidation_reason: "conversation_start_not_sent",
        attempt_state: "interrupted",
        dispatch_state: "aborted",
        phase: "canceled",
        external_side_effect_state: "none",
      },
    );

    const next = admit(
      normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000702", "run-2", "create"),
    ) as CommandResult;
    assert.equal(next.ok, true);
  });
});

repositoryTest("pre-dispatch terminal distinguishes ambiguous Binding creation from an unsent request", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000703", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000704", "run-1", "create")) as CommandResult).ok,
      true,
    );

    const command = preparingRunTerminalCommand("binding_creation_ambiguous", "interrupted");
    const result = terminal(command) as CommandResult;
    assert.equal(result.ok && result.value.phase, "interrupted");
    const lateBindingResolution = resolve(ambiguousBindingResolutionPayload()) as CommandResult;
    assert.equal(!lateBindingResolution.ok && lateBindingResolution.error.code, "request_invalid");
    const replay = terminal(command) as CommandResult;
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, b.invalidation_reason, d.dispatch_state,
                   r.phase, r.external_side_effect_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidation_reason: "conversation_start_ambiguous",
        dispatch_state: "aborted",
        phase: "interrupted",
        external_side_effect_state: "unknown",
      },
    );
    assert.equal(count(database, "run_events"), 1);
  });
});

repositoryTest(
  "pre-dispatch terminal preserves an active persistent Binding and aborts only its pending Dispatch",
  () => {
    withDatabase((database) => {
      const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
      const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
      const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 250);
      const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
      assert.equal(
        (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000705", "session-1")) as CommandResult).ok,
        true,
      );
      assert.equal(
        (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000706", "run-1", "create")) as CommandResult)
          .ok,
        true,
      );
      assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);

      const result = terminal(preparingRunTerminalCommand("dispatch_not_sent", "canceled")) as CommandResult;
      assert.equal(result.ok && result.value.phase, "canceled");
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
            SELECT b.binding_state, b.invalidation_reason, d.dispatch_state,
                   r.phase, r.external_side_effect_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.provider_binding_id = b.id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
            )
            .get(),
        },
        {
          binding_state: "active",
          invalidation_reason: null,
          dispatch_state: "aborted",
          phase: "canceled",
          external_side_effect_state: "present",
        },
      );

      const next = admit(
        normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000707", "run-2", "reuse"),
      ) as CommandResult;
      assert.equal(next.ok, true);
    });
  },
);

repositoryTest("pre-dispatch terminal replay survives later persistent Binding invalidation", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 250);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000717", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000718", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    const command = preparingRunTerminalCommand("dispatch_not_sent", "canceled");
    assert.equal((terminal(command) as CommandResult).ok, true);
    database
      .prepare(
        `
        UPDATE provider_bindings
        SET binding_state = 'invalidated', invalidated_at = 400, invalidation_reason = 'later_replacement'
        WHERE id = 'binding-run-1'
      `,
      )
      .run();

    const replay = terminal(command) as CommandResult;
    assert.equal(replay.ok && replay.replayed, true);
  });
});

repositoryTest("pre-dispatch terminal closes a retry admission through the shared Run boundary", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const completeSource = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((completeSource(runTerminalCommand()) as CommandResult).ok, true);
    const retry = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runRetry, () => 800);
    assert.equal(
      (
        retry(
          retryRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000719", "run-2", "run-1", "reuse"),
        ) as CommandResult
      ).ok,
      true,
    );
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 900);
    const result = terminal({
      ...preparingRunTerminalCommand("dispatch_not_sent", "canceled"),
      runId: "run-2",
      attemptId: "attempt-run-2",
      terminalEvent: { id: "terminal-event-retry", dedupeKey: "provider-terminal-retry" },
    }) as CommandResult;
    assert.equal(result.ok && result.value.phase, "canceled");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, d.dispatch_state, a.attempt_state, r.phase
            FROM runs r
            JOIN run_attempts a ON a.run_id = r.id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN provider_bindings b ON b.id = a.provider_binding_id
            WHERE r.id = 'run-2'
          `,
          )
          .get(),
      },
      { binding_state: "active", dispatch_state: "aborted", attempt_state: "interrupted", phase: "canceled" },
    );
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 1_000);
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000720", "run-3", "reuse")) as CommandResult).ok,
      true,
    );
  });
});

repositoryTest("pre-dispatch terminal rejects a Dispatch whose send outcome is already unresolved", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 250);
    const beginDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 275);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000710", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000711", "run-1", "create")) as CommandResult).ok,
      true,
    );
    assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
    assert.equal((beginDispatch(dispatchBeginCommand()) as CommandResult).ok, true);

    const result = terminal(preparingRunTerminalCommand("dispatch_not_sent", "canceled")) as CommandResult;
    assert.equal(!result.ok && result.error.code, "lifecycle_conflict");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, a.attempt_state, d.dispatch_state, r.phase
            FROM provider_bindings b
            JOIN run_attempts a ON a.provider_binding_id = b.id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
          )
          .get(),
      },
      { binding_state: "active", attempt_state: "preparing", dispatch_state: "dispatching", phase: "starting" },
    );
  });
});

repositoryTest("pre-dispatch terminal invalidates an active ephemeral Binding before releasing its Session", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000712", "session-1"),
      ).ok,
      true,
    );
    const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000713", "run-1", "create");
    now = 200;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...admission,
        bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    now = 250;
    const ownerToken = "018f1f4e-7f0a-7000-8000-000000000714";
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
      }).ok,
      true,
    );

    now = 300;
    const result = execute(
      REPOSITORY_WRITE_OPERATIONS.runTerminal,
      preparingRunTerminalCommand("dispatch_not_sent", "canceled"),
    );
    assert.equal(result.ok && result.value.phase, "canceled");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, b.invalidation_reason, d.dispatch_state,
                   r.phase, r.external_side_effect_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.provider_binding_id = b.id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidation_reason: "ephemeral_run_terminal",
        dispatch_state: "aborted",
        phase: "canceled",
        external_side_effect_state: "present",
      },
    );
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.runAdmit,
        normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000715", "run-2", "create"),
      ).ok,
      true,
    );
  });
});

repositoryTest("Run terminal converges unresolved supplemental input before invalidating an ephemeral Binding", () => {
  for (const deliveryState of ["pending", "dispatching"] as const) {
    withDatabase((database) => {
      let now = 100;
      const operations = createRepositoryWriteOperations(database, { clock: () => now });
      const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
        const operation = operations.get(name);
        assert.ok(operation);
        return operation.execute(payload).result as CommandResult;
      };
      assert.equal(
        execute(
          REPOSITORY_WRITE_OPERATIONS.sessionCreate,
          sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000713", "session-1"),
        ).ok,
        true,
      );
      now = 200;
      const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000714", "run-1", "create");
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
          ...admission,
          bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
        }).ok,
        true,
      );
      const ownerToken = "018f1f4e-7f0a-7000-8000-000000000715";
      now = 300;
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
          ...bindingResolutionCommand("active"),
          resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
        }).ok,
        true,
      );
      now = 400;
      assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(ownerToken)).ok, true);
      now = 500;
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.dispatchResolve, dispatchResolutionCommand("accepted", ownerToken)).ok,
        true,
      );
      now = 600;
      const inputCommand = runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000716", ownerToken);
      assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.runInputAdmit, inputCommand).ok, true);
      if (deliveryState === "dispatching") {
        now = 650;
        assert.equal(execute(REPOSITORY_WRITE_OPERATIONS.runInputBegin, runInputBeginCommand(ownerToken)).ok, true);
      }

      now = 700;
      const completed = execute(REPOSITORY_WRITE_OPERATIONS.runTerminal, runTerminalCommand());
      assert.equal(completed.ok && completed.value.phase, "completed");
      const delivery = database
        .prepare("SELECT delivery_state, resolution_code, dispatching_at, resolved_at FROM run_input_deliveries")
        .get() as Record<string, unknown>;
      assert.deepEqual(
        { ...delivery },
        deliveryState === "pending"
          ? {
              delivery_state: "aborted",
              resolution_code: "run_terminal_not_sent",
              dispatching_at: null,
              resolved_at: 700,
            }
          : {
              delivery_state: "ambiguous",
              resolution_code: "process_unknown",
              dispatching_at: 650,
              resolved_at: 700,
            },
      );
      const binding = database
        .prepare("SELECT binding_state, invalidation_reason FROM provider_bindings WHERE id = 'binding-run-1'")
        .get() as Record<string, unknown>;
      assert.deepEqual({ ...binding }, { binding_state: "invalidated", invalidation_reason: "ephemeral_run_terminal" });
      if (deliveryState === "pending") {
        assert.throws(
          () =>
            database
              .prepare("UPDATE run_input_deliveries SET dispatching_at = 650 WHERE delivery_state = 'aborted'")
              .run(),
          /constraint/iu,
        );
      }

      const admissionReplay = execute(REPOSITORY_WRITE_OPERATIONS.runInputAdmit, inputCommand);
      assert.equal(
        admissionReplay.ok && admissionReplay.replayed && admissionReplay.value.deliveryState,
        deliveryState === "pending" ? "aborted" : "ambiguous",
      );
      if (deliveryState === "dispatching") {
        const resolutionReplay = execute(REPOSITORY_WRITE_OPERATIONS.runInputResolve, {
          ...runInputResolutionCommand("ambiguous", null),
          outcome: { kind: "ambiguous", resolutionCode: "process_unknown" },
        });
        assert.equal(resolutionReplay.ok && resolutionReplay.replayed, true);
      }
    });
  }
});

repositoryTest("Run terminal rolls back supplemental input convergence on a late fault", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const admitInput = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runInputAdmit, () => 600);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal(
      (admitInput(runInputAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000717")) as CommandResult).ok,
      true,
    );
    database.exec(`
      CREATE TRIGGER fail_terminal_after_input_convergence BEFORE INSERT ON run_events
      WHEN NEW.event_code = 'run.terminal'
      BEGIN SELECT RAISE(ABORT, 'terminal input convergence fault injection'); END;
    `);

    assert.throws(() => terminal(runTerminalCommand()), /terminal input convergence fault injection/u);
    assert.deepEqual(
      {
        ...database.prepare("SELECT delivery_state, resolution_code, resolved_at FROM run_input_deliveries").get(),
      },
      { delivery_state: "pending", resolution_code: null, resolved_at: null },
    );
    assert.equal(
      (database.prepare("SELECT phase FROM runs WHERE id = 'run-1'").get() as { phase: string }).phase,
      "active",
    );
    assert.equal(count(database, "run_events"), 0);
  });
});

repositoryTest("terminal rejects an ephemeral Binding outside the Run Session and Provider scope", () => {
  for (const mismatch of ["session", "provider"] as const) {
    withDatabase((database) => {
      let now = 100;
      const operations = createRepositoryWriteOperations(database, { clock: () => now });
      const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
        const operation = operations.get(name);
        assert.ok(operation);
        return operation.execute(payload).result as CommandResult;
      };
      assert.equal(
        execute(
          REPOSITORY_WRITE_OPERATIONS.sessionCreate,
          sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000721", "session-1"),
        ).ok,
        true,
      );
      assert.equal(
        execute(
          REPOSITORY_WRITE_OPERATIONS.sessionCreate,
          sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000722", "session-2"),
        ).ok,
        true,
      );
      now = 200;
      const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000723", "run-1", "create");
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
          ...admission,
          bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
        }).ok,
        true,
      );
      now = 250;
      const ownerToken = "018f1f4e-7f0a-7000-8000-000000000724";
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
          ...bindingResolutionCommand("active"),
          resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
        }).ok,
        true,
      );

      if (mismatch === "session") {
        database.prepare("UPDATE provider_bindings SET session_id = 'session-2' WHERE id = 'binding-run-1'").run();
      } else {
        database
          .prepare("UPDATE provider_bindings SET provider_id = 'provider-other' WHERE id = 'binding-run-1'")
          .run();
      }
      now = 300;
      const terminal = execute(
        REPOSITORY_WRITE_OPERATIONS.runTerminal,
        preparingRunTerminalCommand("dispatch_not_sent", "canceled"),
      );
      assert.equal(!terminal.ok && terminal.error.code, "reference_invalid");
      assert.deepEqual(
        {
          ...database
            .prepare(
              `
              SELECT b.binding_state, a.attempt_state, d.dispatch_state, r.phase
              FROM provider_bindings b
              JOIN run_attempts a ON a.provider_binding_id = b.id
              JOIN run_dispatches d ON d.run_attempt_id = a.id
              JOIN runs r ON r.id = a.run_id
              WHERE b.id = 'binding-run-1'
            `,
            )
            .get(),
        },
        { binding_state: "active", attempt_state: "preparing", dispatch_state: "pending", phase: "queued" },
      );

      if (mismatch === "session") {
        database.prepare("UPDATE provider_bindings SET session_id = 'session-1' WHERE id = 'binding-run-1'").run();
      } else {
        database.prepare("UPDATE provider_bindings SET provider_id = 'provider' WHERE id = 'binding-run-1'").run();
      }
      now = 350;
      const dispatch = execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(ownerToken));
      assert.equal(dispatch.ok && dispatch.value.sendAllowed, true);
    });
  }
});

repositoryTest("terminal does not mutate or release a cross-Session ephemeral Binding referenced by an Attempt", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000725", "session-1"),
      ).ok,
      true,
    );
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000726", "session-2"),
      ).ok,
      true,
    );

    now = 200;
    const firstAdmission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000727", "run-1", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...firstAdmission,
        bindingIntent: { ...firstAdmission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    const firstOwner = "018f1f4e-7f0a-7000-8000-000000000728";
    now = 250;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: firstOwner },
      }).ok,
      true,
    );

    now = 300;
    const secondAdmission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000729", "run-2", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...secondAdmission,
        sessionId: "session-2",
        bindingIntent: { ...secondAdmission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    const secondOwner = "018f1f4e-7f0a-7000-8000-000000000730";
    now = 350;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        sessionId: "session-2",
        runId: "run-2",
        attemptId: "attempt-run-2",
        bindingId: "binding-run-2",
        resolution: { kind: "active", externalConversationId: "external-2", ephemeralOwnerToken: secondOwner },
      }).ok,
      true,
    );

    database.prepare("UPDATE run_attempts SET provider_binding_id = 'binding-run-2' WHERE id = 'attempt-run-1'").run();
    now = 400;
    const terminal = execute(
      REPOSITORY_WRITE_OPERATIONS.runTerminal,
      preparingRunTerminalCommand("dispatch_not_sent", "canceled"),
    );
    assert.equal(!terminal.ok && terminal.error.code, "reference_invalid");
    assert.equal(count(database, "run_events"), 0);
    assert.deepEqual(
      database
        .prepare("SELECT id, binding_state FROM provider_bindings ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "binding-run-1", binding_state: "active" },
        { id: "binding-run-2", binding_state: "active" },
      ],
    );

    database.prepare("UPDATE run_attempts SET provider_binding_id = 'binding-run-1' WHERE id = 'attempt-run-1'").run();
    now = 450;
    const firstDispatch = execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, dispatchBeginCommand(firstOwner));
    assert.equal(firstDispatch.ok && firstDispatch.value.sendAllowed, true);
    const secondDispatch = execute(REPOSITORY_WRITE_OPERATIONS.dispatchBegin, {
      ...dispatchBeginCommand(secondOwner),
      sessionId: "session-2",
      runId: "run-2",
      attemptId: "attempt-run-2",
      bindingId: "binding-run-2",
    });
    assert.equal(secondDispatch.ok && secondDispatch.value.sendAllowed, true);
  });
});

repositoryTest("terminal does not mutate an ephemeral Binding owned by another Attempt", () => {
  withDatabase((database) => {
    let now = 100;
    const operations = createRepositoryWriteOperations(database, { clock: () => now });
    const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
      const operation = operations.get(name);
      assert.ok(operation);
      return operation.execute(payload).result as CommandResult;
    };
    assert.equal(
      execute(
        REPOSITORY_WRITE_OPERATIONS.sessionCreate,
        sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000734", "session-1"),
      ).ok,
      true,
    );
    now = 200;
    const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000735", "run-1", "create");
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
        ...admission,
        bindingIntent: { ...admission.bindingIntent, persistenceMode: "ephemeral" },
      }).ok,
      true,
    );
    const ownerToken = "018f1f4e-7f0a-7000-8000-000000000736";
    now = 250;
    assert.equal(
      execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
        ...bindingResolutionCommand("active"),
        resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
      }).ok,
      true,
    );
    database.exec(`
      UPDATE run_dispatches
      SET dispatch_state = 'aborted', resolved_at = 275
      WHERE run_attempt_id = 'attempt-run-1';
      UPDATE run_attempts
      SET attempt_state = 'interrupted', failure_origin = 'application', terminal_at = 275
      WHERE id = 'attempt-run-1';
      UPDATE runs
      SET phase = 'canceled', terminal_at = 275, updated_at = 275, version = version + 1
      WHERE id = 'run-1';
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, updated_at, version
      ) SELECT 'run-foreign', session_id, 2, initiating_message_id, 'queued', execution_snapshot_json,
          'none', 275, 275, 0
        FROM runs WHERE id = 'run-1';
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
      ) VALUES ('attempt-run-foreign', 'run-foreign', 1, 'binding-run-1', 'initial', 'preparing', 275);
      INSERT INTO run_dispatches (
        run_attempt_id, dispatch_state, request_fingerprint, provider_idempotency_key, created_at
      ) SELECT 'attempt-run-foreign', 'pending', request_fingerprint, provider_idempotency_key, 275
        FROM run_dispatches WHERE run_attempt_id = 'attempt-run-1';
    `);

    now = 300;
    const terminal = execute(REPOSITORY_WRITE_OPERATIONS.runTerminal, {
      ...preparingRunTerminalCommand("dispatch_not_sent", "canceled"),
      runId: "run-foreign",
      attemptId: "attempt-run-foreign",
      terminalEvent: { id: "terminal-event-foreign-attempt", dedupeKey: "provider-terminal-foreign-attempt" },
    });
    assert.equal(!terminal.ok && terminal.error.code, "reference_invalid");
    assert.equal(count(database, "run_events"), 0);
    assert.equal(
      (
        database.prepare("SELECT binding_state FROM provider_bindings WHERE id = 'binding-run-1'").get() as {
          binding_state: string;
        }
      ).binding_state,
      "active",
    );

    now = 350;
    const replay = execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
      ...bindingResolutionCommand("active"),
      resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
    });
    assert.equal(replay.ok && replay.replayed && replay.value.ephemeralOwnership, "registered");
  });
});

repositoryTest("terminal rejects multiple Provider Bindings related to one preparing Attempt", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000731", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000732", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000733", "run-1", "create")) as CommandResult).ok,
      true,
    );
    database
      .prepare(
        `
        INSERT INTO provider_bindings (
          id, session_id, ordinal, provider_id, persistence_mode, binding_state,
          created_by_run_attempt_id, created_at, invalidated_at, invalidation_reason
        ) VALUES (
          'binding-extra', 'session-2', 1, 'provider', 'ephemeral', 'invalidated',
          'attempt-run-1', 250, 250, 'test_cross_scope'
        )
      `,
      )
      .run();

    const result = terminal(preparingRunTerminalCommand("binding_creation_not_sent", "canceled")) as CommandResult;
    assert.equal(!result.ok && result.error.code, "reference_invalid");
    assert.equal(count(database, "run_events"), 0);
    assert.deepEqual(
      database
        .prepare("SELECT id, binding_state FROM provider_bindings ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "binding-extra", binding_state: "invalidated" },
        { id: "binding-run-1", binding_state: "creating" },
      ],
    );
  });
});

repositoryTest("pre-dispatch child terminal publishes its Delivery while resolving admission state", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const startChild = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childStart, () => 600);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 650);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal(
      (startChild(childStartCommand("018f1f4e-7f0a-7000-8000-000000000716", "pre-dispatch")) as CommandResult).ok,
      true,
    );
    const ambiguous = resolve(
      ambiguousBindingResolutionPayload({
        sessionId: "child-session-pre-dispatch",
        runId: "child-run-pre-dispatch",
        attemptId: "child-attempt-pre-dispatch",
        bindingId: "child-binding-pre-dispatch",
      }),
    ) as CommandResult;
    assert.equal(!ambiguous.ok && ambiguous.error.code, "request_invalid");

    const result = terminal({
      sessionId: "child-session-pre-dispatch",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
      runId: "child-run-pre-dispatch",
      attemptId: "child-attempt-pre-dispatch",
      terminalEvent: {
        id: "child-terminal-event-pre-dispatch",
        dedupeKey: "child-provider-terminal-pre-dispatch",
      },
      preDispatchResolution: { kind: "binding_creation_ambiguous" },
      outcome: {
        kind: "interrupted",
        failureOrigin: "transport",
        providerErrorCode: null,
        errorSummary: "Conversation creation outcome is unknown.",
      },
      outputs: [],
      childResult: { workflowState: "closed", resultSummary: "Child conversation creation outcome is unknown." },
    }) as CommandResult;
    assert.equal(result.ok && result.value.childDeliveryId, "delivery-pre-dispatch");
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, b.invalidation_reason, d.dispatch_state,
                   c.availability_state, c.terminal_phase_snapshot, g.workflow_state, g.closure_reason
            FROM provider_bindings b
            JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN child_result_deliveries c ON c.child_run_id = a.run_id
            JOIN delegations g ON g.id = c.delegation_id
            WHERE a.run_id = 'child-run-pre-dispatch'
          `,
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidation_reason: "conversation_start_ambiguous",
        dispatch_state: "aborted",
        availability_state: "available",
        terminal_phase_snapshot: "interrupted",
        workflow_state: "closed",
        closure_reason: "interrupted",
      },
    );
    const terminalEventCount = database
      .prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND event_code = 'run.terminal'")
      .get("child-run-pre-dispatch") as { count: number };
    assert.equal(terminalEventCount.count, 1);
  });
});

repositoryTest("pre-dispatch terminal rolls back Binding and Dispatch resolution on a late fault", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000708", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000709", "run-1", "create")) as CommandResult).ok,
      true,
    );
    database.exec(`
      CREATE TRIGGER fail_pre_dispatch_terminal_event BEFORE INSERT ON run_events
      WHEN NEW.event_code = 'run.terminal'
      BEGIN SELECT RAISE(ABORT, 'pre-dispatch terminal fault injection'); END;
    `);

    assert.throws(
      () => terminal(preparingRunTerminalCommand("binding_creation_not_sent", "canceled")),
      /pre-dispatch terminal fault injection/,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `
            SELECT b.binding_state, b.invalidation_reason, a.attempt_state,
                   d.dispatch_state, r.phase, r.terminal_at, r.external_side_effect_state
            FROM provider_bindings b
            JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
            JOIN run_dispatches d ON d.run_attempt_id = a.id
            JOIN runs r ON r.id = a.run_id
            WHERE r.id = 'run-1'
          `,
          )
          .get(),
      },
      {
        binding_state: "creating",
        invalidation_reason: null,
        attempt_state: "preparing",
        dispatch_state: "pending",
        phase: "queued",
        terminal_at: null,
        external_side_effect_state: "none",
      },
    );
    assert.equal(count(database, "run_events"), 0);
  });
});

repositoryTest("Run terminal replay rejects an unresolved ambiguous Dispatch", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    const command = runTerminalCommand();
    assert.equal((terminal(command) as CommandResult).ok, true);
    database
      .prepare("UPDATE run_dispatches SET dispatch_state = 'ambiguous' WHERE run_attempt_id = 'attempt-run-1'")
      .run();

    const replay = terminal(command) as CommandResult;
    assert.equal(!replay.ok && replay.error.code, "lifecycle_conflict");
    assert.equal(count(database, "run_events"), 1);
  });
});

repositoryTest("Run terminal exact replay ignores object property order but rejects semantic changes", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    const command = runTerminalCommand();
    assert.equal((terminal(command) as CommandResult).ok, true);

    const reordered = terminal(reverseObjectKeyOrder(command) as Readonly<Record<string, unknown>>) as CommandResult;
    assert.equal(reordered.ok && reordered.replayed, true);

    const semanticChange = terminal({
      ...command,
      outcome: {
        ...command.outcome,
        finalAssistantMessage: {
          ...command.outcome.finalAssistantMessage,
          contentBlocks: [{ type: "text", text: "different" }],
        },
      },
    }) as CommandResult;
    assert.equal(!semanticChange.ok && semanticChange.error.code, "lifecycle_conflict");
  });
});

repositoryTest("Run terminal rejects persistence as a Provider Attempt failure origin", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    const command = runTerminalCommand();
    const result = terminal({
      ...command,
      outcome: {
        kind: "failed",
        failureOrigin: "persistence",
        providerErrorCode: null,
        errorSummary: "write failed",
      },
      outputs: [],
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "request_invalid");
    assert.equal(
      (database.prepare("SELECT phase FROM runs WHERE id = 'run-1'").get() as { phase: string }).phase,
      "active",
    );
    assert.equal(
      (
        database.prepare("SELECT attempt_state FROM run_attempts WHERE id = 'attempt-run-1'").get() as {
          attempt_state: string;
        }
      ).attempt_state,
      "active",
    );
    assert.equal(count(database, "run_events"), 0);
  });
});

repositoryTest("terminal pending output resolves one-way after terminal commit", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((terminal(runTerminalCommand()) as CommandResult).ok, true);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runOutputResolvePending, () => 800);
    const command = {
      sessionId: "session-1",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
      runId: "run-1",
      outputItemId: "output-pending-1",
      resolution: {
        state: "stored",
        payloadFormat: "text",
        mediaType: "text/plain",
        content: new TextEncoder().encode("later"),
      },
    };
    const first = resolve(command) as CommandResult;
    const replay = resolve(command) as CommandResult;
    assert.equal(first.ok && first.value.payloadState, "stored");
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(replay.ok && replay.value, first.ok && first.value);
    const terminalReplay = terminal(runTerminalCommand()) as CommandResult;
    assert.equal(terminalReplay.ok && terminalReplay.replayed, true);
    const reverse = resolve({ ...command, resolution: { state: "omitted_persistence" } }) as CommandResult;
    assert.equal(!reverse.ok && reverse.error.code, "lifecycle_conflict");
    assert.equal(count(database, "run_output_payloads"), 1);
  });
});

repositoryTest("pending payload resolution rolls back an inserted payload on a semantic update conflict", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((terminal(runTerminalCommand()) as CommandResult).ok, true);
    database.exec(`
      CREATE TRIGGER ignore_pending_resolution BEFORE UPDATE ON run_output_items
      WHEN OLD.payload_state = 'pending'
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    const resolve = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runOutputResolvePending, () => 800);
    const result = resolve({
      sessionId: "session-1",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
      runId: "run-1",
      outputItemId: "output-pending-1",
      resolution: {
        state: "stored",
        payloadFormat: "text",
        mediaType: "text/plain",
        content: new TextEncoder().encode("later"),
      },
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "lifecycle_conflict");
    assert.equal(count(database, "run_output_payloads"), 0);
    assert.equal(
      (
        database.prepare("SELECT payload_state FROM run_output_items WHERE id = 'output-pending-1'").get() as {
          payload_state: string;
        }
      ).payload_state,
      "pending",
    );
  });
});

repositoryTest("child terminal atomically closes Delegation and makes its Delivery available", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    const result = terminal(childTerminalCommand()) as CommandResult;
    assert.equal(result.ok && result.value.childDeliveryId, "delivery-child-1");
    const delivery = database
      .prepare("SELECT availability_state, terminal_phase_snapshot, result_summary FROM child_result_deliveries")
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...delivery },
      {
        availability_state: "available",
        terminal_phase_snapshot: "completed",
        result_summary: "child done",
      },
    );
    const delegation = database.prepare("SELECT workflow_state, closure_reason FROM delegations").get() as Record<
      string,
      unknown
    >;
    assert.deepEqual({ ...delegation }, { workflow_state: "closed", closure_reason: "completed" });
  });
});

repositoryTest("child terminal rolls back every terminal row when Delivery publication fails", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    database.exec(`
      CREATE TRIGGER fail_child_availability BEFORE UPDATE ON child_result_deliveries
      BEGIN SELECT RAISE(ABORT, 'terminal fault injection'); END;
    `);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.throws(() => terminal(childTerminalCommand()), /terminal fault injection/);
    assert.equal(
      (database.prepare("SELECT phase FROM runs WHERE id = 'child-run'").get() as { phase: string }).phase,
      "active",
    );
    assert.equal(database.prepare("SELECT 1 FROM messages WHERE id = 'child-final-message'").get(), undefined);
    assert.equal(count(database, "run_events"), 0);
  });
});

repositoryTest("child terminal rolls back every terminal row on a semantic Delivery conflict", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    database.exec(`
      CREATE TRIGGER ignore_child_availability BEFORE UPDATE ON child_result_deliveries
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    const result = terminal(childTerminalCommand()) as CommandResult;
    assert.equal(!result.ok && result.error.code, "lifecycle_conflict");
    assert.equal(
      (database.prepare("SELECT phase FROM runs WHERE id = 'child-run'").get() as { phase: string }).phase,
      "active",
    );
    assert.equal(database.prepare("SELECT 1 FROM messages WHERE id = 'child-final-message'").get(), undefined);
    assert.equal(count(database, "run_events"), 0);
    assert.equal(count(database, "run_output_items"), 0);
  });
});

repositoryTest("child result collect preserves first collection and replays a Delivery-scoped envelope", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((terminal(childTerminalCommand()) as CommandResult).ok, true);
    const collect = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 800);
    const command = childCollectCommand("018f1f4e-7f0a-7000-8000-000000000191", "collect-event-1");
    const first = collect(command) as CommandResult;
    const replay = collect(command) as CommandResult;
    assert.equal(first.ok && first.value.firstCollectedByParentRunId, "parent-run");
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(count(database, "idempotency_records"), 1);
    assert.equal(count(database, "run_events"), 2);
    assert.equal(
      (
        database.prepare("SELECT summary FROM run_events WHERE id = 'collect-event-1'").get() as {
          summary: string | null;
        }
      ).summary,
      null,
    );

    const recollect = collect(
      childCollectCommand("018f1f4e-7f0a-7000-8000-000000000192", "collect-event-2"),
    ) as CommandResult;
    assert.equal(recollect.ok && recollect.value.firstCollectedAt, 800);
    assert.equal(count(database, "run_events"), 3);
    const delivery = database
      .prepare(
        "SELECT availability_state, first_collected_by_parent_run_id, first_collected_at FROM child_result_deliveries",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...delivery },
      {
        availability_state: "available",
        first_collected_by_parent_run_id: "parent-run",
        first_collected_at: 800,
      },
    );
  });
});

repositoryTest("child result collect rejects pending scope and rolls back collection when Event insert fails", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    const collectPending = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 600);
    const pending = collectPending(
      childCollectCommand("018f1f4e-7f0a-7000-8000-000000000193", "collect-event-pending"),
    ) as CommandResult;
    assert.equal(!pending.ok && pending.error.code, "lifecycle_conflict");

    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((terminal(childTerminalCommand()) as CommandResult).ok, true);
    database.exec(`
      CREATE TRIGGER ignore_first_collection BEFORE UPDATE ON child_result_deliveries
      WHEN OLD.first_collected_at IS NULL
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    const semanticConflict = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 750);
    const semanticResult = semanticConflict(
      childCollectCommand("018f1f4e-7f0a-7000-8000-000000000194", "collect-event-ignore"),
    ) as CommandResult;
    assert.equal(!semanticResult.ok && semanticResult.error.code, "lifecycle_conflict");
    assert.equal(count(database, "idempotency_records"), 0);
    assert.equal(count(database, "run_events"), 1);
    database.exec("DROP TRIGGER ignore_first_collection;");
    database.exec(`
      CREATE TRIGGER fail_collect_event BEFORE INSERT ON run_events
      WHEN NEW.event_code = 'child.result.collected'
      BEGIN SELECT RAISE(ABORT, 'collect fault injection'); END;
    `);
    const collect = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 800);
    assert.throws(
      () => collect(childCollectCommand("018f1f4e-7f0a-7000-8000-000000000196", "collect-event-fault")),
      /collect fault injection/,
    );
    const delivery = database
      .prepare("SELECT first_collected_at FROM child_result_deliveries WHERE id = 'delivery-child-1'")
      .get() as { first_collected_at: number | null };
    assert.equal(delivery.first_collected_at, null);
    assert.equal(count(database, "idempotency_records"), 0);
  });
});

repositoryTest("child result collect directly rejects fingerprint reuse, missing references, and expiry", () => {
  withDatabase((database) => {
    insertChildScenario(database);
    const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
    assert.equal((terminal(childTerminalCommand()) as CommandResult).ok, true);
    const collect = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 800, 1);
    const command = childCollectCommand("018f1f4e-7f0a-7000-8000-000000000195", "collect-event-contract");
    assert.equal((collect(command) as CommandResult).ok, true);
    const envelope = (
      database
        .prepare("SELECT response_envelope_json FROM idempotency_records WHERE idempotency_key = ?")
        .get(command.idempotencyKey) as { response_envelope_json: string }
    ).response_envelope_json;
    database
      .prepare("UPDATE idempotency_records SET response_envelope_json = ? WHERE idempotency_key = ?")
      .run('{"deliveryId":"delivery-child-1"}', command.idempotencyKey);
    const corruptEnvelope = collect(command) as CommandResult;
    assert.equal(!corruptEnvelope.ok && corruptEnvelope.error.code, "reference_invalid");
    database
      .prepare("UPDATE idempotency_records SET response_envelope_json = ? WHERE idempotency_key = ?")
      .run(envelope, command.idempotencyKey);
    const conflict = collect({ ...command, eventId: "collect-event-changed" }) as CommandResult;
    assert.equal(!conflict.ok && conflict.error.code, "idempotency_conflict");

    database
      .prepare("UPDATE idempotency_records SET response_ref_id = 'missing-delivery' WHERE idempotency_key = ?")
      .run(command.idempotencyKey);
    const missing = collect(command) as CommandResult;
    assert.equal(!missing.ok && missing.error.code, "reference_invalid");
    database
      .prepare("UPDATE idempotency_records SET response_ref_id = 'delivery-child-1' WHERE idempotency_key = ?")
      .run(command.idempotencyKey);
    const expiredCollect = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 802, 1);
    const expired = expiredCollect(command) as CommandResult;
    assert.equal(!expired.ok && expired.error.code, "idempotency_expired");
    const record = database
      .prepare(
        "SELECT record_state, response_ref_id, response_envelope_json FROM idempotency_records WHERE idempotency_key = ?",
      )
      .get(command.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual({ ...record }, { record_state: "expired", response_ref_id: null, response_envelope_json: null });
  });
});

repositoryTest("startup repair converges local state and reports provider reconciliation without guessing it", () => {
  withDatabase((database) => {
    insertStartupRepairFixture(database);
    const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 100);

    const first = repair({}) as CommandResult;
    assert.deepEqual(first.ok && first.value, {
      repairedAt: 100,
      repaired: {
        expiredIdempotencyRecords: 1,
        invalidatedBindings: 1,
        abortedDispatches: 1,
        settledInputDeliveries: 2,
        availableChildResults: 1,
        repairedDelegations: 1,
        storedOutputPayloads: 1,
        omittedOutputPayloads: 1,
      },
      inspection: {
        safeDispatchCandidates: 1,
        providerBindingCandidates: 1,
        providerDispatchCandidates: 1,
        ephemeralResumeBlockedRuns: 1,
        diagnosticRuns: 1,
        diagnosticIdempotencyRecords: 2,
        diagnosticChildResults: 1,
      },
    });
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT dispatch_state, resolved_at FROM run_dispatches WHERE run_attempt_id = 'repair-terminal-attempt'",
          )
          .get(),
      },
      { dispatch_state: "aborted", resolved_at: 100 },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT delivery_state, resolution_code, dispatching_at, resolved_at FROM run_input_deliveries WHERE message_id = 'repair-collision-delivery'",
          )
          .get(),
      },
      {
        delivery_state: "aborted",
        resolution_code: "run_terminal_not_sent",
        dispatching_at: null,
        resolved_at: 100,
      },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT delivery_state, resolution_code, dispatching_at, resolved_at FROM run_input_deliveries WHERE message_id = 'repair-dispatching-delivery'",
          )
          .get(),
      },
      {
        delivery_state: "ambiguous",
        resolution_code: "process_unknown",
        dispatching_at: 3,
        resolved_at: 100,
      },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT binding_state, invalidated_at, invalidation_reason FROM provider_bindings WHERE id = 'repair-terminal-binding'",
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidated_at: 100,
        invalidation_reason: "conversation_start_ambiguous",
      },
    );
    assert.equal(
      (
        database.prepare("SELECT external_side_effect_state FROM runs WHERE id = 'repair-child-run'").get() as {
          external_side_effect_state: string;
        }
      ).external_side_effect_state,
      "present",
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT availability_state, terminal_phase_snapshot, available_at FROM child_result_deliveries WHERE id = 'repair-delivery'",
          )
          .get(),
      },
      { availability_state: "available", terminal_phase_snapshot: "completed", available_at: 20 },
    );
    assert.deepEqual(
      database
        .prepare("SELECT id, payload_state, stored_payload_id FROM run_output_items ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
      [
        { id: "repair-output-missing", payload_state: "omitted_persistence", stored_payload_id: null },
        { id: "repair-output-stored", payload_state: "stored", stored_payload_id: "repair-output-stored" },
      ],
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT record_state, response_ref_id, response_envelope_json FROM idempotency_records WHERE idempotency_key = '018f1f4e-7f0a-7000-8000-000000000501'",
          )
          .get(),
      },
      { record_state: "expired", response_ref_id: null, response_envelope_json: null },
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT latest_instruction_message_id, latest_child_run_id, workflow_state FROM delegations WHERE id = 'repair-delegation'",
          )
          .get(),
      },
      {
        latest_instruction_message_id: "repair-child-message-2",
        latest_child_run_id: "repair-child-run-2",
        workflow_state: "closed",
      },
    );

    const replay = repair({}) as CommandResult;
    assert.deepEqual(replay.ok && replay.value, {
      repairedAt: 100,
      repaired: {
        expiredIdempotencyRecords: 0,
        invalidatedBindings: 0,
        abortedDispatches: 0,
        settledInputDeliveries: 0,
        availableChildResults: 0,
        repairedDelegations: 0,
        storedOutputPayloads: 0,
        omittedOutputPayloads: 0,
      },
      inspection: first.ok && first.value.inspection,
    });
    const invalid = repair({ unexpected: true }) as CommandResult;
    assert.equal(!invalid.ok && invalid.error.code, "request_invalid");
  });
});

repositoryTest("startup repair ignores cross-scope Provider Bindings in mutations and inspection", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000737", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000738", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000739", "run-1", "create")) as CommandResult).ok,
      true,
    );
    database
      .prepare(
        `
        INSERT INTO provider_bindings (
          id, session_id, ordinal, provider_id, persistence_mode, binding_state,
          created_by_run_attempt_id, created_at, invalidated_at, invalidation_reason
        ) VALUES (
          'binding-foreign-invalidated', 'session-2', 1, 'provider', 'ephemeral', 'invalidated',
          'attempt-run-1', 250, 250, 'test_cross_scope'
        )
      `,
      )
      .run();

    const result = repair({}) as CommandResult;
    assert.equal(result.ok && (result.value.repaired as Readonly<Record<string, unknown>>).abortedDispatches, 0);
    assert.equal(
      result.ok && (result.value.inspection as Readonly<Record<string, unknown>>).providerBindingCandidates,
      1,
    );
    assert.equal(
      (
        database.prepare("SELECT dispatch_state FROM run_dispatches WHERE run_attempt_id = 'attempt-run-1'").get() as {
          dispatch_state: string;
        }
      ).dispatch_state,
      "pending",
    );
  });

  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 300);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000740", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000741", "session-2")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000742", "run-1", "create")) as CommandResult).ok,
      true,
    );
    database.exec(`
      INSERT INTO provider_bindings (
        id, session_id, ordinal, provider_id, persistence_mode, binding_state,
        created_by_run_attempt_id, created_at
      ) VALUES (
        'binding-foreign-creating', 'session-2', 1, 'provider', 'ephemeral', 'creating',
        'attempt-run-1', 250
      );
      UPDATE run_attempts SET attempt_state = 'interrupted', failure_origin = 'application', terminal_at = 275
      WHERE id = 'attempt-run-1';
      UPDATE runs SET phase = 'canceled', terminal_at = 275, updated_at = 275, version = version + 1
      WHERE id = 'run-1';
    `);

    const result = repair({}) as CommandResult;
    assert.equal(result.ok && (result.value.repaired as Readonly<Record<string, unknown>>).invalidatedBindings, 1);
    assert.equal(
      result.ok && (result.value.inspection as Readonly<Record<string, unknown>>).providerBindingCandidates,
      0,
    );
    assert.equal(
      (
        database.prepare("SELECT binding_state FROM provider_bindings WHERE id = 'binding-foreign-creating'").get() as {
          binding_state: string;
        }
      ).binding_state,
      "creating",
    );
  });

  for (const persistenceMode of ["persistent", "ephemeral"] as const) {
    withDatabase((database) => {
      let now = 100;
      const operations = createRepositoryWriteOperations(database, { clock: () => now });
      const execute = (name: string, payload: Readonly<Record<string, unknown>>) => {
        const operation = operations.get(name);
        assert.ok(operation);
        return operation.execute(payload).result as CommandResult;
      };
      assert.equal(
        execute(
          REPOSITORY_WRITE_OPERATIONS.sessionCreate,
          sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000743", "session-1"),
        ).ok,
        true,
      );
      assert.equal(
        execute(
          REPOSITORY_WRITE_OPERATIONS.sessionCreate,
          sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000744", "session-2"),
        ).ok,
        true,
      );
      now = 200;
      const admission = normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000745", "run-1", "create");
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.runAdmit, {
          ...admission,
          bindingIntent: { ...admission.bindingIntent, persistenceMode },
        }).ok,
        true,
      );
      now = 250;
      const ownerToken = persistenceMode === "ephemeral" ? "018f1f4e-7f0a-7000-8000-000000000746" : null;
      assert.equal(
        execute(REPOSITORY_WRITE_OPERATIONS.bindingResolve, {
          ...bindingResolutionCommand("active"),
          resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: ownerToken },
        }).ok,
        true,
      );
      database.prepare("UPDATE provider_bindings SET session_id = 'session-2' WHERE id = 'binding-run-1'").run();
      database.prepare("UPDATE runs SET phase = 'canceling' WHERE id = 'run-1'").run();

      now = 300;
      const result = execute(REPOSITORY_WRITE_OPERATIONS.startupRepair, {});
      assert.equal(result.ok && (result.value.repaired as Readonly<Record<string, unknown>>).abortedDispatches, 0);
      assert.equal(
        result.ok && (result.value.inspection as Readonly<Record<string, unknown>>).safeDispatchCandidates,
        0,
      );
      assert.equal(
        result.ok && (result.value.inspection as Readonly<Record<string, unknown>>).ephemeralResumeBlockedRuns,
        0,
      );
      assert.equal(
        (
          database
            .prepare("SELECT dispatch_state FROM run_dispatches WHERE run_attempt_id = 'attempt-run-1'")
            .get() as {
            dispatch_state: string;
          }
        ).dispatch_state,
        "pending",
      );
    });
  }
});

repositoryTest("startup repair rejects a Binding whose creator Attempt belongs to another Session", () => {
  for (const scenario of ["active_pending", "invalidated_pending", "dispatching", "ambiguous"] as const) {
    withDatabase((database) => {
      const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
      const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
      const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 300);
      assert.equal(
        (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000747", "session-1")) as CommandResult).ok,
        true,
      );
      assert.equal(
        (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000748", "session-2")) as CommandResult).ok,
        true,
      );
      assert.equal(
        (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000749", "run-1", "create")) as CommandResult)
          .ok,
        true,
      );
      assert.equal(
        (
          admit({
            ...normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000750", "run-2", "create"),
            sessionId: "session-2",
          }) as CommandResult
        ).ok,
        true,
      );

      const active = scenario !== "invalidated_pending";
      database.exec(`
        UPDATE provider_bindings
        SET binding_state = 'invalidated', invalidated_at = 225, invalidation_reason = 'fixture_replaced'
        WHERE id = 'binding-run-1';
        UPDATE provider_bindings
        SET session_id = 'session-1', ordinal = 2,
            binding_state = '${active ? "active" : "invalidated"}',
            external_conversation_id = ${active ? "'foreign-conversation'" : "NULL"},
            invalidated_at = ${active ? "NULL" : "225"},
            invalidation_reason = ${active ? "NULL" : "'fixture_invalidated'"}
        WHERE id = 'binding-run-2';
        UPDATE run_attempts SET provider_binding_id = 'binding-run-2' WHERE id = 'attempt-run-1';
      `);
      if (scenario === "dispatching") {
        database
          .prepare(
            "UPDATE run_dispatches SET dispatch_state = 'dispatching', dispatching_at = 250 WHERE run_attempt_id = 'attempt-run-1'",
          )
          .run();
      } else if (scenario === "ambiguous") {
        database
          .prepare(
            "UPDATE run_dispatches SET dispatch_state = 'ambiguous', dispatching_at = 250, resolved_at = 275 WHERE run_attempt_id = 'attempt-run-1'",
          )
          .run();
      }

      const result = repair({}) as CommandResult;
      assert.equal(result.ok, true);
      const repaired = result.ok ? (result.value.repaired as Readonly<Record<string, unknown>>) : {};
      const inspection = result.ok ? (result.value.inspection as Readonly<Record<string, unknown>>) : {};
      assert.equal(repaired.abortedDispatches, 0);
      assert.equal(inspection.safeDispatchCandidates, 0);
      assert.equal(inspection.providerDispatchCandidates, 0);
      assert.equal(
        (
          database
            .prepare("SELECT dispatch_state FROM run_dispatches WHERE run_attempt_id = 'attempt-run-1'")
            .get() as {
            dispatch_state: string;
          }
        ).dispatch_state,
        scenario === "invalidated_pending" || scenario === "active_pending" ? "pending" : scenario,
      );
      if (scenario === "active_pending") {
        const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 325);
        const dispatch = begin({ ...dispatchBeginCommand(), bindingId: "binding-run-2" }) as CommandResult;
        assert.equal(!dispatch.ok && dispatch.error.code, "not_found");
      }
    });
  }
});

repositoryTest("startup repair rolls back every local convergence when a later update fails", () => {
  withDatabase((database) => {
    insertStartupRepairFixture(database);
    database.exec(`
      CREATE TRIGGER fail_startup_repair_delivery BEFORE UPDATE ON child_result_deliveries
      BEGIN SELECT RAISE(ABORT, 'startup repair fault injection'); END;
    `);
    const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 100);
    assert.throws(() => repair({}), /startup repair fault injection/u);
    assert.equal(
      (
        database
          .prepare(
            "SELECT record_state FROM idempotency_records WHERE idempotency_key = '018f1f4e-7f0a-7000-8000-000000000501'",
          )
          .get() as { record_state: string }
      ).record_state,
      "completed",
    );
    assert.equal(
      (
        database
          .prepare("SELECT dispatch_state FROM run_dispatches WHERE run_attempt_id = 'repair-terminal-attempt'")
          .get() as { dispatch_state: string }
      ).dispatch_state,
      "pending",
    );
  });
});

repositoryTest("startup repair releases a legacy canceled Run's unresolved Binding for the next admission", () => {
  withDatabase((database) => {
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
    const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
    const repair = operationFor(database, REPOSITORY_WRITE_OPERATIONS.startupRepair, () => 400);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000511", "session-1")) as CommandResult).ok,
      true,
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000512", "run-1", "create")) as CommandResult).ok,
      true,
    );
    database.exec(`
      UPDATE run_attempts SET attempt_state = 'interrupted', failure_origin = 'application', terminal_at = 300
      WHERE id = 'attempt-run-1';
      UPDATE runs SET phase = 'canceled', terminal_at = 300, updated_at = 300, version = version + 1
      WHERE id = 'run-1';
    `);

    const repaired = repair({}) as CommandResult;
    assert.equal(repaired.ok && (repaired.value.repaired as Readonly<Record<string, unknown>>).invalidatedBindings, 1);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT binding_state, invalidated_at, invalidation_reason FROM provider_bindings WHERE id = 'binding-run-1'",
          )
          .get(),
      },
      {
        binding_state: "invalidated",
        invalidated_at: 400,
        invalidation_reason: "conversation_start_ambiguous",
      },
    );
    assert.equal(
      (
        database.prepare("SELECT external_side_effect_state FROM runs WHERE id = 'run-1'").get() as {
          external_side_effect_state: string;
        }
      ).external_side_effect_state,
      "unknown",
    );
    assert.equal(
      (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000513", "run-2", "create")) as CommandResult).ok,
      true,
    );
  });
});

repositoryTest("Session subtree delete removes local child data and preserves parent tombstones", () => {
  withDatabase((database) => {
    const childStart = prepareDeletableChild(database);
    const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 850);
    assert.equal(
      (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000331", "unrelated-session")) as CommandResult).ok,
      true,
    );
    const remove = operationFor(database, "repository.session.delete-subtree", () => 900);
    const command = {
      deletionId: "018f1f4e-7f0a-7000-8000-000000000401",
      sessionId: "child-session-delete",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
    };
    const result = remove(command) as CommandResult;

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, {
      cleanupToken: command.deletionId,
      deletedSessionCount: 1,
      localOnly: true,
    });
    const replay = remove(command) as CommandResult;
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(replay.ok && replay.value, result.ok && result.value);
    assert.equal(database.prepare("SELECT 1 FROM sessions WHERE id = 'session-1'").get() !== undefined, true);
    assert.equal(database.prepare("SELECT 1 FROM sessions WHERE id = 'unrelated-session'").get() !== undefined, true);
    assert.equal(database.prepare("SELECT 1 FROM sessions WHERE id = 'child-session-delete'").get(), undefined);
    assert.equal(count(database, "session_relations"), 0);
    assert.equal(count(database, "delegations"), 0);
    assert.equal(count(database, "child_result_deliveries"), 0);
    assert.equal(
      database.prepare("SELECT 1 FROM run_events WHERE id = 'event-delete-child-collected'").get(),
      undefined,
    );
    const tombstone = database
      .prepare(
        `
        SELECT record_state, response_kind, response_ref_type, response_ref_id, response_envelope_json
        FROM idempotency_records WHERE idempotency_key = ?
      `,
      )
      .get(childStart.idempotencyKey) as Record<string, unknown>;
    assert.deepEqual(
      { ...tombstone },
      {
        record_state: "expired",
        response_kind: null,
        response_ref_type: null,
        response_ref_id: null,
        response_envelope_json: null,
      },
    );
    const childReplay = operationFor(database, "repository.child.start", () => 901)(childStart) as CommandResult;
    assert.equal(!childReplay.ok && childReplay.error.code, "idempotency_expired");
    const cleanup = operationFor(
      database,
      REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete,
      () => 902,
    )({ cleanupToken: command.deletionId, workspaceKey: TEST_WORKSPACE.workspaceKey }) as CommandResult;
    assert.equal(cleanup.ok && cleanup.replayed, false);
    assert.deepEqual(cleanup.ok && cleanup.value, {
      cleanupToken: command.deletionId,
      cleanupCompleted: true,
    });
    assert.equal(count(database, "session_deletion_manifests"), 0);
    assert.equal(count(database, "session_deletion_items"), 0);
    assert.deepEqual(
      {
        ...(database
          .prepare(
            `
            SELECT workspace_key, deleted_session_count, completed_at
            FROM session_deletion_completion_tombstones WHERE deletion_id = ?
          `,
          )
          .get(command.deletionId) as Record<string, unknown>),
      },
      { workspace_key: TEST_WORKSPACE.workspaceKey, deleted_session_count: 1, completed_at: 902 },
    );
    assert.equal(
      database
        .prepare("PRAGMA table_info(session_deletion_completion_tombstones)")
        .all()
        .some((column) => (column as { name: string }).name.includes("session_id")),
      false,
    );

    const cleanupReplay = operationFor(
      database,
      REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete,
      () => 903,
    )({ cleanupToken: command.deletionId, workspaceKey: TEST_WORKSPACE.workspaceKey }) as CommandResult;
    assert.equal(cleanupReplay.ok && cleanupReplay.replayed, true);
    assert.deepEqual(cleanupReplay.ok && cleanupReplay.value, cleanup.ok && cleanup.value);

    const deleteReplayAfterCleanup = remove(command) as CommandResult;
    assert.equal(deleteReplayAfterCleanup.ok && deleteReplayAfterCleanup.replayed, true);
    assert.deepEqual(deleteReplayAfterCleanup.ok && deleteReplayAfterCleanup.value, result.ok && result.value);
    const deleteConflict = remove({ ...command, sessionId: "session-1" }) as CommandResult;
    assert.equal(!deleteConflict.ok && deleteConflict.error.code, "idempotency_conflict");
    const wrongWorkspace = operationFor(
      database,
      REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete,
      () => 904,
    )({ cleanupToken: command.deletionId, workspaceKey: "other-workspace" }) as CommandResult;
    assert.equal(!wrongWorkspace.ok && wrongWorkspace.error.code, "not_found");
  });
});

repositoryTest("Session deletion cleanup completion rolls back its tombstone when manifest deletion fails", () => {
  withDatabase((database) => {
    prepareDeletableChild(database);
    const command = {
      deletionId: "018f1f4e-7f0a-7000-8000-000000000407",
      sessionId: "child-session-delete",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
    };
    const remove = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionDeleteSubtree, () => 900);
    assert.equal((remove(command) as CommandResult).ok, true);
    database.exec(`
      CREATE TRIGGER fail_cleanup_manifest_delete BEFORE DELETE ON session_deletion_manifests
      BEGIN SELECT RAISE(ABORT, 'cleanup completion fault injection'); END;
    `);

    const complete = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete, () => 901);
    assert.throws(
      () => complete({ cleanupToken: command.deletionId, workspaceKey: command.workspaceKey }),
      /cleanup completion fault injection/u,
    );
    assert.equal(count(database, "session_deletion_manifests"), 1);
    assert.equal(count(database, "session_deletion_items"), 1);
    assert.equal(count(database, "session_deletion_completion_tombstones"), 0);
  });
});

repositoryTest("Session subtree delete rejects busy trees and rolls back late failures", () => {
  withDatabase((database) => {
    activatePersistentRun(database);
    const remove = operationFor(database, "repository.session.delete-subtree", () => 600);
    const result = remove({
      deletionId: "018f1f4e-7f0a-7000-8000-000000000402",
      sessionId: "session-1",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "session_busy");
    assert.equal(count(database, "sessions"), 1);
    assert.equal(count(database, "runs"), 1);
  });

  withDatabase((database) => {
    const childStart = prepareDeletableChild(database);
    database.exec(`
      CREATE TRIGGER fail_subtree_session_delete BEFORE DELETE ON sessions
      BEGIN SELECT RAISE(ABORT, 'subtree delete fault injection'); END;
    `);
    const remove = operationFor(database, "repository.session.delete-subtree", () => 900);
    assert.throws(
      () =>
        remove({
          deletionId: "018f1f4e-7f0a-7000-8000-000000000403",
          sessionId: "child-session-delete",
          workspaceKey: TEST_WORKSPACE.workspaceKey,
        }),
      /subtree delete fault injection/u,
    );
    assert.equal(
      database.prepare("SELECT 1 FROM sessions WHERE id = 'child-session-delete'").get() !== undefined,
      true,
    );
    assert.equal(
      database.prepare("SELECT 1 FROM run_events WHERE id = 'event-delete-child-collected'").get() !== undefined,
      true,
    );
    const idempotency = database
      .prepare("SELECT record_state FROM idempotency_records WHERE idempotency_key = ?")
      .get(childStart.idempotencyKey) as { record_state: string };
    assert.equal(idempotency.record_state, "completed");
  });
});

repositoryTest("Session subtree delete recursively removes an intermediate branch only", () => {
  withDatabase((database) => {
    insertTerminalSessionTree(database);
    const remove = operationFor(database, "repository.session.delete-subtree", () => 900);
    const result = remove({
      deletionId: "018f1f4e-7f0a-7000-8000-000000000404",
      sessionId: "tree-middle",
      workspaceKey: "workspace",
    }) as CommandResult;
    assert.deepEqual(result.ok && result.value, {
      cleanupToken: "018f1f4e-7f0a-7000-8000-000000000404",
      deletedSessionCount: 2,
      localOnly: true,
    });
    assert.deepEqual(
      database
        .prepare("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id),
      ["tree-root", "unrelated-tree-session"],
    );
    assert.equal(count(database, "session_relations"), 0);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  });
});

repositoryTest("Session subtree delete rejects relations that cross a workspace boundary", () => {
  withDatabase((database) => {
    database.exec(`
      INSERT INTO sessions VALUES
        ('workspace-a-root', 'provider', 'workspace-a', '/workspace-a', '[]', 'character', 4, 'closed', 1, 3, 3),
        ('workspace-b-child', 'provider', 'workspace-b', '/workspace-b', '[]', 'character', 4, 'closed', 1, 3, 3);
      INSERT INTO messages VALUES ('workspace-a-message', 'workspace-a-root', 1, 'user', '[]', 1);
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, terminal_at, updated_at, version
      ) VALUES ('workspace-a-run', 'workspace-a-root', 1, 'workspace-a-message', 'completed', '{}',
        'none', 1, 2, 2, 0);
      INSERT INTO session_relations VALUES (
        'cross-workspace-relation', 'workspace-a-root', 'workspace-b-child', 'workspace-a-root',
        'workspace-a-run', 'cross-workspace-correlation', NULL, NULL, 2
      );
    `);
    const remove = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionDeleteSubtree, () => 900);
    const result = remove({
      deletionId: "018f1f4e-7f0a-7000-8000-000000000405",
      sessionId: "workspace-a-root",
      workspaceKey: "workspace-a",
    }) as CommandResult;
    assert.equal(!result.ok && result.error.code, "reference_invalid");
    assert.equal(count(database, "sessions"), 2);
    assert.equal(count(database, "session_relations"), 1);
    assert.equal(count(database, "session_deletion_manifests"), 0);
  });
});

repositoryTest("Session subtree delete returns a bounded cleanup token for large ID manifests", () => {
  withDatabase((database) => {
    database.exec(`
      INSERT INTO sessions VALUES
        ('large-delete-root', 'provider', 'workspace', '/workspace', '[]', 'character', 300, 'closed', 1, 3, 3);
      INSERT INTO messages VALUES ('large-delete-message', 'large-delete-root', 1, 'user', '[]', 1);
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, terminal_at, updated_at, version
      ) VALUES ('large-delete-run', 'large-delete-root', 1, 'large-delete-message', 'completed', '{}',
        'none', 1, 2, 2, 0);
    `);
    const insertSession = database.prepare(
      "INSERT INTO sessions VALUES (?, 'provider', 'workspace', '/workspace', '[]', 'character', 0, 'closed', 1, 3, 3)",
    );
    const insertRelation = database.prepare(
      `
      INSERT INTO session_relations VALUES (?, 'large-delete-root', ?, 'large-delete-root',
        'large-delete-run', ?, NULL, NULL, 2)
    `,
    );
    for (let index = 0; index < 256; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      const sessionId = `large-delete-${suffix}-${"x".repeat(1_007)}`;
      insertSession.run(sessionId);
      insertRelation.run(`large-delete-relation-${suffix}`, sessionId, `large-delete-correlation-${suffix}`);
    }
    const remove = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionDeleteSubtree, () => 900);
    const result = remove({
      deletionId: "018f1f4e-7f0a-7000-8000-000000000406",
      sessionId: "large-delete-root",
      workspaceKey: "workspace",
    }) as CommandResult;
    assert.deepEqual(result.ok && result.value, {
      cleanupToken: "018f1f4e-7f0a-7000-8000-000000000406",
      deletedSessionCount: 257,
      localOnly: true,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_024);
    assert.equal(count(database, "session_deletion_items"), 257);
    assert.equal(count(database, "sessions"), 0);
  });
});

repositoryTest("Worker registry accepts Session commands only as write requests", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(fs.readFileSync(new URL("../schema/sqlite/v1.sql", import.meta.url), "utf8"));
  const messages: WorkerToMainMessage[] = [];
  const generationId = "018f1f4e-7f0a-7000-8000-000000000201";
  const runtime = new PersistenceWorkerRuntime(generationId, database, ":memory:", (message) => messages.push(message));
  const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000202", "session-runtime");
  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000203",
    requestSequence: 1,
    operation: REPOSITORY_WRITE_OPERATIONS.sessionCreate,
    requestClass: "write",
    payload: command,
  });
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0]?.kind === "response" && messages[0].ok, true);

  runtime.handleMessage({
    protocolVersion: PERSISTENCE_PROTOCOL_VERSION,
    generationId,
    kind: "request",
    requestId: "018f1f4e-7f0a-7000-8000-000000000204",
    requestSequence: 2,
    operation: REPOSITORY_WRITE_OPERATIONS.sessionCreate,
    requestClass: "read",
    payload: command,
  });
  await waitFor(() => messages.length === 2);
  assert.equal(
    messages[1]?.kind === "response" && !messages[1].ok && messages[1].error.code,
    "operation_not_supported",
  );
  database.close();
});

function operationFor(
  database: DatabaseSync,
  name: string,
  clock: () => number,
  idempotencyRetentionMs = 30 * 24 * 60 * 60 * 1_000,
  capacity: Readonly<{ maxConcurrentRuns: number; maxConcurrentRunsPerProvider: number }> = {
    maxConcurrentRuns: 4,
    maxConcurrentRunsPerProvider: 4,
  },
) {
  const operation = createRepositoryWriteOperations(database, { clock, idempotencyRetentionMs, ...capacity }).get(name);
  assert.ok(operation);
  return (payload: Readonly<Record<string, unknown>>) => operation.execute(payload).result;
}

function sessionCreateCommand(idempotencyKey: string, sessionId: string) {
  return {
    idempotencyKey,
    session: {
      id: sessionId,
      providerId: "provider",
      workspaceKey: TEST_WORKSPACE.workspaceKey,
      workspacePath: TEST_WORKSPACE.workspacePath,
      allowedAdditionalDirectories: ["C:/workspace/shared"],
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 4,
    },
  };
}

function normalRunAdmissionCommand(idempotencyKey: string, runId: string, binding: "create" | "reuse") {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    idempotencyKey,
    message: { id: `message-${runId}`, contentBlocks: [{ type: "text", text: "hello" }] },
    run: {
      id: runId,
      executionSnapshot: {
        providerId: "provider",
        model: "test-model",
        reasoning: { effort: "medium" },
        approval: { mode: "on-request" },
        sandbox: { mode: "workspace-write" },
        workspace: { key: TEST_WORKSPACE.workspaceKey },
        character: null,
      },
    },
    attemptId: `attempt-${runId}`,
    bindingIntent:
      binding === "create"
        ? ({ kind: "create", bindingId: `binding-${runId}`, persistenceMode: "persistent" } as const)
        : ({ kind: "reuse", bindingId: "binding-run-1" } as const),
    dispatch: {
      providerRequest: { options: { a: true, z: 1 }, prompt: "hello" },
      providerIdempotencyKey: null,
    },
  };
}

function retryRunAdmissionCommand(
  idempotencyKey: string,
  runId: string,
  retryOfRunId: string,
  binding: "create" | "reuse",
) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    idempotencyKey,
    retryOfRunId,
    run: {
      id: runId,
      executionSnapshot: {
        providerId: "provider",
        model: "test-model",
        reasoning: { effort: "medium" },
        approval: { mode: "on-request" },
        sandbox: { mode: "workspace-write" },
        workspace: { key: TEST_WORKSPACE.workspaceKey },
        character: null,
      },
    },
    attemptId: `attempt-${runId}`,
    bindingIntent:
      binding === "create"
        ? ({ kind: "create", bindingId: `binding-${runId}`, persistenceMode: "persistent" } as const)
        : ({ kind: "reuse", bindingId: "binding-run-1" } as const),
    dispatch: {
      providerRequest: { options: { a: true, z: 1 }, prompt: "hello" },
      providerIdempotencyKey: null,
    },
  };
}

function childStartCommand(
  idempotencyKey: string,
  suffix: string,
  parentSessionId = "session-1",
  parentRunId = "run-1",
) {
  return {
    parentSessionId,
    parentRunId,
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    idempotencyKey,
    childSession: {
      id: `child-session-${suffix}`,
      providerId: "provider",
      allowedAdditionalDirectories: ["C:/workspace/shared"],
      defaultCharacterId: "child-character",
      maxConcurrentChildRuns: 4,
    },
    relation: {
      id: `relation-${suffix}`,
      correlationId: `correlation-${suffix}`,
      label: "research",
      purposeSummary: "Investigate the requested topic.",
    },
    delegation: {
      id: `delegation-${suffix}`,
      mentionText: "@Child",
    },
    message: {
      id: `child-message-${suffix}`,
      contentBlocks: [{ type: "text", text: "Investigate the requested topic." }],
    },
    run: {
      id: `child-run-${suffix}`,
      executionSnapshot: {
        providerId: "provider",
        model: "test-model",
        reasoning: { effort: "medium" },
        approval: { mode: "on-request" },
        sandbox: { mode: "workspace-write" },
        workspace: { key: TEST_WORKSPACE.workspaceKey },
        character: { id: "child-character" },
      },
    },
    attemptId: `child-attempt-${suffix}`,
    binding: {
      id: `child-binding-${suffix}`,
      persistenceMode: "persistent" as const,
    },
    dispatch: {
      providerRequest: { prompt: "Investigate the requested topic." },
      providerIdempotencyKey: null,
    },
    deliveryId: `delivery-${suffix}`,
  };
}

function prepareDeletableChild(database: DatabaseSync) {
  activatePersistentRun(database);
  const startChild = operationFor(database, "repository.child.start", () => 600);
  const childStart = childStartCommand("018f1f4e-7f0a-7000-8000-000000000330", "delete");
  assert.equal((startChild(childStart) as CommandResult).ok, true);
  database
    .prepare(
      `
      UPDATE provider_bindings
      SET binding_state = 'active', external_conversation_id = 'child-conversation-delete'
      WHERE id = 'child-binding-delete'
    `,
    )
    .run();
  database
    .prepare(
      `
      UPDATE run_attempts
      SET provider_binding_id = 'child-binding-delete', attempt_state = 'active',
        external_execution_id = 'child-execution-delete', started_at = 601
      WHERE id = 'child-attempt-delete'
    `,
    )
    .run();
  database
    .prepare(
      `
      UPDATE run_dispatches
      SET dispatch_state = 'accepted', dispatching_at = 601, resolved_at = 601
      WHERE run_attempt_id = 'child-attempt-delete'
    `,
    )
    .run();
  database
    .prepare(
      `
      UPDATE runs
      SET phase = 'active', started_at = 601, external_side_effect_state = 'present', updated_at = 601
      WHERE id = 'child-run-delete'
    `,
    )
    .run();
  const terminal = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runTerminal, () => 700);
  assert.equal(
    (
      terminal({
        sessionId: "child-session-delete",
        workspaceKey: TEST_WORKSPACE.workspaceKey,
        runId: "child-run-delete",
        attemptId: "child-attempt-delete",
        terminalEvent: { id: "event-delete-child-terminal", dedupeKey: "dedupe-delete-child-terminal" },
        preDispatchResolution: { kind: "not_applicable" },
        outcome: {
          kind: "completed",
          finalAssistantMessage: {
            id: "message-delete-child-final",
            contentBlocks: [{ type: "text", text: "child done" }],
          },
        },
        outputs: [],
        childResult: { workflowState: "closed", resultSummary: "child done" },
      }) as CommandResult
    ).ok,
    true,
  );
  const collect = operationFor(database, REPOSITORY_WRITE_OPERATIONS.childResultCollect, () => 800);
  assert.equal(
    (
      collect({
        parentSessionId: "session-1",
        childSessionId: "child-session-delete",
        workspaceKey: TEST_WORKSPACE.workspaceKey,
        idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000332",
        deliveryId: "delivery-delete",
        collectingParentRunId: "run-1",
        eventId: "event-delete-child-collected",
      }) as CommandResult
    ).ok,
    true,
  );
  return childStart;
}

function insertTerminalSessionTree(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO sessions VALUES
      ('tree-root', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'closed', 1, 4, 4),
      ('tree-middle', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'closed', 1, 4, 4),
      ('tree-leaf', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'closed', 1, 4, 4),
      ('unrelated-tree-session', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'closed', 1, 4, 4);
    INSERT INTO messages VALUES
      ('tree-root-message', 'tree-root', 1, 'user', '[]', 1),
      ('tree-middle-message', 'tree-middle', 1, 'user', '[]', 1),
      ('tree-leaf-message', 'tree-leaf', 1, 'user', '[]', 1);
    INSERT INTO runs (
      id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
      external_side_effect_state, created_at, terminal_at, updated_at, version
    ) VALUES
      ('tree-root-run', 'tree-root', 1, 'tree-root-message', 'completed', '{}', 'none', 1, 3, 3, 0),
      ('tree-middle-run', 'tree-middle', 1, 'tree-middle-message', 'completed', '{}', 'none', 1, 3, 3, 0),
      ('tree-leaf-run', 'tree-leaf', 1, 'tree-leaf-message', 'completed', '{}', 'none', 1, 3, 3, 0);
    INSERT INTO session_relations VALUES
      ('tree-root-middle-relation', 'tree-root', 'tree-middle', 'tree-root', 'tree-root-run',
        'tree-root-middle-correlation', NULL, NULL, 2),
      ('tree-middle-leaf-relation', 'tree-middle', 'tree-leaf', 'tree-root', 'tree-middle-run',
        'tree-middle-leaf-correlation', NULL, NULL, 2);
    COMMIT;
  `);
}

function makeRunRetryable(
  database: DatabaseSync,
  runId: string,
  attemptId: string,
  bindingId: string,
  terminalAt: number,
): void {
  database
    .prepare(
      `
      UPDATE provider_bindings SET binding_state = 'active', external_conversation_id = ?
      WHERE id = ?
    `,
    )
    .run(`external-${runId}`, bindingId);
  database
    .prepare(
      `
      UPDATE run_attempts SET provider_binding_id = ?, attempt_state = 'failed',
        failure_origin = 'provider', terminal_at = ? WHERE id = ?
    `,
    )
    .run(bindingId, terminalAt, attemptId);
  database
    .prepare(
      `
      UPDATE runs SET phase = 'failed', failure_origin = 'provider', terminal_at = ?,
        updated_at = ?, version = version + 1 WHERE id = ?
    `,
    )
    .run(terminalAt, terminalAt, runId);
}

function bindingResolutionCommand(_kind: "active") {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    bindingId: "binding-run-1",
    resolution: { kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: null } as const,
  };
}

function ambiguousBindingResolutionPayload(
  scope: Readonly<{
    sessionId: string;
    runId: string;
    attemptId: string;
    bindingId: string;
  }> = {
    sessionId: "session-1",
    runId: "run-1",
    attemptId: "attempt-run-1",
    bindingId: "binding-run-1",
  },
) {
  return {
    ...scope,
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    resolution: {
      kind: "ambiguous",
      failureOrigin: "transport",
      errorSummary: "Conversation creation outcome is unknown.",
    },
  };
}

function dispatchBeginCommand(ephemeralOwnerToken: string | null = null) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    bindingId: "binding-run-1",
    providerRequest: { options: { a: true, z: 1 }, prompt: "hello" },
    ephemeralOwnerToken,
  };
}

function dispatchResolutionCommand(
  kind: "accepted" | "rejected" | "ambiguous",
  ephemeralOwnerToken: string | null = null,
) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    bindingId: "binding-run-1",
    ephemeralOwnerToken,
    outcome:
      kind === "accepted" ? ({ kind: "accepted", externalExecutionId: "execution-1" } as const) : ({ kind } as const),
  };
}

function runInputAdmissionCommand(idempotencyKey: string, ephemeralOwnerToken: string | null = null) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    idempotencyKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    ephemeralOwnerToken,
    message: { id: "message-input-1", contentBlocks: [{ type: "text", text: "more" }] },
  };
}

function runInputBeginCommand(ephemeralOwnerToken: string | null = null) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    messageId: "message-input-1",
    bindingId: "binding-run-1",
    ephemeralOwnerToken,
  };
}

function runInputResolutionCommand(
  kind: "accepted" | "rejected" | "ambiguous",
  ephemeralOwnerToken: string | null = null,
) {
  return {
    ...runInputBeginCommand(ephemeralOwnerToken),
    outcome:
      kind === "accepted"
        ? ({ kind } as const)
        : ({
            kind,
            resolutionCode: kind === "rejected" ? "provider_rejected" : "transport_unknown",
          } as const),
  };
}

function runOutputAppendCommand(outputId: string, providerItemId: string | null, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    item: {
      id: outputId,
      category: "operation",
      kind: "command",
      providerItemId,
      summary: "command output",
      completionState: "complete",
      payload: {
        state: "stored",
        originalByteLength: bytes.byteLength,
        redactionState: "not_required",
        payloadFormat: "text",
        mediaType: "text/plain",
        content: bytes,
      },
    },
  };
}

function runTerminalCommand() {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    terminalEvent: { id: "terminal-event-1", dedupeKey: "provider-terminal-1" },
    preDispatchResolution: { kind: "not_applicable" },
    outcome: {
      kind: "completed",
      finalAssistantMessage: {
        id: "message-final-1",
        contentBlocks: [{ type: "text", text: "done" }],
      },
    },
    outputs: [
      {
        id: "output-pending-1",
        category: "diagnostic",
        kind: "trace",
        providerItemId: "provider-pending-1",
        summary: "detail pending",
        completionState: "complete",
        payload: {
          state: "pending",
          originalByteLength: 5,
          redactionState: "not_required",
        },
      },
    ],
    childResult: null,
  };
}

function preparingRunTerminalCommand(
  resolutionKind: "not_applicable" | "binding_creation_not_sent" | "binding_creation_ambiguous" | "dispatch_not_sent",
  outcomeKind: "canceled" | "interrupted",
) {
  return {
    sessionId: "session-1",
    workspaceKey: TEST_WORKSPACE.workspaceKey,
    runId: "run-1",
    attemptId: "attempt-run-1",
    terminalEvent: { id: "terminal-event-pre-dispatch", dedupeKey: "provider-terminal-pre-dispatch" },
    preDispatchResolution: { kind: resolutionKind },
    outcome:
      outcomeKind === "canceled"
        ? ({ kind: "canceled" } as const)
        : ({
            kind: "interrupted",
            failureOrigin: "transport",
            providerErrorCode: null,
            errorSummary: "Conversation creation outcome is unknown.",
          } as const),
    outputs: [],
    childResult: null,
  };
}

function childTerminalCommand() {
  return {
    sessionId: "child-session",
    workspaceKey: "workspace",
    runId: "child-run",
    attemptId: "child-attempt",
    terminalEvent: { id: "child-terminal-event", dedupeKey: "child-provider-terminal" },
    preDispatchResolution: { kind: "not_applicable" },
    outcome: {
      kind: "completed",
      finalAssistantMessage: {
        id: "child-final-message",
        contentBlocks: [{ type: "text", text: "child done" }],
      },
    },
    outputs: [],
    childResult: { workflowState: "closed", resultSummary: "child done" },
  };
}

function childCollectCommand(idempotencyKey: string, eventId: string) {
  return {
    parentSessionId: "parent-session",
    childSessionId: "child-session",
    workspaceKey: "workspace",
    idempotencyKey,
    deliveryId: "delivery-child-1",
    collectingParentRunId: "parent-run",
    eventId,
  };
}

function insertChildScenario(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO sessions VALUES
      ('parent-session', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 1, 1),
      ('child-session', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 1, 1);
    INSERT INTO messages VALUES
      ('parent-message', 'parent-session', 1, 'user', '[]', 1),
      ('child-message', 'child-session', 1, 'user', '[]', 1);
    INSERT INTO runs (
      id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
      external_side_effect_state, created_at, started_at, updated_at, version
    ) VALUES
      ('parent-run', 'parent-session', 1, 'parent-message', 'active', '{}', 'present', 1, 2, 2, 0),
      ('child-run', 'child-session', 1, 'child-message', 'active', '{}', 'present', 1, 2, 2, 0);
    INSERT INTO provider_bindings (
      id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
      binding_state, created_by_run_attempt_id, created_at
    ) VALUES ('child-binding', 'child-session', 1, 'provider', 'child-conversation', 'persistent',
      'active', 'child-attempt', 1);
    INSERT INTO run_attempts (
      id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state,
      external_execution_id, created_at, started_at
    ) VALUES ('child-attempt', 'child-run', 1, 'child-binding', 'initial', 'active', 'child-execution', 1, 2);
    INSERT INTO run_dispatches VALUES ('child-attempt', 'accepted',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, 1, 2, 2);
    INSERT INTO session_relations VALUES (
      'relation-child-1', 'parent-session', 'child-session', 'parent-session', 'parent-run',
      'correlation-child-1', NULL, NULL, 1
    );
    INSERT INTO delegations VALUES (
      'delegation-child-1', 'relation-child-1', 'child-message', 'child-message', 'child-run',
      NULL, 'active', NULL, 1, 1, 0
    );
    INSERT INTO child_result_deliveries VALUES (
      'delivery-child-1', 'delegation-child-1', 1, 'child-run', 'pending',
      NULL, NULL, NULL, NULL, NULL, 1, 1, 0
    );
    COMMIT;
  `);
}

function insertQuotaHistoryRun(database: DatabaseSync, sessionId: string, runId: string, messageId: string): void {
  const ordinal = (
    database
      .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM messages WHERE session_id = ?")
      .get(sessionId) as {
      value: number;
    }
  ).value;
  database
    .prepare(
      "INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at) VALUES (?, ?, ?, 'user', '[]', 1)",
    )
    .run(messageId, sessionId, ordinal);
  database
    .prepare(
      `
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, terminal_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'completed', '{}', 'none', 1, 2, 2, 0)
    `,
    )
    .run(runId, sessionId, ordinal, messageId);
}

function insertStoredQuotaFixture(database: DatabaseSync, runId: string, outputId: string, content: string): void {
  const bytes = Buffer.from(content, "utf8");
  database
    .prepare(
      `
      INSERT INTO run_output_items (
        id, run_id, ordinal, category, kind, provider_item_id, summary, completion_state,
        payload_state, payload_original_byte_length, stored_payload_id, redaction_state, created_at
      ) VALUES (?, ?, 1, 'operation', 'fixture', NULL, 'fixture', 'complete', 'pending', ?, NULL, 'not_required', 1)
    `,
    )
    .run(outputId, runId, bytes.byteLength);
  database
    .prepare(
      `
      INSERT INTO run_output_payloads (
        output_item_id, payload_format, media_type, content, byte_length, content_sha256, created_at
      ) VALUES (?, 'text', 'text/plain', ?, ?, ?, 1)
    `,
    )
    .run(outputId, bytes, bytes.byteLength, createHash("sha256").update(bytes).digest("hex"));
  database
    .prepare("UPDATE run_output_items SET payload_state = 'stored', stored_payload_id = ? WHERE id = ?")
    .run(outputId, outputId);
}

function insertStartupRepairFixture(database: DatabaseSync): void {
  const fingerprint = "a".repeat(64);
  database.exec(`
    BEGIN;
    INSERT INTO sessions VALUES
      ('repair-parent', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 20, 20),
      ('repair-child', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 20, 20),
      ('repair-safe', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 2, 2),
      ('repair-creating', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 2, 2),
      ('repair-dispatching', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 2, 2),
      ('repair-ephemeral', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 2, 2),
      ('repair-diagnostic', 'provider', 'workspace', '/workspace', '[]', 'character', 4, 'active', 1, 2, 2);
    INSERT INTO messages VALUES
      ('repair-parent-message', 'repair-parent', 1, 'user', '[]', 1),
      ('repair-collision-delivery', 'repair-parent', 2, 'user', '[]', 2),
      ('repair-child-message', 'repair-child', 1, 'user', '[]', 1),
      ('repair-child-message-2', 'repair-child', 2, 'user', '[]', 2),
      ('repair-dispatching-delivery', 'repair-child', 3, 'user', '[]', 3),
      ('repair-safe-message', 'repair-safe', 1, 'user', '[]', 1),
      ('repair-creating-message', 'repair-creating', 1, 'user', '[]', 1),
      ('repair-dispatching-message', 'repair-dispatching', 1, 'user', '[]', 1),
      ('repair-ephemeral-message', 'repair-ephemeral', 1, 'user', '[]', 1),
      ('repair-diagnostic-message', 'repair-diagnostic', 1, 'user', '[]', 1);
    INSERT INTO runs (
      id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
      external_side_effect_state, created_at, terminal_at, updated_at, version
    ) VALUES
      ('repair-parent-run', 'repair-parent', 1, 'repair-parent-message', 'completed', '{}', 'none', 1, 20, 20, 0),
      ('repair-child-run', 'repair-child', 1, 'repair-child-message', 'completed', '{}', 'present', 1, 20, 20, 0),
      ('repair-child-run-2', 'repair-child', 2, 'repair-child-message-2', 'completed', '{}', 'present', 2, 21, 21, 0),
      ('repair-safe-run', 'repair-safe', 1, 'repair-safe-message', 'queued', '{}', 'none', 1, NULL, 2, 0),
      ('repair-creating-run', 'repair-creating', 1, 'repair-creating-message', 'queued', '{}', 'unknown', 1, NULL, 2, 0),
      ('repair-dispatching-run', 'repair-dispatching', 1, 'repair-dispatching-message', 'starting', '{}', 'unknown', 1, NULL, 2, 0),
      ('repair-ephemeral-run', 'repair-ephemeral', 1, 'repair-ephemeral-message', 'queued', '{}', 'none', 1, NULL, 2, 0),
      ('repair-diagnostic-run', 'repair-diagnostic', 1, 'repair-diagnostic-message', 'queued', '{}', 'none', 1, NULL, 2, 0);
    INSERT INTO provider_bindings (
      id, session_id, ordinal, provider_id, external_conversation_id, persistence_mode,
      binding_state, created_by_run_attempt_id, invalidated_at, invalidation_reason, created_at
    ) VALUES
      ('repair-terminal-binding', 'repair-child', 1, 'provider', NULL, 'persistent',
        'creating', 'repair-terminal-attempt', NULL, NULL, 1),
      ('repair-safe-binding', 'repair-safe', 1, 'provider', 'repair-safe-conversation', 'persistent',
        'active', 'repair-safe-attempt', NULL, NULL, 1),
      ('repair-creating-binding', 'repair-creating', 1, 'provider', NULL, 'persistent',
        'creating', 'repair-creating-attempt', NULL, NULL, 1),
      ('repair-dispatching-binding', 'repair-dispatching', 1, 'provider', 'repair-dispatching-conversation', 'persistent',
        'active', 'repair-dispatching-attempt', NULL, NULL, 1),
      ('repair-ephemeral-binding', 'repair-ephemeral', 1, 'provider', 'repair-ephemeral-conversation', 'ephemeral',
        'active', 'repair-ephemeral-attempt', NULL, NULL, 1);
    INSERT INTO run_attempts (
      id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state,
      external_execution_id, failure_origin, created_at, terminal_at
    ) VALUES
      ('repair-terminal-attempt', 'repair-child-run', 1, NULL, 'initial',
        'failed', NULL, 'unknown', 1, 20),
      ('repair-parent-attempt', 'repair-parent-run', 1, NULL, 'initial',
        'failed', NULL, 'unknown', 1, 20),
      ('repair-safe-attempt', 'repair-safe-run', 1, 'repair-safe-binding', 'initial',
        'preparing', NULL, NULL, 1, NULL),
      ('repair-creating-attempt', 'repair-creating-run', 1, 'repair-creating-binding', 'initial',
        'preparing', NULL, NULL, 1, NULL),
      ('repair-dispatching-attempt', 'repair-dispatching-run', 1, 'repair-dispatching-binding', 'initial',
        'preparing', NULL, NULL, 1, NULL),
      ('repair-ephemeral-attempt', 'repair-ephemeral-run', 1, 'repair-ephemeral-binding', 'initial',
        'preparing', NULL, NULL, 1, NULL);
    INSERT INTO run_dispatches VALUES
      ('repair-terminal-attempt', 'pending', '${fingerprint}', NULL, 1, NULL, NULL),
      ('repair-safe-attempt', 'pending', '${fingerprint}', NULL, 1, NULL, NULL),
      ('repair-creating-attempt', 'pending', '${fingerprint}', NULL, 1, NULL, NULL),
      ('repair-dispatching-attempt', 'dispatching', '${fingerprint}', NULL, 1, 2, NULL),
      ('repair-ephemeral-attempt', 'pending', '${fingerprint}', NULL, 1, NULL, NULL);
    INSERT INTO run_output_items (
      id, run_id, ordinal, category, kind, provider_item_id, summary, completion_state,
      payload_state, payload_original_byte_length, stored_payload_id, redaction_state, created_at
    ) VALUES
      ('repair-output-stored', 'repair-child-run', 1, 'operation', 'fixture', NULL, 'stored', 'complete',
        'pending', 3, NULL, 'not_required', 1),
      ('repair-output-missing', 'repair-child-run', 2, 'operation', 'fixture', NULL, 'missing', 'complete',
        'pending', 3, NULL, 'not_required', 1);
    INSERT INTO run_output_payloads VALUES
      ('repair-output-stored', 'text', 'text/plain', X'616263', 3,
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 1);
    INSERT INTO session_relations VALUES
      ('repair-relation', 'repair-parent', 'repair-child', 'repair-parent', 'repair-parent-run',
        'repair-correlation', NULL, NULL, 1),
      ('repair-inconsistent-relation', 'repair-parent', 'repair-safe', 'repair-parent', 'repair-parent-run',
        'repair-inconsistent-correlation', NULL, NULL, 1);
    INSERT INTO delegations VALUES
      ('repair-delegation', 'repair-relation', 'repair-child-message', 'repair-child-message',
        'repair-child-run', NULL, 'closed', 'completed', 1, 20, 0),
      ('repair-inconsistent-delegation', 'repair-inconsistent-relation', 'repair-safe-message', 'repair-safe-message',
        'repair-safe-run', NULL, 'active', NULL, 1, 2, 0);
    INSERT INTO child_result_deliveries VALUES
      ('repair-delivery', 'repair-delegation', 1, 'repair-child-run', 'pending',
        NULL, NULL, NULL, NULL, NULL, 1, 1, 0),
      ('repair-inconsistent-delivery', 'repair-inconsistent-delegation', 1, 'repair-child-run-2', 'available',
        'failed', NULL, 2, NULL, NULL, 1, 1, 0);
    INSERT INTO run_input_deliveries VALUES
      ('repair-collision-delivery', 'repair-parent-run', 'repair-parent-attempt', 'pending', NULL, 2, NULL, NULL),
      ('repair-dispatching-delivery', 'repair-child-run', 'repair-terminal-attempt', 'dispatching', NULL, 2, 3, NULL);
    INSERT INTO idempotency_records VALUES
      ('018f1f4e-7f0a-7000-8000-000000000501', 'repair-child', 'run.admit', '${fingerprint}',
        'completed', 'success', 'run', 'repair-child-run', '{"runId":"repair-child-run"}', 1, 2, 50),
      ('018f1f4e-7f0a-7000-8000-000000000502', 'repair-safe', 'run.admit', '${fingerprint}',
        'completed', 'success', 'run', 'missing-run', '{"runId":"missing-run"}', 1, 2, 200),
      ('018f1f4e-7f0a-7000-8000-000000000503', 'repair-parent', 'repository.child.start', '${fingerprint}',
        'completed', 'success', 'delivery', 'repair-collision-delivery',
        '{"deliveryId":"repair-collision-delivery"}', 1, 2, 200);
    COMMIT;
  `);
}

function activatePersistentRun(database: DatabaseSync): void {
  const create = operationFor(database, REPOSITORY_WRITE_OPERATIONS.sessionCreate, () => 100);
  const admit = operationFor(database, REPOSITORY_WRITE_OPERATIONS.runAdmit, () => 200);
  const resolveBinding = operationFor(database, REPOSITORY_WRITE_OPERATIONS.bindingResolve, () => 300);
  const begin = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchBegin, () => 400);
  const resolveDispatch = operationFor(database, REPOSITORY_WRITE_OPERATIONS.dispatchResolve, () => 500);
  assert.equal(
    (create(sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000177", "session-1")) as CommandResult).ok,
    true,
  );
  assert.equal(
    (admit(normalRunAdmissionCommand("018f1f4e-7f0a-7000-8000-000000000178", "run-1", "create")) as CommandResult).ok,
    true,
  );
  assert.equal((resolveBinding(bindingResolutionCommand("active")) as CommandResult).ok, true);
  assert.equal((begin(dispatchBeginCommand()) as CommandResult).ok, true);
  assert.equal((resolveDispatch(dispatchResolutionCommand("accepted")) as CommandResult).ok, true);
}

function insertActiveRun(database: DatabaseSync, sessionId: string): void {
  database.prepare("INSERT INTO messages VALUES ('message-1', ?, 1, 'user', '[]', 1)").run(sessionId);
  database
    .prepare(
      `
    INSERT INTO runs (
      id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
      external_side_effect_state, created_at, updated_at, version
    ) VALUES ('run-1', ?, 1, 'message-1', 'queued', '{}', 'none', 1, 1, 0)
  `,
    )
    .run(sessionId);
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .reverse()
        .map(([key, nested]) => [key, reverseObjectKeyOrder(nested)]),
    );
  }
  return value;
}

function readLifecycle(database: DatabaseSync, sessionId: string): string {
  return (
    database.prepare("SELECT lifecycle_status FROM sessions WHERE id = ?").get(sessionId) as {
      lifecycle_status: string;
    }
  ).lifecycle_status;
}

function withDatabase(run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(fs.readFileSync(new URL("../schema/sqlite/v1.sql", import.meta.url), "utf8"));
    run(database);
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Worker response.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type CommandResult =
  | Readonly<{ ok: true; value: Readonly<Record<string, unknown>>; replayed: boolean }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; details?: unknown }>; replayed: false }>;
