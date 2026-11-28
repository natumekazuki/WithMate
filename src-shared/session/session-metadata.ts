/** Sessionのタイトル、説明、または両方を部分更新する入力。 */
export type SessionMetadataPatch = { title?: string; description?: string };

/** 更新項目の有無と長さを検証し、タイトルだけ前後の空白を除いて返す。 */
export function validateSessionMetadataPatch(
  patch: SessionMetadataPatch,
): SessionMetadataPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid Session metadata patch.");
  if (patch.title === undefined && patch.description === undefined)
    throw new Error("Title or description is required.");
  if (
    patch.title !== undefined &&
    (typeof patch.title !== "string" ||
      !patch.title.trim() ||
      patch.title.length > 500)
  )
    throw new Error("The Session title must contain 1 to 500 characters.");
  if (
    patch.description !== undefined &&
    (typeof patch.description !== "string" || patch.description.length > 10000)
  )
    throw new Error(
      "The Session description must contain at most 10000 characters.",
    );
  return {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
  };
}
