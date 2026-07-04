import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuditLogOwner } from "../../src/chat/audit-log-owner.js";

test("resolveAuditLogOwner は通常時に parent session の audit log owner を返す", () => {
  const parentSession = { id: "session-1" };
  const displayedSession = { id: "session-1" };

  const result = resolveAuditLogOwner({
    parentSession,
    displayedSession,
    hasActiveAuxiliarySession: false,
    parentSourceLabel: "Main Session",
  });

  assert.equal(result.session, parentSession);
  assert.equal(result.ownerSessionId, "session-1");
  assert.equal(result.sourceLabel, "Main Session");
});

test("resolveAuditLogOwner は Active Auxiliary 中に Auxiliary session の audit log owner を返す", () => {
  const parentSession = { id: "session-1" };
  const displayedSession = { id: "aux-1" };

  const result = resolveAuditLogOwner({
    parentSession,
    displayedSession,
    hasActiveAuxiliarySession: true,
    parentSourceLabel: "Companion",
  });

  assert.equal(result.session, displayedSession);
  assert.equal(result.ownerSessionId, "aux-1");
  assert.equal(result.sourceLabel, "Auxiliary Session");
});
