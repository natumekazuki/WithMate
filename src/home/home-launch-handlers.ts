import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { CreateSessionRequest, HomeSessionSummary, Session, SessionCharacterUsage, SessionSummary } from "../../src-shared/session/session-state.js";
import type { MateProfile, MateStorageState } from "../../src-shared/mate/mate-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { SessionSummariesLoadStatus } from "../chat/runtime/session-summary-subscription.js";
import type { OpenSessionWindowIdsLoadStatus } from "../app/open-session-window-subscription.js";
import type { HomeLaunchCharacterCatalog, HomeLaunchDraft } from "./home-launch-state.js";
import {
  closeLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceToSessionFolder,
  updateLaunchDraftForCharacterSelection,
  updateLaunchDraftForProviderSelection,
  updateLaunchDraftForRandomCharacterSelection,
} from "./home-launch-state.js";
import { startHomeLaunch, type HomeLaunchFeedbackSource, type HomeLaunchResult } from "./home-launch-actions.js";

export type HomeLaunchLifetime = { starting: boolean };

type HomeLaunchHandlersContext = {
  launchDraft: HomeLaunchDraft;
  launchStarting: boolean;
  launchLifetimeRef: { current: HomeLaunchLifetime };
  onDetachedResult: (result: HomeLaunchResult) => void;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  enabledLaunchProviders: readonly ModelCatalogProvider[];
  characterEntries: readonly CharacterCatalogEntry[];
  selectedLaunchProviderId: string | null;
  sessions: readonly HomeSessionSummary[];
  sessionCharacterUsage: readonly SessionCharacterUsage[];
  openSessionWindowIds: readonly string[];
  openSessionWindowIdsLoadStatus: OpenSessionWindowIdsLoadStatus;
  sessionCharacterUsageLoadStatus: SessionSummariesLoadStatus;
  refreshCharacterEntries: () => Promise<readonly CharacterCatalogEntry[]>;
  setLaunchCharacterCatalog: (catalog: HomeLaunchCharacterCatalog) => void;
  setLaunchFeedback: (message: string, source?: HomeLaunchFeedbackSource) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  setLaunchDraft: (updater: HomeLaunchDraft | ((draft: HomeLaunchDraft) => HomeLaunchDraft)) => void;
  pickWorkspaceDirectory: () => Promise<string | null> | string | null;
  scheduleWorkspaceValidation: (targetPath: string) => void;
  cancelWorkspaceValidation: () => void;
  openSessionWindow: (sessionId: string) => Promise<void>;
  createSession: (input: CreateSessionRequest) => Promise<Session | SessionSummary | null>;
  upsertSessionSummary: (summary: HomeSessionSummary) => void;
};

export type HomeLaunchHandlers = {
  onBrowseWorkspace: () => void;
  onSelectSessionFolder: () => void;
  onOpenLaunchDialog: () => Promise<void>;
  onCloseLaunchDialog: () => void;
  onSelectLaunchProvider: (providerId: string) => void;
  onSelectLaunchCharacter: (characterId: string) => void;
  onSelectRandomLaunchCharacter: () => void;
  onChangeTitle: (value: string) => void;
  onChangeWorkspacePath: (value: string) => void;
  onStartSession: () => void;
};

export function buildHomeLaunchHandlers({
  launchDraft,
  launchStarting,
  launchLifetimeRef,
  onDetachedResult,
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
  setLaunchCharacterCatalog,
  setLaunchFeedback,
  setLaunchStarting,
  setLaunchDraft,
  pickWorkspaceDirectory,
  scheduleWorkspaceValidation,
  cancelWorkspaceValidation,
  openSessionWindow,
  createSession,
  upsertSessionSummary,
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
    const lifetime: HomeLaunchLifetime = { starting: false };
    launchLifetimeRef.current = lifetime;
    cancelWorkspaceValidation();
    setLaunchStarting(false);
    setLaunchFeedback("");
    setLaunchCharacterCatalog({ entries: [], status: "loading" });
    try {
      const entries = await refreshCharacterEntries();
      if (launchLifetimeRef.current !== lifetime) {
        return;
      }
      setLaunchCharacterCatalog({ entries, status: "loaded" });
    } catch (error) {
      if (launchLifetimeRef.current !== lifetime) {
        return;
      }
      setLaunchCharacterCatalog({ entries: [], status: "error" });
      setLaunchFeedback(error instanceof Error ? error.message : "Could not refresh characters.");
    }
    setLaunchDraft((current) =>
      openLaunchDraft(
        current,
        enabledLaunchProviders[0]?.id ?? "",
      ),
    );
  };

  const onCloseLaunchDialog = () => {
    launchLifetimeRef.current = { starting: false };
    cancelWorkspaceValidation();
    setLaunchFeedback("");
    setLaunchStarting(false);
    setLaunchCharacterCatalog({ entries: [], status: "loading" });
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  const onSelectLaunchProvider = (providerId: string) => {
    setLaunchFeedback("");
    setLaunchDraft((current) => updateLaunchDraftForProviderSelection(current, providerId));
  };

  const onStartSession = async () => {
    const lifetime = launchLifetimeRef.current;
    if (!launchDraft.open || launchStarting || lifetime.starting) {
      return;
    }
    lifetime.starting = true;
    try {
      await startHomeLaunch({
        draft: launchDraft,
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
        openSessionWindow,
        closeLaunchDialog: onCloseLaunchDialog,
        setLaunchFeedback,
        setLaunchStarting,
        upsertSessionSummary,
        isCurrentAttempt: () => launchLifetimeRef.current === lifetime,
        onDetachedResult,
      });
    } finally {
      lifetime.starting = false;
    }
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
    onChangeTitle: (value) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, title: value }));
    },
    onChangeWorkspacePath: (value) => {
      setLaunchFeedback("");
      scheduleWorkspaceValidation(value);
    },
    onStartSession: () => void onStartSession(),
  };
}
