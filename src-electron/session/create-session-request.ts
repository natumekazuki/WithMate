import {
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
} from "../../src-shared/character/character-owner.js";
import { normalizeCharacterRuntimeSnapshot } from "../../src-shared/character/character-runtime-snapshot.js";
import { type SessionRole } from "../../src-shared/session/session-role.js";
import { validateSessionMetadataPatch } from "../../src-shared/session/session-metadata.js";
import type {
  CreateSessionInput,
  CreateSessionWorkspaceRequest,
  SessionKind,
} from "../../src-shared/session/session-state.js";

/** 作成要求から受け取るメタデータ。ワークスペースと実行設定の確定は後続の処理に委ねる。 */
type CreateSessionMetadataInput = Omit<
  CreateSessionInput,
  | "id"
  | "workspaceLabel"
  | "workspacePath"
  | "branch"
  | "approvalMode"
  | "codexSandboxMode"
  | "codexSpeed"
  | "codexReviewer"
  | "withMateReviewerExplicit"
  | "model"
  | "reasoningEffort"
  | "customAgentName"
>;

/** 名前付きフィールドを読む対象として、null と配列を除いたオブジェクトを受け付ける。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 必須オブジェクトの形式が合わなければ、該当するフィールド名を付けて拒否する。 */
function requireRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} has an invalid format.`);
  }
  return value;
}

/** 文字列を型変換・トリミングせずに受け付け、他の型はフィールド名付きで拒否する。 */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} has an invalid format.`);
  }
  return value;
}

/** undefined だけを省略として扱い、明示された値は必須文字列と同じ条件で読む。 */
function optionalString(value: unknown, fieldName: string): string | undefined {
  return value === undefined ? undefined : requireString(value, fieldName);
}

/** 未指定または有限の数値を受け付け、型変換が必要な値や無限大は拒否する。 */
function optionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} has an invalid format.`);
  }
  return value;
}

/** 文字列が許可済みの候補と完全一致することを確認して返す。 */
function requireEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
): T {
  const normalized = requireString(value, fieldName);
  if (!allowedValues.includes(normalized as T)) {
    throw new Error(`Could not parse the ${fieldName} value.`);
  }
  return normalized as T;
}

/** 未指定は既定値の決定に委ね、明示値は列挙された候補に限る。 */
function optionalEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
): T | undefined {
  return value === undefined
    ? undefined
    : requireEnum(value, fieldName, allowedValues);
}

/** 未指定または文字列だけの配列を受け付け、入力側の配列は共有しない。 */
function optionalStringArray(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${fieldName} has an invalid format.`);
  }
  return [...value];
}

/** 作成要求を検証し、Session のメタデータとワークスペースの取得方法を分けて返す。キャラクターとスナップショットの所有者は一致が必要。 */
export function parseCreateSessionRequest(input: unknown): {
  sessionInput: CreateSessionMetadataInput;
  workspace: CreateSessionWorkspaceRequest;
} {
  const request = requireRecord(input, "session");
  const title = requireString(request.taskTitle, "taskTitle");
  const description = optionalString(request.description, "description");
  if (title.trim() || description !== undefined)
    validateSessionMetadataPatch({
      ...(title.trim() ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  const theme = requireRecord(
    request.characterThemeColors,
    "characterThemeColors",
  );
  const runtimeSnapshot =
    request.characterRuntimeSnapshot === undefined ||
    request.characterRuntimeSnapshot === null
      ? request.characterRuntimeSnapshot
      : normalizeCharacterRuntimeSnapshot(request.characterRuntimeSnapshot);
  if (
    request.characterRuntimeSnapshot !== undefined &&
    request.characterRuntimeSnapshot !== null &&
    !runtimeSnapshot
  ) {
    throw new Error("characterRuntimeSnapshot has an invalid format.");
  }
  const characterId = normalizeCharacterOwnerId(
    requireString(request.characterId, "characterId"),
  );
  if (!characterId || isUnknownCharacterOwnerId(characterId)) {
    throw new Error("characterId cannot be empty.");
  }
  const normalizedRuntimeSnapshot = runtimeSnapshot;
  if (
    normalizedRuntimeSnapshot &&
    normalizedRuntimeSnapshot.characterId !== characterId
  ) {
    throw new Error(
      "characterRuntimeSnapshot.characterId does not match characterId.",
    );
  }

  const workspaceInput = requireRecord(request.workspace, "workspace");
  const workspaceKind = requireString(workspaceInput.kind, "workspace.kind");
  let workspace: CreateSessionWorkspaceRequest;
  if (workspaceKind === "directory") {
    workspace = {
      kind: "directory",
      label: requireString(workspaceInput.label, "workspace.label"),
      path: requireString(workspaceInput.path, "workspace.path"),
      branch: requireString(workspaceInput.branch, "workspace.branch"),
    };
  } else if (workspaceKind === "session-folder") {
    workspace = { kind: "session-folder" };
  } else {
    throw new Error("Could not parse the workspace creation method.");
  }

  return {
    workspace,
    sessionInput: {
      provider: optionalString(request.provider, "provider"),
      catalogRevision: optionalNumber(
        request.catalogRevision,
        "catalogRevision",
      ),
      taskTitle: title,
      description,
      sessionRole: optionalEnum<SessionRole>(
        request.sessionRole,
        "sessionRole",
        ["standalone", "overall-coordinator"],
      ),
      sessionKind: optionalEnum<SessionKind>(
        request.sessionKind,
        "sessionKind",
        ["default", "character-authoring"],
      ),
      characterId,
      character: requireString(request.character, "character"),
      characterIconPath: requireString(
        request.characterIconPath,
        "characterIconPath",
      ),
      characterThemeColors: {
        main: requireString(theme.main, "characterThemeColors.main"),
        sub: requireString(theme.sub, "characterThemeColors.sub"),
      },
      characterRuntimeSnapshot: normalizedRuntimeSnapshot,
      allowedAdditionalDirectories: optionalStringArray(
        request.allowedAdditionalDirectories,
        "allowedAdditionalDirectories",
      ),
    },
  };
}
