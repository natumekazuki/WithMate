import type { SessionHistorySource } from "../session/session-history-read-scope.js";

export type AgentRuntimeSourceRef = Omit<Extract<SessionHistorySource, { kind: "main" }>, "ownerIdentity">
  | Omit<Extract<SessionHistorySource, { kind: "auxiliary" }>, "ownerIdentity">;
