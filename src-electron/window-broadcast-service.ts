import type {
  AppSettings,
  CharacterProfile,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionSummary,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../src/app-state.js";
import type { CompanionSessionSummary } from "../src/companion-state.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import {
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  WITHMATE_CHARACTERS_CHANGED_EVENT,
  WITHMATE_COMPANION_SESSIONS_CHANGED_EVENT,
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_SESSIONS_INVALIDATED_EVENT,
  WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT,
  WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT,
} from "../src/withmate-ipc-channels.js";

type WindowLike = {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
};

type WindowBroadcastServiceOptions<TWindow extends WindowLike> = {
  getAllWindows(): TWindow[];
  getHomeWindows(): TWindow[];
  getSessionWindows(): TWindow[];
};

export class WindowBroadcastService<TWindow extends WindowLike> {
  public constructor(private readonly options: WindowBroadcastServiceOptions<TWindow>) {}

  public broadcastSessionSummaries(sessions: SessionSummary[]): void {
    this.broadcastTo(this.options.getHomeWindows(), WITHMATE_SESSIONS_CHANGED_EVENT, sessions);
  }

  public broadcastCompanionSessionSummaries(sessions: CompanionSessionSummary[]): void {
    this.broadcastTo(this.options.getHomeWindows(), WITHMATE_COMPANION_SESSIONS_CHANGED_EVENT, sessions);
  }

  public broadcastSessionInvalidation(sessionIds: string[]): void {
    this.broadcastTo(this.options.getSessionWindows(), WITHMATE_SESSIONS_INVALIDATED_EVENT, sessionIds);
  }

  public broadcastCharacters(characters: CharacterProfile[]): void {
    this.broadcast(WITHMATE_CHARACTERS_CHANGED_EVENT, characters);
  }

  public broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void {
    this.broadcast(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, snapshot);
  }

  public broadcastAppSettings(settings: AppSettings): void {
    this.broadcast(WITHMATE_APP_SETTINGS_CHANGED_EVENT, settings);
  }

  public broadcastOpenSessionWindowIds(sessionIds: string[]): void {
    this.broadcast(WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT, sessionIds);
  }

  public broadcastLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void {
    this.broadcast(WITHMATE_LIVE_SESSION_RUN_EVENT, { sessionId, state });
  }

  public broadcastProviderQuotaTelemetry(providerId: string, telemetry: ProviderQuotaTelemetry | null): void {
    this.broadcast(WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT, { providerId, telemetry });
  }

  public broadcastSessionContextTelemetry(sessionId: string, telemetry: SessionContextTelemetry | null): void {
    this.broadcast(WITHMATE_SESSION_CONTEXT_TELEMETRY_EVENT, { sessionId, telemetry });
  }

  public broadcastSessionBackgroundActivity(
    sessionId: string,
    kind: SessionBackgroundActivityKind,
    state: SessionBackgroundActivityState | null,
  ): void {
    this.broadcast(WITHMATE_SESSION_BACKGROUND_ACTIVITY_EVENT, { sessionId, kind, state });
  }

  private broadcast(channel: string, payload: unknown): void {
    this.broadcastTo(this.options.getAllWindows(), channel, payload);
  }

  private broadcastTo(windows: TWindow[], channel: string, payload: unknown): void {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }
}
