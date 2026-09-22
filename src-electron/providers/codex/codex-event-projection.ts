import type { ThreadItem } from "@openai/codex-sdk";
import type { AuditLogOperation, AuditLogProviderMetadata, ChangedFile, DiffRow } from "../../../src-shared/session/runtime-state.js";
import { boundAuditRawItem, stringifyBoundedAuditValue, toAuditTextPreview, type BoundedAuditRawItem } from "../../session/audit-payload-limits.js";
import type { WorkspaceSnapshot } from "../../platform/snapshot-ignore.js";

export type CodexCollabToolCallItem = {
  id: string;
  type: "collab_tool_call";
  tool?: string;
  status?: string;
  agents_states?: unknown;
  error?: { message?: string };
};
export type CodexTurnItem = ThreadItem | CodexCollabToolCallItem;

export type CodexChangedFileProjectionDeps = {
  normalizeWorkspaceRelativePath: (workspacePath: string, filePath: string) => string;
  collectCompletedFileChanges: (items: CodexTurnItem[]) => Array<{ changes: Array<{ kind: string; path: string }> }>;
  compareSnapshotChanges: (before: WorkspaceSnapshot, after: WorkspaceSnapshot) => Array<{ path: string; kind: ChangedFile["kind"] }>;
  summarizeChangedFile: (kind: ChangedFile["kind"], filePath: string) => string;
  buildDiffRows: (before: string | null, after: string | null) => DiffRow[];
};

export function buildChangedFilesFromSources(
  workspacePath: string,
  items: CodexTurnItem[],
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
  useSnapshotFallback: boolean,
  deps: CodexChangedFileProjectionDeps,
): ChangedFile[] {
  const explicitChanges = deps.collectCompletedFileChanges(items).flatMap((item) => item.changes).map((change) => ({
    kind: change.kind === "update" ? "edit" as const : change.kind as ChangedFile["kind"],
    path: deps.normalizeWorkspaceRelativePath(workspacePath, change.path),
  }));
  const merged = new Map<string, ChangedFile["kind"]>();
  for (const change of explicitChanges) merged.set(change.path, change.kind);
  if (useSnapshotFallback) for (const change of deps.compareSnapshotChanges(beforeSnapshot, afterSnapshot)) if (!merged.has(change.path)) merged.set(change.path, change.kind);
  return Array.from(merged.entries()).sort((left, right) => left[0].localeCompare(right[0])).map(([filePath, kind]) => ({
    kind,
    path: filePath,
    summary: deps.summarizeChangedFile(kind, filePath),
    diffRows: deps.buildDiffRows(kind === "add" ? null : beforeSnapshot.get(filePath) ?? null, kind === "delete" ? null : afterSnapshot.get(filePath) ?? null),
  }));
}

function isCodexCollabToolCallItem(item: unknown): item is CodexCollabToolCallItem {
  return Boolean(
    item
    && typeof item === "object"
    && typeof (item as { id?: unknown }).id === "string"
    && (item as { type?: unknown }).type === "collab_tool_call",
  );
}
function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function pushRaw(items: BoundedAuditRawItem[], item: BoundedAuditRawItem): void { items.push(boundAuditRawItem(item)); }

export function buildCodexStableRawItems(items: CodexTurnItem[]): BoundedAuditRawItem[] {
  const rawItems: BoundedAuditRawItem[] = [];
  for (const item of items) {
    if (isCodexCollabToolCallItem(item)) { pushRaw(rawItems, { type: item.type, data: { id: item.id, status: item.status ?? null, tool: item.tool ?? null, agentsStates: item.agents_states ?? null, errorMessage: item.error?.message ?? null } }); continue; }
    switch (item.type) {
      case "command_execution": pushRaw(rawItems, { type: item.type, data: { id: item.id, command: item.command, status: item.status ?? null, exitCode: item.exit_code ?? null, output: item.aggregated_output ?? null } }); break;
      case "file_change": pushRaw(rawItems, { type: item.type, data: { id: item.id, status: item.status ?? null, changes: item.changes.map((change) => ({ kind: change.kind, path: change.path })) } }); break;
      case "mcp_tool_call": pushRaw(rawItems, { type: item.type, data: { id: item.id, status: item.status ?? null, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result?.structured_content ?? null, errorMessage: item.error?.message ?? null } }); break;
      case "web_search": pushRaw(rawItems, { type: item.type, data: { id: item.id, query: item.query } }); break;
      case "todo_list": pushRaw(rawItems, { type: item.type, data: { id: item.id, items: item.items } }); break;
      case "reasoning": break;
      case "error": pushRaw(rawItems, { type: item.type, data: { id: item.id, message: item.message } }); break;
      case "agent_message": pushRaw(rawItems, { type: item.type, data: { id: item.id, text: item.text } }); break;
      default: { const unknownItem = item as Record<string, unknown>; pushRaw(rawItems, { type: typeof unknownItem.type === "string" ? unknownItem.type : "unknown", data: { item: unknownItem } }); }
    }
  }
  return rawItems;
}

function isSupported(item: CodexTurnItem): boolean {
  if (isCodexCollabToolCallItem(item)) return true;
  return ["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list", "reasoning", "error", "agent_message"].includes(item.type);
}
export function buildCodexProviderMetadata(items: CodexTurnItem[]): AuditLogProviderMetadata[] {
  return items.filter((item) => !isSupported(item)).map((item) => {
    const unknownItem = item as Record<string, unknown>;
    const responseType = typeof unknownItem.type === "string" ? unknownItem.type : "unknown";
    return { provider: "codex", kind: "unsupported_response", source: "codex.thread_item", responseType, summary: `Unsupported Codex item: ${responseType}`, payload: boundAuditRawItem({ type: responseType, data: { item: unknownItem } }) };
  });
}
export function toAuditOperations(items: CodexTurnItem[]): AuditLogOperation[] {
  const operations: AuditLogOperation[] = [];
  for (const item of items) {
    if (isCodexCollabToolCallItem(item)) { operations.push({ type: item.type, summary: item.tool ?? "collab tool", details: item.error?.message ? toAuditTextPreview(item.error.message) : stringifyBoundedAuditValue(item.agents_states) }); continue; }
    switch (item.type) {
      case "command_execution": operations.push({ type: item.type, summary: toAuditTextPreview(item.command) ?? item.command, details: toAuditTextPreview(item.aggregated_output || (typeof item.exit_code === "number" ? `exit code: ${item.exit_code}` : undefined)) }); break;
      case "file_change": for (const change of item.changes) operations.push({ type: item.type, summary: `${change.kind}: ${change.path}` }); break;
      case "mcp_tool_call": operations.push({ type: item.type, summary: `${item.server}/${item.tool}`, details: item.error?.message ? toAuditTextPreview(item.error.message) : stringifyBoundedAuditValue(item.result?.structured_content ?? item.arguments) }); break;
      case "web_search": operations.push({ type: item.type, summary: item.query }); break;
      case "todo_list": operations.push({ type: item.type, summary: `${item.items.filter((entry) => entry.completed).length}/${item.items.length} completed`, details: toAuditTextPreview(item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n")) }); break;
      case "error": operations.push({ type: item.type, summary: toAuditTextPreview(item.message) ?? item.message }); break;
      case "agent_message": operations.push({ type: item.type, summary: toAuditTextPreview(item.text) ?? item.text }); break;
      default: operations.push({ type: "unknown", summary: stringifyUnknown(item) ?? "unknown item" });
    }
  }
  return operations;
}
