import type { DatabaseSync } from "node:sqlite";
import type { LocalPrComment, LocalPrDetail, LocalPrVersion } from "../../src-shared/local-pr/local-pr-contract.js";
import { assertRuntimeTurnAdmission } from "../platform/agent-runtime/runtime-turn-admission.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/** Persisted fields that do not depend on a live Git ref. */
export type LocalPrSummary = Omit<LocalPrDetail, "versions" | "comments" | "approval" | "currentTargetCommit">;

/** A read snapshot used for SQLite compare-and-swap, never exposed to public callers. */
export type LocalPrRecord = {
  revision: number;
  summary: LocalPrSummary;
  approval: LocalPrDetail["approval"];
  versions: LocalPrVersion[];
  comments: LocalPrComment[];
};

/** One atomic change to a review and its dependent rows. */
export type LocalPrChange = {
  summary: LocalPrSummary;
  approval: LocalPrDetail["approval"];
  version?: LocalPrVersion;
  comments?: LocalPrComment[];
  deleteDraft?: string;
};

/** Async interface exposed by the existing SQLite Worker. */
export type LocalPrStore = {
  listLocalPrs(repositoryId: string, offset: number, limit: number): Promise<LocalPrSummary[]>;
  readLocalPr(repositoryId: string, prId: string, includeDrafts: boolean): Promise<LocalPrRecord | null>;
  createLocalPr(repositoryId: string, summary: LocalPrSummary, version: LocalPrVersion): Promise<void>;
  saveLocalPr(repositoryId: string, expectedRevision: number, change: LocalPrChange): Promise<boolean>;
};

type JsonRow = { value: string };
type PrRow = { revision: number; summary_json: string; approval_json: string | null };

/** Owns SQL for the Local PR feature inside the persistent store Worker. */
export class LocalPrStorage {
  private readonly db: DatabaseSync;

  /** The Worker has already installed the schema before making this connection. */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  /** Releases the connection with the storage generation. */
  close(): void {
    this.db.close();
  }

  /** Projects a page without loading review conversations or Git objects. */
  listLocalPrs(repositoryId: string, offset: number, limit: number): LocalPrSummary[] {
    assertRuntimeTurnAdmission();
    const rows = this.db.prepare(`
      SELECT summary_json AS value FROM local_prs_v7 WHERE repository_id=?
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?
    `).all(repositoryId, limit, offset) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value) as LocalPrSummary);
  }

  /** Reads a consistent version/comment snapshot, excluding drafts at the SQL boundary for Agents. */
  readLocalPr(repositoryId: string, prId: string, includeDrafts: boolean): LocalPrRecord | null {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT revision, summary_json, approval_json FROM local_prs_v7 WHERE repository_id=? AND id=?
      `).get(repositoryId, prId) as PrRow | undefined;
      // A PR ID from another repository is indistinguishable from an unknown ID.
      if (!row) return null;
      const versions = this.db.prepare(`
        SELECT version_json AS value FROM local_pr_versions_v7 WHERE repository_id=? AND pr_id=? ORDER BY version
      `).all(repositoryId, prId) as JsonRow[];
      const comments = this.db.prepare(`
        SELECT comment_json AS value FROM local_pr_comments_v7
        WHERE repository_id=? AND pr_id=? AND (? OR draft=0) ORDER BY created_at, id
      `).all(repositoryId, prId, Number(includeDrafts)) as JsonRow[];
      return {
        revision: row.revision,
        summary: JSON.parse(row.summary_json) as LocalPrSummary,
        approval: row.approval_json === null ? null : JSON.parse(row.approval_json) as LocalPrDetail["approval"],
        versions: versions.map((version) => JSON.parse(version.value) as LocalPrVersion),
        comments: comments.map((comment) => JSON.parse(comment.value) as LocalPrComment),
      };
    });
  }

  /** Inserts the PR and initial pinned version together. */
  createLocalPr(repositoryId: string, summary: LocalPrSummary, version: LocalPrVersion): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO local_prs_v7(repository_id,id,updated_at,revision,summary_json) VALUES(?,?,?,1,?)
      `).run(repositoryId, summary.id, summary.updatedAt, JSON.stringify(summary));
      this.insertVersion(repositoryId, summary.id, version);
    });
  }

  /** Applies a change only to the exact snapshot reviewed by the service. */
  saveLocalPr(repositoryId: string, expectedRevision: number, change: LocalPrChange): boolean {
    return this.transaction(() => {
      const id = change.summary.id;
      const update = this.db.prepare(`
        UPDATE local_prs_v7 SET revision=revision+1, updated_at=?, summary_json=?, approval_json=?
        WHERE repository_id=? AND id=? AND revision=?
      `).run(change.summary.updatedAt, JSON.stringify(change.summary),
        change.approval ? JSON.stringify(change.approval) : null, repositoryId, id, expectedRevision);
      // No dependent rows can be modified if the PR changed after the service read it.
      if (!update.changes) return false;
      // Submitted versions are insert-only, unlike the presentation state.
      if (change.version) this.insertVersion(repositoryId, id, change.version);
      // Publish, add, or edit all requested comment rows in the same transaction.
      for (const comment of change.comments ?? []) {
        this.db.prepare(`
          INSERT INTO local_pr_comments_v7(repository_id,pr_id,id,version,draft,created_at,comment_json) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(repository_id,pr_id,id) DO UPDATE SET draft=excluded.draft, comment_json=excluded.comment_json
        `).run(repositoryId, id, comment.id, comment.version, Number(comment.draft), comment.createdAt, JSON.stringify(comment));
      }
      // Published comments are not deletable through the draft operation.
      if (change.deleteDraft) {
        this.db.prepare("DELETE FROM local_pr_comments_v7 WHERE repository_id=? AND pr_id=? AND id=? AND draft=1")
          .run(repositoryId, id, change.deleteDraft);
      }
      return true;
    });
  }

  /** Records immutable Git endpoints for a new version. */
  private insertVersion(repositoryId: string, prId: string, version: LocalPrVersion): void {
    this.db.prepare("INSERT INTO local_pr_versions_v7(repository_id,pr_id,version,version_json) VALUES(?,?,?,?)")
      .run(repositoryId, prId, version.version, JSON.stringify(version));
  }

  /** Uses SQLite to keep PR state and its dependent rows consistent across connections. */
  private transaction<T>(operation: () => T): T {
    assertRuntimeTurnAdmission();
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // No dependent writes should survive a failed statement.
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
