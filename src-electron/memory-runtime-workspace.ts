import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
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

export type MemoryRuntimeWorkspaceStatus = "running" | "completed" | "failed";

export type MemoryRuntimeRunMetadata = {
  runId: string;
  createdAt: number;
  heartbeatAt: number;
  status: MemoryRuntimeWorkspaceStatus;
};

export type MemoryRuntimeCleanupRunsOptions = {
  staleHeartbeatMs?: number;
  nowMs?: number;
};

export class MemoryRuntimeWorkspaceService {
  private readonly workspacePath: string;
  private readonly lockPath: string;
  private readonly runsRootPath: string;
  private readonly quarantinePath: string;
  private readonly templateRootPath: string | undefined;
  private activeWorkspacePath: string | null = null;
  private activeRunId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatGeneration = 0;
  private heartbeatInFlight: Promise<void> | null = null;

  constructor(deps: MemoryRuntimeWorkspaceServiceDeps) {
    const userDataRoot = path.resolve(deps.userDataPath);
    this.workspacePath = path.join(userDataRoot, "memory-runtime", "current");
    this.lockPath = path.join(this.workspacePath, ".lock");
    this.runsRootPath = path.join(userDataRoot, "memory-runtime", "runs");
    this.quarantinePath = path.join(userDataRoot, "memory-runtime", "quarantine");
    this.templateRootPath = deps.templateRootPath ? path.resolve(deps.templateRootPath) : undefined;
  }

  getWorkspacePath(): string {
    return this.activeWorkspacePath ?? this.workspacePath;
  }

  getCurrentWorkspacePath(): string {
    return this.activeWorkspacePath ?? this.workspacePath;
  }

  async prepareRun(): Promise<{ workspacePath: string; lockPath: string }> {
    if (await this.isLockPresent()) {
      await this.cleanupStaleRuns();
      if (await this.isLockPresent()) {
        throw new Error("Memory runtime workspace is already in use");
      }
    }

    const runId = this.createRunId();
    const runWorkspacePath = path.join(this.runsRootPath, runId);
    const runLockPath = path.join(runWorkspacePath, ".lock");
    const now = Date.now();
    const metadata = this.buildRunMetadata(runId, now, now, "running");

    await mkdir(this.workspacePath, { recursive: true });
    await mkdir(this.runsRootPath, { recursive: true });
    await mkdir(runWorkspacePath, { recursive: true });

    try {
      await this.acquireLockForPath(this.lockPath, metadata);
      await this.acquireLockForPath(runLockPath, metadata);
      await this.writeWorkspaceStatus(runWorkspacePath, metadata);
      await this.copyTemplateFiles(runWorkspacePath);
      await this.resetCurrentWorkspaceMirror();
      await this.copyTemplateFiles(this.workspacePath);
      this.activeWorkspacePath = runWorkspacePath;
      this.activeRunId = runId;
      return {
        workspacePath: runWorkspacePath,
        lockPath: runLockPath,
      };
    } catch (error) {
      await this.forceReleaseLock(runLockPath);
      await this.releaseCurrentLockIfRunMatches(runId);
      await rm(runWorkspacePath, { recursive: true, force: true });
      if (this.activeWorkspacePath === runWorkspacePath) {
        this.activeWorkspacePath = null;
        this.activeRunId = null;
      }
      throw error;
    }
  }

  prepareCurrentRun(): Promise<{ workspacePath: string; lockPath: string }> {
    return this.prepareRun();
  }

  async acquireLock(options: MemoryRuntimeWorkspaceLockOptions = {}): Promise<void> {
    await this.acquireLockForPath(this.lockPath, null, options);
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
    await this.stopHeartbeatTimer();
    if (this.activeWorkspacePath && this.activeRunId) {
      const currentMetadata = await this.readWorkspaceStatus(this.activeWorkspacePath);
      await this.writeWorkspaceStatus(
        this.activeWorkspacePath,
        this.buildRunMetadata(
          this.activeRunId,
          currentMetadata?.createdAt ?? Date.now(),
          Date.now(),
          "completed",
        ),
      );
    }
    await this.releaseLock();
    this.activeWorkspacePath = null;
    this.activeRunId = null;
  }

  async failRun(_errorPreview?: string): Promise<void> {
    await this.stopHeartbeatTimer();

    if (!this.activeWorkspacePath || !this.activeRunId) {
      this.activeWorkspacePath = null;
      this.activeRunId = null;
      return;
    }

    const currentMetadata = await this.readWorkspaceStatus(this.activeWorkspacePath);
    const metadata = this.buildRunMetadata(
      this.activeRunId,
      currentMetadata?.createdAt ?? Date.now(),
      Date.now(),
      "failed",
    );
    await this.writeWorkspaceStatus(this.activeWorkspacePath, metadata);
    await this.releaseLock();
  }

  startHeartbeat(intervalMs: number = 30_000): () => Promise<void> {
    if (!this.activeWorkspacePath || !this.activeRunId) {
      return () => Promise.resolve();
    }

    const interval = Number.isFinite(intervalMs) ? intervalMs : 30_000;
    this.stopHeartbeatTimerWithoutDrain();
    const heartbeatGeneration = this.heartbeatGeneration;

    const heartbeatTimer = setInterval(() => {
      if (this.heartbeatGeneration !== heartbeatGeneration || this.heartbeatInFlight) {
        return;
      }
      const heartbeat = this.touchHeartbeat().catch(() => {}).finally(() => {
        if (this.heartbeatInFlight === heartbeat) {
          this.heartbeatInFlight = null;
        }
      });
      this.heartbeatInFlight = heartbeat;
    }, interval);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
    this.heartbeatTimer = heartbeatTimer;

    return () => this.stopHeartbeatTimer();
  }

  async touchHeartbeat(): Promise<void> {
    if (!this.activeWorkspacePath || !this.activeRunId) {
      throw new Error("アクティブな memory runtime workspace がありません");
    }

    const currentMetadata = await this.readWorkspaceStatus(this.activeWorkspacePath);
    const now = Date.now();
    const metadata = this.buildRunMetadata(
      this.activeRunId,
      currentMetadata?.createdAt ?? now,
      now,
      "running",
    );
    const activeLockPath = this.getLockPath(this.activeWorkspacePath);

    await Promise.all([
      this.writeWorkspaceStatus(this.activeWorkspacePath, metadata),
      writeFile(activeLockPath, JSON.stringify(metadata), { flag: "w" }),
      writeFile(this.lockPath, JSON.stringify(metadata), { flag: "w" }),
    ]);
  }

  async cleanupStaleRuns(options: MemoryRuntimeCleanupRunsOptions = {}): Promise<void> {
    const staleHeartbeatMs = options.staleHeartbeatMs ?? 60_000;
    const now = options.nowMs ?? Date.now();

    await mkdir(this.runsRootPath, { recursive: true });
    await mkdir(this.quarantinePath, { recursive: true });

    const entries = await readdir(this.runsRootPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runWorkspacePath = path.join(this.runsRootPath, entry.name);
      const lockPath = this.getLockPath(runWorkspacePath);
      const hasLock = await this.pathExists(lockPath);
      const statusMetadata = await this.readWorkspaceStatus(runWorkspacePath);
      const lockMetadata = hasLock ? await this.readRunMetadataFromLock(lockPath) : null;
      const legacyLockMetadata = await this.readRunMetadataFromLock(this.lockPath);
      const activeMetadata = this.resolveCleanupRunMetadata(statusMetadata, lockMetadata);

      if (this.activeWorkspacePath === runWorkspacePath && activeMetadata?.status === "running") {
        continue;
      }

      if (hasLock && activeMetadata?.status === "running") {
        const heartbeatAt = activeMetadata.heartbeatAt;
        if (Number.isFinite(heartbeatAt) && now - heartbeatAt > staleHeartbeatMs) {
          const quarantineRunPath = path.join(this.quarantinePath, entry.name);
          await rm(quarantineRunPath, { recursive: true, force: true });
          await rename(runWorkspacePath, quarantineRunPath);
          await this.writeWorkspaceStatus(quarantineRunPath, this.buildRunMetadata(
            entry.name,
            activeMetadata.createdAt,
            now,
            "failed",
          ));
          if (legacyLockMetadata?.runId === entry.name) {
            await this.forceReleaseLock(this.lockPath);
          }
          if (this.activeWorkspacePath === runWorkspacePath) {
            this.activeWorkspacePath = null;
            this.activeRunId = null;
          }
        }
        continue;
      }

      if (
        activeMetadata?.status === "completed"
        || activeMetadata?.status === "failed"
      ) {
        if (legacyLockMetadata?.runId === entry.name) {
          await this.forceReleaseLock(this.lockPath);
        }
        await rm(runWorkspacePath, { recursive: true, force: true });
        if (this.activeWorkspacePath === runWorkspacePath) {
          this.activeWorkspacePath = null;
          this.activeRunId = null;
        }
      }
    }
  }

  async releaseLock(): Promise<void> {
    await this.stopHeartbeatTimer();
    if (this.activeWorkspacePath) {
      await this.forceReleaseLock(this.getLockPath(this.activeWorkspacePath));
    }
    await this.forceReleaseLock(this.lockPath);
    this.activeWorkspacePath = null;
    this.activeRunId = null;
  }

  private resolveCleanupRunMetadata(
    statusMetadata: MemoryRuntimeRunMetadata | null,
    lockMetadata: MemoryRuntimeRunMetadata | null,
  ): MemoryRuntimeRunMetadata | null {
    if (statusMetadata?.status === "completed" || statusMetadata?.status === "failed") {
      return statusMetadata;
    }

    return lockMetadata ?? statusMetadata;
  }

  async resetWorkspace(): Promise<void> {
    await rm(this.workspacePath, { recursive: true, force: true });
    await mkdir(this.workspacePath, { recursive: true });
  }

  async regenerateTemplateInstructionFiles(
    files: ReadonlyArray<MemoryRuntimeInstructionFile>,
  ): Promise<void> {
    const targetWorkspacePath = this.activeWorkspacePath ?? this.workspacePath;

    await Promise.all(
      files.map(async ({ relativePath, content }) => {
        const instructionPath = this.resolveInstructionFilePath(targetWorkspacePath, relativePath);
        await mkdir(path.dirname(instructionPath), { recursive: true });
        await writeFile(instructionPath, content);

        if (this.activeWorkspacePath !== null && this.activeWorkspacePath !== this.workspacePath) {
          const legacyPath = this.resolveInstructionFilePath(this.workspacePath, relativePath);
          await mkdir(path.dirname(legacyPath), { recursive: true });
          await writeFile(legacyPath, content);
        }
      }),
    );
  }

  private stopHeartbeatTimerWithoutDrain(): void {
    this.heartbeatGeneration += 1;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async stopHeartbeatTimer(): Promise<void> {
    this.stopHeartbeatTimerWithoutDrain();
    const heartbeatInFlight = this.heartbeatInFlight;
    if (heartbeatInFlight) {
      await heartbeatInFlight;
    }
  }

  private async acquireLockForPath(
    lockPath: string,
    metadataSeed: MemoryRuntimeRunMetadata | null,
    options: MemoryRuntimeWorkspaceLockOptions = {},
  ): Promise<void> {
    const staleLockMs = options.staleLockMs;
    await mkdir(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    const metadata = metadataSeed ?? this.buildRunMetadata(
      this.activeRunId ?? "legacy",
      now,
      now,
      "running",
    );

    while (true) {
      try {
        await writeFile(lockPath, JSON.stringify(metadata), { flag: "wx" });
        return;
      } catch (error) {
        const errnoError = error as NodeJS.ErrnoException | undefined;
        if (errnoError?.code !== "EEXIST") {
          throw error;
        }

        if (staleLockMs == null) {
          throw new Error("Memory runtime workspace is already in use");
        }

        const staleAt = await this.readLockTimestampMs(lockPath);
        if (staleAt == null) {
          throw new Error("Memory runtime workspace is already in use");
        }

        if (Date.now() - staleAt < staleLockMs) {
          throw new Error("Memory runtime workspace is already in use");
        }

        await this.forceReleaseLock(lockPath);
      }
    }
  }

  private async readLockTimestampMs(lockPath: string): Promise<number | null> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const metadata = this.parseRunMetadata(raw);
      if (metadata) {
        return metadata.heartbeatAt;
      }

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
    if (await this.pathExists(this.lockPath)) {
      return true;
    }

    if (this.activeWorkspacePath) {
      const activeLockPath = this.getLockPath(this.activeWorkspacePath);
      return await this.pathExists(activeLockPath);
    }

    return this.hasAnyRunLock();
  }

  private async forceReleaseLock(lockPath: string): Promise<void> {
    await rm(lockPath, { force: true });
  }

  private async releaseCurrentLockIfRunMatches(runId: string): Promise<void> {
    const currentLockMetadata = await this.readRunMetadataFromLock(this.lockPath);
    if (currentLockMetadata?.runId === runId) {
      await this.forceReleaseLock(this.lockPath);
    }
  }

  private async copyTemplateFiles(destinationPath: string): Promise<void> {
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
        cp(path.join(templateRootPath, entry.name), path.join(destinationPath, entry.name), {
          recursive: true,
        }),
      ),
    );
  }

  private async resetCurrentWorkspaceMirror(): Promise<void> {
    await mkdir(this.workspacePath, { recursive: true });
    const entries = await readdir(this.workspacePath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name !== ".lock")
        .map((entry) => rm(path.join(this.workspacePath, entry.name), { recursive: true, force: true })),
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

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async hasAnyRunLock(): Promise<boolean> {
    try {
      const entries = await readdir(this.runsRootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (await this.pathExists(this.getLockPath(path.join(this.runsRootPath, entry.name)))) {
          return true;
        }
      }
      return false;
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async writeWorkspaceStatus(workspacePath: string, metadata: MemoryRuntimeRunMetadata): Promise<void> {
    await writeFile(path.join(workspacePath, ".status"), JSON.stringify(metadata), { flag: "w" });
    const lockPath = this.getLockPath(workspacePath);
    if (await this.pathExists(lockPath)) {
      await writeFile(lockPath, JSON.stringify(metadata), { flag: "w" });
    }
  }

  private async readWorkspaceStatus(workspacePath: string): Promise<MemoryRuntimeRunMetadata | null> {
    try {
      const raw = await readFile(path.join(workspacePath, ".status"), "utf8");
      return this.parseRunMetadata(raw);
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readRunMetadataFromLock(lockPath: string): Promise<MemoryRuntimeRunMetadata | null> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const parsed = this.parseRunMetadata(raw);
      if (parsed) {
        return parsed;
      }
      return this.parseLegacyLockMetadata(raw, lockPath);
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private parseRunMetadata(raw: string): MemoryRuntimeRunMetadata | null {
    try {
      const parsed = JSON.parse(raw.trim());
      if (
        parsed !== null
        && typeof parsed === "object"
        && typeof parsed.runId === "string"
        && Number.isFinite(parsed.createdAt)
        && Number.isFinite(parsed.heartbeatAt)
        && (parsed.status === "running" || parsed.status === "completed" || parsed.status === "failed")
      ) {
        return {
          runId: parsed.runId,
          createdAt: parsed.createdAt,
          heartbeatAt: parsed.heartbeatAt,
          status: parsed.status,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseLegacyLockMetadata(
    raw: string,
    lockPath: string,
  ): MemoryRuntimeRunMetadata | null {
    const timestamp = Number(raw.trim());
    if (!Number.isFinite(timestamp)) {
      return null;
    }

    return this.buildRunMetadata(
      path.basename(path.dirname(lockPath)),
      timestamp,
      timestamp,
      "running",
    );
  }

  private buildRunMetadata(
    runId: string,
    createdAt: number,
    heartbeatAt: number,
    status: MemoryRuntimeWorkspaceStatus,
  ): MemoryRuntimeRunMetadata {
    return {
      runId,
      createdAt,
      heartbeatAt,
      status,
    };
  }

  private createRunId(): string {
    return `${Date.now()}-${randomBytes(8).toString("hex")}`;
  }

  private getLockPath(workspacePath: string): string {
    return path.join(workspacePath, ".lock");
  }

  private resolveInstructionFilePath(
    workspacePath: string,
    relativePath: string,
  ): string {
    const trimmed = relativePath.trim();
    if (!trimmed || trimmed === ".") {
      throw new Error(`relativePath は相対パスを指定してください: ${relativePath}`);
    }
    if (path.isAbsolute(trimmed)) {
      throw new Error(`relativePath は相対パスを指定してください: ${relativePath}`);
    }

    const resolvedWorkspacePath = path.resolve(workspacePath);
    const destinationPath = path.resolve(workspacePath, trimmed);
    const relativeToWorkspace = path.relative(resolvedWorkspacePath, destinationPath);

    if (
      relativeToWorkspace.startsWith(`..${path.sep}`)
      || relativeToWorkspace === ".."
      || path.isAbsolute(relativeToWorkspace)
    ) {
      throw new Error(`Path traversal が検出されました: ${relativePath}`);
    }

    return destinationPath;
  }
}
