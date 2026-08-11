import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionExecutionAdmissionGate } from "../../src-electron/session-execution-admission-gate.js";

test("DB-MAINT-07: maintenanceは既受付operationをdrainし新規admissionを完了まで拒否する", async () => {
  const gate = new SessionExecutionAdmissionGate();
  const admission = gate.tryAdmit();
  assert.notEqual(admission, null);

  let maintenanceStarted = false;
  const maintenance = gate.runMaintenance(async () => {
    maintenanceStarted = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(maintenanceStarted, false);
  assert.equal(gate.tryAdmit(), null);

  admission?.release();
  await maintenance;
  assert.equal(maintenanceStarted, true);

  const resumedAdmission = gate.tryAdmit();
  assert.notEqual(resumedAdmission, null);
  resumedAdmission?.release();
});
