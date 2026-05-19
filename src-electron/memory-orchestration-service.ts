import {
  mergeSessionMemory,
  type AuditLogEntry,
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionMemory,
  type SessionMemoryDelta,
} from "../src/app-state.js";
import {
  getProviderAppSettings,
  type AppSettings,
} from "../src/provider-settings-state.js";
import { type Session } from "../src/session-state.js";
import type { ProviderBackgroundAdapter } from "./provider-runtime.js";
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
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

export type MemoryOrchestrationServiceDeps = {
  getSession(sessionId: string): Awaitable<Session | null>;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  getAppSettings(): AppSettings;
  getProviderBackgroundAdapter(providerId: string): ProviderBackgroundAdapter;
  ensureSessionMemory(session: Session): SessionMemory;
  upsertSessionMemory(memory: SessionMemory): void;
  promoteSessionMemoryDeltaToProjectMemory(session: Session, delta: SessionMemoryDelta): number;
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, entry: CreateAuditLogInput): Awaitable<void | AuditLogEntry>;
  setSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ): void;
};

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

export class MemoryOrchestrationService {
  private readonly inFlightSessionMemoryExtractions = new Set<string>();

  constructor(private readonly deps: MemoryOrchestrationServiceDeps) {}

  reset(): void {
    this.inFlightSessionMemoryExtractions.clear();
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

    const latestSession = (await this.deps.getSession(session.id)) ?? session;
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
    const runningAuditLog = await this.deps.createAuditLog({
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
          ? this.deps.promoteSessionMemoryDeltaToProjectMemory((await this.deps.getSession(session.id)) ?? latestSession, delta)
        : 0;
      await this.deps.updateAuditLog(runningAuditLog.id, {
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

      const sessionForSave = (await this.deps.getSession(session.id)) ?? latestSession;
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
      await this.deps.updateAuditLog(runningAuditLog.id, {
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
