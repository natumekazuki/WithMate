import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  RESOURCE_BUDGET_CONTRACT_REVISION,
  RESOURCE_BUDGET_DEFAULT_DURATION_MS,
  RESOURCE_BUDGET_DEFAULT_HARD_LIMITS,
  RESOURCE_BUDGET_DIMENSIONS,
  RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT,
  resourceBudgetConfigureFingerprint,
  type ResourceBudget,
  type ResourceBudgetAccountKind,
  type ResourceBudgetAmounts,
  type ResourceBudgetConfigureInput,
  type ResourceBudgetDimension,
  type ResourceBudgetListResult,
  type ResourceBudgetMeteredUsage,
  type ResourceBudgetPartialAmounts,
  type ResourceBudgetUsageConfidence,
} from "../src/resource-budget.js";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import { assertGrantProofCurrent } from "./session-authority-storage.js";
import { openAppDatabase } from "./sqlite-connection.js";

type AccountRow = {
  account_id: string;
  account_kind: ResourceBudgetAccountKind;
  root_session_id: string;
  owner_session_id: string;
  parent_account_id: string | null;
  authority_grant_id: string | null;
  authority_grant_revision: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  deadline_at: string;
  retry_per_execution_limit: number;
  revision: number;
  created_at: string;
  updated_at: string;
};

type DimensionRow = {
  dimension: ResourceBudgetDimension;
  hard_limit: number;
  soft_limit: number | null;
  committed: number;
  reserved: number;
  measurement_status: "known" | "unknown";
  unknown_since: string | null;
};

export type ResourceBudgetReservationKind =
  | "queued_turn"
  | "running_turn"
  | "storage"
  | "resource";

export type ResourceBudgetReservation = Readonly<{
  reservationId: string;
  accountId: string;
  dimension: ResourceBudgetDimension;
  amount: number;
  consumed: number;
  state: "reserved" | "consumed" | "released" | "reconciliation_required";
  kind: ResourceBudgetReservationKind;
  executionId: string | null;
  providerGenerationId: string | null;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}>;

export class ResourceBudgetError extends Error {
  constructor(
    readonly code:
      | "BUDGET_NOT_FOUND"
      | "BUDGET_REVISION_CONFLICT"
      | "BUDGET_HARD_LIMIT_EXCEEDED"
      | "BUDGET_DEADLINE_EXCEEDED"
      | "BUDGET_AUTHORITY_REQUIRED"
      | "BUDGET_IDEMPOTENCY_CONFLICT"
      | "BUDGET_RESERVATION_NOT_FOUND"
      | "BUDGET_SETTLEMENT_CONFLICT"
      | "BUDGET_LEDGER_INVALID"
      | "BUDGET_STORAGE_UNKNOWN",
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "ResourceBudgetError";
  }
}

export function ensureResourceBudgetSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_budget_accounts_v6 (
      account_id TEXT PRIMARY KEY,
      account_kind TEXT NOT NULL CHECK (account_kind IN ('root', 'session')),
      root_session_id TEXT NOT NULL,
      owner_session_id TEXT NOT NULL,
      parent_account_id TEXT,
      authority_grant_id TEXT,
      authority_grant_revision INTEGER,
      expires_at TEXT,
      revoked_at TEXT,
      deadline_at TEXT NOT NULL,
      retry_per_execution_limit INTEGER NOT NULL CHECK (retry_per_execution_limit >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((authority_grant_id IS NULL) = (authority_grant_revision IS NULL)),
      CHECK ((account_kind = 'root') = (parent_account_id IS NULL)),
      FOREIGN KEY (owner_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
      FOREIGN KEY (root_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_account_id) REFERENCES resource_budget_accounts_v6(account_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS resource_budget_accounts_owner_v6
      ON resource_budget_accounts_v6(owner_session_id, account_kind);
    CREATE INDEX IF NOT EXISTS resource_budget_accounts_root_v6
      ON resource_budget_accounts_v6(root_session_id, account_id);

    CREATE TABLE IF NOT EXISTS resource_budget_dimensions_v6 (
      account_id TEXT NOT NULL,
      dimension TEXT NOT NULL CHECK (dimension IN (
        'concurrentTurns', 'queuedTurns', 'totalTurns', 'retries',
        'sessions', 'workItems', 'delegations', 'storageBytes'
      )),
      hard_limit INTEGER NOT NULL CHECK (hard_limit >= 0),
      soft_limit INTEGER CHECK (soft_limit IS NULL OR soft_limit >= 0),
      committed INTEGER NOT NULL CHECK (committed >= 0),
      reserved INTEGER NOT NULL CHECK (reserved >= 0),
      measurement_status TEXT NOT NULL DEFAULT 'known' CHECK (measurement_status IN ('known', 'unknown')),
      unknown_since TEXT,
      CHECK ((measurement_status = 'unknown') = (unknown_since IS NOT NULL)),
      PRIMARY KEY (account_id, dimension),
      FOREIGN KEY (account_id) REFERENCES resource_budget_accounts_v6(account_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS resource_budget_reservations_v6 (
      reservation_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      dimension TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed >= 0 AND consumed <= amount),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released', 'reconciliation_required')),
      reservation_kind TEXT NOT NULL CHECK (reservation_kind IN (
        'queued_turn', 'running_turn', 'storage', 'resource'
      )),
      execution_id TEXT,
      provider_generation_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (account_id, reservation_kind, idempotency_key),
      FOREIGN KEY (account_id, dimension) REFERENCES resource_budget_dimensions_v6(account_id, dimension) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS resource_budget_reservations_execution_v6
      ON resource_budget_reservations_v6(execution_id, state);

    CREATE TABLE IF NOT EXISTS resource_budget_metered_usage_v6 (
      usage_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      execution_id TEXT,
      provider_generation_id TEXT,
      reservation_id TEXT,
      usage_unit TEXT NOT NULL CHECK (usage_unit IN ('tokens', 'monetary_cost', 'provider_usage')),
      amount REAL,
      currency TEXT,
      confidence TEXT NOT NULL CHECK (confidence IN ('unknown', 'estimated', 'reported', 'settled')),
      idempotency_key TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      UNIQUE (account_id, usage_unit, idempotency_key),
      CHECK ((confidence = 'unknown') = (amount IS NULL)),
      CHECK (amount IS NULL OR amount >= 0),
      CHECK ((usage_unit = 'monetary_cost') OR currency IS NULL),
      FOREIGN KEY (account_id) REFERENCES resource_budget_accounts_v6(account_id) ON DELETE CASCADE,
      FOREIGN KEY (reservation_id) REFERENCES resource_budget_reservations_v6(reservation_id) ON DELETE SET NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS resource_budget_events_v6 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      account_revision INTEGER NOT NULL CHECK (account_revision > 0),
      event_kind TEXT NOT NULL CHECK (event_kind IN (
        'migration_baseline', 'configured', 'child_allocated', 'reserved',
        'consumed', 'released', 'reconciliation_required', 'usage_observed', 'measurement_changed'
      )),
      dimension TEXT,
      committed_delta INTEGER NOT NULL DEFAULT 0,
      reserved_delta INTEGER NOT NULL DEFAULT 0,
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent', 'system')),
      actor_session_id TEXT,
      grant_id TEXT,
      grant_revision INTEGER,
      operation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      projection_json TEXT NOT NULL CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'),
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES resource_budget_accounts_v6(account_id) ON DELETE CASCADE,
      CHECK ((grant_id IS NULL) = (grant_revision IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS resource_budget_events_account_v6
      ON resource_budget_events_v6(account_id, sequence);
    CREATE TRIGGER IF NOT EXISTS resource_budget_events_no_update_v6
    BEFORE UPDATE ON resource_budget_events_v6 BEGIN
      SELECT RAISE(ABORT, 'resource budget events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS resource_budget_events_no_delete_v6
    BEFORE DELETE ON resource_budget_events_v6 BEGIN
      SELECT RAISE(ABORT, 'resource budget events are append-only');
    END;

    CREATE TABLE IF NOT EXISTS resource_budget_idempotency_v6 (
      operation TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      account_id TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation, principal_key, idempotency_key)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS resource_budget_migration_markers_v6 (
      root_session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      baseline_json TEXT NOT NULL CHECK (json_valid(baseline_json)),
      migrated_at TEXT NOT NULL
    ) STRICT;
  `);
}

export function backfillResourceBudgets(db: DatabaseSync, migratedAt: string): void {
  ensureResourceBudgetSchema(db);
  const roots = db.prepare(`
    SELECT binding.root_session_id, session.created_at
    FROM session_role_bindings_v6 AS binding
    INNER JOIN sessions_v6 AS session ON session.id = binding.session_id
    WHERE binding.session_id = binding.root_session_id
    ORDER BY binding.root_session_id
  `).all() as Array<{ root_session_id: string; created_at: string }>;
  for (const root of roots) {
    withSavepoint(db, () => backfillRoot(db, root.root_session_id, root.created_at, migratedAt));
  }
}

export function verifyResourceBudgetLedger(db: DatabaseSync): void {
  ensureResourceBudgetSchema(db);
  const missingDimensions = db.prepare(`
    SELECT account.account_id, COUNT(dimension.dimension) AS count
    FROM resource_budget_accounts_v6 AS account
    LEFT JOIN resource_budget_dimensions_v6 AS dimension ON dimension.account_id = account.account_id
    GROUP BY account.account_id HAVING count <> ?
  `).all(RESOURCE_BUDGET_DIMENSIONS.length) as Array<{ account_id: string }>;
  if (missingDimensions.length > 0) invalidLedger("A budget account does not contain every dimension.", missingDimensions[0].account_id);
  const invalidChildStorage = db.prepare(`SELECT account.account_id FROM resource_budget_accounts_v6 AS account
    INNER JOIN resource_budget_dimensions_v6 AS dimension ON dimension.account_id = account.account_id
    WHERE account.account_kind = 'session' AND dimension.dimension = 'storageBytes' AND dimension.hard_limit <> 0
    LIMIT 1`).get() as { account_id: string } | undefined;
  if (invalidChildStorage) invalidLedger("A child account cannot allocate root-managed storage.", invalidChildStorage.account_id);

  const invalidProjection = db.prepare(`
    SELECT dimension.account_id, dimension.dimension,
      dimension.committed, dimension.reserved,
      COALESCE(SUM(event.committed_delta), 0) AS event_committed,
      COALESCE(SUM(event.reserved_delta), 0) AS event_reserved
    FROM resource_budget_dimensions_v6 AS dimension
    LEFT JOIN resource_budget_events_v6 AS event
      ON event.account_id = dimension.account_id AND event.dimension = dimension.dimension
    GROUP BY dimension.account_id, dimension.dimension
    HAVING dimension.committed <> event_committed OR dimension.reserved <> event_reserved
    LIMIT 1
  `).get() as { account_id: string; dimension: string } | undefined;
  if (invalidProjection) invalidLedger(`Budget event projection differs for ${invalidProjection.dimension}.`, invalidProjection.account_id);

  const missingHeader = db.prepare(`SELECT event.event_id FROM resource_budget_events_v6 AS event
    LEFT JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
    WHERE header.event_id IS NULL OR header.resource_kind <> 'budget' OR header.resource_id <> event.account_id
    LIMIT 1`).get() as { event_id: string } | undefined;
  if (missingHeader) invalidLedger("A budget event header is missing or inconsistent.", missingHeader.event_id);

  verifyBudgetRowProjections(db);
  const inconsistentHeader = db.prepare(`SELECT event.event_id FROM resource_budget_events_v6 AS event
    INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = event.account_id
    INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
    WHERE (header.root_id <> account.root_session_id AND NOT EXISTS (
        SELECT 1 FROM resource_budget_events_v6 AS transfer
        WHERE transfer.account_id = event.account_id
          AND transfer.event_kind = 'configured'
          AND json_extract(transfer.payload_json, '$.transfer') = 1
          AND event.account_revision < transfer.account_revision
          AND header.root_id = json_extract(transfer.payload_json, '$.previousRootSessionId')
      )) OR header.owner_id <> account.owner_session_id
      OR header.event_kind <> event.event_kind OR header.resource_revision <> event.account_revision
      OR header.principal_kind <> event.principal_kind
      OR COALESCE(header.actor_session_id, '') <> COALESCE(event.actor_session_id, '')
      OR COALESCE(header.grant_id, '') <> COALESCE(event.grant_id, '')
      OR COALESCE(header.grant_revision, 0) <> COALESCE(event.grant_revision, 0)
      OR header.operation_id <> event.operation_id LIMIT 1`).get() as { event_id: string } | undefined;
  if (inconsistentHeader) invalidLedger("A budget event header differs from its typed event.", inconsistentHeader.event_id);

  const missingMigration = db.prepare(`
    SELECT binding.root_session_id
    FROM session_role_bindings_v6 AS binding
    LEFT JOIN resource_budget_migration_markers_v6 AS marker ON marker.root_session_id = binding.root_session_id
    WHERE binding.session_id = binding.root_session_id AND marker.root_session_id IS NULL
    LIMIT 1
  `).get() as { root_session_id: string } | undefined;
  if (missingMigration) invalidLedger("A root budget migration marker is missing.", missingMigration.root_session_id);
}

export class ResourceBudgetStorage {
  private readonly db: DatabaseSync;
  private readonly ownsConnection: boolean;

  constructor(database: string | DatabaseSync) {
    this.ownsConnection = typeof database === "string";
    this.db = typeof database === "string" ? openAppDatabase(database) : database;
    ensureResourceBudgetSchema(this.db);
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  bootstrapRootBudget(input: { rootSessionId: string; rootCreatedAt: string; createdAt: string }): ResourceBudget {
    withSavepoint(this.db, () => backfillRoot(this.db, input.rootSessionId, input.rootCreatedAt, input.createdAt));
    return this.getByAccountId(input.rootSessionId);
  }

  get(sessionId: string): ResourceBudget {
    const row = this.resolveAccount(sessionId);
    return this.decode(row, sessionId, row.owner_session_id === sessionId ? "owned" : "root_shared");
  }

  getByAccountId(accountId: string): ResourceBudget {
    return this.decode(this.requireAccount(accountId));
  }

  /** Reparents an existing Session allocation while preserving its ledger identity. */
  transferSessionAllocation(input: {
    sessionId: string;
    destinationRootSessionId: string;
    destinationParentAccountId: string;
    destinationAuthorityGrantId: string | null;
    destinationAuthorityGrantRevision: number | null;
    proof: MutationAuthorityProof;
    destinationProof?: MutationAuthorityProof;
    operationId: string;
    transferredAt: string;
  }): ResourceBudget {
    return withSavepoint(this.db, () => {
      assertGrantProofCurrent(this.db, input.proof, new Date(input.transferredAt));
      if (input.destinationProof) assertGrantProofCurrent(this.db, input.destinationProof, new Date(input.transferredAt));
      const account = this.db.prepare(`SELECT * FROM resource_budget_accounts_v6
        WHERE owner_session_id = ? AND account_kind = 'session'`).get(input.sessionId) as AccountRow | undefined;
      if (!account) throw budgetNotFound(input.sessionId);
      const parent = this.requireAccount(input.destinationParentAccountId);
      const destinationRoot = this.requireAccount(input.destinationRootSessionId);
      if (destinationRoot.account_kind !== "root" || parent.root_session_id !== input.destinationRootSessionId
        || (input.destinationProof && input.destinationProof.principal.kind === "agent"
          && input.destinationProof.grantId !== input.destinationAuthorityGrantId)) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The destination budget authority is invalid.");
      }
      if (account.account_id === parent.account_id || parent.account_id === account.parent_account_id) {
        throw new ResourceBudgetError("BUDGET_SETTLEMENT_CONFLICT", "The budget allocation would create a cycle.");
      }
      if (account.root_session_id !== input.destinationRootSessionId && !input.destinationProof) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Cross-root allocation transfer requires destination authority.");
      }
      if (account.root_session_id !== input.destinationRootSessionId
        && (input.destinationAuthorityGrantId === null || input.destinationAuthorityGrantRevision === null)) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Cross-root allocation transfer requires a destination grant.");
      }
      assertAllocationActive(this.db, parent, input.transferredAt);
      assertDeadlineOpen(this.db, parent, input.transferredAt);
      const dimensions = this.readDimensionRows(account.account_id);
      for (const row of dimensions) {
        assertChildResizeCapacity(this.db, parent.account_id, account.account_id,
          row.dimension, row.hard_limit, input.transferredAt);
      }
      const nextRevision = account.revision + 1;
      this.db.prepare(`UPDATE resource_budget_accounts_v6
        SET root_session_id = ?, parent_account_id = ?, authority_grant_id = ?,
            authority_grant_revision = ?, revision = ?, updated_at = ?
        WHERE account_id = ? AND revision = ?`).run(
        input.destinationRootSessionId, parent.account_id,
        input.destinationAuthorityGrantId ?? account.authority_grant_id,
        input.destinationAuthorityGrantRevision ?? account.authority_grant_revision,
        nextRevision, input.transferredAt, account.account_id, account.revision,
      );
      appendEvent(this.db, {
        accountId: account.account_id,
        revision: nextRevision,
        eventKind: "configured",
        proof: input.destinationProof ?? input.proof,
        operationId: input.operationId,
        occurredAt: input.transferredAt,
        payload: {
          transfer: true,
          previousRootSessionId: account.root_session_id,
          previousParentAccountId: account.parent_account_id,
          destinationRootSessionId: input.destinationRootSessionId,
          destinationParentAccountId: parent.account_id,
          previousAuthorityGrantId: account.authority_grant_id,
          destinationAuthorityGrantId: input.destinationAuthorityGrantId,
        },
      });
      return this.getByAccountId(account.account_id);
    });
  }

  list(rootSessionId: string, limit: number, cursor?: string): ResourceBudgetListResult {
    const rows = this.db.prepare(`
      SELECT * FROM resource_budget_accounts_v6
      WHERE root_session_id = ? AND account_id > ?
      ORDER BY account_id LIMIT ?
    `).all(rootSessionId, cursor ?? "", limit + 1) as AccountRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: selected.map((row) => this.decode(row)),
      ...(hasMore ? { nextCursor: selected[selected.length - 1].account_id } : {}),
    };
  }

  listVisible(actorSessionId: string, rootSessionId: string, limit: number, cursor?: string): ResourceBudgetListResult {
    const actor = this.db.prepare(`SELECT root_session_id, delegation_depth FROM session_role_bindings_v6 WHERE session_id = ?`)
      .get(actorSessionId) as { root_session_id: string; delegation_depth: number } | undefined;
    if (!actor || actor.root_session_id !== rootSessionId) throw budgetNotFound(actorSessionId);
    const rows = this.db.prepare(`
      SELECT account.* FROM resource_budget_accounts_v6 AS account
      INNER JOIN session_role_bindings_v6 AS owner ON owner.session_id = account.owner_session_id
      WHERE account.root_session_id = ? AND account.account_id > ? AND (
        ? = 0 OR account.account_id = ? OR account.owner_session_id = ?
        OR owner.parent_session_id = ?
      )
      ORDER BY account.account_id LIMIT ?
    `).all(rootSessionId, cursor ?? "", actor.delegation_depth, rootSessionId,
      actorSessionId, actorSessionId, limit + 1) as AccountRow[];
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    return { items: selected.map((row) => this.decode(row)),
      ...(hasMore ? { nextCursor: selected[selected.length - 1].account_id } : {}) };
  }

  configure(input: ResourceBudgetConfigureInput, proof: MutationAuthorityProof, changedAt: string): ResourceBudget {
    return withSavepoint(this.db, () => {
      const principalKey = mutationPrincipalKey(proof);
      const fingerprint = resourceBudgetConfigureFingerprint(input);
      const replay = this.findIdempotency("budget.configure", principalKey, input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) throw idempotencyConflict(input.idempotencyKey);
        return JSON.parse(replay.response_json) as ResourceBudget;
      }
      assertGrantProofCurrent(this.db, proof, new Date(changedAt));
      const account = this.requireAccount(input.accountId);
      if (account.revision !== input.expectedRevision) {
        throw new ResourceBudgetError("BUDGET_REVISION_CONFLICT", "The resource budget revision changed.", {
          expectedRevision: input.expectedRevision,
          actualRevision: account.revision,
        });
      }
      assertConfigureScope(this.db, account, input.sessionId, proof);
      if (input.childAllocation) {
        const binding = this.db.prepare(`SELECT root_session_id, parent_session_id FROM session_role_bindings_v6 WHERE session_id = ?`)
          .get(input.childAllocation.childSessionId) as { root_session_id: string; parent_session_id: string | null } | undefined;
        if (!binding || binding.root_session_id !== account.root_session_id || binding.parent_session_id !== input.sessionId) {
          throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The allocation target must be a direct child Session.");
        }
        const result = this.allocateChild({
          accountId: input.childAllocation.accountId,
          accountKind: "session",
          rootSessionId: account.root_session_id,
          ownerSessionId: input.childAllocation.childSessionId,
          parentAccountId: account.account_id,
          hardLimits: input.childAllocation.hardLimits,
          softLimits: input.childAllocation.softLimits,
          authorityGrantId: proof.grantId,
          authorityGrantRevision: proof.grantRevision,
          expiresAt: input.childAllocation.expiresAt ?? null,
          deadlineAt: account.deadline_at,
          idempotencyKey: input.idempotencyKey,
          proof,
          createdAt: changedAt,
        });
        this.insertIdempotency("budget.configure", principalKey, input.idempotencyKey, fingerprint,
          result.accountId, result, changedAt);
        return result;
      }
      const current = this.readDimensionRows(account.account_id);
      if (account.account_kind === "session" && input.hardLimits?.storageBytes !== undefined
        && input.hardLimits.storageBytes !== 0) {
        throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "Storage is configured on the root budget.", {
          dimension: "storageBytes",
        });
      }
      if (account.account_kind === "session" && input.softLimits?.storageBytes !== undefined
        && input.softLimits.storageBytes !== null) {
        throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "Storage soft limits are configured on the root budget.", {
          dimension: "storageBytes",
        });
      }
      const nextHardLimits = Object.fromEntries(current.map((row) => [row.dimension, row.hard_limit])) as Record<ResourceBudgetDimension, number>;
      for (const [dimension, value] of dimensionEntries(input.hardLimits)) {
        if (account.account_kind === "root" && value > nextHardLimits[dimension] && proof.principal.kind !== "user") {
          throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Increasing a root hard limit requires trusted user authority.", { dimension });
        }
        if (account.account_kind === "session" && value > nextHardLimits[dimension]) {
          const parent = account.parent_account_id ? this.requireAccount(account.parent_account_id) : null;
          const isParent = proof.principal.kind === "agent" && parent?.owner_session_id === proof.principal.actorSessionId;
          if (proof.principal.kind !== "user" && !isParent) {
            throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Only the parent account owner can increase a child allocation.", { dimension });
          }
        }
        nextHardLimits[dimension] = value;
      }
      assertHardLimitsFit(this.db, account.account_id, nextHardLimits, input.revoked === true, changedAt);
      if (account.account_kind === "session" && input.deadlineAt !== undefined) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The operation deadline is configured on the root budget.");
      }
      if (input.deadlineAt !== undefined && input.deadlineAt > account.deadline_at
        && !(proof.principal.kind === "user" || (proof.principal.kind === "system" && proof.principal.service === "session-lifecycle"))) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Extending a root deadline requires trusted user authority.");
      }
      if (input.expiresAt !== undefined
        && (account.expires_at === null || input.expiresAt === null || input.expiresAt > account.expires_at)
        && !(proof.principal.kind === "user" || (proof.principal.kind === "system" && proof.principal.service === "session-lifecycle"))) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Extending an allocation expiry requires trusted user authority.");
      }
      if (input.revoked === false && account.revoked_at !== null && proof.principal.kind !== "user") {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Restoring a revoked budget requires trusted user authority.");
      }
      if (input.retryPerExecutionLimit !== undefined
        && input.retryPerExecutionLimit > account.retry_per_execution_limit
        && proof.principal.kind !== "user") {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Increasing the per-execution retry limit requires trusted user authority.");
      }
      if (account.account_kind === "session" && input.retryPerExecutionLimit !== undefined) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The per-execution retry limit is configured on the root budget.");
      }
      const revokedAt = input.revoked === undefined ? account.revoked_at : input.revoked ? changedAt : null;
      const expiresAt = input.expiresAt === undefined ? account.expires_at : input.expiresAt;
      const nextAccount = { ...account, revoked_at: revokedAt, expires_at: expiresAt };
      if (account.account_kind === "session" && account.parent_account_id
        && isAccountChainActive(this.db, nextAccount, changedAt)) {
        for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
          assertChildResizeCapacity(this.db, account.parent_account_id, account.account_id,
            dimension, nextHardLimits[dimension], changedAt);
        }
      }
      for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
        const hardLimit = nextHardLimits[dimension];
        const softLimit = input.softLimits?.[dimension] === undefined
          ? current.find((row) => row.dimension === dimension)!.soft_limit
          : input.softLimits[dimension];
        if (softLimit !== null && softLimit > hardLimit) {
          throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "A soft limit cannot exceed its hard limit.", { dimension });
        }
        this.db.prepare(`UPDATE resource_budget_dimensions_v6 SET hard_limit = ?, soft_limit = ? WHERE account_id = ? AND dimension = ?`)
          .run(hardLimit, softLimit, account.account_id, dimension);
      }
      const revision = account.revision + 1;
      this.db.prepare(`
        UPDATE resource_budget_accounts_v6
        SET deadline_at = ?, expires_at = ?, revoked_at = ?, retry_per_execution_limit = ?, revision = ?, updated_at = ?
        WHERE account_id = ?
      `).run(
        input.deadlineAt ?? account.deadline_at,
        input.expiresAt === undefined ? account.expires_at : input.expiresAt,
        revokedAt,
        input.retryPerExecutionLimit ?? account.retry_per_execution_limit,
        revision,
        changedAt,
        account.account_id,
      );
      appendEvent(this.db, {
        accountId: account.account_id,
        revision,
        eventKind: "configured",
        proof,
        operationId: `budget.configure:${principalKey}:${input.idempotencyKey}`,
        occurredAt: changedAt,
        payload: { hardLimits: input.hardLimits, softLimits: input.softLimits, deadlineAt: input.deadlineAt,
          expiresAt: input.expiresAt, revoked: input.revoked, retryPerExecutionLimit: input.retryPerExecutionLimit },
      });
      const result = this.getByAccountId(account.account_id);
      this.insertIdempotency("budget.configure", principalKey, input.idempotencyKey, fingerprint, account.account_id, result, changedAt);
      return result;
    });
  }

  allocateChild(input: {
    accountId: string;
    accountKind: Exclude<ResourceBudgetAccountKind, "root">;
    rootSessionId: string;
    ownerSessionId: string;
    parentAccountId: string;
    hardLimits: ResourceBudgetAmounts;
    softLimits?: Readonly<Partial<Record<ResourceBudgetDimension, number | null>>>;
    authorityGrantId: string | null;
    authorityGrantRevision: number | null;
    expiresAt: string | null;
    deadlineAt: string;
    idempotencyKey: string;
    proof: MutationAuthorityProof;
    createdAt: string;
  }): ResourceBudget {
    return withSavepoint(this.db, () => {
      const replay = this.db.prepare(`SELECT account_id FROM resource_budget_accounts_v6 WHERE account_id = ?`)
        .get(input.accountId) as { account_id: string } | undefined;
      if (replay) return this.getByAccountId(input.accountId);
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      if (input.proof.principal.kind === "system"
        || (input.proof.principal.kind === "agent" && input.proof.principal.actorSessionId !== this.requireAccount(input.parentAccountId).owner_session_id)) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "Only the parent account owner can allocate a child budget.");
      }
      const parent = this.requireAccount(input.parentAccountId);
      if (parent.root_session_id !== input.rootSessionId) throw budgetNotFound(input.parentAccountId);
      if ((input.proof.principal.kind === "agent" && (input.proof.grantId !== input.authorityGrantId
        || input.proof.grantRevision !== input.authorityGrantRevision))
        || (input.proof.principal.kind === "user" && (input.authorityGrantId !== null || input.authorityGrantRevision !== null))) {
        throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The child allocation must be bound to the current authority grant.");
      }
      assertAllocationActive(this.db, parent, input.createdAt);
      assertDeadlineOpen(this.db, parent, input.createdAt);
      const parentDimensions = this.readDimensionRows(parent.account_id);
      const requested = input.hardLimits;
      if (requested.storageBytes !== 0) {
        throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "Child storage allocation is unavailable because storage is metered at the root SessionFolder.", {
          dimension: "storageBytes",
        });
      }
      if (input.softLimits?.storageBytes !== undefined && input.softLimits.storageBytes !== null) {
        throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "Child storage soft limits are unavailable because storage is metered at the root SessionFolder.", {
          dimension: "storageBytes",
        });
      }
      for (const row of parentDimensions) {
        assertCapacity(this.db, parent.account_id, row.dimension, requested[row.dimension], input.createdAt);
      }
      const deadlineAt = input.deadlineAt < parent.deadline_at ? input.deadlineAt : parent.deadline_at;
      this.db.prepare(`
        INSERT INTO resource_budget_accounts_v6 (
          account_id, account_kind, root_session_id, owner_session_id, parent_account_id,
          authority_grant_id, authority_grant_revision, expires_at, revoked_at, deadline_at,
          retry_per_execution_limit, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)
      `).run(input.accountId, input.accountKind, input.rootSessionId, input.ownerSessionId, input.parentAccountId,
        input.authorityGrantId, input.authorityGrantRevision, input.expiresAt, deadlineAt,
        RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT, input.createdAt, input.createdAt);
      for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
        const soft = input.softLimits?.[dimension] ?? null;
        if (soft !== null && soft > requested[dimension]) {
          throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "A child soft limit cannot exceed its allocation.", { dimension });
        }
        this.db.prepare(`INSERT INTO resource_budget_dimensions_v6
          (account_id, dimension, hard_limit, soft_limit, committed, reserved) VALUES (?, ?, ?, ?, 0, 0)`)
          .run(input.accountId, dimension, requested[dimension], soft);
      }
      appendEvent(this.db, { accountId: input.accountId, revision: 1, eventKind: "child_allocated", proof: input.proof,
        operationId: `budget.allocate:${mutationPrincipalKey(input.proof)}:${input.idempotencyKey}`,
        occurredAt: input.createdAt, payload: { parentAccountId: input.parentAccountId, hardLimits: requested } });
      return this.getByAccountId(input.accountId);
    });
  }

  reserve(input: {
    sessionId: string;
    accountId?: string;
    reservationId?: string;
    dimension: ResourceBudgetDimension;
    amount: number;
    kind: ResourceBudgetReservationKind;
    executionId?: string | null;
    providerGenerationId?: string | null;
    idempotencyKey: string;
    createdAt: string;
    deadlineMode?: "dispatch" | "queue";
  }): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const account = input.accountId
        ? this.requireAccountForSessionRoot(input.accountId, input.sessionId)
        : this.resolveAccount(input.sessionId);
      assertPositiveInteger(input.amount, "reservation amount");
      this.assertRootStorageKnown(input.sessionId);
      assertAllocationActive(this.db, account, input.createdAt);
      if ((input.deadlineMode ?? "dispatch") === "dispatch") assertDeadlineOpen(this.db, account, input.createdAt);
      const replay = this.findReservation(account.account_id, input.kind, input.idempotencyKey);
      if (replay) {
        if (replay.dimension !== input.dimension || replay.amount !== input.amount
          || replay.execution_id !== (input.executionId ?? null)
          || replay.provider_generation_id !== (input.providerGenerationId ?? null)) {
          throw idempotencyConflict(input.idempotencyKey);
        }
        return decodeReservation(replay);
      }
      assertCapacity(this.db, account.account_id, input.dimension, input.amount, input.createdAt);
      const reservationId = input.reservationId ?? randomUUID();
      this.db.prepare(`INSERT INTO resource_budget_reservations_v6 (
        reservation_id, account_id, dimension, amount, consumed, state, reservation_kind,
        execution_id, provider_generation_id, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, 'reserved', ?, ?, ?, ?, ?, ?)`)
        .run(reservationId, account.account_id, input.dimension, input.amount, input.kind,
          input.executionId ?? null, input.providerGenerationId ?? null, input.idempotencyKey,
          input.createdAt, input.createdAt);
      this.applyDelta(account.account_id, input.dimension, 0, input.amount, "reserved", input.createdAt,
        `budget.reserve:${input.kind}:${input.idempotencyKey}`, { reservationId }, "system", null);
      return this.requireReservation(reservationId);
    });
  }

  consumeReservation(reservationId: string, amount: number, settledAt: string): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      assertNonNegativeInteger(amount, "consumed amount");
      const reservation = this.requireReservationRow(reservationId);
      if (reservation.state === "consumed") {
        if (reservation.consumed !== amount) throw settlementConflict(reservationId);
        return decodeReservation(reservation);
      }
      if (reservation.state !== "reserved" && reservation.state !== "reconciliation_required") {
        throw settlementConflict(reservationId);
      }
      if (amount > reservation.amount) throw settlementConflict(reservationId);
      this.db.prepare(`UPDATE resource_budget_reservations_v6 SET consumed = ?, state = 'consumed', updated_at = ? WHERE reservation_id = ?`)
        .run(amount, settledAt, reservationId);
      this.applyDelta(reservation.account_id, reservation.dimension, amount, -reservation.amount, "consumed", settledAt,
        `budget.consume:${reservationId}`, { reservationId, amount }, "system", null);
      return this.requireReservation(reservationId);
    });
  }

  releaseReservation(reservationId: string, releasedAt: string): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const reservation = this.requireReservationRow(reservationId);
      if (reservation.state === "released") return decodeReservation(reservation);
      if (reservation.state === "consumed") throw settlementConflict(reservationId);
      this.db.prepare(`UPDATE resource_budget_reservations_v6 SET state = 'released', updated_at = ? WHERE reservation_id = ?`)
        .run(releasedAt, reservationId);
      this.applyDelta(reservation.account_id, reservation.dimension, 0, -reservation.amount, "released", releasedAt,
        `budget.release:${reservationId}`, { reservationId }, "system", null);
      return this.requireReservation(reservationId);
    });
  }

  markReservationForReconciliation(reservationId: string, changedAt: string): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const reservation = this.requireReservationRow(reservationId);
      if (reservation.state !== "reserved") return decodeReservation(reservation);
      this.db.prepare(`UPDATE resource_budget_reservations_v6 SET state = 'reconciliation_required', updated_at = ? WHERE reservation_id = ?`)
        .run(changedAt, reservationId);
      this.bumpRevision(reservation.account_id, "reconciliation_required", changedAt,
        `budget.reconcile:${reservationId}`, { reservationId }, "system", null);
      return this.requireReservation(reservationId);
    });
  }

  consumeCount(input: {
    sessionId: string;
    accountId?: string;
    dimension: "totalTurns" | "retries" | "sessions" | "workItems" | "delegations";
    amount?: number;
    idempotencyKey: string;
    executionId?: string | null;
    consumedAt: string;
    deadlineMode?: "dispatch" | "queue";
  }): ResourceBudgetReservation {
    const amount = input.amount ?? 1;
    return withSavepoint(this.db, () => {
      const account = input.accountId
        ? this.requireAccountForSessionRoot(input.accountId, input.sessionId)
        : this.resolveAccount(input.sessionId);
      this.assertRootStorageKnown(input.sessionId);
      const existing = this.findReservation(account.account_id, "resource", input.idempotencyKey);
      if (existing) {
        if (existing.dimension !== input.dimension || existing.amount !== amount) throw idempotencyConflict(input.idempotencyKey);
        return decodeReservation(existing);
      }
      assertPositiveInteger(amount, "consumed amount");
      assertAllocationActive(this.db, account, input.consumedAt);
      if ((input.deadlineMode ?? "dispatch") === "dispatch") assertDeadlineOpen(this.db, account, input.consumedAt);
      assertCapacity(this.db, account.account_id, input.dimension, amount, input.consumedAt);
      const reservationId = randomUUID();
      this.db.prepare(`INSERT INTO resource_budget_reservations_v6 (
        reservation_id, account_id, dimension, amount, consumed, state, reservation_kind,
        execution_id, provider_generation_id, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'consumed', 'resource', ?, NULL, ?, ?, ?)`)
        .run(reservationId, account.account_id, input.dimension, amount, amount,
          input.executionId ?? null, input.idempotencyKey, input.consumedAt, input.consumedAt);
      this.applyDelta(account.account_id, input.dimension, amount, 0, "consumed", input.consumedAt,
        `budget.consume-count:${input.idempotencyKey}`, { reservationId, amount }, "system", null);
      return this.requireReservation(reservationId);
    });
  }

  reserveQueuedTurn(input: { sessionId: string; executionId: string; idempotencyKey: string; createdAt: string }): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const queued = this.reserve({ ...input, dimension: "queuedTurns", amount: 1, kind: "queued_turn", deadlineMode: "queue" });
      this.consumeCount({ ...input, dimension: "totalTurns", consumedAt: input.createdAt,
        idempotencyKey: `turn:${input.idempotencyKey}`, deadlineMode: "queue" });
      return queued;
    });
  }

  reserveImmediateTurn(input: { sessionId: string; executionId: string; idempotencyKey: string; createdAt: string }): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const running = this.reserve({ ...input, dimension: "concurrentTurns", amount: 1, kind: "running_turn" });
      this.consumeCount({ ...input, dimension: "totalTurns", consumedAt: input.createdAt,
        idempotencyKey: `turn:${input.idempotencyKey}` });
      return running;
    });
  }

  startQueuedTurn(input: { sessionId: string; executionId: string; startedAt: string }): ResourceBudgetReservation {
    return withSavepoint(this.db, () => {
      const queued = this.findExecutionReservationForSession(input.sessionId, input.executionId, "queued_turn", true);
      if (!queued) throw new ResourceBudgetError("BUDGET_RESERVATION_NOT_FOUND", "The queued Turn reservation does not exist.");
      const running = this.reserve({ sessionId: input.sessionId, accountId: queued.account_id,
        dimension: "concurrentTurns", amount: 1,
        kind: "running_turn", executionId: input.executionId, idempotencyKey: `start:${input.executionId}`, createdAt: input.startedAt });
      this.releaseReservation(queued.reservation_id, input.startedAt);
      return running;
    });
  }

  settleTurn(input: {
    sessionId: string;
    executionId: string;
    outcome: "completed" | "failed" | "canceled" | "interrupted";
    settledAt: string;
    uncertain?: boolean;
  }): void {
    withSavepoint(this.db, () => {
      const rows = this.db.prepare(`SELECT * FROM resource_budget_reservations_v6
        WHERE account_id IN (
          SELECT account.account_id FROM resource_budget_accounts_v6 AS account
          INNER JOIN session_role_bindings_v6 AS binding ON binding.root_session_id = account.root_session_id
          WHERE binding.session_id = ?
        ) AND execution_id = ? AND state IN ('reserved', 'reconciliation_required')
          AND reservation_kind IN ('queued_turn', 'running_turn')`)
        .all(input.sessionId, input.executionId) as ReservationRow[];
      for (const row of rows) {
        if (input.uncertain) this.markReservationForReconciliation(row.reservation_id, input.settledAt);
        else this.releaseReservation(row.reservation_id, input.settledAt);
      }
    });
  }

  consumeRetry(input: { sessionId: string; executionId: string; retryAttempt: number; idempotencyKey: string; consumedAt: string }): void {
    withSavepoint(this.db, () => {
      const origin = this.findExecutionReservationForSession(input.sessionId, input.executionId, "running_turn", false)
        ?? this.findExecutionReservationForSession(input.sessionId, input.executionId, "queued_turn", false);
      const account = origin ? this.requireAccount(origin.account_id) : this.resolveAccount(input.sessionId);
      const rootAccount = this.resolveRootAccount(input.sessionId);
      const replay = this.findReservation(account.account_id, "resource", `retry:${input.idempotencyKey}`);
      if (replay) return;
      const used = this.db.prepare(`SELECT COALESCE(SUM(consumed), 0) AS count
        FROM resource_budget_reservations_v6
        WHERE account_id = ? AND dimension = 'retries' AND execution_id = ? AND state = 'consumed'`)
        .get(account.account_id, input.executionId) as { count: number };
      if (!Number.isSafeInteger(input.retryAttempt) || input.retryAttempt !== used.count + 1
        || input.retryAttempt > rootAccount.retry_per_execution_limit) {
        throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "The execution retry limit was exceeded or its durable sequence is invalid.", {
          retryAttempt: input.retryAttempt,
          recordedRetries: used.count,
          retryPerExecutionLimit: rootAccount.retry_per_execution_limit,
        });
      }
      this.consumeCount({ ...input, accountId: account.account_id, dimension: "retries", idempotencyKey: `retry:${input.idempotencyKey}` });
      this.consumeCount({ ...input, accountId: account.account_id, dimension: "totalTurns", idempotencyKey: `retry-turn:${input.idempotencyKey}` });
    });
  }

  reserveStorage(input: { sessionId: string; bytes: number; operationId: string; createdAt: string }): ResourceBudgetReservation {
    const root = this.resolveRootAccount(input.sessionId);
    return this.reserve({ sessionId: root.owner_session_id, dimension: "storageBytes", amount: input.bytes,
      kind: "storage", idempotencyKey: input.operationId, createdAt: input.createdAt });
  }

  resumeStorageReservation(input: {
    sessionId: string;
    bytes: number;
    alreadyCommittedBytes: number;
    operationId: string;
    resumedAt: string;
  }): ResourceBudgetReservation | null {
    assertNonNegativeInteger(input.alreadyCommittedBytes, "already committed bytes");
    const remaining = Math.max(0, input.bytes - input.alreadyCommittedBytes);
    if (remaining === 0) return null;
    return this.reserveStorage({
      sessionId: input.sessionId,
      bytes: remaining,
      operationId: `${input.operationId}:resume:${input.alreadyCommittedBytes}`,
      createdAt: input.resumedAt,
    });
  }

  recordMeteredUsage(input: {
    sessionId: string;
    usageId?: string;
    executionId?: string | null;
    providerGenerationId?: string | null;
    reservationId?: string | null;
    unit: ResourceBudgetMeteredUsage["unit"];
    amount: number | null;
    currency?: string | null;
    confidence: ResourceBudgetUsageConfidence;
    idempotencyKey: string;
    observedAt: string;
  }): ResourceBudgetMeteredUsage {
    return withSavepoint(this.db, () => {
      let reservation: ReservationRow | undefined;
      if (input.reservationId) reservation = this.requireReservationRow(input.reservationId);
      else if (input.executionId) {
        reservation = this.db.prepare(`SELECT reservation.* FROM resource_budget_reservations_v6 AS reservation
          INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = reservation.account_id
          INNER JOIN session_role_bindings_v6 AS binding ON binding.root_session_id = account.root_session_id
            AND binding.session_id = ?
          WHERE reservation.execution_id = ? AND reservation.reservation_kind = 'running_turn'
          ORDER BY reservation.created_at DESC LIMIT 1`).get(input.sessionId, input.executionId) as ReservationRow | undefined;
        if (!reservation) {
          throw new ResourceBudgetError("BUDGET_RESERVATION_NOT_FOUND", "Provider usage has no running Turn reservation.", {
            executionId: input.executionId,
          });
        }
      }
      if (reservation && input.executionId && reservation.execution_id !== input.executionId) {
        throw new ResourceBudgetError("BUDGET_SETTLEMENT_CONFLICT", "Provider usage does not match its reservation execution.", {
          reservationId: reservation.reservation_id,
          executionId: input.executionId,
        });
      }
      const account = reservation ? this.requireAccount(reservation.account_id) : this.resolveAccount(input.sessionId);
      if (reservation) {
        const sameRoot = this.db.prepare(`SELECT 1 FROM session_role_bindings_v6
          WHERE session_id = ? AND root_session_id = ?`).get(input.sessionId, account.root_session_id);
        if (!sameRoot) throw new ResourceBudgetError("BUDGET_SETTLEMENT_CONFLICT", "Provider usage Session is outside the reservation root.");
      }
      const reservationId = reservation?.reservation_id ?? null;
      if ((input.confidence === "unknown") !== (input.amount === null)) {
        throw new TypeError("Unknown usage must have a null amount, and known usage must have an amount.");
      }
      if (input.amount !== null && (!Number.isFinite(input.amount) || input.amount < 0)) {
        throw new TypeError("Usage amount must be non-negative.");
      }
      const prior = this.db.prepare(`SELECT * FROM resource_budget_metered_usage_v6
        WHERE account_id = ? AND usage_unit = ? AND idempotency_key = ?`)
        .get(account.account_id, input.unit, input.idempotencyKey) as MeteredUsageRow | undefined;
      if (prior) {
        if (prior.usage_id !== (input.usageId ?? prior.usage_id)
          || prior.execution_id !== (input.executionId ?? null)
          || prior.provider_generation_id !== (input.providerGenerationId ?? null)
          || prior.reservation_id !== reservationId
          || usageConfidenceRank(input.confidence) < usageConfidenceRank(prior.confidence)) {
          throw idempotencyConflict(input.idempotencyKey);
        }
        if (prior.confidence === input.confidence) {
          if (prior.amount !== input.amount || prior.currency !== (input.currency ?? null)) throw idempotencyConflict(input.idempotencyKey);
          return decodeMeteredUsage(prior);
        }
        this.db.prepare(`UPDATE resource_budget_metered_usage_v6
          SET amount = ?, currency = ?, confidence = ?, observed_at = ? WHERE usage_id = ?`)
          .run(input.amount, input.currency ?? null, input.confidence, input.observedAt, prior.usage_id);
        this.bumpRevision(account.account_id, "usage_observed", input.observedAt, `budget.usage:${input.idempotencyKey}`,
          { usageId: prior.usage_id, unit: input.unit, previousConfidence: prior.confidence, confidence: input.confidence }, "system", null);
        return decodeMeteredUsage(this.requireMeteredUsage(prior.usage_id));
      }
      const usageId = input.usageId ?? randomUUID();
      this.db.prepare(`INSERT INTO resource_budget_metered_usage_v6 (
        usage_id, account_id, execution_id, provider_generation_id, reservation_id,
        usage_unit, amount, currency, confidence, idempotency_key, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(usageId, account.account_id, input.executionId ?? null, input.providerGenerationId ?? null,
          reservationId, input.unit, input.amount, input.currency ?? null,
          input.confidence, input.idempotencyKey, input.observedAt);
      this.bumpRevision(account.account_id, "usage_observed", input.observedAt, `budget.usage:${input.idempotencyKey}`,
        { usageId, unit: input.unit, confidence: input.confidence }, "system", null);
      return decodeMeteredUsage(this.requireMeteredUsage(usageId));
    });
  }

  reconcileCommitted(input: {
    sessionId: string;
    dimension: ResourceBudgetDimension;
    absoluteAmount: number;
    idempotencyKey: string;
    reconciledAt: string;
    releaseOpenReservations?: boolean;
  }): ResourceBudget {
    return withSavepoint(this.db, () => {
      assertNonNegativeInteger(input.absoluteAmount, "reconciled amount");
      const account = input.dimension === "storageBytes"
        ? this.resolveRootAccount(input.sessionId)
        : this.resolveAccount(input.sessionId);
      const principalKey = "system:resource-budget-reconciliation";
      const fingerprint = JSON.stringify({ accountId: account.account_id, dimension: input.dimension,
        amount: input.absoluteAmount, releaseOpenReservations: input.releaseOpenReservations === true });
      const replay = this.findIdempotency("budget.reconcile", principalKey, input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) throw idempotencyConflict(input.idempotencyKey);
        return JSON.parse(replay.response_json) as ResourceBudget;
      }
      if (input.dimension === "storageBytes") {
        const stale = this.db.prepare(`SELECT reservation_id FROM resource_budget_reservations_v6
          WHERE account_id = ? AND dimension = 'storageBytes'
            AND (state = 'reconciliation_required' OR (? = 1 AND state = 'reserved'))`)
          .all(account.account_id, input.releaseOpenReservations === true ? 1 : 0) as Array<{ reservation_id: string }>;
        for (const reservation of stale) this.releaseReservation(reservation.reservation_id, input.reconciledAt);
      }
      const current = this.requireDimension(account.account_id, input.dimension);
      const delta = input.absoluteAmount - current.committed;
      if (delta === 0 && (input.dimension !== "storageBytes" || current.measurement_status === "known")) {
        return this.getByAccountId(account.account_id);
      }
      if (delta !== 0) {
        this.applyDelta(account.account_id, input.dimension, delta, 0, "consumed", input.reconciledAt,
          `budget.reconcile:${input.idempotencyKey}`, { absoluteAmount: input.absoluteAmount }, "system", null);
      }
      if (input.dimension === "storageBytes" && current.measurement_status === "unknown") {
        this.db.prepare(`UPDATE resource_budget_dimensions_v6 SET measurement_status = 'known', unknown_since = NULL
          WHERE account_id = ? AND dimension = 'storageBytes'`).run(account.account_id);
        this.bumpRevision(account.account_id, "measurement_changed", input.reconciledAt,
          `budget.storage-known:${input.idempotencyKey}`, { measurement: "known" }, "system", null);
      }
      const result = this.getByAccountId(account.account_id);
      this.insertIdempotency("budget.reconcile", principalKey, input.idempotencyKey, fingerprint,
        account.account_id, result, input.reconciledAt);
      return result;
    });
  }

  listReconciliationRequired(rootSessionId: string): ResourceBudgetReservation[] {
    return (this.db.prepare(`SELECT reservation.* FROM resource_budget_reservations_v6 AS reservation
      INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = reservation.account_id
      WHERE account.root_session_id = ? AND reservation.state = 'reconciliation_required'
      ORDER BY reservation.created_at, reservation.reservation_id`)
      .all(rootSessionId) as ReservationRow[]).map(decodeReservation);
  }

  markStorageUnknown(input: { sessionId: string; idempotencyKey: string; observedAt: string }): ResourceBudget {
    return withSavepoint(this.db, () => {
      const account = this.resolveRootAccount(input.sessionId);
      const row = this.requireDimension(account.account_id, "storageBytes");
      if (row.measurement_status === "unknown") return this.getByAccountId(account.account_id);
      this.db.prepare(`UPDATE resource_budget_dimensions_v6 SET measurement_status = 'unknown', unknown_since = ?
        WHERE account_id = ? AND dimension = 'storageBytes'`).run(input.observedAt, account.account_id);
      this.bumpRevision(account.account_id, "measurement_changed", input.observedAt,
        `budget.storage-unknown:${input.idempotencyKey}`, { measurement: "unknown" }, "system", null);
      return this.getByAccountId(account.account_id);
    });
  }

  private resolveAccount(sessionId: string): AccountRow {
    const direct = this.db.prepare(`SELECT * FROM resource_budget_accounts_v6
      WHERE owner_session_id = ?
      ORDER BY CASE account_kind WHEN 'session' THEN 0 ELSE 1 END LIMIT 1`)
      .get(sessionId) as AccountRow | undefined;
    if (direct) return direct;
    const root = this.db.prepare(`SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?`)
      .get(sessionId) as { root_session_id: string } | undefined;
    if (!root) throw budgetNotFound(sessionId);
    return this.requireAccount(root.root_session_id);
  }

  private resolveRootAccount(sessionId: string): AccountRow {
    const binding = this.db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
      .get(sessionId) as { root_session_id: string } | undefined;
    if (!binding) throw budgetNotFound(sessionId);
    return this.requireAccount(binding.root_session_id);
  }

  private assertRootStorageKnown(sessionId: string): void {
    const account = this.resolveRootAccount(sessionId);
    const row = this.requireDimension(account.account_id, "storageBytes");
    if (row.measurement_status === "unknown") {
      throw new ResourceBudgetError("BUDGET_STORAGE_UNKNOWN", "Storage usage is unknown; reconcile it before admitting new effects.", {
        unknownSince: row.unknown_since ?? "unknown",
      });
    }
  }

  private requireAccount(accountId: string): AccountRow {
    const row = this.db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(accountId) as AccountRow | undefined;
    if (!row) throw budgetNotFound(accountId);
    return row;
  }

  private requireAccountForSessionRoot(accountId: string, sessionId: string): AccountRow {
    const account = this.requireAccount(accountId);
    const binding = this.db.prepare(`SELECT 1 FROM session_role_bindings_v6
      WHERE session_id = ? AND root_session_id = ?`).get(sessionId, account.root_session_id);
    if (!binding) throw budgetNotFound(accountId);
    return account;
  }

  private readDimensionRows(accountId: string): DimensionRow[] {
    return this.db.prepare(`SELECT dimension, hard_limit, soft_limit, committed, reserved, measurement_status, unknown_since
      FROM resource_budget_dimensions_v6 WHERE account_id = ? ORDER BY dimension`)
      .all(accountId) as DimensionRow[];
  }

  private requireDimension(accountId: string, dimension: ResourceBudgetDimension): DimensionRow {
    const row = this.db.prepare(`SELECT dimension, hard_limit, soft_limit, committed, reserved, measurement_status, unknown_since
      FROM resource_budget_dimensions_v6 WHERE account_id = ? AND dimension = ?`)
      .get(accountId, dimension) as DimensionRow | undefined;
    if (!row) invalidLedger(`Budget dimension ${dimension} is missing.`, accountId);
    return row;
  }

  private decode(row: AccountRow, appliesToSessionId = row.owner_session_id,
    allocationSource: ResourceBudget["allocationSource"] = "owned"): ResourceBudget {
    const dimensions = {} as Record<ResourceBudgetDimension, ResourceBudget["dimensions"][ResourceBudgetDimension]>;
    const alerts: ResourceBudget["alerts"][number][] = [];
    for (const item of this.readDimensionRows(row.account_id)) {
      const allocated = childAllocation(this.db, row.account_id, item.dimension);
      const usage = item.committed + item.reserved + allocated;
      const softExceeded = item.soft_limit !== null && usage >= item.soft_limit;
      dimensions[item.dimension] = {
        hardLimit: item.hard_limit,
        softLimit: item.soft_limit,
        committed: item.committed,
        reserved: item.reserved,
        allocatedToChildren: allocated,
        available: Math.max(0, item.hard_limit - usage),
        softLimitExceeded: softExceeded,
        measurement: item.measurement_status,
        unknownSince: item.unknown_since,
      };
      if (softExceeded && !(row.account_kind === "session" && item.dimension === "storageBytes")) {
        alerts.push({ dimension: item.dimension, softLimit: item.soft_limit!, usage });
      }
    }
    const rootManagedDimensions: ResourceBudgetDimension[] = [];
    if (row.account_kind === "session") {
      rootManagedDimensions.push("storageBytes");
      const rootStorage = this.requireDimension(row.root_session_id, "storageBytes");
      const allocated = childAllocation(this.db, row.root_session_id, "storageBytes");
      const usage = rootStorage.committed + rootStorage.reserved + allocated;
      const softExceeded = rootStorage.soft_limit !== null && usage >= rootStorage.soft_limit;
      dimensions.storageBytes = {
        hardLimit: rootStorage.hard_limit,
        softLimit: rootStorage.soft_limit,
        committed: rootStorage.committed,
        reserved: rootStorage.reserved,
        allocatedToChildren: allocated,
        available: Math.max(0, rootStorage.hard_limit - usage),
        softLimitExceeded: softExceeded,
        measurement: rootStorage.measurement_status,
        unknownSince: rootStorage.unknown_since,
      };
      if (softExceeded) alerts.push({ dimension: "storageBytes", softLimit: rootStorage.soft_limit!, usage });
    }
    const usageRows = this.db.prepare(`SELECT * FROM resource_budget_metered_usage_v6
      WHERE account_id = ? ORDER BY observed_at DESC, usage_id DESC LIMIT 101`)
      .all(row.account_id) as MeteredUsageRow[];
    const meteredUsageTruncated = usageRows.length > 100;
    const meteredUsage = (meteredUsageTruncated ? usageRows.slice(0, 100) : usageRows)
      .reverse().map(decodeMeteredUsage);
    const meteredUsageSummary = summarizeMeteredUsage(this.db, row.account_id);
    const rootPolicy = row.account_kind === "root" ? row : this.requireAccount(row.root_session_id);
    return {
      contractRevision: RESOURCE_BUDGET_CONTRACT_REVISION,
      accountId: row.account_id,
      accountKind: row.account_kind,
      rootSessionId: row.root_session_id,
      ownerSessionId: row.owner_session_id,
      appliesToSessionId,
      allocationSource,
      rootManagedDimensions,
      parentAccountId: row.parent_account_id,
      authorityGrantId: row.authority_grant_id,
      authorityGrantRevision: row.authority_grant_revision,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      deadlineAt: rootPolicy.deadline_at,
      retryPerExecutionLimit: rootPolicy.retry_per_execution_limit,
      revision: row.revision,
      dimensions,
      alerts,
      meteredUsage,
      meteredUsageTruncated,
      meteredUsageSummary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private applyDelta(accountId: string, dimension: ResourceBudgetDimension, committedDelta: number,
    reservedDelta: number, eventKind: BudgetEventKind, occurredAt: string, operationId: string,
    payload: object, principalKind: "user" | "agent" | "system", actorSessionId: string | null): void {
    const row = this.requireDimension(accountId, dimension);
    const committed = row.committed + committedDelta;
    const reserved = row.reserved + reservedDelta;
    if (committed < 0 || reserved < 0) invalidLedger("A budget projection delta would become negative.", accountId);
    this.db.prepare(`UPDATE resource_budget_dimensions_v6 SET committed = ?, reserved = ?
      WHERE account_id = ? AND dimension = ?`).run(committed, reserved, accountId, dimension);
    const revision = this.nextRevision(accountId, occurredAt);
    appendRawEvent(this.db, { accountId, revision, eventKind, dimension, committedDelta, reservedDelta,
      principalKind, actorSessionId, operationId, occurredAt, payload });
  }

  private bumpRevision(accountId: string, eventKind: BudgetEventKind, occurredAt: string, operationId: string,
    payload: object, principalKind: "user" | "agent" | "system", actorSessionId: string | null): void {
    const revision = this.nextRevision(accountId, occurredAt);
    appendRawEvent(this.db, { accountId, revision, eventKind, dimension: null, committedDelta: 0,
      reservedDelta: 0, principalKind, actorSessionId, operationId, occurredAt, payload });
  }

  private nextRevision(accountId: string, updatedAt: string): number {
    const row = this.requireAccount(accountId);
    const revision = row.revision + 1;
    this.db.prepare("UPDATE resource_budget_accounts_v6 SET revision = ?, updated_at = ? WHERE account_id = ?")
      .run(revision, updatedAt, accountId);
    return revision;
  }

  private findReservation(accountId: string, kind: ResourceBudgetReservationKind, key: string): ReservationRow | undefined {
    return this.db.prepare(`SELECT * FROM resource_budget_reservations_v6
      WHERE account_id = ? AND reservation_kind = ? AND idempotency_key = ?`).get(accountId, kind, key) as ReservationRow | undefined;
  }

  private findExecutionReservationForSession(sessionId: string, executionId: string,
    kind: "queued_turn" | "running_turn", openOnly: boolean): ReservationRow | undefined {
    return this.db.prepare(`SELECT reservation.* FROM resource_budget_reservations_v6 AS reservation
      INNER JOIN resource_budget_accounts_v6 AS account ON account.account_id = reservation.account_id
      INNER JOIN session_role_bindings_v6 AS binding ON binding.root_session_id = account.root_session_id
        AND binding.session_id = ?
      WHERE reservation.execution_id = ? AND reservation.reservation_kind = ?
        ${openOnly ? "AND reservation.state IN ('reserved', 'reconciliation_required')" : ""}
      ORDER BY reservation.created_at DESC LIMIT 1`).get(sessionId, executionId, kind) as ReservationRow | undefined;
  }

  private requireReservationRow(reservationId: string): ReservationRow {
    const row = this.db.prepare("SELECT * FROM resource_budget_reservations_v6 WHERE reservation_id = ?")
      .get(reservationId) as ReservationRow | undefined;
    if (!row) throw new ResourceBudgetError("BUDGET_RESERVATION_NOT_FOUND", "The budget reservation does not exist.", { reservationId });
    return row;
  }

  private requireReservation(reservationId: string): ResourceBudgetReservation {
    return decodeReservation(this.requireReservationRow(reservationId));
  }

  private requireMeteredUsage(usageId: string): MeteredUsageRow {
    const row = this.db.prepare("SELECT * FROM resource_budget_metered_usage_v6 WHERE usage_id = ?")
      .get(usageId) as MeteredUsageRow | undefined;
    if (!row) invalidLedger("A metered usage row is missing.", usageId);
    return row;
  }

  private findIdempotency(operation: string, principalKey: string, key: string): IdempotencyRow | undefined {
    return this.db.prepare(`SELECT request_fingerprint, response_json FROM resource_budget_idempotency_v6
      WHERE operation = ? AND principal_key = ? AND idempotency_key = ?`)
      .get(operation, principalKey, key) as IdempotencyRow | undefined;
  }

  private insertIdempotency(operation: string, principalKey: string, key: string, fingerprint: string,
    accountId: string, response: unknown, createdAt: string): void {
    this.db.prepare(`INSERT INTO resource_budget_idempotency_v6 (
      operation, principal_key, idempotency_key, request_fingerprint, account_id, response_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(operation, principalKey, key, fingerprint, accountId, JSON.stringify(response), createdAt);
  }
}

type ReservationRow = {
  reservation_id: string;
  account_id: string;
  dimension: ResourceBudgetDimension;
  amount: number;
  consumed: number;
  state: ResourceBudgetReservation["state"];
  reservation_kind: ResourceBudgetReservationKind;
  execution_id: string | null;
  provider_generation_id: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
};

type MeteredUsageRow = {
  usage_id: string;
  account_id: string;
  execution_id: string | null;
  provider_generation_id: string | null;
  reservation_id: string | null;
  usage_unit: ResourceBudgetMeteredUsage["unit"];
  amount: number | null;
  currency: string | null;
  confidence: ResourceBudgetUsageConfidence;
  idempotency_key: string;
  observed_at: string;
};

type IdempotencyRow = { request_fingerprint: string; response_json: string };
type BudgetEventKind = "migration_baseline" | "configured" | "child_allocated" | "reserved"
  | "consumed" | "released" | "reconciliation_required" | "usage_observed" | "measurement_changed";

export function bootstrapRootResourceBudget(db: DatabaseSync, input: {
  rootSessionId: string;
  rootCreatedAt: string;
  createdAt: string;
}): ResourceBudget {
  ensureResourceBudgetSchema(db);
  withSavepoint(db, () => backfillRoot(db, input.rootSessionId, input.rootCreatedAt, input.createdAt));
  return new ResourceBudgetStorage(db).getByAccountId(input.rootSessionId);
}

export const bootstrapRootBudget = bootstrapRootResourceBudget;

function backfillRoot(db: DatabaseSync, rootSessionId: string, rootCreatedAt: string, migratedAt: string): void {
  const marker = db.prepare("SELECT 1 FROM resource_budget_migration_markers_v6 WHERE root_session_id = ?")
    .get(rootSessionId);
  if (marker) {
    const account = db.prepare("SELECT 1 FROM resource_budget_accounts_v6 WHERE account_id = ?").get(rootSessionId);
    if (!account) invalidLedger("The root budget projection is missing after migration.", rootSessionId);
    return;
  }
  const existing = db.prepare("SELECT 1 FROM resource_budget_accounts_v6 WHERE account_id = ?").get(rootSessionId);
  if (existing) invalidLedger("A root budget exists without its migration marker.", rootSessionId);
  const deadlineAt = new Date(Date.parse(rootCreatedAt) + RESOURCE_BUDGET_DEFAULT_DURATION_MS).toISOString();
  const counts = deriveBaselineCounts(db, rootSessionId);
  db.prepare(`INSERT INTO resource_budget_accounts_v6 (
    account_id, account_kind, root_session_id, owner_session_id, parent_account_id,
    authority_grant_id, authority_grant_revision, expires_at, revoked_at, deadline_at,
    retry_per_execution_limit, revision, created_at, updated_at
  ) VALUES (?, 'root', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, ?)`)
    .run(rootSessionId, rootSessionId, rootSessionId, deadlineAt,
      RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT, rootCreatedAt, migratedAt);
  for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
    const committed = counts[dimension];
    db.prepare(`INSERT INTO resource_budget_dimensions_v6
      (account_id, dimension, hard_limit, soft_limit, committed, reserved) VALUES (?, ?, ?, NULL, ?, 0)`)
      .run(rootSessionId, dimension, RESOURCE_BUDGET_DEFAULT_HARD_LIMITS[dimension], committed);
    appendRawEvent(db, { accountId: rootSessionId, revision: 1, eventKind: "migration_baseline", dimension,
      committedDelta: committed, reservedDelta: 0, principalKind: "system", actorSessionId: null,
      operationId: `budget.migration:${rootSessionId}`, occurredAt: migratedAt,
      payload: { source: "existing-v6-database", derivedCommitted: committed,
        policySource: "user-approved-2026-09-07",
        hardLimit: RESOURCE_BUDGET_DEFAULT_HARD_LIMITS[dimension],
        deadlineAt,
        retryPerExecutionLimit: RESOURCE_BUDGET_RETRY_PER_EXECUTION_LIMIT } });
  }
  db.prepare(`INSERT INTO resource_budget_migration_markers_v6
    (root_session_id, source, baseline_json, migrated_at) VALUES (?, ?, ?, ?)`)
    .run(rootSessionId, "existing-v6-database", JSON.stringify(counts), migratedAt);
  createBaselineOccupancyReservations(db, rootSessionId, migratedAt);
}

function deriveBaselineCounts(db: DatabaseSync, rootSessionId: string): ResourceBudgetAmounts {
  const scalar = (sql: string): number => (db.prepare(sql).get(rootSessionId) as { count: number }).count;
  const totalTurns = scalar(`SELECT COUNT(*) AS count FROM session_executions_v6 AS execution
    INNER JOIN session_role_bindings_v6 AS binding ON binding.session_id = execution.session_id
    WHERE binding.root_session_id = ?`);
  return {
    concurrentTurns: 0,
    queuedTurns: 0,
    totalTurns,
    retries: 0,
    sessions: scalar("SELECT COUNT(*) AS count FROM session_role_bindings_v6 WHERE root_session_id = ?"),
    workItems: scalar("SELECT COUNT(*) AS count FROM work_items_v6 WHERE root_session_id = ?"),
    delegations: 0,
    storageBytes: 0,
  };
}

function createBaselineOccupancyReservations(db: DatabaseSync, rootSessionId: string, createdAt: string): void {
  const executions = db.prepare(`SELECT execution.id, execution.state
    FROM session_executions_v6 AS execution
    INNER JOIN session_role_bindings_v6 AS binding ON binding.session_id = execution.session_id
    WHERE binding.root_session_id = ? AND execution.state IN ('queued', 'running')`)
    .all(rootSessionId) as Array<{ id: string; state: "queued" | "running" }>;
  for (const execution of executions) {
    const dimension = execution.state === "queued" ? "queuedTurns" : "concurrentTurns";
    const kind = execution.state === "queued" ? "queued_turn" : "running_turn";
    const reservationId = randomUUID();
    db.prepare(`INSERT INTO resource_budget_reservations_v6 (
      reservation_id, account_id, dimension, amount, consumed, state, reservation_kind,
      execution_id, provider_generation_id, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 0, 'reserved', ?, ?, NULL, ?, ?, ?)`)
      .run(reservationId, rootSessionId, dimension, kind, execution.id, `migration:${execution.id}:${kind}`, createdAt, createdAt);
    db.prepare(`UPDATE resource_budget_dimensions_v6 SET reserved = reserved + 1 WHERE account_id = ? AND dimension = ?`)
      .run(rootSessionId, dimension);
    appendRawEvent(db, { accountId: rootSessionId, revision: 1, eventKind: "reserved", dimension,
      committedDelta: 0, reservedDelta: 1, principalKind: "system", actorSessionId: null,
      operationId: `budget.migration-reservation:${execution.id}:${kind}`, occurredAt: createdAt,
      payload: { reservationId, executionId: execution.id, source: "existing-v6-database" } });
  }
}

function assertCapacity(db: DatabaseSync, accountId: string, dimension: ResourceBudgetDimension, requested: number,
  timestamp = new Date().toISOString()): void {
  const row = db.prepare(`SELECT hard_limit, committed, reserved FROM resource_budget_dimensions_v6
    WHERE account_id = ? AND dimension = ?`).get(accountId, dimension) as
    { hard_limit: number; committed: number; reserved: number } | undefined;
  if (!row) invalidLedger(`Budget dimension ${dimension} is missing.`, accountId);
  const allocated = childAllocation(db, accountId, dimension, timestamp);
  const usage = row.committed + row.reserved + allocated;
  if (usage + requested > row.hard_limit) {
    throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", `The ${dimension} hard limit would be exceeded.`, {
      dimension, hardLimit: row.hard_limit, usage, requested,
    });
  }
}

function childAllocation(db: DatabaseSync, accountId: string, dimension: ResourceBudgetDimension,
  timestamp = new Date().toISOString()): number {
  const children = db.prepare(`SELECT child.*, child_dimension.hard_limit, child_dimension.committed, child_dimension.reserved
    FROM resource_budget_accounts_v6 AS child
    INNER JOIN resource_budget_dimensions_v6 AS child_dimension ON child_dimension.account_id = child.account_id
    WHERE child.parent_account_id = ? AND child_dimension.dimension = ?`)
    .all(accountId, dimension) as Array<AccountRow & { hard_limit: number; committed: number; reserved: number }>;
  return children.reduce((total, child) => total + childContribution(db, child, dimension, timestamp), 0);
}

function childContribution(db: DatabaseSync,
  child: AccountRow & { hard_limit: number; committed: number; reserved: number },
  dimension: ResourceBudgetDimension, timestamp: string): number {
  if (isAccountChainActive(db, child, timestamp)) return child.hard_limit;
  return child.committed + child.reserved + childAllocation(db, child.account_id, dimension, timestamp);
}

function assertHardLimitsFit(db: DatabaseSync, accountId: string,
  hardLimits: Readonly<Record<ResourceBudgetDimension, number>>, revoked: boolean,
  timestamp = new Date().toISOString()): void {
  if (revoked) return;
  for (const dimension of RESOURCE_BUDGET_DIMENSIONS) {
    const row = db.prepare(`SELECT committed, reserved FROM resource_budget_dimensions_v6
      WHERE account_id = ? AND dimension = ?`).get(accountId, dimension) as { committed: number; reserved: number };
    const required = row.committed + row.reserved + childAllocation(db, accountId, dimension, timestamp);
    if (hardLimits[dimension] < required) {
      throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "The hard limit is below committed, reserved, and allocated usage.", {
        dimension, requested: hardLimits[dimension], required,
      });
    }
  }
}

function assertChildResizeCapacity(db: DatabaseSync, parentAccountId: string, childAccountId: string,
  dimension: ResourceBudgetDimension, requestedChildLimit: number, timestamp = new Date().toISOString()): void {
  const parent = db.prepare(`SELECT hard_limit, committed, reserved FROM resource_budget_dimensions_v6
    WHERE account_id = ? AND dimension = ?`).get(parentAccountId, dimension) as
    { hard_limit: number; committed: number; reserved: number };
  const currentChild = db.prepare(`SELECT child.*, dimension.hard_limit, dimension.committed, dimension.reserved
    FROM resource_budget_accounts_v6 AS child
    INNER JOIN resource_budget_dimensions_v6 AS dimension ON dimension.account_id = child.account_id
    WHERE child.account_id = ? AND dimension.dimension = ?`).get(childAccountId, dimension) as
    AccountRow & { hard_limit: number; committed: number; reserved: number };
  const currentContribution = childContribution(db, currentChild, dimension, timestamp);
  const required = parent.committed + parent.reserved
    + childAllocation(db, parentAccountId, dimension, timestamp) - currentContribution + requestedChildLimit;
  if (required > parent.hard_limit) {
    throw new ResourceBudgetError("BUDGET_HARD_LIMIT_EXCEEDED", "The child allocation would exceed its parent budget.", {
      dimension, requested: requestedChildLimit, parentHardLimit: parent.hard_limit,
    });
  }
}

function assertAllocationActive(db: DatabaseSync, account: AccountRow, timestamp: string): void {
  if (!isAccountChainActive(db, account, timestamp)) {
    const expiresAt = findExpiredAllocationInChain(db, account, timestamp);
    throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The resource budget allocation or its authority chain is no longer active.",
      expiresAt === null ? {} : { reason: "allocation_expired", expiresAt });
  }
}

function findExpiredAllocationInChain(db: DatabaseSync, account: AccountRow, timestamp: string): string | null {
  let current: AccountRow | undefined = account;
  let expiredAt: string | null = null;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.account_id) || current.revoked_at !== null) return null;
    visited.add(current.account_id);
    if (current.authority_grant_id !== null
      && !isGrantChainActive(db, current.authority_grant_id, current.authority_grant_revision ?? -1, timestamp)) return null;
    if (expiredAt === null && current.expires_at !== null && current.expires_at <= timestamp) {
      expiredAt = current.expires_at;
    }
    if (!current.parent_account_id) break;
    current = db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(current.parent_account_id) as AccountRow | undefined;
    if (!current) return null;
  }
  return expiredAt;
}

function assertDeadlineOpen(db: DatabaseSync, account: AccountRow, timestamp: string): void {
  const root = account.account_kind === "root"
    ? account
    : db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?").get(account.root_session_id) as AccountRow | undefined;
  if (!root) invalidLedger("The root budget account is missing.", account.account_id);
  if (root.deadline_at <= timestamp) {
    throw new ResourceBudgetError("BUDGET_DEADLINE_EXCEEDED", "The root deadline prevents new dispatch.", { deadlineAt: root.deadline_at });
  }
}

function isAccountChainActive(db: DatabaseSync, account: AccountRow, timestamp: string): boolean {
  let current: AccountRow | undefined = account;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.account_id)) return false;
    visited.add(current.account_id);
    if (current.revoked_at !== null || (current.expires_at !== null && current.expires_at <= timestamp)) return false;
    if (current.authority_grant_id !== null
      && !isGrantChainActive(db, current.authority_grant_id, current.authority_grant_revision ?? -1, timestamp)) return false;
    if (!current.parent_account_id) {
      current = undefined;
      continue;
    }
    current = db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?")
      .get(current.parent_account_id) as AccountRow | undefined;
    if (!current) return false;
  }
  return true;
}

function isGrantChainActive(db: DatabaseSync, grantId: string, revision: number, timestamp: string): boolean {
  let expectedGrantId: string | null = grantId;
  let expectedRevision: number | null = revision;
  const visited = new Set<string>();
  while (expectedGrantId !== null) {
    if (visited.has(expectedGrantId)) return false;
    visited.add(expectedGrantId);
    const grant = db.prepare(`SELECT grant_id, revision, effective_at, expires_at, revoked_at,
      issuer_grant_id, issuer_grant_revision FROM session_authority_grants_v6 WHERE grant_id = ?`)
      .get(expectedGrantId) as { grant_id: string; revision: number; effective_at: string; expires_at: string | null;
        revoked_at: string | null; issuer_grant_id: string | null; issuer_grant_revision: number | null } | undefined;
    if (!grant || grant.revision !== expectedRevision || grant.revoked_at !== null || grant.effective_at > timestamp
      || (grant.expires_at !== null && grant.expires_at <= timestamp)) return false;
    expectedGrantId = grant.issuer_grant_id;
    expectedRevision = grant.issuer_grant_revision;
  }
  return true;
}

function assertConfigureScope(db: DatabaseSync, account: AccountRow, sessionId: string, proof: MutationAuthorityProof): void {
  if (proof.principal.kind === "user") return;
  if (proof.principal.kind === "system" && proof.principal.service === "session-lifecycle") return;
  if (proof.principal.kind !== "agent" || proof.principal.actorSessionId !== sessionId) {
    throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "The budget configuration actor is invalid.");
  }
  if (account.owner_session_id === sessionId) return;
  const child = db.prepare(`SELECT 1 FROM resource_budget_accounts_v6
    WHERE account_id = ? AND parent_account_id IN (
      SELECT account_id FROM resource_budget_accounts_v6 WHERE owner_session_id = ?
    )`).get(account.account_id, sessionId);
  if (!child) throw new ResourceBudgetError("BUDGET_AUTHORITY_REQUIRED", "An Agent can configure only its own or direct child budget.");
}

function mutationPrincipalKey(proof: MutationAuthorityProof): string {
  if (proof.principal.kind === "agent") return `agent:${proof.principal.actorSessionId}`;
  if (proof.principal.kind === "user") return "user";
  return `system:${proof.principal.service}`;
}

function dimensionEntries<T>(values: Readonly<Partial<Record<ResourceBudgetDimension, T>>> | undefined): Array<[ResourceBudgetDimension, T]> {
  if (!values) return [];
  return RESOURCE_BUDGET_DIMENSIONS.flatMap((dimension) => values[dimension] === undefined ? [] : [[dimension, values[dimension]!] as [ResourceBudgetDimension, T]]);
}

function appendEvent(db: DatabaseSync, input: { accountId: string; revision: number; eventKind: BudgetEventKind;
  proof: MutationAuthorityProof; operationId: string; occurredAt: string; payload: object }): void {
  appendRawEvent(db, { accountId: input.accountId, revision: input.revision, eventKind: input.eventKind,
    dimension: null, committedDelta: 0, reservedDelta: 0, principalKind: input.proof.principal.kind,
    actorSessionId: input.proof.principal.kind === "agent" ? input.proof.principal.actorSessionId : null,
    grantId: input.proof.grantId, grantRevision: input.proof.grantRevision,
    operationId: input.operationId, occurredAt: input.occurredAt, payload: input.payload });
}

function appendRawEvent(db: DatabaseSync, input: { accountId: string; revision: number; eventKind: BudgetEventKind;
  dimension: ResourceBudgetDimension | null; committedDelta: number; reservedDelta: number;
  principalKind: "user" | "agent" | "system"; actorSessionId: string | null;
  grantId?: string | null; grantRevision?: number | null;
  operationId: string; occurredAt: string; payload: object }): void {
  const eventId = randomUUID();
  const account = db.prepare(`SELECT root_session_id, owner_session_id FROM resource_budget_accounts_v6 WHERE account_id = ?`)
    .get(input.accountId) as { root_session_id: string; owner_session_id: string };
  db.prepare(`INSERT INTO resource_budget_events_v6 (
    event_id, account_id, account_revision, event_kind, dimension, committed_delta, reserved_delta,
    principal_kind, actor_session_id, grant_id, grant_revision, operation_id, payload_json, projection_json, occurred_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, input.accountId, input.revision, input.eventKind, input.dimension,
      input.committedDelta, input.reservedDelta, input.principalKind, input.actorSessionId,
      input.grantId ?? null, input.grantRevision ?? null, input.operationId,
      JSON.stringify(input.payload), JSON.stringify(budgetEventProjection(db, input.accountId, input.payload)), input.occurredAt);
  db.prepare(`INSERT INTO resource_event_headers_v6 (
    event_id, resource_kind, resource_id, root_id, owner_kind, owner_id, event_kind,
    resource_revision, principal_kind, actor_session_id, grant_id, grant_revision,
    operation_id, idempotency_key_fingerprint, occurred_at, committed_at,
    supersedes_event_id, payload_schema_revision, effect
  ) VALUES (?, 'budget', ?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 1, 'committed')`)
    .run(eventId, input.accountId, account.root_session_id, account.owner_session_id, input.eventKind,
      input.revision, input.principalKind, input.actorSessionId, input.grantId ?? null,
      input.grantRevision ?? null, input.operationId,
      input.occurredAt, input.occurredAt);
}

function budgetEventProjection(db: DatabaseSync, accountId: string, payload: object): object {
  const identity = payload as { reservationId?: unknown; usageId?: unknown };
  const reservation = typeof identity.reservationId === "string"
    ? db.prepare("SELECT * FROM resource_budget_reservations_v6 WHERE reservation_id = ?").get(identity.reservationId) ?? null
    : null;
  const usage = typeof identity.usageId === "string"
    ? db.prepare("SELECT * FROM resource_budget_metered_usage_v6 WHERE usage_id = ?").get(identity.usageId) ?? null
    : null;
  return {
    account: db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?").get(accountId),
    dimensions: db.prepare("SELECT * FROM resource_budget_dimensions_v6 WHERE account_id = ? ORDER BY dimension").all(accountId),
    reservation,
    usage,
  };
}

function verifyBudgetRowProjections(db: DatabaseSync): void {
  const accounts = db.prepare("SELECT account_id FROM resource_budget_accounts_v6 ORDER BY account_id")
    .all() as Array<{ account_id: string }>;
  for (const account of accounts) {
    const latest = db.prepare(`SELECT projection_json FROM resource_budget_events_v6
      WHERE account_id = ? ORDER BY sequence DESC LIMIT 1`).get(account.account_id) as { projection_json: string } | undefined;
    if (!latest) invalidLedger("The budget account history is missing.", account.account_id);
    const projection = JSON.parse(latest.projection_json) as { account: unknown; dimensions: unknown };
    const currentAccount = db.prepare("SELECT * FROM resource_budget_accounts_v6 WHERE account_id = ?").get(account.account_id);
    const currentDimensions = db.prepare("SELECT * FROM resource_budget_dimensions_v6 WHERE account_id = ? ORDER BY dimension").all(account.account_id);
    if (JSON.stringify(projection.account) !== JSON.stringify(currentAccount)
      || JSON.stringify(projection.dimensions) !== JSON.stringify(currentDimensions)) {
      invalidLedger("The budget account projection differs from its history.", account.account_id);
    }
  }
  const reservations = db.prepare("SELECT reservation_id, account_id FROM resource_budget_reservations_v6")
    .all() as Array<{ reservation_id: string; account_id: string }>;
  for (const row of reservations) verifyProjectedIdentity(db, row.account_id, "reservationId", row.reservation_id,
    "resource_budget_reservations_v6", "reservation_id", "reservation");
  const usage = db.prepare("SELECT usage_id, account_id FROM resource_budget_metered_usage_v6")
    .all() as Array<{ usage_id: string; account_id: string }>;
  for (const row of usage) verifyProjectedIdentity(db, row.account_id, "usageId", row.usage_id,
    "resource_budget_metered_usage_v6", "usage_id", "usage");
}

function verifyProjectedIdentity(db: DatabaseSync, accountId: string, payloadField: "reservationId" | "usageId",
  identity: string, table: "resource_budget_reservations_v6" | "resource_budget_metered_usage_v6",
  keyColumn: "reservation_id" | "usage_id", projectionField: "reservation" | "usage"): void {
  const events = db.prepare(`SELECT payload_json, projection_json FROM resource_budget_events_v6
    WHERE account_id = ? ORDER BY sequence DESC`).all(accountId) as Array<{ payload_json: string; projection_json: string }>;
  const event = events.find((candidate) => (JSON.parse(candidate.payload_json) as Record<string, unknown>)[payloadField] === identity);
  const current = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} = ?`).get(identity);
  const projected = event ? (JSON.parse(event.projection_json) as Record<string, unknown>)[projectionField] : undefined;
  if (!event || JSON.stringify(projected) !== JSON.stringify(current)) {
    invalidLedger(`The ${projectionField} projection differs from its history.`, accountId);
  }
}

function decodeReservation(row: ReservationRow): ResourceBudgetReservation {
  return { reservationId: row.reservation_id, accountId: row.account_id, dimension: row.dimension,
    amount: row.amount, consumed: row.consumed, state: row.state, kind: row.reservation_kind,
    executionId: row.execution_id, providerGenerationId: row.provider_generation_id,
    idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at };
}

function decodeMeteredUsage(row: MeteredUsageRow): ResourceBudgetMeteredUsage {
  return { usageId: row.usage_id, executionId: row.execution_id,
    providerGenerationId: row.provider_generation_id, reservationId: row.reservation_id,
    unit: row.usage_unit, amount: row.amount, currency: row.currency,
    confidence: row.confidence, observedAt: row.observed_at };
}

function usageConfidenceRank(confidence: ResourceBudgetUsageConfidence): number {
  return { unknown: 0, estimated: 1, reported: 2, settled: 3 }[confidence];
}

function summarizeMeteredUsage(db: DatabaseSync, accountId: string): ResourceBudget["meteredUsageSummary"] {
  const rows = db.prepare(`SELECT usage_unit, currency, confidence, COUNT(*) AS count,
      COALESCE(SUM(amount), 0) AS amount
    FROM resource_budget_metered_usage_v6 WHERE account_id = ?
    GROUP BY usage_unit, currency, confidence`).all(accountId) as Array<{
      usage_unit: ResourceBudgetMeteredUsage["unit"];
      currency: string | null;
      confidence: ResourceBudgetUsageConfidence;
      count: number;
      amount: number;
    }>;
  const monetaryCostByCurrency: Record<string, number> = {};
  const unknownRecords = { tokens: 0, monetary_cost: 0, provider_usage: 0 };
  let knownTokens = 0;
  let knownProviderUsage = 0;
  for (const row of rows) {
    if (row.confidence === "unknown") {
      unknownRecords[row.usage_unit] += row.count;
    } else if (row.usage_unit === "tokens") {
      knownTokens += row.amount;
    } else if (row.usage_unit === "provider_usage") {
      knownProviderUsage += row.amount;
    } else {
      const currency = row.currency ?? "unspecified";
      monetaryCostByCurrency[currency] = (monetaryCostByCurrency[currency] ?? 0) + row.amount;
    }
  }
  return { knownTokens, knownProviderUsage, monetaryCostByCurrency, unknownRecords };
}

function withSavepoint<T>(db: DatabaseSync, run: () => T): T {
  if (!db.isTransaction) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const name = `resource_budget_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
}

function budgetNotFound(id: string): ResourceBudgetError {
  return new ResourceBudgetError("BUDGET_NOT_FOUND", "The resource budget does not exist.", { id });
}

function idempotencyConflict(key: string): ResourceBudgetError {
  return new ResourceBudgetError("BUDGET_IDEMPOTENCY_CONFLICT", "The idempotency key was reused with different input.", { key });
}

function settlementConflict(reservationId: string): ResourceBudgetError {
  return new ResourceBudgetError("BUDGET_SETTLEMENT_CONFLICT", "The reservation was already settled differently.", { reservationId });
}

function invalidLedger(message: string, accountId: string): never {
  throw new ResourceBudgetError("BUDGET_LEDGER_INVALID", message, { accountId });
}
