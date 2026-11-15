import type { SessionEvent } from "@github/copilot-sdk";
import { projectProviderOutput, type ProviderOutputTextUnit } from "../../../src-shared/session/provider-output.js";

/** Native identity, not text equality, determines updates. Phases are deliberately not Codex phases. */
export class CopilotOutputProjection {
  private readonly units = new Map<string, ProviderOutputTextUnit>();
  private readonly seen = new Set<string>();
  private readonly correspondence = new Map<string, { originatingMessageId?: string; turnId?: string; toolRequests: boolean }>();
  get lastNonEmptyText(): string { return [...this.units.values()].reverse().find((unit) => unit.text.trim())?.text ?? ""; }
  apply(event: SessionEvent): void {
    if (event.agentId || this.seen.has(event.id)) return;
    if (event.type !== "assistant.message_start" && event.type !== "assistant.message_delta" && event.type !== "assistant.message") return;
    if ("parentToolCallId" in event.data && event.data.parentToolCallId) return;
    this.seen.add(event.id);
    const id = event.data.messageId;
    const previous = this.units.get(id);
    if (event.type === "assistant.message") this.correspondence.set(id, { originatingMessageId: event.data.originatingMessageId, turnId: event.data.turnId, toolRequests: Boolean(event.data.toolRequests?.length) });
    this.units.set(id, {
      id, messageId: id, text: event.type === "assistant.message" ? event.data.content : event.type === "assistant.message_delta" ? (previous?.text ?? "") + event.data.deltaContent : previous?.text ?? "",
      phase: "phase" in event.data ? event.data.phase ?? previous?.phase ?? null : previous?.phase ?? null,
      role: "unclassified", completion: event.type === "assistant.message" ? "complete" : "partial", final: false, evidence: null,
    });
  }
  completeRequest(requestMessageId: string): void {
    const matching = [...this.correspondence].filter(([, value]) => value.originatingMessageId === requestMessageId);
    const terminal = matching.at(-1)?.[1];
    if (!terminal?.turnId || terminal.toolRequests) return;
    for (const [id, native] of matching) {
      const unit = this.units.get(id)!;
      if (native.turnId === terminal.turnId && !native.toolRequests && unit.completion === "complete" && unit.text) {
        unit.final = true; unit.role = "answer"; unit.evidence = "copilot.request-completion:originating-message/native-turn";
      }
    }
  }
  project(sanitize: (text: string) => string = (text) => text) {
    const units = [...this.units.values()].filter((unit) => unit.text.length > 0);
    return projectProviderOutput(units, units.some((unit) => unit.final) ? "identified" : units.length ? "unknown" : "none", sanitize);
  }
}
