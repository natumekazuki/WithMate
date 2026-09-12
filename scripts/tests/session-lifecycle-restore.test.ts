import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { SESSION_AUTHORITY_MAPPING_REVISION, type MutationAuthorityProof } from "../../src/session-authority.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import { ResourceBudgetStorage } from "../../src-electron/resource-budget-storage.js";
import { initializeSessionConstruction } from "../../src-electron/session-lifecycle-creation.js";
import { restoreRootBudgetWithinTransaction } from "../../src-electron/session-lifecycle-restore.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-08T12:00:00.000Z";

function root(id: string): Session {
  return {
    ...buildNewSession({
      id,
      taskTitle: id,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      characterId: "character-a",
      character: "A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
      rootSessionRole: "overall-coordinator",
    }),
    updatedAt: NOW,
  };
}

function proof(sessionId: string): MutationAuthorityProof {
  return {
    principal: { kind: "user", receiptId: "restore-test-user" },
    providerId: null,
    operation: "session.restore",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "session.restore",
    effectClass: "local_mutation",
    grantId: null,
    grantRevision: null,
    resolvedScope: {
      resourceKind: "session",
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    evaluatedAt: NOW,
  };
}

// @test-value v2
// kind = "contract"
// claim = "root restore reuses the root budget account and applies explicit limits without refunding usage"
// oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/01-session-lifecycle.md#Root restore" }
// fault = "restore creates a child budget, refunds existing consumption, or applies limits to a different account"
// observable = "account identity and count, root ownership, revision, deadline, hard limits, and every committed dimension remain consistent"
// observation_boundary = "component-behavior"
// scope = "session-lifecycle-restore"
// lifecycle = "permanent"
// @end-test-value
it("restores explicit root budget without changing cumulative usage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-session-restore-"));
  const dbPath = path.join(directory, "db.sqlite");
  const sessions = new SessionStorageV6(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const session = root("restore-root");
    sessions.insertSession(session);
    initializeSessionConstruction(db, {
      expectedContainerRevision: 1,
      placement: { kind: "root", rootKind: "overall-coordinator" },
      title: session.taskTitle,
      character: { characterId: session.characterId, expectedDefinitionSha256: "sha" },
      provider: { id: "codex", catalogRevision: 1, model: "test", reasoningEffort: "medium", threadContinuity: "reset", approvalMode: DEFAULT_APPROVAL_MODE, codexSandboxMode: "workspace-write", allowedAdditionalDirectories: [] },
      workspace: { kind: "directory", path: "C:/workspace" },
      initialGrant: { kind: "inherit" },
      budget: { kind: "inherit" },
      idempotencyKey: "construction",
    }, proof(session.id), session, "construction", NOW);

    const storage = new ResourceBudgetStorage(db);
    storage.consumeCount({ sessionId: session.id, dimension: "workItems", idempotencyKey: "old-work", consumedAt: NOW });
    const before = storage.getByAccountId(session.id);
    const committedBefore = Object.fromEntries(Object.entries(before.dimensions)
      .map(([dimension, state]) => [dimension, state.committed]));
    const accountCountBefore = Number((db.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE root_session_id = ?")
      .get(session.id) as { count: number }).count);
    const requested = { kind: "explicit" as const, hardLimits: { workItems: 7 }, deadlineAt: "2026-09-20T00:00:00.000Z" };

    db.exec("BEGIN IMMEDIATE");
    const updated = restoreRootBudgetWithinTransaction(db, session.id, requested, proof(session.id), "restore-op", NOW);
    db.exec("COMMIT");
    assert.equal(updated.accountId, before.accountId);
    assert.equal(updated.accountKind, "root");
    assert.equal(updated.rootSessionId, session.id);
    assert.equal(updated.ownerSessionId, session.id);
    assert.equal(updated.revision, before.revision + 1);
    assert.equal(updated.dimensions.workItems.hardLimit, 7);
    assert.deepEqual(Object.fromEntries(Object.entries(updated.dimensions)
      .filter(([dimension]) => dimension !== "workItems").map(([dimension, state]) => [dimension, state.hardLimit])),
    Object.fromEntries(Object.entries(before.dimensions)
      .filter(([dimension]) => dimension !== "workItems").map(([dimension, state]) => [dimension, state.hardLimit])));
    assert.equal(updated.deadlineAt, requested.deadlineAt);
    assert.deepEqual(Object.fromEntries(Object.entries(updated.dimensions)
      .map(([dimension, state]) => [dimension, state.committed])), committedBefore);
    assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM resource_budget_accounts_v6 WHERE root_session_id = ?")
      .get(session.id) as { count: number }).count), accountCountBefore);

    db.exec("BEGIN IMMEDIATE");
    const inherited = restoreRootBudgetWithinTransaction(db, session.id, { kind: "inherit" }, proof(session.id), "restore-inherit", NOW);
    db.exec("COMMIT");
    assert.deepEqual(inherited, updated);
  } finally {
    db.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  }
});
