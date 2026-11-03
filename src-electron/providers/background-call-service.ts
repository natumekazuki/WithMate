import type { Session } from "../../src-shared/session/session-state.js";
import type { ModelReasoningEffort } from "../../src-shared/settings/model-catalog.js";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnHandle } from "./provider-agent-runtime-turn-coordinator.js";
import type { BackgroundExecution, BackgroundExecutionService } from "./background-execution-service.js";

export type BackgroundCallContext = Omit<
  Parameters<BackgroundExecutionService["begin"]>[0], "providerId" | "session"
> & { session: Session };

export type BackgroundSelection = Readonly<{ providerId: string; modelId: string; reasoningEffort?: ModelReasoningEffort }>;

export type BackgroundAgentInput = Readonly<{
  session: Session;
  scope: BackgroundExecutionScope;
  selection: BackgroundSelection;
  userInput: string;
  binding: ProviderAgentRuntimeBindingProjection;
  handle: ProviderAgentRuntimeTurnHandle;
  signal: AbortSignal;
}>;

/** The Agent reads and registers through its bound tools within this invocation. */
export type BackgroundAgentPort = (input: BackgroundAgentInput) => void | Promise<void>;

export type BackgroundCallInput = Readonly<{
  context: BackgroundCallContext;
  selection: BackgroundSelection;
  userInput: string;
  onAdmitted: () => void;
}>;

export type BackgroundCallResult =
  | { kind: "failed" | "canceled"; code: string }
  | { kind: "completed" };

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : fallback;
}

/** One invocation; execution ownership remains in BackgroundExecutionService. */
export class BackgroundCallService {
  constructor(private readonly deps: {
    executions: BackgroundExecutionService;
    runAgent: BackgroundAgentPort;
  }) {}

  async runOnce(input: BackgroundCallInput): Promise<BackgroundCallResult> {
    let execution: BackgroundExecution;
    try {
      execution = this.deps.executions.begin({ ...input.context, providerId: input.selection.providerId });
    } catch (error) {
      if (input.context.signal?.aborted && error === input.context.signal.reason) {
        return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };
      }
      // Invalid authority/source and unavailable runtimes retain their existing begin failure.
      throw error;
    }
    try {
      try {
        input.onAdmitted();
      } catch (error) {
        return { kind: "failed", code: errorCode(error, "BACKGROUND_ADMISSION_CALLBACK_FAILED") };
      }

      try {
        execution.signal.throwIfAborted();
        await runWithRuntimeTurnAdmission(execution.admission, () => this.deps.runAgent({
          session: input.context.session, scope: input.context.scope, selection: input.selection,
          userInput: input.userInput,
          binding: execution.binding, handle: execution.handle, signal: execution.signal,
        }));
      } catch (error) {
        return execution.signal.aborted
          ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
          : { kind: "failed", code: errorCode(error, "BACKGROUND_AGENT_FAILED") };
      }
      if (execution.signal.aborted) return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };

      return { kind: "completed" };
    } finally {
      this.deps.executions.finish(execution);
    }
  }
}
