import { z } from "zod";
import type { BackgroundPurpose } from "../agent-runtime/background-execution-scope.js";
import {
  DEFAULT_MEMORY_RECORDING_FREQUENCIES,
  memoryRecordingFrequencySchema,
  type MemoryRecordingFrequencies,
} from "../memory-recording/memory-recording-frequency.js";

export const BACKGROUND_PURPOSES = ["character-memory", "target-memory", "affect"] as const satisfies readonly BackgroundPurpose[];

const selectionSchema = z.object({
  providerId: z.string().min(1).refine((value) => value.trim() === value),
  modelId: z.string().min(1).refine((value) => value.trim() === value),
}).strict();
const purposeSettingsSchema = z.object({
  selection: selectionSchema.optional(),
  instructionText: z.string().optional(),
}).strict();
const settingsSchema = z.object({
  "character-memory": purposeSettingsSchema.default({}),
  "target-memory": purposeSettingsSchema.default({}),
  affect: purposeSettingsSchema.default({}),
}).strict();
const frequenciesSchema = z.object({
  "character-memory": memoryRecordingFrequencySchema.default(DEFAULT_MEMORY_RECORDING_FREQUENCIES["character-memory"]),
  "target-memory": memoryRecordingFrequencySchema.default(DEFAULT_MEMORY_RECORDING_FREQUENCIES["target-memory"]),
}).strict();

export type BackgroundExecutionSelection = z.infer<typeof selectionSchema>;
export type BackgroundPurposeSettings = z.infer<typeof purposeSettingsSchema>;
export type BackgroundExecutionSettings = Record<BackgroundPurpose, BackgroundPurposeSettings>;

export function createDefaultBackgroundExecutionSettings(): BackgroundExecutionSettings {
  return { "character-memory": {}, "target-memory": {}, affect: {} };
}

export function parseBackgroundExecutionSettings(value: unknown): BackgroundExecutionSettings {
  return settingsSchema.parse(value === undefined ? {} : value);
}

export function parseMemoryRecordingFrequencies(value: unknown): MemoryRecordingFrequencies {
  return frequenciesSchema.parse(value === undefined ? {} : value);
}

export function resolveBackgroundInstructionText(settings: BackgroundPurposeSettings, preset: string): string {
  return settings.instructionText ?? preset;
}
