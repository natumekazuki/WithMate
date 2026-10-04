import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SetSessionTitleResult } from "../../../src-shared/session/session-mutation-contract.js";
import {
  applyCopilotCustomAgentSelection,
  getSessionIncarnationId,
  type Session,
} from "../../../src-shared/session/session-state.js";
import type { ApprovalMode } from "../../../src-shared/settings/approval-mode.js";
import type { CodexSandboxMode } from "../../../src-shared/settings/codex-sandbox-mode.js";
import type { CodexSpeed } from "../../../src-shared/settings/codex-speed.js";
import type { CodexReviewer } from "../../../src-shared/settings/codex-reviewer.js";
import type {
  ModelCatalogProvider,
  ModelReasoningEffort,
} from "../../../src-shared/settings/model-catalog.js";
import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexReviewer,
  buildSessionWithCodexSandboxMode,
  buildSessionWithCodexSpeed,
  buildSessionWithModelChange,
  buildSessionWithReasoningEffort,
} from "../../settings/runtime-option-state.js";

export type MainRuntimeOption =
  | { kind: "custom-agent"; value: string }
  | { kind: "approval-mode"; value: ApprovalMode }
  | { kind: "codex-sandbox-mode"; value: CodexSandboxMode }
  | { kind: "codex-speed"; value: CodexSpeed }
  | { kind: "codex-reviewer"; value: CodexReviewer }
  | { kind: "model"; value: string }
  | { kind: "reasoning-effort"; value: ModelReasoningEffort };

export async function runMainRuntimeOptionOperation(input: {
  session: Session | null;
  isReadOnly: boolean;
  runState: Session["runState"] | null;
  providerCatalog: ModelCatalogProvider | null;
  catalogRevision: number | null;
  option: MainRuntimeOption;
  persist: (session: Session) => Promise<Session>;
  createTimestampLabel: () => string;
}): Promise<Session | null> {
  const {
    session,
    isReadOnly,
    runState,
    providerCatalog,
    catalogRevision,
    option,
    persist,
    createTimestampLabel,
  } = input;
  if (!session || isReadOnly) return null;

  if (option.kind === "custom-agent") {
    if (
      session.provider !== "copilot" ||
      session.customAgentName === option.value
    )
      return null;
    return persist(
      applyCopilotCustomAgentSelection(
        session,
        option.value,
        createTimestampLabel(),
      ),
    );
  }

  if (option.kind === "approval-mode") {
    if (runState === "running") return null;
    const next = buildSessionWithApprovalMode(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }

  if (option.kind === "codex-sandbox-mode") {
    if (session.provider !== "codex" || runState === "running") return null;
    const next = buildSessionWithCodexSandboxMode(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (option.kind === "codex-speed") {
    if (session.provider !== "codex" || runState === "running") return null;
    const next = buildSessionWithCodexSpeed(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (option.kind === "codex-reviewer") {
    if (
      session.provider !== "codex" ||
      session.approvalMode === "never" ||
      runState === "running"
    )
      return null;
    const next = buildSessionWithCodexReviewer(
      session,
      option.value,
      createTimestampLabel(),
    );
    return next ? persist(next) : null;
  }
  if (!providerCatalog || catalogRevision === null) return null;
  const next =
    option.kind === "model"
      ? buildSessionWithModelChange(
          session,
          providerCatalog,
          option.value,
          catalogRevision,
          createTimestampLabel(),
        )
      : buildSessionWithReasoningEffort(
          session,
          providerCatalog,
          option.value,
          catalogRevision,
          createTimestampLabel(),
        );
  return persist(next);
}

export async function persistMainSession(input: {
  api: Pick<WithMateWindowApi, "updateSession"> | null;
  session: Session;
  isReadOnly: boolean;
}): Promise<Session> {
  const { api, session, isReadOnly } = input;
  if (!api || isReadOnly) {
    throw new Error(
      isReadOnly
        ? "Read-only sessions cannot be updated. Create a new session."
        : "Open the Session Window from Electron.",
    );
  }
  return api.updateSession(session);
}

export async function toggleMainSessionPin(input: {
  api: Pick<WithMateWindowApi, "setSessionPinned"> | null;
  session: Session;
}): Promise<Pick<Session, "id" | "isPinned">> {
  if (!input.api) {
    throw new Error("Open the Session Window from Electron.");
  }
  const saved = await input.api.setSessionPinned({
    sessionId: input.session.id,
    isPinned: input.session.isPinned !== true,
  });
  return { id: saved.id, isPinned: saved.isPinned };
}

export async function updateMainSessionTitle(input: {
  api: Pick<WithMateWindowApi, "setSessionTitle" | "getSessionSummary">;
  session: Session;
  title: string;
  isCurrent(): boolean;
  applyTitle(title: string): void;
}): Promise<string> {
  const { api, session, title, isCurrent, applyTitle } = input;
  const incarnationId = getSessionIncarnationId(session);
  let result: SetSessionTitleResult;
  try {
    result = await api.setSessionTitle({ sessionId: session.id, incarnationId, title });
  } catch (error) {
    if (isCurrent()) {
      try {
        const saved = await api.getSessionSummary(session.id);
        if (isCurrent() && saved && getSessionIncarnationId(saved) === incarnationId) applyTitle(saved.taskTitle);
      } catch {
        if (isCurrent()) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} The saved title could not be reloaded. Close and reopen the session window to refresh.`, { cause: error });
        }
      }
    }
    throw error;
  }
  if (!isCurrent()) return "";
  applyTitle(title);
  if (result.projectionUpdated) return "";

  try {
    const saved = await api.getSessionSummary(session.id);
    if (!isCurrent()) return "";
    if (!saved || getSessionIncarnationId(saved) !== incarnationId) {
      return "Title saved, but this session is no longer available. Close and reopen the session window.";
    }
    applyTitle(saved.taskTitle);
    return "Title saved and reloaded, but other windows may be out of date. Reopen them to refresh.";
  } catch {
    if (!isCurrent()) return "";
    return "Title saved, but window updates failed and the saved title could not be reloaded. Close and reopen the session window to refresh.";
  }
}
