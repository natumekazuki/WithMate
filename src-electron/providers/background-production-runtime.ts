import type { BackgroundExecutionScope, BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import { getBackgroundMemoryReadOperations } from "../../src-shared/agent-runtime/background-memory-read.js";
import { BACKGROUND_REGISTRATION_OPERATIONS } from "../../src-shared/agent-runtime/background-operations.js";
import type { ProviderAgentRuntimeAuthoritySnapshot } from "../../src-shared/agent-runtime/agent-runtime-binding-contract.js";
import { getSessionHistoryAgentRuntimeOperations } from "../../src-shared/session-history/session-history-contract.js";
import type { BackgroundSourceRef, CapturedBackgroundSource } from "../../src-shared/session/background-source-snapshot.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { resolveBackgroundProviderAvailability } from "../../src-shared/settings/background-provider-support.js";
import type { SessionBackgroundEvent } from "../session/session-background-events.js";
import { BackgroundCallService, type BackgroundAgentPort, type BackgroundCallInput } from "./background-call-service.js";
import type { BackgroundExecutionService } from "./background-execution-service.js";
import type { BackgroundRegistration } from "./background-registration.js";

export type BackgroundRuntimeEvent =
  | (SessionBackgroundEvent & Readonly<{ source: BackgroundSourceRef }>)
  | Readonly<{ kind: "settings_changed"; settings: AppSettings }>
  | Readonly<{ kind: "stopped" }>;

export type PrepareBackgroundCallInput = Readonly<{
  purpose: BackgroundPurpose;
  source: BackgroundSourceRef;
  session: Session;
  processing: BackgroundExecutionScope["processing"];
  memoryTargets: BackgroundExecutionScope["memoryTargets"];
}>;

export type PreparedBackgroundCall =
  | { status: "ready"; call: Omit<BackgroundCallInput, "userInput" | "onAdmitted">; instructionText?: string }
  | { status: "not_configured" | "unavailable" | "failed"; code: string; reason: string };

/** Purpose controllers choose processing positions; the shared builder only fixes and validates their scope. */
export function buildBackgroundExecutionScope(
  captured: CapturedBackgroundSource,
  input: Pick<PrepareBackgroundCallInput, "purpose" | "processing" | "memoryTargets">,
): BackgroundExecutionScope {
  const { afterTurnId, throughTurnId } = input.processing;
  if ((afterTurnId !== null && (!Number.isSafeInteger(afterTurnId) || afterTurnId < 0))
    || !Number.isSafeInteger(throughTurnId) || throughTurnId <= (afterTurnId ?? 0)
    || !captured.snapshot.turns.some((turn) => turn.id === throughTurnId
      && turn.phase !== "running" && turn.completedAt && turn.assistantMessageSeq !== undefined
      && turn.assistantMessageSeq >= captured.history.fromMessageSeq
      && turn.assistantMessageSeq <= captured.history.throughMessageSeq)) {
    throw new Error("Background processing requires a saved terminal Turn within the captured history.");
  }
  return structuredClone({ purpose: input.purpose, history: captured.history,
    processing: input.processing, memoryTargets: input.memoryTargets });
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
    resolveAuthority(session: Session): ProviderAgentRuntimeAuthoritySnapshot | null;
    sourceKinds: BackgroundRegistration["sourceKinds"];
  }) {
    this.calls = new BackgroundCallService({ executions: deps.executions, runAgent: deps.runAgent });
  }

  subscribe(listener: (event: BackgroundRuntimeEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(event: BackgroundRuntimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(event)).catch((error) => console.warn("Background controller callback failed", error));
      } catch (error) { console.warn("Background controller callback failed", error); }
    }
  }

  start(): void { this.deps.executions.start(); }
  stop(): void {
    this.deps.executions.stop();
    this.publish({ kind: "stopped" });
  }

  async prepare(input: PrepareBackgroundCallInput): Promise<PreparedBackgroundCall> {
    let settings: AppSettings;
    try { settings = await this.deps.getAppSettings(); }
    catch { return { status: "failed", code: "BACKGROUND_SETTINGS_UNAVAILABLE", reason: "Background settings could not be retrieved." }; }
    const configured = settings.backgroundExecutionSettings[input.purpose];
    if (!configured.selection) return { status: "not_configured", code: "BACKGROUND_NOT_CONFIGURED", reason: "Select a provider and model for this purpose in Settings." };
    if (!settings.codingProviderSettings[configured.selection.providerId]?.enabled) {
      return { status: "unavailable", code: "BACKGROUND_PROVIDER_DISABLED", reason: "Enable the selected provider in Settings." };
    }
    if (!this.deps.sourceKinds[input.purpose]?.includes(input.source.kind)) {
      return { status: "unavailable", code: "BACKGROUND_SOURCE_UNSUPPORTED", reason: "Registration for this purpose does not support this conversation kind." };
    }
    let catalog: ModelCatalogSnapshot;
    try { catalog = await this.deps.getModelCatalog(input.session, configured.selection.providerId); }
    catch { return { status: "failed", code: "BACKGROUND_CATALOG_UNAVAILABLE", reason: "Background models could not be retrieved." }; }
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
    const authoritySnapshot = this.deps.resolveAuthority(session);
    if (!authoritySnapshot) return { status: "unavailable", code: "BACKGROUND_AUTHORITY_UNAVAILABLE", reason: "The source Character authority is unavailable." };
    const scope = buildBackgroundExecutionScope(captured, input);
    return { status: "ready", instructionText: configured.instructionText, call: {
      context: { session, actorSessionId: session.id, authoritySnapshot, scope,
        operationGrants: [...getSessionHistoryAgentRuntimeOperations(), ...getBackgroundMemoryReadOperations(),
          BACKGROUND_REGISTRATION_OPERATIONS[input.purpose].operation] },
      selection: { ...configured.selection },
    } };
  }
}
