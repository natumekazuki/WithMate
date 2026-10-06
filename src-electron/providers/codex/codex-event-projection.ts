import type {
  AuditLogOperation,
  AuditLogProviderMetadata,
  ChangedFile,
  DiffRow,
} from "../../../src-shared/session/runtime-state.js";
import {
  AUDIT_RAW_ITEM_CLONE_LIMIT,
  boundAuditRawItem,
  stringifyBoundedAuditValue,
  toAuditTextPreview,
  type BoundedAuditRawItem,
} from "../../session/audit-payload-limits.js";
import type { WorkspaceSnapshot } from "../../platform/snapshot-ignore.js";
import { getCodexCommandOutputPreview, type CodexTurnItem } from "./codex-turn-events.js";
export type { CodexTurnItem } from "./codex-turn-events.js";
export type CodexChangedFileProjectionDeps = {
  normalizeWorkspaceRelativePath: (
    workspacePath: string,
    filePath: string,
  ) => string;
  collectCompletedFileChanges: (
    items: CodexTurnItem[],
  ) => Array<{ changes: Array<{ kind: { type: string }; path: string }> }>;
  compareSnapshotChanges: (
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
  ) => Array<{ path: string; kind: ChangedFile["kind"] }>;
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
  const explicitChanges = deps
    .collectCompletedFileChanges(items)
    .flatMap((item) => item.changes)
    .map((change) => ({
      kind:
        change.kind.type === "update"
          ? ("edit" as const)
          : (change.kind.type as ChangedFile["kind"]),
      path: deps.normalizeWorkspaceRelativePath(workspacePath, change.path),
    }));
  const merged = new Map<string, ChangedFile["kind"]>();
  for (const change of explicitChanges) merged.set(change.path, change.kind);
  if (useSnapshotFallback)
    for (const change of deps.compareSnapshotChanges(
      beforeSnapshot,
      afterSnapshot,
    ))
      if (!merged.has(change.path)) merged.set(change.path, change.kind);
  return Array.from(merged.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([filePath, kind]) => ({
      kind,
      path: filePath,
      summary: deps.summarizeChangedFile(kind, filePath),
      diffRows: deps.buildDiffRows(
        kind === "add" ? null : (beforeSnapshot.get(filePath) ?? null),
        kind === "delete" ? null : (afterSnapshot.get(filePath) ?? null),
      ),
    }));
}

export function buildCodexStableRawItems(
  items: CodexTurnItem[],
): BoundedAuditRawItem[] {
  return items
    .filter((item) => item.type !== "reasoning" && item.type !== "userMessage")
    .map((item) => {
      if (item.type !== "commandExecution") return boundAuditRawItem({ type: item.type, data: { ...item } });
      const { aggregatedOutputOriginalLength, ...data } = item;
      const bounded = boundAuditRawItem({ type: item.type, data });
      if (aggregatedOutputOriginalLength !== undefined && aggregatedOutputOriginalLength > (item.aggregatedOutput?.length ?? 0) && bounded.data) {
        bounded.data.aggregatedOutput = {
          text: getCodexCommandOutputPreview(item),
          truncated: true,
          originalLength: aggregatedOutputOriginalLength,
        };
        if (JSON.stringify(bounded).length > AUDIT_RAW_ITEM_CLONE_LIMIT) return boundAuditRawItem(bounded);
      }
      return bounded;
    });
}
export function buildCodexProviderMetadata(
  items: CodexTurnItem[],
): AuditLogProviderMetadata[] {
  const supported = new Set([
    "userMessage",
    "agentMessage",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "collabAgentToolCall",
    "webSearch",
    "plan",
  ]);
  return items
    .filter((item) => !supported.has(item.type))
    .map((item) => ({
      provider: "codex",
      kind: "unsupported_response",
      source: "codex.app-server.ThreadItem",
      responseType: item.type,
      summary: `Unsupported Codex item: ${item.type}`,
      payload: boundAuditRawItem({ type: item.type, data: { item } }),
    }));
}
export function toAuditOperations(items: CodexTurnItem[]): AuditLogOperation[] {
  return items.flatMap((item): AuditLogOperation[] => {
    switch (item.type) {
      case "userMessage":
      case "reasoning":
        return [];
      case "agentMessage":
        return [
          {
            type: "agent_message",
            summary: toAuditTextPreview(item.text) ?? "",
          },
        ];
      case "commandExecution":
        return [
          {
            type: "command_execution",
            summary: toAuditTextPreview(item.command) ?? "",
            details: getCodexCommandOutputPreview(item) ?? (item.exitCode === null ? "" : `exit code: ${item.exitCode}`),
          },
        ];
      case "fileChange":
        return item.changes.map((change) => ({
          type: "file_change",
          summary: `${change.kind.type}: ${change.path}`,
          details: toAuditTextPreview(change.diff),
        }));
      case "mcpToolCall":
        return [
          {
            type: "mcp_tool_call",
            summary: `${item.server}/${item.tool}`,
            details:
              item.error?.message ??
              stringifyBoundedAuditValue(
                item.result?.structuredContent ?? item.arguments,
              ),
          },
        ];
      case "collabAgentToolCall":
        return [
          {
            type: "collab_tool_call",
            summary: item.tool,
            details: stringifyBoundedAuditValue(item.agentsStates),
          },
        ];
      case "webSearch":
        return [
          {
            type: "web_search",
            summary: item.query ?? "Web search",
            details: stringifyBoundedAuditValue(item.action),
          },
        ];
      case "plan":
        return [{ type: "plan", summary: toAuditTextPreview(item.text) ?? "" }];
      default:
        return [
          {
            type: "unknown",
            summary: stringifyBoundedAuditValue(item) ?? "Unknown item",
          },
        ];
    }
  });
}
