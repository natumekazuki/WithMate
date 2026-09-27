import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { getSessionIncarnationId, setMessageBookmarked, type Message, type Session } from "../../../src-shared/session/session-state.js";
import type { AuxiliarySessionBinding } from "../use-auxiliary-workspace.js";
import type { MessageCollapseTarget } from "./session-message-collapse.js";

export function createMessageBookmarkHandler(input: {
  api: Pick<WithMateWindowApi, "setSessionMessageBookmark" | "setAuxiliaryMessageBookmark"> | null;
  mainSession: Session | null;
  isReadOnly: boolean;
  getAuxiliaryBinding: (id: string) => Pick<AuxiliarySessionBinding, "getSession" | "setMessageBookmark">;
  updateSessionProjection: (sessionId: string, patch: (current: Session) => Session) => void;
}): ((target: MessageCollapseTarget) => Promise<void>) | undefined {
  const { api, mainSession } = input;
  if (!api || !mainSession || input.isReadOnly) return undefined;

  return async (target) => {
    const { messageIndex } = target.source;
    const isBookmarked = !target.isBookmarked;
    const matchesMessage = (message: Message | undefined) => message?.role === target.role && message.text === target.text;
    if (target.source.kind === "auxiliary") {
      const binding = input.getAuxiliaryBinding(target.source.sessionId);
      const owner = binding.getSession();
      if (!owner || owner.id !== target.source.sessionId || owner.parentSessionId !== mainSession.id
        || owner.status !== "active" || !matchesMessage(owner.messages[messageIndex])) return;
      await api.setAuxiliaryMessageBookmark({
        auxiliarySessionId: owner.id, parentSessionId: owner.parentSessionId, createdAt: owner.createdAt,
        messageIndex, isBookmarked,
      });
      const latest = binding.getSession();
      if (latest?.id === owner.id && latest.createdAt === owner.createdAt
        && matchesMessage(latest.messages[messageIndex])) binding.setMessageBookmark(messageIndex, isBookmarked);
      return;
    }

    if (!matchesMessage(mainSession.messages[messageIndex])) return;
    const incarnationId = getSessionIncarnationId(mainSession);
    await api.setSessionMessageBookmark({ sessionId: mainSession.id, incarnationId, messageIndex, isBookmarked });
    input.updateSessionProjection(mainSession.id, (current) => (
      getSessionIncarnationId(current) === incarnationId && matchesMessage(current.messages[messageIndex])
        ? { ...current, messages: current.messages.map((message, index) => index === messageIndex ? setMessageBookmarked(message, isBookmarked) : message) }
        : current
    ));
  };
}
