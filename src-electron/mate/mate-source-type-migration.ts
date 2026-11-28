import type { DatabaseSync } from "node:sqlite";

const LEGACY_MATE_SOURCE_TYPE_CHECK =
  "source_type IN ('session', 'manual', 'system')";

/** スキーマ SQL からテーブル作成文だけを切り出し、見つからなければ失敗させる。 */
function extractCreateTableStatement(schemaSql: string): string {
  const tableMatch = schemaSql.match(
    /CREATE TABLE IF NOT EXISTS[\s\S]*?;(?:\s*\n\s*CREATE (?:UNIQUE )?INDEX|\s*$)/i,
  );

  if (!tableMatch) {
    throw new Error("create table statement が見つからなかったよ。");
  }

  return tableMatch[0]
    .replace(/\n\s*CREATE (?:UNIQUE )?INDEX[\s\S]*$/i, "")
    .trim();
}

/** テーブル再作成後に戻す通常・一意インデックスの作成文を、スキーマ SQL から取り出す。 */
function extractIndexStatements(schemaSql: string): string[] {
  const indexMatches = schemaSql.match(
    /\n\s*CREATE (?:UNIQUE )?INDEX[\s\S]*?;/gi,
  );
  return indexMatches ? indexMatches.map((statement) => statement.trim()) : [];
}

/** 移行後の復元に備えて、接続の外部キー検査が有効かを読み取る。 */
function isForeignKeysEnabled(db: DatabaseSync): boolean {
  const pragma = db.prepare("PRAGMA foreign_keys").get() as
    { foreign_keys: number } | undefined;
  return pragma?.foreign_keys === 1;
}

/** 移行後の復元に備えて、接続が旧式のテーブル名変更の挙動を使うか読み取る。 */
function isLegacyAlterTableEnabled(db: DatabaseSync): boolean {
  const pragma = db.prepare("PRAGMA legacy_alter_table").get() as
    { legacy_alter_table: number } | undefined;
  return pragma?.legacy_alter_table === 1;
}

/** 旧来の source_type 制約を持つテーブルだけを再作成し、既存行とインデックスを戻して mate_talk を許可する。接続設定は復元する。 */
export function ensureSourceTypeCheckSupportsMateTalk(
  db: DatabaseSync,
  tableName: string,
  createTableSql: string,
): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql: string } | undefined;

  if (!table?.sql) {
    return;
  }

  if (
    !table.sql.includes(LEGACY_MATE_SOURCE_TYPE_CHECK) ||
    table.sql.includes("'mate_talk'")
  ) {
    return;
  }

  const createTableStatement = extractCreateTableStatement(createTableSql);
  const indexStatements = extractIndexStatements(createTableSql);
  const tempTableName = `${tableName}__mate_talk_migration`;
  const oldTableName = `${tableName}`;
  const wasForeignKeysEnabled = isForeignKeysEnabled(db);
  const wasLegacyAlterTableEnabled = isLegacyAlterTableEnabled(db);

  try {
    if (wasForeignKeysEnabled) {
      db.exec("PRAGMA foreign_keys = OFF;");
    }
    if (!wasLegacyAlterTableEnabled) {
      db.exec("PRAGMA legacy_alter_table = ON;");
    }

    db.exec(`ALTER TABLE ${oldTableName} RENAME TO ${tempTableName}`);
    db.exec(createTableStatement);
    db.exec(`INSERT INTO ${oldTableName} SELECT * FROM ${tempTableName}`);
    db.exec(`DROP TABLE ${tempTableName}`);
    for (const indexSql of indexStatements) {
      db.exec(indexSql);
    }
  } finally {
    if (!wasLegacyAlterTableEnabled) {
      db.exec("PRAGMA legacy_alter_table = OFF;");
    }
    if (wasForeignKeysEnabled) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
}
