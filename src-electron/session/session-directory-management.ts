import { resolveCrewFilesDirectory, resolveSessionFilesDirectory } from "../files/session-files.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { SessionManagementError } from "./session-management-application.js";
import { AdditionalDirectoryValidationError, type SessionPersistenceService } from "./session-persistence-service.js";
import type { RelatedSession } from "./session-relationship-resolver.js";

export async function manageSessionDirectories(
  persistence: SessionPersistenceService,
  userDataPath: string,
  target: RelatedSession,
  change: { operation: "add" | "remove"; directoryPath: string } | null,
  assertCurrent: () => void,
) {
  let session;
  try {
    session = change
      ? await persistence.changeAdditionalDirectory({ sessionId: target.mainSessionId, incarnationId: target.mainIncarnationId, ...change }, assertCurrent)
      : await persistence.readSessionSummaryForLifecycle(target.mainSessionId);
  } catch (error) {
    if (error instanceof AdditionalDirectoryValidationError) throw new SessionManagementError("SESSION_REJECTED", error.message);
    throw error;
  }
  if (!session || getSessionIncarnationId(session) !== target.mainIncarnationId) throw new SessionManagementError("SESSION_REPLACED", "The directory owner was replaced or deleted.");
  if (!change) assertCurrent();
  return {
    workspacePath: session.workspacePath,
    sessionFolderPath: resolveSessionFilesDirectory(userDataPath, target.mainSessionId),
    crewFolder: { rootSessionId: target.rootSessionId, path: resolveCrewFilesDirectory(userDataPath, target.rootSessionId) },
    additionalDirectories: session.allowedAdditionalDirectories,
  };
}
