import { useEffect, useId, useRef, useState } from "react";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import type {
  SessionFolderCleanupRequest,
  SessionFolderCleanupScan,
  SessionFolderCleanupResult,
  SessionFolderCleanupIssue,
} from "../../src-shared/session/session-folder-cleanup.js";
import { parseSessionFolderCleanupRequest } from "../../src-shared/session/session-folder-cleanup.js";
import { ButtonContent } from "../ui/button-content.js";
import { useDialogA11y } from "../ui/a11y.js";
import { SettingsActionButton } from "./SettingsActionButton.js";

export type SessionFolderCleanupApi = {
  scanSessionFolderCleanup(request: SessionFolderCleanupRequest): Promise<SessionFolderCleanupScan>;
  runSessionFolderCleanup(request: { scanId: string }): Promise<SessionFolderCleanupResult>;
};

const numberFormat = new Intl.NumberFormat("en-US");
export function formatCleanupBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: index === 0 ? 0 : 2 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

function issueText(issues: readonly SessionFolderCleanupIssue[]): string {
  return issues.filter((issue) => issue.kind === "failed").map((issue) => `${issue.relativePath || issue.sessionId}: ${issue.message}`).join("\n");
}

function periodLabel(request: SessionFolderCleanupRequest): string {
  if (!request.fromDate && !request.toDate) return "All Dates";
  if (!request.fromDate) return `Through ${request.toDate}`;
  if (!request.toDate) return `From ${request.fromDate}`;
  return `${request.fromDate} – ${request.toDate}`;
}

function CleanupConfirmation({ scan, onCancel, onConfirm, onRestoreFocus }: {
  scan: SessionFolderCleanupScan;
  onCancel(): void;
  onConfirm(): void;
  onRestoreFocus(): void;
}) {
  const { dialogRef: dialog, handleDialogKeyDown } = useDialogA11y<HTMLDialogElement>({ open: true, onClose: onCancel });
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); onRestoreFocus(); };
  }, []);
  return (
    <dialog ref={dialog} className="session-folder-cleanup-confirm" aria-labelledby={titleId}
      onKeyDown={handleDialogKeyDown}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id={titleId}>Delete Session Files?</h2>
      <p className="session-folder-cleanup-confirm-count">
        {numberFormat.format(scan.matchedFileCount)} Files · {formatCleanupBytes(scan.matchedBytes)}
      </p>
      <p className="session-folder-cleanup-secondary">
        {periodLabel(scan.request)} · ≥ {scan.request.minimumFileSizeMiB} MiB
      </p>
      <footer>
        <button className="launch-toggle secondary" type="button" autoFocus onClick={onCancel}>Cancel</button>
        <button className="launch-toggle session-folder-cleanup-delete" type="button" onClick={onConfirm}>Permanently Delete</button>
      </footer>
    </dialog>
  );
}

export function SessionFolderCleanup({ api = getWithMateApi(), disabled = false, onBusyChange }: {
  api?: SessionFolderCleanupApi | null;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const id = useId();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [allDates, setAllDates] = useState(false);
  const [minimumSize, setMinimumSize] = useState("0");
  const [scan, setScan] = useState<SessionFolderCleanupScan | null>(null);
  const [result, setResult] = useState<SessionFolderCleanupResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "scanning" | "deleting">("idle");
  const [confirming, setConfirming] = useState(false);
  const [validation, setValidation] = useState("");
  const [scanError, setScanError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const operation = useRef(0);
  const inFlight = useRef(false);
  const deleteButton = useRef<HTMLDivElement>(null);
  const busy = phase !== "idle";

  useEffect(() => () => { operation.current += 1; }, []);
  useEffect(() => {
    onBusyChange?.(busy || confirming);
    return () => onBusyChange?.(false);
  }, [busy, confirming, onBusyChange]);

  const edit = (update: () => void) => {
    update();
    setScan(null);
    setResult(null);
    setValidation("");
    setScanError("");
    setDeleteError("");
  };
  const calculate = async () => {
    if (!api || inFlight.current || disabled) return;
    let request: SessionFolderCleanupRequest;
    try {
      if (!allDates && !fromDate && !toDate) throw new Error("Choose a date range or All Dates.");
      if (!minimumSize.trim()) throw new Error("Enter a minimum file size.");
      request = parseSessionFolderCleanupRequest({
        fromDate: allDates ? "" : fromDate,
        toDate: allDates ? "" : toDate,
        minimumFileSizeMiB: Number(minimumSize),
      });
    } catch (error) {
      setValidation(error instanceof Error ? error.message : String(error));
      return;
    }
    const token = ++operation.current;
    inFlight.current = true;
    setPhase("scanning");
    setScan(null);
    setResult(null);
    setValidation("");
    setScanError("");
    setDeleteError("");
    try {
      const next = await api.scanSessionFolderCleanup(request);
      if (token === operation.current) setScan(next);
    } catch (error) {
      if (token === operation.current) setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === operation.current) { inFlight.current = false; setPhase("idle"); }
    }
  };
  const run = async () => {
    if (!api || !scan || inFlight.current || disabled) return;
    const token = ++operation.current;
    inFlight.current = true;
    setConfirming(false);
    setPhase("deleting");
    setDeleteError("");
    try {
      const next = await api.runSessionFolderCleanup({ scanId: scan.scanId });
      if (token === operation.current) setResult(next);
    } catch (error) {
      if (token === operation.current) setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (token === operation.current) { inFlight.current = false; setScan(null); setPhase("idle"); }
    }
  };
  const skippedSessions = scan ? [
    scan.skippedRunningSessionCount ? `${numberFormat.format(scan.skippedRunningSessionCount)} Running` : "",
    scan.skippedWorkspaceSessionCount ? `${numberFormat.format(scan.skippedWorkspaceSessionCount)} Workspace` : "",
    scan.skippedLinkCount ? `${numberFormat.format(scan.skippedLinkCount)} Links` : "",
  ].filter(Boolean) : [];

  return (
    <div className="session-folder-cleanup" aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h3 id={`${id}-title`}>Clean Session Files</h3>
      <fieldset disabled={busy || disabled || !api} className="session-folder-cleanup-fields">
        <legend>Last Active</legend>
        <div className="session-folder-cleanup-dates">
          <label className="settings-provider-input" htmlFor={`${id}-from`}>
            <span>From</span>
            <input id={`${id}-from`} type="date" value={fromDate} disabled={allDates}
              onChange={(event) => edit(() => setFromDate(event.target.value))} />
          </label>
          <label className="settings-provider-input" htmlFor={`${id}-through`}>
            <span>Through</span>
            <input id={`${id}-through`} type="date" value={toDate} disabled={allDates}
              onChange={(event) => edit(() => setToDate(event.target.value))} />
          </label>
          <label className="session-folder-cleanup-all-dates">
            <input type="checkbox" checked={allDates} onChange={(event) => edit(() => setAllDates(event.target.checked))} />
            <span>All Dates</span>
          </label>
        </div>
        <div className="session-folder-cleanup-size-row">
          <label className="settings-provider-input" htmlFor={`${id}-minimum`}>
            <span>Min File Size (MiB)</span>
            <input id={`${id}-minimum`} type="number" min="0" step="any" value={minimumSize}
              onChange={(event) => edit(() => setMinimumSize(event.target.value))} />
          </label>
          <SettingsActionButton actionLabel="Calculate Session File Usage" failure={scanError || (scan ? issueText(scan.issues) : "")}
            className="launch-toggle secondary" type="button" onClick={() => void calculate()}
            disabled={busy || disabled || !api} aria-busy={phase === "scanning"}>
            <ButtonContent busy={phase === "scanning"} busyLabel="Calculating session file usage.">Calculate</ButtonContent>
          </SettingsActionButton>
        </div>
      </fieldset>
      <div className="session-folder-cleanup-feedback" aria-live="polite" aria-atomic="true">
        {validation ? <p className="session-folder-cleanup-error" role="alert">{validation}</p> : null}
        {scanError ? <p className="session-folder-cleanup-error">Calculation Failed</p> : null}
        {scan ? <>
          <dl className="session-folder-cleanup-summary">
            <div><dt>Session Folders</dt><dd>{numberFormat.format(scan.sessionCount)}</dd></div>
            <div><dt>Total Size</dt><dd>{formatCleanupBytes(scan.totalBytes)}</dd></div>
            <div className="session-folder-cleanup-target"><dt>To Delete</dt><dd>{formatCleanupBytes(scan.matchedBytes)} <small>· {numberFormat.format(scan.matchedFileCount)} Files</small></dd></div>
          </dl>
          {skippedSessions.length ? <p className="session-folder-cleanup-secondary">Skipped: {skippedSessions.join(" · ")}</p> : null}
          {scan.issues.length ? <p className="session-folder-cleanup-error">Some Files Could Not Be Read</p> : null}
        </> : null}
        {result ? <>
          <p>{numberFormat.format(result.deletedFileCount)} Files Deleted · {formatCleanupBytes(result.deletedBytes)}</p>
          {result.skippedFileCount ? <p className="session-folder-cleanup-secondary">{numberFormat.format(result.skippedFileCount)} Files Skipped</p> : null}
          {result.failedFileCount ? <p className="session-folder-cleanup-error">{numberFormat.format(result.failedFileCount)} Files Failed</p>
            : result.issues.some((issue) => issue.kind === "failed") ? <p className="session-folder-cleanup-error">Cleanup Incomplete</p> : null}
        </> : null}
        {deleteError ? <p className="session-folder-cleanup-error">Deletion Failed · Calculate Again</p> : null}
      </div>
      <div ref={deleteButton} className="session-folder-cleanup-actions">
        <SettingsActionButton actionLabel="Delete Session Files" failure={deleteError || (result ? issueText(result.issues) : "")}
          className="launch-toggle session-folder-cleanup-delete" type="button"
          disabled={busy || disabled || !scan || scan.matchedFileCount === 0}
          aria-busy={phase === "deleting"} onClick={() => setConfirming(true)}>
          <ButtonContent busy={phase === "deleting"} busyLabel="Deleting session files.">Delete Files…</ButtonContent>
        </SettingsActionButton>
      </div>
      {confirming && scan ? <CleanupConfirmation scan={scan}
        onCancel={() => setConfirming(false)}
        onRestoreFocus={() => deleteButton.current?.querySelector("button")?.focus()}
        onConfirm={() => void run()} /> : null}
    </div>
  );
}
