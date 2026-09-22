import type {
  MemoryForgetReason,
  MemoryV6ReviewSearchRequest,
} from "../../src-shared/memory/memory-contract.js";
import type {
  MemoryV6DiagnosticEvent,
  MemoryV6Diagnostics,
} from "../../src-shared/memory/memory-diagnostics-state.js";
import { projectMemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import type {
  MemoryV6ProtectedObjectGcRequest,
  MemoryV6ReviewForgetResult,
  MemoryV6ReviewSearchResult,
  MemoryV6ProtectedObjectGcResponse,
  MemoryV6ReviewEntryDetail,
} from "../../src-shared/memory/memory-review-state.js";
import type { MemoryFileUsageResponse } from "../../src-shared/memory/memory-response-contract.js";
import { MemoryCliShimService } from "./memory-cli-shim-service.js";
import {
  exportMemoryProtectedObjectFile,
  exportMemoryProtectedObjectFiles,
} from "./memory-protected-object-exporter.js";
import {
  MemoryProtectedObjectKeyStore,
  type MemoryProtectedObjectKeyProtector,
} from "./memory-protected-object-key-store.js";
import { MemoryProtectedObjectStore } from "./memory-protected-object-store.js";
import { MemoryV6ReviewService } from "./memory-v6-review-service.js";
import type { MemoryV6RuntimeApiHandle } from "./memory-v6-runtime.js";

export type MemoryV6MainAssemblyDeps = {
  getRuntime(): MemoryV6RuntimeApiHandle | null;
  getRuntimeStatus(): MemoryV6Diagnostics["runtime"]["status"];
  getCliShimService(): MemoryCliShimService;
  getDiagnosticErrors(): readonly MemoryV6DiagnosticEvent[];
  userDataPath: string;
  protectedObjectKeyProtector: MemoryProtectedObjectKeyProtector;
  getMemoryFileQuotaBytes(): number | Promise<number>;
};

/** Main-process composition boundary for Memory review and diagnostics operations. */
export class MemoryV6MainAssembly {
  constructor(private readonly deps: MemoryV6MainAssemblyDeps) {}

  async getDiagnostics(): Promise<MemoryV6Diagnostics> {
    const cliShimDiagnostics = await this.deps.getCliShimService().getDiagnostics();
    const runtime = this.deps.getRuntime();
    return projectMemoryV6Diagnostics({
      generatedAt: new Date().toISOString(),
      runtime: {
        status: runtime ? "running" : this.deps.getRuntimeStatus(),
        applicationInstanceId: runtime?.applicationInstanceId ?? null,
        runtimeGenerationId: runtime?.runtimeGenerationId ?? null,
        buildChannel: runtime?.buildChannel ?? null,
        discoveryPublished: Boolean(runtime),
      },
      cliShim: {
        platform: cliShimDiagnostics.platform,
        commandName: cliShimDiagnostics.commandName,
        supported: cliShimDiagnostics.supported,
        status: cliShimDiagnostics.status,
        pathContainsShimDirectory: cliShimDiagnostics.pathContainsShimDirectory,
      },
      lastErrors: [...this.deps.getDiagnosticErrors()],
    });
  }

  async installCliShim(): Promise<MemoryV6Diagnostics> {
    await this.deps.getCliShimService().install();
    return this.getDiagnostics();
  }

  async uninstallCliShim(): Promise<MemoryV6Diagnostics> {
    await this.deps.getCliShimService().uninstall();
    return this.getDiagnostics();
  }

  getFileUsage(): Promise<MemoryFileUsageResponse> {
    return this.createReviewService().getFileUsage();
  }

  async exportEntryFiles(entryId: string, outputDirectoryPath: string) {
    return this.createReviewService().exportEntryFiles(entryId, outputDirectoryPath);
  }

  runProtectedObjectGc(
    request: MemoryV6ProtectedObjectGcRequest,
  ): Promise<MemoryV6ProtectedObjectGcResponse> {
    return this.createReviewService().runProtectedObjectGc(request);
  }

  searchEntries(
    request: MemoryV6ReviewSearchRequest | null | undefined,
  ): Promise<MemoryV6ReviewSearchResult> {
    return this.createReviewService().searchEntries(request);
  }

  getEntry(entryId: string): Promise<MemoryV6ReviewEntryDetail | null> {
    return this.createReviewService().getEntry(entryId);
  }

  forgetEntry(
    entryId: string,
    reason?: MemoryForgetReason | null,
  ): Promise<MemoryV6ReviewForgetResult> {
    return this.createReviewService().forgetEntry(entryId, reason);
  }

  private createReviewService(): MemoryV6ReviewService {
    const runtime = this.deps.getRuntime();
    if (!runtime) {
      throw new Error("Memory is unavailable because the Memory V6 runtime is not available.");
    }
    const protectedObjectStore = MemoryProtectedObjectStore.fromUserDataPath(this.deps.userDataPath);
    const protectedObjectKeyStore = MemoryProtectedObjectKeyStore.fromUserDataPath(
      this.deps.userDataPath,
      this.deps.protectedObjectKeyProtector,
    );
    return new MemoryV6ReviewService({
      resolveDbPath: () => runtime.dbPath,
      storage: runtime.memoryStorage,
      getMemoryFileQuotaBytes: () => this.deps.getMemoryFileQuotaBytes(),
      protectedObjectStore,
      protectedObjectExporter: {
        exportFile: (input) => exportMemoryProtectedObjectFile({
          keyStore: protectedObjectKeyStore,
          objectStore: protectedObjectStore,
        }, input),
        exportFiles: (input) => exportMemoryProtectedObjectFiles({
          keyStore: protectedObjectKeyStore,
          objectStore: protectedObjectStore,
        }, input),
      },
    });
  }
}
