/** Repository-owned review records; Session identities are historical values, not cascading owners. */
export const CREATE_LOCAL_PR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_prs_v7 (
    repository_id TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
    approval_json TEXT CHECK(json_valid(approval_json)),
    PRIMARY KEY (repository_id, id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_local_prs_v7_page
    ON local_prs_v7(repository_id, updated_at DESC, id);
  CREATE TABLE IF NOT EXISTS local_pr_versions_v7 (
    repository_id TEXT NOT NULL,
    pr_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    version_json TEXT NOT NULL CHECK(json_valid(version_json)),
    PRIMARY KEY (repository_id, pr_id, version),
    FOREIGN KEY (repository_id, pr_id) REFERENCES local_prs_v7(repository_id, id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS local_pr_comments_v7 (
    repository_id TEXT NOT NULL,
    pr_id TEXT NOT NULL,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    draft INTEGER NOT NULL CHECK(draft IN (0,1)),
    created_at TEXT NOT NULL,
    comment_json TEXT NOT NULL CHECK(json_valid(comment_json)),
    PRIMARY KEY (repository_id, pr_id, id),
    FOREIGN KEY (repository_id, pr_id, version)
      REFERENCES local_pr_versions_v7(repository_id, pr_id, version) ON DELETE CASCADE
  ) STRICT;
`;
