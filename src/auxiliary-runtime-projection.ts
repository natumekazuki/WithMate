import type { ApprovalMode } from "./approval-mode.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "./model-catalog.js";
import type { Message } from "./session-state.js";
import type { CompanionSession } from "./companion-state.js";
import type { Session } from "./session-state.js";
import type { AuxiliarySession } from "./auxiliary-session-state.js";

type AuxiliaryRuntimeProjectionMode = "main" | "companion";

type AuxiliaryRuntimeSessionProjectionCommon = {
  provider: string;
  catalogRevision: number;
  runState: AuxiliarySession["runState"];
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  messages: Message[];
};

function buildAuxiliaryRuntimeSessionProjectionCommon(
  auxiliary: AuxiliarySession,
  options: { cloneAdditionalDirectories: boolean },
): AuxiliaryRuntimeSessionProjectionCommon {
  return {
    provider: auxiliary.provider,
    catalogRevision: auxiliary.catalogRevision,
    runState: auxiliary.runState,
    approvalMode: auxiliary.approvalMode,
    codexSandboxMode: auxiliary.codexSandboxMode,
    model: auxiliary.model,
    reasoningEffort: auxiliary.reasoningEffort,
    customAgentName: auxiliary.customAgentName,
    allowedAdditionalDirectories: options.cloneAdditionalDirectories
      ? [...auxiliary.allowedAdditionalDirectories]
      : auxiliary.allowedAdditionalDirectories,
    threadId: auxiliary.threadId,
    messages: auxiliary.messages,
  };
}

export function buildAuxiliaryRuntimeSessionProjection(
  mode: "main",
  parent: Session,
  auxiliary: AuxiliarySession,
): Session;
export function buildAuxiliaryRuntimeSessionProjection(
  mode: "companion",
  parent: CompanionSession,
  auxiliary: AuxiliarySession,
): CompanionSession;
export function buildAuxiliaryRuntimeSessionProjection(
  mode: AuxiliaryRuntimeProjectionMode,
  parent: Session | CompanionSession,
  auxiliary: AuxiliarySession,
): Session | CompanionSession {
  const baseProjection = buildAuxiliaryRuntimeSessionProjectionCommon(
    auxiliary,
    { cloneAdditionalDirectories: mode === "companion" },
  );

  if (mode === "main") {
    const sessionParent = parent as Session;
    const projection: Session = {
      ...sessionParent,
      id: auxiliary.id,
      taskTitle: sessionParent.taskTitle,
      status: auxiliary.runState === "running" ? "running" : "idle",
      updatedAt: auxiliary.updatedAt,
      ...baseProjection,
      stream: [],
    };
    return projection;
  }

  const companionParent = parent as CompanionSession;
  const projection: CompanionSession = {
    ...companionParent,
    id: auxiliary.id,
    taskTitle: auxiliary.title,
    status: "active",
    ...baseProjection,
    updatedAt: auxiliary.updatedAt,
  };
  return projection;
}
