import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseMissedSessionScheduleFire,
  listNextSessionScheduleTriggerInstants,
  nextSessionScheduleTriggerInstant,
  validateSessionScheduleTrigger,
} from "../../src/session-schedule-trigger.js";

const now = new Date("2026-08-18T00:00:00Z");

test("once rejects a past local date-time", () => {
  assert.throws(() =>
    validateSessionScheduleTrigger(
      { type: "once", localDateTime: "2026-08-17T10:00", timeZone: "UTC" },
      now,
    ),
  );
});

test("once rejects an invalid IANA time zone", () => {
  assert.throws(() =>
    validateSessionScheduleTrigger(
      { type: "once", localDateTime: "2026-08-19T10:00", timeZone: "Not/Zone" },
      now,
    ),
  );
});

test("once rejects a local date-time in a DST gap", () => {
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
});

test("once accepts a valid future local date-time", () => {
  assert.doesNotThrow(() => validateSessionScheduleTrigger(
    { type: "once", localDateTime: "2026-08-19T10:00", timeZone: "UTC" },
    now,
  ));
});

test("cron skips a local occurrence in a DST gap", () => {
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
});

test("cron chooses one canonical occurrence in a DST fold", () => {
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
});

test("cron accepts 7 as Sunday", () => {
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
});

test("missed cron occurrences collapse to the latest logical fire", () => {
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

test("cron preview returns consecutive canonical occurrences", () => {
  const preview = listNextSessionScheduleTriggerInstants(
    {
      type: "cron",
      expression: "*/15 * * * *",
      timeZone: "UTC",
    },
    new Date("2026-08-18T00:07:00Z"),
    4,
  );
  assert.deepEqual(
    preview.map((instant) => instant.toISOString()),
    [
      "2026-08-18T00:15:00.000Z",
      "2026-08-18T00:30:00.000Z",
      "2026-08-18T00:45:00.000Z",
      "2026-08-18T01:00:00.000Z",
    ],
  );
});
