import type { OpenCodeEvent, SessionMessageInfo, TokenUsageInfo } from "@opencode/client";
import type { LiveRunStep, ProviderUsage } from "../../../src-shared/session/runtime-state.js";

export function projectOpenCodeUsage(tokens: TokenUsageInfo): ProviderUsage {
  return { inputTokens: tokens.input + tokens.cache.read + tokens.cache.write, cachedInputTokens: tokens.cache.read, outputTokens: tokens.output + tokens.reasoning,
    reasoningOutputTokens: tokens.reasoning, totalTokens: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write };
}

/** Text ordinals are provisional until native full-text or message snapshots replace them. */
export class OpenCodeTurnProjection {
  private readonly text = new Map<string, string>();
  private readonly reasoning = new Map<string, string>();
  private readonly usage = new Map<string, TokenUsageInfo>();
  readonly steps = new Map<string, LiveRunStep>();
  private readonly seen = new Set<string>();
  constructor(readonly rootID: string) {}

  get assistantText(): string { return [...this.text.values()].join("\n\n"); }
  get reasoningText(): string { return [...this.reasoning.values()].join("\n\n"); }
  get tokenUsage(): ProviderUsage | null {
    if (!this.usage.size) return null;
    return [...this.usage.values()].map(projectOpenCodeUsage).reduce((a, b) => ({ inputTokens: a.inputTokens + b.inputTokens,
      cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens, outputTokens: a.outputTokens + b.outputTokens,
      reasoningOutputTokens: (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0), totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0) }));
  }

  apply(event: OpenCodeEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (!("sessionID" in event.data)) return;
    const data = event.data;
    if ((event.type === "session.text.delta" || event.type === "session.text.ended" || event.type === "session.reasoning.delta" || event.type === "session.reasoning.ended") && data.sessionID === this.rootID) {
      const key = `${event.data.assistantMessageID}:${event.data.ordinal}`;
      const target = event.type.startsWith("session.reasoning") ? this.reasoning : this.text;
      target.set(key, "delta" in event.data ? (target.get(key) ?? "") + event.data.delta : event.data.text);
    }
    if (event.type === "session.step.ended") this.usage.set(`${data.sessionID}:${event.data.assistantMessageID}`, event.data.tokens);
    if (event.type === "session.tool.input.started") {
      const key = `${data.sessionID}:${event.data.assistantMessageID}:${event.data.id}`;
      this.steps.set(key, { id: key, type: "tool_call", status: "in_progress", summary: event.data.name });
    }
    if (event.type === "session.tool.called" || event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const key = `${data.sessionID}:${event.data.assistantMessageID}:${event.data.id}`;
      const previous = this.steps.get(key);
      const command = event.type === "session.tool.called" && typeof event.data.input.command === "string" ? event.data.input.command : undefined;
      this.steps.set(key, { id: key, type: command ? "command_execution" : previous?.type ?? "tool_call",
        summary: command ?? previous?.summary ?? event.data.id,
        status: event.type === "session.tool.success" ? "completed" : event.type === "session.tool.failed" ? "failed" : "in_progress",
        ...(event.type === "session.tool.failed" ? { error: { message: JSON.stringify(event.data.error) } } : {}),
        details: event.type === "session.tool.called" ? JSON.stringify(event.data.input) : JSON.stringify(event.data.content), });
    }
  }

  replaceMessages(messages: SessionMessageInfo[]): void {
    this.text.clear(); this.reasoning.clear();
    for (const message of messages) {
      if (message.type !== "assistant") continue;
      message.content.forEach((part, ordinal) => {
        const key = `${message.id}:${ordinal}`;
        if (part.type === "text") this.text.set(key, part.text);
        else if (part.type === "reasoning") this.reasoning.set(key, part.text);
        else {
          const toolKey = `${this.rootID}:${message.id}:${part.id}`;
          const command = "input" in part.state && typeof part.state.input === "object" && typeof part.state.input.command === "string" ? part.state.input.command : undefined;
          this.steps.set(toolKey, { id: toolKey, type: command ? "command_execution" : "tool_call", summary: command ?? part.name,
            status: part.state.status === "error" ? "failed" : part.state.status === "completed" ? "completed" : "in_progress",
            details: JSON.stringify(part.state), ...(part.state.status === "error" ? { error: { message: JSON.stringify(part.state.error) } } : {}) });
        }
      });
      if (message.tokens) this.usage.set(`${this.rootID}:${message.id}`, message.tokens);
    }
  }
}
