import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditLogSummary } from "../../src/runtime-state.js";
import { isTerminalAuditLogPhase } from "../../src/audit-log-phase.js";

describe("isTerminalAuditLogPhase", () => {
  it("terminal phase を正しく true と判定する", () => {
    const terminalPhases: Array<AuditLogSummary["phase"]> = [
      "completed",
      "failed",
      "canceled",
      "background-completed",
      "background-failed",
      "background-canceled",
    ];

    for (const phase of terminalPhases) {
      assert.equal(isTerminalAuditLogPhase(phase), true, `expected terminal: ${phase}`);
    }
  });

  it("非 terminal phase を正しく false と判定する", () => {
    const nonTerminalPhases: Array<AuditLogSummary["phase"]> = [
      "running",
      "started",
      "background-running",
    ];
    for (const phase of nonTerminalPhases) {
      assert.equal(isTerminalAuditLogPhase(phase), false, `expected non-terminal: ${phase}`);
    }
  });
});
