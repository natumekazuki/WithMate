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
