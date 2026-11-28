import type { DatabaseSync } from "node:sqlite";
import type {
  LocalPrComment,
  LocalPrDetail,
  LocalPrVersion,
} from "../../src-shared/local-pr/local-pr-contract.js";
import { assertRuntimeTurnAdmission } from "../platform/agent-runtime/runtime-turn-admission.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/** 現在の Git ref に依存しない保存項目。 */
export type LocalPrSummary = Omit<
  LocalPrDetail,
  "versions" | "comments" | "approval" | "currentTargetCommit"
>;

/** SQLite の比較・交換に使う読み取りスナップショット。公開の呼び出し元には開示しない。 */
export type LocalPrRecord = {
  revision: number;
  summary: LocalPrSummary;
  approval: LocalPrDetail["approval"];
  versions: LocalPrVersion[];
  comments: LocalPrComment[];
};

/** レビューとその従属行に対する、一つのアトミックな変更。 */
export type LocalPrChange = {
  summary: LocalPrSummary;
  approval: LocalPrDetail["approval"];
  version?: LocalPrVersion;
  comments?: LocalPrComment[];
  deleteDraft?: string;
};

/** 既存の SQLite Worker が公開する非同期インターフェース。 */
export type LocalPrStore = {
  /** リポジトリの PR 概要を更新日時順でページ読み取りする。版やコメントの内容は含めない。 */
  listLocalPrs(
    repositoryId: string,
    offset: number,
    limit: number,
  ): Promise<LocalPrSummary[]>;
  /** 同じリポジトリの PR を一貫した状態で読み、要求元に必要な場合だけ下書きを含める。 */
  readLocalPr(
    repositoryId: string,
    prId: string,
    includeDrafts: boolean,
  ): Promise<LocalPrRecord | null>;
  /** レビューの概要と比較端点を固定した初版を同時に保存する。 */
  createLocalPr(
    repositoryId: string,
    summary: LocalPrSummary,
    version: LocalPrVersion,
  ): Promise<void>;
  /** 期待リビジョンと一致した PR にだけ変更を適用する。不一致は false を返す。 */
  saveLocalPr(
    repositoryId: string,
    expectedRevision: number,
    change: LocalPrChange,
  ): Promise<boolean>;
};

/** SQLite で別名を付けて取得する、概要・提出版・コメントなどの JSON 列。 */
type JsonRow = { value: string };
/** PR の比較・交換に使う版番号と、保存済みの概要・承認の JSON 列。 */
type PrRow = {
  revision: number;
  summary_json: string;
  approval_json: string | null;
};

/** 永続ストア Worker 内で Local PR 機能の SQL を担う。 */
export class LocalPrStorage {
  private readonly db: DatabaseSync;

  /** この接続を開く時点で、Worker はスキーマを適用済み。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
  }

  /** ストレージ世代の終了に合わせて接続を解放する。 */
  close(): void {
    this.db.close();
  }

  /** レビューの会話や Git オブジェクトを読み込まずに、表示用の一ページを組み立てる。 */
  listLocalPrs(
    repositoryId: string,
    offset: number,
    limit: number,
  ): LocalPrSummary[] {
    assertRuntimeTurnAdmission();
    const rows = this.db
      .prepare(
        `
      SELECT summary_json AS value FROM local_prs_v7 WHERE repository_id=?
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?
    `,
      )
      .all(repositoryId, limit, offset) as JsonRow[];
    return rows.map((row) => JSON.parse(row.value) as LocalPrSummary);
  }

  /** 版とコメントを一貫したスナップショットから読み取る。Agent 向けでは SQL の段階で下書きを除外する。 */
  readLocalPr(
    repositoryId: string,
    prId: string,
    includeDrafts: boolean,
  ): LocalPrRecord | null {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `
        SELECT revision, summary_json, approval_json FROM local_prs_v7 WHERE repository_id=? AND id=?
      `,
        )
        .get(repositoryId, prId) as PrRow | undefined;
      // 別リポジトリの PR ID は、未知の ID と区別しない。
      if (!row) return null;
      const versions = this.db
        .prepare(
          `
        SELECT version_json AS value FROM local_pr_versions_v7 WHERE repository_id=? AND pr_id=? ORDER BY version
      `,
        )
        .all(repositoryId, prId) as JsonRow[];
      const comments = this.db
        .prepare(
          `
        SELECT comment_json AS value FROM local_pr_comments_v7
        WHERE repository_id=? AND pr_id=? AND (? OR draft=0) ORDER BY created_at, id
      `,
        )
        .all(repositoryId, prId, Number(includeDrafts)) as JsonRow[];
      return {
        revision: row.revision,
        summary: JSON.parse(row.summary_json) as LocalPrSummary,
        approval:
          row.approval_json === null
            ? null
            : (JSON.parse(row.approval_json) as LocalPrDetail["approval"]),
        versions: versions.map(
          (version) => JSON.parse(version.value) as LocalPrVersion,
        ),
        comments: comments.map(
          (comment) => JSON.parse(comment.value) as LocalPrComment,
        ),
      };
    });
  }

  /** PR と、コミットを固定した初版をまとめて挿入する。 */
  createLocalPr(
    repositoryId: string,
    summary: LocalPrSummary,
    version: LocalPrVersion,
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO local_prs_v7(repository_id,id,updated_at,revision,summary_json) VALUES(?,?,?,1,?)
      `,
        )
        .run(
          repositoryId,
          summary.id,
          summary.updatedAt,
          JSON.stringify(summary),
        );
      this.insertVersion(repositoryId, summary.id, version);
    });
  }

  /** サービスが確認したスナップショットと完全に一致する場合だけ変更を適用する。 */
  saveLocalPr(
    repositoryId: string,
    expectedRevision: number,
    change: LocalPrChange,
  ): boolean {
    return this.transaction(() => {
      const id = change.summary.id;
      const update = this.db
        .prepare(
          `
        UPDATE local_prs_v7 SET revision=revision+1, updated_at=?, summary_json=?, approval_json=?
        WHERE repository_id=? AND id=? AND revision=?
      `,
        )
        .run(
          change.summary.updatedAt,
          JSON.stringify(change.summary),
          change.approval ? JSON.stringify(change.approval) : null,
          repositoryId,
          id,
          expectedRevision,
        );
      // サービスが読み取った後に PR が変わっていれば、従属行は変更できない。
      if (!update.changes) return false;
      // 表示用の状態と異なり、提出版は追加のみで更新しない。
      if (change.version) this.insertVersion(repositoryId, id, change.version);
      // 要求されたすべてのコメント行の公開・追加・編集を同じトランザクションで行う。
      for (const comment of change.comments ?? []) {
        this.db
          .prepare(
            `
          INSERT INTO local_pr_comments_v7(repository_id,pr_id,id,version,draft,created_at,comment_json) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(repository_id,pr_id,id) DO UPDATE SET draft=excluded.draft, comment_json=excluded.comment_json
        `,
          )
          .run(
            repositoryId,
            id,
            comment.id,
            comment.version,
            Number(comment.draft),
            comment.createdAt,
            JSON.stringify(comment),
          );
      }
      // 公開済みコメントは下書き操作では削除できない。
      if (change.deleteDraft) {
        this.db
          .prepare(
            "DELETE FROM local_pr_comments_v7 WHERE repository_id=? AND pr_id=? AND id=? AND draft=1",
          )
          .run(repositoryId, id, change.deleteDraft);
      }
      return true;
    });
  }

  /** 新版の不変の Git 比較端点を記録する。 */
  private insertVersion(
    repositoryId: string,
    prId: string,
    version: LocalPrVersion,
  ): void {
    this.db
      .prepare(
        "INSERT INTO local_pr_versions_v7(repository_id,pr_id,version,version_json) VALUES(?,?,?,?)",
      )
      .run(repositoryId, prId, version.version, JSON.stringify(version));
  }

  /** SQLite を使い、接続をまたいで PR の状態と従属行の整合性を保つ。 */
  private transaction<T>(operation: () => T): T {
    assertRuntimeTurnAdmission();
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQL 文の実行が失敗した場合、従属する書き込みは残さない。
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
