import {
  access,
  cp,
  readFile,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type MemoryRuntimeWorkspaceServiceDeps = {
  userDataPath: string;
  templateRootPath?: string;
};

export type MemoryRuntimeInstructionFile = {
  relativePath: string;
  content: string;
};

export type MemoryRuntimeWorkspaceLockOptions = {
  staleLockMs?: number;
};

export class MemoryRuntimeWorkspaceService {
  private readonly workspacePath: string;
  private readonly lockPath: string;
  private readonly templateRootPath: string | undefined;

  constructor(deps: MemoryRuntimeWorkspaceServiceDeps) {
    const userDataRoot = path.resolve(deps.userDataPath);
    this.workspacePath = path.join(userDataRoot, "memory-runtime", "current");
    this.lockPath = path.join(this.workspacePath, ".lock");
    this.templateRootPath = deps.templateRootPath ? path.resolve(deps.templateRootPath) : undefined;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getCurrentWorkspacePath(): string {
    return this.workspacePath;
  }

  async prepareRun(): Promise<{ workspacePath: string; lockPath: string }> {
    if (await this.isLockPresent()) {
      throw new Error("Memory runtime workspace is already in use");
    }

    await this.resetWorkspace();
    await this.copyTemplateFiles();
    await this.acquireLock();

    return {
      workspacePath: this.workspacePath,
      lockPath: this.lockPath,
    };
  }

  prepareCurrentRun(): Promise<{ workspacePath: string; lockPath: string }> {
    return this.prepareRun();
  }

  async acquireLock(options: MemoryRuntimeWorkspaceLockOptions = {}): Promise<void> {
    const staleLockMs = options.staleLockMs;
    await mkdir(this.workspacePath, { recursive: true });

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
          throw new Error("Memory runtime workspace is already in use");
        }

        const staleAt = await this.readLockTimestampMs();
        if (staleAt == null) {
          throw new Error("Memory runtime workspace is already in use");
        }

        if (Date.now() - staleAt < staleLockMs) {
          throw new Error("Memory runtime workspace is already in use");
        }

        await rm(this.lockPath, { force: true });
      }
    }
  }

  async withLock<T>(
    operation: () => Promise<T> | T,
    options: MemoryRuntimeWorkspaceLockOptions = {},
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

  async regenerateTemplateInstructionFiles(
    files: ReadonlyArray<MemoryRuntimeInstructionFile>,
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

  private async isLockPresent(): Promise<boolean> {
    try {
      await access(this.lockPath);
      return true;
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async copyTemplateFiles(): Promise<void> {
    const templateRootPath = this.templateRootPath;
    if (!templateRootPath) {
      return;
    }

    if (!(await this.templateRootExists(templateRootPath))) {
      return;
    }

    const entries = await readdir(templateRootPath, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) =>
        cp(path.join(templateRootPath, entry.name), path.join(this.workspacePath, entry.name), {
          recursive: true,
        }),
      ),
    );
  }

  private async templateRootExists(templateRootPath: string): Promise<boolean> {
    try {
      await access(templateRootPath);
      return true;
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return false;
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
