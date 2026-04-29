import type { CharacterProfile } from "./character-state.js";
import { DEFAULT_CHARACTER_SESSION_COPY } from "./character-state.js";
import type { CompanionSession } from "./companion-state.js";
import type { CompanionReviewSnapshot } from "./companion-review-state.js";

export type CompanionSessionWindowView = "chat" | "merge";

export function getCompanionWindowViewFromSearch(search: string): CompanionSessionWindowView {
  const query = new URLSearchParams(search);
  return query.get("view") === "merge" ? "merge" : "chat";
}

export function buildCompanionChatSnapshot(session: CompanionSession): CompanionReviewSnapshot {
  return {
    session,
    changedFiles: [],
    mergeRuns: [],
    mergeReadiness: {
      status: "ready",
      blockers: [],
      warnings: [],
      targetHead: "",
      baseParent: "",
      simulatedAt: "",
    },
    generatedAt: session.updatedAt,
    warnings: [],
  };
}

export function buildCompanionCharacterProfile(session: CompanionSession): CharacterProfile {
  return {
    id: session.characterId,
    name: session.character,
    iconPath: session.characterIconPath,
    description: "",
    roleMarkdown: session.characterRoleMarkdown,
    notesMarkdown: "",
    updatedAt: session.updatedAt,
    themeColors: session.characterThemeColors,
    sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
  };
}

export function formatCompanionPathReference(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  return /\s/.test(normalizedPath) ? `@"${normalizedPath}"` : `@${normalizedPath}`;
}
