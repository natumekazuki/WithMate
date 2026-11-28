/** 保存する Main の役割として認める値。Auxiliary は Main の役割の一種ではない。 */
export const SESSION_ROLE_VALUES = [
  "standalone",
  "overall-coordinator",
  "task-coordinator",
  "executor",
] as const;
/** 単独・全体統括・タスク統括・実行のいずれかを表す Main の役割。 */
export type SessionRole = (typeof SESSION_ROLE_VALUES)[number];
/** 関連 Session の表示・検索では、Main の役割に加えて Auxiliary 自体も区別する。 */
export type RelatedSessionRole = SessionRole | "auxiliary";

/** Main の役割と保存済みの系譜。Crew の起点、直接の親、作成元を別に保持する。 */
export type SessionRelationship = {
  sessionRole: SessionRole;
  rootSessionId: string;
  parentSessionId: string | null;
  createdBySessionId: string | null;
};

/** 省略された役割は単独とし、親指定がなければ自分を Crew の起点にする。親と作成元の空白値は null にそろえる。 */
export function normalizeSessionRelationship(
  input: Partial<SessionRelationship> & { id: string },
): SessionRelationship {
  if (input.sessionRole !== undefined) assertSessionRole(input.sessionRole);
  return {
    sessionRole: input.sessionRole ?? "standalone",
    rootSessionId: input.parentSessionId
      ? input.rootSessionId?.trim() || input.id
      : input.id,
    parentSessionId: input.parentSessionId?.trim() || null,
    createdBySessionId: input.createdBySessionId?.trim() || null,
  };
}

/** 一般更新で役割・Crew 起点・直接の親・作成元が変わることを防ぐため、正規化後に差があれば例外を投げる。 */
export function assertSameSessionRelationship(
  current: Partial<SessionRelationship> & { id: string },
  next: Partial<SessionRelationship> & { id: string },
): void {
  const before = normalizeSessionRelationship(current);
  const after = normalizeSessionRelationship(next);
  if (
    before.sessionRole !== after.sessionRole ||
    before.rootSessionId !== after.rootSessionId ||
    before.parentSessionId !== after.parentSessionId ||
    before.createdBySessionId !== after.createdBySessionId
  ) {
    throw new Error(
      "Session Role and saved relationships cannot be changed by a general update.",
    );
  }
}

/** 全体統括はタスク統括または実行、タスク統括は実行のみを子にできる。それ以外の組み合わせは拒否する。 */
export function assertChildSessionRole(
  parentRole: SessionRole,
  childRole: SessionRole,
): void {
  if (
    (parentRole === "overall-coordinator" &&
      (childRole === "task-coordinator" || childRole === "executor")) ||
    (parentRole === "task-coordinator" && childRole === "executor")
  )
    return;
  throw new Error("This Role cannot create the requested child Session Role.");
}

/** 保存できる Main の役割か検証し、未知の値や Auxiliary の区分値は拒否する。 */
export function assertSessionRole(
  value: unknown,
): asserts value is SessionRole {
  if (!SESSION_ROLE_VALUES.includes(value as SessionRole))
    throw new Error("Invalid Session Role.");
}
