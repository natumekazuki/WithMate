export type MemoryV6RuntimeDiagnostics = {
  status: "running" | "stopped" | "failed";
  baseUrl: string | null;
  dbPath: string | null;
  discoveryFilePath: string | null;
  hasApiSecret: boolean;
};

export type MemoryV6BindingDiagnostics = {
  activeBindingCount: number;
};

export type MemoryV6ProviderBindingDiagnostics = {
  providerId: string;
  providerSupported: boolean;
  memoryBindingTransport: "env" | "context_file" | "unsupported";
};

export type MemoryV6SkillSyncDiagnostics = {
  providerId: string;
  skillRootConfigured: boolean;
  skillPath: string | null;
  status:
    | "installed"
    | "updated"
    | "unchanged"
    | "skipped-unconfigured"
    | "skipped-collision"
    | "failed"
    | "not-run";
  errorMessage?: string;
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
  shimDirectory: string | null;
  shimPath: string | null;
  pathContainsShimDirectory: boolean;
  message: string;
};

export type MemoryV6DiagnosticEvent = {
  kind: string;
  message: string;
  occurredAt: string;
};

export type MemoryV6Diagnostics = {
  generatedAt: string;
  runtime: MemoryV6RuntimeDiagnostics;
  binding: MemoryV6BindingDiagnostics;
  providers: MemoryV6ProviderBindingDiagnostics[];
  skillSync: MemoryV6SkillSyncDiagnostics[];
  cliShim: MemoryV6CliShimDiagnostics;
  lastErrors: MemoryV6DiagnosticEvent[];
};
