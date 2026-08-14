import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { CharacterAffectTurnSettlementStorage } from "../src-electron/character-affect-turn-settlement-storage.js";

type RecoveryCommand =
  | { kind: "inspect"; dbPath: string }
  | { kind: "release"; dbPath: string; correlationId: string; appStoppedConfirmed: true };

export function parseCharacterAffectTurnRecoveryCommand(args: readonly string[]): RecoveryCommand {
  const valueAfter = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  const dbPath = valueAfter("--db");
  if (!dbPath || !path.isAbsolute(dbPath)) {
    throw new Error("--db requires an absolute application database path.");
  }
  if (!existsSync(dbPath)) {
    throw new Error("The application database does not exist.");
  }
  if (args.includes("--inspect")) {
    return { kind: "inspect", dbPath };
  }
  const correlationId = valueAfter("--release");
  if (correlationId) {
    if (!args.includes("--confirm-app-stopped")) {
      throw new Error("--release requires --confirm-app-stopped.");
    }
    return { kind: "release", dbPath, correlationId, appStoppedConfirmed: true };
  }
  throw new Error("Specify --inspect or --release <correlation-id>.");
}

export function inspectCharacterAffectTurnSettlements(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(character_affect_turn_settlements)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "quarantined_at")) {
      throw new Error("The database has not been opened by a version with Issue #289 recovery metadata.");
    }
    const summary = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' AND quarantined_at IS NULL THEN 1 ELSE 0 END) AS recoverable,
        SUM(CASE WHEN status = 'pending' AND quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS quarantined,
        SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END) AS settled
      FROM character_affect_turn_settlements
    `).get();
    const quarantined = db.prepare(`
      SELECT correlation_id AS correlationId, session_id AS sessionId,
             attempt_count AS attemptCount, quarantined_at AS quarantinedAt,
             last_failure_code AS failureCode, last_failure_stage AS failureStage,
             last_error_name AS errorName, last_duration_ms AS durationMs
      FROM character_affect_turn_settlements
      WHERE status = 'pending' AND quarantined_at IS NOT NULL
      ORDER BY quarantined_at ASC, correlation_id ASC
    `).all();
    return { summary, quarantined };
  } finally {
    db.close();
  }
}

export function releaseCharacterAffectTurnSettlement(dbPath: string, correlationId: string): unknown {
  const storage = new CharacterAffectTurnSettlementStorage(dbPath);
  try {
    if (!storage.releaseQuarantined(correlationId)) {
      throw new Error("The quarantined Character affect settlement was not found.");
    }
    const released = storage.getPending(correlationId);
    if (!released || released.quarantinedAt !== null || released.attemptCount !== 0) {
      throw new Error("The Character affect settlement release could not be read back.");
    }
    return {
      correlationId: released.correlationId,
      sessionId: released.sessionId,
      state: "ready",
      attemptCount: released.attemptCount,
      nextAttemptAt: released.nextAttemptAt,
      evaluationPersisted: released.evaluation !== null,
    };
  } finally {
    storage.close();
  }
}

export function runCharacterAffectTurnSettlementRecovery(args: readonly string[]): unknown {
  const command = parseCharacterAffectTurnRecoveryCommand(args);
  return command.kind === "inspect"
    ? inspectCharacterAffectTurnSettlements(command.dbPath)
    : releaseCharacterAffectTurnSettlement(command.dbPath, command.correlationId);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${JSON.stringify(runCharacterAffectTurnSettlementRecovery(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
