import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  SESSION_INSTRUCTIONS_MAX_BYTES,
  sessionInstructionsByteLength,
  type SessionInstructionsTarget,
} from "../../../src-shared/session/session-instructions.js";
import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../../ui/a11y.js";
import { ButtonContent } from "../../ui/button-content.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

type InstructionsControlProps = {
  api: Pick<WithMateWindowApi, "getSessionInstructions" | "setSessionInstructions">;
  target: SessionInstructionsTarget;
  title: string;
};

/** 対象一つ分のエディターを持つ。完全な識別情報をキーにし、対象が変われば以前のエディターを破棄する。 */
export function SessionInstructionsControl(props: InstructionsControlProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="composer-instructions-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Instructions
      </button>
      {open ? createPortal(<SessionInstructionsDialog {...props} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

/** 本文なしは読み取りがまだ成功していないことを示し、空の値が保存されていることとは区別する。 */
type InstructionRead = { status: "loading" | "failed" } | { status: "loaded"; body: string };

/** 開いたときに読み取り、キャンセルまたは保存が確認されるまで独立した下書きを編集する。 */
function SessionInstructionsDialog({ api, target, title, onClose }: InstructionsControlProps & { onClose: () => void }) {
  const [read, setRead] = useState<InstructionRead>({ status: "loading" });
  const [readAttempt, setReadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const mounted = useRef(false);
  const pendingSave = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  const counterId = useId();
  const limitErrorId = useId();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const closeUnlessSaving = () => {
    // キャンセルは編集を破棄するが、送信済みの置き換えは取り消せない。
    if (!pendingSave.current) onClose();
  };
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true, onClose: closeUnlessSaving, initialFocusRef: inputRef,
  });

  // 開いたときに対象を一度だけ確定し、表示中の Session の投影が更新されても取り直さない。
  const [openedTarget] = useState(target);
  useEffect(() => {
    let current = true;
    void api.getSessionInstructions(openedTarget).then((body) => {
      if (current) setRead({ status: "loaded", body });
    }, () => {
      if (current) setRead({ status: "failed" });
    });
    return () => { current = false; };
  }, [api, openedTarget, readAttempt]);

  const bytes = read.status === "loaded" ? sessionInstructionsByteLength(read.body) : null;
  const overLimit = bytes !== null && bytes > SESSION_INSTRUCTIONS_MAX_BYTES;

  /** 指定した置換を一度だけ送り、その処理を開始したエディターだけを更新する。 */
  const save = async () => {
    // イベントが重複して処理されないよう、描画済みボタンの状態とは別に検査する。
    if (read.status !== "loaded" || overLimit || pendingSave.current) return;
    pendingSave.current = true;
    setSaving(true);
    setSaveFailed(false);
    inputRef.current?.focus();
    try {
      await api.setSessionInstructions(openedTarget, read.body);
      if (mounted.current) onClose();
    } catch {
      // 修正や再試行に備え、下書き全体を保持する。
      if (mounted.current) setSaveFailed(true);
    } finally {
      pendingSave.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <LaunchDialogShell
      dialogRef={dialogRef}
      dialogTabIndex={-1}
      className="launch-modal session-instructions-modal"
      dialogClassName="session-instructions-dialog"
      ariaLabelledBy={headingId}
      showDismissControl={false}
      closeOnBackdropClick={false}
      onClose={closeUnlessSaving}
      onKeyDown={(event) => {
        // テキスト入力を妨げず、モーダル内の操作で Session のショートカットが発火しないようにする。
        event.stopPropagation();
        if (!event.nativeEvent.isComposing) handleDialogKeyDown(event);
      }}
      footer={
        <>
          <button type="button" className="drawer-toggle compact secondary" disabled={saving} onClick={closeUnlessSaving}>Cancel</button>
          <button
            type="button" className="start-session-button" disabled={read.status !== "loaded" || overLimit || saving}
            aria-busy={saving || undefined} onClick={() => void save()}
          >
            <ButtonContent busy={saving} busyLabel="Saving Instructions">Save</ButtonContent>
          </button>
        </>
      }
    >
      <div className="session-instructions-editor">
        <header>
          <h2 id={headingId}>Session Instructions</h2>
          <p className="session-instructions-target">{title}</p>
        </header>
        <textarea
          ref={inputRef}
          className="session-instructions-body"
          aria-label="Instructions"
          aria-describedby={overLimit ? `${counterId} ${limitErrorId}` : counterId}
          aria-invalid={overLimit || undefined}
          aria-busy={read.status === "loading" || undefined}
          readOnly={read.status !== "loaded" || saving}
          value={read.status === "loaded" ? read.body : ""}
          onChange={(event) => {
            setRead({ status: "loaded", body: event.target.value });
            setSaveFailed(false);
          }}
          spellCheck={false}
        />
        <div className="session-instructions-meta">
          <div className="session-instructions-feedback">
            {read.status === "loading" ? <LoadingIndicator label="Loading Instructions" inline /> : null}
            {read.status === "failed" ? <>
              <span role="alert">Load Failed</span>
              <button type="button" className="drawer-toggle compact secondary" onClick={() => {
                inputRef.current?.focus();
                setRead({ status: "loading" });
                setReadAttempt((attempt) => attempt + 1);
              }}>Retry</button>
            </> : null}
            {overLimit ? <span id={limitErrorId} role="alert">Byte Limit Exceeded</span> : null}
            {saveFailed ? <span role="alert">Save Failed</span> : null}
          </div>
          <span id={counterId} className="session-instructions-counter">{bytes?.toLocaleString("en-US") ?? "—"} / {SESSION_INSTRUCTIONS_MAX_BYTES.toLocaleString("en-US")} bytes</span>
        </div>
      </div>
    </LaunchDialogShell>
  );
}
