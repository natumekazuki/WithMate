import { z } from "zod";
import type { BackgroundPurpose } from "../agent-runtime/background-execution-scope.js";

export type MemoryRecordingPurpose = Exclude<BackgroundPurpose, "affect">;

export const memoryRecordingFrequencySchema = z.object({
  turnCount: z.number().int().min(1),
  idleMinutes: z.number().positive(),
}).strict();

export type MemoryRecordingFrequency = Readonly<z.infer<typeof memoryRecordingFrequencySchema>>;
export type MemoryRecordingFrequencies = Readonly<Record<MemoryRecordingPurpose, MemoryRecordingFrequency>>;

export const DEFAULT_MEMORY_RECORDING_FREQUENCIES: MemoryRecordingFrequencies = Object.freeze({
  "character-memory": Object.freeze({ turnCount: 5, idleMinutes: 5 }),
  "target-memory": Object.freeze({ turnCount: 5, idleMinutes: 5 }),
});

export function validateMemoryRecordingFrequency(value: unknown): MemoryRecordingFrequency {
  return memoryRecordingFrequencySchema.parse(value);
}

export type MemoryRecordingFrequencyInput = Readonly<{
  /** Counted by the caller for one conversation owner and purpose, not a global Turn ID difference. */
  pendingTurnCount: number;
  frequency: MemoryRecordingFrequency;
  isConversationRunning: boolean;
  idleMinutes: number;
}>;

/** Scheduling only; the caller owns validated inputs, admission, timers and invocation lifetime. */
export function getMemoryRecordingTrigger(input: MemoryRecordingFrequencyInput): "none" | "turn_count" | "idle" {
  if (input.pendingTurnCount === 0) return "none";
  if (input.pendingTurnCount >= input.frequency.turnCount) return "turn_count";
  return !input.isConversationRunning && input.idleMinutes >= input.frequency.idleMinutes ? "idle" : "none";
}
