import { createHash } from "node:crypto";
import path from "node:path";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { getProviderAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  ModelCatalogProvider,
  ModelCatalogRequest,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type { ProviderCodingAdapter } from "../providers/provider-runtime.js";
import type { CachedProviderModels } from "./model-catalog-storage.js";

const PROVIDERS = {
  codex: "Codex",
  claude: "Claude",
  copilot: "Copilot",
  opencode: "OpenCode",
} as const;
const FRESH_MS = 10 * 60_000;
const RETRY_DELAY_MS = 30_000;
/** プロバイダーごとの候補検出の進行状態と、最後に取得できた時刻。 */
type DiscoveryState = NonNullable<ModelCatalogSnapshot["discovery"]>[string];
/** 現在の接続設定、永続キャッシュ、SDK アダプターと候補の更新通知への接続口。 */
type Dependencies = {
  /** モデル一覧の取得条件を確定し、取得中の条件変更を再確認するために現在の設定を読む。 */
  getAppSettings(): AppSettings | Promise<AppSettings>;
  /** 接続条件を照合するため、プロバイダー候補の保存済みキャッシュを読む。 */
  getCachedProviders():
    CachedProviderModels[] | Promise<CachedProviderModels[]>;
  /** 取得した候補と時刻を、対象の接続条件に紐付けて永続化する。 */
  upsertProvider(entry: CachedProviderModels): unknown | Promise<unknown>;
  /** プロバイダー ID からモデル候補の問い合わせ先を解決する。 */
  getAdapter(providerId: string): ProviderCodingAdapter;
  /** 要求にワークスペースがない場合に使う既定のディレクトリを返す。 */
  defaultWorkspace(): string;
  /** ワークスペースの候補一覧または検出状態が更新されたことを通知する。 */
  onChanged(snapshot: ModelCatalogSnapshot): void;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
};

/** SDK の一覧は候補を示すだけで、保存済みの実行時の選択を移行するものではない。 */
export class ProviderModelDiscoveryService {
  private readonly jobs = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  private readonly states = new Map<string, DiscoveryState>();
  private readonly attempts = new Map<string, number>();
  private readonly workspaces = new Set<string>();
  private closed = false;

  /** キャッシュ読み書きと SDK を接続する。候補取得は要求を受けるまで始めない。 */
  constructor(private readonly deps: Dependencies) {}

  /** キャッシュの鮮度と再試行間隔に同じ時刻源を使う。 */
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** プロバイダー、ワークスペース、設定と認証環境を照合するキャッシュキーを作る。 */
  private context(
    providerId: string,
    workspacePath: string,
    settings: AppSettings,
  ): string {
    const environment = this.deps.environment ?? process.env;
    const credentialEnvironment = Object.fromEntries(
      Object.entries(environment)
        .filter(([key]) =>
          /^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|COPILOT_|GITHUB_|GH_TOKEN$|OPENCODE_)/.test(
            key,
          ),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    // 認証情報ごとに分離したキャッシュキーであり、永続化する認証情報でも整合性の台帳でもない。
    return createHash("sha256")
      .update(
        JSON.stringify([
          providerId,
          process.platform === "win32"
            ? workspacePath.toLowerCase()
            : workspacePath,
          getProviderAppSettings(settings, providerId),
          credentialEnvironment,
        ]),
      )
      .digest("hex");
  }

  /** 要求または既定のワークスペースを絶対パスとして検証し、正規化する。 */
  private workspace(request?: ModelCatalogRequest): string {
    const workspace = request?.workspacePath ?? this.deps.defaultWorkspace();
    if (typeof workspace !== "string" || !path.isAbsolute(workspace))
      throw new Error("An absolute model workspace is required.");
    return path.resolve(workspace);
  }

  /** 指定された対応プロバイダーだけを対象にする。未指定時は対応する全プロバイダーを対象とする。 */
  private providerIds(request?: ModelCatalogRequest): string[] {
    if (
      request?.providerId !== undefined &&
      !Object.hasOwn(PROVIDERS, request.providerId)
    )
      throw new Error("Unsupported model provider.");
    return request?.providerId ? [request.providerId] : Object.keys(PROVIDERS);
  }

  /** 現在の接続条件に一致するキャッシュと検出状態を投影し、他の接続条件の候補を混ぜない。 */
  private snapshot(
    workspacePath: string,
    settings: AppSettings,
    cached: CachedProviderModels[],
  ): ModelCatalogSnapshot {
    const discovery: NonNullable<ModelCatalogSnapshot["discovery"]> = {};
    const providers = Object.entries(PROVIDERS).map(([id, label]) => {
      const key = this.context(id, workspacePath, settings);
      const entry = cached.find(
        (candidate) =>
          candidate.provider.id === id && candidate.contextKey === key,
      );
      discovery[id] =
        this.states.get(key) ??
        (entry
          ? { status: "ready", fetchedAt: entry.fetchedAt }
          : { status: "idle" });
      return (
        entry?.provider ?? {
          id,
          label,
          defaultModelId: "",
          defaultReasoningEffort: "",
          models: [],
        }
      );
    });
    return { workspacePath, providers, discovery };
  }

  /** 現在のキャッシュを直ちに返し、必要な候補の取得はバックグラウンドで始める。 */
  async get(request?: ModelCatalogRequest): Promise<ModelCatalogSnapshot> {
    const workspacePath = this.workspace(request);
    this.workspaces.add(workspacePath);
    const ids = this.providerIds(request);
    const [settings, cached] = await Promise.all([
      this.deps.getAppSettings(),
      this.deps.getCachedProviders(),
    ]);
    if (!this.closed) {
      for (const id of ids)
        this.start(id, workspacePath, settings, cached, false);
    }
    return this.snapshot(workspacePath, settings, cached);
  }

  /** モデルをまだ選んでいない新規 Session だけが、最初の一覧の取得を待つ。 */
  async ensure(
    providerId: string,
    workspacePath?: string,
  ): Promise<ModelCatalogSnapshot> {
    const request = { providerId, ...(workspacePath ? { workspacePath } : {}) };
    const workspace = this.workspace(request);
    this.providerIds(request);
    const [settings, cached] = await Promise.all([
      this.deps.getAppSettings(),
      this.deps.getCachedProviders(),
    ]);
    const key = this.context(providerId, workspace, settings);
    if (
      !cached.some(
        (entry) => entry.contextKey === key && entry.provider.id === providerId,
      )
    ) {
      this.start(providerId, workspace, settings, cached, false);
      await this.jobs.get(key)?.completion;
    }
    const result = await this.deps.getCachedProviders();
    const currentSettings = await this.deps.getAppSettings();
    const snapshot = this.snapshot(workspace, currentSettings, result);
    const provider = snapshot.providers.find(
      (entry) => entry.id === providerId,
    );
    if (
      snapshot.discovery?.[providerId]?.status === "error" &&
      !provider?.defaultModelId.trim()
    ) {
      throw new Error(
        "Model discovery failed. Check the provider connection and try again.",
      );
    }
    return snapshot;
  }

  /** 観測済みと既定のワークスペースで有効なプロバイダーの更新を予約し、現在の状態も通知する。 */
  async refreshEnabled(force = false): Promise<void> {
    const [settings, cached] = await Promise.all([
      this.deps.getAppSettings(),
      this.deps.getCachedProviders(),
    ]);
    if (this.closed) return;
    this.workspaces.add(this.workspace());
    for (const workspace of this.workspaces) {
      for (const id of Object.keys(PROVIDERS))
        this.start(id, workspace, settings, cached, force);
      this.deps.onChanged(this.snapshot(workspace, settings, cached));
    }
  }

  /** 同じ接続条件の取得を一つにまとめる。通常は鮮度と再試行間隔を守り、取得中に接続条件が変われば結果を保存しない。 */
  private start(
    id: string,
    workspace: string,
    settings: AppSettings,
    cached: CachedProviderModels[],
    force: boolean,
  ): void {
    if (this.closed || !getProviderAppSettings(settings, id).enabled) return;
    const key = this.context(id, workspace, settings);
    if (this.jobs.has(key)) return;
    const previous = cached.find(
      (entry) => entry.contextKey === key && entry.provider.id === id,
    );
    if (
      !force &&
      previous &&
      this.now() - Date.parse(previous.fetchedAt) < FRESH_MS
    )
      return;
    if (
      !force &&
      this.now() - (this.attempts.get(key) ?? -Infinity) < RETRY_DELAY_MS
    )
      return;
    this.attempts.set(key, this.now());
    this.states.set(key, {
      status: "loading",
      ...(previous ? { fetchedAt: previous.fetchedAt } : {}),
    });
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const adapter = this.deps.getAdapter(id);
        if (!adapter.listModels)
          throw new Error("Model discovery is unavailable.");
        const provider = await adapter.listModels({
          appSettings: settings,
          workspacePath: workspace,
          signal: controller.signal,
        });
        if (controller.signal.aborted || this.closed) return;
        const currentSettings = await this.deps.getAppSettings();
        if (this.context(id, workspace, currentSettings) !== key) return;
        const fetchedAt = new Date(this.now()).toISOString();
        await this.deps.upsertProvider({
          provider,
          contextKey: key,
          fetchedAt,
        });
        if (this.closed) return;
        this.states.set(key, { status: "ready", fetchedAt });
      } catch {
        if (!this.closed)
          this.states.set(key, {
            status: "error",
            ...(previous ? { fetchedAt: previous.fetchedAt } : {}),
            error: "Could not load models. Check the provider connection.",
          });
      } finally {
        clearTimeout(timeout);
        this.jobs.delete(key);
        if (!this.closed) {
          const [currentSettings, entries] = await Promise.all([
            this.deps.getAppSettings(),
            this.deps.getCachedProviders(),
          ]);
          if (!this.closed)
            this.deps.onChanged(
              this.snapshot(workspace, currentSettings, entries),
            );
        }
      }
    });
    // ストレージ世代の終了処理は未完了の検出ジョブをすべて引き受け、完了を待つ。
    this.jobs.set(key, { controller, completion });
    void completion.catch(() => undefined);
  }

  /** 新しいモデル検出を止め、すべての実行中の取得を中止して後処理の完了を待つ。 */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.completion),
    );
  }
}
