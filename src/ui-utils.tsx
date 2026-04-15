import { useState, type CSSProperties } from "react";

import type { CharacterVisual, ChangedFile, Session } from "./app-state.js";
import { reasoningEffortLabel, type ModelCatalogItem, type ModelCatalogProvider, type ModelReasoningEffort } from "./model-catalog.js";
import { buildThemeInkPalette, toRgba } from "./theme-utils.js";
export { approvalModeLabel, approvalModeOptions } from "./approval-mode.js";

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }

  return `file:///${encodeURI(normalized)}`;
}

export function toAssetPath(filePath: string): string {
  if (filePath.startsWith("data:")) {
    return filePath;
  }

  if (filePath.startsWith("file://")) {
    return filePath;
  }

  return toFileUrl(filePath);
}

function fallbackLabel(name: string): string {
  return name.slice(0, 1);
}

type SessionStateSnapshot = Pick<Session, "status" | "runState">;

function statusLabel(status: Session["status"]): string {
  switch (status) {
    case "running":
      return "実行中";
    case "idle":
      return "待機";
    case "saved":
      return "保存";
    default:
      return status;
  }
}

export function sessionStateLabel(session: SessionStateSnapshot): string {
  if (session.runState === "interrupted") {
    return "中断";
  }

  return statusLabel(session.status);
}

export function sessionStateClassName(session: Session): string {
  if (session.runState === "interrupted") {
    return "interrupted";
  }

  return session.status;
}

export function liveRunStepStatusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "実行中";
    case "completed":
      return "完了";
    case "failed":
      return "エラー";
    case "canceled":
      return "キャンセル";
    case "pending":
      return "待機";
    default:
      return status;
  }
}

export function liveRunStepDetailsLabel(type: string): string {
  switch (type) {
    case "command_execution":
      return "出力詳細";
    case "todo_list":
      return "Todo 詳細";
    case "mcp_tool_call":
      return "Tool 詳細";
    default:
      return "詳細";
  }
}

export function operationTypeLabel(type: string): string {
  switch (type) {
    case "agent_message":
      return "Message";
    case "command_execution":
      return "Command";
    case "file_change":
      return "File";
    case "mcp_tool_call":
      return "MCP";
    case "web_search":
      return "Web";
    case "todo_list":
      return "Todo";
    case "reasoning":
      return "Reasoning";
    case "error":
      return "Error";
    default:
      return type;
  }
}

export function reasoningDepthLabel(reasoningEffort: ModelReasoningEffort): string {
  return reasoningEffortLabel(reasoningEffort);
}

export function modelDisplayLabel(providerCatalog: ModelCatalogProvider | null, model: string): string {
  return providerCatalog?.models.find((entry) => entry.id === model)?.label ?? model;
}

export function modelOptionLabel(model: ModelCatalogItem): string {
  return model.label;
}

export function fileKindLabel(kind: ChangedFile["kind"]): string {
  switch (kind) {
    case "add":
      return "ADD";
    case "edit":
      return "EDIT";
    case "delete":
      return "DEL";
    default:
      return kind;
  }
}

export function buildCardThemeStyle(theme: { main: string; sub: string }): CSSProperties {
  const inkPalette = buildThemeInkPalette(theme.main);

  return {
    "--card-main": theme.main,
    "--card-sub": theme.sub,
    "--card-ink": inkPalette.ink,
    "--card-muted": inkPalette.muted,
    "--card-border": toRgba(theme.sub, 0.38),
    "--card-shadow": toRgba(theme.main, 0.24),
  } as CSSProperties;
}

export function CharacterAvatar({
  character,
  size = "medium",
  className = "",
}: {
  character: CharacterVisual;
  size?: "tiny" | "small" | "medium" | "large";
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = character.iconPath ? toAssetPath(character.iconPath) : null;

  return (
    <div className={`character-avatar ${size} ${className}`.trim()} aria-hidden="true">
      <span className="avatar-fallback">{fallbackLabel(character.name || "?")}</span>
      {imageFailed || !src ? null : <img src={src} alt="" onError={() => setImageFailed(true)} />}
    </div>
  );
}
