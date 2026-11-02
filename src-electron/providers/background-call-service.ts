import type { Session } from "../../src-shared/session/session-state.js";
import type { BackgroundExecutionScope } from "../../src-shared/agent-runtime/background-execution-scope.js";
import {
  runWithRuntimeTurnAdmission,
  RuntimeTurnInactiveError,
} from "../platform/memory/runtime-turn-admission.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { ProviderAgentRuntimeTurnHandle } from "./provider-agent-runtime-turn-coordinator.js";
import type { BackgroundExecution, BackgroundExecutionService } from "./background-execution-service.js";

export type BackgroundCallContext = Omit<
  Parameters<BackgroundExecutionService["begin"]>[0], "providerId" | "session"
> & { session: Session };

export type BackgroundSelection = Readonly<{ providerId: string; modelId: string }>;

export type BackgroundGenerationInput = Readonly<{
  session: Session;
  scope: BackgroundExecutionScope;
  selection: BackgroundSelection;
  userInput: string;
  finalSchema: Readonly<Record<string, unknown>>;
  binding: ProviderAgentRuntimeBindingProjection;
  handle: ProviderAgentRuntimeTurnHandle;
  signal: AbortSignal;
}>;

/** A trusted adapter returns only the final value, not a transcript or intermediate output. */
export type BackgroundGenerationPort = (input: BackgroundGenerationInput) => unknown | Promise<unknown>;

export type BackgroundSaveResult =
  | { kind: "saved"; confirmedSavedCount: number }
  | { kind: "none" }
  | { kind: "stopped"; confirmedSavedCount: number | null;
      cause: "rejected" | "failed" | "unknown" | "canceled" | "revoked"; code: string };

export type BackgroundCallInput<Output> = Readonly<{
  context: BackgroundCallContext;
  selection: BackgroundSelection;
  userInput: string;
  final: Readonly<{
    schema: Readonly<Record<string, unknown>>;
    parse: (raw: unknown) => Output;
  }>;
  onAdmitted: () => void;
  save: (output: Output, execution: BackgroundExecution) => BackgroundSaveResult | Promise<BackgroundSaveResult>;
}>;

export type BackgroundCallResult =
  | { kind: "skipped"; reason: "capacity" | "already_active" }
  | { kind: "failed" | "invalid_output" | "canceled"; code: string }
  | { kind: "generated"; save: BackgroundSaveResult };

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : fallback;
}

/** One invocation; execution ownership and capacity remain in BackgroundExecutionService. */
export class BackgroundCallService {
  constructor(private readonly deps: {
    executions: BackgroundExecutionService;
    generate: BackgroundGenerationPort;
  }) {}

  async runOnce<Output>(input: BackgroundCallInput<Output>): Promise<BackgroundCallResult> {
    let begun: ReturnType<BackgroundExecutionService["begin"]>;
    try {
      begun = this.deps.executions.begin({ ...input.context, providerId: input.selection.providerId });
    } catch (error) {
      if (input.context.signal?.aborted && error === input.context.signal.reason) {
        return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };
      }
      // Invalid authority/source and unavailable runtimes retain their existing begin failure.
      throw error;
    }
    if (!begun.ok) return { kind: "skipped", reason: begun.reason };
    const { execution } = begun;
    try {
      try {
        input.onAdmitted();
      } catch (error) {
        return { kind: "failed", code: errorCode(error, "BACKGROUND_ADMISSION_CALLBACK_FAILED") };
      }

      let raw: unknown;
      try {
        execution.signal.throwIfAborted();
        raw = await this.deps.generate({
          session: input.context.session, scope: input.context.scope, selection: input.selection,
          userInput: input.userInput, finalSchema: input.final.schema,
          binding: execution.binding, handle: execution.handle, signal: execution.signal,
        });
      } catch (error) {
        return execution.signal.aborted
          ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
          : { kind: "failed", code: errorCode(error, "BACKGROUND_GENERATION_FAILED") };
      } finally {
        this.deps.executions.nativeCompleted(execution);
      }
      if (execution.signal.aborted) return { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" };

      let output: Output;
      try {
        output = input.final.parse(raw);
      } catch (error) {
        return execution.signal.aborted
          ? { kind: "canceled", code: "BACKGROUND_CALL_CANCELED" }
          : { kind: "invalid_output", code: errorCode(error, "BACKGROUND_FINAL_INVALID") };
      }

      let saveStarted = false;
      try {
        const save = await runWithRuntimeTurnAdmission(execution.admission, () => {
          saveStarted = true;
          return input.save(output, execution);
        });
        return { kind: "generated", save };
      } catch (error) {
        if (!saveStarted && error instanceof RuntimeTurnInactiveError) {
          return { kind: "canceled", code: "RUNTIME_TURN_INACTIVE" };
        }
        return { kind: "generated", save: {
          kind: "stopped", confirmedSavedCount: null,
          cause: error instanceof RuntimeTurnInactiveError ? "revoked" : "unknown",
          code: errorCode(error, error instanceof RuntimeTurnInactiveError
            ? "RUNTIME_TURN_INACTIVE" : "BACKGROUND_SAVE_UNKNOWN"),
        } };
      }
    } finally {
      this.deps.executions.finish(execution);
    }
  }
}
