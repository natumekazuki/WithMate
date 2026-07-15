import { useMemo } from "react";

import type { CharacterProfile } from "./character-state.js";
import type { CompanionSession } from "./companion-state.js";
import { buildCompanionCharacterProfile } from "./companion-session-mode-adapter.js";

export function useCompanionCharacterProfile(session: CompanionSession | null): CharacterProfile | null {
  return useMemo(
    () => session ? buildCompanionCharacterProfile(session) : null,
    [
      session?.character,
      session?.characterIconPath,
      session?.characterId,
      session?.characterRoleMarkdown,
      session?.characterThemeColors.main,
      session?.characterThemeColors.sub,
      session?.updatedAt,
    ],
  );
}
