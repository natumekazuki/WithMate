import assert from "node:assert/strict";
import test from "node:test";

import { CoordinationFeedRequestGate } from "../../src/coordination-feed-request-gate.js";

test("Coordination feedはinitial load中の通知で古いresponseを捨てる", () => {
  const gate = new CoordinationFeedRequestGate();
  gate.selectSession("session-a");
  const initial = gate.begin("session-a")!;
  const notificationRefresh = gate.begin("session-a")!;
  assert.equal(gate.isCurrent(initial), false);
  assert.equal(gate.isCurrent(notificationRefresh), true);
});

test("Coordination feedはSession切替後のresponseを捨てる", () => {
  const gate = new CoordinationFeedRequestGate();
  gate.selectSession("session-a");
  const request = gate.begin("session-a")!;
  gate.selectSession("session-b");
  assert.equal(gate.isCurrent(request), false);
  assert.equal(gate.begin("session-a"), null);
});
