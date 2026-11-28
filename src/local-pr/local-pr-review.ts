import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { LocalPrComment } from "../../src-shared/local-pr/local-pr-contract.js";
import {
  parseUnifiedDiff,
  type UnifiedDiffDisplayRow,
} from "../../src-shared/file-explorer/unified-diff.js";

/** 対応行の組は左右分割差分に役立つが、unified diff では各変更行を Git の元の順番に保つ。 */
export function unifiedReviewRows(patch: string): UnifiedDiffDisplayRow[] {
  const rows = parseUnifiedDiff(patch).rows.flatMap(
    (row): UnifiedDiffDisplayRow[] =>
      row.kind === "modify"
        ? [
            {
              kind: "delete",
              leftNumber: row.leftNumber,
              leftText: row.leftText,
              leftPatchLineIndex: row.leftPatchLineIndex,
            },
            {
              kind: "add",
              rightNumber: row.rightNumber,
              rightText: row.rightText,
              rightPatchLineIndex: row.rightPatchLineIndex,
            },
          ]
        : [row],
  );
  /** 表示行の種別に応じ、Git パッチ上の元の行位置を取得する。 */
  const position = (row: UnifiedDiffDisplayRow) =>
    "text" in row
      ? row.patchLineIndex
      : (row.leftPatchLineIndex ?? row.rightPatchLineIndex ?? 0);
  return rows.sort((left, right) => position(left) - position(right));
}

/** 種別と ID・世代を比較し、Auxiliary では所有元 Main の ID と世代も一致する必要がある。 */
export function isSameSession(a: SessionTarget, b: SessionTarget): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.incarnationId === b.incarnationId &&
    (a.kind === "main"
      ? b.kind === "main"
      : b.kind === "auxiliary" &&
        a.mainSessionId === b.mainSessionId &&
        a.mainIncarnationId === b.mainIncarnationId)
  );
}

/** 返信を辿れる最上位コメントごとにまとめ、参照欠落や循環では追跡を止める。 */
export function commentThreads(comments: readonly LocalPrComment[]) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const nodes = new Map<
    string,
    { comment: LocalPrComment; replies: LocalPrComment[] }
  >();
  for (const comment of comments) {
    let root = comment;
    const seen = new Set([comment.id]);
    while (root.replyTo) {
      const parent = byId.get(root.replyTo);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
    }
    const thread = nodes.get(root.id) ?? { comment: root, replies: [] };
    if (root.id !== comment.id) thread.replies.push(comment);
    nodes.set(root.id, thread);
  }
  return Array.from(nodes.values());
}
