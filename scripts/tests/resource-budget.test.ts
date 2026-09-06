import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import type { ResourceBudgetAmounts } from "../../src/resource-budget.js";
import {
  SESSION_AUTHORITY_MAPPING_REVISION,
  type MutationAuthorityProof,
} from "../../src/session-authority.js";
import { buildChildSessionRoleBinding } from "../../src/session-role-binding.js";
import { buildNewSession, type Session } from "../../src/session-state.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import {
  ResourceBudgetError,
  ResourceBudgetStorage,
  verifyResourceBudgetLedger,
} from "../../src-electron/resource-budget-storage.js";
import { SessionAuthorityService } from "../../src-electron/session-authority-service.js";
import { revokeSessionAuthorityGrant } from "../../src-electron/session-authority-storage.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";

const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T01:00:00.000Z";
const execFileAsync = promisify(execFile);

const reserveWorkerInput = process.env.WITHMATE_RESOURCE_BUDGET_RESERVE_WORKER;
if (reserveWorkerInput) {
  const input = JSON.parse(reserveWorkerInput) as {
    dbPath: string;
    readyPath: string;
    startPath: string;
    index: number;
  };
  const storage = new ResourceBudgetStorage(input.dbPath);
  let outcome = "reserved";
  try {
    writeFileSync(input.readyPath, "");
    while (!existsSync(input.startPath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    storage.reserveImmediateTurn({
      sessionId: "root-a",
      executionId: `execution-${input.index}`,
      idempotencyKey: `run-${input.index}`,
      createdAt: NOW,
    });
  } catch (error) {
    outcome = error instanceof ResourceBudgetError
      ? error.code
      : error instanceof Error
        ? `${"code" in error ? String(error.code) : error.name}:${error.message}`
        : "unexpected";
  } finally {
    storage.close();
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(outcome, (error) => error ? reject(error) : resolve());
  });
  process.exit(0);
}

async function waitForPath(targetPath: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(targetPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return existsSync(targetPath);
}

function makeRoot(id: string): Session {
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

function makeChild(
  id: string,
  parent: Session,
  role: "task-coordinator" | "executor" = "executor",
): Session {
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
      roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role),
    }),
    updatedAt: NOW,
  };
}

function binding(sessionId: string): ResolvedAgentRuntimeBinding {
  return {
    bindingId: `binding-${sessionId}`,
    bindingIdHash: `binding-hash-${sessionId}`,
    actorSessionId: sessionId,
    providerId: "codex",
    executionGeneration: "generation-1",
    authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"],
    createdAt: NOW,
    expiresAt: null,
  };
}

function userBudgetProof(sessionId: string, receiptId: string): MutationAuthorityProof {
  return {
    principal: { kind: "user", receiptId },
    operation: "budget.configure",
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: "budget.configure",
    resolvedScope: {
      resourceKind: "budget",
      resourceId: sessionId,
      rootSessionId: sessionId,
      ownerKind: "session",
      ownerId: sessionId,
      relation: "self",
    },
    effectClass: "local_mutation",
    grantId: null,
    grantRevision: null,
    evaluatedAt: NOW,
  };
}

function childLimits(concurrentTurns: number): ResourceBudgetAmounts {
  return {
    concurrentTurns,
    queuedTurns: 0,
    totalTurns: 0,
    retries: 0,
    sessions: 0,
    workItems: 0,
    delegations: 0,
    storageBytes: 0,
  };
}

async function createFixture(prefix: string): Promise<{
  directory: string;
  dbPath: string;
  sessionStorage: SessionStorageV6;
  root: Session;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(directory, "db.sqlite");
  const sessionStorage = new SessionStorageV6(dbPath);
  const root = makeRoot("root-a");
  sessionStorage.insertSession(root);
  return { directory, dbPath, sessionStorage, root };
}

function isBudgetError(code: ResourceBudgetError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof ResourceBudgetError && error.code === code;
}

describe("Resource budget", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "root作成時のledgerは承認された初期hard limitとSession数1を持ち、Session更新でbaselineを重複加算せず、直接呼んだledger verifierがprojection改変を拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Migration" }
  // fault = "移行済みrootへ空または無制限のbudgetを作る、replayでbaselineを重複加算する、またはeventとprojectionの不一致を受理する"
  // observable = "budget.getのhard limitとSession committed数、migration marker件数、ledger verifierの例外"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-migration-and-ledger"
  // lifecycle = "permanent"
  // @end-test-value
  it("初期budgetを一度だけ生成しledger改変を検出する", async () => {
    const fixture = await createFixture("withmate-budget-migration-");
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    const db = new DatabaseSync(fixture.dbPath);
    try {
      const initial = budget.get(fixture.root.id);
      assert.deepEqual(
        Object.fromEntries(Object.entries(initial.dimensions).map(([dimension, state]) => [dimension, state.hardLimit])),
        { concurrentTurns: 4, queuedTurns: 100, totalTurns: 1_000, retries: 100,
          sessions: 100, workItems: 500, delegations: 500, storageBytes: 1_073_741_824 },
      );
      assert.equal(initial.dimensions.sessions.committed, 1);

      fixture.sessionStorage.upsertSession({ ...fixture.root, taskTitle: "renamed" });
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM resource_budget_migration_markers_v6 WHERE root_session_id = ?")
          .get(fixture.root.id) as { count: number }).count,
        1,
      );
      assert.equal(budget.get(fixture.root.id).dimensions.sessions.committed, 1);

      db.prepare(`UPDATE resource_budget_dimensions_v6 SET committed = committed + 1
        WHERE account_id = ? AND dimension = 'sessions'`).run(fixture.root.id);
      assert.throws(() => verifyResourceBudgetLedger(db), isBudgetError("BUDGET_LEDGER_INVALID"));
    } finally {
      db.close();
      budget.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "root全体のconcurrent Turn予約は独立processのDB connectionが同時に競合してもhard limitちょうどだけを許可する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Direct-validation" }
  // fault = "競合したconnectionが同じavailableを使って上限超過する、exact limitを拒否する、またはlock競合をbudget拒否として扱う"
  // observable = "同時開始した5 processの4成功・1 hard-limit拒否という結果集合とrootのreserved値"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-atomic-reservation"
  // lifecycle = "permanent"
  // @end-test-value
  it("独立processの同時予約をroot aggregate exact limitで直列化する", async () => {
    const fixture = await createFixture("withmate-budget-concurrent-");
    const startPath = path.join(fixture.directory, "reserve-start");
    const workerPath = fileURLToPath(import.meta.url);
    const workers: Array<Promise<{ stdout: string }>> = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const readyPath = path.join(fixture.directory, `reserve-ready-${index}`);
        const worker = execFileAsync(process.execPath, ["--import", "tsx", workerPath], {
          env: {
            ...process.env,
            WITHMATE_RESOURCE_BUDGET_RESERVE_WORKER: JSON.stringify({
              dbPath: fixture.dbPath,
              readyPath,
              startPath,
              index,
            }),
          },
        });
        workers.push(worker);
        if (!await waitForPath(readyPath)) await worker;
        assert.equal(existsSync(readyPath), true, `reserve worker ${index} did not become ready`);
      }
      await writeFile(startPath, "");
      const outcomes = (await Promise.all(workers)).map(({ stdout }) => stdout);
      assert.equal(outcomes.filter((outcome) => outcome === "reserved").length, 4);
      assert.deepEqual(
        outcomes.filter((outcome) => outcome !== "reserved"),
        ["BUDGET_HARD_LIMIT_EXCEEDED"],
      );
      const inspection = new ResourceBudgetStorage(fixture.dbPath);
      try {
        assert.equal(inspection.get(fixture.root.id).dimensions.concurrentTurns.reserved, 4);
        assert.equal(inspection.get(fixture.root.id).dimensions.totalTurns.committed, 4);
      } finally {
        inspection.close();
      }
    } finally {
      if (!existsSync(startPath)) await writeFile(startPath, "");
      await Promise.allSettled(workers);
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "child allocationとparent自身の予約の合計はparent hard limitを超えない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Allocation-と-authority" }
  // fault = "child allocationとparent reservationを別々に検査してroot全体ではhard limitを超える"
  // observable = "exact limit時のparent availableと追加parent予約・追加child allocationの拒否"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-child-allocation"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("child allocationとparent予約を同じavailableから差し引く", async () => {
    const fixture = await createFixture("withmate-budget-child-");
    const childA = makeChild("child-a", fixture.root);
    const childB = makeChild("child-b", fixture.root);
    fixture.sessionStorage.insertSession(childA);
    fixture.sessionStorage.insertSession(childB);
    const authority = new SessionAuthorityService({
      databasePath: fixture.dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const proof = authority.authorize(binding(fixture.root.id), "budget.configure", {
        sessionId: fixture.root.id,
      }).proof;
      budget.reserve({
        sessionId: fixture.root.id,
        dimension: "concurrentTurns",
        amount: 2,
        kind: "running_turn",
        executionId: "parent-execution",
        idempotencyKey: "parent-reserve",
        createdAt: NOW,
      });
      budget.allocateChild({
        accountId: "budget-child-a",
        accountKind: "session",
        rootSessionId: fixture.root.id,
        ownerSessionId: childA.id,
        parentAccountId: fixture.root.id,
        hardLimits: childLimits(2),
        authorityGrantId: proof.grantId!,
        authorityGrantRevision: proof.grantRevision!,
        expiresAt: null,
        deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey: "allocate-child-a",
        proof,
        createdAt: NOW,
      });
      assert.equal(budget.get(fixture.root.id).dimensions.concurrentTurns.available, 0);
      assert.throws(() => budget.reserve({
        sessionId: fixture.root.id,
        dimension: "concurrentTurns",
        amount: 1,
        kind: "running_turn",
        executionId: "parent-over-limit",
        idempotencyKey: "parent-over-limit",
        createdAt: NOW,
      }), isBudgetError("BUDGET_HARD_LIMIT_EXCEEDED"));
      assert.throws(() => budget.allocateChild({
        accountId: "budget-child-b",
        accountKind: "session",
        rootSessionId: fixture.root.id,
        ownerSessionId: childB.id,
        parentAccountId: fixture.root.id,
        hardLimits: childLimits(1),
        authorityGrantId: proof.grantId!,
        authorityGrantRevision: proof.grantRevision!,
        expiresAt: null,
        deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey: "allocate-child-b",
        proof,
        createdAt: NOW,
      }), isBudgetError("BUDGET_HARD_LIMIT_EXCEEDED"));
    } finally {
      budget.close();
      authority.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "authority issuer chainが失効したchild allocationは未使用枠だけをparentへ返し、childのcommitted使用量はparent hard limitへ残る"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Allocation-と-authority" }
  // fault = "issuer ancestor失効後もchildが新規reserveできる、またはchildのcommitted使用量までparent availableへ返す"
  // observable = "child reserveのauthority拒否、parent available、exact limitのparent消費成功と追加消費拒否"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-inactive-child-contribution"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("issuer chain失効後もchild committed分をparent hard limitへ保持する", async () => {
    const fixture = await createFixture("withmate-budget-child-revoke-");
    const child = makeChild("child-a", fixture.root);
    fixture.sessionStorage.insertSession(child);
    const authority = new SessionAuthorityService({
      databasePath: fixture.dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    const db = new DatabaseSync(fixture.dbPath);
    try {
      const initial = budget.get(fixture.root.id);
      budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: initial.revision,
        hardLimits: { totalTurns: 4 },
        idempotencyKey: "set-total-turn-limit",
      }, userBudgetProof(fixture.root.id, "user-set-total-turn-limit"), NOW);
      const proof = authority.authorize(binding(fixture.root.id), "budget.configure", {
        sessionId: fixture.root.id,
      }).proof;
      budget.allocateChild({
        accountId: "budget-child-a",
        accountKind: "session",
        rootSessionId: fixture.root.id,
        ownerSessionId: child.id,
        parentAccountId: fixture.root.id,
        hardLimits: { ...childLimits(1), totalTurns: 2 },
        authorityGrantId: proof.grantId!,
        authorityGrantRevision: proof.grantRevision!,
        expiresAt: null,
        deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey: "allocate-child-a",
        proof,
        createdAt: NOW,
      });
      budget.consumeCount({
        sessionId: child.id,
        dimension: "totalTurns",
        idempotencyKey: "child-turn-a",
        consumedAt: NOW,
      });

      const directGrant = db.prepare(`SELECT issuer_grant_id FROM session_authority_grants_v6
        WHERE grant_id = ?`).get(proof.grantId) as { issuer_grant_id: string };
      const issuer = db.prepare(`SELECT revision FROM session_authority_grants_v6
        WHERE grant_id = ?`).get(directGrant.issuer_grant_id) as { revision: number };
      revokeSessionAuthorityGrant(db, {
        grantId: directGrant.issuer_grant_id,
        expectedRevision: issuer.revision,
        principal: { kind: "user", receiptId: "revoke-budget-issuer" },
        revokedAt: LATER,
      });

      assert.throws(() => budget.reserve({
        sessionId: child.id,
        dimension: "concurrentTurns",
        amount: 1,
        kind: "running_turn",
        executionId: "child-after-revoke",
        idempotencyKey: "child-after-revoke",
        createdAt: LATER,
      }), isBudgetError("BUDGET_AUTHORITY_REQUIRED"));
      assert.equal(budget.get(fixture.root.id).dimensions.totalTurns.available, 3);
      budget.consumeCount({
        sessionId: fixture.root.id,
        dimension: "totalTurns",
        amount: 3,
        idempotencyKey: "parent-exact-use",
        consumedAt: LATER,
      });
      assert.throws(() => budget.consumeCount({
        sessionId: fixture.root.id,
        dimension: "totalTurns",
        idempotencyKey: "parent-over-limit",
        consumedAt: LATER,
      }), isBudgetError("BUDGET_HARD_LIMIT_EXCEEDED"));
    } finally {
      db.close();
      budget.close();
      authority.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "revokedまたはexpiredになったchild allocationは未使用枠だけを返し、committed使用量をparent hard limitへ残す"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Allocation-と-authority" }
  // fault = "child accountの失効時にhard allocation全量を返還してcommitted使用量をparent availableへ戻す"
  // observable = "revoked・expired各状態でのparent totalTurns availableとchild新規消費のauthority拒否"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-inactive-child-usage"
  // lifecycle = "permanent"
  // @end-test-value
  it("revokedとexpiredのchild committed分をparentへ返還しない", async () => {
    for (const mode of ["revoked", "expired"] as const) {
      const fixture = await createFixture(`withmate-budget-child-${mode}-`);
      const child = makeChild("child-a", fixture.root);
      fixture.sessionStorage.insertSession(child);
      const authority = new SessionAuthorityService({
        databasePath: fixture.dbPath,
        getExecutionGeneration: () => "generation-1",
        now: () => new Date(NOW),
      });
      const budget = new ResourceBudgetStorage(fixture.dbPath);
      try {
        const initial = budget.get(fixture.root.id);
        budget.configure({
          sessionId: fixture.root.id,
          accountId: fixture.root.id,
          expectedRevision: initial.revision,
          hardLimits: { totalTurns: 4 },
          idempotencyKey: `set-total-turn-limit-${mode}`,
        }, userBudgetProof(fixture.root.id, `user-set-total-turn-limit-${mode}`), NOW);
        const proof = authority.authorize(binding(fixture.root.id), "budget.configure", {
          sessionId: fixture.root.id,
        }).proof;
        budget.allocateChild({
          accountId: "budget-child-a",
          accountKind: "session",
          rootSessionId: fixture.root.id,
          ownerSessionId: child.id,
          parentAccountId: fixture.root.id,
          hardLimits: { ...childLimits(1), totalTurns: 2 },
          authorityGrantId: proof.grantId!,
          authorityGrantRevision: proof.grantRevision!,
          expiresAt: mode === "expired" ? "2026-09-05T00:30:00.000Z" : null,
          deadlineAt: "2026-10-01T00:00:00.000Z",
          idempotencyKey: `allocate-child-${mode}`,
          proof,
          createdAt: NOW,
        });
        budget.consumeCount({
          sessionId: child.id,
          dimension: "totalTurns",
          idempotencyKey: `child-turn-${mode}`,
          consumedAt: NOW,
        });
        if (mode === "revoked") {
          const childBudget = budget.getByAccountId("budget-child-a");
          budget.configure({
            sessionId: child.id,
            accountId: "budget-child-a",
            expectedRevision: childBudget.revision,
            revoked: true,
            idempotencyKey: "revoke-child",
          }, userBudgetProof(child.id, "user-revoke-child"), LATER);
        }
        assert.equal(budget.get(fixture.root.id).dimensions.totalTurns.available, 3);
        assert.throws(() => budget.consumeCount({
          sessionId: child.id,
          dimension: "totalTurns",
          idempotencyKey: `child-after-${mode}`,
          consumedAt: LATER,
        }), isBudgetError("BUDGET_AUTHORITY_REQUIRED"));
      } finally {
        budget.close();
        authority.close();
        fixture.sessionStorage.close();
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "explicit child accountのdispatch deadlineはroot policyを追随し、root期限延長後にchild allocationを作り直さず再開する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Deadline-と-retry" }
  // fault = "child作成時のdeadline複製を使い続けてroot短縮を無視する、またはroot延長後も期限切れのままになる"
  // observable = "root短縮後のchild deadline拒否、root延長後の同じchild accountでの予約成功"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-child-root-deadline"
  // lifecycle = "permanent"
  // @end-test-value
  it("explicit child accountをroot deadline延長後に再開する", async () => {
    const fixture = await createFixture("withmate-budget-child-deadline-");
    const child = makeChild("child-a", fixture.root);
    fixture.sessionStorage.insertSession(child);
    const authority = new SessionAuthorityService({
      databasePath: fixture.dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const proof = authority.authorize(binding(fixture.root.id), "budget.configure", {
        sessionId: fixture.root.id,
      }).proof;
      budget.allocateChild({
        accountId: "budget-child-a",
        accountKind: "session",
        rootSessionId: fixture.root.id,
        ownerSessionId: child.id,
        parentAccountId: fixture.root.id,
        hardLimits: { ...childLimits(1), totalTurns: 2 },
        authorityGrantId: proof.grantId!,
        authorityGrantRevision: proof.grantRevision!,
        expiresAt: null,
        deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey: "allocate-child-a",
        proof,
        createdAt: NOW,
      });
      const root = budget.get(fixture.root.id);
      const shortened = budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: root.revision,
        deadlineAt: "2026-09-05T00:30:00.000Z",
        idempotencyKey: "shorten-child-root-deadline",
      }, userBudgetProof(fixture.root.id, "user-shorten-child-root-deadline"), NOW);
      assert.throws(() => budget.reserveImmediateTurn({
        sessionId: child.id,
        executionId: "child-before-extension",
        idempotencyKey: "child-before-extension",
        createdAt: LATER,
      }), isBudgetError("BUDGET_DEADLINE_EXCEEDED"));

      budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: shortened.revision,
        deadlineAt: "2026-09-06T00:00:00.000Z",
        idempotencyKey: "extend-child-root-deadline",
      }, userBudgetProof(fixture.root.id, "user-extend-child-root-deadline"), LATER);
      const resumed = budget.reserveImmediateTurn({
        sessionId: child.id,
        executionId: "child-after-extension",
        idempotencyKey: "child-after-extension",
        createdAt: "2026-09-05T02:00:00.000Z",
      });
      assert.equal(resumed.accountId, "budget-child-a");
      assert.equal(budget.get(child.id).deadlineAt, "2026-09-06T00:00:00.000Z");
    } finally {
      budget.close();
      authority.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "execution受付後にchild allocationを作成またはrevokeしてもstart・retry・settleは受付時のaccount reservationへ帰属する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "lifecycle途中のallocation変更によりqueueを開始できない、retryを別accountへ加算する、またはterminalで元予約を解放できない"
  // observable = "running reservation account、root retry committed、allocation revoke後の元child reservation release state"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-execution-account-affinity"
  // lifecycle = "permanent"
  // @end-test-value
  it("allocation変更後もexecution lifecycleを受付時accountへ固定する", async () => {
    const fixture = await createFixture("withmate-budget-execution-affinity-");
    const child = makeChild("child-a", fixture.root);
    fixture.sessionStorage.insertSession(child);
    const authority = new SessionAuthorityService({
      databasePath: fixture.dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const queued = budget.reserveQueuedTurn({
        sessionId: child.id,
        executionId: "execution-before-allocation",
        idempotencyKey: "queue-before-allocation",
        createdAt: NOW,
      });
      assert.equal(queued.accountId, fixture.root.id);

      const proof = authority.authorize(binding(fixture.root.id), "budget.configure", {
        sessionId: fixture.root.id,
      }).proof;
      budget.allocateChild({
        accountId: "budget-child-a",
        accountKind: "session",
        rootSessionId: fixture.root.id,
        ownerSessionId: child.id,
        parentAccountId: fixture.root.id,
        hardLimits: { ...childLimits(1), queuedTurns: 1, totalTurns: 4, retries: 3 },
        authorityGrantId: proof.grantId!,
        authorityGrantRevision: proof.grantRevision!,
        expiresAt: null,
        deadlineAt: "2026-10-01T00:00:00.000Z",
        idempotencyKey: "allocate-child-a",
        proof,
        createdAt: NOW,
      });
      const runningFromRoot = budget.startQueuedTurn({
        sessionId: child.id,
        executionId: "execution-before-allocation",
        startedAt: LATER,
      });
      assert.equal(runningFromRoot.accountId, fixture.root.id);
      budget.consumeRetry({
        sessionId: child.id,
        executionId: "execution-before-allocation",
        retryAttempt: 1,
        idempotencyKey: "retry-before-allocation",
        consumedAt: LATER,
      });
      assert.equal(budget.get(fixture.root.id).dimensions.retries.committed, 1);
      assert.equal(budget.get(child.id).dimensions.retries.committed, 0);
      budget.settleTurn({
        sessionId: child.id,
        executionId: "execution-before-allocation",
        outcome: "completed",
        settledAt: "2026-09-05T02:00:00.000Z",
      });
      assert.equal(budget.getByAccountId(fixture.root.id).dimensions.concurrentTurns.reserved, 0);

      const runningFromChild = budget.reserveImmediateTurn({
        sessionId: child.id,
        executionId: "execution-before-revoke",
        idempotencyKey: "run-before-revoke",
        createdAt: "2026-09-05T03:00:00.000Z",
      });
      assert.equal(runningFromChild.accountId, "budget-child-a");
      const childBudget = budget.getByAccountId("budget-child-a");
      budget.configure({
        sessionId: child.id,
        accountId: "budget-child-a",
        expectedRevision: childBudget.revision,
        revoked: true,
        idempotencyKey: "revoke-child-allocation",
      }, userBudgetProof(child.id, "user-revoke-child-allocation"), "2026-09-05T04:00:00.000Z");
      budget.settleTurn({
        sessionId: child.id,
        executionId: "execution-before-revoke",
        outcome: "canceled",
        settledAt: "2026-09-05T05:00:00.000Z",
      });
      assert.equal(budget.getByAccountId(runningFromChild.accountId).dimensions.concurrentTurns.reserved, 0);
    } finally {
      budget.close();
      authority.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "response loss replay、crash reconciliation、遅延usageをexecution・generation・reservation identityで一度だけ精算する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "replayを新規Turnとして加算する、crash予約を消失させる、または同じusage keyを別generationへ誤帰属させる"
  // observable = "reservation identity、committed Turn数、reconciliation一覧、metered usage identityと競合エラー"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-settlement-and-usage"
  // lifecycle = "permanent"
  // @end-test-value
  it("replayとcrashと遅延usageを同じidentityへ収束させる", async () => {
    const fixture = await createFixture("withmate-budget-reconcile-");
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const input = {
        sessionId: fixture.root.id,
        executionId: "execution-a",
        idempotencyKey: "run-a",
        createdAt: NOW,
      };
      const original = budget.reserveImmediateTurn(input);
      const replay = budget.reserveImmediateTurn(input);
      assert.equal(replay.reservationId, original.reservationId);
      assert.equal(budget.get(fixture.root.id).dimensions.totalTurns.committed, 1);

      budget.settleTurn({
        sessionId: fixture.root.id,
        executionId: input.executionId,
        outcome: "interrupted",
        settledAt: LATER,
        uncertain: true,
      });
      assert.deepEqual(
        budget.listReconciliationRequired(fixture.root.id).map((item) => item.reservationId),
        [original.reservationId],
      );
      budget.releaseReservation(original.reservationId, "2026-09-05T02:00:00.000Z");

      const usageInput = {
        sessionId: fixture.root.id,
        usageId: "usage-a",
        executionId: input.executionId,
        providerGenerationId: "provider-generation-a",
        reservationId: original.reservationId,
        unit: "tokens" as const,
        amount: 25,
        confidence: "settled" as const,
        idempotencyKey: "usage-event-a",
        observedAt: "2026-09-05T03:00:00.000Z",
      };
      const usage = budget.recordMeteredUsage(usageInput);
      assert.deepEqual(
        {
          executionId: usage.executionId,
          providerGenerationId: usage.providerGenerationId,
          reservationId: usage.reservationId,
          amount: usage.amount,
        },
        {
          executionId: "execution-a",
          providerGenerationId: "provider-generation-a",
          reservationId: original.reservationId,
          amount: 25,
        },
      );
      assert.equal(budget.recordMeteredUsage(usageInput).usageId, usage.usageId);
      assert.throws(() => budget.recordMeteredUsage({
        ...usageInput,
        usageId: "usage-wrong-generation",
        providerGenerationId: "provider-generation-b",
      }), isBudgetError("BUDGET_IDEMPOTENCY_CONFLICT"));
      assert.equal(budget.get(fixture.root.id).meteredUsage.length, 1);
    } finally {
      budget.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "storage書込み再開は解放済みの元予約を変更せず、確定済みbytesを除いた残量だけを新しい予約としてexact capまで利用する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Admission-と-settlement" }
  // fault = "再開時に全量を再予約する、元予約を再利用する、または確定済み全量の再開で空予約を作りstorage hard limitを誤消費する"
  // observable = "元予約と再開予約のidentity・amount・state、storage committed/reserved、exact cap後の拒否"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-storage-resumption"
  // lifecycle = "permanent"
  // @end-test-value
  it("storage再開で確定済みbytesを控除してexact capを回復する", async () => {
    const fixture = await createFixture("withmate-budget-storage-resume-");
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const initial = budget.get(fixture.root.id);
      budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: initial.revision,
        hardLimits: { storageBytes: 10 },
        idempotencyKey: "set-storage-limit",
      }, userBudgetProof(fixture.root.id, "user-set-storage-limit"), NOW);

      const original = budget.reserveStorage({
        sessionId: fixture.root.id,
        bytes: 10,
        operationId: "write-a",
        createdAt: NOW,
      });
      budget.markReservationForReconciliation(original.reservationId, LATER);
      budget.reconcileCommitted({
        sessionId: fixture.root.id,
        dimension: "storageBytes",
        absoluteAmount: 4,
        idempotencyKey: "measure-after-crash",
        reconciledAt: "2026-09-05T02:00:00.000Z",
      });

      const remaining = budget.resumeStorageReservation({
        sessionId: fixture.root.id,
        bytes: 10,
        alreadyCommittedBytes: 4,
        operationId: "write-a",
        resumedAt: "2026-09-05T03:00:00.000Z",
      });
      assert.ok(remaining);
      assert.notEqual(remaining.reservationId, original.reservationId);
      assert.equal(remaining.amount, 6);
      assert.equal(remaining.state, "reserved");
      const unchangedOriginal = budget.releaseReservation(original.reservationId, "2026-09-05T03:30:00.000Z");
      assert.deepEqual(
        { amount: unchangedOriginal.amount, state: unchangedOriginal.state },
        { amount: 10, state: "released" },
      );

      budget.consumeReservation(remaining.reservationId, 6, "2026-09-05T04:00:00.000Z");
      const settled = budget.get(fixture.root.id);
      assert.equal(settled.dimensions.storageBytes.committed, 10);
      assert.equal(settled.dimensions.storageBytes.reserved, 0);
      assert.equal(budget.resumeStorageReservation({
        sessionId: fixture.root.id,
        bytes: 10,
        alreadyCommittedBytes: 10,
        operationId: "write-a",
        resumedAt: "2026-09-05T05:00:00.000Z",
      }), null);
      assert.throws(() => budget.reserveStorage({
        sessionId: fixture.root.id,
        bytes: 1,
        operationId: "write-over-limit",
        createdAt: "2026-09-05T05:00:00.000Z",
      }), isBudgetError("BUDGET_HARD_LIMIT_EXCEEDED"));
    } finally {
      budget.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "deadline後は新規dispatchだけを止め、userが期限を延長すると消費済み履歴を保ったまま再開できる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Deadline-と-retry" }
  // fault = "deadlineがreleaseも禁止してrootを詰ませる、または期限延長後もdispatch不能・過去消費resetになる"
  // observable = "deadlineエラー、期限後のrelease結果、configure後の予約成功、totalTurns committed値"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-deadline-recovery"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("deadline延長後に履歴を保ってdispatchを再開する", async () => {
    const fixture = await createFixture("withmate-budget-deadline-");
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const openReservation = budget.reserveImmediateTurn({
        sessionId: fixture.root.id,
        executionId: "execution-before-deadline",
        idempotencyKey: "before-deadline",
        createdAt: NOW,
      });
      const before = budget.get(fixture.root.id);
      const expired = budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: before.revision,
        deadlineAt: "2026-09-05T00:30:00.000Z",
        idempotencyKey: "shorten-deadline",
      }, userBudgetProof(fixture.root.id, "user-shorten-deadline"), NOW);

      assert.throws(() => budget.reserveImmediateTurn({
        sessionId: fixture.root.id,
        executionId: "execution-after-deadline",
        idempotencyKey: "after-deadline",
        createdAt: LATER,
      }), isBudgetError("BUDGET_DEADLINE_EXCEEDED"));
      assert.equal(budget.releaseReservation(openReservation.reservationId, LATER).state, "released");

      const extended = budget.configure({
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: expired.revision + 1,
        deadlineAt: "2026-09-08T00:00:00.000Z",
        idempotencyKey: "extend-deadline",
      }, userBudgetProof(fixture.root.id, "user-extend-deadline"), LATER);
      assert.equal(extended.dimensions.totalTurns.committed, 1);
      budget.reserveImmediateTurn({
        sessionId: fixture.root.id,
        executionId: "execution-after-extension",
        idempotencyKey: "after-extension",
        createdAt: "2026-09-05T02:00:00.000Z",
      });
      assert.equal(budget.get(fixture.root.id).dimensions.totalTurns.committed, 2);
    } finally {
      budget.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  // @test-value v2
  // kind = "security"
  // claim = "Agentのbudget.configureはroot hard limitとdeadlineを増やせず、明示されたuser authorityだけが増加できる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Configure" }
  // fault = "内部配分権限からroot全体の有限上限または有効期間を拡張できる"
  // observable = "Agent proofへのBUDGET_AUTHORITY_REQUIREDとuser proofによる増加後のprojection"
  // observation_boundary = "component-behavior"
  // scope = "resource-budget-root-authority"
  // lifecycle = "permanent"
  // risk_tags = ["authorization"]
  // @end-test-value
  it("root増加をAgentへ拒否しuser authorityで許可する", async () => {
    const fixture = await createFixture("withmate-budget-authority-");
    const authority = new SessionAuthorityService({
      databasePath: fixture.dbPath,
      getExecutionGeneration: () => "generation-1",
      now: () => new Date(NOW),
    });
    const budget = new ResourceBudgetStorage(fixture.dbPath);
    try {
      const initial = budget.get(fixture.root.id);
      const agentProof = authority.authorize(binding(fixture.root.id), "budget.configure", {
        sessionId: fixture.root.id,
      }).proof;
      const increase = {
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: initial.revision,
        hardLimits: { concurrentTurns: initial.dimensions.concurrentTurns.hardLimit + 1 },
        idempotencyKey: "increase-root",
      };
      assert.throws(
        () => budget.configure(increase, agentProof, NOW),
        isBudgetError("BUDGET_AUTHORITY_REQUIRED"),
      );
      const deadlineIncrease = {
        sessionId: fixture.root.id,
        accountId: fixture.root.id,
        expectedRevision: initial.revision,
        deadlineAt: "2026-11-01T00:00:00.000Z",
        idempotencyKey: "extend-root-deadline",
      };
      assert.throws(
        () => budget.configure(deadlineIncrease, agentProof, NOW),
        isBudgetError("BUDGET_AUTHORITY_REQUIRED"),
      );
      const configured = budget.configure(
        increase,
        userBudgetProof(fixture.root.id, "user-increase-root"),
        NOW,
      );
      assert.equal(configured.dimensions.concurrentTurns.hardLimit, 5);
      const deadlineConfigured = budget.configure(
        { ...deadlineIncrease, expectedRevision: configured.revision },
        userBudgetProof(fixture.root.id, "user-extend-root-deadline"),
        NOW,
      );
      assert.equal(deadlineConfigured.deadlineAt, deadlineIncrease.deadlineAt);
    } finally {
      budget.close();
      authority.close();
      fixture.sessionStorage.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
