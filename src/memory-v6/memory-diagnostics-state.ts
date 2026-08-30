export type MemoryV6RuntimeDiagnostics = {
  status: "running" | "stopped" | "failed";
  applicationInstanceId: string | null;
  runtimeGenerationId: string | null;
  buildChannel: "installed" | "development" | "visual-check" | "unknown" | null;
  discoveryPublished: boolean;
};

export type MemoryV6SkillSyncDiagnostics = {
  providerId: string;
  skillRootConfigured: boolean;
  status:
    | "installed"
    | "updated"
    | "unchanged"
    | "skipped-unpackaged"
    | "skipped-unconfigured"
    | "skipped-collision"
    | "failed"
    | "not-run";
};

export type MemoryV6CliShimDiagnostics = {
  platform: NodeJS.Platform;
  commandName: "withmate-memory";
  supported: boolean;
  status:
    | "managed-by-installer"
    | "installed"
    | "installed-path-missing"
    | "not-installed"
    | "stale"
    | "blocked-existing"
    | "unsupported"
    | "failed";
  pathContainsShimDirectory: boolean;
};

export type MemoryV6DiagnosticEvent = {
  kind: string;
  occurredAt: string;
  discoveryCode?: "WITHMATE_RUNTIME_REGISTRY_CAPACITY";
};

export type MemoryV6Diagnostics = {
  generatedAt: string;
  runtime: MemoryV6RuntimeDiagnostics;
  providers: Array<{
    providerId: string;
    providerSupported: boolean;
  }>;
  skillSync: MemoryV6SkillSyncDiagnostics[];
  cliShim: MemoryV6CliShimDiagnostics;
  lastErrors: MemoryV6DiagnosticEvent[];
};
