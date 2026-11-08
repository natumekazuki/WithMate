import type { BackgroundMemoryFileAccess, BackgroundPurpose } from "./background-execution-scope.js";
import { BACKGROUND_MEMORY_READ_TOOL_OPERATIONS } from "./background-memory-read.js";

export const BACKGROUND_REGISTRATION_OPERATIONS = {
  affect: { tool: "character_affect.appraise", operation: "memory.route.character_affect_appraise" },
  "character-memory": { tool: "character_memory.append_episode", operation: "memory.route.character_memory_append_episode" },
  "target-memory": { tool: "memory.append", operation: "memory.route.append" },
} as const satisfies Record<BackgroundPurpose, { tool: string; operation: string }>;

/** These operations restore files and therefore require a captured writable export root. */
export const BACKGROUND_MEMORY_FILE_TOOL_OPERATIONS: Readonly<Record<string, string>> = {
  "memory.get_file": "memory.route.get_file",
  "memory.export_files": "memory.route.export_files",
};

export function getBackgroundMemoryFileOperations(): string[] {
  return Object.values(BACKGROUND_MEMORY_FILE_TOOL_OPERATIONS);
}

export function backgroundMemoryToolOperations(purpose: BackgroundPurpose, registrationConnected: boolean,
  fileAccess?: BackgroundMemoryFileAccess): Readonly<Record<string, string>> {
  const registration = BACKGROUND_REGISTRATION_OPERATIONS[purpose];
  return { ...BACKGROUND_MEMORY_READ_TOOL_OPERATIONS,
    ...(purpose === "affect" ? { "character_affect.inspect": "memory.route.character_affect_inspect" } : {}),
    ...(fileAccess?.exportRoot ? BACKGROUND_MEMORY_FILE_TOOL_OPERATIONS : {}),
    ...(registrationConnected ? { [registration.tool]: registration.operation } : {}) };
}
