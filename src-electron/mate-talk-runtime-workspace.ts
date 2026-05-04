import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type MateTalkRuntimeWorkspaceServiceDeps = {
  userDataPath: string;
};

export type MateTalkRuntimeInstructionFile = {
  relativePath: string;
  content: string;
};

export type MateTalkProfileInstructionInput = {
  id: string;
  displayName: string;
  description: string;
  contextText?: string;
};

export type MateTalkRuntimeWorkspaceLockOptions = {
  staleLockMs?: number;
};

const MATE_TALK_RUNTIME_AGENTS = [
  "# AGENTS",
  "- この workspace はメイトーク会話生成専用です。",
  "- ファイル編集、ファイル作成、ファイル削除を行わないでください。",
  "- 外部操作（ファイル以外のコマンド実行・ネットワーク通信・ブラウザー起動など）は行わないでください。",
  "- 応答は JSON structured output のみ返してください。",
  "- 参照対象はこの workspace 配下のみです。",
].join("\n");

const ABSOLUTE_PATH_TOKEN_PATTERN = /(?:[A-Za-z]:\\[^\s"'\`]+|[A-Za-z]:\/[^\s"'\`]+|\/[^\s"'\`]+(?:\/[^\s"'\`]+)+)/g;
const DEFAULT_STALE_LOCK_MS = 10 * 60_000;

function removeAbsolutePaths(value: string): string {
  return value.replace(ABSOLUTE_PATH_TOKEN_PATTERN, "[path omitted]");
}

export function sanitizeMateTalkProfileContextText(contextText: string | undefined): string | null {
  const trimmed = contextText?.trim();
  if (!trimmed) {
    return null;
  }

  const safeLines = trimmed
    .split(/\r?\n/)
    .map((line) => removeAbsolutePaths(line.trim()))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const joined = safeLines.join("\n");
  return joined.length > 0 ? joined : null;
}

export function buildMateTalkRuntimeInstructionFiles(
  input: MateTalkProfileInstructionInput,
): readonly MateTalkRuntimeInstructionFile[] {
  const contextText = sanitizeMateTalkProfileContextText(input.contextText);

  const mateProfile = [
    "# Mate Profile",
    `id: ${input.id || "(no id)"}`,
    `name: ${input.displayName || "(no name)"}`,
    `description: ${input.description || "(no description)"}`,
    ...(contextText ? ["", "## Context", contextText] : []),
  ].join("\n");

  return [
    {
      relativePath: "AGENTS.md",
      content: MATE_TALK_RUNTIME_AGENTS,
    },
    {
      relativePath: "mate-profile.md",
      content: mateProfile,
    },
  ];
}

export class MateTalkRuntimeWorkspaceService {
  private readonly workspacePath: string;
  private readonly lockPath: string;
  private readonly runtimeRootPath: string;

  constructor(deps: MateTalkRuntimeWorkspaceServiceDeps) {
    const userDataRoot = path.resolve(deps.userDataPath);
    this.runtimeRootPath = path.join(userDataRoot, "mate-talk-runtime");
    this.workspacePath = path.join(this.runtimeRootPath, "current");
    this.lockPath = path.join(this.runtimeRootPath, ".lock");
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCurrentWorkspacePath(): string {
    return this.workspacePath;
  }

  async prepareRun(
    options: MateTalkRuntimeWorkspaceLockOptions = {},
  ): Promise<{ workspacePath: string; lockPath: string }> {
    await this.acquireLock({
      ...options,
      staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
    });
    try {
      await this.resetWorkspace();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }

    return {
      workspacePath: this.workspacePath,
      lockPath: this.lockPath,
    };
  }

  prepareCurrentRun(
    options: MateTalkRuntimeWorkspaceLockOptions = {},
  ): Promise<{ workspacePath: string; lockPath: string }> {
    return this.prepareRun(options);
  }

  async acquireLock(options: MateTalkRuntimeWorkspaceLockOptions = {}): Promise<void> {
    const staleLockMs = options.staleLockMs;
    await mkdir(this.runtimeRootPath, { recursive: true });

    while (true) {
      try {
        await writeFile(this.lockPath, `${Date.now()}`, { flag: "wx" });
        return;
      } catch (error) {
        const errnoError = error as NodeJS.ErrnoException | undefined;
        if (errnoError?.code !== "EEXIST") {
          throw error;
        }

        if (staleLockMs == null) {
          throw new Error("MateTalk runtime workspace is already in use");
        }

        const staleAt = await this.readLockTimestampMs();
        if (staleAt == null) {
          throw new Error("MateTalk runtime workspace is already in use");
        }

        if (Date.now() - staleAt < staleLockMs) {
          throw new Error("MateTalk runtime workspace is already in use");
        }

        await rm(this.lockPath, { force: true });
      }
    }
  }

  async withLock<T>(
    operation: () => Promise<T> | T,
    options: MateTalkRuntimeWorkspaceLockOptions = {},
  ): Promise<T> {
    await this.acquireLock(options);
    try {
      return await operation();
    } finally {
      await this.releaseLock();
    }
  }

  async completeRun(): Promise<void> {
    await this.releaseLock();
  }

  async releaseLock(): Promise<void> {
    await rm(this.lockPath, { force: true });
  }

  async resetWorkspace(): Promise<void> {
    await rm(this.workspacePath, { recursive: true, force: true });
    await mkdir(this.workspacePath, { recursive: true });
  }

  async regenerateInstructionFiles(
    files: ReadonlyArray<MateTalkRuntimeInstructionFile>,
  ): Promise<void> {
    await Promise.all(
      files.map(async ({ relativePath, content }) => {
        const instructionPath = this.resolveInstructionFilePath(relativePath);
        await mkdir(path.dirname(instructionPath), { recursive: true });
        await writeFile(instructionPath, content);
      }),
    );
  }

  private async readLockTimestampMs(): Promise<number | null> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const timestamp = Number(raw.trim());
      if (!Number.isFinite(timestamp)) {
        return null;
      }
      return timestamp;
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException | undefined;
      if (errnoError?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private resolveInstructionFilePath(relativePath: string): string {
    const trimmed = relativePath.trim();
    if (!trimmed || trimmed === ".") {
      throw new Error(`relativePath は相対パスを指定してください: ${relativePath}`);
    }
    if (path.isAbsolute(trimmed)) {
      throw new Error(`relativePath は相対パスを指定してください: ${relativePath}`);
    }

    const resolvedWorkspacePath = path.resolve(this.workspacePath);
    const destinationPath = path.resolve(this.workspacePath, trimmed);
    const relativeToWorkspace = path.relative(resolvedWorkspacePath, destinationPath);

    if (relativeToWorkspace.startsWith(`..${path.sep}`) || relativeToWorkspace === ".." || path.isAbsolute(relativeToWorkspace)) {
      throw new Error(`Path traversal が検出されました: ${relativePath}`);
    }

    return destinationPath;
  }
}
