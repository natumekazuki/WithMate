import type { Session } from "../src/session-state.js";
import type { MateStorageState } from "../src/mate-state.js";
import type { MateProjectDigest } from "./mate-project-digest-storage.js";

type WarningLogger = (...data: unknown[]) => void;

type ResolveMateProjectDigestForSessionDeps = {
  session: Session;
  getMateState: () => MateStorageState;
  resolveProjectDigestForWorkspace: (workspacePath: string) => MateProjectDigest | null;
  logWarning?: WarningLogger;
};

const defaultLogWarning: WarningLogger = (...data) => {
  console.warn(...data);
};

export function resolveMateProjectDigestForSession(
  params: ResolveMateProjectDigestForSessionDeps,
): MateProjectDigest | null {
  const { session, getMateState, resolveProjectDigestForWorkspace } = params;
  const logWarning = params.logWarning ?? defaultLogWarning;

  if (getMateState() === "not_created") {
    return null;
  }

  try {
    return resolveProjectDigestForWorkspace(session.workspacePath);
  } catch (error) {
    logWarning("Failed to resolve Mate Project Digest", session.id, error);
    return null;
  }
}

type ResolveMateProjectContextTextForPromptDeps = ResolveMateProjectDigestForSessionDeps & {
  userMessage: string;
  getProjectDigestContextText: (
    projectDigestId: string,
    options: { queryText: string },
  ) => Promise<string | null>;
};

export async function resolveMateProjectContextTextForPrompt(
  params: ResolveMateProjectContextTextForPromptDeps,
): Promise<string | null> {
  const { session, userMessage, getProjectDigestContextText } = params;
  const logWarning = params.logWarning ?? defaultLogWarning;

  const digest = resolveMateProjectDigestForSession(params);
  if (!digest) {
    return null;
  }

  try {
    return await getProjectDigestContextText(digest.id, {
      queryText: userMessage,
    });
  } catch (error) {
    logWarning("Failed to resolve Mate Project Context", session.id, error);
    return null;
  }
}
