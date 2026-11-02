import type { BackgroundPurpose } from "./background-execution-scope.js";
import { BACKGROUND_MEMORY_READ_TOOL_OPERATIONS } from "./background-memory-read.js";

export const BACKGROUND_REGISTRATION_OPERATIONS = {
  affect: { tool: "character_affect.appraise", operation: "memory.route.character_affect_appraise" },
  "character-memory": { tool: "character_memory.append_episode", operation: "memory.route.character_memory_append_episode" },
  "target-memory": { tool: "memory.append", operation: "memory.route.append" },
} as const satisfies Record<BackgroundPurpose, { tool: string; operation: string }>;

export function backgroundMemoryToolOperations(purpose: BackgroundPurpose, registrationConnected: boolean): Readonly<Record<string, string>> {
  const registration = BACKGROUND_REGISTRATION_OPERATIONS[purpose];
  return registrationConnected
    ? { ...BACKGROUND_MEMORY_READ_TOOL_OPERATIONS, [registration.tool]: registration.operation }
    : BACKGROUND_MEMORY_READ_TOOL_OPERATIONS;
}
