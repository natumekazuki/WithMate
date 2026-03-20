import { useState, type CSSProperties } from "react";

import type { CharacterVisual, ChangedFile, Session } from "./app-state.js";
import { reasoningEffortLabel, type ModelCatalogItem, type ModelCatalogProvider, type ModelReasoningEffort } from "./model-catalog.js";

export const approvalModeOptions = [
  { id: "on-request", label: "都度確認" },
  { id: "never", label: "確認しない" },
  { id: "untrusted", label: "未信頼時のみ確認" },
] as const;

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

export function sessionStateLabel(session: Session): string {
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

export function approvalModeLabel(approvalMode: string): string {
  return approvalModeOptions.find((option) => option.id === approvalMode)?.label ?? approvalMode;
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

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#6f8cff";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function toRgba(color: string, alpha: number): string {
  const rgb = hexToRgb(color);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function relativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function buildCardThemeStyle(theme: { main: string; sub: string }): CSSProperties {
  const ink = relativeLuminance(theme.main) > 0.36 ? "#0f172a" : "#f8fafc";
  const muted = ink === "#0f172a" ? "rgba(15, 23, 42, 0.72)" : "rgba(248, 250, 252, 0.82)";

  return {
    "--card-main": theme.main,
    "--card-sub": theme.sub,
    "--card-ink": ink,
    "--card-muted": muted,
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
