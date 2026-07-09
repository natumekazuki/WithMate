import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import {
  DEFAULT_CHARACTER_THEME,
  type CharacterDetail,
} from "../src/character/character-catalog.js";
import {
  type CharacterAuthoringSessionStartResult,
  type StartCharacterAuthoringSessionInput,
} from "../src/character/character-authoring.js";
import {
  DEFAULT_PROVIDER_ID,
} from "../src/model-catalog.js";
import type { CreateSessionInput, Session } from "../src/session-state.js";

export const CHARACTER_AUTHORING_SKILL_NAME = "withmate-character-authoring";
const CODEX_WORKSPACE_SKILL_ROOT = ".agents/skills";
const COPILOT_WORKSPACE_SKILL_ROOT = ".github/skills";

type CharacterAuthoringServiceDeps = {
  bundledSkillPath: string;
  createSession(input: CreateSessionInput): Promise<Session>;
  getCharacter(characterId: string): Promise<CharacterDetail | null> | CharacterDetail | null;
  getCharacterDirectory(characterId: string): string | null;
};

type AuthoringSeed = {
  name: string;
  description: string;
  definitionMarkdown: string;
  notesMarkdown: string;
};

export class CharacterAuthoringService {
  constructor(private readonly deps: CharacterAuthoringServiceDeps) {}

  async startSession(input: StartCharacterAuthoringSessionInput): Promise<CharacterAuthoringSessionStartResult> {
    const characterId = input.characterId?.trim();
    if (!characterId) {
      throw new Error("Authoring session は保存済み Character でのみ開始できます。先に Character を保存してください。");
    }

    const seed = await this.resolveSeed(input);
    const runId = this.createRunId(seed.name);
    const workspacePath = this.deps.getCharacterDirectory(characterId);
    if (!workspacePath) {
      throw new Error("Character authoring workspace を解決できませんでした。");
    }
    await this.prepareWorkspace(workspacePath, runId, input, seed);

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
      characterIconPath: input.iconFilePath ?? "",
      characterThemeColors: {
        main: input.theme?.main ?? DEFAULT_CHARACTER_THEME.main,
        sub: input.theme?.sub ?? DEFAULT_CHARACTER_THEME.sub,
      },
      approvalMode: input.approvalMode ?? DEFAULT_APPROVAL_MODE,
      codexSandboxMode: input.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      provider: input.provider ?? DEFAULT_PROVIDER_ID,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      customAgentName: "",
      allowedAdditionalDirectories: [],
    });

    return {
      session,
      workspacePath,
      runId,
    };
  }

  private async resolveSeed(input: StartCharacterAuthoringSessionInput): Promise<AuthoringSeed> {
    const character = input.characterId ? await this.deps.getCharacter(input.characterId) : null;
    const name = this.normalizeName(input.name || character?.name || "New Character");
    const description = (input.description ?? character?.description ?? "").trim();
    return {
      name,
      description,
      definitionMarkdown: input.definitionMarkdown?.trim()
        ? input.definitionMarkdown
        : character?.definitionMarkdown?.trim()
          ? character.definitionMarkdown
          : await this.readTemplate("character.md", {
              character_name: name,
              short_description: description || "作成中の相手",
            }),
      notesMarkdown: input.notesMarkdown?.trim()
        ? input.notesMarkdown
        : character?.notesMarkdown?.trim()
          ? character.notesMarkdown
          : await this.readTemplate("character-notes.md"),
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
      userInstruction: input.userInstruction?.trim() || "",
      skill: CHARACTER_AUTHORING_SKILL_NAME,
      skillPath: `${skillRootPath}/${CHARACTER_AUTHORING_SKILL_NAME}`,
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(workspacePath, "character.md"), seed.definitionMarkdown, "utf8");
    await writeFile(path.join(workspacePath, "character-notes.md"), seed.notesMarkdown, "utf8");

  }

  private buildAgentsInstructions(input: StartCharacterAuthoringSessionInput): string {
    const modeLabel = input.mode === "improve" ? "既存の character.md / character-notes.md を改善する" : "新しい character.md / character-notes.md を作成する";
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
      "- `character.md` 本文には WithMate の実装説明、prompt 注入説明、作成 workflow、notes/report の扱いを書かない。",
      "- `character.md` では相手を作り物として扱わず、一人の相手として本人らしさ、口調、距離感、反応を書く。",
      "- `character-notes.md` は調査メモ、採用理由、改稿履歴、再導入しない判断を残す場所として使う。",
      "",
      "## 初回作業",
      "",
      "- `AUTHORING_PROMPT.md` を読み、必要な追加情報がなければ成果物を更新する。",
      "- 完了時は変更したファイルと未確認事項を短く報告する。",
      "",
    ].join("\n");
  }

  private buildAuthoringPrompt(input: StartCharacterAuthoringSessionInput, seed: AuthoringSeed): string {
    const instruction = input.userInstruction?.trim();
    const skillPath = `${this.resolveWorkspaceSkillRoot(input.provider)}/${CHARACTER_AUTHORING_SKILL_NAME}`;
    return [
      `# ${seed.name} Character Authoring`,
      "",
      `Mode: ${input.mode}`,
      "",
      "## Goal",
      "",
      "WithMate V5 用の `character.md` と `character-notes.md` を、person-first の runtime definition として整える。",
      "",
      "## Constraints",
      "",
      `- Skill は ${CHARACTER_AUTHORING_SKILL_NAME} に固定する。`,
      `- Skill 配置は \`${skillPath}\`。`,
      "- Grow From Conversations は扱わない。",
      "- session / companion history は入力にしない。",
      "- `character.md` はユーザーに見える返答へ効く振る舞いだけを書く。",
      "- `character-notes.md` に根拠、解釈、改稿理由、再導入しない判断を残す。",
      "",
      instruction ? "## User Instruction" : "",
      instruction ? "" : "",
      instruction || "",
      "",
    ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
  }

  private async readTemplate(templateName: string, replacements: Record<string, string> = {}): Promise<string> {
    const templatePath = path.join(this.deps.bundledSkillPath, "templates", templateName);
    let contents = await readFile(templatePath, "utf8");
    for (const [key, value] of Object.entries(replacements)) {
      contents = contents.replaceAll(`{${key}}`, value);
    }
    return contents;
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

  private resolveWorkspaceSkillRoot(providerId: string | null | undefined): string {
    return providerId === "copilot" ? COPILOT_WORKSPACE_SKILL_ROOT : CODEX_WORKSPACE_SKILL_ROOT;
  }
}
