import type {
  AppSettings,
  CharacterProfile,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  Session,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../src/app-state.js";
import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import {
  WITHMATE_APP_SETTINGS_CHANGED_EVENT,
  WITHMATE_CHARACTERS_CHANGED_EVENT,
  WITHMATE_LIVE_SESSION_RUN_EVENT,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_SESSION_WINDOWS_CHANGED_EVENT,
  WITHMATE_PROVIDER_QUOTA_TELEMETRY_EVENT,
  WITHMATE_SESSIONS_CHANGED_EVENT,
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
  getWindows(): TWindow[];
};

export class WindowBroadcastService<TWindow extends WindowLike> {
  public constructor(private readonly options: WindowBroadcastServiceOptions<TWindow>) {}

  public broadcastSessions(sessions: Session[]): void {
    this.broadcast(WITHMATE_SESSIONS_CHANGED_EVENT, sessions);
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
    for (const window of this.options.getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }
}
