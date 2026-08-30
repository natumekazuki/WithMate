import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { parseSessionRuntimeOperationInput } from "../../src/session-external-runtime-contract.js";
import type { ResolvedAgentRuntimeBinding } from "../../src-electron/agent-runtime-binding.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/app-database-v6-bootstrap.js";
import { ensureV6Schema } from "../../src-electron/database-schema-v6.js";
import { SessionExecutionStorageV6 } from "../../src-electron/session-execution-storage-v6.js";
import { SessionStorageV6 } from "../../src-electron/session-storage-v6.js";
import {
  WorkItemAuthorityError,
  WorkItemExecutionAssociationError,
  WorkItemParentError,
  WorkItemService,
} from "../../src-electron/work-item-service.js";
import {
  WorkItemAggregationConflictError,
  WorkItemIdempotencyConflictError,
  WorkItemIdempotencyResponseUnavailableError,
  WorkItemRevisionConflictError,
  WorkItemStateConflictError,
  WorkItemStorageV6,
} from "../../src-electron/work-item-storage-v6.js";
import {
  buildChildSessionRoleBinding,
  type RootSessionRole,
  type SessionRoleBinding,
} from "../../src/session-role-binding.js";
import { buildNewSession, type Session, type SessionKind } from "../../src/session-state.js";
import {
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES,
  WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
  WORK_ITEM_MAX_TEXT_LENGTH,
  WorkItemEventPayloadTooLargeError,
  type WorkItem,
  type WorkItemResultState,
} from "../../src/work-item.js";

const NOW = "2026-08-30T00:00:00.000Z";
const EXPIRES = "2026-08-31T00:00:00.000Z";
const SOURCE_IDENTITY = {
  workspace: "C:/workspace",
  repository: "WithMate",
  branch: "feat/root-work-item",
  base: "base-commit",
  head: "head-commit",
} as const;
const WIDE_LEGACY_TEXT = "界".repeat(WORK_ITEM_MAX_TEXT_LENGTH);

type Harness = {
  directory: string;
  dbPath: string;
  sessionStorage: SessionStorageV6;
  workStorage: WorkItemStorageV6;
  executionStorage: SessionExecutionStorageV6;
  service: WorkItemService;
  nextWorkItemId: number;
  now: string;
};

function runtimeBinding(actorSessionId: string): ResolvedAgentRuntimeBinding {
  return {
    bindingId: "binding-" + actorSessionId,
    bindingIdHash: "hash-" + actorSessionId,
    actorSessionId,
    providerId: "codex",
    executionGeneration: "generation-1",
    authoritySnapshot: {},
    operationGrants: ["session.runtime.invoke"],
    createdAt: NOW,
    expiresAt: null,
  };
}

function createSession(input: {
  id: string;
  title?: string;
  rootRole?: RootSessionRole;
  roleBinding?: SessionRoleBinding;
  sessionKind?: SessionKind;
}): Session {
  return {
    ...buildNewSession({
      id: input.id,
      taskTitle: input.title ?? input.id,
      workspaceLabel: "workspace",
      workspacePath: "C:/workspace",
      branch: "main",
      sessionKind: input.sessionKind,
      rootSessionRole: input.rootRole,
      roleBinding: input.roleBinding,
      characterId: "character-a",
      character: "Character A",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: DEFAULT_APPROVAL_MODE,
    }),
    updatedAt: NOW,
  };
}

function makeService(harness: Harness): WorkItemService {
  return new WorkItemService({
    storage: harness.workStorage,
    getTurnAuthoritySession: (sessionId) => harness.sessionStorage.getSessionTurnAuthority(sessionId),
    createWorkItemId: () => "work-" + harness.nextWorkItemId++,
    currentTimestamp: () => harness.now,
  });
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "withmate-root-work-item-"));
  const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
  const harness = {
    directory,
    dbPath,
    sessionStorage: new SessionStorageV6(dbPath),
    workStorage: new WorkItemStorageV6(dbPath),
    executionStorage: new SessionExecutionStorageV6(dbPath),
    service: null as unknown as WorkItemService,
    nextWorkItemId: 1,
    now: NOW,
  } satisfies Harness;
  harness.service = makeService(harness);
  return harness;
}

async function closeHarness(harness: Harness): Promise<void> {
  harness.executionStorage.close();
  harness.workStorage.close();
  harness.sessionStorage.close();
  await rm(harness.directory, { recursive: true, force: true });
}

function insertRootSession(
  harness: Harness,
  id: string,
  role: RootSessionRole = "overall-coordinator",
  title = id,
): Session {
  return harness.sessionStorage.insertSession(createSession({ id, title, rootRole: role }));
}

function insertChildSession(
  harness: Harness,
  id: string,
  parent: Session,
  role: "task-coordinator" | "executor",
): Session {
  return harness.sessionStorage.insertSession(createSession({
    id,
    roleBinding: buildChildSessionRoleBinding(id, parent.id, parent.roleBinding!, role),
  }));
}

function getRootWorkItem(harness: Harness, rootSessionId: string): WorkItem {
  const db = new DatabaseSync(harness.dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT id
      FROM work_items_v6
      WHERE kind = 'root' AND root_session_id = ?
    `).get(rootSessionId) as { id: string } | undefined;
    assert.ok(row, "Root WorkItem for " + rootSessionId);
    const item = harness.workStorage.get(row.id);
    assert.ok(item);
    return item;
  } finally {
    db.close();
  }
}

function createDelegated(
  harness: Harness,
  actorSessionId: string,
  targetSessionId: string,
  key: string,
  parentWorkItemId?: string,
): WorkItem {
  return harness.service.create({
    targetSessionId,
    ...(parentWorkItemId === undefined ? {} : { parentWorkItemId }),
    goal: key + " goal",
    scope: key + " scope",
    completionCriteria: key + " complete",
    authority: key + " authority",
    sourceIdentity: SOURCE_IDENTITY,
    idempotencyKey: key,
  }, runtimeBinding(actorSessionId));
}

function resultInput(summary: string) {
  return {
    summary,
    changes: [],
    verificationResults: [],
    findings: [],
    unverifiedItems: [],
    remainingWork: [],
  };
}

function reportResult(
  harness: Harness,
  workItemId: string,
  actorSessionId: string,
  state: WorkItemResultState,
  expectedRevision: number,
  idempotencyKey: string,
  expectedAggregateRevision?: number,
): WorkItem {
  return harness.service.reportResult({
    workItemId,
    state,
    expectedRevision,
    result: resultInput(workItemId + " result"),
    idempotencyKey,
    ...(expectedAggregateRevision === undefined ? {} : { expectedAggregateRevision }),
  }, runtimeBinding(actorSessionId));
}

function tableCount(dbPath: string, table: string, where = "1", ...parameters: unknown[]): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM " + table + " WHERE " + where).get(...parameters) as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

describe("Root WorkItem contract", () => {
  // @test-value v1
  // kind = "invariant"
  // claim = "root Sessionの作成は上限内の自己所有Root WorkItemとcreated eventを同じtransactionで一件だけ永続化し、event超過時は両方をrollbackし、childとcharacter-authoring Sessionを除外する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#Session 作成との原子性" }
  // failure_mode = "Sessionだけの部分commit、過大created eventのSQLite内部error、Root WorkItemの重複、または対象外SessionへのRoot WorkItem作成により再開時のroot作業契約が一意に復元できない"
  // scope = "SessionStorageV6 root Session persistence"
  // lifecycle = "permanent"
  // distinction = "通常作成、event byte超過と失敗注入によるrollback、再起動後の再読込、対象外Sessionを同じreal SQLiteで観測する"
  // @end-test-value
  it("RW-1: root SessionとRoot WorkItemをatomicかつ一対一に作成し再起動後も重複させない", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator", "Ship Root WorkItem");
      insertRootSession(harness, "standalone", "standalone", "Standalone task");
      insertChildSession(harness, "child", root, "task-coordinator");
      harness.sessionStorage.insertSession(createSession({
        id: "character-authoring",
        title: "Character authoring",
        sessionKind: "character-authoring",
      }));

      const rootItem = getRootWorkItem(harness, "root");
      assert.deepEqual({
        kind: rootItem.kind,
        rootSessionId: rootItem.rootSessionId,
        creatorSessionId: rootItem.creatorSessionId,
        targetSessionId: rootItem.targetSessionId,
        parentWorkItemId: rootItem.parentWorkItemId,
        goal: rootItem.goal,
        scope: rootItem.scope,
        completionCriteria: rootItem.completionCriteria,
        authority: rootItem.authority,
        state: rootItem.state,
        revision: rootItem.revision,
      }, {
        kind: "root",
        rootSessionId: "root",
        creatorSessionId: "root",
        targetSessionId: "root",
        parentWorkItemId: null,
        goal: "Ship Root WorkItem",
        scope: "",
        completionCriteria: "",
        authority: "",
        state: "pending",
        revision: 1,
      });
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "kind = 'root'"), 2);
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "root_session_id IN ('child', 'character-authoring')"), 0);
      const initialHistory = harness.workStorage.listHistory({ workItemId: rootItem.id, afterSequence: null, limit: 10 });
      assert.deepEqual(initialHistory.map((event) => ({
        revision: event.revision,
        type: event.type,
        actorSessionId: event.actorSessionId,
      })), [{ revision: 1, type: "created", actorSessionId: "root" }]);
      const createdEvent = initialHistory[0];
      assert.equal(createdEvent?.type, "created");
      if (createdEvent?.type !== "created") throw new Error("Root WorkItem created event is missing.");
      assert.deepEqual(createdEvent.payload.contract, {
        goal: "Ship Root WorkItem",
        scope: "",
        completionCriteria: "",
        authority: "",
      });

      harness.executionStorage.close();
      harness.workStorage.close();
      harness.sessionStorage.close();
      harness.sessionStorage = new SessionStorageV6(harness.dbPath);
      harness.workStorage = new WorkItemStorageV6(harness.dbPath);
      harness.executionStorage = new SessionExecutionStorageV6(harness.dbPath);
      harness.service = makeService(harness);
      assert.equal(getRootWorkItem(harness, "root").id, rootItem.id);
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "kind = 'root' AND root_session_id = 'root'"), 1);

      assert.throws(
        () => insertRootSession(harness, "oversized-root", "standalone", "界".repeat(200_000)),
        (error) => error instanceof WorkItemEventPayloadTooLargeError
          && error.eventType === "created"
          && error.maxBytes === WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
      );
      assert.equal(harness.sessionStorage.getSession("oversized-root"), null);
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "root_session_id = 'oversized-root'"), 0);

      const db = new DatabaseSync(harness.dbPath);
      try {
        const cloneRoot = db.prepare(`
          INSERT INTO work_items_v6 (
            id, kind, contract_revision, root_session_id, creator_session_id,
            target_session_id, parent_work_item_id, goal, scope,
            completion_criteria, authority, source_identity_json, state,
            revision, progress_summary, blockers_json, next_action,
            result_json, created_at, updated_at
          )
          SELECT ?, 'root', contract_revision, root_session_id, creator_session_id,
            ?, NULL, goal, scope, completion_criteria, authority,
            source_identity_json, state, revision, progress_summary,
            blockers_json, next_action, result_json, created_at, updated_at
          FROM work_items_v6 WHERE id = ?
        `);
        assert.throws(() => cloneRoot.run("invalid-binding-root", "child", rootItem.id), /CHECK constraint failed/);
        assert.throws(() => cloneRoot.run("duplicate-root", "root", rootItem.id), /UNIQUE constraint failed/);
        db.exec(`
          CREATE TRIGGER fail_root_work_item_insert
          BEFORE INSERT ON work_items_v6
          WHEN NEW.kind = 'root'
          BEGIN
            SELECT RAISE(ABORT, 'injected root WorkItem failure');
          END;
        `);
      } finally {
        db.close();
      }
      assert.throws(
        () => insertRootSession(harness, "rolled-back", "standalone", "Must roll back"),
        /injected root WorkItem failure/,
      );
      assert.equal(harness.sessionStorage.getSession("rolled-back"), null);
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "root_session_id = 'rolled-back'"), 0);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Root ownerのcontract revision、progress、handoffは一つの単調revisionでcurrent projectionとappend-only eventへ保存され、同一keyの再送は新しいrevisionを作らず、trusted GUI向けrecent historyは最新pageを時系列順で返す"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
  // failure_mode = "応答喪失後の再送、stale revision、process再起動、または先頭page固定でcurrent projectionと最新履歴が分岐し次の行動を一意に復元できない"
  // scope = "WorkItemService root mutation and WorkItemStorageV6 event stream"
  // lifecycle = "permanent"
  // distinction = "contract、progress、handoffの三種を連続更新し、replay、異payload key再利用、stale revision、restart recoveryを同じstreamで検証する"
  // @end-test-value
  it("RW-2: contract、progress、handoffを単調revisionと履歴へ直列化してreplayする", async () => {
    const harness = await createHarness();
    try {
      insertRootSession(harness, "root", "standalone", "Initial goal");
      const rootItem = getRootWorkItem(harness, "root");
      const reviseInput = {
        workItemId: rootItem.id,
        goal: "Revised goal",
        scope: "Root scope",
        completionCriteria: "All direct checks pass",
        authority: "Repository-local changes only",
        expectedRevision: 1,
        idempotencyKey: "revise-1",
      };
      const revised = harness.service.revise(reviseInput, runtimeBinding("root"));
      assert.equal(harness.service.revise(reviseInput, runtimeBinding("root")).revision, 2);
      const progressed = harness.service.appendHistory({
        workItemId: rootItem.id,
        type: "progress",
        summary: "Storage complete",
        blockers: ["Service pending"],
        nextAction: "Implement service",
        expectedRevision: revised.revision,
        idempotencyKey: "progress-1",
      }, runtimeBinding("root"));
      const handoffInput = {
        workItemId: rootItem.id,
        type: "handoff" as const,
        summary: "Storage and service complete",
        blockers: [],
        nextAction: "Run integration tests",
        expectedRevision: progressed.revision,
        idempotencyKey: "handoff-1",
      };
      const handedOff = harness.service.appendHistory(handoffInput, runtimeBinding("root"));
      assert.deepEqual({
        revision: handedOff.revision,
        goal: handedOff.goal,
        scope: handedOff.scope,
        completionCriteria: handedOff.completionCriteria,
        authority: handedOff.authority,
        progressSummary: handedOff.kind === "root" ? handedOff.progressSummary : null,
        blockers: handedOff.kind === "root" ? handedOff.blockers : null,
        nextAction: handedOff.kind === "root" ? handedOff.nextAction : null,
      }, {
        revision: 4,
        goal: "Revised goal",
        scope: "Root scope",
        completionCriteria: "All direct checks pass",
        authority: "Repository-local changes only",
        progressSummary: "Storage and service complete",
        blockers: [],
        nextAction: "Run integration tests",
      });
      assert.equal(harness.service.appendHistory(handoffInput, runtimeBinding("root")).revision, 4);
      assert.throws(() => harness.service.appendHistory({
        ...handoffInput,
        summary: "Different payload",
      }, runtimeBinding("root")), WorkItemIdempotencyConflictError);
      assert.throws(() => harness.service.revise({
        ...reviseInput,
        expectedRevision: 1,
        idempotencyKey: "stale-revision",
      }, runtimeBinding("root")), WorkItemRevisionConflictError);

      const history = harness.service.listHistory({
        workItemId: rootItem.id,
        afterSequence: null,
        limit: 10,
      }, runtimeBinding("root"));
      assert.deepEqual(history.map((event) => [event.revision, event.type]), [
        [1, "created"],
        [2, "contract_revised"],
        [3, "progress"],
        [4, "handoff"],
      ]);
      assert.deepEqual(history[1]?.payload, {
        before: { goal: "Initial goal", scope: "", completionCriteria: "", authority: "" },
        after: {
          goal: "Revised goal",
          scope: "Root scope",
          completionCriteria: "All direct checks pass",
          authority: "Repository-local changes only",
        },
      });
      assert.deepEqual(
        harness.service.listRecentHistory({ workItemId: rootItem.id, limit: 2 }, runtimeBinding("root"))
          .map((event) => [event.revision, event.type]),
        [[3, "progress"], [4, "handoff"]],
      );

      harness.workStorage.close();
      harness.workStorage = new WorkItemStorageV6(harness.dbPath);
      harness.service = makeService(harness);
      const recovered = harness.service.get(rootItem.id, runtimeBinding("root"));
      assert.equal(recovered.revision, 4);
      assert.deepEqual(harness.service.listHistory({
        workItemId: rootItem.id,
        afterSequence: null,
        limit: 10,
      }, runtimeBinding("root")), history);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "public validatorが512 KiB境界内で受理したhistory mutationは、canonical Work Item全体のidempotency responseも同じtransactionで保存して同一keyをreplayできる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
  // failure_mode = "event単体は受理されるのにcontractと最新progressを含むresponseがledger CHECKを超え、mutation全体がrollbackする"
  // scope = "shared public validator and WorkItemStorageV6 idempotency ledger"
  // lifecycle = "permanent"
  // distinction = "最大長contractと512 KiB近傍のblocker payloadを組み合わせ、event sizeではなく保存済みcanonical response byte数とreplayを観測する"
  // @end-test-value
  it("RW-2B: validator受理payloadをcanonical idempotency responseとして保存してreplayする", async () => {
    const harness = await createHarness();
    try {
      insertRootSession(harness, "root", "standalone", "Initial goal");
      const rootItem = getRootWorkItem(harness, "root");
      const wideText = "契".repeat(WORK_ITEM_MAX_TEXT_LENGTH);
      const revised = harness.service.revise({
        workItemId: rootItem.id,
        goal: wideText,
        scope: wideText,
        completionCriteria: wideText,
        authority: wideText,
        expectedRevision: rootItem.revision,
        idempotencyKey: "wide-contract",
      }, runtimeBinding("root"));
      const rawInput = {
        workItemId: rootItem.id,
        type: "progress" as const,
        summary: "Near-limit progress",
        blockers: Array.from({ length: 32 }, () => "x".repeat(WORK_ITEM_MAX_TEXT_LENGTH)),
        nextAction: "Replay the canonical response",
        expectedRevision: revised.revision,
        idempotencyKey: "near-limit-history",
      };
      const parsed = parseSessionRuntimeOperationInput("work.history.append", rawInput);
      assert.ok(Buffer.byteLength(JSON.stringify(parsed), "utf8") <= WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES);
      const updated = harness.service.appendHistory(parsed, runtimeBinding("root"));
      assert.equal(harness.service.appendHistory(parsed, runtimeBinding("root")).revision, updated.revision);

      const db = new DatabaseSync(harness.dbPath, { readOnly: true });
      try {
        const ledger = db.prepare(`
          SELECT length(CAST(response_json AS BLOB)) AS response_bytes
          FROM work_item_idempotency_v6
          WHERE operation = 'work.history.append' AND idempotency_key = 'near-limit-history'
        `).get() as { response_bytes: number };
        assert.ok(ledger.response_bytes > WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES);
        assert.ok(ledger.response_bytes <= WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES);
      } finally {
        db.close();
      }
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "WorkItemStorageV6はmutationが生成するevent全体を共通byte上限で検証し、超過時はprojection、event、idempotencyを一件もcommitしない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
  // failure_mode = "各入力fieldは受理可能でも生成後のcreated eventが512 KiBを超え、SQLite CHECK由来の内部errorになるかWorkItemだけ部分保存される"
  // scope = "WorkItemStorageV6 event admission and transaction"
  // lifecycle = "permanent"
  // distinction = "history inputの早期validationではなく、bindingを含むexact created payloadとtransaction rollbackをstorage境界で観測する"
  // @end-test-value
  it("RW-2C: exact event payload超過をstorage境界で拒否してcreateをrollbackする", async () => {
    const harness = await createHarness();
    try {
      insertRootSession(harness, "root", "standalone", "Initial goal");
      const oversizedTargetSessionId = "界".repeat(200_000);
      assert.throws(
        () => harness.workStorage.create({
          id: "oversized-created-event",
          binding: {
            kind: "delegated",
            rootSessionId: "root",
            creatorSessionId: "root",
            targetSessionId: oversizedTargetSessionId,
            parentWorkItemId: null,
            goal: "goal",
            scope: "scope",
            completionCriteria: "done",
            authority: "repository-local",
            sourceIdentity: SOURCE_IDENTITY,
          },
          principalSessionId: "root",
          idempotencyKey: "oversized-created-event",
          requestFingerprint: "oversized-created-event-fingerprint",
          createdAt: NOW,
          expiresAt: EXPIRES,
        }),
        (error) => error instanceof WorkItemEventPayloadTooLargeError
          && error.eventType === "created"
          && error.actualBytes > WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES
          && error.maxBytes === WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
      );
      assert.equal(harness.workStorage.get("oversized-created-event"), null);
      const db = new DatabaseSync(harness.dbPath, { readOnly: true });
      try {
        assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM work_item_events_v6 WHERE work_item_id = 'oversized-created-event'`).get() as { count: number }).count, 0);
        assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM work_item_idempotency_v6 WHERE work_item_id = 'oversized-created-event'`).get() as { count: number }).count, 0);
      } finally {
        db.close();
      }
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "security"
  // claim = "Root WorkItemのcontractとhistoryは自己ownerだけが変更でき、delegated WorkItemは既存creator/target authorityを保ち自己対象createを拒否する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#変更可能な情報" }
  // failure_mode = "Root追加のためにdelegated authorityが一括緩和され、child、別root、またはdelegated targetが不変な委任契約を書き換える"
  // scope = "WorkItemService actor authority"
  // lifecycle = "permanent"
  // distinction = "root owner境界とdelegated creator/targetの既存操作matrixを同じreal SQLite graphで対比する"
  // @end-test-value
  it("RW-3: root owner authorityをdelegated authorityから分離して自己対象createを拒否する", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      const task = insertChildSession(harness, "task", root, "task-coordinator");
      insertRootSession(harness, "other-root", "standalone");
      const rootItem = getRootWorkItem(harness, "root");
      const revise = {
        workItemId: rootItem.id,
        goal: "goal",
        scope: "scope",
        completionCriteria: "criteria",
        authority: "description only",
        expectedRevision: rootItem.revision,
        idempotencyKey: "forbidden-revise",
      };
      assert.throws(() => harness.service.revise(revise, runtimeBinding("task")), WorkItemAuthorityError);
      assert.throws(() => harness.service.revise(revise, runtimeBinding("other-root")), WorkItemAuthorityError);
      assert.throws(() => harness.service.appendHistory({
        workItemId: rootItem.id,
        type: "handoff",
        summary: "Must not be recorded",
        blockers: [],
        nextAction: "Must not change",
        expectedRevision: rootItem.revision,
        idempotencyKey: "forbidden-handoff",
      }, runtimeBinding("task")), WorkItemAuthorityError);

      const delegated = createDelegated(harness, "root", "task", "delegated");
      assert.equal(delegated.kind, "delegated");
      assert.throws(() => harness.service.revise({
        ...revise,
        workItemId: delegated.id,
        idempotencyKey: "delegated-revise",
      }, runtimeBinding("task")), WorkItemAuthorityError);
      const started = harness.service.transition({
        workItemId: delegated.id,
        state: "in_progress",
        expectedRevision: delegated.revision,
        idempotencyKey: "delegated-start",
      }, runtimeBinding("task"));
      assert.equal(started.state, "in_progress");

      const cancelable = createDelegated(harness, "root", "task", "delegated-cancel");
      assert.equal(harness.service.cancel({
        workItemId: cancelable.id,
        expectedRevision: cancelable.revision,
        idempotencyKey: "creator-cancel",
      }, runtimeBinding("root")).state, "canceled");
      assert.throws(() => createDelegated(harness, "root", "root", "self-target"), WorkItemAuthorityError);
      assert.equal(task.roleBinding?.parentSessionId, "root");
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Root WorkItemはdelegated WorkItemのparentにもaggregation parentにもならず、root resultはaggregate revisionを受け取らない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#WorkItem の種別" }
  // failure_mode = "root直属の委譲をnested childとして永続化するか、root aggregationのread・decision・retry・result revisionを受理してtop-level回収とnested aggregationのfinalization契約を分岐させる"
  // scope = "WorkItemService and WorkItemStorageV6 root parent boundary"
  // lifecycle = "permanent"
  // distinction = "serviceの正規createに加えてstorage直接createと既存不正tupleへの全aggregation入口を通し、WorkItem・event・decision・idempotency・aggregate ledgerの不在を観測する"
  // @end-test-value
  it("RW-3B: rootをdelegationとaggregationのparentにせずtop-level境界を保つ", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      insertChildSession(harness, "task", root, "task-coordinator");
      const rootItem = getRootWorkItem(harness, "root");
      const activeRoot = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "root-parent-start",
      }, runtimeBinding("root"));
      const isAggregationParentInvalid = (error: unknown) => error instanceof WorkItemAggregationConflictError
        && error.code === "WORK_ITEM_AGGREGATION_PARENT_INVALID";

      assert.throws(() => reportResult(
        harness,
        rootItem.id,
        "root",
        "completed",
        activeRoot.revision,
        "root-result-with-aggregate",
        0,
      ), isAggregationParentInvalid);
      assert.equal(harness.workStorage.get(rootItem.id)?.state, "in_progress");

      assert.throws(
        () => createDelegated(harness, "root", "task", "service-root-child", rootItem.id),
        WorkItemParentError,
      );
      assert.throws(() => harness.workStorage.create({
        id: "storage-root-child",
        binding: {
          kind: "delegated",
          rootSessionId: "root",
          creatorSessionId: "root",
          targetSessionId: "task",
          parentWorkItemId: rootItem.id,
          goal: "storage root child",
          scope: "scope",
          completionCriteria: "complete",
          authority: "authority",
          sourceIdentity: SOURCE_IDENTITY,
        },
        principalSessionId: "root",
        idempotencyKey: "storage-root-child",
        requestFingerprint: "storage-root-child-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
      }), (error: unknown) => error instanceof WorkItemAggregationConflictError
        && error.code === "WORK_ITEM_PARENT_INVALID");

      const topLevel = createDelegated(harness, "root", "task", "top-level-valid");
      assert.equal(topLevel.parentWorkItemId, null);
      const activeTopLevel = harness.service.transition({
        workItemId: topLevel.id,
        state: "in_progress",
        expectedRevision: topLevel.revision,
        idempotencyKey: "top-level-valid-start",
      }, runtimeBinding("task"));
      reportResult(
        harness,
        topLevel.id,
        "task",
        "completed",
        activeTopLevel.revision,
        "top-level-valid-result",
      );
      const db = new DatabaseSync(harness.dbPath);
      try {
        db.prepare("UPDATE work_items_v6 SET parent_work_item_id = ? WHERE id = ?")
          .run(rootItem.id, topLevel.id);
      } finally {
        db.close();
      }

      assert.throws(
        () => harness.service.getAggregation({ parentWorkItemId: rootItem.id }, runtimeBinding("root")),
        isAggregationParentInvalid,
      );
      assert.throws(() => harness.service.listAggregation({
        parentWorkItemId: rootItem.id,
        afterSequence: null,
        limit: 10,
      }, runtimeBinding("root")), isAggregationParentInvalid);
      assert.throws(() => harness.service.decideAggregation({
        parentWorkItemId: rootItem.id,
        childWorkItemId: topLevel.id,
        decision: "accepted",
        expectedAggregateRevision: 0,
        idempotencyKey: "service-root-decide",
      }, runtimeBinding("root")), isAggregationParentInvalid);
      assert.throws(() => harness.service.retryAggregation({
        parentWorkItemId: rootItem.id,
        childWorkItemId: topLevel.id,
        targetSessionId: "task",
        goal: "replacement",
        scope: "scope",
        completionCriteria: "complete",
        authority: "authority",
        sourceIdentity: SOURCE_IDENTITY,
        expectedAggregateRevision: 0,
        idempotencyKey: "service-root-retry",
      }, runtimeBinding("root")), isAggregationParentInvalid);
      assert.throws(() => harness.workStorage.decideAggregation({
        parentWorkItemId: rootItem.id,
        childWorkItemId: topLevel.id,
        actorSessionId: "root",
        decision: "accepted",
        reason: null,
        expectedAggregateRevision: 0,
        idempotencyKey: "storage-root-decide",
        requestFingerprint: "storage-root-decide-fingerprint",
        decidedAt: NOW,
        expiresAt: EXPIRES,
      }), isAggregationParentInvalid);
      assert.throws(() => harness.workStorage.retryAggregation({
        parentWorkItemId: rootItem.id,
        childWorkItemId: topLevel.id,
        actorSessionId: "root",
        expectedAggregateRevision: 0,
        idempotencyKey: "storage-root-retry",
        requestFingerprint: "storage-root-retry-fingerprint",
        replacementId: "storage-root-replacement",
        replacementBinding: {
          kind: "delegated",
          rootSessionId: "root",
          creatorSessionId: "root",
          targetSessionId: "task",
          parentWorkItemId: rootItem.id,
          goal: "replacement",
          scope: "scope",
          completionCriteria: "complete",
          authority: "authority",
          sourceIdentity: SOURCE_IDENTITY,
        },
        reason: null,
        decidedAt: NOW,
        expiresAt: EXPIRES,
      }), isAggregationParentInvalid);

      assert.equal(tableCount(harness.dbPath, "work_items_v6", "id IN ('service-root-child', 'storage-root-child', 'storage-root-replacement')"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6", "work_item_id IN ('service-root-child', 'storage-root-child', 'storage-root-replacement')"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregations_v6", "parent_work_item_id = ?", rootItem.id), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregation_decisions_v6", "parent_work_item_id = ?", rootItem.id), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregation_idempotency_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_idempotency_v6", "idempotency_key IN ('service-root-child', 'storage-root-child', 'root-result-with-aggregate')"), 0);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "activeな自己所有Root WorkItemは同じroot Sessionのturn executionへ関連付けられ、別Sessionまたは別rootへの関連付けを許さない"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#実行関連付けと再開" }
  // failure_mode = "delegated通信前提のassociation判定によりroot自身のturnが拒否されるか、別ownerのexecutionへRoot WorkItemが誤帰属する"
  // scope = "WorkItemService and SessionExecutionStorageV6 association"
  // lifecycle = "permanent"
  // distinction = "service authority判定だけでなくexecutionとassociation rowの同一transaction永続化を観測する"
  // @end-test-value
  it("RW-8: 自己所有Root WorkItemをroot turn executionへ関連付ける", async () => {
    const harness = await createHarness();
    try {
      insertRootSession(harness, "root", "standalone");
      insertRootSession(harness, "other-root", "standalone");
      const rootItem = getRootWorkItem(harness, "root");
      assert.equal(harness.service.requireExecutionAssociation(rootItem.id, "root", "root").id, rootItem.id);
      assert.throws(
        () => harness.service.requireExecutionAssociation(rootItem.id, "other-root", "other-root"),
        WorkItemExecutionAssociationError,
      );

      const enqueued = harness.executionStorage.startImmediate({
        id: "execution-root",
        sessionId: "root",
        request: { turn: "continue root work" },
        idempotencyKey: "execution-root-key",
        requestFingerprint: "execution-root-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: rootItem.id,
      });
      assert.equal(enqueued.execution.sessionId, "root");
      assert.equal(harness.workStorage.getExecutionWorkItemId("execution-root"), rootItem.id);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "Root WorkItemのterminal resultはnested descendantがterminalで各aggregation decisionが確定し、parent-null top-level delegated branchがresult付きterminalへ収束した場合だけ保存される"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#確定した判断" }
  // failure_mode = "direct childだけの集約でrootをterminalにし、active nested作業、未確定decision、または結果未回収top-level branchを残したまま目的完了と誤認する"
  // scope = "WorkItemStorageV6 root terminal aggregation"
  // lifecycle = "permanent"
  // distinction = "root直下へreparentしないtop-level parent-null branchと、そのnested child decisionを段階的に確定してfailure timingを観測する"
  // @end-test-value
  it("RW-4: nested aggregationとparent-null top-level branchが確定するまでroot resultを拒否する", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      const task = insertChildSession(harness, "task", root, "task-coordinator");
      insertChildSession(harness, "executor", task, "executor");
      const rootItem = getRootWorkItem(harness, "root");
      const activeRoot = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "root-start",
      }, runtimeBinding("root"));
      const topLevelBranch = createDelegated(harness, "root", "task", "top-level-parent-null");
      const activeBranch = harness.service.transition({
        workItemId: topLevelBranch.id,
        state: "in_progress",
        expectedRevision: topLevelBranch.revision,
        idempotencyKey: "top-level-start",
      }, runtimeBinding("task"));
      const nested = createDelegated(harness, "task", "executor", "nested", topLevelBranch.id);
      const activeNested = harness.service.transition({
        workItemId: nested.id,
        state: "in_progress",
        expectedRevision: nested.revision,
        idempotencyKey: "nested-start",
      }, runtimeBinding("executor"));

      assert.throws(
        () => reportResult(harness, rootItem.id, "root", "completed", activeRoot.revision, "root-too-early"),
        WorkItemAggregationConflictError,
      );
      const terminalNested = reportResult(
        harness,
        nested.id,
        "executor",
        "completed",
        activeNested.revision,
        "nested-result",
      );
      assert.equal(terminalNested.state, "completed");
      assert.throws(
        () => reportResult(harness, topLevelBranch.id, "task", "completed", activeBranch.revision, "branch-before-decision", 1),
        WorkItemAggregationConflictError,
      );

      const aggregate = harness.service.getAggregation({ parentWorkItemId: topLevelBranch.id }, runtimeBinding("task"));
      harness.service.decideAggregation({
        parentWorkItemId: topLevelBranch.id,
        childWorkItemId: nested.id,
        decision: "accepted",
        expectedAggregateRevision: aggregate.aggregateRevision,
        idempotencyKey: "accept-nested",
      }, runtimeBinding("task"));
      const resolvedAggregate = harness.service.getAggregation({ parentWorkItemId: topLevelBranch.id }, runtimeBinding("task"));
      const terminalBranch = reportResult(
        harness,
        topLevelBranch.id,
        "task",
        "completed",
        activeBranch.revision,
        "top-level-result",
        resolvedAggregate.aggregateRevision,
      );
      assert.equal(terminalBranch.result?.summary, topLevelBranch.id + " result");
      const terminalRoot = reportResult(
        harness,
        rootItem.id,
        "root",
        "completed",
        activeRoot.revision,
        "root-result",
      );
      assert.equal(terminalRoot.state, "completed");
      assert.equal(terminalRoot.result?.reportingSessionId, "root");
      assert.throws(() => harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: terminalRoot.revision,
        idempotencyKey: "root-reopen",
      }, runtimeBinding("root")), WorkItemStateConflictError);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "root coordinatorが作成したparent-null top-level delegated WorkItemは、terminal canceledへ収束すればresultなしでもRoot finalizationを永久に阻害しない"
  // oracle = { type = "contract", ref = "docs/adr/028-session-root-work-item.md#Decision" }
  // failure_mode = "再開不能なcanceled top-levelをresultなしの未回収作業として扱い続け、Root resultが以後すべてWORK_ITEM_AGGREGATION_INCOMPLETEになる"
  // scope = "WorkItemStorageV6 root finalization for top-level cancellation"
  // lifecycle = "permanent"
  // distinction = "completed resultを持つtop-levelの既存経路ではなく、cancel APIが作るterminalかつresultなしのtupleを直接作ってRoot resultを報告する"
  // @end-test-value
  it("RW-4B: canceled top-level WorkItemをsettledとしてRoot resultを確定する", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      insertChildSession(harness, "task", root, "task-coordinator");
      const rootItem = getRootWorkItem(harness, "root");
      const activeRoot = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "root-start",
      }, runtimeBinding("root"));
      const topLevel = createDelegated(harness, "root", "task", "cancel-top-level");
      const canceled = harness.service.cancel({
        workItemId: topLevel.id,
        expectedRevision: topLevel.revision,
        idempotencyKey: "cancel-top-level",
      }, runtimeBinding("root"));
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.result, null);

      const terminalRoot = reportResult(
        harness,
        rootItem.id,
        "root",
        "completed",
        activeRoot.revision,
        "root-after-cancel",
      );
      assert.equal(terminalRoot.state, "completed");
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "invariant"
  // claim = "active root Sessionの削除は拒否し、削除可能なterminal rootはSession、WorkItem、event、execution、associationを同じtransactionで削除して失敗時は全rowをrollbackする"
  // oracle = { type = "contract", ref = "docs/adr/028-session-root-work-item.md#Decision" }
  // failure_mode = "通常turnのexecution associationがterminal Sessionを削除不能にする、または途中失敗でassociationだけ消えてRoot WorkItemとexecutionが分岐する"
  // scope = "SQLite delete trigger and SessionStorageV6 delete transaction"
  // lifecycle = "permanent"
  // distinction = "同じSessionをactive時に拒否した後terminalへ進め、Root WorkItem deleteの失敗注入前後で五表のrollbackと最終削除を直接観測する"
  // @end-test-value
  it("RW-6: active rootの削除を拒否しterminal rootとexecution associationをatomic deleteする", async () => {
    const harness = await createHarness();
    try {
      insertRootSession(harness, "root", "standalone");
      const rootItem = getRootWorkItem(harness, "root");
      assert.throws(() => harness.sessionStorage.deleteSession("root"), /WORK_ITEM_SESSION_PROTECTED/);
      assert.ok(harness.sessionStorage.getSession("root"));
      const active = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "root-start",
      }, runtimeBinding("root"));
      harness.executionStorage.startImmediate({
        id: "execution-before-terminal",
        sessionId: "root",
        request: { turn: "finish root work" },
        idempotencyKey: "execution-before-terminal-key",
        requestFingerprint: "execution-before-terminal-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: rootItem.id,
      });
      harness.executionStorage.completeRunning({
        executionId: "execution-before-terminal",
        state: "completed",
        result: { ok: true },
        errorCode: "",
        reason: "",
        completedAt: NOW,
        expiresAt: EXPIRES,
      });
      reportResult(harness, rootItem.id, "root", "completed", active.revision, "root-result");
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6", "work_item_id = ?", rootItem.id), 3);

      const db = new DatabaseSync(harness.dbPath);
      try {
        db.exec(`
          CREATE TRIGGER fail_terminal_root_work_item_delete
          BEFORE DELETE ON work_items_v6
          WHEN OLD.kind = 'root'
          BEGIN
            SELECT RAISE(ABORT, 'injected terminal root delete failure');
          END;
        `);
      } finally {
        db.close();
      }
      assert.throws(
        () => harness.sessionStorage.deleteSession("root"),
        /injected terminal root delete failure/,
      );
      assert.ok(harness.sessionStorage.getSession("root"));
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "id = ?", rootItem.id), 1);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6", "work_item_id = ?", rootItem.id), 3);
      assert.equal(tableCount(harness.dbPath, "session_executions_v6", "id = 'execution-before-terminal'"), 1);
      assert.equal(tableCount(harness.dbPath, "work_item_execution_associations_v6", "execution_id = 'execution-before-terminal'"), 1);
      const cleanup = new DatabaseSync(harness.dbPath);
      try {
        cleanup.exec("DROP TRIGGER fail_terminal_root_work_item_delete;");
      } finally {
        cleanup.close();
      }

      harness.sessionStorage.deleteSession("root");
      assert.equal(harness.sessionStorage.getSession("root"), null);
      assert.equal(tableCount(harness.dbPath, "work_items_v6", "id = ?", rootItem.id), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6", "work_item_id = ?", rootItem.id), 0);
      assert.equal(tableCount(harness.dbPath, "session_executions_v6", "id = 'execution-before-terminal'"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_execution_associations_v6", "execution_id = 'execution-before-terminal'"), 0);

      insertRootSession(harness, "canceled-root", "standalone");
      const cancelable = getRootWorkItem(harness, "canceled-root");
      const cancelInput = {
        workItemId: cancelable.id,
        expectedRevision: cancelable.revision,
        idempotencyKey: "cancel-root-work",
      };
      const canceled = harness.service.cancel(cancelInput, runtimeBinding("canceled-root"));
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.revision, 2);
      assert.equal(harness.service.cancel(cancelInput, runtimeBinding("canceled-root")).revision, 2);
      assert.deepEqual(
        harness.workStorage.listHistory({ workItemId: cancelable.id, afterSequence: null, limit: 10 })
          .map((event) => [event.revision, event.type]),
        [[1, "created"], [2, "state_transitioned"]],
      );
      harness.sessionStorage.deleteSession("canceled-root");
      assert.equal(harness.sessionStorage.getSession("canceled-root"), null);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6", "work_item_id = ?", cancelable.id), 0);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "Session tree削除は未確定nested delegated WorkItemを拒否し、aggregation decisionとroot finalization後にterminal delegated WorkItem、event、idempotency、execution association、aggregation ledgerを同じtransactionで物理削除する"
  // oracle = { type = "contract", ref = "docs/adr/028-session-root-work-item.md#Decision" }
  // failure_mode = "未確定nested resultを削除する、decision済みtreeを永久に削除不能にする、または関連ledgerだけを孤児として残す"
  // scope = "SessionStorageV6 WorkItem-aware tree deletion"
  // lifecycle = "permanent"
  // distinction = "nested delegatedをterminal化した直後の拒否、aggregation decision後のroot finalization、三階層bulk delete後の全関連表を同じfixtureで観測する"
  // @end-test-value
  it("RW-6B: decision済みnested delegatedをledgerごと削除する", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      const task = insertChildSession(harness, "task", root, "task-coordinator");
      insertChildSession(harness, "executor", task, "executor");
      const rootItem = getRootWorkItem(harness, "root");
      const activeRoot = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "root-start-delete-tree",
      }, runtimeBinding("root"));
      const branch = createDelegated(harness, "root", "task", "delete-tree-branch");
      const activeBranch = harness.service.transition({
        workItemId: branch.id,
        state: "in_progress",
        expectedRevision: branch.revision,
        idempotencyKey: "delete-tree-branch-start",
      }, runtimeBinding("task"));
      const nested = createDelegated(harness, "task", "executor", "delete-tree-nested", branch.id);
      const activeNested = harness.service.transition({
        workItemId: nested.id,
        state: "in_progress",
        expectedRevision: nested.revision,
        idempotencyKey: "delete-tree-nested-start",
      }, runtimeBinding("executor"));
      harness.executionStorage.startImmediate({
        id: "delete-tree-execution",
        sessionId: "executor",
        request: { turn: "complete nested" },
        idempotencyKey: "delete-tree-execution-key",
        requestFingerprint: "delete-tree-execution-fingerprint",
        createdAt: NOW,
        expiresAt: EXPIRES,
        workItemId: nested.id,
      });
      harness.executionStorage.completeRunning({
        executionId: "delete-tree-execution",
        state: "completed",
        result: { ok: true },
        errorCode: "",
        reason: "",
        completedAt: NOW,
        expiresAt: EXPIRES,
      });
      const terminalNested = reportResult(
        harness,
        nested.id,
        "executor",
        "completed",
        activeNested.revision,
        "delete-tree-nested-result",
      );
      assert.equal(terminalNested.state, "completed");
      assert.throws(() => harness.sessionStorage.deleteSession("executor"), /WORK_ITEM_SESSION_PROTECTED/);
      assert.ok(harness.sessionStorage.getSession("executor"));

      const aggregate = harness.service.getAggregation({ parentWorkItemId: branch.id }, runtimeBinding("task"));
      harness.service.decideAggregation({
        parentWorkItemId: branch.id,
        childWorkItemId: nested.id,
        decision: "accepted",
        expectedAggregateRevision: aggregate.aggregateRevision,
        idempotencyKey: "delete-tree-accept-nested",
      }, runtimeBinding("task"));
      const resolvedAggregate = harness.service.getAggregation({ parentWorkItemId: branch.id }, runtimeBinding("task"));
      reportResult(
        harness,
        branch.id,
        "task",
        "completed",
        activeBranch.revision,
        "delete-tree-branch-result",
        resolvedAggregate.aggregateRevision,
      );
      reportResult(harness, rootItem.id, "root", "completed", activeRoot.revision, "delete-tree-root-result");

      harness.sessionStorage.deleteSessions(["root", "task", "executor"]);
      assert.equal(tableCount(harness.dbPath, "sessions_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_items_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_idempotency_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_execution_associations_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregations_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregation_decisions_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_aggregation_idempotency_v6"), 0);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "regression"
  // claim = "parent-null delegated resultは報告だけでは回収済みにならず、root WorkItemがactiveな間はtarget Session削除をserviceとschema triggerの両方で拒否し、root terminal後だけtreeと共に削除できる"
  // oracle = { type = "adr", ref = "docs/adr/028-session-root-work-item.md#Decision" }
  // failure_mode = "top-level result報告直後のtarget Session削除が成功し、root revisionや履歴に採用証拠がないまま唯一のresultを失う"
  // scope = "SessionStorageV6 and SQLite trigger WorkItem-aware deletion"
  // lifecycle = "permanent"
  // distinction = "nested aggregationではなくparent-null delegatedを使い、active rootでのservice deleteとraw SQL delete、root terminal後のcleanupを順に観測する"
  // @end-test-value
  it("RW-6C: top-level delegated resultをroot terminalまで保護する", async () => {
    const harness = await createHarness();
    try {
      const root = insertRootSession(harness, "root", "overall-coordinator");
      insertChildSession(harness, "task", root, "executor");
      const rootItem = getRootWorkItem(harness, "root");
      const branch = createDelegated(harness, "root", "task", "top-level-result");
      const activeBranch = harness.service.transition({
        workItemId: branch.id,
        state: "in_progress",
        expectedRevision: branch.revision,
        idempotencyKey: "top-level-result-start",
      }, runtimeBinding("task"));
      const terminalBranch = reportResult(
        harness,
        branch.id,
        "task",
        "completed",
        activeBranch.revision,
        "top-level-result-report",
      );
      const rootHistoryBeforeDelete = harness.workStorage.listHistory({
        workItemId: rootItem.id,
        afterSequence: null,
        limit: 20,
      });

      assert.throws(() => harness.sessionStorage.deleteSession("task"), /WORK_ITEM_SESSION_PROTECTED/);
      const raw = new DatabaseSync(harness.dbPath);
      try {
        assert.throws(
          () => raw.prepare("DELETE FROM sessions_v6 WHERE id = 'task'").run(),
          /WORK_ITEM_SESSION_PROTECTED/,
        );
      } finally {
        raw.close();
      }
      assert.ok(harness.sessionStorage.getSession("task"));
      assert.equal(harness.workStorage.get(branch.id)?.result?.summary, terminalBranch.result?.summary);
      assert.equal(harness.workStorage.get(rootItem.id)?.revision, rootItem.revision);
      assert.deepEqual(
        harness.workStorage.listHistory({ workItemId: rootItem.id, afterSequence: null, limit: 20 }),
        rootHistoryBeforeDelete,
      );

      const activeRoot = harness.service.transition({
        workItemId: rootItem.id,
        state: "in_progress",
        expectedRevision: rootItem.revision,
        idempotencyKey: "top-level-root-start",
      }, runtimeBinding("root"));
      reportResult(
        harness,
        rootItem.id,
        "root",
        "completed",
        activeRoot.revision,
        "top-level-root-result",
      );
      const rawCleanup = new DatabaseSync(harness.dbPath);
      try {
        rawCleanup.exec(`
          PRAGMA foreign_keys = ON;
          BEGIN IMMEDIATE;
          DELETE FROM session_role_bindings_v6 WHERE session_id IN ('root', 'task');
          DELETE FROM sessions_v6 WHERE id = 'task';
          DELETE FROM sessions_v6 WHERE id = 'root';
          COMMIT;
        `);
      } catch (error) {
        if (rawCleanup.isTransaction) rawCleanup.exec("ROLLBACK;");
        throw error;
      } finally {
        rawCleanup.close();
      }
      assert.equal(tableCount(harness.dbPath, "sessions_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_items_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_events_v6"), 0);
      assert.equal(tableCount(harness.dbPath, "work_item_idempotency_v6"), 0);
    } finally {
      await closeHarness(harness);
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "v1 WorkItem migrationは通常event上限を超える旧契約上有効なsnapshotをbaseline専用上限内で保持し、二回目のrepairで増殖させず、responseを持たないlegacy idempotency replayを適用済みresponse復元不能errorへ収束させる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#Migration と repair" }
  // failure_mode = "通常eventの512 KiB制約で正規な旧snapshotのmigrationが失敗する、既存委任契約またはledgerを失う、repairでrowを重複する、または旧key再送へ後続revisionを元のcanonical responseとして返す"
  // scope = "ensureV6Schema WorkItem v1 migration and backfill"
  // lifecycle = "permanent"
  // distinction = "v1 table shapeへ通常event上限を超えるsnapshotと関連表を投入し、migrationを二回実行した後に旧fingerprint replayのerror tupleを観測する"
  // @end-test-value
  it("RW-5: v1 delegatedをbaselineから保持してroot backfillを二回実行しても収束する", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-root-work-item-migration-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
      prepareV1WorkItemDatabase(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA foreign_keys = ON;");
        ensureV6Schema(db);
        const first = migrationProjection(db);
        ensureV6Schema(db);
        const second = migrationProjection(db);
        assert.deepEqual(second, first);
        assert.deepEqual(first.delegated, {
          id: "legacy-parent",
          kind: "delegated",
          contractRevision: 2,
          rootSessionId: "legacy-root",
          creatorSessionId: "legacy-root",
          targetSessionId: "legacy-task",
          parentWorkItemId: null,
          state: "in_progress",
          revision: 3,
        });
        assert.equal(first.delegatedCount, 2);
        assert.equal(first.rootCount, 1);
        assert.deepEqual(first.events, [
          ["legacy-child", 2, "migration_baseline"],
          ["legacy-parent", 3, "migration_baseline"],
        ]);
        assert.deepEqual(first.parentBaseline, {
          kind: "delegated",
          goal: "legacy parent",
          state: "in_progress",
          creatorSessionId: "legacy-root",
          targetSessionId: "legacy-task",
          parentWorkItemId: null,
        });
        assert.equal(first.associationWorkItemId, "legacy-parent");
        assert.deepEqual(first.aggregation, { parentWorkItemId: "legacy-parent", aggregateRevision: 2 });
        assert.deepEqual(first.decision, { childWorkItemId: "legacy-child", decisionType: "accepted" });
        assert.deepEqual(first.idempotency, { operation: "work.transition", workItemId: "legacy-parent" });
        assert.deepEqual(first.aggregationIdempotency, {
          operation: "work.aggregation.decide",
          childWorkItemId: "legacy-child",
        });
        assert.equal(first.childResultSummary, "legacy child result");
        assert.deepEqual(first.childBaselineContent, {
          goal: WIDE_LEGACY_TEXT,
          workspace: WIDE_LEGACY_TEXT,
          change: WIDE_LEGACY_TEXT,
          finding: WIDE_LEGACY_TEXT,
          unverifiedItem: WIDE_LEGACY_TEXT,
          remainingWork: WIDE_LEGACY_TEXT,
        });
        assert.ok(first.childBaselineBytes > WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES);
        assert.ok(first.childBaselineBytes <= WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES);
      } finally {
        db.close();
      }
      const migratedStorage = new WorkItemStorageV6(dbPath);
      try {
        const laterRevision = migratedStorage.mutate({
          operation: "work.transition",
          workItemId: "legacy-parent",
          principalSessionId: "legacy-task",
          idempotencyKey: "later-transition",
          requestFingerprint: "later-fingerprint",
          expectedRevision: 3,
          state: "waiting",
          result: null,
          updatedAt: "2026-08-30T01:00:00.000Z",
          expiresAt: EXPIRES,
        });
        assert.equal(laterRevision.revision, 4);
        assert.throws(
          () => migratedStorage.resolveIdempotency(
            "work.transition",
            "legacy-task",
            "legacy-transition",
            "fingerprint",
            NOW,
          ),
          (error) => error instanceof WorkItemIdempotencyResponseUnavailableError
            && error.code === "IDEMPOTENCY_RESPONSE_UNAVAILABLE"
            && error.workItemId === "legacy-parent",
        );
      } finally {
        migratedStorage.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // @test-value v1
  // kind = "compatibility"
  // claim = "既存V2 databaseの旧event CHECKと512 KiB idempotency response CHECKは、rowとsequenceを保持したままbaseline専用上限とcanonical response用2 MiB境界へrepairされ、再実行しても収束する"
  // oracle = { type = "contract", ref = "docs/plans/20260830-session-root-work-item/plan.md#改訂と進捗の履歴" }
  // failure_mode = "fresh databaseだけ上限が更新され、既存利用者ではmigration baselineまたはcanonical responseが古いCHECKでrollbackし続けるか、table rebuildでeventやreplay rowを失う"
  // scope = "ensureV6Schema Work Item event and idempotency limit repair"
  // lifecycle = "permanent"
  // distinction = "現行V2のeventとidempotency tableを旧CHECKへ狭め、schema repair二回後のDDL、event sequence、ledger row保持を直接観測する"
  // @end-test-value
  it("RW-5B: 旧eventとidempotency上限をrow保持付きでrepairする", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "withmate-root-idempotency-repair-"));
    try {
      const { dbPath } = await createOrVerifyV6FreshDatabase(directory);
      const storage = new SessionStorageV6(dbPath);
      try {
        storage.insertSession(createSession({ id: "root", rootRole: "standalone" }));
      } finally {
        storage.close();
      }
      const db = new DatabaseSync(dbPath);
      try {
        const rootRow = db.prepare("SELECT id FROM work_items_v6 WHERE kind = 'root' AND root_session_id = 'root'")
          .get() as { id: string };
        db.prepare(`
          INSERT INTO work_item_idempotency_v6 (
            operation, principal_session_id, idempotency_key, request_fingerprint,
            work_item_id, response_json, created_at, expires_at
          ) VALUES ('work.revise', 'root', 'preserved-key', 'fingerprint', ?, NULL, ?, ?)
        `).run(rootRow.id, NOW, EXPIRES);
        const current = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'work_item_idempotency_v6'
        `).get() as { sql: string };
        const oldCapSql = current.sql.replace(
          `length(CAST(response_json AS BLOB)) <= ${WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES}`,
          "length(CAST(response_json AS BLOB)) <= 524288",
        );
        assert.notEqual(oldCapSql, current.sql);
        db.exec(`
          ALTER TABLE work_item_idempotency_v6 RENAME TO work_item_idempotency_v6_old_cap;
          DROP INDEX IF EXISTS idx_v6_work_item_idempotency_item;
          DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry;
          ${oldCapSql};
          CREATE INDEX idx_v6_work_item_idempotency_item ON work_item_idempotency_v6(work_item_id);
          CREATE INDEX idx_v6_work_item_idempotency_expiry ON work_item_idempotency_v6(expires_at);
          INSERT INTO work_item_idempotency_v6
          SELECT * FROM work_item_idempotency_v6_old_cap;
          DROP TABLE work_item_idempotency_v6_old_cap;
        `);
        const currentEvents = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'work_item_events_v6'
        `).get() as { sql: string };
        const baselineLimitSql = `length(CAST(payload_json AS BLOB)) <= CASE event_type
        WHEN 'migration_baseline' THEN ${WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES}
        ELSE ${WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES}
      END`;
        const oldEventCapSql = currentEvents.sql.replace(
          baselineLimitSql,
          `length(CAST(payload_json AS BLOB)) <= ${WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES}`,
        );
        assert.notEqual(oldEventCapSql, currentEvents.sql);
        db.exec(`
          ALTER TABLE work_item_events_v6 RENAME TO work_item_events_v6_old_cap;
          DROP INDEX IF EXISTS idx_v6_work_item_events_item_sequence;
          ${oldEventCapSql};
          CREATE INDEX idx_v6_work_item_events_item_sequence
            ON work_item_events_v6(work_item_id, sequence ASC);
          INSERT INTO work_item_events_v6
          SELECT * FROM work_item_events_v6_old_cap;
          DROP TABLE work_item_events_v6_old_cap;
        `);

        ensureV6Schema(db);
        ensureV6Schema(db);
        const repaired = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'work_item_idempotency_v6'
        `).get() as { sql: string };
        assert.match(
          repaired.sql,
          new RegExp(`length\\(CAST\\(response_json AS BLOB\\)\\) <= ${WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES}`),
        );
        const repairedEvents = db.prepare(`
          SELECT sql FROM sqlite_schema
          WHERE type = 'table' AND name = 'work_item_events_v6'
        `).get() as { sql: string };
        assert.match(
          repairedEvents.sql,
          new RegExp(`WHEN 'migration_baseline' THEN ${WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES}`),
        );
        const repairedEventRows = db.prepare(
          "SELECT sequence, revision, event_type AS eventType FROM work_item_events_v6 ORDER BY sequence",
        ).all() as Array<{ sequence: number; revision: number; eventType: string }>;
        assert.deepEqual(
          repairedEventRows.map((row) => ({ ...row })),
          [{ sequence: 1, revision: 1, eventType: "created" }],
        );
        const preserved = db.prepare(`
          SELECT COUNT(*) AS count
          FROM work_item_idempotency_v6
          WHERE idempotency_key = 'preserved-key'
        `).get() as { count: number };
        assert.equal(preserved.count, 1);
      } finally {
        db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function prepareV1WorkItemDatabase(dbPath: string): void {
  const storage = new SessionStorageV6(dbPath);
  try {
    const root = storage.insertSession(createSession({
      id: "legacy-root",
      title: "Legacy root goal",
      rootRole: "overall-coordinator",
    }));
    const task = storage.insertSession(createSession({
      id: "legacy-task",
      roleBinding: buildChildSessionRoleBinding("legacy-task", root.id, root.roleBinding!, "task-coordinator"),
    }));
    storage.insertSession(createSession({
      id: "legacy-executor",
      roleBinding: buildChildSessionRoleBinding("legacy-executor", task.id, task.roleBinding!, "executor"),
    }));
  } finally {
    storage.close();
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`
      DROP TRIGGER IF EXISTS trg_v6_work_items_protect_session_delete;
      DROP TRIGGER IF EXISTS trg_v6_work_items_cleanup_terminal_root_session_delete;
      DROP INDEX IF EXISTS idx_v6_work_item_aggregation_idempotency_expiry;
      DROP INDEX IF EXISTS idx_v6_work_item_aggregation_decisions_parent_sequence;
      DROP INDEX IF EXISTS idx_v6_work_item_execution_item;
      DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry;
      DROP INDEX IF EXISTS idx_v6_work_item_idempotency_item;
      DROP INDEX IF EXISTS idx_v6_work_item_events_item_sequence;
      DROP INDEX IF EXISTS idx_v6_work_items_one_root_per_session;
      DROP INDEX IF EXISTS idx_v6_work_items_parent;
      DROP INDEX IF EXISTS idx_v6_work_items_target_sequence;
      DROP INDEX IF EXISTS idx_v6_work_items_creator_sequence;
      DROP INDEX IF EXISTS idx_v6_work_items_root_sequence;
      DROP TABLE IF EXISTS work_item_aggregation_idempotency_v6;
      DROP TABLE IF EXISTS work_item_aggregation_decisions_v6;
      DROP TABLE IF EXISTS work_item_aggregations_v6;
      DROP TABLE IF EXISTS work_item_execution_associations_v6;
      DROP TABLE IF EXISTS work_item_idempotency_v6;
      DROP TABLE IF EXISTS work_item_events_v6;
      DROP TABLE IF EXISTS work_items_v6;
    `);
    db.exec(V1_WORK_ITEM_SCHEMA_SQL);
    db.prepare(`
      INSERT INTO work_items_v6 (
        id, contract_revision, root_session_id, creator_session_id, target_session_id,
        parent_work_item_id, goal, scope, completion_criteria, authority,
        source_identity_json, state, revision, result_json, created_at, updated_at
      ) VALUES (?, 1, 'legacy-root', ?, ?, ?, ?, 'scope', 'criteria', 'authority', ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-parent",
      "legacy-root",
      "legacy-task",
      null,
      "legacy parent",
      JSON.stringify(SOURCE_IDENTITY),
      "in_progress",
      3,
      null,
      NOW,
      NOW,
    );
    db.prepare(`
      INSERT INTO work_items_v6 (
        id, contract_revision, root_session_id, creator_session_id, target_session_id,
        parent_work_item_id, goal, scope, completion_criteria, authority,
        source_identity_json, state, revision, result_json, created_at, updated_at
      ) VALUES (?, 1, 'legacy-root', ?, ?, ?, ?, 'scope', 'criteria', 'authority', ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-child",
      "legacy-task",
      "legacy-executor",
      "legacy-parent",
      "legacy child",
      JSON.stringify(SOURCE_IDENTITY),
      "completed",
      2,
      JSON.stringify({
        outcome: "completed",
        summary: "legacy child result",
        changes: [],
        verificationResults: [],
        findings: [],
        unverifiedItems: [],
        remainingWork: [],
        reportingSessionId: "legacy-executor",
        reportedAt: NOW,
      }),
      NOW,
      NOW,
    );
    db.prepare(`
      UPDATE work_items_v6
      SET goal = ?, scope = ?, completion_criteria = ?, authority = ?,
        source_identity_json = ?, result_json = ?
      WHERE id = 'legacy-child'
    `).run(
      WIDE_LEGACY_TEXT,
      WIDE_LEGACY_TEXT,
      WIDE_LEGACY_TEXT,
      WIDE_LEGACY_TEXT,
      JSON.stringify({
        workspace: WIDE_LEGACY_TEXT,
        repository: WIDE_LEGACY_TEXT,
        branch: WIDE_LEGACY_TEXT,
        base: WIDE_LEGACY_TEXT,
        head: WIDE_LEGACY_TEXT,
      }),
      JSON.stringify({
        outcome: "completed",
        summary: "legacy child result",
        changes: [WIDE_LEGACY_TEXT],
        verificationResults: [],
        findings: [WIDE_LEGACY_TEXT],
        unverifiedItems: [WIDE_LEGACY_TEXT],
        remainingWork: [WIDE_LEGACY_TEXT],
        reportingSessionId: "legacy-executor",
        reportedAt: NOW,
      }),
    );
    db.prepare(`
      INSERT INTO session_executions_v6 (
        id, session_id, operation, state, request_json, result_json,
        error_code, reason, created_at, admitted_at, completed_at, updated_at
      ) VALUES ('legacy-execution', 'legacy-task', 'turn.run', 'completed', '{}', '{}', '', '', ?, ?, ?, ?)
    `).run(NOW, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO work_item_execution_associations_v6 (execution_id, work_item_id, created_at)
      VALUES ('legacy-execution', 'legacy-parent', ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO work_item_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        work_item_id, created_at, expires_at
      ) VALUES ('work.transition', 'legacy-task', 'legacy-transition', 'fingerprint', 'legacy-parent', ?, ?)
    `).run(NOW, EXPIRES);
    db.prepare(`
      INSERT INTO work_item_aggregations_v6 (parent_work_item_id, aggregate_revision, updated_at)
      VALUES ('legacy-parent', 2, ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO work_item_aggregation_decisions_v6 (
        parent_work_item_id, child_work_item_id, decision_revision, child_revision,
        actor_session_id, decision_type, reason, replacement_work_item_id, decided_at
      ) VALUES ('legacy-parent', 'legacy-child', 2, 2, 'legacy-task', 'accepted', NULL, NULL, ?)
    `).run(NOW);
    db.prepare(`
      INSERT INTO work_item_aggregation_idempotency_v6 (
        operation, principal_session_id, idempotency_key, request_fingerprint,
        child_work_item_id, replacement_work_item_id, created_at, expires_at
      ) VALUES ('work.aggregation.decide', 'legacy-task', 'legacy-decision', 'fingerprint', 'legacy-child', NULL, ?, ?)
    `).run(NOW, EXPIRES);
    db.exec("PRAGMA foreign_keys = ON;");
  } finally {
    db.close();
  }
}

function migrationProjection(db: DatabaseSync) {
  const delegated = db.prepare(`
    SELECT id, kind, contract_revision AS contractRevision, root_session_id AS rootSessionId,
      creator_session_id AS creatorSessionId, target_session_id AS targetSessionId,
      parent_work_item_id AS parentWorkItemId, state, revision
    FROM work_items_v6 WHERE id = 'legacy-parent'
  `).get() as Record<string, unknown>;
  const events = (db.prepare(`
    SELECT work_item_id AS workItemId, revision, event_type AS eventType
    FROM work_item_events_v6
    WHERE work_item_id IN ('legacy-parent', 'legacy-child')
    ORDER BY work_item_id
  `).all() as Array<{ workItemId: string; revision: number; eventType: string }>)
    .map((row) => [row.workItemId, row.revision, row.eventType]);
  const association = db.prepare(`
    SELECT work_item_id AS workItemId
    FROM work_item_execution_associations_v6 WHERE execution_id = 'legacy-execution'
  `).get() as { workItemId: string };
  const aggregation = db.prepare(`
    SELECT parent_work_item_id AS parentWorkItemId, aggregate_revision AS aggregateRevision
    FROM work_item_aggregations_v6 WHERE parent_work_item_id = 'legacy-parent'
  `).get() as Record<string, unknown>;
  const decision = db.prepare(`
    SELECT child_work_item_id AS childWorkItemId, decision_type AS decisionType
    FROM work_item_aggregation_decisions_v6 WHERE child_work_item_id = 'legacy-child'
  `).get() as Record<string, unknown>;
  const idempotency = db.prepare(`
    SELECT operation, work_item_id AS workItemId
    FROM work_item_idempotency_v6 WHERE idempotency_key = 'legacy-transition'
  `).get() as Record<string, unknown>;
  const aggregationIdempotency = db.prepare(`
    SELECT operation, child_work_item_id AS childWorkItemId
    FROM work_item_aggregation_idempotency_v6 WHERE idempotency_key = 'legacy-decision'
  `).get() as Record<string, unknown>;
  const result = db.prepare(`
    SELECT json_extract(result_json, '$.summary') AS summary
    FROM work_items_v6 WHERE id = 'legacy-child'
  `).get() as { summary: string };
  const childBaseline = db.prepare(`
    SELECT
      length(CAST(payload_json AS BLOB)) AS payloadBytes,
      json_extract(payload_json, '$.contract.goal') AS goal,
      json_extract(payload_json, '$.sourceIdentity.workspace') AS workspace,
      json_extract(payload_json, '$.result.changes[0]') AS change,
      json_extract(payload_json, '$.result.findings[0]') AS finding,
      json_extract(payload_json, '$.result.unverifiedItems[0]') AS unverifiedItem,
      json_extract(payload_json, '$.result.remainingWork[0]') AS remainingWork
    FROM work_item_events_v6
    WHERE work_item_id = 'legacy-child' AND event_type = 'migration_baseline'
  `).get() as {
    payloadBytes: number;
    goal: string;
    workspace: string;
    change: string;
    finding: string;
    unverifiedItem: string;
    remainingWork: string;
  };
  const parentBaseline = db.prepare(`
    SELECT
      json_extract(payload_json, '$.kind') AS kind,
      json_extract(payload_json, '$.contract.goal') AS goal,
      json_extract(payload_json, '$.state') AS state,
      json_extract(payload_json, '$.creatorSessionId') AS creatorSessionId,
      json_extract(payload_json, '$.targetSessionId') AS targetSessionId,
      json_extract(payload_json, '$.parentWorkItemId') AS parentWorkItemId
    FROM work_item_events_v6
    WHERE work_item_id = 'legacy-parent' AND event_type = 'migration_baseline'
  `).get() as Record<string, unknown>;
  return {
    delegated: { ...delegated },
    delegatedCount: Number((db.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE kind = 'delegated'").get() as { count: number }).count),
    rootCount: Number((db.prepare("SELECT COUNT(*) AS count FROM work_items_v6 WHERE kind = 'root'").get() as { count: number }).count),
    events,
    parentBaseline: { ...parentBaseline },
    associationWorkItemId: association.workItemId,
    aggregation: { ...aggregation },
    decision: { ...decision },
    idempotency: { ...idempotency },
    aggregationIdempotency: { ...aggregationIdempotency },
    childResultSummary: result.summary,
    childBaselineContent: {
      goal: childBaseline.goal,
      workspace: childBaseline.workspace,
      change: childBaseline.change,
      finding: childBaseline.finding,
      unverifiedItem: childBaseline.unverifiedItem,
      remainingWork: childBaseline.remainingWork,
    },
    childBaselineBytes: childBaseline.payloadBytes,
  };
}

const V1_WORK_ITEM_SCHEMA_SQL = `
  CREATE TABLE work_items_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    contract_revision INTEGER NOT NULL CHECK (contract_revision = 1),
    root_session_id TEXT NOT NULL,
    creator_session_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    parent_work_item_id TEXT,
    goal TEXT NOT NULL,
    scope TEXT NOT NULL,
    completion_criteria TEXT NOT NULL,
    authority TEXT NOT NULL,
    source_identity_json TEXT NOT NULL CHECK (json_valid(source_identity_json)),
    state TEXT NOT NULL CHECK (state IN (
      'pending', 'in_progress', 'waiting', 'completed',
      'partially_completed', 'failed', 'canceled'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id),
    CHECK (creator_session_id <> target_session_id),
    CHECK (
      (state IN ('completed', 'partially_completed', 'failed') AND result_json IS NOT NULL)
      OR (state NOT IN ('completed', 'partially_completed', 'failed') AND result_json IS NULL)
    )
  );
  CREATE INDEX idx_v6_work_items_root_sequence ON work_items_v6(root_session_id, sequence ASC);
  CREATE INDEX idx_v6_work_items_creator_sequence ON work_items_v6(creator_session_id, sequence ASC);
  CREATE INDEX idx_v6_work_items_target_sequence ON work_items_v6(target_session_id, sequence ASC);
  CREATE INDEX idx_v6_work_items_parent ON work_items_v6(parent_work_item_id);

  CREATE TABLE work_item_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('work.create', 'work.transition', 'work.result', 'work.cancel')),
    principal_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, principal_session_id, idempotency_key),
    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_v6_work_item_idempotency_item ON work_item_idempotency_v6(work_item_id);
  CREATE INDEX idx_v6_work_item_idempotency_expiry ON work_item_idempotency_v6(expires_at);

  CREATE TABLE work_item_execution_associations_v6 (
    execution_id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id)
  );
  CREATE INDEX idx_v6_work_item_execution_item ON work_item_execution_associations_v6(work_item_id, execution_id);

  CREATE TABLE work_item_aggregations_v6 (
    parent_work_item_id TEXT PRIMARY KEY,
    aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 1),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id)
  );

  CREATE TABLE work_item_aggregation_decisions_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_work_item_id TEXT NOT NULL,
    child_work_item_id TEXT NOT NULL UNIQUE,
    decision_revision INTEGER NOT NULL CHECK (decision_revision >= 1),
    child_revision INTEGER NOT NULL CHECK (child_revision >= 1),
    actor_session_id TEXT NOT NULL,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('accepted', 'excluded', 'retry_requested')),
    reason TEXT,
    replacement_work_item_id TEXT UNIQUE,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (child_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (replacement_work_item_id) REFERENCES work_items_v6(id)
  );
  CREATE INDEX idx_v6_work_item_aggregation_decisions_parent_sequence
    ON work_item_aggregation_decisions_v6(parent_work_item_id, sequence ASC);

  CREATE TABLE work_item_aggregation_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('work.aggregation.decide', 'work.aggregation.retry')),
    principal_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    child_work_item_id TEXT NOT NULL,
    replacement_work_item_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, principal_session_id, idempotency_key),
    FOREIGN KEY (child_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (replacement_work_item_id) REFERENCES work_items_v6(id)
  );
  CREATE INDEX idx_v6_work_item_aggregation_idempotency_expiry
    ON work_item_aggregation_idempotency_v6(expires_at);
`;
