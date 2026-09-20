import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuditLogOwner } from "../../src/chat/audit-log-owner.js";

// @test-value v2
// kind = "contract"
// claim = "Audit log ownerは表示中Sessionではなく親Sessionへ解決する"
// oracle = { type = "contract", ref = "src/chat/audit-log-owner.ts" }
// fault = "表示中Sessionをownerとして扱い、親Sessionのaudit logを参照できなくする"
// observable = "ownerSessionIdとsourceLabel"
// observation_boundary = "public-boundary"
// scope = "audit-log-owner resolution"
// lifecycle = "permanent"
// @end-test-value
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

// @test-value v2
// kind = "contract"
// claim = "Active Auxiliary表示中もaudit log ownerは親Sessionを維持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md" }
// fault = "Auxiliary自身をaudit ownerとして扱い、親Sessionの履歴を失う"
// observable = "ownerSessionIdとsourceLabel"
// observation_boundary = "public-boundary"
// scope = "audit-log-owner auxiliary resolution"
// lifecycle = "permanent"
// @end-test-value
test("resolveAuditLogOwner は Active Auxiliary 中も parent session の audit log owner を返す", () => {
  const parentSession = { id: "session-1" };
  const displayedSession = { id: "aux-1" };

  const result = resolveAuditLogOwner({
    parentSession,
    displayedSession,
    parentSourceLabel: "Session",
  });

  assert.equal(result.session, displayedSession);
  assert.equal(result.ownerSessionId, "session-1");
  assert.equal(result.sourceLabel, "Session");
});
