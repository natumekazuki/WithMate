import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseMissedSessionScheduleFire,
  nextSessionScheduleTriggerInstant,
  validateSessionScheduleTrigger,
} from "../../src-electron/session-schedule-trigger.js";

test("once rejects past, invalid zone, DST gap and accepts future", () => {
  const now = new Date("2026-08-18T00:00:00Z");
  assert.throws(() =>
    validateSessionScheduleTrigger(
      { type: "once", localDateTime: "2026-08-17T10:00", timeZone: "UTC" },
      now,
    ),
  );
  assert.throws(() =>
    validateSessionScheduleTrigger(
      { type: "once", localDateTime: "2026-08-19T10:00", timeZone: "Not/Zone" },
      now,
    ),
  );
  assert.throws(() =>
    validateSessionScheduleTrigger(
      {
        type: "once",
        localDateTime: "2026-03-08T02:30",
        timeZone: "America/New_York",
      },
      now,
    ),
  );
  validateSessionScheduleTrigger(
    { type: "once", localDateTime: "2026-08-19T10:00", timeZone: "UTC" },
    now,
  );
});

test("cron handles DST gap/fold, DOW 7 and latest missed", () => {
  const ny = {
    type: "cron" as const,
    expression: "30 2 * * *",
    timeZone: "America/New_York",
  };
  assert.equal(
    nextSessionScheduleTriggerInstant(
      ny,
      new Date("2026-03-08T00:00:00Z"),
    ).toISOString(),
    "2026-03-09T06:30:00.000Z",
  );
  const fold = {
    type: "cron" as const,
    expression: "30 1 * * *",
    timeZone: "America/New_York",
  };
  assert.equal(
    nextSessionScheduleTriggerInstant(
      fold,
      new Date("2026-11-01T00:00:00Z"),
    ).toISOString(),
    "2026-11-01T05:30:00.000Z",
  );
  const sunday = {
    type: "cron" as const,
    expression: "0 0 * * 7",
    timeZone: "UTC",
  };
  assert.equal(
    nextSessionScheduleTriggerInstant(
      sunday,
      new Date("2026-08-17T00:00:00Z"),
    ).getUTCDay(),
    0,
  );
  const frequent = {
    type: "cron" as const,
    expression: "*/1 * * * *",
    timeZone: "UTC",
  };
  assert.equal(
    collapseMissedSessionScheduleFire(
      frequent,
      new Date("2026-08-18T00:03:30Z"),
    )?.toISOString(),
    "2026-08-18T00:03:00.000Z",
  );
});
