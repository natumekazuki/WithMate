import type { AuditLogicalPrompt, AuditLogUsage } from "../src/app-state.js";
import type { MateGrowthModelPreferencePurpose } from "../src/mate-state.js";

import type { MateMemoryGenerationPrompt } from "./mate-memory-generation-prompt.js";

export type MateGrowthModelPortInput = {
  purpose: MateGrowthModelPreferencePurpose;
  prompt: MateMemoryGenerationPrompt;
  logicalPrompt: AuditLogicalPrompt;
  reasoningEffort?: string;
  depth?: string;
};

export type MateGrowthModelPortResult = {
  rawText: string;
  parsedJson?: unknown;
  usage?: AuditLogUsage | null;
  provider?: string;
  model?: string;
  threadId?: string | null;
  rawItemsJson?: string;
  reasoningEffort?: string;
  depth?: string;
};

export interface MateGrowthModelPort {
  runStructuredGeneration(input: MateGrowthModelPortInput): Promise<MateGrowthModelPortResult>;
}
