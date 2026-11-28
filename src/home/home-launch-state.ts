import type {
  CreateSessionRequest,
  HomeSessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterThemeColors,
} from "../../src-shared/character/character-state.js";
import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { NEUTRAL_CHARACTER_ID } from "../../src-shared/character/character-owner.js";
import {
  selectWeightedRandomLaunchCharacterId,
  type CharacterUsageSessionSource,
} from "../../src-shared/character/launch-character-selection.js";
import {
  inferWorkspaceFromPath,
  isSessionFolderLaunchWorkspace,
  resolveLaunchDirectoryWorkspace,
  type LaunchWorkspaceSelection,
} from "./home-launch-workspace.js";
import { LAUNCH_NO_PROVIDER_SELECTED_MESSAGE } from "../launch/launch-feedback.js";
import type { DirectoryPathValidationState } from "../launch/directory-path-validation.js";
import type {
  MateProfile,
  MateStorageState,
} from "../../src-shared/mate/mate-state.js";
import {
  resolveWorkspaceDirectoryValidationMessage,
  type WorkspaceDirectoryValidationResult,
} from "../../src-shared/window/workspace-directory-validation.js";

const NEUTRAL_CHARACTER_NAME = "WithMate";

/** 起動時に選ばれた Character の識別子と、表示用プロフィールおよびテーマの写し。 */
type LaunchCharacterSnapshot = {
  characterId: string;
  character: string;
  characterRoleMarkdown: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
};

/** 指定した Character で起動するか、起動時にランダムに割り当てるかの選択。 */
export type LaunchCharacterSelectionMode = "specific" | "random";
/** Character 一覧を取得中・取得済み・取得失敗のどれとして扱うかを表す。 */
export type HomeCharacterLoadStatus = "loading" | "loaded" | "error";

/** 起動に使う Character 一覧と、一覧が確定したかどうかの状態。 */
export type HomeLaunchCharacterCatalog = {
  entries: readonly CharacterCatalogEntry[];
  status: HomeCharacterLoadStatus;
};

/** 起動前の入力。入力中のパスと、検証に成功して選定済みのワークスペースを分けて保持する。 */
export type HomeLaunchDraft = {
  open: boolean;
  title: string;
  workspacePathInput: string;
  workspaceValidation: DirectoryPathValidationState;
  workspaceValidationMessage: string;
  workspace: LaunchWorkspaceSelection | null;
  providerId: string;
  characterSelectionMode: LaunchCharacterSelectionMode;
  characterId: string;
  sessionRole: "standalone" | "overall-coordinator";
};

/** 未入力・未選択の閉じた起動欄を初期化する。役割は Standalone、Character はランダムが既定。 */
export function createClosedLaunchDraft(): HomeLaunchDraft {
  return {
    open: false,
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: "",
    characterSelectionMode: "random",
    characterId: "",
    sessionRole: "standalone",
  };
}

/** 起動欄を開き、以前の入力や検証状態を残さず、現在の既定 Provider から始める。 */
export function openLaunchDraft(
  draft: HomeLaunchDraft,
  defaultProviderId: string,
): HomeLaunchDraft {
  return {
    ...draft,
    open: true,
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: defaultProviderId,
    characterSelectionMode: "random",
    characterId: "",
    sessionRole: "standalone",
  };
}

/** 起動欄を閉じ、未確定の入力やパスの検証結果を次回へ持ち越さない。 */
export function closeLaunchDraft(draft: HomeLaunchDraft): HomeLaunchDraft {
  return {
    ...draft,
    open: false,
    title: "",
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: null,
    providerId: "",
    characterSelectionMode: "random",
    characterId: "",
    sessionRole: "standalone",
  };
}

/** 選択または検証済みのディレクトリを入力値と起動先の両方へ反映する。 */
export function setLaunchWorkspaceFromPath(
  draft: HomeLaunchDraft,
  selectedPath: string,
): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: selectedPath,
    workspaceValidation: "valid",
    workspaceValidationMessage: "",
    workspace: inferWorkspaceFromPath(selectedPath),
  };
}

/** 手入力が変わったら以前の起動先を解除し、空でなければ検証前の待機状態にする。 */
export function beginLaunchWorkspacePathValidation(
  draft: HomeLaunchDraft,
  targetPath: string,
): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: targetPath,
    workspaceValidation: targetPath.length > 0 ? "debouncing" : "idle",
    workspaceValidationMessage: "",
    workspace: null,
  };
}

/** 検証が始まったパスが入力欄に残っている場合のみ、検証中に切り替える。 */
export function markLaunchWorkspacePathValidationPending(
  draft: HomeLaunchDraft,
  targetPath: string,
): HomeLaunchDraft {
  if (draft.workspacePathInput !== targetPath) {
    return draft;
  }
  return {
    ...draft,
    workspaceValidation: "pending",
  };
}

/** 現在も検証中の同じ入力にだけ結果を反映し、成功なら起動先、失敗なら理由を保持する。 */
export function applyLaunchWorkspacePathValidation(
  draft: HomeLaunchDraft,
  targetPath: string,
  result: WorkspaceDirectoryValidationResult,
): HomeLaunchDraft {
  if (
    draft.workspacePathInput !== targetPath ||
    draft.workspaceValidation !== "pending"
  ) {
    return draft;
  }
  if (result.valid) {
    return setLaunchWorkspaceFromPath(draft, targetPath);
  }
  return {
    ...draft,
    workspaceValidation: "invalid",
    workspaceValidationMessage:
      resolveWorkspaceDirectoryValidationMessage(result),
    workspace: null,
  };
}

/** 起動先を専用 Session Folder に切り替え、既存ディレクトリのパスと検証状態を消す。 */
export function setLaunchWorkspaceToSessionFolder(
  draft: HomeLaunchDraft,
): HomeLaunchDraft {
  return {
    ...draft,
    workspacePathInput: "",
    workspaceValidation: "idle",
    workspaceValidationMessage: "",
    workspace: { kind: "session-folder" },
  };
}

/** 起動用の Provider だけを差し替え、他の入力を保つ。 */
export function updateLaunchDraftForProviderSelection(
  draft: HomeLaunchDraft,
  providerId: string,
): HomeLaunchDraft {
  return {
    ...draft,
    providerId,
  };
}

/** 指定された Character ID を保持し、起動時のランダム選択を解除する。 */
export function updateLaunchDraftForCharacterSelection(
  draft: HomeLaunchDraft,
  characterId: string,
): HomeLaunchDraft {
  return {
    ...draft,
    characterSelectionMode: "specific",
    characterId,
  };
}

/** Character を起動時に選ぶ方式へ切り替える。保存済みの ID 自体はここでは消さない。 */
export function updateLaunchDraftForRandomCharacterSelection(
  draft: HomeLaunchDraft,
): HomeLaunchDraft {
  return {
    ...draft,
    characterSelectionMode: "random",
  };
}

/** タイトル、ワークスペース、Provider の順に不足を案内し、すべて揃えば空を返す。 */
export function resolveLaunchValidationMessage({
  draft,
  mateState: _mateState,
  mateProfile: _mateProfile,
  selectedProviderId,
}: {
  draft: HomeLaunchDraft;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
}): string {
  if (!draft.title.trim()) {
    return "Enter a session title.";
  }
  if (!draft.workspace) {
    return "Choose a workspace.";
  }
  if (!selectedProviderId) {
    return LAUNCH_NO_PROVIDER_SELECTED_MESSAGE;
  }
  return "";
}

/** 起動に必要な値を確定し、ディレクトリと専用フォルダーを区別した作成要求を作る。不足があれば null。 */
export function buildCreateSessionRequestFromLaunchDraft({
  draft,
  mateProfile,
  selectedProviderId,
  characterEntries = [],
  sessions = [],
  openSessionCharacterIds = [],
  random = Math.random,
}: {
  draft: HomeLaunchDraft;
  mateProfile: MateProfile | null;
  selectedProviderId: string | null;
  characterEntries?: readonly CharacterCatalogEntry[];
  sessions?: readonly CharacterUsageSessionSource[];
  openSessionCharacterIds?: readonly string[];
  random?: () => number;
}): CreateSessionRequest | null {
  const normalizedTitle = draft.title.trim();
  if (!normalizedTitle || !draft.workspace || !selectedProviderId) {
    return null;
  }
  const characterSnapshot = buildLaunchCharacterSnapshot(
    characterEntries,
    draft,
    sessions,
    openSessionCharacterIds,
    random,
  );
  if (!characterSnapshot) {
    return null;
  }
  const workspace = isSessionFolderLaunchWorkspace(draft.workspace)
    ? { kind: "session-folder" as const }
    : {
        kind: "directory" as const,
        label: draft.workspace.label,
        path: draft.workspace.path,
        branch: draft.workspace.branch,
      };

  return {
    provider: selectedProviderId,
    sessionRole: draft.sessionRole,
    taskTitle: normalizedTitle,
    workspace,
    characterId: characterSnapshot.characterId,
    character: characterSnapshot.character,
    characterIconPath: characterSnapshot.characterIconPath,
    characterThemeColors: characterSnapshot.characterThemeColors,
  };
}

/** 選択済み ID が現在も有効な Character なら維持し、それ以外は未指定に戻す。 */
export function resolveLaunchCharacterId(
  entries: readonly CharacterCatalogEntry[],
  currentCharacterId: string | null | undefined,
): string {
  if (
    currentCharacterId &&
    entries.some(
      (entry) => entry.state === "active" && entry.id === currentCharacterId,
    )
  ) {
    return currentCharacterId;
  }

  return "";
}

/** 有効な Character だけから対象を取得し、削除・非アクティブなどで見つからなければ null。 */
function resolveLaunchCharacterEntry(
  entries: readonly CharacterCatalogEntry[],
  characterId: string | null | undefined,
): CharacterCatalogEntry | null {
  const resolvedCharacterId = resolveLaunchCharacterId(entries, characterId);
  return (
    entries.find(
      (entry) => entry.state === "active" && entry.id === resolvedCharacterId,
    ) ?? null
  );
}

/** 指定または重み付き抽選で Character を確定する。見つからない場合の中立値はランダム選択にだけ使う。 */
function buildLaunchCharacterSnapshot(
  entries: readonly CharacterCatalogEntry[],
  draft: Pick<HomeLaunchDraft, "characterId" | "characterSelectionMode">,
  sessions: readonly CharacterUsageSessionSource[],
  openSessionCharacterIds: readonly string[],
  random: () => number,
): LaunchCharacterSnapshot | null {
  const characterId =
    draft.characterSelectionMode === "random"
      ? selectWeightedRandomLaunchCharacterId(
          entries,
          sessions,
          openSessionCharacterIds,
          random,
        )
      : draft.characterId;
  const character = resolveLaunchCharacterEntry(entries, characterId);
  if (!character) {
    if (draft.characterSelectionMode === "specific") {
      return null;
    }
    return {
      characterId: NEUTRAL_CHARACTER_ID,
      character: NEUTRAL_CHARACTER_NAME,
      characterRoleMarkdown: "",
      characterIconPath: "",
      characterThemeColors: { ...DEFAULT_CHARACTER_THEME_COLORS },
    };
  }

  return {
    characterId: character.id,
    character: character.name,
    characterRoleMarkdown: character.description,
    characterIconPath: character.iconFilePath,
    characterThemeColors: {
      main: character.theme.main,
      sub: character.theme.sub,
    },
  };
}
