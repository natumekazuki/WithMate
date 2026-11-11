import type { Session } from "../../src-shared/session/session-state.js";
import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type { CharacterContextApplicationService } from "../character/character-context-application-service.js";
import { refreshSessionCharacterRuntimeSnapshot } from "../character/character-runtime-service.js";
import { resolveRuntimeCharacterContext } from "../character/character-context-runtime.js";
import { resolveConversationTimingContext, type ConversationTimingStorageSnapshot } from "../session/conversation-timing.js";
import { appendSessionFilesDirectoryForSessionId, resolveSessionFilesDirectory } from "../files/session-files.js";
import type { BackgroundAgentInput } from "./background-call-service.js";
import type { BackgroundProviderAgentDependencies } from "./background-provider-agent.js";

/** Uses the foreground Character/context resolvers with the real background source. */
export async function resolveBackgroundPromptContext(input: Pick<BackgroundAgentInput, "session" | "scope">, settings: AppSettings, deps: {
  userDataPath: string;
  refreshSnapshot(characterId: string, previous: CharacterRuntimeSnapshot | null): Promise<CharacterRuntimeSnapshot>;
  characterContextService: Pick<CharacterContextApplicationService, "getContext"> | null | undefined;
  getTimingSnapshot(sessionId: string, observedAt: string): Promise<ConversationTimingStorageSnapshot | null>;
  onCharacterContextFailure: Parameters<typeof resolveRuntimeCharacterContext>[0]["onFailure"];
}): ReturnType<NonNullable<BackgroundProviderAgentDependencies["resolvePromptContext"]>> {
  const source = input.scope.history.source;
  const folderSessionId = source.kind === "auxiliary" ? source.parent.sessionId : source.sessionId;
  const session: Session = appendSessionFilesDirectoryForSessionId(deps.userDataPath,
    await refreshSessionCharacterRuntimeSnapshot(input.session, deps.refreshSnapshot), folderSessionId);
  const characterContext = settings.characterAffectContextEnabled
    ? await resolveRuntimeCharacterContext({ session, service: deps.characterContextService,
      sessionSource: source, onFailure: deps.onCharacterContextFailure }) : null;
  const observedAt = new Date();
  // Auxiliary foreground turns do not have a separate timing projection.
  const timing = settings.conversationTimingEnabled && source.kind === "main"
    ? await deps.getTimingSnapshot(session.id, observedAt.toISOString()) : null;
  return { session, sessionFolderPath: resolveSessionFilesDirectory(deps.userDataPath, folderSessionId),
    characterContext: characterContext ?? undefined,
    conversationTimingContext: timing ? resolveConversationTimingContext(timing, observedAt) : undefined };
}
