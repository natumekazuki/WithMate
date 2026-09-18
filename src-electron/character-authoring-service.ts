import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
  getSessionStorageIdentity(): object;
  readBundledSkillFiles?: typeof readBundledCharacterAuthoringSkillFiles;
  resolveProvider(providerId: string): string;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
};

type AuthoringSeed = {
  name: string;
  description: string;
};

export type PreparedWorkspaceFile = {
  relativePath: string;
  content: Buffer;
};

type PreparedAuthoringSession = {
  input: StartCharacterAuthoringSessionInput & { provider: string; characterId: string };
  character: CharacterDetail;
  seed: AuthoringSeed;
  runId: string;
  workspacePath: string;
  storageIdentity: object;
  workspaceFiles: PreparedWorkspaceFile[];
};

export async function readBundledCharacterAuthoringSkillFiles(rootPath: string): Promise<PreparedWorkspaceFile[]> {
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Character authoring Skill bundle は通常のディレクトリである必要があります。");
  }
  const files: PreparedWorkspaceFile[] = [];
  const visit = async (currentPath: string, relativeRoot: string): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Character authoring Skill に symlink は配置できません: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(entryPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Character authoring Skill に通常ファイル以外の項目があります: ${relativePath}`);
      }
      files.push({ relativePath, content: await readFile(entryPath) });
    }
  };
  await visit(rootPath, "");
  return files;
}

export class CharacterAuthoringService {
  constructor(private readonly deps: CharacterAuthoringServiceDeps) {}

  async startSession(input: StartCharacterAuthoringSessionInput): Promise<CharacterAuthoringSessionStartResult> {
    const prepared = await this.prepareSession(input);
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.startSessionExclusive(prepared),
    );
  }

  private async prepareSession(input: StartCharacterAuthoringSessionInput): Promise<PreparedAuthoringSession> {
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
    const storageIdentity = this.deps.getSessionStorageIdentity();

    const character = await this.deps.getCharacter(characterId);
    if (!character) {
      throw new Error("Authoring session は保存済み Character でのみ開始できます。先に Character を保存してください。");
    }
    if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
      throw new Error("Character authoring の準備中に Session storage が切り替わりました。もう一度お試しください。");
    }

    const capturedCharacter = this.cloneCharacter(character);
    const seed = this.resolveSeed(character);
    const runId = this.createRunId(seed.name);
    const workspacePath = this.deps.getCharacterDirectory(characterId);
    if (!workspacePath) {
      throw new Error("Character authoring workspace を解決できませんでした。");
    }
    const workspaceFiles = await this.prepareWorkspaceFiles(normalizedInput, seed, runId);
    return {
      input: normalizedInput,
      character: capturedCharacter,
      seed,
      runId,
      workspacePath,
      storageIdentity,
      workspaceFiles,
    };
  }

  private async startSessionExclusive(
    prepared: PreparedAuthoringSession,
  ): Promise<CharacterAuthoringSessionStartResult> {
    const { input, seed, runId, workspacePath } = prepared;
    await this.assertPreparedSessionCurrent(prepared);
    await this.writePreparedWorkspace(workspacePath, input.provider, prepared.workspaceFiles);
    await this.assertPreparedSessionCurrent(prepared);

    const session = await this.deps.createSession({
      taskTitle: input.mode === "improve"
        ? `${seed.name} の character.md 改善`
        : `${seed.name} の character.md 作成`,
      workspaceLabel: `${seed.name} authoring`,
      workspacePath,
      branch: "main",
      sessionKind: "character-authoring",
      characterId: input.characterId,
      character: seed.name,
      characterIconPath: prepared.character.iconFilePath,
      characterThemeColors: { ...prepared.character.theme },
      approvalMode: input.approvalMode ?? DEFAULT_APPROVAL_MODE,
      codexSandboxMode: input.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE,
      provider: input.provider,
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

  private resolveSeed(character: CharacterDetail): AuthoringSeed {
    const name = this.normalizeName(character.name || "New Character");
    const description = character.description.trim();
    return {
      name,
      description,
    };
  }

  private async prepareWorkspaceFiles(
    input: StartCharacterAuthoringSessionInput,
    seed: AuthoringSeed,
    runId: string,
  ): Promise<PreparedWorkspaceFile[]> {
    const skillRootPath = this.resolveWorkspaceSkillRoot(input.provider);
    const readSkillFiles = this.deps.readBundledSkillFiles ?? readBundledCharacterAuthoringSkillFiles;
    const bundledFiles = await readSkillFiles(this.deps.bundledSkillPath);
    return [
      ...bundledFiles.map((file) => ({
        relativePath: path.join(skillRootPath, CHARACTER_AUTHORING_SKILL_NAME, file.relativePath),
        content: file.content,
      })),
      { relativePath: "AGENTS.md", content: Buffer.from(this.buildAgentsInstructions(input), "utf8") },
      { relativePath: "AUTHORING_PROMPT.md", content: Buffer.from(this.buildAuthoringPrompt(input, seed), "utf8") },
      {
        relativePath: "input.json",
        content: Buffer.from(`${JSON.stringify({
          runId,
          mode: input.mode,
          characterId: input.characterId ?? null,
          name: seed.name,
          description: seed.description,
          skill: CHARACTER_AUTHORING_SKILL_NAME,
          skillPath: `${skillRootPath}/${CHARACTER_AUTHORING_SKILL_NAME}`,
        }, null, 2)}\n`, "utf8"),
      },
    ];
  }

  private async writePreparedWorkspace(
    workspacePath: string,
    provider: string,
    files: PreparedWorkspaceFile[],
  ): Promise<void> {
    const skillRootPath = this.resolveWorkspaceSkillRoot(provider);
    await mkdir(workspacePath, { recursive: true });
    await rm(path.join(workspacePath, skillRootPath, CHARACTER_AUTHORING_SKILL_NAME), { recursive: true, force: true });
    for (const file of files) {
      const destination = path.join(workspacePath, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
  }

  private async assertPreparedSessionCurrent(prepared: PreparedAuthoringSession): Promise<void> {
    if (this.deps.getSessionStorageIdentity() !== prepared.storageIdentity) {
      throw new Error("Character authoring の準備中に Session storage が切り替わりました。もう一度お試しください。");
    }
    const provider = this.deps.resolveProvider(prepared.input.provider);
    if (provider !== prepared.input.provider) {
      throw new Error("Character authoring provider を一意に解決できませんでした。");
    }
    const currentCharacter = await this.deps.getCharacter(prepared.input.characterId);
    if (this.deps.getSessionStorageIdentity() !== prepared.storageIdentity) {
      throw new Error("Character authoring の準備中に Session storage が切り替わりました。もう一度お試しください。");
    }
    if (!currentCharacter || !isDeepStrictEqual(this.cloneCharacter(currentCharacter), prepared.character)) {
      throw new Error("Character authoring の準備中に Character が変更されました。もう一度お試しください。");
    }
    if (this.deps.getCharacterDirectory(prepared.input.characterId) !== prepared.workspacePath) {
      throw new Error("Character authoring workspace が変更されました。もう一度お試しください。");
    }
  }

  private cloneCharacter(character: CharacterDetail): CharacterDetail {
    return { ...character, theme: { ...character.theme } };
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
      "- 編集対象はこの workspace 内の `character.md` / `character-notes.md` に限定する。詳細な authoring / validation 契約は固定 Skill と参照資料に従う。",
      "- authoring session の開始処理は Character files を書き換えない。保存済みの現在内容を正本として読む。",
      "",
      "## 初回作業",
      "",
      "- `AUTHORING_PROMPT.md`、`input.json`、固定 Skill と参照資料を読む。",
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
      "WithMate 用の `character.md` と、必要な場合の `character-notes.md` を整える。詳細な作成・検証手順は固定 Skill と参照資料に従う。",
      "",
      "## Constraints",
      "",
      `- Skill は ${CHARACTER_AUTHORING_SKILL_NAME} に固定する。`,
      `- Skill 配置は \`${skillPath}\`。`,
      "- 改善内容はこの Session の通常メッセージで受け取る。",
      "- `character.md` / `character-notes.md` 以外の成果物や Character directory 外の変更は、固定 Skill の boundary に従って作らない。",
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
