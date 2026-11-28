import { useState, type CSSProperties } from "react";

import type { CharacterVisual } from "../../src-shared/character/character-state.js";
import type { ChangedFile } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import {
  reasoningEffortLabel,
  type ModelCatalogItem,
  type ModelCatalogProvider,
  type ModelReasoningEffort,
} from "../../src-shared/settings/model-catalog.js";
import { buildThemeInkPalette, toRgba } from "./theme-utils.js";
export {
  approvalModeLabel,
  approvalModeOptions,
} from "../../src-shared/settings/approval-mode.js";

/** 区切りをスラッシュに揃え、Windowsのドライブ付きパスやスラッシュ始まりのパスを file URL 表記にする。 */
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

/** 画像などのアセット参照に使う URL を返す。data URL と既存の file URL はそのまま返す。 */
export function toAssetPath(filePath: string): string {
  if (filePath.startsWith("data:")) {
    return filePath;
  }

  if (filePath.startsWith("file://")) {
    return filePath;
  }

  return toFileUrl(filePath);
}

/** アイコンを表示できない場合に使う、名前の先頭部分を取り出す。 */
function fallbackLabel(name: string): string {
  return name.slice(0, 1);
}

/** Sessionの状態を画面用ラベルに変換し、認識しない状態は `Unknown` と表示する。 */
export function sessionStatusLabel(status: Session["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    case "saved":
      return "Saved";
    default:
      return "Unknown";
  }
}

/** 実行ステップの状態を表示用に変換し、記録がない状態と未対応の状態を区別する。 */
export function liveRunStepStatusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "pending":
      return "Pending";
    case "unknown":
      return "Not Recorded";
    default:
      return "Unknown";
  }
}

/** コマンド、Todo、MCPツールでは詳細の内容を見出しに示し、その他は共通の見出しにする。 */
export function liveRunStepDetailsLabel(type: string): string {
  switch (type) {
    case "command_execution":
      return "Output Details";
    case "todo_list":
      return "Todo Details";
    case "mcp_tool_call":
      return "Tool Details";
    default:
      return "Details";
  }
}

/** 実行履歴の操作種別を短い表示名に置き換え、未定義の種別では元の値を表示する。 */
export function operationTypeLabel(type: string): string {
  switch (type) {
    case "agent_message":
      return "Message";
    case "approval_request":
      return "Approval";
    case "command_execution":
      return "Command";
    case "elicitation_request":
      return "Input";
    case "file_change":
      return "File";
    case "mcp_tool_call":
      return "MCP";
    case "web_search":
      return "Web";
    case "image_view":
      return "Image";
    case "sleep":
      return "Wait";
    case "context_compaction":
      return "Compaction";
    case "subagent_activity":
      return "Subagent";
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

/** 推論の強度を、モデルカタログと同じ表記で返す。 */
export function reasoningDepthLabel(
  reasoningEffort: ModelReasoningEffort,
): string {
  return reasoningEffortLabel(reasoningEffort);
}

/** モデルIDに対応するカタログ表示名を使い、カタログにない場合はIDをそのまま返す。 */
export function modelDisplayLabel(
  providerCatalog: ModelCatalogProvider | null,
  model: string,
): string {
  return (
    providerCatalog?.models.find((entry) => entry.id === model)?.label ?? model
  );
}

/** モデル選択肢に使う、個別のカタログ項目の表示名を取り出す。 */
export function modelOptionLabel(model: ModelCatalogItem): string {
  return model.label;
}

/** ファイルの追加・変更・削除を画面用に表記し、未定義の値はそのまま返す。 */
export function fileKindLabel(kind: ChangedFile["kind"]): string {
  switch (kind) {
    case "add":
      return "Added";
    case "edit":
      return "Modified";
    case "delete":
      return "Deleted";
    default:
      return kind;
  }
}

/** キャラクターの主色と副色から、カードの文字色・枠線・影に使うCSSカスタムプロパティを構成する。 */
export function buildCardThemeStyle(theme: {
  main: string;
  sub: string;
}): CSSProperties {
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

/** キャラクターの装飾用アイコンを描画し、画像がないか読み込めない場合は名前の先頭を表示する。 */
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
    <div
      className={`character-avatar ${size} ${className}`.trim()}
      aria-hidden="true"
    >
      <span className="avatar-fallback">
        {fallbackLabel(character.name || "?")}
      </span>
      {imageFailed || !src ? null : (
        <img src={src} alt="" onError={() => setImageFailed(true)} />
      )}
    </div>
  );
}
