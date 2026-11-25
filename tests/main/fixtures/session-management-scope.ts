import type { SessionManagementApplicationDeps } from "../../../src-electron/session/session-management-application.js";
import { queryRelatedSessions, type RelatedSession } from "../../../src-electron/session/session-relationship-resolver.js";

export function fixtureSessionManagementScope(
  list: () => readonly RelatedSession[] | Promise<readonly RelatedSession[]>,
): SessionManagementApplicationDeps["readSessionScope"] {
  return async (reference, selection) => {
    const entries = await list();
    const find = (identity: { kind: RelatedSession["kind"]; sessionId: string }) =>
      entries.find((entry) => entry.kind === identity.kind && entry.id === identity.sessionId) ?? null;
    const actor = find(reference);
    if (!actor || !selection) return { actor };
    if ("target" in selection) return { actor, target: find(selection.target) };
    return { actor, page: queryRelatedSessions(entries, actor, selection.query) };
  };
}
