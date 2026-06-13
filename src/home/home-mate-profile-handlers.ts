import type { CompanionSessionSummary } from "../companion-state.js";
import type { MateProfile, MateStorageState } from "../mate/mate-state.js";
import type { SessionSummary } from "../session-state.js";
import type { WithMateWindowApi } from "../withmate-window-api.js";
import {
  clearHomeMateAvatar,
  saveHomeMateProfile,
  selectHomeMateAvatar,
} from "./home-mate-profile-actions.js";

type HomeMateProfileHandlersContext = {
  getApi: () => WithMateWindowApi | null;
  mateDisplayName: string;
  mateState: MateStorageState | null;
  mateProfile: MateProfile | null;
  setMateState: (state: MateStorageState) => void;
  setMateProfile: (profile: MateProfile | null) => void;
  setMateDisplayName: (displayName: string) => void;
  setMateCreationFeedback: (message: string) => void;
  setMateProfileEditorOpen: (open: boolean) => void;
  setMateCreating: (creating: boolean) => void;
  setMateAvatarUpdating: (updating: boolean) => void;
  setLaunchFeedback: (message: string) => void;
  setSessions: (sessions: SessionSummary[]) => void;
  setCompanionSessions: (sessions: CompanionSessionSummary[]) => void;
};

export type HomeMateProfileHandlers = {
  onChangeDisplayName: (value: string) => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
  onSelectAvatar: () => void;
  onClearAvatar: () => void;
  onOpenProfileEditor: () => void;
};

export function buildHomeMateProfileHandlers({
  getApi,
  mateDisplayName,
  mateState,
  mateProfile,
  setMateState,
  setMateProfile,
  setMateDisplayName,
  setMateCreationFeedback,
  setMateProfileEditorOpen,
  setMateCreating,
  setMateAvatarUpdating,
  setLaunchFeedback,
  setSessions,
  setCompanionSessions,
}: HomeMateProfileHandlersContext): HomeMateProfileHandlers {
  const refreshSessionSummaries = async (api: WithMateWindowApi) => {
    const [nextSessions, nextCompanionSessions] = await Promise.all([
      api.listSessionSummaries(),
      api.listCompanionSessionSummaries(),
    ]);
    setSessions(nextSessions);
    setCompanionSessions(nextCompanionSessions);
  };

  return {
    onChangeDisplayName: (value) => {
      setMateDisplayName(value);
      setMateCreationFeedback("");
    },
    onSubmit: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void saveHomeMateProfile({
        api,
        displayName: mateDisplayName,
        mateState,
        setMateState,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateProfileEditorOpen,
        setMateCreating,
        setLaunchFeedback,
        hydrateHomeData: async () => {
          const [nextSessions, nextCompanionSessions] = await Promise.all([
            api.listSessionSummaries(),
            api.listCompanionSessionSummaries(),
          ]);
          setSessions(nextSessions);
          setCompanionSessions(nextCompanionSessions);
        },
      });
    },
    onCancelEdit: () => setMateProfileEditorOpen(false),
    onSelectAvatar: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void selectHomeMateAvatar({
        api,
        mateState,
        currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateAvatarUpdating,
        setLaunchFeedback,
        refreshSessionSummaries: async () => {
          await refreshSessionSummaries(api);
        },
      });
    },
    onClearAvatar: () => {
      const api = getApi();
      if (!api) {
        setMateCreationFeedback("Mate API が利用できないよ。");
        return;
      }

      void clearHomeMateAvatar({
        api,
        mateState,
        currentAvatarFilePath: mateProfile?.avatarFilePath ?? null,
        setMateProfile,
        setMateDisplayName,
        setMateCreationFeedback,
        setMateAvatarUpdating,
        setLaunchFeedback,
        refreshSessionSummaries: async () => {
          await refreshSessionSummaries(api);
        },
      });
    },
    onOpenProfileEditor: () => {
      setMateDisplayName(mateProfile?.displayName ?? "");
      setMateCreationFeedback("");
      setMateProfileEditorOpen(true);
    },
  };
}
