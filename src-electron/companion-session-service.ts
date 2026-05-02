import path from "node:path";
import { randomUUID } from "node:crypto";

import { currentTimestampLabel } from "../src/time-state.js";
import {
  type CompanionGroup,
  type CompanionSession,
  type CompanionSessionSummary,
  type CreateCompanionSessionInput,
} from "../src/companion-state.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";
import type { CompanionStorage } from "./companion-storage.js";
import {
  buildCompanionGroupDisplayName,
  cleanupCompanionWorkspaceArtifacts,
  createCompanionWorkspace,
  type CompanionWorkspaceArtifacts,
  resolveCompanionGitEligibility,
} from "./companion-git.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

export type CompanionSessionServiceDeps = {
  appDataPath: string;
  storage: {
    listSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    listActiveSessionSummaries(): Awaitable<CompanionSessionSummary[]>;
    ensureGroup(group: CompanionGroup): Awaitable<CompanionGroup>;
    createSession(session: CompanionSession): Awaitable<CompanionSession>;
  };
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

export class CompanionSessionService {
  constructor(private readonly deps: CompanionSessionServiceDeps) {}

  async listSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.storage.listSessionSummaries();
  }

  async listActiveSessionSummaries(): Promise<CompanionSessionSummary[]> {
    return await this.deps.storage.listActiveSessionSummaries();
  }

  async createSession(input: CreateCompanionSessionInput): Promise<CompanionSession> {
    const taskTitle = input.taskTitle.trim();
    if (!taskTitle) {
      throw new Error("Companion のタイトルを入力してね。");
    }

    const eligibility = await resolveCompanionGitEligibility(input.workspacePath);
    if (!eligibility.ok) {
      throw new Error(eligibility.reason);
    }

    const now = currentTimestampLabel();
    const groupId = `companion-group-${randomUUID()}`;
    const sessionId = `companion-session-${randomUUID()}`;
    const safeSessionId = safeId(sessionId);
    const group: CompanionGroup = {
      id: groupId,
      repoRoot: eligibility.repoRoot,
      displayName: buildCompanionGroupDisplayName(eligibility.repoRoot),
      createdAt: now,
      updatedAt: now,
    };
    const storedGroup = await this.deps.storage.ensureGroup(group);
    const worktreePath = path.join(
      this.deps.appDataPath,
      "cw",
      safeSessionId.replace(/^companion-session-/, "cs-"),
    );
    let artifacts: CompanionWorkspaceArtifacts | null = null;
    try {
      artifacts = await createCompanionWorkspace({
        repoRoot: eligibility.repoRoot,
        sessionId,
        safeSessionId,
        companionBranch: `withmate/companion/${safeSessionId}`,
        worktreePath,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error("Companion worktree の作成に失敗したよ。");
    }

    const session: CompanionSession = {
      id: sessionId,
      groupId: storedGroup.id,
      taskTitle,
      status: "active",
      repoRoot: eligibility.repoRoot,
      focusPath: eligibility.focusPath,
      targetBranch: eligibility.targetBranch,
      baseSnapshotRef: artifacts.baseSnapshotRef,
      baseSnapshotCommit: artifacts.baseSnapshotCommit,
      companionBranch: artifacts.companionBranch,
      worktreePath: artifacts.worktreePath,
      selectedPaths: [],
      changedFiles: [],
      siblingWarnings: [],
      allowedAdditionalDirectories: [],
      runState: "idle",
      threadId: "",
      provider: input.provider,
      catalogRevision: input.catalogRevision ?? DEFAULT_CATALOG_REVISION,
      model: input.model ?? DEFAULT_MODEL_ID,
      reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      customAgentName: input.customAgentName ?? "",
      approvalMode: input.approvalMode,
      codexSandboxMode: input.codexSandboxMode,
      characterId: input.characterId,
      character: input.character,
      characterRoleMarkdown: input.characterRoleMarkdown,
      characterIconPath: input.characterIconPath,
      characterThemeColors: input.characterThemeColors,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    try {
      return await this.deps.storage.createSession(session);
    } catch (error) {
      await cleanupCompanionWorkspaceArtifacts(artifacts);
      throw error;
    }
  }
}
