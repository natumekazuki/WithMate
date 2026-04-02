import {
  mergeSessionMemory,
  type AuditLogEntry,
  type CharacterMemoryDelta,
  type CharacterMemoryEntry,
  type CharacterReflectionMonologue,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionMemory,
  type SessionMemoryDelta,
} from "../src/app-state.js";
import { type CharacterProfile } from "../src/character-state.js";
import {
  getCharacterReflectionTriggerSettings,
  getProviderAppSettings,
  type AppSettings,
} from "../src/provider-settings-state.js";
import { type Session } from "../src/session-state.js";
import type { ProviderBackgroundAdapter } from "./provider-runtime.js";
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
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

export type MemoryOrchestrationServiceDeps = {
  getSession(sessionId: string): Session | null;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  resolveSessionCharacter(session: Session): Promise<CharacterProfile | null>;
  getAppSettings(): AppSettings;
  getProviderBackgroundAdapter(providerId: string): ProviderBackgroundAdapter;
  ensureSessionMemory(session: Session): SessionMemory;
  upsertSessionMemory(memory: SessionMemory): void;
  promoteSessionMemoryDeltaToProjectMemory(session: Session, delta: SessionMemoryDelta): number;
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

function buildBackgroundActivityMetadataLines(input: {
  triggerReason: string;
  model: string;
  reasoningEffort: string;
  timeoutSeconds?: number;
}): string[] {
  const lines = [
    `trigger: ${input.triggerReason}`,
    `model: ${input.model}`,
    `reasoning: ${input.reasoningEffort}`,
  ];
  if (typeof input.timeoutSeconds === "number") {
    lines.push(`timeoutSeconds: ${input.timeoutSeconds}`);
  }
  return lines;
}

function appendDetailBlock(lines: string[], label: string, values: string[]): void {
  const normalizedValues = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalizedValues.length === 0) {
    return;
  }

  lines.push("", `${label}:`);
  lines.push(...normalizedValues.map((value) => `- ${value}`));
}

function buildSessionMemoryActivityDetails(input: {
  triggerReason: SessionMemoryExtractionTriggerReason;
  model: string;
  reasoningEffort: string;
  timeoutSeconds?: number;
  delta: SessionMemoryDelta | null;
  projectMemoryPromotions?: number;
}): string {
  const lines = buildBackgroundActivityMetadataLines(input);
  if (!input.delta) {
    return lines.join("\n");
  }

  appendDetailBlock(lines, "updated goal", input.delta.goal === null ? ["<cleared>"] : input.delta.goal ? [input.delta.goal] : []);
  appendDetailBlock(lines, "updated decisions", input.delta.decisions ?? []);
  appendDetailBlock(lines, "updated openQuestions", input.delta.openQuestions ?? []);
  appendDetailBlock(lines, "updated nextActions", input.delta.nextActions ?? []);
  appendDetailBlock(lines, "updated notes", input.delta.notes ?? []);
  if (typeof input.projectMemoryPromotions === "number") {
    lines.push("", `projectMemoryPromotions: ${input.projectMemoryPromotions}`);
  }
  return lines.join("\n");
}

function buildCharacterMemoryEntryDetail(entry: CharacterMemoryDelta["entries"][number]): string {
  const title = entry.title.trim();
  const detail = entry.detail.trim();
  return detail.length > 0
    ? `[${entry.category}] ${title} | ${detail}`
    : `[${entry.category}] ${title}`;
}

function buildCharacterMemoryActivityDetails(input: {
  triggerReason: string;
  model: string;
  reasoningEffort: string;
  timeoutSeconds?: number;
  entries: CharacterMemoryDelta["entries"];
  monologueUpdated?: boolean;
}): string {
  const lines = buildBackgroundActivityMetadataLines(input);
  if (input.monologueUpdated) {
    lines.push("", "monologue: updated");
  }

  const detailEntries = input.entries
    .slice(0, 5)
    .map((entry) => buildCharacterMemoryEntryDetail(entry));
  appendDetailBlock(lines, "updated entries", detailEntries);
  if (input.entries.length > 5) {
    lines.push(`- ...and ${input.entries.length - 5} more`);
  }

  return lines.join("\n");
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

    const appSettings = this.deps.getAppSettings();
    const checkpoint = this.characterReflectionCheckpoints.get(latestSession.id) ?? null;
    const currentSnapshot = buildCharacterReflectionContextSnapshot(latestSession);
    const triggerSettings = getCharacterReflectionTriggerSettings(appSettings);
    if (!shouldTriggerCharacterReflection(currentSnapshot, checkpoint, options.triggerReason, triggerSettings)) {
      return;
    }

    const character = await this.deps.resolveSessionCharacter(latestSession);
    if (!character) {
      return;
    }

    if (!appSettings.memoryGenerationEnabled) {
      return;
    }
    if (!getProviderAppSettings(appSettings, latestSession.provider).enabled) {
      return;
    }

    const providerAdapter = this.deps.getProviderBackgroundAdapter(latestSession.provider);
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
    if (options.triggerReason !== "session-start") {
      this.deps.setSessionBackgroundActivity(latestSession.id, "character-memory-generation", {
        sessionId: latestSession.id,
        kind: "character-memory-generation",
        status: "running",
        title: "CharacterMemory",
        summary: "Character Memory を整理しています。",
        details: buildCharacterMemoryActivityDetails({
          triggerReason: options.triggerReason,
          model: reflectionSettings.model,
          reasoningEffort: reflectionSettings.reasoningEffort,
          timeoutSeconds: reflectionSettings.timeoutSeconds,
          entries: [],
        }),
        errorMessage: "",
        updatedAt: new Date().toISOString(),
      });
    }
    this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
      sessionId: latestSession.id,
      kind: "monologue",
      status: "running",
      title: "Monologue",
      summary: options.triggerReason === "session-start"
        ? "SessionStart の独り言を生成しています。"
        : "独り言と Character Memory を整理しています。",
      details: buildBackgroundActivityMetadataLines({
        triggerReason: options.triggerReason,
        model: reflectionSettings.model,
        reasoningEffort: reflectionSettings.reasoningEffort,
        timeoutSeconds: reflectionSettings.timeoutSeconds,
      }).join("\n"),
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
        timeoutMs: reflectionSettings.timeoutSeconds * 1000,
        triggerReason: options.triggerReason,
        prompt,
      });

      if (!reflectionResult.output) {
        throw new Error("Character reflection の JSON parse に失敗したよ。");
      }

      const memoryEntries = reflectionResult.output.memoryDelta?.entries ?? [];
      const monologue = reflectionResult.output.monologue;
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
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
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(transportPayload, reflectionResult.providerQuotaTelemetry),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "characterMemoryReferenced", value: String(characterMemoryEntries.length) },
            { label: "characterMemorySaved", value: String(options.triggerReason === "session-start" ? 0 : memoryEntries.length) },
            { label: "monologueUpdated", value: monologue ? "true" : "false" },
          ],
        ),
        assistantText: reflectionResult.rawText,
        operations: [],
        rawItemsJson: reflectionResult.rawItemsJson,
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
      if (options.triggerReason !== "session-start") {
        this.deps.setSessionBackgroundActivity(latestSession.id, "character-memory-generation", {
          sessionId: latestSession.id,
          kind: "character-memory-generation",
          status: "completed",
          title: "CharacterMemory",
          summary: savedCount > 0 ? `Character Memory を更新しました: ${savedCount}件` : "更新は不要でした。",
          details: buildCharacterMemoryActivityDetails({
            triggerReason: options.triggerReason,
            model: reflectionSettings.model,
            reasoningEffort: reflectionSettings.reasoningEffort,
            timeoutSeconds: reflectionSettings.timeoutSeconds,
            entries: savedCount > 0 ? memoryEntries : [],
            monologueUpdated: !!monologue,
          }),
          errorMessage: "",
          updatedAt: new Date().toISOString(),
        });
      }
      this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
        sessionId: latestSession.id,
        kind: "monologue",
        status: "completed",
        title: "Monologue",
        summary: buildMonologueSummary(monologue),
        details: [
          ...buildBackgroundActivityMetadataLines({
            triggerReason: options.triggerReason,
            model: reflectionSettings.model,
            reasoningEffort: reflectionSettings.reasoningEffort,
            timeoutSeconds: reflectionSettings.timeoutSeconds,
          }),
          ...(savedCount > 0 ? ["", `characterMemory: ${savedCount}件更新`] : []),
        ].join("\n"),
        errorMessage: "",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
      if (options.triggerReason !== "session-start") {
        this.deps.setSessionBackgroundActivity(latestSession.id, "character-memory-generation", {
          sessionId: latestSession.id,
          kind: "character-memory-generation",
          status: isCanceledRunError(error) ? "canceled" : "failed",
          title: "CharacterMemory",
          summary: isCanceledRunError(error) ? "Character Memory 更新はキャンセルされました。" : "Character Memory 更新に失敗しました。",
          details: buildCharacterMemoryActivityDetails({
            triggerReason: options.triggerReason,
            model: reflectionSettings.model,
            reasoningEffort: reflectionSettings.reasoningEffort,
            timeoutSeconds: reflectionSettings.timeoutSeconds,
            entries: [],
          }),
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
      }
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
        transportPayload: appendTransportPayloadFields(transportPayload, [
          { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
          { label: "characterMemoryReferenced", value: String(characterMemoryEntries.length) },
        ]),
        assistantText: "",
        operations: [],
        rawItemsJson: runningAuditLog.rawItemsJson,
        usage: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.deps.setSessionBackgroundActivity(latestSession.id, "monologue", {
        sessionId: latestSession.id,
        kind: "monologue",
        status: isCanceledRunError(error) ? "canceled" : "failed",
        title: "Monologue",
        summary: isCanceledRunError(error) ? "独り言生成はキャンセルされました。" : "独り言生成に失敗しました。",
        details: buildBackgroundActivityMetadataLines({
          triggerReason: options.triggerReason,
          model: reflectionSettings.model,
          reasoningEffort: reflectionSettings.reasoningEffort,
          timeoutSeconds: reflectionSettings.timeoutSeconds,
        }).join("\n"),
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
    if (!appSettings.memoryGenerationEnabled) {
      return;
    }
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
    const triggerReason = options?.triggerReason ?? (options?.force ? "manual" : "outputTokensThreshold");
    const transportPayload = buildSessionMemoryExtractionTransportPayload(
      latestSession.provider,
      extractionSettings,
      triggerReason,
    );
    const providerAdapter = this.deps.getProviderBackgroundAdapter(latestSession.provider);
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
      details: buildSessionMemoryActivityDetails({
        triggerReason,
        model: extractionSettings.model,
        reasoningEffort: extractionSettings.reasoningEffort,
        timeoutSeconds: extractionSettings.timeoutSeconds,
        delta: null,
      }),
      errorMessage: "",
      updatedAt: new Date().toISOString(),
    });
    try {
      const extractionResult = await providerAdapter.extractSessionMemoryDelta({
        session: latestSession,
        appSettings,
        model: extractionSettings.model,
        reasoningEffort: extractionSettings.reasoningEffort,
        timeoutMs: extractionSettings.timeoutSeconds * 1000,
        prompt,
      });
      const delta = extractionResult.delta;
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
      const memoryFieldLabels = delta
        ? [
          delta.goal !== undefined ? "goal" : null,
          delta.decisions?.length ? "decisions" : null,
          delta.openQuestions?.length ? "openQuestions" : null,
          delta.nextActions?.length ? "nextActions" : null,
          delta.notes?.length ? "notes" : null,
        ].filter((value): value is string => !!value)
        : [];
      const promotedCount = delta
        ? this.deps.promoteSessionMemoryDeltaToProjectMemory(this.deps.getSession(session.id) ?? latestSession, delta)
        : 0;
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
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(transportPayload, extractionResult.providerQuotaTelemetry),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "updatedFields", value: memoryFieldLabels.join(", ") },
            { label: "projectMemoryPromotions", value: String(promotedCount) },
          ],
        ),
        assistantText: extractionResult.rawText,
        operations: [],
        rawItemsJson: extractionResult.rawItemsJson,
        usage: extractionResult.usage,
        errorMessage: "",
      });
      this.deps.setSessionBackgroundActivity(session.id, "memory-generation", {
        sessionId: session.id,
        kind: "memory-generation",
        status: "completed",
        title: "Memory生成",
        summary: memoryFieldLabels.length > 0
          ? `Session Memory を更新しました: ${memoryFieldLabels.join(", ")}`
          : "更新は不要でした。",
        details: buildSessionMemoryActivityDetails({
          triggerReason,
          model: extractionSettings.model,
          reasoningEffort: extractionSettings.reasoningEffort,
          timeoutSeconds: extractionSettings.timeoutSeconds,
          delta,
          projectMemoryPromotions: promotedCount,
        }),
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
    } catch (error) {
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
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
        transportPayload: appendTransportPayloadFields(transportPayload, [
          { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
        ]),
        assistantText: "",
        operations: [],
        rawItemsJson: runningAuditLog.rawItemsJson,
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
        details: buildSessionMemoryActivityDetails({
          triggerReason,
          model: extractionSettings.model,
          reasoningEffort: extractionSettings.reasoningEffort,
          timeoutSeconds: extractionSettings.timeoutSeconds,
          delta: null,
        }),
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
