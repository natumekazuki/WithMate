export const SESSION_METADATA_LIMITS = {
  titleMaxLength: 512,
  repositoryNameMaxLength: 1_024,
  queryMaxLength: 512,
  repositoryFilterMaxItems: 100,
  repositoryNamesPerItemMax: 100,
} as const;

export const LOCAL_REPOSITORY_KEY_PREFIX = "local-repository-v1-sha256-";

export type LocalRepositoryMetadata =
  | Readonly<{ localRepositoryKey: string; repositoryName: string }>
  | Readonly<{ localRepositoryKey: null; repositoryName: null }>;

export type SessionMetadata = Readonly<{ title: string }> & LocalRepositoryMetadata;

export function canonicalizeSessionTitle(value: string): string | undefined {
  const title = value.trim();
  return isCanonicalSessionTitle(title) ? title : undefined;
}

export function canonicalizeSessionQuery(value: string): string | undefined {
  const query = value.trim();
  return query.length > 0 && query.length <= SESSION_METADATA_LIMITS.queryMaxLength && !query.includes("\0")
    ? query
    : undefined;
}

export function sessionSearchKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function isCanonicalSessionTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_METADATA_LIMITS.titleMaxLength &&
    value === value.trim() &&
    !value.includes("\0")
  );
}

export function isLocalRepositoryKey(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${LOCAL_REPOSITORY_KEY_PREFIX}[0-9a-f]{64}$`, "u").test(value);
}

export function isRepositoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SESSION_METADATA_LIMITS.repositoryNameMaxLength &&
    !value.includes("\0")
  );
}

export function snapshotLocalRepositoryMetadata(
  localRepositoryKey: unknown,
  repositoryName: unknown,
): LocalRepositoryMetadata | undefined {
  if (localRepositoryKey === null && repositoryName === null) {
    return { localRepositoryKey: null, repositoryName: null };
  }
  return isLocalRepositoryKey(localRepositoryKey) && isRepositoryName(repositoryName)
    ? { localRepositoryKey, repositoryName }
    : undefined;
}
