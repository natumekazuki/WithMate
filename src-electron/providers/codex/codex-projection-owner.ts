import { createProviderAgentRuntimeBindingRedactor, type ProviderAgentRuntimeBindingRedactor } from "../provider-agent-runtime-binding.js";
import { stringifyBoundedAuditRawItems } from "../../session/audit-payload-limits.js";
import { buildCodexStableRawItems, buildCodexProviderMetadata, toAuditOperations } from "./codex-event-projection.js";
import { applyCodexTurnEvent, collectCodexAssistantResponseFromItems, createCodexTurnStreamState, getLiveCodexAssistantPreview, getLiveCodexReasoningPreview, type CodexNativeNotification } from "./codex-turn-events.js";
import type { CodexProjectionStart, CodexProjectionProgress, CodexProjectionFinal, CodexProjectionEvent } from "./codex-projection-protocol.js";
import type { BoundedAuditRawItem } from "../../session/audit-payload-limits.js";

/** Owns native items and sanitized projections inside the shared projection Worker. */
export class CodexProjectionOwner {
  private readonly state;
  private readonly redactor: ProviderAgentRuntimeBindingRedactor;
  private liveRevision = -1;
  private assistantSource = "";
  private assistantText = "";
  private reasoningSource = "";
  private reasoningText = "";
  private auditAssistantText = "";
  private auditErrorMessage = "";
  private auditUsage: CodexProjectionProgress["state"]["usage"] = null;

  constructor(private readonly input: CodexProjectionStart) {
    this.state = createCodexTurnStreamState(input.threadId);
    this.state.turnId = input.turnId;
    this.redactor = createProviderAgentRuntimeBindingRedactor(input.binding, [input.apiKey]);
  }

  private assistantPreview(): string {
    const assistant = getLiveCodexAssistantPreview(this.state);
    if (assistant !== this.assistantSource) {
      this.assistantSource = assistant;
      this.assistantText = this.redactor.sanitizeText(assistant);
    }
    return this.assistantText;
  }

  private frame(steps: CodexProjectionProgress["state"]["steps"]): CodexProjectionProgress["state"] {
    const assistantText = this.assistantPreview();
    const reasoning = getLiveCodexReasoningPreview(this.state);
    if (reasoning !== this.reasoningSource) {
      this.reasoningSource = reasoning;
      this.reasoningText = this.redactor.sanitizeText(reasoning);
    }
    return {
      sessionId: this.input.sessionId, threadId: this.input.threadId, turnId: this.input.turnId,
      assistantText, reasoningText: this.reasoningText, steps,
      backgroundTasks: [], usage: this.state.usage,
      errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
      approvalRequest: null, elicitationRequest: null,
    };
  }

  apply(event: CodexNativeNotification): CodexProjectionEvent | null {
    const revision = this.state.revision;
    applyCodexTurnEvent(this.state, event);
    if (!this.input.progress || revision === this.state.revision) return null;
    const steps = this.state.liveSteps.takeProgress(this.redactor, false);
    const assistantText = this.assistantPreview();
    const errorMessage = this.redactor.sanitizeText(this.state.streamErrorMessage);
    const assistantChanged = assistantText !== this.auditAssistantText;
    const errorChanged = errorMessage !== this.auditErrorMessage;
    const usageChanged = this.state.usage !== this.auditUsage;
    this.auditAssistantText = assistantText;
    this.auditErrorMessage = errorMessage;
    this.auditUsage = this.state.usage;
    if (!assistantChanged && !errorChanged && !usageChanged && !steps.changes.upserts.length && !steps.changes.removes.length)
      return { audit: null };
    return {
      audit: {
        state: {
          sessionId: this.input.sessionId, threadId: this.input.threadId, turnId: this.input.turnId,
          assistantText: assistantChanged ? assistantText : "", reasoningText: "", steps: steps.changes.upserts,
          backgroundTasks: [], usage: usageChanged ? this.state.usage : null,
          errorMessage: errorChanged ? errorMessage : "", approvalRequest: null, elicitationRequest: null,
        },
        changes: { delivery: "audit", steps: steps.changes, backgroundTasks: { upserts: [], removes: [] } },
      },
    };
  }

  live(inputAvailable: boolean, force = false): CodexProjectionProgress | null {
    if (!this.input.progress || !force && this.liveRevision === this.state.revision) return null;
    this.liveRevision = this.state.revision;
    const steps = this.state.liveSteps.takeProgress(this.redactor);
    return {
      state: { ...this.frame(steps.snapshot), inputAvailable },
      changes: { delivery: "live", steps: { upserts: [], removes: [] }, backgroundTasks: { upserts: [], removes: [] } },
    };
  }

  finish(diagnostics: BoundedAuditRawItem[]): CodexProjectionFinal {
    const items = this.redactor.sanitize([...this.state.items.values()]);
    const response = collectCodexAssistantResponseFromItems(items);
    return {
      items, ...response, operations: toAuditOperations(items),
      rawItemsJson: stringifyBoundedAuditRawItems([...this.redactor.sanitize(diagnostics), ...buildCodexStableRawItems(items)]),
      providerMetadata: buildCodexProviderMetadata(items), usage: this.state.usage,
      terminalStatus: this.state.terminalStatus, errorMessage: this.redactor.sanitizeText(this.state.streamErrorMessage),
    };
  }

  sanitizeError(error: unknown): string {
    return this.redactor.sanitizeText(error instanceof Error ? error.message : String(error));
  }
}
