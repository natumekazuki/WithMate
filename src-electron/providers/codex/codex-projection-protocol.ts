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
  /** Scalar live frame; collection content is delivered only through changes. */
  state: LiveSessionRunState;
  changes: RunSessionTurnProgressChanges;
};
export type CodexProjectionEvent = { changed: boolean; errorMessage?: string };
export type CodexProjectionFinal = {
  items: CodexTurnItem[];
  assistantText: string;
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
  | { type: "finish"; diagnostics: BoundedProviderRawItem[] }
  | { type: "release" };
export type CodexProjectionRequest = { id: number; runId: string; command: CodexProjectionCommand };
export type CodexProjectionResponse = { id: number; value?: unknown; error?: string };
