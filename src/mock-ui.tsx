import { useState } from "react";

import type { CharacterVisual, ChangedFile, Session } from "./mock-data.js";
import {
  bundledModelCatalog,
  reasoningEffortLabel,
  type ModelCatalogItem,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "./model-catalog.js";

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

  if (typeof window !== "undefined" && (window.withmate || window.location.protocol === "file:")) {
    return toFileUrl(filePath);
  }

  return `/@fs/${encodeURI(filePath.replace(/\\/g, "/"))}`;
}

function fallbackLabel(name: string): string {
  return name.slice(0, 1);
}

export function statusLabel(status: Session["status"]): string {
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

export function reasoningDepthLabel(reasoningEffort: ModelReasoningEffort): string {
  return reasoningEffortLabel(reasoningEffort);
}

export function modelDisplayLabel(model: string): string {
  return bundledModelCatalog.find((entry) => entry.id === model)?.label ?? model;
}

export function resolvedModelSelectionLabel(selection: ResolvedModelSelection): string {
  const modelLabel =
    selection.requestedModel === selection.resolvedModel
      ? modelDisplayLabel(selection.resolvedModel)
      : `${selection.requestedModel} -> ${selection.resolvedModel}`;
  const reasoningLabel =
    selection.requestedReasoningEffort === selection.resolvedReasoningEffort
      ? reasoningDepthLabel(selection.resolvedReasoningEffort)
      : `${reasoningDepthLabel(selection.requestedReasoningEffort)} -> ${reasoningDepthLabel(selection.resolvedReasoningEffort)}`;

  return `${modelLabel} / ${reasoningLabel}`;
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
