import { CronExpressionParser } from "cron-parser";

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}
function parts(instant: Date, timeZone: string): LocalParts {
  const result: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant))
    if (p.type !== "literal") result[p.type] = Number(p.value);
  return {
    year: result.year,
    month: result.month,
    day: result.day,
    hour: result.hour === 24 ? 0 : result.hour,
    minute: result.minute,
    second: result.second,
  };
}
function key(p: LocalParts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}
function validateZone(zone: string): void {
  try {
    formatter(zone).format(new Date());
  } catch {
    throw new Error(`Unknown IANA time zone: ${zone}`);
  }
}
function resolveLocal(
  local: string,
  zone: string,
  rejectAmbiguous = true,
): Date {
  validateZone(zone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local))
    throw new Error("Local date time must be YYYY-MM-DDTHH:mm[:ss].");
  const normalized = local.length === 16 ? `${local}:00` : local;
  const [date, time] = normalized.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const target = { year, month, day, hour, minute, second };
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const candidates: Date[] = [];
  for (let offset = -24 * 60; offset <= 24 * 60; offset += 15) {
    const d = new Date(naive - offset * 60000);
    if (
      key(parts(d, zone)) === key(target) &&
      !candidates.some((x) => x.getTime() === d.getTime())
    )
      candidates.push(d);
  }
  if (candidates.length === 0)
    throw new Error(
      "Local date time does not exist in the selected time zone.",
    );
  if (candidates.length > 1 && rejectAmbiguous)
    throw new Error("Local date time is ambiguous in the selected time zone.");
  return candidates.sort((a, b) => a.getTime() - b.getTime())[0];
}

type Field = {
  min: number;
  max: number;
  values: Set<number>;
  wildcard: boolean;
};
function parseField(raw: string, min: number, max: number): Field {
  if (!raw) throw new Error("Cron field is empty.");
  const values = new Set<number>();
  let wildcard = false;
  for (const item of raw.split(",")) {
    const [base, stepRaw] = item.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1)
      throw new Error("Cron step is invalid.");
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
      wildcard = true;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b)
        throw new Error("Cron range is invalid.");
      start = a;
      end = b;
    } else {
      start = Number(base);
      if (!Number.isInteger(start)) throw new Error("Cron value is invalid.");
      end = start;
    }
    if (start < min || end > max)
      throw new Error("Cron value is out of range.");
    for (let n = start; n <= end; n += step) values.add(n);
  }
  if (!values.size) throw new Error("Cron field has no values.");
  return { min, max, values, wildcard };
}
function cronFields(expression: string): [Field, Field, Field, Field, Field] {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("Cron requires five fields.");
  const dow = parseField(f[4], 0, 7);
  if (dow.values.has(7)) {
    dow.values.delete(7);
    dow.values.add(0);
  }
  dow.max = 6;
  return [
    parseField(f[0], 0, 59),
    parseField(f[1], 0, 23),
    parseField(f[2], 1, 31),
    parseField(f[3], 1, 12),
    dow,
  ];
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function matchesCron(
  p: LocalParts,
  fields: ReturnType<typeof cronFields>,
): boolean {
  const [minute, hour, dom, month, dow] = fields;
  if (
    !minute.values.has(p.minute) ||
    !hour.values.has(p.hour) ||
    !month.values.has(p.month)
  )
    return false;
  if (p.day > daysInMonth(p.year, p.month)) return false;
  const domMatch = dom.values.has(p.day),
    dowMatch = dow.values.has(
      new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
    );
  const dayMatch =
    dom.wildcard || dow.wildcard ? domMatch && dowMatch : domMatch || dowMatch;
  return dayMatch;
}

export function nextSessionScheduleTriggerInstant(
  trigger:
    | { type: "once"; localDateTime: string; timeZone: string }
    | { type: "cron"; expression: string; timeZone: string },
  after: Date,
): Date {
  if (trigger.type === "once") {
    const d = resolveLocal(trigger.localDateTime, trigger.timeZone);
    if (d <= after) throw new Error("Once schedule must be in the future.");
    return d;
  }
  validateZone(trigger.timeZone);
  const fields = cronFields(trigger.expression);
  const iterator = CronExpressionParser.parse(trigger.expression, {
    currentDate: after,
    tz: trigger.timeZone,
  });
  for (let i = 0; i < 1000; i++) {
    const d = iterator.next().toDate();
    const p = parts(d, trigger.timeZone);
    if (p.second !== 0 || !matchesCron(p, fields)) continue;
    try {
      const resolved = resolveLocal(
        key(p).slice(0, 16),
        trigger.timeZone,
        false,
      );
      if (resolved.getTime() === d.getTime()) return d;
    } catch {
      /* DST gap is skipped. */
    }
  }
  throw new Error("Cron next occurrence could not be found.");
}

export function listNextSessionScheduleTriggerInstants(
  trigger: Parameters<typeof nextSessionScheduleTriggerInstant>[0],
  after: Date,
  count = 5,
): Date[] {
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("Schedule preview count must be between 1 and 10.");
  }
  const instants: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextSessionScheduleTriggerInstant(trigger, cursor);
    instants.push(next);
    cursor = next;
  }
  return instants;
}

export function validateSessionScheduleTrigger(
  trigger: Parameters<typeof nextSessionScheduleTriggerInstant>[0],
  now = new Date(),
): void {
  if (trigger.type === "once") {
    const instant = resolveLocal(trigger.localDateTime, trigger.timeZone);
    if (instant <= now) throw new Error("Once schedule must be in the future.");
    return;
  }
  cronFields(trigger.expression);
  validateZone(trigger.timeZone);
  nextSessionScheduleTriggerInstant(trigger, now);
}
export function collapseMissedSessionScheduleFire(
  trigger: Parameters<typeof nextSessionScheduleTriggerInstant>[0],
  now: Date,
): Date | null {
  if (trigger.type === "once") {
    try {
      const d = resolveLocal(trigger.localDateTime, trigger.timeZone);
      return d <= now ? d : null;
    } catch {
      return null;
    }
  }
  validateZone(trigger.timeZone);
  const fields = cronFields(trigger.expression);
  const iterator = CronExpressionParser.parse(trigger.expression, {
    currentDate: now,
    tz: trigger.timeZone,
  });
  for (let i = 0; i < 1000; i++) {
    const d = iterator.prev().toDate();
    const p = parts(d, trigger.timeZone);
    if (!matchesCron(p, fields)) continue;
    try {
      const canonical = resolveLocal(
        key(p).slice(0, 16),
        trigger.timeZone,
        false,
      );
      if (canonical <= now) return canonical;
    } catch {
      /* gap */
    }
  }
  return null;
}
