import type { CompanionSessionSummary } from "../companion-state.js";
import type { CreateSessionInput, SessionSummary } from "../session-state.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { CreateCompanionSessionInput, CompanionSession } from "../companion-state.js";
import type { ModelCatalogProvider } from "../model-catalog.js";
import type { HomeLaunchDraft } from "./home-launch-state.js";
import {
  closeLaunchDraft,
  openLaunchDraft,
  setLaunchWorkspaceFromPath,
  updateLaunchDraftForProviderSelection,
} from "./home-launch-state.js";
import { startHomeLaunch } from "./home-launch-actions.js";

type HomeLaunchHandlersContext = {
  launchDraft: HomeLaunchDraft;
  launchStarting: boolean;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  enabledLaunchProviders: readonly ModelCatalogProvider[];
  selectedLaunchProviderId: string | null;
  sessions: readonly SessionSummary[];
  setLaunchFeedback: (message: string) => void;
  setLaunchStarting: (launchStarting: boolean) => void;
  setLaunchDraft: (updater: HomeLaunchDraft | ((draft: HomeLaunchDraft) => HomeLaunchDraft)) => void;
  pickWorkspaceDirectory: () => Promise<string | null> | string | null;
  openSessionWindow: (sessionId: string) => Promise<void>;
  openCompanionReviewWindow: (sessionId: string) => Promise<void>;
  createSession: (input: CreateSessionInput) => Promise<SessionSummary | null>;
  createCompanionSession: (input: CreateCompanionSessionInput) => Promise<CompanionSession | null>;
  upsertSessionSummary: (summary: SessionSummary) => void;
  upsertCompanionSessionSummary: (summary: CompanionSessionSummary) => void;
};

export type HomeLaunchHandlers = {
  onBrowseWorkspace: () => void;
  onOpenLaunchDialog: () => void;
  onCloseLaunchDialog: () => void;
  onSelectLaunchProvider: (providerId: string) => void;
  onChangeMode: (mode: HomeLaunchDraft["mode"]) => void;
  onChangeTitle: (value: string) => void;
  onStartSession: (mode?: HomeLaunchDraft["mode"]) => void;
};

export function buildHomeLaunchHandlers({
  launchDraft,
  launchStarting,
  mateState,
  mateProfile,
  enabledLaunchProviders,
  selectedLaunchProviderId,
  sessions,
  setLaunchFeedback,
  setLaunchStarting,
  setLaunchDraft,
  pickWorkspaceDirectory,
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
    setLaunchDraft((current) => setLaunchWorkspaceFromPath(current, selectedPath));
  };

  const onOpenLaunchDialog = () => {
    if (mateState === "not_created") {
      setLaunchFeedback("Mate を作成してから開始してね。");
      return;
    }

    setLaunchFeedback("");
    setLaunchDraft((current) => openLaunchDraft(current, enabledLaunchProviders[0]?.id ?? ""));
  };

  const onCloseLaunchDialog = () => {
    setLaunchFeedback("");
    setLaunchStarting(false);
    setLaunchDraft((current) => closeLaunchDraft(current));
  };

  const onSelectLaunchProvider = (providerId: string) => {
    setLaunchFeedback("");
    setLaunchDraft((current) => updateLaunchDraftForProviderSelection(current, providerId, enabledLaunchProviders));
  };

  const onStartSession = async (requestedMode: HomeLaunchDraft["mode"] = launchDraft.mode) => {
    await startHomeLaunch({
      draft: launchDraft,
      requestedMode,
      launchStarting,
      mateState,
      mateProfile,
      selectedProviderId: selectedLaunchProviderId,
      sessions,
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
    onOpenLaunchDialog,
    onCloseLaunchDialog,
    onSelectLaunchProvider,
    onChangeMode: (mode) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, mode }));
    },
    onChangeTitle: (value) => {
      setLaunchFeedback("");
      setLaunchDraft((current) => ({ ...current, title: value }));
    },
    onStartSession: (mode) => void onStartSession(mode),
  };
}
