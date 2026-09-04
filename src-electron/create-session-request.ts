import {
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
} from "../src/character/character-owner.js";
import { normalizeCharacterRuntimeSnapshot } from "../src/character/character-runtime-snapshot.js";
import type {
  CreateSessionInput,
  CreateSessionWorkspaceRequest,
  SessionKind,
} from "../src/session-state.js";
import { type RootSessionRole } from "../src/session-role-binding.js";

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
  | "model"
  | "reasoningEffort"
  | "customAgentName"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} の形式が正しくないよ。`);
  }
  return value;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} の形式が正しくないよ。`);
  }
  return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  return value === undefined ? undefined : requireString(value, fieldName);
}

function optionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} の形式が正しくないよ。`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
): T {
  const normalized = requireString(value, fieldName);
  if (!allowedValues.includes(normalized as T)) {
    throw new Error(`${fieldName} の値を解釈できないよ。`);
  }
  return normalized as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
): T | undefined {
  return value === undefined ? undefined : requireEnum(value, fieldName, allowedValues);
}

function optionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${fieldName} の形式が正しくないよ。`);
  }
  return [...value];
}

export function parseCreateSessionRequest(input: unknown): {
  sessionInput: CreateSessionMetadataInput;
  workspace: CreateSessionWorkspaceRequest;
} {
  const request = requireRecord(input, "session");
  const theme = requireRecord(request.characterThemeColors, "characterThemeColors");
  const runtimeSnapshot = request.characterRuntimeSnapshot === undefined || request.characterRuntimeSnapshot === null
    ? request.characterRuntimeSnapshot
    : normalizeCharacterRuntimeSnapshot(request.characterRuntimeSnapshot);
  if (request.characterRuntimeSnapshot !== undefined && request.characterRuntimeSnapshot !== null && !runtimeSnapshot) {
    throw new Error("characterRuntimeSnapshot の形式が正しくないよ。");
  }
  const characterId = normalizeCharacterOwnerId(requireString(request.characterId, "characterId"));
  if (!characterId || isUnknownCharacterOwnerId(characterId)) {
    throw new Error("characterId が空だよ。");
  }
  const normalizedRuntimeSnapshot = runtimeSnapshot;
  if (normalizedRuntimeSnapshot && normalizedRuntimeSnapshot.characterId !== characterId) {
    throw new Error("characterRuntimeSnapshot.characterId が characterId と一致しないよ。");
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
    throw new Error("workspace の作成方法を解釈できないよ。");
  }

  return {
    workspace,
    sessionInput: {
      provider: optionalString(request.provider, "provider"),
      catalogRevision: optionalNumber(request.catalogRevision, "catalogRevision"),
      taskTitle: requireString(request.taskTitle, "taskTitle"),
      rootSessionRole: requireEnum<RootSessionRole>(
        request.rootSessionRole,
        "rootSessionRole",
        ["standalone", "overall-coordinator"],
      ),
      sessionKind: optionalEnum<SessionKind>(
        request.sessionKind,
        "sessionKind",
        ["default", "character-authoring"],
      ),
      characterId,
      character: requireString(request.character, "character"),
      characterIconPath: requireString(request.characterIconPath, "characterIconPath"),
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
