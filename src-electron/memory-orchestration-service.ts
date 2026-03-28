import {
  getProviderAppSettings,
  mergeSessionMemory,
  type AppSettings,
  type AuditLogEntry,
  type CharacterMemoryDelta,
  type CharacterMemoryEntry,
  type CharacterProfile,
  type CharacterReflectionMonologue,
  type Session,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionMemory,
  type SessionMemoryDelta,
} from "../src/app-state.js";
import type { ProviderTurnAdapter } from "./provider-runtime.js";
import {
  buildCharacterReflectionContextSnapshot,
  buildCharacterReflectionLogicalPrompt,
  buildCharacterReflectionPrompt,
  buildCharacterReflectionTransportPayload,
  getCharacterReflectionSettings,
  hasCharacterMemoryDeltaContent,
  shouldTriggerCharacterReflection,
  type CharacterReflectionCheckpoint,
  type CharacterReflectionTriggerReason,
} from "./character-reflection.js";
import {
  buildSessionMemoryExtractionLogicalPrompt,
  buildSessionMemoryExtractionPrompt,
  buildSessionMemoryExtractionTransportPayload,
  getSessionMemoryExtractionSettings,
  shouldTriggerSessionMemoryExtraction,
  type SessionMemoryExtractionTriggerReason,
} from "./session-memory-extraction.js";
import { isCanceledRunError } from "./session-runtime-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

export type MemoryOrchestrationServiceDeps = {
  getSession(sessionId: string): Session | null;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  resolveSessionCharacter(session: Session): Promise<CharacterProfile | null>;
  getAppSettings(): AppSettings;
  getProviderAdapter(providerId: string): ProviderTurnAdapter;
  ensureSessionMemory(session: Session): SessionMemory;
  upsertSessionMemory(memory: SessionMemory): void;
  promoteSessionMemoryDeltaToProjectMemory(session: Session, delta: SessionMemoryDelta): void;
  resolveCharacterMemoryEntriesForReflection(session: Session): CharacterMemoryEntry[];
  markCharacterMemoryEntriesUsed(entryIds: string[]): void;
  saveCharacterMemoryDelta(session: Session, entries: CharacterMemoryDelta["entries"]): number;
  appendMonologueToSession(session: Session, monologue: CharacterReflectionMonologue): Session;
  createAuditLog(input: CreateAuditLogInput): AuditLogEntry;
  updateAuditLog(id: number, entry: CreateAuditLogInput): void;
  setSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ): void;
};

function buildMonologueSummary(monologue: CharacterReflectionMonologue | null): string {
  if (!monologue) {
    return "更新はありませんでした。";
  }

  return monologue.text.length > 72 ? `${monologue.text.slice(0, 72)}…` : monologue.text;
}

export class MemoryOrchestrationService {
  private readonly inFlightSessionMemoryExtractions = new Set<string>();
  private readonly inFlightCharacterReflections = new Set<string>();
  private readonly characterReflectionCheckpoints = new Map<string, CharacterReflectionCheckpoint>();

  constructor(private readonly deps: MemoryOrchestrationServiceDeps) {}

  clearCharacterReflectionCheckpoint(sessionId: string): void {
    this.characterReflectionCheckpoints.delete(sessionId);
  }

  clearInFlightCharacterReflection(sessionId: string): void {
    this.inFlightCharacterReflections.delete(sessionId);
  }

  reset(): void {
    this.inFlightSessionMemoryExtractions.clear();
    this.inFlightCharacterReflections.clear();
    this.characterReflectionCheckpoints.clear();
  }

  async runCharacterReflection(
    session: Session,
    options: { triggerReason: CharacterReflectionTriggerReason },
  ): Promise<void> {
    if (this.inFlightCharacterReflections.has(session.id)) {
      return;
    }

    const latestSession = this.deps.getSession(session.id) ?? session;
    if (this.deps.isSessionRunInFlight(latestSession.id) || this.deps.isRunningSession(latestSession)) {
      return;
    }

    const checkpoint = this.characterReflectionCheckpoints.get(latestSession.id) ?? null;
    const currentSnapshot = buildCharacterReflectionContextSnapshot(latestSession);
    if (!shouldTriggerCharacterReflection(currentSnapshot, checkpoint, options.triggerReason)) {
      return;
    }

    const character = await this.deps.resolveSessionCharacter(latestSession);
    if (!character) {
      return;
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, latestSession.provider).enabled) {
      return;
    }

    const providerAdapter = this.deps.getProviderAdapter(latestSession.provider);
    const sessionMemory = this.deps.ensureSessionMemory(latestSession);
    const characterMemoryEntries = this.deps.resolveCharacterMemoryEntriesForReflection(latestSession);
    const reflectionSettings = getCharacterReflectionSettings(appSettings, latestSession.provider);
    const prompt = buildCharacterReflectionPrompt({
      session: latestSession,
      sessionMemory,
      character,
      characterMemoryEntries,
      triggerReason: options.triggerReason,
    });
    const logicalPrompt = buildCharacterReflectionLogicalPrompt(prompt);
    const transportPayload = buildCharacterReflectionTransportPayload(
      latestSession.provider,
      reflectionSettings,
      options.triggerReason,
    );
    const runningAuditLog = this.deps.createAuditLog({
      sessionId: latestSession.id,
      createdAt: new Date().toISOString(),
      phase: "background-running",
      provider: latestSession.provider,
      model: reflectionSettings.model,
      reasoningEffort: reflectionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: "",
      operations: [],
      rawItemsJson: "[]",
      usage: null,
      errorMessage: "",
    });

    this.inFlightCharacterReflections.add(latestSession.id);
    this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
      sessionId: latestSession.id,
      kind: "monologue",
      status: "running",
      title: "Monologue",
      summary: options.triggerReason === "session-start"
        ? "SessionStart の独り言を生成しています。"
        : "独り言と Character Memory を整理しています。",
      details: `trigger: ${options.triggerReason}\nmodel: ${reflectionSettings.model}\nreasoning: ${reflectionSettings.reasoningEffort}`,
      errorMessage: "",
      updatedAt: new Date().toISOString(),
    });

    try {
      const reflectionResult = await providerAdapter.runCharacterReflection({
        session: latestSession,
        sessionMemory,
        character,
        characterMemoryEntries,
        appSettings,
        model: reflectionSettings.model,
        reasoningEffort: reflectionSettings.reasoningEffort,
        triggerReason: options.triggerReason,
        prompt,
      });

      if (!reflectionResult.output) {
        throw new Error("Character reflection の JSON parse に失敗したよ。");
      }

      const memoryEntries = reflectionResult.output.memoryDelta?.entries ?? [];
      const monologue = reflectionResult.output.monologue;
      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId: latestSession.id,
        createdAt: runningAuditLog.createdAt,
        phase: "background-completed",
        provider: latestSession.provider,
        model: reflectionSettings.model,
        reasoningEffort: reflectionSettings.reasoningEffort,
        approvalMode: latestSession.approvalMode,
        threadId: reflectionResult.threadId ?? latestSession.threadId,
        logicalPrompt,
        transportPayload,
        assistantText: reflectionResult.rawText,
        operations: [],
        rawItemsJson: "[]",
        usage: reflectionResult.usage,
        errorMessage: "",
      });

      if (characterMemoryEntries.length > 0) {
        this.deps.markCharacterMemoryEntriesUsed(characterMemoryEntries.map((entry) => entry.id));
      }

      const savedCount = options.triggerReason === "session-start" || !hasCharacterMemoryDeltaContent(reflectionResult.output.memoryDelta)
        ? 0
        : this.deps.saveCharacterMemoryDelta(latestSession, memoryEntries);
      if (monologue) {
        this.deps.appendMonologueToSession(this.deps.getSession(latestSession.id) ?? latestSession, monologue);
      }

      this.characterReflectionCheckpoints.set(latestSession.id, {
        ...currentSnapshot,
        reflectedAt: new Date().toISOString(),
      });
      this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
        sessionId: latestSession.id,
        kind: "monologue",
        status: "completed",
        title: "Monologue",
        summary: buildMonologueSummary(monologue),
        details: [
          `trigger: ${options.triggerReason}`,
          `model: ${reflectionSettings.model}`,
          `reasoning: ${reflectionSettings.reasoningEffort}`,
          savedCount > 0 ? `characterMemory: ${savedCount}件更新` : "",
        ].filter((line) => line.length > 0).join("\n"),
        errorMessage: "",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId: latestSession.id,
        createdAt: runningAuditLog.createdAt,
        phase: isCanceledRunError(error) ? "background-canceled" : "background-failed",
        provider: latestSession.provider,
        model: reflectionSettings.model,
        reasoningEffort: reflectionSettings.reasoningEffort,
        approvalMode: latestSession.approvalMode,
        threadId: latestSession.threadId,
        logicalPrompt,
        transportPayload,
        assistantText: "",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
        sessionId: latestSession.id,
        kind: "monologue",
        status: isCanceledRunError(error) ? "canceled" : "failed",
        title: "Monologue",
        summary: isCanceledRunError(error) ? "独り言生成はキャンセルされました。" : "独り言生成に失敗しました。",
        details: `trigger: ${options.triggerReason}\nmodel: ${reflectionSettings.model}\nreasoning: ${reflectionSettings.reasoningEffort}`,
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      console.error("character reflection failed", {
        sessionId: latestSession.id,
        provider: latestSession.provider,
        error,
      });
    } finally {
      this.inFlightCharacterReflections.delete(latestSession.id);
    }
  }

  async runSessionMemoryExtraction(
    session: Session,
    usage: AuditLogEntry["usage"],
    options?: { force?: boolean; triggerReason?: SessionMemoryExtractionTriggerReason },
  ): Promise<void> {
    if (this.inFlightSessionMemoryExtractions.has(session.id)) {
      return;
    }

    const appSettings = this.deps.getAppSettings();
    const extractionSettings = getSessionMemoryExtractionSettings(appSettings, session.provider);
    const shouldRun = shouldTriggerSessionMemoryExtraction(
      usage,
      extractionSettings.outputTokensThreshold,
      options?.force ?? false,
    );
    if (!shouldRun) {
      return;
    }

    const latestSession = this.deps.getSession(session.id) ?? session;
    const currentMemory = this.deps.ensureSessionMemory(latestSession);
    const prompt = buildSessionMemoryExtractionPrompt(latestSession, currentMemory);
    const logicalPrompt = buildSessionMemoryExtractionLogicalPrompt(prompt);
    const triggerReason = options?.triggerReason ?? (options?.force ? "session-window-close" : "outputTokensThreshold");
    const transportPayload = buildSessionMemoryExtractionTransportPayload(
      latestSession.provider,
      extractionSettings,
      triggerReason,
    );
    const providerAdapter = this.deps.getProviderAdapter(latestSession.provider);
    const runningAuditLog = this.deps.createAuditLog({
      sessionId: latestSession.id,
      createdAt: new Date().toISOString(),
      phase: "background-running",
      provider: latestSession.provider,
      model: extractionSettings.model,
      reasoningEffort: extractionSettings.reasoningEffort,
      approvalMode: latestSession.approvalMode,
      threadId: latestSession.threadId,
      logicalPrompt,
      transportPayload,
      assistantText: "",
      operations: [],
      rawItemsJson: "[]",
      usage: null,
      errorMessage: "",
    });

    this.inFlightSessionMemoryExtractions.add(session.id);
    this.deps.setSessionBackgroundActivity(session.id, "memory-generation", {
      sessionId: session.id,
      kind: "memory-generation",
      status: "running",
      title: "Memory生成",
      summary: "Session Memory を整理しています。",
      details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
      errorMessage: "",
      updatedAt: new Date().toISOString(),
    });
    try {
      const extractionResult = await providerAdapter.extractSessionMemoryDelta({
        session: latestSession,
        appSettings,
        model: extractionSettings.model,
        reasoningEffort: extractionSettings.reasoningEffort,
        prompt,
      });
      const delta = extractionResult.delta;
      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId: latestSession.id,
        createdAt: runningAuditLog.createdAt,
        phase: "background-completed",
        provider: latestSession.provider,
        model: extractionSettings.model,
        reasoningEffort: extractionSettings.reasoningEffort,
        approvalMode: latestSession.approvalMode,
        threadId: extractionResult.threadId ?? latestSession.threadId,
        logicalPrompt,
        transportPayload,
        assistantText: extractionResult.rawText,
        operations: [],
        rawItemsJson: "[]",
        usage: extractionResult.usage,
        errorMessage: "",
      });
      const memoryFieldLabels = delta
        ? [
          delta.goal !== undefined ? "goal" : null,
          delta.decisions?.length ? "decisions" : null,
          delta.openQuestions?.length ? "openQuestions" : null,
          delta.nextActions?.length ? "nextActions" : null,
          delta.notes?.length ? "notes" : null,
        ].filter((value): value is string => !!value)
        : [];
      this.deps.setSessionBackgroundActivity(session.id, "memory-generation", {
        sessionId: session.id,
        kind: "memory-generation",
        status: "completed",
        title: "Memory生成",
        summary: memoryFieldLabels.length > 0
          ? `Session Memory を更新しました: ${memoryFieldLabels.join(", ")}`
          : "更新は不要でした。",
        details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
        errorMessage: "",
        updatedAt: new Date().toISOString(),
      });
      if (!delta) {
        return;
      }

      const sessionForSave = this.deps.getSession(session.id) ?? latestSession;
      const currentForSave = this.deps.ensureSessionMemory(sessionForSave);
      this.deps.upsertSessionMemory(
        mergeSessionMemory(
          {
            ...currentForSave,
            workspacePath: sessionForSave.workspacePath,
            threadId: sessionForSave.threadId,
          },
          delta,
        ),
      );
      this.deps.promoteSessionMemoryDeltaToProjectMemory(sessionForSave, delta);
    } catch (error) {
      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId: latestSession.id,
        createdAt: runningAuditLog.createdAt,
        phase: "background-failed",
        provider: latestSession.provider,
        model: extractionSettings.model,
        reasoningEffort: extractionSettings.reasoningEffort,
        approvalMode: latestSession.approvalMode,
        threadId: latestSession.threadId,
        logicalPrompt,
        transportPayload,
        assistantText: "",
        operations: [],
        rawItemsJson: "[]",
        usage: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.deps.setSessionBackgroundActivity(session.id, "memory-generation", {
        sessionId: session.id,
        kind: "memory-generation",
        status: isCanceledRunError(error) ? "canceled" : "failed",
        title: "Memory生成",
        summary: isCanceledRunError(error)
          ? "Memory 生成はキャンセルされました。"
          : "Memory 生成に失敗しました。",
        details: `trigger: ${triggerReason}\nmodel: ${extractionSettings.model}\nreasoning: ${extractionSettings.reasoningEffort}`,
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      console.error("session memory extraction failed", {
        sessionId: session.id,
        provider: session.provider,
        error,
      });
    } finally {
      this.inFlightSessionMemoryExtractions.delete(session.id);
    }
  }
}
