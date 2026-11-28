import type { LiveSessionRunState, ProviderDiagnosticMetadata } from "../../../src-shared/session/runtime-state.js";
import type { ProviderAgentRuntimeBindingProjection } from "../agent-runtime-binding.js";
import type { RunSessionTurnProgressChanges } from "../provider-runtime.js";
import type { BoundedProviderRawItem } from "../../session/provider-payload-limits.js";
import type { CodexNativeNotification, CodexTurnItem } from "./codex-turn-events.js";

export const CODEX_LIVE_PROGRESS_INTERVAL_MS = 33;

export type CodexProjectionStart = {
  sessionId: string;
  threadId: string;
  turnId: string;
  binding?: ProviderAgentRuntimeBindingProjection | null;
  apiKey: string;
  progress: boolean;
  diagnosticTrace?: boolean;
};
export type CodexProjectionProgress = {
  /** ライブ状態のスカラー項目を伝える。コレクションの内容は changes でのみ伝える。 */
  state: LiveSessionRunState;
  changes: RunSessionTurnProgressChanges;
};
export type CodexProjectionEvent = {
  changed: boolean;
  errorMessage?: string;
  unhandledNotification?: { sessionId: string; threadId: string; turnId: string; method: string; params?: unknown };
};
export type CodexProjectionFinal = {
  output: import("../../../src-shared/session/provider-output.js").ProviderOutput;
  items: CodexTurnItem[];
  assistantText: string;
  assistantQuestionRanges?: LiveSessionRunState["assistantQuestionRanges"];
  lastNonEmptyAssistantMessageText: string;
  rawItemsJson?: string;
  providerMetadata: ProviderDiagnosticMetadata[];
  usage: LiveSessionRunState["usage"];
  terminalStatus: string | null;
  errorMessage: string;
};
export type CodexProjectionCommand =
  | { type: "start"; input: CodexProjectionStart }
  | { type: "event"; event: CodexNativeNotification }
  | { type: "events"; events: CodexNativeNotification[] }
  | { type: "live"; inputAvailable: boolean; force?: boolean }
  | { type: "question-position" }
  | { type: "finish"; diagnostics: BoundedProviderRawItem[] }
  | { type: "release" };
export type CodexProjectionRequest = { id: number; runId: string; command: CodexProjectionCommand };
export type CodexProjectionResponse = { id: number; value?: unknown; error?: string };
