export type CompletedExchangeTiming = {
  lastCompletedAt: string;
  elapsedMs: number;
};

export type CharacterSharedWorkTiming = {
  todayCompletedTurnDurationMs: number;
  totalCompletedTurnDurationMs: number;
};

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type ConversationTimingContext = {
  observedAt: string;
  observedDayOfWeek: DayOfWeek;
  currentSession: CompletedExchangeTiming | null;
  sameCharacterOtherSession: CompletedExchangeTiming | null;
  sameCharacterSharedWork: CharacterSharedWorkTiming | null;
};

export type CompletedTurnTimingRow = {
  startedAt: string;
  completedAt: string;
};

export type ConversationTimingStorageSnapshot = {
  currentSessionLastCompletedAt: string | null;
  sameCharacterOtherSessionLastCompletedAt: string | null;
  sameCharacterCompletedTurns: CompletedTurnTimingRow[] | null;
};

const DAY_OF_WEEK: readonly DayOfWeek[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absoluteMinutes / 60))}:${pad(absoluteMinutes % 60)}`;
}

function shiftedDate(date: Date, offsetMinutes: number): Date {
  return new Date(date.getTime() + offsetMinutes * 60_000);
}

export function formatIsoDateTimeAtOffset(date: Date, offsetMinutes: number): string {
  const shifted = shiftedDate(date, offsetMinutes);
  return [
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`,
    `.${pad(shifted.getUTCMilliseconds(), 3)}${formatOffset(offsetMinutes)}`,
  ].join("");
}

function parseTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function resolveCompletedExchange(
  value: string | null,
  observedAt: Date,
  resolveOffsetMinutes: (date: Date) => number,
): CompletedExchangeTiming | null {
  const completedAt = parseTimestamp(value);
  if (!completedAt || completedAt.getTime() > observedAt.getTime()) {
    return null;
  }
  return {
    lastCompletedAt: formatIsoDateTimeAtOffset(completedAt, resolveOffsetMinutes(completedAt)),
    elapsedMs: observedAt.getTime() - completedAt.getTime(),
  };
}

function localDateKey(date: Date, offsetMinutes: number): string {
  const shifted = shiftedDate(date, offsetMinutes);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function resolveConversationTimingContext(
  snapshot: ConversationTimingStorageSnapshot,
  observedAt: Date,
  resolveOffsetMinutes: (date: Date) => number = (date) => -date.getTimezoneOffset(),
): ConversationTimingContext {
  const observedOffsetMinutes = resolveOffsetMinutes(observedAt);
  const observedAtText = formatIsoDateTimeAtOffset(observedAt, observedOffsetMinutes);
  const observedLocalDate = shiftedDate(observedAt, observedOffsetMinutes);
  let sameCharacterSharedWork: CharacterSharedWorkTiming | null = null;

  if (snapshot.sameCharacterCompletedTurns !== null) {
    let todayCompletedTurnDurationMs = 0;
    let totalCompletedTurnDurationMs = 0;
    const observedDateKey = localDateKey(observedAt, observedOffsetMinutes);
    for (const turn of snapshot.sameCharacterCompletedTurns) {
      const startedAt = parseTimestamp(turn.startedAt);
      const completedAt = parseTimestamp(turn.completedAt);
      if (!startedAt || !completedAt || completedAt.getTime() > observedAt.getTime()) {
        continue;
      }
      const durationMs = completedAt.getTime() - startedAt.getTime();
      if (durationMs < 0) {
        continue;
      }
      totalCompletedTurnDurationMs += durationMs;
      if (localDateKey(completedAt, resolveOffsetMinutes(completedAt)) === observedDateKey) {
        todayCompletedTurnDurationMs += durationMs;
      }
    }
    sameCharacterSharedWork = {
      todayCompletedTurnDurationMs,
      totalCompletedTurnDurationMs,
    };
  }

  return {
    observedAt: observedAtText,
    observedDayOfWeek: DAY_OF_WEEK[observedLocalDate.getUTCDay()] ?? "sunday",
    currentSession: resolveCompletedExchange(snapshot.currentSessionLastCompletedAt, observedAt, resolveOffsetMinutes),
    sameCharacterOtherSession: resolveCompletedExchange(
      snapshot.sameCharacterOtherSessionLastCompletedAt,
      observedAt,
      resolveOffsetMinutes,
    ),
    sameCharacterSharedWork,
  };
}
