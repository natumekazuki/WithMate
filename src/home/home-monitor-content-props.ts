import type { HomeMonitorContentProps } from "./HomeMonitorContent.js";
import type { HomeMonitorEntry } from "./home-session-projection.js";

export type HomeMonitorContentInput = {
  runningEntries: HomeMonitorEntry[];
  nonRunningEntries: HomeMonitorEntry[];
  onOpenSession: (sessionId: string) => void;
  onOpenCompanionReview: (sessionId: string) => void;
};

export function buildHomeMonitorContentProps({
  runningEntries,
  nonRunningEntries,
  onOpenSession,
  onOpenCompanionReview,
}: HomeMonitorContentInput): HomeMonitorContentProps {
  return {
    runningEntries,
    nonRunningEntries,
    onOpenSession,
    onOpenCompanionReview,
  };
}
