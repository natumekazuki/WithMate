import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { cleanupForbiddenV6Tables, ensureV6Schema } from "../src-electron/database-schema-v6.js";

type AuditEventRow = {
  id: number;
  session_id: string | null;
  auxiliary_session_id: string | null;
  provider_id: string;
  summary: string;
  metadata_json: string;
  created_at: string;
};

type ProviderOutputKind =
  | "operation"
  | "raw_items"
  | "usage"
  | "logical_prompt"
  | "transport_payload"
  | "provider_error"
  | "legacy_assistant_text"
  | "quota"
  | "context_telemetry"
  | "background_task"
  | "provider_metadata";

type SessionTurnPhase = "running" | "completed" | "failed" | "canceled";

export type SessionTurnStorageV6DryRunReport = {
  mode: "dry-run";
  input: {
    databaseFile: string;
  };
  sourceCounts: {
    auditSessionTurnRows: number;
    auditEventRows: number;
    existingSessionTurnRows: number;
    legacyTables: Array<{
      tableName: string;
      rows: number;
    }>;
  };
  plannedCounts: {
    sessionTurns: number;
    mainAssistantMessages: number;
    interims: number;
    providerOutputs: number;
    providerOutputsByKind: Record<ProviderOutputKind, number>;
  };
  assistantText: {
    completedMatchedFinalMessages: number;
    completedUnmatchedFinalMessages: number;
    runningSnapshots: number;
    terminalPartialResponses: number;
    empty: number;
  };
  skipped: {
    invalidMetadataJson: number;
    nonSessionTurnRows: number;
    orphanTurnRows: number;
  };
  cleanupCandidates: {
    dropAuditEventsV6: boolean;
    dropLegacyTables: string[];
  };
  caveats: string[];
};

export type SessionTurnStorageV6WriteReport = Omit<SessionTurnStorageV6DryRunReport, "mode"> & {
  mode: "write";
  migratedAt: string;
};

type ParsedAuditMetadata = {
  phase?: unknown;
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  approvalMode?: unknown;
  threadId?: unknown;
  logicalPrompt?: unknown;
  transportPayload?: unknown;
  assistantText?: unknown;
  operations?: unknown;
  rawItemsJson?: unknown;
  providerMetadata?: unknown;
  usage?: unknown;
  errorMessage?: unknown;
};

const PROVIDER_OUTPUT_KINDS: ProviderOutputKind[] = [
  "operation",
  "raw_items",
  "usage",
  "logical_prompt",
  "transport_payload",
  "provider_error",
  "legacy_assistant_text",
  "quota",
  "context_telemetry",
  "background_task",
  "provider_metadata",
];

const LEGACY_TABLE_CLEANUP_CANDIDATES = [
  "session_memories",
  "project_scopes",
  "project_memory_entries",
  "character_scopes",
  "character_memory_entries",
] as const;

function createEmptyProviderOutputCounts(): Record<ProviderOutputKind, number> {
  return Object.fromEntries(PROVIDER_OUTPUT_KINDS.map((kind) => [kind, 0])) as Record<ProviderOutputKind, number>;
}

function countRows(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name?: string }
    | undefined;
  return row?.name === tableName;
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function parseMetadata(value: string): ParsedAuditMetadata | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ParsedAuditMetadata : null;
  } catch {
    return null;
  }
}

function normalizePhase(value: unknown): SessionTurnPhase {
  if (value === "completed" || value === "background-completed") {
    return "completed";
  }
  if (value === "failed" || value === "background-failed") {
    return "failed";
  }
  if (value === "canceled" || value === "background-canceled") {
    return "canceled";
  }
  return "running";
}

function hasPayload(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "" && value.trim() !== "[]";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function timestampDistanceMs(left: string, right: string): number | null {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return null;
  }
  return Math.abs(leftMs - rightMs);
}

function readAssistantMessageSeq(
  db: DatabaseSync,
  sessionId: string,
  assistantText: string,
  auditCreatedAt: string,
): number | null {
  const rows = db.prepare(`
    SELECT seq, created_at
    FROM session_messages_v6
    WHERE session_id = ?
      AND role = 'assistant'
      AND body = ?
    ORDER BY seq ASC
  `).all(sessionId, assistantText) as Array<{ seq: number; created_at: string }>;
  if (rows.length === 0) {
    return null;
  }
  if (rows.length === 1) {
    return rows[0]?.seq ?? null;
  }

  const candidates = rows
    .map((row) => ({ seq: row.seq, distanceMs: timestampDistanceMs(row.created_at, auditCreatedAt) }))
    .filter((row): row is { seq: number; distanceMs: number } => row.distanceMs !== null)
    .sort((left, right) => left.distanceMs - right.distanceMs || left.seq - right.seq);
  const nearest = candidates[0];
  if (!nearest || nearest.distanceMs > 5 * 60 * 1000) {
    return null;
  }
  const second = candidates[1];
  if (second && second.distanceMs === nearest.distanceMs) {
    return null;
  }
  return nearest.seq;
}

function incrementProviderOutput(
  report: SessionTurnStorageV6DryRunReport,
  kind: ProviderOutputKind,
  count = 1,
): void {
  report.plannedCounts.providerOutputs += count;
  report.plannedCounts.providerOutputsByKind[kind] += count;
}

function readAuditRows(db: DatabaseSync): AuditEventRow[] {
  const auxiliarySessionIdSelect = tableColumnNames(db, "audit_events_v6").has("auxiliary_session_id")
    ? "auxiliary_session_id"
    : "NULL AS auxiliary_session_id";
  return db.prepare(`
    SELECT id, session_id, ${auxiliarySessionIdSelect}, provider_id, summary, metadata_json, created_at
    FROM audit_events_v6
    WHERE event_type = 'session_turn'
    ORDER BY id ASC
  `).all() as AuditEventRow[];
}

function countNonSessionTurnAuditRows(db: DatabaseSync): number {
  if (!tableColumnNames(db, "audit_events_v6").has("event_type")) {
    return 0;
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_events_v6
    WHERE event_type <> 'session_turn'
  `).get() as { count: number };
  return row.count;
}

export function createSessionTurnStorageV6DryRunReport(databaseFile: string): SessionTurnStorageV6DryRunReport {
  const dbPath = resolve(databaseFile);
  if (!existsSync(dbPath)) {
    throw new Error(`database file not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!tableExists(db, "audit_events_v6")) {
      throw new Error("audit_events_v6 table not found");
    }
    if (!tableExists(db, "session_messages_v6")) {
      throw new Error("session_messages_v6 table not found");
    }

    const rows = readAuditRows(db);

    const report: SessionTurnStorageV6DryRunReport = {
      mode: "dry-run",
      input: {
        databaseFile: dbPath,
      },
      sourceCounts: {
        auditSessionTurnRows: rows.length,
        auditEventRows: countRows(db, "audit_events_v6"),
        existingSessionTurnRows: tableExists(db, "session_turns_v6") ? countRows(db, "session_turns_v6") : 0,
        legacyTables: LEGACY_TABLE_CLEANUP_CANDIDATES
          .filter((tableName) => tableExists(db, tableName))
          .map((tableName) => ({
            tableName,
            rows: countRows(db, tableName),
          })),
      },
      plannedCounts: {
        sessionTurns: 0,
        mainAssistantMessages: 0,
        interims: 0,
        providerOutputs: 0,
        providerOutputsByKind: createEmptyProviderOutputCounts(),
      },
      assistantText: {
        completedMatchedFinalMessages: 0,
        completedUnmatchedFinalMessages: 0,
        runningSnapshots: 0,
        terminalPartialResponses: 0,
        empty: 0,
      },
      skipped: {
        invalidMetadataJson: 0,
        nonSessionTurnRows: countNonSessionTurnAuditRows(db),
        orphanTurnRows: 0,
      },
      cleanupCandidates: {
        dropAuditEventsV6: true,
        dropLegacyTables: LEGACY_TABLE_CLEANUP_CANDIDATES.filter((tableName) => tableExists(db, tableName)),
      },
      caveats: [
        "stream delta chunk boundaries cannot be reconstructed from existing audit_events_v6 metadata_json.",
        "completed legacy assistantText is treated as final text; running snapshots and terminal partial responses stay in turn details.",
        "audit_events_v6 is a transitional migration source and can be dropped after all audit rows are migrated or explicitly cleared.",
        "non-session_turn audit_events_v6 rows are not migrated by this script and block destructive cleanup.",
        "orphan audit rows without session_id or auxiliary_session_id are not migrated.",
        "running audit rows only preserve the latest assistantText snapshot that was persisted.",
        "Copilot live-only quota/context/background telemetry cannot be migrated unless it already exists in persisted payload fields.",
      ],
    };

    for (const row of rows) {
      if (!row.session_id && !row.auxiliary_session_id) {
        report.skipped.orphanTurnRows += 1;
        continue;
      }

      const metadata = parseMetadata(row.metadata_json);
      if (!metadata) {
        report.skipped.invalidMetadataJson += 1;
        continue;
      }

      const phase = normalizePhase(metadata.phase);
      report.plannedCounts.sessionTurns += 1;

      if (hasPayload(metadata.logicalPrompt)) {
        incrementProviderOutput(report, "logical_prompt");
      }
      if (hasPayload(metadata.transportPayload)) {
        incrementProviderOutput(report, "transport_payload");
      }
      if (Array.isArray(metadata.operations) && metadata.operations.length > 0) {
        incrementProviderOutput(report, "operation", metadata.operations.length);
      }
      if (hasPayload(metadata.rawItemsJson)) {
        incrementProviderOutput(report, "raw_items");
      }
      if (Array.isArray(metadata.providerMetadata) && metadata.providerMetadata.length > 0) {
        incrementProviderOutput(report, "provider_metadata", metadata.providerMetadata.length);
      }
      if (hasPayload(metadata.usage)) {
        incrementProviderOutput(report, "usage");
      }
      if (typeof metadata.errorMessage === "string" && metadata.errorMessage.trim() !== "") {
        incrementProviderOutput(report, "provider_error");
      }

      const assistantText = typeof metadata.assistantText === "string" ? metadata.assistantText : "";
      if (assistantText.trim() === "") {
        report.assistantText.empty += 1;
        continue;
      }

      if (phase === "completed") {
        const matchedSeq = row.session_id ? readAssistantMessageSeq(db, row.session_id, assistantText, row.created_at) : null;
        if (!row.session_id) {
          report.assistantText.completedUnmatchedFinalMessages += 1;
        } else if (matchedSeq === null) {
          report.assistantText.completedUnmatchedFinalMessages += 1;
        } else {
          report.assistantText.completedMatchedFinalMessages += 1;
        }
        incrementProviderOutput(report, "legacy_assistant_text");
      } else if (phase === "running") {
        report.assistantText.runningSnapshots += 1;
        report.plannedCounts.interims += 1;
      } else {
        report.assistantText.terminalPartialResponses += 1;
        incrementProviderOutput(report, "legacy_assistant_text");
      }
    }

    if (
      report.skipped.invalidMetadataJson > 0
      || report.skipped.nonSessionTurnRows > 0
      || report.skipped.orphanTurnRows > 0
    ) {
      report.cleanupCandidates.dropAuditEventsV6 = false;
    }

    return report;
  } finally {
    db.close();
  }
}

function insertProviderOutput(
  db: DatabaseSync,
  turnId: number,
  seq: number,
  providerId: string,
  kind: ProviderOutputKind,
  summary: string,
  value: unknown,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO session_turn_provider_outputs_v6 (
      turn_id,
      seq,
      provider_id,
      kind,
      summary,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(turnId, seq, providerId, kind, summary, JSON.stringify({ value }), createdAt);
}

function operationSummaryPayload(operation: unknown): string {
  if (typeof operation === "object" && operation !== null) {
    const type = "type" in operation && typeof (operation as { type?: unknown }).type === "string"
      ? (operation as { type: string }).type
      : "";
    const summary = "summary" in operation && typeof (operation as { summary?: unknown }).summary === "string"
      ? (operation as { summary: string }).summary
      : "Operation";
    return JSON.stringify({ type, summary });
  }
  return JSON.stringify({ type: "", summary: "Operation" });
}

function insertTurnProviderOutputs(
  db: DatabaseSync,
  turnId: number,
  row: AuditEventRow,
  metadata: ParsedAuditMetadata,
  phase: SessionTurnPhase,
  assistantMessageSeq: number | null,
): void {
  let seq = 0;
  const providerId = typeof metadata.provider === "string" ? metadata.provider : row.provider_id;
  if (hasPayload(metadata.logicalPrompt)) {
    insertProviderOutput(db, turnId, seq, providerId, "logical_prompt", "Logical Prompt", metadata.logicalPrompt, row.created_at);
    seq += 1;
  }
  if (hasPayload(metadata.transportPayload)) {
    const summary = typeof metadata.transportPayload === "object"
      && metadata.transportPayload !== null
      && "summary" in metadata.transportPayload
      && typeof (metadata.transportPayload as { summary?: unknown }).summary === "string"
      ? (metadata.transportPayload as { summary: string }).summary
      : "Transport Payload";
    insertProviderOutput(db, turnId, seq, providerId, "transport_payload", summary, metadata.transportPayload, row.created_at);
    seq += 1;
  }
  if (Array.isArray(metadata.operations)) {
    for (const operation of metadata.operations) {
      insertProviderOutput(db, turnId, seq, providerId, "operation", operationSummaryPayload(operation), operation, row.created_at);
      seq += 1;
    }
  }
  if (hasPayload(metadata.rawItemsJson)) {
    insertProviderOutput(db, turnId, seq, providerId, "raw_items", "Raw Items", metadata.rawItemsJson, row.created_at);
    seq += 1;
  }
  if (Array.isArray(metadata.providerMetadata)) {
    for (const providerMetadata of metadata.providerMetadata) {
      const summary = typeof providerMetadata === "object"
        && providerMetadata !== null
        && "summary" in providerMetadata
        && typeof (providerMetadata as { summary?: unknown }).summary === "string"
        ? (providerMetadata as { summary: string }).summary
        : "Provider Metadata";
      insertProviderOutput(db, turnId, seq, providerId, "provider_metadata", summary, providerMetadata, row.created_at);
      seq += 1;
    }
  }
  if (hasPayload(metadata.usage)) {
    insertProviderOutput(db, turnId, seq, providerId, "usage", "Usage", metadata.usage, row.created_at);
    seq += 1;
  }
  if (typeof metadata.errorMessage === "string" && metadata.errorMessage.trim() !== "") {
    insertProviderOutput(db, turnId, seq, providerId, "provider_error", "Provider Error", metadata.errorMessage, row.created_at);
    seq += 1;
  }
  if (
    phase !== "running"
    && typeof metadata.assistantText === "string"
    && metadata.assistantText.trim() !== ""
  ) {
    insertProviderOutput(db, turnId, seq, providerId, "legacy_assistant_text", "Assistant Text", metadata.assistantText, row.created_at);
  }
}

function insertMigrationInterim(db: DatabaseSync, turnId: number, body: string, createdAt: string): void {
  if (body.trim() === "") {
    return;
  }
  db.prepare(`
    INSERT INTO session_turn_interims_v6 (
      turn_id,
      seq,
      body,
      source,
      created_at
    ) VALUES (?, 0, ?, 'migration', ?)
  `).run(turnId, body, createdAt);
}

function dropCleanupTables(db: DatabaseSync, report: SessionTurnStorageV6DryRunReport): void {
  db.exec("DROP TABLE IF EXISTS audit_events_v6;");
  if (report.cleanupCandidates.dropLegacyTables.length > 0) {
    cleanupForbiddenV6Tables(db);
  }
}

function countMigratableAuditRowsMissingTurns(db: DatabaseSync): number {
  return readAuditRows(db).filter((row) => {
    if (!row.session_id && !row.auxiliary_session_id) {
      return false;
    }
    if (!parseMetadata(row.metadata_json)) {
      return false;
    }
    const migrated = db.prepare(`
      SELECT 1
      FROM session_turns_v6
      WHERE id = ?
        AND EXISTS (
          SELECT 1
          FROM session_turn_provider_outputs_v6
          WHERE turn_id = session_turns_v6.id
        )
    `).get(row.id);
    return !migrated;
  }).length;
}

export function migrateSessionTurnStorageV6(databaseFile: string, migratedAt = new Date().toISOString()): SessionTurnStorageV6WriteReport {
  const dryRunReport = createSessionTurnStorageV6DryRunReport(databaseFile);
  const hasSkippedRows =
    dryRunReport.skipped.invalidMetadataJson > 0
    || dryRunReport.skipped.nonSessionTurnRows > 0
    || dryRunReport.skipped.orphanTurnRows > 0;
  const dbPath = resolve(databaseFile);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("BEGIN IMMEDIATE;");
    try {
      ensureV6Schema(db);
      if (dryRunReport.sourceCounts.existingSessionTurnRows > 0 && !hasSkippedRows) {
        const missingTurnRows = countMigratableAuditRowsMissingTurns(db);
        if (missingTurnRows > 0) {
          throw new Error("session_turns_v6 already has rows; refusing to migrate audit_events_v6 again");
        }
      }
      const rows = readAuditRows(db);
      for (const row of rows) {
        if (!row.session_id && !row.auxiliary_session_id) {
          continue;
        }
        const metadata = parseMetadata(row.metadata_json);
        if (!metadata) {
          continue;
        }
        const assistantText = typeof metadata.assistantText === "string" ? metadata.assistantText : "";
        const phase = normalizePhase(metadata.phase);
        const assistantMessageSeq = phase === "completed"
          && row.session_id
          && assistantText.trim() !== ""
          ? readAssistantMessageSeq(db, row.session_id, assistantText, row.created_at)
          : null;
        const insertTurnResult = db.prepare(`
          INSERT OR IGNORE INTO session_turns_v6 (
            id,
            session_id,
            auxiliary_session_id,
            phase,
            provider_id,
            model_id,
            reasoning_effort,
            approval_mode,
            thread_id,
            summary,
            error_summary,
            assistant_message_seq,
            started_at,
            completed_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.id,
          row.session_id,
          row.auxiliary_session_id,
          phase,
          typeof metadata.provider === "string" ? metadata.provider : row.provider_id,
          typeof metadata.model === "string" ? metadata.model : "",
          typeof metadata.reasoningEffort === "string" ? metadata.reasoningEffort : "",
          typeof metadata.approvalMode === "string" ? metadata.approvalMode : "",
          typeof metadata.threadId === "string" ? metadata.threadId : "",
          row.summary,
          typeof metadata.errorMessage === "string" ? metadata.errorMessage : "",
          assistantMessageSeq,
          row.created_at,
          phase === "running" ? null : row.created_at,
          row.created_at,
        );
        if (insertTurnResult.changes === 0) {
          continue;
        }
        insertTurnProviderOutputs(db, row.id, row, metadata, phase, assistantMessageSeq);
        if (phase === "running") {
          insertMigrationInterim(db, row.id, assistantText, row.created_at);
        }
      }
      if (!hasSkippedRows) {
        db.prepare(`
          INSERT INTO app_settings (setting_key, setting_value, updated_at)
          VALUES ('session_turn_storage_v6_migrated_at', ?, ?)
          ON CONFLICT(setting_key) DO UPDATE SET
            setting_value = excluded.setting_value,
            updated_at = excluded.updated_at
        `).run(migratedAt, migratedAt);
        dropCleanupTables(db, dryRunReport);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    return {
      ...dryRunReport,
      mode: "write",
      migratedAt,
    };
  } finally {
    db.close();
  }
}

function usage(): string {
  return "Usage: npx tsx scripts/migrate-session-turn-storage-v6.ts (--dry-run | --write) --v6 <path-to-withmate-v6.db>";
}

function parseArgs(argv: string[]): { mode: "dry-run" | "write" | null; databaseFile: string | null } {
  const mode = argv.includes("--write") ? "write" : argv.includes("--dry-run") ? "dry-run" : null;
  const databaseFileIndex = argv.indexOf("--v6");
  return {
    mode,
    databaseFile: databaseFileIndex >= 0 ? argv[databaseFileIndex + 1] ?? null : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || !args.databaseFile) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    const report = args.mode === "write"
      ? migrateSessionTurnStorageV6(args.databaseFile)
      : createSessionTurnStorageV6DryRunReport(args.databaseFile);
    console.log(JSON.stringify(report, null, 2));
  }
}
