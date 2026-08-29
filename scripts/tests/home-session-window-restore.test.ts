import assert from "node:assert/strict";
import test from "node:test";

import { selectPendingSessionWindowRestoreIds } from "../../src/home/home-session-window-restore.js";

test("未復元SessionだけをCTA対象にし、全件open済みなら空にする", () => {
  assert.deepEqual(
    selectPendingSessionWindowRestoreIds(["session-a", "session-b"], ["session-c"]),
    ["session-a", "session-b"],
  );
  assert.deepEqual(
    selectPendingSessionWindowRestoreIds(["session-a", "session-b"], ["session-a", "session-b"]),
    [],
  );
});
