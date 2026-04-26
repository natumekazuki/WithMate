import type { ChangedFile } from "./runtime-state.js";
import type { CompanionSession } from "./companion-state.js";

export type CompanionReviewSnapshot = {
  session: CompanionSession;
  changedFiles: ChangedFile[];
  generatedAt: string;
  warnings: string[];
};

export type CompanionMergeSelectedFilesRequest = {
  sessionId: string;
  selectedPaths: string[];
};

function getLocationSearch(): string {
  const browserWindow = (globalThis as typeof globalThis & { window?: { location?: { search?: string } } }).window;
  return browserWindow?.location?.search ?? "";
}

export function getCompanionSessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("companionSessionId");
}
