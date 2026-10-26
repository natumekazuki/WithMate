import path from "node:path";
import { getProviderAppSettings } from "../../../src-shared/settings/provider-settings-state.js";
import { parseSessionMemoryDeltaText } from "../../session/session-memory-extraction.js";
import { createProviderAgentRuntimeBindingRedactor, mergeDefinedProviderEnv } from "../provider-agent-runtime-binding.js";
import {
  VALIDATED_JSON_BACKGROUND_STRUCTURED_PROMPT_POLICY,
  type ProviderBackgroundAdapter,
  type ExtractSessionMemoryInput,
  type ExtractSessionMemoryResult,
  type RunBackgroundStructuredPromptInput,
  type RunBackgroundStructuredPromptResult,
} from "../provider-runtime.js";
import { validateStructuredPromptSchemaValue } from "../structured-prompt-validation.js";
import { resolveOpenCodeBinaryPath } from "./opencode-adapter.js";
import { resolveOpenCodeModelRef, validateOpenCodeModel } from "./opencode-model.js";
import { OpenCodeTransport, type OpenCodeTransportOptions } from "./opencode-transport.js";

type Transport = Pick<OpenCodeTransport, "start" | "close" | "whenClosed"> & { readonly secrets?: readonly string[] };
export type OpenCodeBackgroundOptions = {
  databasePath: string;
  executable?: string;
  createTransport?: (options: OpenCodeTransportOptions) => Transport;
  log?: (input: { level: "warn"; kind: string; message: string }) => void;
};

export class OpenCodeBackgroundAdapter implements ProviderBackgroundAdapter {
  private readonly active = new Map<Transport, { controller: AbortController; workspacePath: string; cleanupPending: boolean }>();
  constructor(private readonly options: OpenCodeBackgroundOptions) {}

  getBackgroundStructuredPromptPolicy() { return VALIDATED_JSON_BACKGROUND_STRUCTURED_PROMPT_POLICY; }

  async dispose(): Promise<void> {
    const runtimes = [...this.active.entries()];
    for (const [, entry] of runtimes) entry.controller.abort();
    const results = await Promise.allSettled(runtimes.map(([transport]) => transport.close()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "OpenCode background cleanup failed.");
  }

  assertCleanupComplete(workspacePath: string): void {
    if ([...this.active.values()].some((entry) => entry.cleanupPending && entry.workspacePath === path.resolve(workspacePath))) {
      throw new Error("OpenCode background process cleanup is still pending.");
    }
  }

  async runBackgroundStructuredPrompt<TOutput = unknown>(input: RunBackgroundStructuredPromptInput): Promise<RunBackgroundStructuredPromptResult<TOutput>> {
    this.assertCleanupComplete(input.workspacePath);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeoutMs), ...(input.signal ? [input.signal] : [])]);
    const apiKey = getProviderAppSettings(input.appSettings, "opencode").apiKey.trim() || process.env.OPENCODE_API_KEY?.trim() || "";
    const transport = (this.options.createTransport ?? ((options) => new OpenCodeTransport(options)))({
      executable: this.options.executable ?? resolveOpenCodeBinaryPath(),
      cwd: input.workspacePath,
      databasePath: this.options.databasePath,
      background: true,
      env: mergeDefinedProviderEnv(process.env, apiKey ? { OPENCODE_API_KEY: apiKey } : {}),
    });
    const entry = { controller, workspacePath: path.resolve(input.workspacePath), cleanupPending: false };
    this.active.set(transport, entry);
    void transport.whenClosed().then(() => this.active.delete(transport));
    let redactor = createProviderAgentRuntimeBindingRedactor(null, [apiKey]);
    try {
      signal.throwIfAborted();
      const client = await transport.start(signal);
      redactor = createProviderAgentRuntimeBindingRedactor(null, [apiKey, ...(transport.secrets ?? [])]);
      const model = resolveOpenCodeModelRef(input.model, input.reasoningEffort);
      await validateOpenCodeModel(client, model, { directory: path.join(path.dirname(this.options.databasePath), "background-config") }, [], signal);
      const response = await client.generate.text({
        model,
        prompt: `${input.prompt.systemText}\n\n${input.prompt.userText}\n\nReturn only one JSON value matching this schema, without markdown or explanation:\n${JSON.stringify(input.prompt.outputSchema)}`,
      }, { signal });
      signal.throwIfAborted();
      const rawText = redactor.sanitizeText(response.text);
      let output: unknown;
      try { output = JSON.parse(rawText); }
      catch { throw new Error("OpenCode structured output is not a complete JSON value."); }
      const errors = validateStructuredPromptSchemaValue(input.prompt.outputSchema, output);
      if (errors.length) throw new Error(`OpenCode structured output did not match schema: ${errors.join("; ")}`);
      return { threadId: null, rawText, output: output as TOutput, parsedJson: output, rawItemsJson: "[]", usage: null, providerQuotaTelemetry: null };
    } catch (error) {
      if (signal.aborted) {
        const aborted = new Error("OpenCode background generation was canceled or timed out.");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw new Error(redactor.sanitizeText(error instanceof Error ? error.message : String(error)));
    } finally {
      entry.cleanupPending = true;
      try { await transport.close(); }
      catch {
        this.options.log?.({ level: "warn", kind: "opencode-background-cleanup", message: "OpenCode background process cleanup is still pending." });
      }
    }
  }

  async extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult> {
    const result = await this.runBackgroundStructuredPrompt({
      providerId: input.session.provider, workspacePath: input.session.workspacePath, appSettings: input.appSettings,
      model: input.model, reasoningEffort: input.reasoningEffort, timeoutMs: input.timeoutMs, prompt: input.prompt,
    });
    return { threadId: null, rawText: result.rawText, delta: parseSessionMemoryDeltaText(result.rawText), rawItemsJson: result.rawItemsJson, usage: null, providerQuotaTelemetry: null };
  }
}
