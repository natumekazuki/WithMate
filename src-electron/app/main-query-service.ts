import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type {
  ComposerPreview,
  DiscoveredCustomAgent,
  DiscoveredSkill,
} from "../../src-shared/session/runtime-state.js";
import type {
  MessageArtifact,
  Session,
  SessionCharacterUsage,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  cloneHomeSessionSummaries,
  cloneSessionSummaries,
  cloneSessions,
} from "../../src-shared/session/session-state.js";
import {
  getProviderAppSettings,
  resolveProviderSkillRootPath,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { extractComposerAttachmentReferenceCandidates } from "../../src-shared/files/path-reference.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

/** Session の読み取り、作業先での探索、端末起動を担う Main 側の依存。 */
type MainQueryServiceDeps = {
  /** 一覧表示用の Session 概要を取得する。 */
  getSessionSummaries(): Awaitable<SessionSummary[]>;
  /** 参照可能な Session の概要を ID で取得する。 */
  getReadySessionSummary(sessionId: string): Awaitable<SessionSummary | null>;
  /** 一覧のカーソルと件数指定に従ってホーム用の概要を取得する。 */
  getSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): Awaitable<HomeSessionSummaryPageResult>;
  /** Character ごとの Session 利用状況を集計した結果を得る。 */
  getSessionCharacterUsage(): Awaitable<SessionCharacterUsage[]>;
  /** 履歴を含む Session の詳細を ID で取得する。 */
  getSession(sessionId: string): Awaitable<Session | null>;
  /** 対象メッセージに紐づく成果物を取得する。 */
  getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): Awaitable<MessageArtifact | null>;
  /** 指定された Session の最新の Turn 記録を取得する。 */
  getLatestSessionTurn(sessionId: string): Awaitable<SessionTurnRecord | null>;
  /** スキル探索で使う Provider 設定のためにアプリ設定を取得する。 */
  getAppSettings(): Awaitable<AppSettings>;
  /** ワークスペースと Provider 固有の探索ルートから利用可能なスキルを探す。 */
  discoverSessionSkills(
    workspacePath: string,
    skillRootPath: string | null,
  ): Promise<DiscoveredSkill[]>;
  /** 指定されたワークスペースで利用可能なカスタムエージェントを探す。 */
  discoverSessionCustomAgents(
    workspacePath: string,
  ): Promise<DiscoveredCustomAgent[]>;
  /** 送信前の本文に含まれる添付参照を Session の実行先に照らして解決する。 */
  resolveComposerPreview(
    session: SessionSummary,
    userMessage: string,
  ): Promise<ComposerPreview>;
  /** 指定されたワークスペースを起点に端末を起動する。 */
  launchTerminalAtPath(workspacePath: string): Promise<void>;
};

/** Main の一覧・詳細参照と、作業先に依存する探索やプレビューを扱う。 */
export class MainQueryService {
  /** Session の読み取り、探索および端末起動を担う依存を受け取る。 */
  constructor(private readonly deps: MainQueryServiceDeps) {}

  /** 履歴を含む Session の詳細を、保存側の参照と分離する。 */
  private cloneSession(session: Session): Session {
    return cloneSessions([session])[0] as Session;
  }

  /** 探索やプレビューに渡す Session 概要を、取得元の参照と分離する。 */
  private cloneSessionSummary(session: SessionSummary): SessionSummary {
    return cloneSessionSummaries([session])[0] as SessionSummary;
  }

  /** 参照可能な Session の概要を複製し、存在しなければ null を返す。 */
  private async getSessionSummary(
    sessionId: string,
  ): Promise<SessionSummary | null> {
    const session = await this.deps.getReadySessionSummary(sessionId);
    return session ? this.cloneSessionSummary(session) : null;
  }

  /** 詳細や会話履歴を含めず、一覧用の Session 概要のコピーを返す。 */
  async listSessionSummaries(): Promise<SessionSummary[]> {
    return cloneSessionSummaries(await this.deps.getSessionSummaries());
  }

  /** ページ境界と継続カーソルを保ったまま、ホーム用の概要項目を複製する。 */
  async listSessionSummaryPage(
    request?: SessionSummaryPageRequest | null,
  ): Promise<HomeSessionSummaryPageResult> {
    const page = await this.deps.getSessionSummaryPage(request);
    return {
      entries: cloneHomeSessionSummaries(page.entries),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /** Character 別の Session 利用状況を、取得元と項目を共有しない形で返す。 */
  async listSessionCharacterUsage(): Promise<SessionCharacterUsage[]> {
    return (await this.deps.getSessionCharacterUsage()).map((usage) => ({
      ...usage,
    }));
  }

  /** 指定された Session の最新 Turn を返し、記録がなければ null を返す。 */
  async getLatestSessionTurn(
    sessionId: string,
  ): Promise<SessionTurnRecord | null> {
    return this.deps.getLatestSessionTurn(sessionId);
  }

  /** 保存済み Session の Provider とワークスペースを使ってスキルを探し、Session がなければ拒否する。 */
  async listSessionSkills(sessionId: string): Promise<DiscoveredSkill[]> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    return this.listWorkspaceSkills(session.provider, session.workspacePath);
  }

  /** 指定 Provider の現在設定で探索ルートを決め、ワークスペースで利用可能なスキルを探す。 */
  async listWorkspaceSkills(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredSkill[]> {
    const appSettings = await this.deps.getAppSettings();
    const providerSettings = getProviderAppSettings(appSettings, providerId);
    return this.deps.discoverSessionSkills(
      workspacePath,
      resolveProviderSkillRootPath(providerSettings),
    );
  }

  /** 保存済み Session の Provider とワークスペースを使ってカスタムエージェントを探す。 */
  async listSessionCustomAgents(
    sessionId: string,
  ): Promise<DiscoveredCustomAgent[]> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    return this.listWorkspaceCustomAgents(
      session.provider,
      session.workspacePath,
    );
  }

  /** Copilot の場合だけワークスペースでカスタムエージェントを探し、それ以外は空配列を返す。 */
  async listWorkspaceCustomAgents(
    providerId: string,
    workspacePath: string,
  ): Promise<DiscoveredCustomAgent[]> {
    if (providerId !== "copilot") {
      return [];
    }

    return this.deps.discoverSessionCustomAgents(workspacePath);
  }

  /** 指定された Session だけを複製して返し、見つからなければ null を返す。 */
  async getSession(sessionId: string): Promise<Session | null> {
    const session = await this.deps.getSession(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  /** 非負整数のメッセージ位置に対応する成果物を複製し、不正な位置または成果物がなければ null を返す。 */
  async getSessionMessageArtifact(
    sessionId: string,
    messageIndex: number,
  ): Promise<MessageArtifact | null> {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) {
      return null;
    }

    const artifact = await this.deps.getSessionMessageArtifact(
      sessionId,
      messageIndex,
    );
    return artifact
      ? (JSON.parse(JSON.stringify(artifact)) as MessageArtifact)
      : null;
  }

  /** 添付参照の候補がある場合だけ Session を読み、本文の参照を解決する。 */
  async previewComposerInput(
    sessionId: string,
    userMessage: string,
  ): Promise<ComposerPreview> {
    if (
      extractComposerAttachmentReferenceCandidates(userMessage).length === 0
    ) {
      return { attachments: [], errors: [] };
    }

    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    return this.deps.resolveComposerPreview(session, userMessage);
  }

  /** 保存済み Session のワークスペースで端末を起動し、Session がなければ拒否する。 */
  async openSessionTerminal(sessionId: string): Promise<void> {
    const session = await this.getSessionSummary(sessionId);
    if (!session) {
      throw new Error("The session could not be found.");
    }

    await this.openTerminalAtPath(session.workspacePath);
  }

  /** 指定パスを端末の起動先として端末サービスへ渡す。 */
  async openTerminalAtPath(workspacePath: string): Promise<void> {
    await this.deps.launchTerminalAtPath(workspacePath);
  }
}
