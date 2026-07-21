export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function isValidNodeTimerDelay(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_NODE_TIMER_DELAY_MS;
}
