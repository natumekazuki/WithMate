import { createHash } from "node:crypto";
import path from "node:path";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { getProviderAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogRequest, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { ProviderCodingAdapter } from "../providers/provider-runtime.js";
import type { CachedProviderModels } from "./model-catalog-storage.js";

const PROVIDERS = { codex: "Codex", claude: "Claude", copilot: "Copilot", opencode: "OpenCode" } as const;
const FRESH_MS = 10 * 60_000;
const RETRY_DELAY_MS = 30_000;
type DiscoveryState = NonNullable<ModelCatalogSnapshot["discovery"]>[string];
type Dependencies = {
  getAppSettings(): AppSettings | Promise<AppSettings>;
  getCachedProviders(): CachedProviderModels[] | Promise<CachedProviderModels[]>;
  upsertProvider(entry: CachedProviderModels): unknown | Promise<unknown>;
  getAdapter(providerId: string): ProviderCodingAdapter;
  defaultWorkspace(): string;
  onChanged(snapshot: ModelCatalogSnapshot): void;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
};

/** SDK lists are suggestions, not a migration of saved execution selections. */
export class ProviderModelDiscoveryService {
  private readonly jobs = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  private readonly states = new Map<string, DiscoveryState>();
  private readonly attempts = new Map<string, number>();
  private readonly workspaces = new Set<string>();
  private closed = false;

  constructor(private readonly deps: Dependencies) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private context(providerId: string, workspacePath: string, settings: AppSettings): string {
    const environment = this.deps.environment ?? process.env;
    const credentialEnvironment = Object.fromEntries(Object.entries(environment)
      .filter(([key]) => /^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|COPILOT_|GITHUB_|GH_TOKEN$|OPENCODE_)/.test(key))
      .sort(([a], [b]) => a.localeCompare(b)));
    // This is a credential-isolated cache key, never a persisted credential or integrity ledger.
    return createHash("sha256").update(JSON.stringify([
      providerId, process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath,
      getProviderAppSettings(settings, providerId), credentialEnvironment,
    ])).digest("hex");
  }

  private workspace(request?: ModelCatalogRequest): string {
    const workspace = request?.workspacePath ?? this.deps.defaultWorkspace();
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("An absolute model workspace is required.");
    return path.resolve(workspace);
  }

  private providerIds(request?: ModelCatalogRequest): string[] {
    if (request?.providerId !== undefined && !Object.hasOwn(PROVIDERS, request.providerId)) throw new Error("Unsupported model provider.");
    return request?.providerId ? [request.providerId] : Object.keys(PROVIDERS);
  }

  private snapshot(workspacePath: string, settings: AppSettings, cached: CachedProviderModels[]): ModelCatalogSnapshot {
    const discovery: NonNullable<ModelCatalogSnapshot["discovery"]> = {};
    const providers = Object.entries(PROVIDERS).map(([id, label]) => {
      const key = this.context(id, workspacePath, settings);
      const entry = cached.find((candidate) => candidate.provider.id === id && candidate.contextKey === key);
      discovery[id] = this.states.get(key) ?? (entry ? { status: "ready", fetchedAt: entry.fetchedAt } : { status: "idle" });
      return entry?.provider ?? { id, label, defaultModelId: "", defaultReasoningEffort: "", models: [] };
    });
    return { workspacePath, providers, discovery };
  }

  async get(request?: ModelCatalogRequest): Promise<ModelCatalogSnapshot> {
    const workspacePath = this.workspace(request);
    this.workspaces.add(workspacePath);
    const ids = this.providerIds(request);
    const [settings, cached] = await Promise.all([this.deps.getAppSettings(), this.deps.getCachedProviders()]);
    if (!this.closed) {
      for (const id of ids) this.start(id, workspacePath, settings, cached, false);
    }
    return this.snapshot(workspacePath, settings, cached);
  }

  /** Only a new Session without any selected model waits for its first list. */
  async ensure(providerId: string, workspacePath?: string): Promise<ModelCatalogSnapshot> {
    const request = { providerId, ...(workspacePath ? { workspacePath } : {}) };
    const workspace = this.workspace(request);
    this.providerIds(request);
    const [settings, cached] = await Promise.all([this.deps.getAppSettings(), this.deps.getCachedProviders()]);
    const key = this.context(providerId, workspace, settings);
    if (!cached.some((entry) => entry.contextKey === key && entry.provider.id === providerId)) {
      this.start(providerId, workspace, settings, cached, false);
      await this.jobs.get(key)?.completion;
    }
    const result = await this.deps.getCachedProviders();
    const currentSettings = await this.deps.getAppSettings();
    const snapshot = this.snapshot(workspace, currentSettings, result);
    if (snapshot.discovery?.[providerId]?.status === "error") throw new Error("Model discovery failed. Check the provider connection and try again.");
    return snapshot;
  }

  async refreshEnabled(force = false): Promise<void> {
    const [settings, cached] = await Promise.all([this.deps.getAppSettings(), this.deps.getCachedProviders()]);
    if (this.closed) return;
    this.workspaces.add(this.workspace());
    for (const workspace of this.workspaces) {
      for (const id of Object.keys(PROVIDERS)) this.start(id, workspace, settings, cached, force);
      this.deps.onChanged(this.snapshot(workspace, settings, cached));
    }
  }

  private start(id: string, workspace: string, settings: AppSettings, cached: CachedProviderModels[], force: boolean): void {
    if (this.closed || !getProviderAppSettings(settings, id).enabled) return;
    const key = this.context(id, workspace, settings);
    if (this.jobs.has(key)) return;
    const previous = cached.find((entry) => entry.contextKey === key && entry.provider.id === id);
    if (!force && previous && this.now() - Date.parse(previous.fetchedAt) < FRESH_MS) return;
    if (!force && this.now() - (this.attempts.get(key) ?? -Infinity) < RETRY_DELAY_MS) return;
    this.attempts.set(key, this.now());
    this.states.set(key, { status: "loading", ...(previous ? { fetchedAt: previous.fetchedAt } : {}) });
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const adapter = this.deps.getAdapter(id);
        if (!adapter.listModels) throw new Error("Model discovery is unavailable.");
        const provider = await adapter.listModels({ appSettings: settings, workspacePath: workspace, signal: controller.signal });
        if (controller.signal.aborted || this.closed) return;
        const currentSettings = await this.deps.getAppSettings();
        if (this.context(id, workspace, currentSettings) !== key) return;
        const fetchedAt = new Date(this.now()).toISOString();
        await this.deps.upsertProvider({ provider, contextKey: key, fetchedAt });
        if (this.closed) return;
        this.states.set(key, { status: "ready", fetchedAt });
      } catch {
        if (!this.closed) this.states.set(key, { status: "error", ...(previous ? { fetchedAt: previous.fetchedAt } : {}), error: "Could not load models. Check the provider connection." });
      } finally {
        clearTimeout(timeout);
        this.jobs.delete(key);
        if (!this.closed) {
          const [currentSettings, entries] = await Promise.all([this.deps.getAppSettings(), this.deps.getCachedProviders()]);
          if (!this.closed) this.deps.onChanged(this.snapshot(workspace, currentSettings, entries));
        }
      }
    });
    // A storage-generation shutdown owns and awaits every outstanding discovery.
    this.jobs.set(key, { controller, completion });
    void completion.catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.completion));
  }
}
