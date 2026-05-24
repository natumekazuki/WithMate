import { randomUUID } from "node:crypto";

import { currentTimestampLabel } from "../src/time-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "../src/auxiliary-session-state.js";
import {
  coerceModelSelection,
  getModelCatalogItem,
  getProviderCatalog,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import type { AuxiliarySessionStorageAccess } from "./persistent-store-lifecycle-service.js";

type AuxiliarySessionServiceDeps = {
  getSession(sessionId: string): Session | null;
  getStorage(): AuxiliarySessionStorageAccess;
  getModelCatalogSnapshot?(): ModelCatalogSnapshot | null;
};

function buildAuxiliaryTitle(parent: Session): string {
  return parent.taskTitle.trim() || "Session";
}

function buildInterruptedMessages(messages: AuxiliarySession["messages"]): AuxiliarySession["messages"] {
  const interruptedMessage = "前回の Auxiliary 実行はアプリ終了で中断された可能性があります。必要ならもう一度送信してください。";
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage) {
    return messages;
  }

  return [
    ...messages,
    {
      role: "assistant",
      text: interruptedMessage,
      accent: true,
    },
  ];
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRuntimeMetadataInCatalog(
  session: AuxiliarySession,
  snapshot: ModelCatalogSnapshot | null | undefined,
): boolean {
  if (!snapshot || session.catalogRevision !== snapshot.revision) {
    return false;
  }

  const providerCatalog = getProviderCatalog(snapshot.providers, session.provider);
  if (!providerCatalog || providerCatalog.id !== session.provider) {
    return false;
  }

  const model = getModelCatalogItem(providerCatalog, session.model);
  return model?.reasoningEfforts.includes(session.reasoningEffort) ?? false;
}

export class AuxiliarySessionService {
  constructor(private readonly deps: AuxiliarySessionServiceDeps) {}

  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.deps.getStorage().listAuxiliarySessions(parentSessionId);
  }

  listAllAuxiliarySessions(): AuxiliarySession[] {
    return this.deps.getStorage().listAllAuxiliarySessions();
  }

  getActiveAuxiliarySession(parentSessionId: string): AuxiliarySession | null {
    return this.deps.getStorage().getActiveAuxiliarySession(parentSessionId);
  }

  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.deps.getStorage().getAuxiliarySession(auxiliarySessionId);
  }

  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[] {
    return this.deps.getStorage().listRunningActiveAuxiliarySessions();
  }

  createAuxiliarySession(input: CreateAuxiliarySessionInput): AuxiliarySession {
    const parent = this.deps.getSession(input.parentSessionId);
    if (!parent) {
      throw new Error("親セッションが見つからないよ。");
    }

    const currentActive = this.getActiveAuxiliarySession(input.parentSessionId);
    if (currentActive) {
      return currentActive;
    }

    const snapshot = this.deps.getModelCatalogSnapshot?.();
    const providerCatalog = getProviderCatalog(snapshot?.providers ?? [], input.provider);
    if (!snapshot || !providerCatalog || providerCatalog.id !== input.provider.trim()) {
      throw new Error("Auxiliary Session の Provider が model catalog に存在しないよ。");
    }
    const modelSelection = coerceModelSelection(
      providerCatalog,
      providerCatalog.defaultModelId,
      providerCatalog.defaultReasoningEffort,
    );

    const now = currentTimestampLabel();
    return this.deps.getStorage().upsertAuxiliarySession({
      id: `aux-${randomUUID()}`,
      parentSessionId: parent.id,
      status: "active",
      runState: "idle",
      title: buildAuxiliaryTitle(parent),
      provider: providerCatalog.id,
      catalogRevision: snapshot.revision,
      model: modelSelection.resolvedModel,
      reasoningEffort: modelSelection.resolvedReasoningEffort,
      approvalMode: parent.approvalMode,
      codexSandboxMode: parent.codexSandboxMode,
      customAgentName: parent.customAgentName,
      allowedAdditionalDirectories: [...parent.allowedAdditionalDirectories],
      threadId: "",
      composerDraft: "",
      messages: [],
      displayAfterMessageIndex: parent.messages.length - 1,
      createdAt: now,
      updatedAt: now,
      closedAt: "",
    });
  }

  getAuxiliaryRuntimeSession(auxiliarySessionId: string): Session | null {
    const auxiliary = this.getAuxiliarySession(auxiliarySessionId);
    if (!auxiliary) {
      return null;
    }

    return this.toRuntimeSession(auxiliary);
  }

  upsertAuxiliaryRuntimeSession(runtimeSession: Session): AuxiliarySession {
    const current = this.getAuxiliarySession(runtimeSession.id);
    if (!current) {
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    if (current.status === "closed") {
      throw new Error("Closed Auxiliary Session は更新できないよ。");
    }

    return this.deps.getStorage().upsertAuxiliarySession({
      ...current,
      runState:
        runtimeSession.runState === "running" || runtimeSession.runState === "error"
          ? runtimeSession.runState
          : "idle",
      title: current.title,
      provider: runtimeSession.provider,
      catalogRevision: runtimeSession.catalogRevision,
      model: runtimeSession.model,
      reasoningEffort: runtimeSession.reasoningEffort,
      approvalMode: runtimeSession.approvalMode,
      codexSandboxMode: runtimeSession.codexSandboxMode,
      customAgentName: runtimeSession.customAgentName,
      allowedAdditionalDirectories: [...runtimeSession.allowedAdditionalDirectories],
      threadId: runtimeSession.threadId,
      composerDraft: "",
      messages: runtimeSession.messages,
      updatedAt: runtimeSession.updatedAt,
    });
  }

  updateAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    const current = this.getAuxiliarySession(session.id);
    if (!current) {
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    if (current.status === "closed") {
      throw new Error("Closed Auxiliary Session は更新できないよ。");
    }
    if (current.runState === "running") {
      throw new Error("実行中の Auxiliary Session は更新できないよ。");
    }

    const hasStaleRuntimeThread = session.threadId !== current.threadId && current.threadId !== "";
    const isRuntimeStalePayload =
      session.runState !== current.runState ||
      hasStaleRuntimeThread ||
      session.messages.length < current.messages.length;
    if (isRuntimeStalePayload) {
      return current;
    }
    const hasRuntimeMetadataChange =
      session.provider !== current.provider ||
      session.catalogRevision !== current.catalogRevision ||
      session.model !== current.model ||
      session.reasoningEffort !== current.reasoningEffort;
    const hasComposerDraftChange = session.composerDraft !== current.composerDraft;
    const hasEditableSettingsChange =
      session.title !== current.title ||
      session.approvalMode !== current.approvalMode ||
      session.codexSandboxMode !== current.codexSandboxMode ||
      session.customAgentName !== current.customAgentName ||
      !areStringArraysEqual(session.allowedAdditionalDirectories, current.allowedAdditionalDirectories);
    const isExplicitRuntimeMetadataUpdate =
      hasRuntimeMetadataChange &&
      isRuntimeMetadataInCatalog(session, this.deps.getModelCatalogSnapshot?.());
    const shouldPreserveRuntimeMetadata =
      hasRuntimeMetadataChange &&
      (hasComposerDraftChange || !isExplicitRuntimeMetadataUpdate);
    const shouldPreserveEditableSettings = hasComposerDraftChange && hasEditableSettingsChange;
    const shouldPreserveComposerDraft =
      hasComposerDraftChange &&
      (
        hasEditableSettingsChange ||
        (hasRuntimeMetadataChange && (isExplicitRuntimeMetadataUpdate || session.catalogRevision === current.catalogRevision))
      );

    return this.deps.getStorage().upsertAuxiliarySession({
      ...current,
      title: shouldPreserveEditableSettings ? current.title : session.title,
      provider: shouldPreserveRuntimeMetadata ? current.provider : session.provider,
      catalogRevision: shouldPreserveRuntimeMetadata ? current.catalogRevision : session.catalogRevision,
      model: shouldPreserveRuntimeMetadata ? current.model : session.model,
      reasoningEffort: shouldPreserveRuntimeMetadata ? current.reasoningEffort : session.reasoningEffort,
      approvalMode: shouldPreserveEditableSettings ? current.approvalMode : session.approvalMode,
      codexSandboxMode: shouldPreserveEditableSettings ? current.codexSandboxMode : session.codexSandboxMode,
      customAgentName: shouldPreserveEditableSettings ? current.customAgentName : session.customAgentName,
      allowedAdditionalDirectories: shouldPreserveEditableSettings
        ? [...current.allowedAdditionalDirectories]
        : [...session.allowedAdditionalDirectories],
      composerDraft: shouldPreserveComposerDraft ? current.composerDraft : session.composerDraft,
      updatedAt: currentTimestampLabel(),
    });
  }

  replaceAuxiliarySessions(sessions: AuxiliarySession[]): AuxiliarySession[] {
    const storage = this.deps.getStorage();
    return sessions.map((session) => storage.upsertAuxiliarySession(session));
  }

  closeAuxiliarySession(auxiliarySessionId: string): AuxiliarySession {
    const current = this.getAuxiliarySession(auxiliarySessionId);
    if (!current) {
      throw new Error("Auxiliary Session が見つからないよ。");
    }
    if (current.runState === "running") {
      throw new Error("実行中の Auxiliary Session は終了できないよ。");
    }

    const now = currentTimestampLabel();
    return this.deps.getStorage().upsertAuxiliarySession({
      ...current,
      status: "closed",
      runState: "idle",
      composerDraft: "",
      updatedAt: now,
      closedAt: current.closedAt || now,
    });
  }

  recoverInterruptedSessions(): void {
    const runningSessions = this.listRunningActiveAuxiliarySessions();
    if (runningSessions.length === 0) {
      return;
    }

    const now = currentTimestampLabel();
    for (const summary of runningSessions) {
      const current = this.getAuxiliarySession(summary.id);
      if (!current || current.status !== "active" || current.runState !== "running") {
        continue;
      }

      this.deps.getStorage().upsertAuxiliarySession({
        ...current,
        runState: "error",
        updatedAt: now,
        messages: buildInterruptedMessages(current.messages),
      });
    }
  }

  private toRuntimeSession(auxiliary: AuxiliarySession): Session {
    const parent = this.deps.getSession(auxiliary.parentSessionId);
    if (!parent) {
      throw new Error("親セッションが見つからないよ。");
    }

    return {
      ...parent,
      id: auxiliary.id,
      taskTitle: parent.taskTitle,
      status: auxiliary.runState === "running" ? "running" : "idle",
      updatedAt: auxiliary.updatedAt,
      provider: auxiliary.provider,
      catalogRevision: auxiliary.catalogRevision,
      runState: auxiliary.runState,
      approvalMode: auxiliary.approvalMode,
      codexSandboxMode: auxiliary.codexSandboxMode,
      model: auxiliary.model,
      reasoningEffort: auxiliary.reasoningEffort,
      customAgentName: auxiliary.customAgentName,
      allowedAdditionalDirectories: [...auxiliary.allowedAdditionalDirectories],
      threadId: auxiliary.threadId,
      messages: auxiliary.messages,
      stream: [],
    };
  }
}
