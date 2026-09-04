import path from "node:path";

import { CHARACTER_CONTEXT_SCHEMA_VERSION } from "../src/character-context/character-context-contract.js";
import { MEMORY_V6_SCHEMA_VERSION } from "../src/memory-v6/memory-contract.js";

export type WithMateMemoryMcpCommand =
  | "file_usage"
  | "list_targets"
  | "list_entries"
  | "search"
  | "get_entry"
  | "get_file"
  | "export_files"
  | "list_tags"
  | "append"
  | "forget"
  | "move_entry"
  | "context_get"
  | "affect_appraise"
  | "character_memory_search"
  | "character_memory_append_episode"
  | "character_memory_correct"
  | "character_memory_forget";

const GENERAL_MEMORY_COMMANDS = new Set<WithMateMemoryMcpCommand>([
  "list_targets",
  "list_entries",
  "search",
  "get_entry",
  "get_file",
  "export_files",
  "list_tags",
  "append",
  "forget",
  "move_entry",
]);

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeProjectPathTargets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeProjectPathTargets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, normalizeProjectPathTargets(item)]),
  );
  if (record.type === "path" && typeof record.path === "string" && isAbsolutePath(record.path)) {
    normalized.path = path.win32.isAbsolute(record.path)
      ? path.win32.normalize(record.path).replace(/\\/g, "/")
      : path.resolve(record.path);
  }
  return normalized;
}

export function buildWithMateMemoryMcpRuntimeBody(
  command: WithMateMemoryMcpCommand,
  publicInput: unknown,
): unknown {
  if (command === "file_usage") {
    return {};
  }
  if (!publicInput || typeof publicInput !== "object" || Array.isArray(publicInput)) {
    return publicInput;
  }

  const input = normalizeProjectPathTargets(publicInput) as Record<string, unknown>;
  if (GENERAL_MEMORY_COMMANDS.has(command)) {
    return { ...input, schemaVersion: MEMORY_V6_SCHEMA_VERSION };
  }
  if (command === "context_get") {
    return {
      ...input,
      memoryLimit: input.memoryLimit ?? 3,
      schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    };
  }
  if (command === "character_memory_search") {
    return {
      ...input,
      limit: input.limit ?? 5,
      schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION,
    };
  }
  return { ...input, schemaVersion: CHARACTER_CONTEXT_SCHEMA_VERSION };
}
