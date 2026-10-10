import type {
  MessageOperation,
  ProviderDiagnosticMetadata,
  ChangedFile,
  DiffRow,
} from "../../../src-shared/session/runtime-state.js";
import {
  PROVIDER_RAW_ITEM_CLONE_LIMIT,
  boundProviderRawItem,
  stringifyBoundedProviderValue,
  toProviderTextPreview,
  type BoundedProviderRawItem,
} from "../../session/provider-payload-limits.js";
import type { WorkspaceSnapshot } from "../../platform/snapshot-ignore.js";
import { getCodexCommandOutputPreview, getCodexMcpResultPreview, type CodexTurnItem } from "./codex-turn-events.js";
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
): BoundedProviderRawItem[] {
  return items
    .filter((item) => item.type !== "reasoning" && item.type !== "userMessage")
    .map((item) => {
      if (item.type !== "commandExecution") return boundProviderRawItem({ type: item.type, data: { ...item } });
      const { aggregatedOutputOriginalLength, ...data } = item;
      const bounded = boundProviderRawItem({ type: item.type, data });
      if (aggregatedOutputOriginalLength !== undefined && aggregatedOutputOriginalLength > (item.aggregatedOutput?.length ?? 0) && bounded.data) {
        bounded.data.aggregatedOutput = {
          text: getCodexCommandOutputPreview(item),
          truncated: true,
          originalLength: aggregatedOutputOriginalLength,
        };
        if (JSON.stringify(bounded).length > PROVIDER_RAW_ITEM_CLONE_LIMIT) return boundProviderRawItem(bounded);
      }
      return bounded;
    });
}
export function buildCodexProviderMetadata(
  items: CodexTurnItem[],
): ProviderDiagnosticMetadata[] {
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
      payload: boundProviderRawItem({ type: item.type, data: { item } }),
    }));
}
export function toMessageOperations(items: CodexTurnItem[]): MessageOperation[] {
  const operationStatus = (status: string): string => status === "inProgress" ? "in_progress" : status === "declined" ? "failed" : status;
  return items.flatMap((item): MessageOperation[] => {
    switch (item.type) {
      case "userMessage":
      case "reasoning":
        return [];
      case "agentMessage":
        return [
          {
            id: item.id,
            type: "agent_message",
            summary: toProviderTextPreview(item.text) ?? "",
          },
        ];
      case "commandExecution":
        return [
          {
            id: item.id,
            status: operationStatus(item.status),
            ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}),
            ...(item.aggregatedOutputOriginalLength !== undefined ? { truncated: item.aggregatedOutputOriginalLength > (item.aggregatedOutput?.length ?? 0) } : {}),
            type: "command_execution",
            summary: toProviderTextPreview(item.command) ?? "",
            details: getCodexCommandOutputPreview(item) ?? (item.exitCode === null ? "" : `exit code: ${item.exitCode}`),
          },
        ];
      case "fileChange":
        return item.changes.map((change) => ({
          id: item.id,
          status: operationStatus(item.status),
          type: "file_change",
          summary: `${change.kind.type}: ${change.path}`,
          details: toProviderTextPreview(change.diff),
        }));
      case "mcpToolCall":
        return [
          {
            id: item.id,
            status: operationStatus(item.status),
            ...(item.error ? { error: { message: toProviderTextPreview(item.error.message) ?? "" } } : {}),
            type: "mcp_tool_call",
            summary: `${item.server}/${item.tool}`,
            details: getCodexMcpResultPreview(item),
          },
        ];
      case "collabAgentToolCall":
        return [
          {
            id: item.id,
            status: operationStatus(item.status),
            type: "collab_tool_call",
            summary: item.tool,
            details: stringifyBoundedProviderValue(item.agentsStates),
          },
        ];
      case "webSearch":
        return [
          {
            id: item.id,
            type: "web_search",
            summary: item.query ?? "Web search",
            details: stringifyBoundedProviderValue(item.action),
          },
        ];
      case "plan":
        return [{ id: item.id, type: "plan", summary: toProviderTextPreview(item.text) ?? "" }];
      default:
        return [
          {
            type: "unknown",
            summary: stringifyBoundedProviderValue(item) ?? "Unknown item",
          },
        ];
    }
  });
}
