import type { DatabaseSync } from "node:sqlite";

import { openAppDatabase } from "./sqlite-connection.js";
import { type BlobGcReport, TextBlobStore } from "./text-blob-store.js";

export type V3BlobMaintenanceInput = {
  dbPath: string;
  blobRootPath: string;
  dryRun?: boolean;
  graceMs?: number;
};

export type V3BlobMaintenanceReport = {
  dryRun: boolean;
  referencedBlobIds: string[];
  blobObjectIds: string[];
  orphanBlobObjectIds: string[];
  missingReferencedBlobIds: string[];
  missingBlobObjectIds: string[];
  garbage: BlobGcReport;
};

type BlobIdRow = {
  blob_id: string | null;
};

const BLOB_REFERENCE_QUERIES = [
  "SELECT text_blob_id AS blob_id FROM session_messages WHERE text_blob_id IS NOT NULL",
  "SELECT artifact_blob_id AS blob_id FROM session_message_artifacts WHERE artifact_blob_id IS NOT NULL",
  "SELECT logical_prompt_blob_id AS blob_id FROM audit_log_details WHERE logical_prompt_blob_id IS NOT NULL",
  "SELECT transport_payload_blob_id AS blob_id FROM audit_log_details WHERE transport_payload_blob_id IS NOT NULL",
  "SELECT assistant_text_blob_id AS blob_id FROM audit_log_details WHERE assistant_text_blob_id IS NOT NULL",
  "SELECT raw_items_blob_id AS blob_id FROM audit_log_details WHERE raw_items_blob_id IS NOT NULL",
  "SELECT usage_blob_id AS blob_id FROM audit_log_details WHERE usage_blob_id IS NOT NULL",
  "SELECT details_blob_id AS blob_id FROM audit_log_operations WHERE details_blob_id IS NOT NULL",
  "SELECT character_role_blob_id AS blob_id FROM companion_sessions WHERE character_role_blob_id IS NOT NULL",
  "SELECT text_blob_id AS blob_id FROM companion_messages WHERE text_blob_id IS NOT NULL",
  "SELECT artifact_blob_id AS blob_id FROM companion_message_artifacts WHERE artifact_blob_id IS NOT NULL",
  "SELECT diff_snapshot_blob_id AS blob_id FROM companion_merge_runs WHERE diff_snapshot_blob_id IS NOT NULL",
  "SELECT logical_prompt_blob_id AS blob_id FROM companion_audit_log_details WHERE logical_prompt_blob_id IS NOT NULL",
  "SELECT transport_payload_blob_id AS blob_id FROM companion_audit_log_details WHERE transport_payload_blob_id IS NOT NULL",
  "SELECT assistant_text_blob_id AS blob_id FROM companion_audit_log_details WHERE assistant_text_blob_id IS NOT NULL",
  "SELECT raw_items_blob_id AS blob_id FROM companion_audit_log_details WHERE raw_items_blob_id IS NOT NULL",
  "SELECT usage_blob_id AS blob_id FROM companion_audit_log_details WHERE usage_blob_id IS NOT NULL",
  "SELECT details_blob_id AS blob_id FROM companion_audit_log_operations WHERE details_blob_id IS NOT NULL",
] as const;

function compactBlobIds(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function readReferencedBlobIds(db: DatabaseSync): string[] {
  const blobIds: string[] = [];
  for (const query of BLOB_REFERENCE_QUERIES) {
    const rows = db.prepare(query).all() as BlobIdRow[];
    for (const row of rows) {
      blobIds.push(row.blob_id ?? "");
    }
  }
  return compactBlobIds(blobIds);
}

function readBlobObjectIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT blob_id FROM blob_objects ORDER BY blob_id").all() as BlobIdRow[];
  return compactBlobIds(rows.map((row) => row.blob_id));
}

function deleteBlobObjectRows(db: DatabaseSync, blobIds: readonly string[]): void {
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

export async function repairV3Blobs(input: V3BlobMaintenanceInput): Promise<V3BlobMaintenanceReport> {
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
  const orphanBlobObjectIds = blobObjectIds.filter((blobId) => !referencedSet.has(blobId));
  const missingReferencedBlobIds: string[] = [];
  const missingBlobObjectIds: string[] = [];

  await Promise.all(referencedBlobIds.map(async (blobId) => {
    if (await blobStore.stat(blobId) === null) {
      missingReferencedBlobIds.push(blobId);
    }
  }));
  await Promise.all(blobObjectIds.map(async (blobId) => {
    if (await blobStore.stat(blobId) === null) {
      missingBlobObjectIds.push(blobId);
    }
  }));
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
