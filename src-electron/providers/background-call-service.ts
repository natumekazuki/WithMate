import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundExecutionSelection } from "../../src-shared/settings/background-settings.js";
import { classifyBackgroundFailure, type BackgroundFailureInput } from "./background-failure.js";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { runWithRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnHandle } from "./provider-agent-runtime-turn-coordinator.js";
import type { BackgroundExecution, BackgroundExecutionService } from "./background-execution-service.js";

export type BackgroundCallContext = Omit<
  Parameters<BackgroundExecutionService["begin"]>[0], "providerId" | "session"
> & { session: Session };

export type BackgroundSelection = Readonly<BackgroundExecutionSelection>;

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

/** One invocation; execution ownership remains in BackgroundExecutionService. */
export class BackgroundCallService {
  constructor(private readonly deps: {
    executions: BackgroundExecutionService;
    runAgent: BackgroundAgentPort;
    onFailure?: (input: BackgroundFailureInput) => void;
  }) {}

  async runOnce(input: BackgroundCallInput): Promise<BackgroundCallResult> {
    const failed = (error: unknown, stage: BackgroundFailureInput["stage"]): BackgroundCallResult => {
      const failure = classifyBackgroundFailure(error, stage, stage === "admission" ? "BACKGROUND_ADMISSION_CALLBACK_FAILED" : stage === "setup" ? "BACKGROUND_SETUP_FAILED" : "BACKGROUND_AGENT_FAILED");
      this.deps.onFailure?.({ purpose: input.context.scope.purpose, source: input.context.scope.history.source,
        selection: input.selection, stage: failure.stage, error: failure });
      return { kind: "failed", code: failure.code };
    };
    let execution: BackgroundExecution;
    try {
      execution = this.deps.executions.begin({ ...input.context, providerId: input.selection.providerId });
    } catch (error) {
      if (input.context.signal?.aborted && error === input.context.signal.reason) {
        return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };
      }
      return failed(error, "setup");
    }
    try {
      try {
        input.onAdmitted();
      } catch (error) {
        return failed(error, "admission");
      }

      try {
        execution.signal.throwIfAborted();
        await runWithRuntimeTurnAdmission(execution.admission, () => this.deps.runAgent({
          session: input.context.session, scope: input.context.scope, selection: input.selection,
          userInput: input.userInput,
          binding: execution.binding, handle: execution.handle, signal: execution.signal,
        }));
      } catch (error) {
        if (execution.failure) return failed(execution.failure, execution.failure.stage);
        return execution.signal.aborted
          ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
          : failed(error, "agent");
      }
      if (execution.failure) return failed(execution.failure, execution.failure.stage);
      if (execution.signal.aborted) return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };

      return { kind: "completed" };
    } finally {
      this.deps.executions.finish(execution);
    }
  }
}
