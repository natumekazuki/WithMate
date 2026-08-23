import assert from "node:assert/strict";
import test from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import { startRelatedSessionDetailsSubscription } from "../../src/related-session-details-subscription.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("related Session detailsはcanonical IDで取得しrename/delete invalidationを反映する", async () => {
  let title = "Target";
  let exists = true;
  let listener: ((payload: { scope: "ids"; sessionIds: string[] } | { scope: "all" }) => void) | null = null;
  const applied: Array<Array<{ sessionId: string; taskTitle: string }>> = [];
  const cleanup = startRelatedSessionDetailsSubscription({
    api: {
      async getSession(sessionId) {
        return exists ? {
          ...buildNewSession({
            taskTitle: title,
            workspaceLabel: "workspace",
            workspacePath: "C:/workspace",
            branch: "main",
            characterId: "character-1",
            character: "Character",
            characterIconPath: "",
            characterThemeColors: { main: "#000000", sub: "#ffffff" },
            approvalMode: "on-request",
          }),
          id: sessionId,
        } : null;
      },
      subscribeSessionInvalidation(next) {
        listener = next;
        return () => { listener = null; };
      },
    },
    sessionIds: ["target-session"],
    applyDetails: (details) => applied.push(details),
  });

  await flush();
  assert.deepEqual(applied.at(-1), [{ sessionId: "target-session", taskTitle: "Target" }]);
  title = "Renamed Target";
  listener?.({ scope: "ids", sessionIds: ["target-session"] });
  await flush();
  assert.deepEqual(applied.at(-1), [{ sessionId: "target-session", taskTitle: "Renamed Target" }]);
  exists = false;
  listener?.({ scope: "all" });
  await flush();
  assert.deepEqual(applied.at(-1), []);

  cleanup();
  assert.equal(listener, null);
});
