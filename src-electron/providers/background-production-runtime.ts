import type { BackgroundExecutionScope, BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { backgroundMemoryToolOperations, getBackgroundReadOperations } from "../../src-shared/agent-runtime/background-operations.js";
import type { ProviderAgentRuntimeAuthoritySnapshot } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import { getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { getModelDisabledReason } from "../../src-shared/settings/model-availability.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { SessionBackgroundEvent } from "../session/session-background-events.js";
import { BackgroundCallService, type BackgroundAgentPort, type BackgroundCallInput } from "./background-call-service.js";
import type { BackgroundExecutionService } from "./background-execution-service.js";
import type { BackgroundRegistration } from "./background-registration.js";
import { classifyBackgroundFailure, projectBackgroundFailure, projectBackgroundExecutionDiagnostic, type BackgroundFailureEvent,
  type BackgroundFailureInput, type BackgroundExecutionDiagnosticEvent } from "./background-failure.js";
import { resolveBackgroundExecutionOptions } from "../../src-shared/settings/background-settings.js";
import { captureBackgroundMemoryFileAccess } from "../memory/background-memory-file-access.js";

export type BackgroundRuntimeEvent =
  | (SessionBackgroundEvent & Readonly<{ source: BackgroundSourceRef }>)
  | Readonly<{ kind: "settings_changed"; settings: AppSettings }>
  | Readonly<{ kind: "stopped" }>;

export type PrepareBackgroundCallInput = Readonly<{
  purpose: BackgroundPurpose;
  source: BackgroundSourceRef;
  session: Session;
  memoryTargets: BackgroundExecutionScope["memoryTargets"];
}>;

export type PreparedBackgroundCall =
  | { status: "ready"; call: Omit<BackgroundCallInput, "userInput" | "onAdmitted">; instructionText?: string }
  | { status: "not_configured" | "unavailable" | "failed"; code: string; reason: string };

/** History is an authority window, not an AI processing-progress interval. */
export function buildBackgroundExecutionScope(
  captured: CapturedBackgroundSource,
  input: Pick<PrepareBackgroundCallInput, "purpose" | "memoryTargets">,
): BackgroundExecutionScope {
  if (!captured.snapshot.turns.some((turn) => ["completed", "failed", "canceled"].includes(turn.phase)
      && turn.completedAt && turn.assistantMessageSeq !== undefined
      && turn.assistantMessageSeq >= captured.history.fromMessageSeq
      && turn.assistantMessageSeq <= captured.history.throughMessageSeq)) {
    throw new Error("Background registration requires a saved terminal Turn within the captured history.");
  }
  return structuredClone({ purpose: input.purpose, history: captured.history,
    memoryTargets: input.memoryTargets });
}

/** Shared production seam; scheduling and storage policy belong to purpose controllers. */
export class BackgroundProductionRuntime {
  readonly calls: BackgroundCallService;
  readonly #listeners = new Set<(event: BackgroundRuntimeEvent) => void | Promise<void>>();

  constructor(private readonly deps: {
    executions: BackgroundExecutionService;
    runAgent: BackgroundAgentPort;
    getAppSettings(): AppSettings | Promise<AppSettings>;
    getModelCatalog(session: Session, providerId: string): ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>;
    captureSource(source: BackgroundSourceRef): Promise<CapturedBackgroundSource | null>;
    resolveAuthority(session: Session, source: BackgroundSourceRef): (ProviderAgentRuntimeAuthoritySnapshot & Record<string, unknown>) | null
      | Promise<(ProviderAgentRuntimeAuthoritySnapshot & Record<string, unknown>) | null>;
    resolveSessionFolderPath?(source: BackgroundSourceRef): string;
    sourceKinds: BackgroundRegistration["sourceKinds"];
    onFailure?: (event: BackgroundFailureEvent) => void;
    onExecutionDiagnostic?: (event: BackgroundExecutionDiagnosticEvent) => void;
  }) {
    this.calls = new BackgroundCallService({ executions: deps.executions, runAgent: deps.runAgent,
      onFailure: (failure) => this.reportFailure(failure, false),
      onExecutionDiagnostic: (diagnostic) => deps.onExecutionDiagnostic?.(projectBackgroundExecutionDiagnostic(diagnostic)) });
  }

  reportFailure(input: BackgroundFailureInput, remember = true): void {
    if (remember) this.calls.captureFailureRecorder(input)(input);
    try { this.deps.onFailure?.(projectBackgroundFailure(input)); }
    catch { console.warn("Background failure diagnostic could not be written."); }
  }

  subscribe(listener: (event: BackgroundRuntimeEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(event: BackgroundRuntimeEvent): void {
    if (event.kind === "settings_changed") {
      for (const purpose of ["character-memory", "target-memory", "affect"] as const) {
        this.calls.setProvider(purpose, event.settings.backgroundExecutionSettings[purpose].selection?.providerId);
      }
    }
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error) => console.warn("Background controller callback failed", error));
      } catch (error) { console.warn("Background controller callback failed", error); }
    }
  }

  start(): void { this.deps.executions.start(); }
  stop(): void {
    this.calls.stop();
    this.deps.executions.stop();
    this.publish({ kind: "stopped" });
  }

  forgetSource(kind: BackgroundSourceRef["kind"], sessionId: string): void { this.calls.forgetSource(kind, sessionId); }

  async prepare(input: PrepareBackgroundCallInput): Promise<PreparedBackgroundCall> {
    const rememberFailure = this.calls.captureFailureRecorder(input);
    const reportFailure = (failure: BackgroundFailureInput) => {
      rememberFailure(failure);
      this.reportFailure(failure, false);
    };
    let selection: BackgroundCallInput["selection"] | undefined;
    let result: PreparedBackgroundCall;
    try { result = await this.prepareCall(input, (value) => { selection = value; }); }
    catch (error) {
      reportFailure({ ...input, stage: "prepare", error, selection });
      const failure = classifyBackgroundFailure(error, "prepare", "BACKGROUND_PREPARE_FAILED");
      return { status: "failed", code: failure.code, reason: failure.reason };
    }
    if (result.status !== "ready" && result.status !== "not_configured") {
      reportFailure({ ...input, stage: "prepare", error: result, selection });
    }
    return result;
  }

  private async prepareCall(input: PrepareBackgroundCallInput, selected: (selection: BackgroundCallInput["selection"]) => void): Promise<PreparedBackgroundCall> {
    let settings: AppSettings;
    try { settings = await this.deps.getAppSettings(); }
    catch (cause) { throw Object.assign(new Error("Background settings could not be retrieved.", { cause }), { code: "BACKGROUND_SETTINGS_UNAVAILABLE" }); }
    const configured = structuredClone(settings.backgroundExecutionSettings[input.purpose]);
    if (!configured.selection) return { status: "not_configured", code: "BACKGROUND_NOT_CONFIGURED", reason: "Select a provider and model for this purpose in Settings." };
    selected(configured.selection);
    let executionOptions;
    try { executionOptions = resolveBackgroundExecutionOptions(configured.selection); }
    catch (cause) { throw Object.assign(new Error("The background execution settings are invalid for the provider.", { cause }), { code: "BACKGROUND_EXECUTION_OPTIONS_INVALID" }); }
    if (!settings.codingProviderSettings[configured.selection.providerId]?.enabled) {
      return { status: "unavailable", code: "BACKGROUND_PROVIDER_DISABLED", reason: "Enable the selected provider in Settings." };
    }
    if (getModelDisabledReason(settings.modelAvailability, configured.selection.providerId, configured.selection.modelId)) {
      return { status: "unavailable", code: "BACKGROUND_MODEL_DISABLED", reason: "Enable the selected model and its service in Settings > Models, or select another model." };
    }
    if (!this.deps.sourceKinds[input.purpose]?.includes(input.source.kind)) {
      return { status: "unavailable", code: "BACKGROUND_SOURCE_UNSUPPORTED", reason: "Registration for this purpose does not support this conversation kind." };
    }
    let catalog: ModelCatalogSnapshot;
    try { catalog = await this.deps.getModelCatalog(input.session, configured.selection.providerId); }
    catch (cause) { throw Object.assign(new Error("Background models could not be retrieved.", { cause }), { code: "BACKGROUND_CATALOG_UNAVAILABLE" }); }
    const availability = resolveBackgroundProviderAvailability(configured.selection, catalog);
    if (availability.status !== "available") {
      return availability.status === "not_configured"
        ? { status: "not_configured", code: "BACKGROUND_NOT_CONFIGURED", reason: "Select a background provider and model." }
        : availability;
    }
    const session = input.session;
    const captured = await this.deps.captureSource(input.source);
    if (!captured || session.id !== input.source.sessionId || getSessionIncarnationId(session) !== input.source.incarnationId
      || session.characterId !== captured.snapshot.session.characterId || isReadOnlySession(session)
      || session.sessionKind === "character-authoring") {
      return { status: "unavailable", code: "BACKGROUND_SOURCE_INVALID", reason: "The saved source conversation is no longer eligible." };
    }
    const authoritySnapshot = await this.deps.resolveAuthority(session, captured.history.source);
    if (!authoritySnapshot) return { status: "unavailable", code: "BACKGROUND_AUTHORITY_UNAVAILABLE", reason: "The source Character authority is unavailable." };
    const sessionFolderPath = this.deps.resolveSessionFolderPath?.(input.source);
    const fileAccess = sessionFolderPath === undefined ? undefined : await captureBackgroundMemoryFileAccess({
      readRoots: [session.workspacePath, ...session.allowedAdditionalDirectories, sessionFolderPath], sessionFolderPath,
      writable: executionOptions.approvalMode !== "plan"
        && (configured.selection.providerId !== "codex" || executionOptions.codexSandboxMode !== "read-only"),
    });
    const scope = { ...buildBackgroundExecutionScope(captured, input), ...(fileAccess ? { fileAccess } : {}) };
    return { status: "ready", instructionText: configured.instructionText, call: {
      context: { session, actorSessionId: session.id, authoritySnapshot, scope,
        operationGrants: [...getSessionHistoryAgentRuntimeOperations(), ...getBackgroundReadOperations(),
          ...Object.values(backgroundMemoryToolOperations(input.purpose, true, fileAccess))] },
      selection: { ...configured.selection },
    } };
  }
}
