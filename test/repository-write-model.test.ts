import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createRepositoryWriteOperations } from "../src/persistence-worker/repository-write-model.js";
import { PersistenceWorkerRuntime } from "../src/persistence-worker/worker-runtime.js";
import { PERSISTENCE_PROTOCOL_VERSION, type WorkerToMainMessage } from "../src/shared/persistence-protocol.js";
import { REPOSITORY_WRITE_OPERATIONS } from "../src/shared/repository-write-model.js";

const repositoryTest = Number.parseInt(process.versions.node, 10) >= 24 ? test : test.skip;

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

    const command = sessionCreateCommand("018f1f4e-7f0a-7000-8000-000000000103", "session-1");
    assert.equal((execute(command) as CommandResult).ok, true);
    const conflict = execute({ ...command, session: { ...command.session, workspaceKey: "other" } }) as CommandResult;
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
      workspaceKey: "workspace",
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
      workspaceKey: "workspace",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000106",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "archived",
    }) as CommandResult;
    assert.equal(archived.ok, true);
    const stale = transition({
      sessionId: "session-1",
      workspaceKey: "workspace",
      idempotencyKey: "018f1f4e-7f0a-7000-8000-000000000107",
      expectedLifecycleStatus: "active",
      targetLifecycleStatus: "closed",
    }) as CommandResult;
    assert.equal(!stale.ok && stale.error.code, "lifecycle_conflict");
    assert.equal(readLifecycle(database, "session-1"), "archived");
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
    const conflict = execute({ ...command, session: { ...command.session, workspaceKey: "other" } }) as CommandResult;
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
          workspaceKey: "workspace",
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
      workspaceKey: "workspace",
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
      workspaceKey: "workspace",
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
      workspaceKey: "workspace",
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
          workspaceKey: "workspace",
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

repositoryTest("ambiguous Binding creation atomically interrupts the Run and aborts its pending Dispatch", () => {
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
    const command = bindingResolutionCommand("ambiguous");
    const first = resolve(command) as CommandResult;
    const replay = resolve(command) as CommandResult;
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
    assert.ok(restartedAdmit && restartedBegin);
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
      workspaceKey: "workspace",
      allowedAdditionalDirectories: ["C:/workspace/shared"],
      defaultCharacterId: "character",
      maxConcurrentChildRuns: 4,
    },
  };
}

function normalRunAdmissionCommand(idempotencyKey: string, runId: string, binding: "create" | "reuse") {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace",
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
        workspace: { key: "workspace" },
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
    workspaceKey: "workspace",
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
        workspace: { key: "workspace" },
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

function bindingResolutionCommand(kind: "active" | "ambiguous") {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace",
    runId: "run-1",
    attemptId: "attempt-run-1",
    bindingId: "binding-run-1",
    resolution:
      kind === "active"
        ? ({ kind: "active", externalConversationId: "external-1", ephemeralOwnerToken: null } as const)
        : ({
            kind: "ambiguous",
            failureOrigin: "transport",
            errorSummary: "Conversation creation outcome is unknown.",
          } as const),
  };
}

function dispatchBeginCommand(ephemeralOwnerToken: string | null = null) {
  return {
    sessionId: "session-1",
    workspaceKey: "workspace",
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
    workspaceKey: "workspace",
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
    workspaceKey: "workspace",
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
    workspaceKey: "workspace",
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
  | Readonly<{ ok: false; error: Readonly<{ code: string }>; replayed: false }>;
