import { useState } from "react";

import type { CharacterCatalogItem, ChangedFile, Session } from "./mock-data.js";

export function toViteFsPath(filePath: string): string {
  return `/@fs/${encodeURI(filePath.replace(/\\/g, "/"))}`;
}

function fallbackLabel(name: string): string {
  return name.slice(0, 1);
}

export function statusLabel(status: Session["status"]): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "idle":
      return "IDLE";
    case "saved":
      return "SAVED";
    default:
      return status;
  }
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
  character: CharacterCatalogItem;
  size?: "tiny" | "small" | "medium" | "large";
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = toViteFsPath(character.iconPath);

  return (
    <div className={`character-avatar ${size} ${className}`.trim()} aria-hidden="true">
      <span className="avatar-fallback">{fallbackLabel(character.name)}</span>
      {imageFailed ? null : <img src={src} alt="" onError={() => setImageFailed(true)} />}
    </div>
  );
}
