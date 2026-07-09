import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuditLogOwner } from "../../src/chat/audit-log-owner.js";

test("resolveAuditLogOwner は表示 session と parent session の audit log owner を返す", () => {
  const parentSession = { id: "session-1" };
  const displayedSession = { id: "session-1" };

  const result = resolveAuditLogOwner({
    parentSession,
    displayedSession,
    parentSourceLabel: "Main Session",
  });

  assert.equal(result.session, displayedSession);
  assert.equal(result.ownerSessionId, "session-1");
  assert.equal(result.sourceLabel, "Main Session");
});

test("resolveAuditLogOwner は Active Auxiliary 中も parent session の audit log owner を返す", () => {
  const parentSession = { id: "session-1" };
  const displayedSession = { id: "aux-1" };

  const result = resolveAuditLogOwner({
    parentSession,
    displayedSession,
    parentSourceLabel: "Companion",
  });

  assert.equal(result.session, displayedSession);
  assert.equal(result.ownerSessionId, "session-1");
  assert.equal(result.sourceLabel, "Companion");
});
