import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  type MutationAuthorityProof,
} from "../../src/session-authority.js";
import type { CharacterRuntimeSnapshot } from "../../src/character/character-catalog.js";
import { buildNewSession } from "../../src/session-state.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import { readSessionProjection } from "../../src-electron/resource-history-schema.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const CONFIGURED_AT = "2026-08-10T00:01:00.000Z";
const EXPIRES_AT = "2026-08-11T00:00:00.000Z";

function trustedProof(
  operation: MutationAuthorityProof["operation"],
  resourceKind: MutationAuthorityProof["resolvedScope"]["resourceKind"],
  sessionId = "session-lifecycle-binding",
): MutationAuthorityProof {
  return {
    principal: { kind: "system", service: "session-binding-lifecycle-integration-test" },
    operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: operation,
    resolvedScope: {
      resourceKind,
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: resourceKind === "execution" ? "external_side_effect" : "state_change",
    grantId: null,
    grantRevision: null,
    evaluatedAt: CREATED_AT,
  };
}

function buildSession() {
  const characterRuntimeSnapshot: CharacterRuntimeSnapshot = {
    characterId: "character-a",
    name: "Character A",
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    definitionMarkdown: "# Character A",
    definitionSha256: "character-a-sha256",
    definitionByteSize: 14,
    snapshotAt: CREATED_AT,
  };
  return buildNewSession({
    id: "session-lifecycle-binding",
    taskTitle: "Binding lifecycle",
    workspaceLabel: "workspace",
    workspacePath: "C:/workspace",
    branch: "main",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5",
    reasoningEffort: "high",
    characterId: "character-a",
    character: "Character A",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    characterRuntimeSnapshot,
    approvalMode: DEFAULT_APPROVAL_MODE,
  });
}

// @test-value v2
// kind = "invariant"
// claim = "enqueue時点のruntime bindingはconfigure後も旧executionに固定され、後続terminal executionだけが更新後tupleを保持する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Session identity と変更可能性" }
// fault = "executionのbindingを読み出すたびにSessionのcurrent tupleへ再解決し、configure後に旧turnのprovider・thread・character・workspaceを取り違える"
// observable = "SessionExecutionStorageV6のqueued/running/terminal execution binding snapshot"
// observation_boundary = "consumer"
// scope = "SessionStorageV6 and SessionExecutionStorageV6 binding lifecycle integration"
// lifecycle = "permanent"
// distinction = "同一DBでenqueue前のtuple、configure後のcurrent tuple、旧executionのterminal tuple、後続executionのterminal tupleを比較する"
// @end-test-value
test("Session binding snapshot remains immutable across configure and terminal transitions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-binding-lifecycle-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const fixtureDb = new DatabaseSync(dbPath);
  try {
    fixtureDb.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run("character-a", "Character A", CREATED_AT, CREATED_AT);
    fixtureDb.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run("character-b", "Character B", CREATED_AT, CREATED_AT);
  } finally {
    fixtureDb.close();
  }
  const sessionStorage = new SessionStorageV6(dbPath);
  const executionStorage = new SessionExecutionStorageV6(dbPath);

  try {
    const initial = sessionStorage.insertSession({
      ...buildSession(),
      updatedAt: CREATED_AT,
    });

    const firstEnqueue = executionStorage.enqueue({
      id: "execution-before-configure",
      expectedContainerRevision: executionStorage.getSessionContainerRevision(initial.id),
      sessionId: initial.id,
      request: { userMessage: "before configure" },
      idempotencyKey: "enqueue-before-configure",
      requestFingerprint: "fingerprint-before-configure",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      proof: trustedProof("turn.enqueue", "execution"),
    });
    assert.equal(firstEnqueue.execution.state, "queued");
    assert.deepEqual(firstEnqueue.execution.binding, {
      bindingRevision: 1,
      providerId: "codex",
      modelId: "gpt-5",
      reasoningEffort: "high",
      customAgentName: "",
      catalogRevision: 1,
      threadId: "",
      characterRuntimeIdentity: "character-a",
      workspaceGrant: { path: "C:/workspace" },
      providerGeneration: null,
      executionGeneration: null,
      roleBinding: {
        sessionRole: "standalone",
        roleContractRevision: 1,
        rootSessionId: initial.id,
        parentSessionId: null,
        delegationDepth: 0,
      },
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      accessMode: "active",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      codexSpeed: "standard",
      codexReviewer: "user",
      allowedAdditionalDirectories: [],
      characterId: "character-a",
      characterName: "Character A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: initial.characterRuntimeSnapshot,
    });
    sessionStorage.appendRunningTurnStart({
      sessionId: initial.id,
      expectedMessageCount: 0,
      userMessage: { role: "user", text: "before configure" },
      updatedAt: CREATED_AT,
    });
    const turnDb = new DatabaseSync(dbPath);
    turnDb.prepare(`
      INSERT INTO session_turns_v6 (
        session_id, phase, provider_id, model_id, reasoning_effort,
        approval_mode, sandbox_mode, user_message_seq, started_at, updated_at
      ) VALUES (?, 'running', 'codex', 'gpt-5', 'high', 'untrusted', 'workspace-write', 0, ?, ?)
    `).run(initial.id, CREATED_AT, CREATED_AT);
    turnDb.close();

    const configured = {
      ...initial,
      updatedAt: CONFIGURED_AT,
      provider: "copilot" as const,
      catalogRevision: 2,
      model: "copilot-model",
      reasoningEffort: "low" as const,
      workspacePath: "C:/workspace-next",
      threadId: "thread-after-configure",
      characterId: "character-b",
      character: "Character B",
      characterRuntimeSnapshot: {
        ...initial.characterRuntimeSnapshot!,
        characterId: "character-b",
        name: "Character B",
      },
    };
    const lifecycle = sessionStorage.prepareLifecycleMutation({
      operation: "session.configure",
      input: {
        sessionId: initial.id,
        kind: "runtime",
        idempotencyKey: "configure-binding",
        expectedRevision: 3,
      },
      proof: trustedProof("session.configure", "session"),
      nextSession: configured,
      now: CONFIGURED_AT,
      requestFingerprint: "configure-binding-fingerprint",
    });
    sessionStorage.commitLifecycleMutation({
      operationId: lifecycle.operationId,
      expectedOperationRevision: lifecycle.revision,
      proof: trustedProof("session.configure", "session"),
      now: CONFIGURED_AT,
      projectResult: (session) => ({ sessionId: session.id }),
    });

    const admitted = executionStorage.admitNextQueued(initial.id, CONFIGURED_AT);
    assert.equal(admitted?.id, "execution-before-configure");
    const oldBinding = admitted?.binding;
    assert.deepEqual(oldBinding, firstEnqueue.execution.binding);

    const firstTerminal = executionStorage.completeRunning({
      executionId: "execution-before-configure",
      state: "completed",
      result: { ok: true },
      errorCode: "",
      reason: "",
      completedAt: CONFIGURED_AT,
      expiresAt: EXPIRES_AT,
    });
    assert.equal(firstTerminal.state, "completed");
    assert.deepEqual(firstTerminal.binding, oldBinding);
    const terminalDb = new DatabaseSync(dbPath);
    const auditLogId = (terminalDb.prepare("SELECT id FROM session_turns_v6 WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(initial.id) as { id: number }).id;
    terminalDb.close();
    sessionStorage.upsertTerminalSession({
      ...initial,
      status: "idle",
      runState: "idle",
      updatedAt: CONFIGURED_AT,
      messages: [
        { role: "user", text: "before configure" },
        { role: "assistant", text: "completed with old binding" },
      ],
      threadId: "thread-old",
    }, {
      auditLogId,
      sessionId: initial.id,
      phase: "completed",
      assistantMessageSeq: 1,
      threadId: "thread-old",
      errorMessage: "",
      completedAt: CONFIGURED_AT,
    });

    const secondEnqueue = executionStorage.enqueue({
      id: "execution-after-configure",
      expectedContainerRevision: executionStorage.getSessionContainerRevision(initial.id),
      sessionId: initial.id,
      request: { userMessage: "after configure" },
      idempotencyKey: "enqueue-after-configure",
      requestFingerprint: "fingerprint-after-configure",
      createdAt: "2026-08-10T00:02:00.000Z",
      expiresAt: EXPIRES_AT,
      proof: trustedProof("turn.enqueue", "execution"),
    });
    assert.deepEqual(secondEnqueue.execution.binding, {
      bindingRevision: 2,
      providerId: "copilot",
      modelId: "copilot-model",
      reasoningEffort: "low",
      customAgentName: "",
      catalogRevision: 2,
      threadId: "thread-after-configure",
      characterRuntimeIdentity: "character-b",
      workspaceGrant: { path: "C:/workspace-next" },
      providerGeneration: null,
      executionGeneration: null,
      roleBinding: {
        sessionRole: "standalone",
        roleContractRevision: 1,
        rootSessionId: initial.id,
        parentSessionId: null,
        delegationDepth: 0,
      },
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace-next",
      branch: "main",
      accessMode: "active",
      approvalMode: "untrusted",
      codexSandboxMode: "workspace-write",
      codexSpeed: "standard",
      codexReviewer: "user",
      allowedAdditionalDirectories: [],
      characterId: "character-b",
      characterName: "Character B",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      characterRuntimeSnapshot: configured.characterRuntimeSnapshot,
    });

    const secondAdmitted = executionStorage.admitNextQueued(initial.id, "2026-08-10T00:02:00.000Z");
    assert.equal(secondAdmitted?.id, "execution-after-configure");
    const secondTerminal = executionStorage.completeRunning({
      executionId: "execution-after-configure",
      state: "completed",
      result: { ok: true },
      errorCode: "",
      reason: "",
      completedAt: "2026-08-10T00:03:00.000Z",
      expiresAt: EXPIRES_AT,
    });
    assert.deepEqual(secondTerminal.binding, secondEnqueue.execution.binding);
    assert.deepEqual(executionStorage.get("execution-before-configure")?.binding, oldBinding);
    assert.deepEqual(executionStorage.get("execution-after-configure")?.binding, secondEnqueue.execution.binding);
    const storedAfterTerminal = sessionStorage.getSession(initial.id);
    assert.equal(storedAfterTerminal?.characterId, "character-b");
    assert.equal(storedAfterTerminal?.characterRuntimeSnapshot?.characterId, "character-b");
    assert.equal(storedAfterTerminal?.messages.at(-1)?.text, "completed with old binding");
  } finally {
    executionStorage.close();
    sessionStorage.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

// @test-value v2
// kind = "invariant"
// claim = "既存resource history migration済みDBでもbinding baselineを一度だけ追加し、migration後のenqueueが現在tupleを捕捉する"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Migration" }
// fault = "既存migration markerだけを根拠にbinding backfillを省略し、旧Sessionのenqueueが空bindingのまま進む"
// observable = "resource revision/event count、binding payload、enqueue execution binding"
// observation_boundary = "consumer"
// scope = "SessionStorageV6 resource history migration and SessionExecutionStorageV6 enqueue"
// lifecycle = "permanent"
// distinction = "初回migration、enqueue、再起動時の二重baseline防止を同一DBで検証する"
// @end-test-value
test("既存resource historyへbinding baselineを一度だけ追加してenqueueへ引き継ぐ", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-session-binding-migration-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const fixtureDb = new DatabaseSync(dbPath);
  try {
    fixtureDb.prepare(`
      INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
      VALUES ('resource_history_v6_migrated_at', '1', ?)
    `).run(CREATED_AT);
    fixtureDb.prepare("DELETE FROM app_settings WHERE setting_key = 'session_binding_history_v6_migrated_at'").run();
    fixtureDb.prepare(`
      INSERT INTO characters (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run("character-a", "Character A", CREATED_AT, CREATED_AT);
    fixtureDb.prepare(`
      INSERT INTO sessions_v6 (
        id, title, state, session_kind, provider_id, catalog_revision, model_id,
        reasoning_effort, custom_agent_name, approval_mode, codex_sandbox_mode,
        allowed_additional_directories_json, runtime_policy_json, thread_id,
        character_id, character_snapshot_json, workspace_path, is_pinned,
        created_at, updated_at, last_active_at
      ) VALUES (?, ?, 'active', 'default', 'codex', 1, 'gpt-5', 'high', '',
        'untrusted', 'workspace-write', '[]', ?, '', 'character-a', ?, ?, 0, ?, ?, ?)
    `).run(
      "legacy-session",
      "Legacy binding",
      JSON.stringify({ workspaceLabel: "workspace", branch: "main", accessMode: "active", characterName: "Character A" }),
      JSON.stringify(buildSession().characterRuntimeSnapshot),
      "C:/workspace",
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    );
    fixtureDb.prepare(`
      INSERT INTO session_role_bindings_v6 (
        session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      ) VALUES ('legacy-session', 'standalone', 1, 'legacy-session', NULL, 0)
    `).run();
    fixtureDb.prepare(`
      INSERT INTO session_resource_events_v6 (event_id, session_id, revision, event_kind, payload_json)
      VALUES ('legacy-session:revision:1', 'legacy-session', 1, 'migration_baseline', ?)
    `).run(JSON.stringify({ projection: readSessionProjection(fixtureDb, "legacy-session") }));
    fixtureDb.prepare(`
      INSERT INTO resource_event_headers_v6 (
        event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
        event_kind, resource_revision, principal_kind, actor_session_id,
        grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
        occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
      ) VALUES ('legacy-session:revision:1', 'session', 'legacy-session', 'legacy-session', 'session',
        'legacy-session', 'migration_baseline', 1, 'system', NULL, NULL, NULL,
        'migration:legacy-session', NULL, ?, ?, NULL, 2, 'committed')
    `).run(CREATED_AT, CREATED_AT);
  } finally {
    fixtureDb.close();
  }

  try {
    const sessionStorage = new SessionStorageV6(dbPath);
    const executionStorage = new SessionExecutionStorageV6(dbPath);
    try {
      const migrated = sessionStorage.getSession("legacy-session");
      assert.ok(migrated);
      assert.equal(sessionStorage.getSessionResourceRevision("legacy-session"), 2);
      let baselineBinding: Record<string, unknown>;
      const historyDb = new DatabaseSync(dbPath);
      try {
        const rows = historyDb.prepare(`
          SELECT revision, event_kind, json_type(payload_json, '$.binding') AS binding_type
          FROM session_resource_events_v6 WHERE session_id = 'legacy-session' ORDER BY revision
        `).all() as Array<{ revision: number; event_kind: string; binding_type: string | null }>;
        assert.deepEqual(rows.map((row) => ({ ...row })), [
          { revision: 1, event_kind: "migration_baseline", binding_type: null },
          { revision: 2, event_kind: "binding_migration_baseline", binding_type: "object" },
        ]);
        const payload = historyDb.prepare("SELECT payload_json FROM session_resource_events_v6 WHERE session_id = 'legacy-session' AND revision = 2").get() as { payload_json: string };
        baselineBinding = JSON.parse(payload.payload_json).binding;
        assert.equal(baselineBinding.sessionId, "legacy-session");
        assert.equal(baselineBinding.revision, 2);
        assert.equal(baselineBinding.providerId, "codex");
        assert.equal(baselineBinding.modelId, "gpt-5");
        assert.equal(baselineBinding.threadId, "");
        assert.equal(baselineBinding.workspacePath, "C:/workspace");
        assert.equal(baselineBinding.characterId, "character-a");
        assert.deepEqual(baselineBinding.characterRuntimeSnapshot, buildSession().characterRuntimeSnapshot);
        assert.deepEqual(baselineBinding.roleBinding, {
          sessionRole: "standalone", roleContractRevision: 1, rootSessionId: "legacy-session",
          parentSessionId: null, delegationDepth: 0,
        });
      } finally {
        historyDb.close();
      }
      const queued = executionStorage.enqueue({
        id: "execution-after-binding-migration",
        expectedContainerRevision: executionStorage.getSessionContainerRevision("legacy-session"),
        sessionId: "legacy-session",
        request: { userMessage: "after migration" },
        idempotencyKey: "enqueue-after-binding-migration",
        requestFingerprint: "fingerprint-after-binding-migration",
        createdAt: CONFIGURED_AT,
        expiresAt: EXPIRES_AT,
        proof: trustedProof("turn.enqueue", "execution", "legacy-session"),
      });
      assert.equal(queued.execution.binding?.bindingRevision, 2);
      const { sessionId: _sessionId, revision: _revision, sessionRole: _sessionRole,
        roleContractRevision: _roleRevision, rootSessionId: _rootId, parentSessionId: _parentId,
        delegationDepth: _depth, ...baselineTuple } = baselineBinding;
      assert.deepEqual(queued.execution.binding, { ...baselineTuple, bindingRevision: 2 });
    } finally {
      sessionStorage.close();
      executionStorage.close();
    }

    const restarted = new SessionStorageV6(dbPath);
    try {
      assert.equal(restarted.getSessionResourceRevision("legacy-session"), 3);
      const markerDb = new DatabaseSync(dbPath);
      try {
        const count = markerDb.prepare(`
          SELECT COUNT(*) AS count FROM session_resource_events_v6
          WHERE session_id = 'legacy-session' AND event_kind = 'binding_migration_baseline'
        `).get() as { count: number };
        assert.equal(count.count, 1);
        assert.ok(markerDb.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'session_binding_history_v6_migrated_at'").get());
      } finally {
        markerDb.close();
      }
    } finally {
      restarted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
