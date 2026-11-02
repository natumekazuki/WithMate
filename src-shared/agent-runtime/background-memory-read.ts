/** Background tool publication and application authorization share this exact allowlist. */
export const BACKGROUND_MEMORY_READ_TOOL_OPERATIONS: Readonly<Record<string, string>> = {
  "memory.search": "memory.route.search",
  "memory.list_entries": "memory.route.list_entries",
  "memory.get_entry": "memory.route.get_entry",
  "memory.list_tags": "memory.route.list_tags",
  "character_memory.search": "memory.route.character_memory_search",
};

export function getBackgroundMemoryReadOperations(): string[] {
  return Object.values(BACKGROUND_MEMORY_READ_TOOL_OPERATIONS);
}
