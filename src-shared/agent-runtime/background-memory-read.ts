/** Background tool publication and application authorization share this exact allowlist. */
export const BACKGROUND_MEMORY_READ_TOOL_OPERATIONS: Readonly<Record<string, string>> = {
  "memory.search": "memory.route.search",
  "memory.list_entries": "memory.route.list_entries",
  "memory.get_entry": "memory.route.get_entry",
  "memory.list_tags": "memory.route.list_tags",
  "memory.list_targets": "memory.route.list_targets",
  "memory.audit": "memory.route.audit",
  "memory.characters": "memory.route.characters",
  "memory.status": "memory.route.runtime_status",
  "memory.instances": "memory.route.runtime_instances",
  "memory.file_usage": "memory.route.file_usage",
  "character_context.get": "memory.route.character_context_get",
  "character_context.metrics": "memory.route.character_context_metrics",
  "character_affect.inspect": "memory.route.character_affect_inspect",
  "character_memory.search": "memory.route.character_memory_search",
};

export function getBackgroundMemoryReadOperations(): string[] {
  return Object.values(BACKGROUND_MEMORY_READ_TOOL_OPERATIONS);
}
