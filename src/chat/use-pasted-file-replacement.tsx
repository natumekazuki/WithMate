import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PastedSessionFileConflict } from "../../src-shared/window/withmate-window-types.js";
import type { PastedFileConflictDecision } from "./composer-paste-handlers.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../ui/a11y.js";

/** 同名で内容の異なる貼り付けファイルに対し、置換・別名保存・キャンセルを確認する。 */
function PastedFileReplacementDialog({
  fileName,
  onResolve,
}: {
  fileName: string;
  onResolve: (decision: PastedFileConflictDecision) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true,
    initialFocusRef: cancelRef,
    /** キーボードでダイアログを閉じた場合も貼り付けをキャンセルする。 */
    onClose: () => onResolve("cancel"),
  });
  return createPortal(
    <LaunchDialogShell
      ariaLabel="Replace Pasted File"
      className="launch-modal pasted-file-replacement-modal"
      dialogClassName="pasted-file-replacement-dialog"
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      onClose={() => onResolve("cancel")}
      showDismissControl={false}
      footer={
        <>
          <button
            ref={cancelRef}
            className="drawer-toggle compact secondary"
            type="button"
            onClick={() => onResolve("cancel")}
          >
            Cancel
          </button>
          <button
            className="drawer-toggle compact secondary"
            type="button"
            onClick={() => onResolve("copy")}
          >
            Save a Copy
          </button>
          <button
            className="drawer-toggle compact danger"
            type="button"
            onClick={() => onResolve("replace")}
          >
            Replace File
          </button>
        </>
      }
    >
      <h2>Replace File?</h2>
      <p>
        <strong>{fileName}</strong> has different contents.
      </p>
      <p>Replacing it changes the file used by earlier messages.</p>
    </LaunchDialogShell>,
    document.body,
  );
}

/** 貼り付けの確認と再利用通知を所有キーで分離し、対象の変更やアンマウントで未回答の確認をキャンセルする。 */
export function usePastedFileReplacement(
  ownerKey: string | null | undefined,
  available: boolean,
) {
  const pending = useRef<{
    resolve: (decision: PastedFileConflictDecision) => void;
  } | null>(null);
  const current = useRef({ ownerKey, available, mounted: true });
  current.current.ownerKey = ownerKey;
  current.current.available = available;
  const [conflict, setConflict] = useState<{
    ownerKey: typeof ownerKey;
    fileName: string;
  } | null>(null);
  const [notice, setNotice] = useState<{
    ownerKey: typeof ownerKey;
    fileNames: string[];
  } | null>(null);
  useEffect(() => {
    current.current.mounted = true;
    setConflict(null);
    setNotice(null);
    return () => {
      current.current.mounted = false;
      pending.current?.resolve("cancel");
      pending.current = null;
    };
  }, [ownerKey, available]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  /** 待機中の貼り付けに選択結果を返し、ダイアログを閉じる。 */
  const resolve = (decision: PastedFileConflictDecision) => {
    pending.current?.resolve(decision);
    pending.current = null;
    setConflict(null);
  };
  return {
    /** 現在の所有者にだけ確認を開く。古い呼び出しはキャンセルし、確認の重複は例外として扱う。 */
    confirmReplacement: (
      next: PastedSessionFileConflict,
    ): Promise<PastedFileConflictDecision> => {
      if (
        !current.current.mounted ||
        !current.current.available ||
        current.current.ownerKey !== ownerKey
      )
        return Promise.resolve("cancel");
      if (pending.current)
        throw new Error("Finish the current file replacement first.");
      setNotice(null);
      setConflict({ ownerKey, fileName: next.fileName });
      return new Promise((resolve) => {
        pending.current = { resolve };
      });
    },
    /** 内容が同一で再利用したファイル名を、現在の所有者にだけ一時表示する。 */
    notifyReuse: (fileNames: string[]) => {
      if (
        current.current.mounted &&
        current.current.available &&
        current.current.ownerKey === ownerKey
      ) {
        setNotice({ ownerKey, fileNames });
      }
    },
    reuseNotice:
      available && notice?.ownerKey === ownerKey && notice
        ? createPortal(
            <div
              className="message-copy-toast success pasted-file-reuse-notice"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              Identical File Reused: {notice.fileNames.join(", ")}
            </div>,
            document.body,
          )
        : null,
    replacementDialog:
      available && conflict?.ownerKey === ownerKey && conflict ? (
        <PastedFileReplacementDialog
          fileName={conflict.fileName}
          onResolve={resolve}
        />
      ) : null,
  };
}
