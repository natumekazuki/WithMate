export type CrewDeletionBlocker = {
  kind: "running" | "queue" | "creation" | "coordination";
  id: string;
  sessionId?: string;
  message: string;
};
export type CrewDeletionStatus = { allowed: boolean; blockers: CrewDeletionBlocker[] };
