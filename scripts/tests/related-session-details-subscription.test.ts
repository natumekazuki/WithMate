import assert from "node:assert/strict";
import test from "node:test";

import type { RelatedSessionDetails, RelatedSessionSummary } from "../../src/related-session-details.js";
import { startRelatedSessionDetailsSubscription } from "../../src/related-session-details-subscription.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("related Session detailsはbatch summaryでloading/found/missingをIDごとに反映する", async () => {
  let summaries: RelatedSessionSummary[] = [{ sessionId: "target-session", taskTitle: "Target" }];
  let listener: ((payload: { scope: "ids"; sessionIds: string[] } | { scope: "all" }) => void) | null = null;
  let details: RelatedSessionDetails[] = [];
  const requested: string[][] = [];
  const cleanup = startRelatedSessionDetailsSubscription({
    api: {
      async listRelatedSessionSummaries(sessionIds) {
        requested.push([...sessionIds]);
        return summaries;
      },
      subscribeSessionInvalidation(next) {
        listener = next;
        return () => { listener = null; };
      },
    },
    sessionIds: ["target-session", "missing-session", "target-session"],
    applyDetails(update) {
      details = update(details);
    },
  });

  assert.deepEqual(details, [
    { sessionId: "target-session", status: "loading" },
    { sessionId: "missing-session", status: "loading" },
  ]);
  await flush();
  assert.deepEqual(requested, [["target-session", "missing-session"]]);
  assert.deepEqual(details, [
    { sessionId: "target-session", status: "found", taskTitle: "Target" },
    { sessionId: "missing-session", status: "missing" },
  ]);

  summaries = [{ sessionId: "target-session", taskTitle: "Renamed Target" }];
  listener?.({ scope: "ids", sessionIds: ["target-session"] });
  assert.equal(details[0]?.status, "found", "更新中は直前のfound値を保持する");
  await flush();
  assert.deepEqual(details[0], {
    sessionId: "target-session",
    status: "found",
    taskTitle: "Renamed Target",
  });

  cleanup();
  assert.equal(listener, null);
});

test("related Session detailsは取得失敗をmissingへ変換せず直前タイトルを保持する", async () => {
  let shouldFail = false;
  let listener: ((payload: { scope: "all" }) => void) | null = null;
  let details: RelatedSessionDetails[] = [];
  const errors: unknown[] = [];
  const cleanup = startRelatedSessionDetailsSubscription({
    api: {
      async listRelatedSessionSummaries() {
        if (shouldFail) throw new Error("unavailable");
        return [{ sessionId: "target-session", taskTitle: "Target" }];
      },
      subscribeSessionInvalidation(next) {
        listener = next;
        return () => { listener = null; };
      },
    },
    sessionIds: ["target-session"],
    applyDetails(update) {
      details = update(details);
    },
    onError(error) {
      errors.push(error);
    },
  });

  await flush();
  shouldFail = true;
  listener?.({ scope: "all" });
  await flush();
  assert.deepEqual(details, [{
    sessionId: "target-session",
    status: "error",
    taskTitle: "Target",
  }]);
  assert.equal(errors.length, 1);

  cleanup();
});
