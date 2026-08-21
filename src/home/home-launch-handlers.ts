import type { CompanionSessionSummary } from "../companion-state.js";
import type { CharacterCatalogEntry } from "../character/character-catalog.js";
import type { CreateSessionRequest, SessionCharacterUsage, SessionSummary } from "../session-state.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { CreateCompanionSessionInput, CompanionSession } from "../companion-state.js";
import type { ModelCatalogProvider } from "../model-catalog.js";
import type { SessionSummariesLoadStatus } from "../session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../open-session-window-subscription.js";
import type { HomeLaunchDraft } from "./home-launch-state.js";
import {
  closeLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceToSessionFolder,
  updateLaunchDraftForCharacterSelection,
  updateLaunchDraftForProviderSelection,
  updateLaunchDraftForRandomCharacterSelection,
  updateLaunchDraftForSessionPurpose,
  type HomeLaunchSessionPurpose,
} from "./home-launch-state.js";
import { isSessionFolderLaunchWorkspace } from "./home-launch-workspace.js";
import { startHomeLaunch } from "./home-launch-actions.js";

type HomeLaunchHandlersContext = {
  launchDraft: HomeLaunchDraft;
  launchStarting: boolean;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  enabledLaunchProviders: readonly ModelCatalogProvider[];
  characterEntries: readonly CharacterCatalogEntry[];
  selectedLaunchProviderId: string | null;
  sessions: readonly SessionSummary[];
  sessionCharacterUsage: readonly SessionCharacterUsage[];
  openSessionWindowIds: readonly string[];
  openSessionWindowIdsLoadStatus: OpenSessionWindowIdsLoadStatus;
  sessionCharacterUsageLoadStatus: SessionSummariesLoadStatus;
  refreshCharacterEntries: () => Promise<readonly CharacterCatalogEntry[]>;
  setCharactersLoaded: (loaded: boolean) => void;
  setLaunchFeedback: (message: string) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  setLaunchDraft: (updater: HomeLaunchDraft | ((draft: HomeLaunchDraft) => HomeLaunchDraft)) => void;
  pickWorkspaceDirectory: () => Promise<string | null> | string | null;
  scheduleWorkspaceValidation: (targetPath: string) => void;
  cancelWorkspaceValidation: () => void;
  openSessionWindow: (sessionId: string) => Promise<void>;
  openCompanionReviewWindow: (sessionId: string) => Promise<void>;
  createSession: (input: CreateSessionRequest) => Promise<SessionSummary | null>;
  createCompanionSession: (input: CreateCompanionSessionInput) => Promise<CompanionSession | null>;
  upsertSessionSummary: (summary: SessionSummary) => void;
  upsertCompanionSessionSummary: (summary: CompanionSessionSummary) => void;
};

export type HomeLaunchHandlers = {
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onOpenLaunchDialog: () => Promise<void>;
  onCloseLaunchDialog: () => void;
  onSelectLaunchProvider: (providerId: string) => void;
  onSelectLaunchCharacter: (characterId: string) => void;
  onSelectRandomLaunchCharacter: () => void;
  onSelectSessionPurpose: (purpose: HomeLaunchSessionPurpose) => void;
  onChangeMode: (mode: HomeLaunchDraft["mode"]) => void;
  onChangeTitle: (value: string) => void;
  onChangeWorkspacePath: (value: string) => void;
  onStartSession: (mode?: HomeLaunchDraft["mode"]) => void;
};

export function buildHomeLaunchHandlers({
  launchDraft,
  launchStarting,
  mateState,
  mateProfile,
  enabledLaunchProviders,
  characterEntries,
  selectedLaunchProviderId,
  sessions,
  sessionCharacterUsage,
  openSessionWindowIds,
  openSessionWindowIdsLoadStatus,
  sessionCharacterUsageLoadStatus,
  refreshCharacterEntries,
  setCharactersLoaded,
  setLaunchFeedback,
  setLaunchStarting,
  setLaunchDraft,
  pickWorkspaceDirectory,
  scheduleWorkspaceValidation,
  cancelWorkspaceValidation,
  openSessionWindow,
  openCompanionReviewWindow,
  createSession,
  createCompanionSession,
  upsertSessionSummary,
  upsertCompanionSessionSummary,
}: HomeLaunchHandlersContext): HomeLaunchHandlers {
  const onBrowseWorkspace = async () => {
    const selectedPath = await pickWorkspaceDirectory();
    if (!selectedPath) {
      return;
    }

    setLaunchFeedback("");
    scheduleWorkspaceValidation(selectedPath);
  };

  const onOpenLaunchDialog = async () => {
    cancelWorkspaceValidation();
    setLaunchFeedback("");
    await refreshCharacterEntries().catch((error) => {
      setCharactersLoaded(false);
      setLaunchFeedback(error instanceof Error ? error.message : "Failed to reload Characters.");
    });
    setLaunchDraft((current) =>
      openLaunchDraft(
        current,
        enabledLaunchProviders[0]?.id ?? "",
        "session",
      ),
    );
  };

  const onCloseLaunchDialog = () => {
    cancelWorkspaceValidation();
    setLaunchFeedback("");
    setLaunchStarting(false);
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  const onSelectLaunchProvider = (providerId: string) => {
    setLaunchFeedback("");
    setLaunchDraft((current) => updateLaunchDraftForProviderSelection(current, providerId));
  };

  const onStartSession = async (requestedMode: HomeLaunchDraft["mode"] = launchDraft.mode) => {
    await startHomeLaunch({
      draft: launchDraft,
      requestedMode,
      launchStarting,
      mateState,
      mateProfile,
      selectedProviderId: selectedLaunchProviderId,
      characterEntries,
      sessions,
      sessionCharacterUsage,
      openSessionWindowIds,
      openSessionWindowIdsLoadStatus,
      sessionCharacterUsageLoadStatus,
      createSession,
      createCompanionSession,
      openSessionWindow,
      openCompanionReviewWindow,
      closeLaunchDialog: onCloseLaunchDialog,
      setLaunchFeedback,
      setLaunchStarting,
      upsertSessionSummary,
      upsertCompanionSessionSummary,
    });
  };

  return {
    onBrowseWorkspace: () => void onBrowseWorkspace(),
    onSelectSessionFolder: () => {
      cancelWorkspaceValidation();
      setLaunchFeedback("");
      setLaunchDraft((current) => setLaunchWorkspaceToSessionFolder(current));
    },
    onOpenLaunchDialog,
    onCloseLaunchDialog,
    onSelectLaunchProvider,
    onSelectLaunchCharacter: (characterId) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => updateLaunchDraftForCharacterSelection(current, characterId));
    },
    onSelectRandomLaunchCharacter: () => {
      setLaunchFeedback("");
      setLaunchDraft((current) => updateLaunchDraftForRandomCharacterSelection(current));
    },
    onSelectSessionPurpose: (purpose) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => updateLaunchDraftForSessionPurpose(current, purpose));
    },
    onChangeMode: (mode) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({
        ...current,
        mode,
        workspace: mode === "companion" && isSessionFolderLaunchWorkspace(current.workspace)
          ? null
          : current.workspace,
      }));
    },
    onChangeTitle: (value) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, title: value }));
    },
    onChangeWorkspacePath: (value) => {
      setLaunchFeedback("");
      scheduleWorkspaceValidation(value);
    },
    onStartSession: (mode) => void onStartSession(mode),
  };
}
