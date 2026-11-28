import type { SessionHistorySource } from "../session/session-history-read-scope.js";

/** Agent runtimeで要求元のMainまたはAuxiliaryを参照する識別子。履歴読み取り側の所有者情報は含めない。 */
export type AgentRuntimeSourceRef =
  | Omit<Extract<SessionHistorySource, { kind: "main" }>, "ownerIdentity">
  | Omit<Extract<SessionHistorySource, { kind: "auxiliary" }>, "ownerIdentity">;
