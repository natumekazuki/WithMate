import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { getDefaultApprovalModeForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import type {
  CharacterDetail,
  CharacterRuntimeSnapshot,
} from "../../src-shared/character/character-catalog.js";
import {
  isUnknownCharacterOwnerId,
  normalizeCharacterOwnerId,
} from "../../src-shared/character/character-owner.js";
import {
  type CharacterAuthoringSessionStartResult,
  type StartCharacterAuthoringSessionInput,
} from "../../src-shared/character/character-authoring.js";
import type {
  CreateSessionInput,
  Session,
} from "../../src-shared/session/session-state.js";
import type { RunCharacterWorkspaceOperationExclusive } from "./character-workspace-operation-coordinator.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** 作成用 Session のワークスペースへ同梱する固定 Skill の名前。 */
export const CHARACTER_AUTHORING_SKILL_NAME = "withmate-character-authoring";
const CODEX_WORKSPACE_SKILL_ROOT = ".agents/skills";
const COPILOT_WORKSPACE_SKILL_ROOT = ".github/skills";
const CLAUDE_WORKSPACE_SKILL_ROOT = ".claude/skills";
const OPENCODE_WORKSPACE_SKILL_ROOT = ".opencode/skills";

/** 作成用 Session のターンだけ、現在の Character を使って実行時の表示と定義を更新する。取得できなければ古い定義を外す。 */
export async function resolveCharacterAuthoringRuntimeSessionForTurn(
  session: Session,
  createRuntimeSnapshot: (
    characterId: string,
  ) => Awaitable<CharacterRuntimeSnapshot | null>,
): Promise<Session> {
  if (session.sessionKind !== "character-authoring") {
    return session;
  }

  const snapshot = await createRuntimeSnapshot(session.characterId);
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

/** 作成用ワークスペースの資材、対象 Character の照合、Session 起動をつなぐ依存関係。 */
type CharacterAuthoringServiceDeps = {
  bundledSkillPath: string;
  /** 準備済みのワークスペースと実行設定で新しい作成用 Session を保存する。 */
  createSession(input: Omit<CreateSessionInput, "id">): Promise<Session>;
  /** Character の詳細を読み、準備後も同じ保存内容か比較する。 */
  getCharacter(
    characterId: string,
  ): Promise<CharacterDetail | null> | CharacterDetail | null;
  /** 対象 Character の作成用ワークスペースとして使うディレクトリを解決する。 */
  getCharacterDirectory(
    characterId: string,
  ): Promise<string | null> | string | null;
  /** 準備の途中で Session の保存先が置き換わっていないか照合するための識別値。 */
  getSessionStorageIdentity(): object;
  readBundledSkillFiles?: typeof readBundledCharacterAuthoringSkillFiles;
  /** 要求したプロバイダーが既定値への代用なしに解決できるか確認する。 */
  resolveProvider(providerId: string): Promise<string> | string;
  runCharacterWorkspaceOperationExclusive: RunCharacterWorkspaceOperationExclusive;
  writePreparedWorkspace?: (
    workspacePath: string,
    provider: string,
    files: PreparedWorkspaceFile[],
  ) => Promise<void>;
};

/** 初回の作成指示に含める、保存済みの Character 名と説明。 */
type AuthoringSeed = {
  name: string;
  description: string;
};

/** ワークスペースを準備する際に書き出す相対パスと内容の組。 */
export type PreparedWorkspaceFile = {
  relativePath: string;
  content: Buffer;
};

/** 排他処理に渡す正規化済み入力と、準備後に照合する Character・保存世代・作業資材。 */
type PreparedAuthoringSession = {
  input: StartCharacterAuthoringSessionInput & {
    provider: string;
    characterId: string;
  };
  character: CharacterDetail;
  seed: AuthoringSeed;
  runId: string;
  workspacePath: string;
  storageIdentity: object;
  workspaceFiles: PreparedWorkspaceFile[];
};

/** 同梱 Skill の通常ファイルを相対パスとバイト列で読み取る。ルートや配下のリンクは許可しない。 */
export async function readBundledCharacterAuthoringSkillFiles(
  rootPath: string,
): Promise<PreparedWorkspaceFile[]> {
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      "The Character authoring Skill bundle must be a regular directory.",
    );
  }
  const files: PreparedWorkspaceFile[] = [];
  /** ディレクトリを再帰的に走査し、通常ファイルだけを同梱資材として取り込む。 */
  const visit = async (
    currentPath: string,
    relativeRoot: string,
  ): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? path.join(relativeRoot, entry.name)
        : entry.name;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Character authoring Skill cannot contain symlinks: ${relativePath}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(entryPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Character authoring Skill contains a non-regular file: ${relativePath}`,
        );
      }
      files.push({ relativePath, content: await readFile(entryPath) });
    }
  };
  await visit(rootPath, "");
  return files;
}

/** 保存済み Character の作成または改稿を、固定 Skill を備えた専用 Session として開始する。 */
export class CharacterAuthoringService {
  /** 保存データとプロバイダー照合、同梱資材、ワークスペース操作の接続を受け取る。 */
  constructor(private readonly deps: CharacterAuthoringServiceDeps) {}

  /** 資材を先に準備し、同じ Character の操作と直列化した区間で再照合してから配置・起動する。 */
  async startSession(
    input: StartCharacterAuthoringSessionInput,
  ): Promise<CharacterAuthoringSessionStartResult> {
    const prepared = await this.prepareSession(input);
    return this.deps.runCharacterWorkspaceOperationExclusive(
      prepared.input.characterId,
      async () => {
        await this.assertPreparedSessionCurrent(prepared);
        await (this.deps.writePreparedWorkspace
          ? this.deps.writePreparedWorkspace(
              prepared.workspacePath,
              prepared.input.provider,
              prepared.workspaceFiles,
            )
          : this.writePreparedWorkspace(
              prepared.workspacePath,
              prepared.input.provider,
              prepared.workspaceFiles,
            ));
        await this.assertPreparedSessionCurrent(prepared);
        return this.createSessionAfterPreparation(prepared);
      },
    );
  }

  /** モード・プロバイダーと保存済み Character を検証し、作業領域と必要なファイルを計算する。 */
  private async prepareSession(
    input: StartCharacterAuthoringSessionInput,
  ): Promise<PreparedAuthoringSession> {
    if (input.mode !== "create" && input.mode !== "improve") {
      throw new Error("Character authoring mode is invalid.");
    }
    const requestedProvider = input.provider?.trim();
    if (!requestedProvider) {
      throw new Error("Select a provider to start the authoring session.");
    }
    const provider = await this.deps.resolveProvider(requestedProvider);
    if (provider !== requestedProvider) {
      throw new Error(
        "The Character authoring provider could not be resolved uniquely.",
      );
    }
    const characterId = normalizeCharacterOwnerId(input.characterId);
    if (!characterId || isUnknownCharacterOwnerId(characterId)) {
      throw new Error(
        "An authoring session can start only for a saved Character. Save the Character first.",
      );
    }
    const normalizedInput = { ...input, provider, characterId };
    const storageIdentity = this.deps.getSessionStorageIdentity();

    const character = await this.deps.getCharacter(characterId);
    if (!character) {
      throw new Error(
        "An authoring session can start only for a saved Character. Save the Character first.",
      );
    }
    if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
      throw new Error(
        "Session storage changed while preparing Character authoring. Try again.",
      );
    }

    const capturedCharacter = this.cloneCharacter(character);
    const seed = this.resolveSeed(character);
    const runId = this.createRunId(seed.name);
    const workspacePath = await this.deps.getCharacterDirectory(characterId);
    if (!workspacePath) {
      throw new Error(
        "The Character authoring workspace could not be resolved.",
      );
    }
    const workspaceFiles = await this.prepareWorkspaceFiles(
      normalizedInput,
      seed,
      runId,
    );
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

  /** 資材を配置したワークスペースを使い、指定のプロバイダー・モデルで作成用 Session を保存する。 */
  private async createSessionAfterPreparation(
    prepared: PreparedAuthoringSession,
  ): Promise<CharacterAuthoringSessionStartResult> {
    const { input, seed, runId, workspacePath } = prepared;

    const session = await this.deps.createSession({
      taskTitle:
        input.mode === "improve"
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
      approvalMode:
        input.approvalMode ?? getDefaultApprovalModeForProvider(input.provider),
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

  /** 保存済みの名前を初回指示用に正規化し、説明の前後の空白を取り除く。 */
  private resolveSeed(character: CharacterDetail): AuthoringSeed {
    const name = this.normalizeName(character.name || "New Character");
    const description = character.description.trim();
    return {
      name,
      description,
    };
  }

  /** 保存済みの定義ファイルは含めず、固定 Skill と初回作業用の指示・入力ファイルだけを準備する。 */
  private async prepareWorkspaceFiles(
    input: StartCharacterAuthoringSessionInput,
    seed: AuthoringSeed,
    runId: string,
  ): Promise<PreparedWorkspaceFile[]> {
    const skillRootPath = this.resolveWorkspaceSkillRoot(input.provider);
    const readSkillFiles =
      this.deps.readBundledSkillFiles ??
      readBundledCharacterAuthoringSkillFiles;
    const bundledFiles = await readSkillFiles(this.deps.bundledSkillPath);
    return [
      ...bundledFiles.map((file) => ({
        relativePath: path.join(
          skillRootPath,
          CHARACTER_AUTHORING_SKILL_NAME,
          file.relativePath,
        ),
        content: file.content,
      })),
      {
        relativePath: "AGENTS.md",
        content: Buffer.from(this.buildAgentsInstructions(input), "utf8"),
      },
      {
        relativePath: "AUTHORING_PROMPT.md",
        content: Buffer.from(this.buildAuthoringPrompt(input, seed), "utf8"),
      },
      {
        relativePath: "input.json",
        content: Buffer.from(
          `${JSON.stringify(
            {
              runId,
              mode: input.mode,
              characterId: input.characterId ?? null,
              name: seed.name,
              description: seed.description,
              skill: CHARACTER_AUTHORING_SKILL_NAME,
              skillPath: `${skillRootPath}/${CHARACTER_AUTHORING_SKILL_NAME}`,
            },
            null,
            2,
          )}\n`,
          "utf8",
        ),
      },
    ];
  }

  /** 対象プロバイダー用の固定 Skill を入れ替え、準備済みファイルを作業領域へ書き出す。 */
  private async writePreparedWorkspace(
    workspacePath: string,
    provider: string,
    files: PreparedWorkspaceFile[],
  ): Promise<void> {
    const skillRootPath = this.resolveWorkspaceSkillRoot(provider);
    await mkdir(workspacePath, { recursive: true });
    await rm(
      path.join(workspacePath, skillRootPath, CHARACTER_AUTHORING_SKILL_NAME),
      { recursive: true, force: true },
    );
    for (const file of files) {
      const destination = path.join(workspacePath, file.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content);
    }
  }

  /** 準備時の保存世代、明示プロバイダー、Character の内容とディレクトリが今も一致するか確認する。 */
  private async assertPreparedSessionCurrent(
    prepared: PreparedAuthoringSession,
  ): Promise<void> {
    if (this.deps.getSessionStorageIdentity() !== prepared.storageIdentity) {
      throw new Error(
        "Session storage changed while preparing Character authoring. Try again.",
      );
    }
    const provider = await this.deps.resolveProvider(prepared.input.provider);
    if (provider !== prepared.input.provider) {
      throw new Error(
        "The Character authoring provider could not be resolved uniquely.",
      );
    }
    const currentCharacter = await this.deps.getCharacter(
      prepared.input.characterId,
    );
    if (this.deps.getSessionStorageIdentity() !== prepared.storageIdentity) {
      throw new Error(
        "Session storage changed while preparing Character authoring. Try again.",
      );
    }
    if (
      !currentCharacter ||
      !isDeepStrictEqual(
        this.cloneCharacter(currentCharacter),
        prepared.character,
      )
    ) {
      throw new Error(
        "The Character changed while preparing Character authoring. Try again.",
      );
    }
    if (
      (await this.deps.getCharacterDirectory(prepared.input.characterId)) !==
      prepared.workspacePath
    ) {
      throw new Error("The Character authoring workspace changed. Try again.");
    }
  }

  /** 準備時に取得した Character とテーマをコピーし、後続の照合値を保持する。 */
  private cloneCharacter(character: CharacterDetail): CharacterDetail {
    return { ...character, theme: { ...character.theme } };
  }

  /** ワークスペースの AGENTS.md に使う、モードと編集境界・固定 Skill の指示を組み立てる。 */
  private buildAgentsInstructions(
    input: StartCharacterAuthoringSessionInput,
  ): string {
    const modeLabel =
      input.mode === "improve"
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

  /** Character の名前と作業モードを使い、初回に読む作業指示の本文を組み立てる。 */
  private buildAuthoringPrompt(
    input: StartCharacterAuthoringSessionInput,
    seed: AuthoringSeed,
  ): string {
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

  /** 実行を区別する時刻と UUID の一部を、短い名前のスラッグと組み合わせる。 */
  private createRunId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "character";
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** 作成指示に使う名前の前後の空白を取り除き、空の結果は拒否する。 */
  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Character name cannot be empty.");
    }
    return normalized;
  }

  /** 明示されたプロバイダーのワークスペースで Skill を探索するルートを選ぶ。 */
  private resolveWorkspaceSkillRoot(providerId: string): string {
    if (providerId === "claude") return CLAUDE_WORKSPACE_SKILL_ROOT;
    if (providerId === "opencode") return OPENCODE_WORKSPACE_SKILL_ROOT;
    return providerId === "copilot"
      ? COPILOT_WORKSPACE_SKILL_ROOT
      : CODEX_WORKSPACE_SKILL_ROOT;
  }
}
