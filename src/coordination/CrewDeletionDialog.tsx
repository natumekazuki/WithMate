import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  CrewDeletionBlocker,
  CrewDeletionStatus,
} from "../../src-shared/session/session-crew-deletion.js";
import { useDialogA11y } from "../ui/a11y.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { LoadingIndicator } from "../ui/loading-indicator.js";
import { LoadError } from "../ui/load-error.js";
import { ButtonContent } from "../ui/button-content.js";

export function CrewDeletionDialog({
  api,
  sessionId,
  incarnationId,
  title,
  onClose,
  onDeleted,
}: {
  api: WithMateWindowApi;
  sessionId: string;
  incarnationId: string;
  title: string;
  onClose(): void;
  onDeleted(): void;
}) {
  const [status, setStatus] = useState<CrewDeletionStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pendingDelete = useRef(false);
  const retry = useCallback(() => {
    generation.current += 1;
    setRevision((value) => value + 1);
  }, []);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true,
    onClose,
  });
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    void api
      .getCrewDeletionStatus(sessionId, incarnationId)
      .then((value) => {
        if (generation.current === current) {
          setStatus(value);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (generation.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not check Crew deletion.",
          );
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [api, sessionId, incarnationId, revision]);
  useEffect(() => {
    const coordination = api.subscribeCoordinationChanged(retry);
    const live = api.subscribeLiveSessionRunStatus(() => retry());
    return () => {
      coordination();
      live();
    };
  }, [api, retry]);
  const openBlocker = async (blocker: CrewDeletionBlocker) => {
    try {
      const result = await api.executeCoordination({
        operation: "get",
        id: blocker.id,
      });
      if (!("record" in result))
        throw new Error("The Coordination record is no longer available.");
      await api.openCoordination({
        ...result.record.initiator,
        id: result.record.id,
      });
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not open Coordination.",
      );
    }
  };
  const remove = async () => {
    if (pendingDelete.current || loading || !status?.allowed || error) return;
    pendingDelete.current = true;
    setDeleting(true);
    try {
      await api.deleteSession(sessionId);
      onDeleted();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Crew was not deleted.",
      );
      retry();
    } finally {
      pendingDelete.current = false;
      setDeleting(false);
    }
  };
  return createPortal(
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      ariaLabel="Delete Crew"
      closeOnBackdropClick={false}
      showDismissControl={false}
      footer={
        <>
          <button
            type="button"
            className="launch-toggle"
            disabled={deleting}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="launch-toggle danger"
            disabled={deleting || loading || !status?.allowed || Boolean(error)}
            aria-busy={deleting}
            onClick={() => void remove()}
          >
            <ButtonContent busy={deleting} busyLabel="Deleting Crew">
              Delete Crew
            </ButtonContent>
          </button>
        </>
      }
    >
      <p>
        Delete the entire Crew rooted at “{title}”? All descendant Sessions,
        their Auxiliary conversations, Coordination records, and Session Graph
        will be deleted. Workspaces are kept.
      </p>
      {loading ? <LoadingIndicator label="Checking Crew deletion" /> : null}
      {error ? <LoadError message={error} onRetry={retry} /> : null}
      {status?.blockers.length ? (
        <ul>
          {status.blockers.map((blocker) => (
            <li key={`${blocker.kind}:${blocker.id}`}>
              <p>{blocker.message}</p>
              {blocker.kind === "coordination" ? (
                <button
                  className="launch-toggle"
                  type="button"
                  onClick={() => void openBlocker(blocker)}
                >
                  Open Coordination
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && !error ? (
        <button className="launch-toggle" type="button" onClick={retry}>
          Refresh Deletion Status
        </button>
      ) : null}
    </LaunchDialogShell>,
    document.body,
  );
}
