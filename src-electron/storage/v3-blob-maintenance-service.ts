import type { DatabaseSync } from "node:sqlite";

import { openAppDatabase } from "./sqlite-connection.js";
import { type BlobGcReport, TextBlobStore } from "./text-blob-store.js";

/** V3 DB と対応する Blob 領域を指定する。削除には dryRun: false が必要で、ファイルの猶予期間は任意。 */
export type V3BlobMaintenanceInput = {
  dbPath: string;
  blobRootPath: string;
  dryRun?: boolean;
  graceMs?: number;
};

/** 参照元と登録済み Blob の一覧、孤立・欠損の検出結果、ファイルの整理結果をまとめる。 */
export type V3BlobMaintenanceReport = {
  dryRun: boolean;
  referencedBlobIds: string[];
  blobObjectIds: string[];
  orphanBlobObjectIds: string[];
  missingReferencedBlobIds: string[];
  missingBlobObjectIds: string[];
  garbage: BlobGcReport;
};

/** 参照列やオブジェクト一覧を同じ列名で走査するための問い合わせ結果。 */
type BlobIdRow = {
  blob_id: string | null;
};

const BLOB_REFERENCE_QUERIES = [
  "SELECT text_blob_id AS blob_id FROM session_messages WHERE text_blob_id IS NOT NULL",
  "SELECT artifact_blob_id AS blob_id FROM session_message_artifacts WHERE artifact_blob_id IS NOT NULL",
] as const;

const OPTIONAL_BLOB_REFERENCE_COLUMNS = {
  audit_log_details: [
    "logical_prompt_blob_id",
    "transport_payload_blob_id",
    "assistant_text_blob_id",
    "raw_items_blob_id",
    "usage_blob_id",
  ],
  audit_log_operations: ["details_blob_id"],
} as const;

/** 空の値と重複を除き、照合や報告に使う Blob ID を昇順に揃える。 */
function compactBlobIds(values: Iterable<string | null | undefined>): string[] {
  return [
    ...new Set(
      [...values].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ].sort();
}

/** メッセージと添付成果物に加え、存在する旧監査テーブルからも Blob 参照を集め、削除対象から除外できるようにする。 */
function readReferencedBlobIds(db: DatabaseSync): string[] {
  const blobIds: string[] = [];
  const queries: string[] = [...BLOB_REFERENCE_QUERIES];
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  );
  for (const [table, columns] of Object.entries(
    OPTIONAL_BLOB_REFERENCE_COLUMNS,
  )) {
    if (tableExists.get(table)) {
      queries.push(
        ...columns.map(
          (column) =>
            `SELECT ${column} AS blob_id FROM ${table} WHERE ${column} IS NOT NULL`,
        ),
      );
    }
  }
  for (const query of queries) {
    const rows = db.prepare(query).all() as BlobIdRow[];
    for (const row of rows) {
      blobIds.push(row.blob_id ?? "");
    }
  }
  return compactBlobIds(blobIds);
}

/** Blob オブジェクト表に登録された ID を、参照一覧と照合できる形で取得する。 */
function readBlobObjectIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT blob_id FROM blob_objects ORDER BY blob_id")
    .all() as BlobIdRow[];
  return compactBlobIds(rows.map((row) => row.blob_id));
}

/** 孤立が確認されたオブジェクト行を一つのトランザクションで削除し、失敗時はロールバックする。 */
function deleteBlobObjectRows(
  db: DatabaseSync,
  blobIds: readonly string[],
): void {
  if (blobIds.length === 0) {
    return;
  }
  const statement = db.prepare("DELETE FROM blob_objects WHERE blob_id = ?");
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const blobId of blobIds) {
      statement.run(blobId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** V3 DB の参照を基準に孤立・欠損を報告する。明示的に削除を有効にした場合のみ、未参照の登録行と猶予期間を過ぎた未参照ファイルを整理する。 */
export async function repairV3Blobs(
  input: V3BlobMaintenanceInput,
): Promise<V3BlobMaintenanceReport> {
  const dryRun = input.dryRun !== false;
  const blobStore = new TextBlobStore(input.blobRootPath);
  const { referencedBlobIds, blobObjectIds } = (() => {
    const db = openAppDatabase(input.dbPath);
    try {
      return {
        referencedBlobIds: readReferencedBlobIds(db),
        blobObjectIds: readBlobObjectIds(db),
      };
    } finally {
      db.close();
    }
  })();
  const referencedSet = new Set(referencedBlobIds);
  const orphanBlobObjectIds = blobObjectIds.filter(
    (blobId) => !referencedSet.has(blobId),
  );
  const missingReferencedBlobIds: string[] = [];
  const missingBlobObjectIds: string[] = [];

  await Promise.all(
    referencedBlobIds.map(async (blobId) => {
      if ((await blobStore.stat(blobId)) === null) {
        missingReferencedBlobIds.push(blobId);
      }
    }),
  );
  await Promise.all(
    blobObjectIds.map(async (blobId) => {
      if ((await blobStore.stat(blobId)) === null) {
        missingBlobObjectIds.push(blobId);
      }
    }),
  );
  missingReferencedBlobIds.sort();
  missingBlobObjectIds.sort();

  if (!dryRun && orphanBlobObjectIds.length > 0) {
    const db = openAppDatabase(input.dbPath);
    try {
      deleteBlobObjectRows(db, orphanBlobObjectIds);
    } finally {
      db.close();
    }
  }

  const garbage = await blobStore.collectGarbage({
    referencedBlobIds,
    dryRun,
    graceMs: input.graceMs,
  });

  return {
    dryRun,
    referencedBlobIds,
    blobObjectIds,
    orphanBlobObjectIds,
    missingReferencedBlobIds,
    missingBlobObjectIds,
    garbage,
  };
}
