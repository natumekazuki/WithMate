import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import type {
  CharacterDetail,
  CharacterRuntimeSnapshot,
} from "../src/character/character-catalog.js";
import {
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
} from "../src/character/character-owner.js";
import {
  type CharacterAuthoringSessionStartResult,
  type StartCharacterAuthoringSessionInput,
} from "../src/character/character-authoring.js";
import type { CreateSessionInput, Session } from "../src/session-state.js";
import type { RunProviderRuntimeOperationExclusive } from "./provider-runtime-operation-coordinator.js";

export const CHARACTER_AUTHORING_SKILL_NAME = "withmate-character-authoring";
const CODEX_WORKSPACE_SKILL_ROOT = ".agents/skills";
const COPILOT_WORKSPACE_SKILL_ROOT = ".github/skills";

export function resolveCharacterAuthoringRuntimeSessionForTurn(
  session: Session,
  createRuntimeSnapshot: (characterId: string) => CharacterRuntimeSnapshot | null,
): Session {
  if (session.sessionKind !== "character-authoring") {
    return session;
  }

  const snapshot = createRuntimeSnapshot(session.characterId);
  if (!snapshot) {
    return session.characterRuntimeSnapshot
      ? { ...session, characterRuntimeSnapshot: null }
      : session;
  }

  return {
    ...session,
    character: snapshot.name,
    characterIconPath: snapshot.iconFilePath,
    characterThemeColors: snapshot.theme,
    characterRuntimeSnapshot: snapshot,
  };
}

type CharacterAuthoringServiceDeps = {
  bundledSkillPath: string;
  createSession(input: Omit<CreateSessionInput, "id">): Promise<Session>;
  getCharacter(characterId: string): Promise<CharacterDetail | null> | CharacterDetail | null;
  getCharacterDirectory(characterId: string): string | null;
  resolveProvider(providerId: string): string;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
};

type AuthoringSeed = {
  name: string;
  description: string;
};

export class CharacterAuthoringService {
  constructor(private readonly deps: CharacterAuthoringServiceDeps) {}

  async startSession(input: StartCharacterAuthoringSessionInput): Promise<CharacterAuthoringSessionStartResult> {
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.startSessionExclusive(input),
    );
  }

  private async startSessionExclusive(
    input: StartCharacterAuthoringSessionInput,
  ): Promise<CharacterAuthoringSessionStartResult> {
    if (input.mode !== "create" && input.mode !== "improve") {
      throw new Error("Character authoring mode が正しくありません。");
    }
    const requestedProvider = input.provider?.trim();
    if (!requestedProvider) {
      throw new Error("Authoring session を開始する provider を選択してください。");
    }
    const provider = this.deps.resolveProvider(requestedProvider);
    if (provider !== requestedProvider) {
      throw new Error("Character authoring provider を一意に解決できませんでした。");
    }
    const characterId = normalizeCharacterOwnerId(input.characterId);
    if (!characterId || isUnknownCharacterOwnerId(characterId)) {
      throw new Error("Authoring session は保存済み Character でのみ開始できます。先に Character を保存してください。");
    }
    const normalizedInput = { ...input, provider, characterId };

    const character = await this.deps.getCharacter(characterId);
    if (!character) {
      throw new Error("Authoring session は保存済み Character でのみ開始できます。先に Character を保存してください。");
    }

    const seed = this.resolveSeed(character);
    const runId = this.createRunId(seed.name);
    const workspacePath = this.deps.getCharacterDirectory(characterId);
    if (!workspacePath) {
      throw new Error("Character authoring workspace を解決できませんでした。");
    }
    await this.prepareWorkspace(workspacePath, runId, normalizedInput, seed);

    const session = await this.deps.createSession({
      taskTitle: input.mode === "improve"
        ? `${seed.name} の character.md 改善`
        : `${seed.name} の character.md 作成`,
      workspaceLabel: `${seed.name} authoring`,
      workspacePath,
      branch: "main",
      sessionKind: "character-authoring",
      characterId,
      character: seed.name,
      characterIconPath: character.iconFilePath,
      characterThemeColors: { ...character.theme },
      approvalMode: input.approvalMode ?? DEFAULT_APPROVAL_MODE,
      codexSandboxMode: input.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      provider,
      model: normalizedInput.model,
      reasoningEffort: normalizedInput.reasoningEffort,
      customAgentName: "",
      allowedAdditionalDirectories: [],
    });

    return {
      session,
      workspacePath,
      runId,
    };
  }

  private resolveSeed(character: CharacterDetail): AuthoringSeed {
    const name = this.normalizeName(character.name || "New Character");
    const description = character.description.trim();
    return {
      name,
      description,
    };
  }

  private async prepareWorkspace(
    workspacePath: string,
    runId: string,
    input: StartCharacterAuthoringSessionInput,
    seed: AuthoringSeed,
  ): Promise<void> {
    await mkdir(workspacePath, { recursive: true });
    const skillRootPath = this.resolveWorkspaceSkillRoot(input.provider);
    const workspaceSkillPath = path.join(workspacePath, skillRootPath, CHARACTER_AUTHORING_SKILL_NAME);
    await rm(workspaceSkillPath, { recursive: true, force: true });
    await cp(this.deps.bundledSkillPath, workspaceSkillPath, {
      recursive: true,
    });

    await writeFile(path.join(workspacePath, "AGENTS.md"), this.buildAgentsInstructions(input), "utf8");
    await writeFile(path.join(workspacePath, "AUTHORING_PROMPT.md"), this.buildAuthoringPrompt(input, seed), "utf8");
    await writeFile(path.join(workspacePath, "input.json"), `${JSON.stringify({
      runId,
      mode: input.mode,
      characterId: input.characterId ?? null,
      name: seed.name,
      description: seed.description,
      skill: CHARACTER_AUTHORING_SKILL_NAME,
      skillPath: `${skillRootPath}/${CHARACTER_AUTHORING_SKILL_NAME}`,
    }, null, 2)}\n`, "utf8");
  }

  private buildAgentsInstructions(input: StartCharacterAuthoringSessionInput): string {
    const modeLabel = input.mode === "improve"
      ? "既存の character.md と、必要な場合の character-notes.md を改善する"
      : "新しい character.md と、必要な場合の character-notes.md を作成する";
    const skillPath = `${this.resolveWorkspaceSkillRoot(input.provider)}/${CHARACTER_AUTHORING_SKILL_NAME}`;
    return [
      "# Character Authoring Workspace",
      "",
      `この workspace は WithMate の Character authoring run です。目的は ${modeLabel} ことです。`,
      "",
      "## 固定ルール",
      "",
      `- 必ず ${CHARACTER_AUTHORING_SKILL_NAME} Skill を使う。`,
      `- Skill は \`${skillPath}\` に配置されている。`,
      "- Skill picker や agent picker で別 Skill / 別 agent を選ぶ前提にしない。",
      "- 会話履歴からの自動成長や companion/session history の取り込みは行わない。",
      "- 編集対象はこの workspace 内の `character.md` / `character-notes.md` に限定する。",
      "- authoring session の開始処理は Character files を書き換えない。保存済みの現在内容を正本として読む。",
      "- `character.md` 本文には WithMate の実装説明、prompt 注入説明、作成 workflow、notes/report の扱いを書かない。",
      "- `character.md` では相手を作り物として扱わず、一人の相手として本人らしさ、口調、距離感、反応を書く。",
      "- `character-notes.md` を使う場合は、調査メモ、採用理由、改稿履歴、再導入しない判断を残す。",
      "",
      "## 初回作業",
      "",
      "- `AUTHORING_PROMPT.md` と固定 Skill の参照資料を読む。",
      "- 改善指示は通常の Session composer から自然言語で受け取る。起動入力に別の改善指示がある前提にしない。",
      "- 完了時は変更したファイルと未確認事項を短く報告する。",
      "",
    ].join("\n");
  }

  private buildAuthoringPrompt(input: StartCharacterAuthoringSessionInput, seed: AuthoringSeed): string {
    const skillPath = `${this.resolveWorkspaceSkillRoot(input.provider)}/${CHARACTER_AUTHORING_SKILL_NAME}`;
    return [
      `# ${seed.name} Character Authoring`,
      "",
      `Mode: ${input.mode}`,
      "",
      "## Goal",
      "",
      "WithMate 用の `character.md` と、必要な場合の `character-notes.md` を person-first の runtime definition として整える。",
      "",
      "## Constraints",
      "",
      `- Skill は ${CHARACTER_AUTHORING_SKILL_NAME} に固定する。`,
      `- Skill 配置は \`${skillPath}\`。`,
      "- Grow From Conversations は扱わない。",
      "- session / companion history は入力にしない。",
      "- 改善内容はこの Session の通常メッセージで受け取る。",
      "- source 調査と `character-notes.md` の作成・更新要否は、固定 Skill の mode 判定に従う。",
      "- `character.md` はユーザーに見える返答へ効く振る舞いだけを書く。",
      "- `character-notes.md` を使う場合は、根拠、解釈、改稿理由、再導入しない判断を残す。",
      "- Character root に source report、review checklist、manifest、Zip などの追加成果物を作らない。",
      "",
    ].join("\n");
  }

  private createRunId(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "character";
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Character name は空にできないよ。");
    }
    return normalized;
  }

  private resolveWorkspaceSkillRoot(providerId: string): string {
    return providerId === "copilot" ? COPILOT_WORKSPACE_SKILL_ROOT : CODEX_WORKSPACE_SKILL_ROOT;
  }
}
