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
import { buildCompanionGroupDisplayName, resolveCompanionGitEligibility } from "./companion-git.js";

export type CompanionSessionServiceDeps = {
  appDataPath: string;
  storage: CompanionStorage;
};

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

export class CompanionSessionService {
  constructor(private readonly deps: CompanionSessionServiceDeps) {}

  listSessionSummaries(): CompanionSessionSummary[] {
    return this.deps.storage.listSessionSummaries();
  }

  listActiveSessionSummaries(): CompanionSessionSummary[] {
    return this.deps.storage.listActiveSessionSummaries();
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
    const safeGroupId = safeId(groupId);
    const safeSessionId = safeId(sessionId);
    const group: CompanionGroup = {
      id: groupId,
      repoRoot: eligibility.repoRoot,
      displayName: buildCompanionGroupDisplayName(eligibility.repoRoot),
      createdAt: now,
      updatedAt: now,
    };
    const storedGroup = this.deps.storage.ensureGroup(group);
    const worktreePath = path.join(this.deps.appDataPath, "companion-worktrees", safeGroupId, safeSessionId);
    const session: CompanionSession = {
      id: sessionId,
      groupId: storedGroup.id,
      taskTitle,
      status: "active",
      repoRoot: eligibility.repoRoot,
      focusPath: eligibility.focusPath,
      targetBranch: eligibility.targetBranch,
      companionBranch: `withmate/companion/${safeSessionId}`,
      worktreePath,
      provider: input.provider,
      catalogRevision: input.catalogRevision ?? DEFAULT_CATALOG_REVISION,
      model: input.model ?? DEFAULT_MODEL_ID,
      reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      customAgentName: input.customAgentName ?? "",
      approvalMode: input.approvalMode,
      codexSandboxMode: input.codexSandboxMode,
      characterId: input.characterId,
      character: input.character,
      characterIconPath: input.characterIconPath,
      characterThemeColors: input.characterThemeColors,
      createdAt: now,
      updatedAt: now,
    };

    return this.deps.storage.createSession(session);
  }
}

