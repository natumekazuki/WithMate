import { z } from "zod";
import { APPROVAL_MODE_VALUES } from "./approval-mode.js";
import { CODEX_REVIEWER_VALUES, DEFAULT_CODEX_REVIEWER } from "./codex-reviewer.js";
import { CODEX_SANDBOX_MODE_VALUES, DEFAULT_CODEX_SANDBOX_MODE } from "./codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED } from "./codex-speed.js";
import { getApprovalReviewerOptionsForProvider, getDefaultApprovalModeForProvider, getSandboxOptionsForProvider } from "./provider-runtime-options.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../session/session-execution-options.js";
import { isModelReasoningEffort, type ModelReasoningEffort } from "./model-catalog.js";
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
  reasoningEffort: z.custom<ModelReasoningEffort>(isModelReasoningEffort).optional(),
  approvalMode: z.enum(APPROVAL_MODE_VALUES).optional(),
  codexReviewer: z.enum(CODEX_REVIEWER_VALUES).optional(),
  codexSandboxMode: z.enum(CODEX_SANDBOX_MODE_VALUES).optional(),
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

export function resolveBackgroundExecutionOptions(selection: BackgroundExecutionSelection): SessionExecutionOptions {
  const approvalMode = selection.approvalMode ?? getDefaultApprovalModeForProvider(selection.providerId);
  if (selection.codexReviewer !== undefined && getApprovalReviewerOptionsForProvider(selection.providerId, approvalMode).length === 0) {
    throw new Error("The selected reviewer is not supported by this provider.");
  }
  if (selection.codexSandboxMode !== undefined && getSandboxOptionsForProvider(selection.providerId).length === 0) {
    throw new Error("The selected sandbox mode is not supported by this provider.");
  }
  return validateSessionExecutionOptions({
    model: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? "",
    approvalMode,
    codexReviewer: selection.codexReviewer ?? DEFAULT_CODEX_REVIEWER,
    codexSandboxMode: selection.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
    codexSpeed: DEFAULT_CODEX_SPEED,
    customAgentName: "",
  }, { id: selection.providerId });
}
