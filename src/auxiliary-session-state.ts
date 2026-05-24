import type { ApprovalMode } from "./approval-mode.js";
import { normalizeCodexSandboxMode, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { ModelReasoningEffort } from "./model-catalog.js";
import { normalizeMessage, type Message } from "./session-state.js";

export type AuxiliarySessionStatus = "active" | "closed";

export type AuxiliarySession = {
  id: string;
  parentSessionId: string;
  status: AuxiliarySessionStatus;
  runState: "idle" | "running" | "error";
  title: string;
  provider: string;
  catalogRevision: number;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  composerDraft: string;
  messages: Message[];
  displayAfterMessageIndex: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
};

export type AuxiliarySessionSummary = Omit<AuxiliarySession, "messages" | "composerDraft">;

export function normalizeAuxiliarySession(value: unknown): AuxiliarySession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AuxiliarySession>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }
  if (typeof candidate.parentSessionId !== "string" || !candidate.parentSessionId.trim()) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    parentSessionId: candidate.parentSessionId.trim(),
    status: candidate.status === "closed" ? "closed" : "active",
    runState:
      candidate.runState === "running" || candidate.runState === "error"
        ? candidate.runState
        : "idle",
    title: typeof candidate.title === "string" ? candidate.title : "",
    provider: typeof candidate.provider === "string" ? candidate.provider : "codex",
    catalogRevision: typeof candidate.catalogRevision === "number" ? candidate.catalogRevision : 1,
    model: typeof candidate.model === "string" ? candidate.model : "",
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : "medium",
    approvalMode:
      candidate.approvalMode === "never" ||
      candidate.approvalMode === "on-request" ||
      candidate.approvalMode === "on-failure"
      || candidate.approvalMode === "untrusted"
        ? candidate.approvalMode
        : "untrusted",
    codexSandboxMode: normalizeCodexSandboxMode(candidate.codexSandboxMode),
    customAgentName: typeof candidate.customAgentName === "string" ? candidate.customAgentName : "",
    allowedAdditionalDirectories: Array.isArray(candidate.allowedAdditionalDirectories)
      ? candidate.allowedAdditionalDirectories.filter((entry): entry is string => typeof entry === "string")
      : [],
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    composerDraft: typeof candidate.composerDraft === "string" ? candidate.composerDraft : "",
    messages: Array.isArray(candidate.messages)
      ? candidate.messages
          .map((message) => normalizeMessage(message))
          .filter((message): message is Message => message !== null)
      : [],
    displayAfterMessageIndex:
      typeof candidate.displayAfterMessageIndex === "number" && Number.isInteger(candidate.displayAfterMessageIndex)
        ? candidate.displayAfterMessageIndex
        : null,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    closedAt: typeof candidate.closedAt === "string" ? candidate.closedAt : "",
  };
}

export function projectAuxiliarySessionSummary(session: AuxiliarySession): AuxiliarySessionSummary {
  const { messages: _messages, composerDraft: _composerDraft, ...summary } = session;
  return summary;
}
