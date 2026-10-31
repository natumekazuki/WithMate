export function computeMemoryTimeDecayScore(
  referenceTimestamp: string | null,
  updatedAt: string,
  nowMs: number,
): number {
  const reference = Date.parse(referenceTimestamp ?? updatedAt);
  if (Number.isNaN(reference)) {
    return 0;
  }

  const deltaMs = Math.max(0, nowMs - reference);
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (deltaMs <= 7 * oneDayMs) {
    return 3;
  }
  if (deltaMs <= 30 * oneDayMs) {
    return 1;
  }
  if (deltaMs <= 90 * oneDayMs) {
    return -1;
  }
  if (deltaMs <= 180 * oneDayMs) {
    return -3;
  }

  return -5;
}
