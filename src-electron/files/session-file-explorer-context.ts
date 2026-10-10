import { getSessionIncarnationId, type SessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionFileExplorerContext } from "./session-file-explorer-service.js";

type SessionFileExplorerContextReads = {
  assertCurrent(): void;
  getAuxiliaryMetadata(sessionId: string): Promise<Pick<AuxiliarySessionSummary, "parentSessionId" | "allowedAdditionalDirectories"> | null>;
  getSessionSummary(sessionId: string): Promise<SessionSummary | null>;
};

export async function readSessionFileExplorerContext(
  sessionId: string,
  reads: SessionFileExplorerContextReads,
): Promise<SessionFileExplorerContext | null> {
  reads.assertCurrent();
  const auxiliary = await reads.getAuxiliaryMetadata(sessionId);
  reads.assertCurrent();
  const session = await reads.getSessionSummary(auxiliary?.parentSessionId ?? sessionId);
  reads.assertCurrent();
  if (!session) return null;
  return {
    workspacePath: session.workspacePath,
    parentSessionId: session.id,
    parentIncarnationId: getSessionIncarnationId(session),
    allowedAdditionalDirectories: auxiliary?.allowedAdditionalDirectories ?? session.allowedAdditionalDirectories,
  };
}
