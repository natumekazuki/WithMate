/** Accept visibility-only revisions without invalidating an aggregation decision. */
export function workItemDecisionRevisionMatchesSql(itemAlias: "item" | "child"): string {
  return `(
    decision.child_revision = ${itemAlias}.revision
    OR (
      SELECT COUNT(*) FROM work_item_events_v6 AS lifecycle
      WHERE lifecycle.work_item_id = ${itemAlias}.id
        AND lifecycle.revision > decision.child_revision
        AND lifecycle.revision <= ${itemAlias}.revision
        AND lifecycle.event_type IN ('archived', 'restored')
    ) = ${itemAlias}.revision - decision.child_revision
  )`;
}
