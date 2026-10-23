import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { getShortcutDispatcher, SHORTCUT_COMMAND_IDS } from "../../settings/shortcut-registry.js";
import { ComposerAttachmentMenu } from "../composer-attachment-menu.js";
import { collectPastedClipboardFiles, collectPastedSessionAttachments } from "../composer-paste-handlers.js";
import {
  buildComposerReferenceInsertionState,
  pickComposerReferencePath,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "../composer/session-composer-paths.js";

type QuestionAnswerEditorProps = {
  label: string;
  describedBy?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
  sessionId?: string;
  workspacePath?: string | null;
  attachmentTarget: HTMLElement | null;
  attachmentLabel?: string;
};

export function QuestionAnswerEditor({
  label, describedBy, value, onChange, onSubmit, onBusyChange, disabled, sessionId, workspacePath,
  attachmentTarget, attachmentLabel,
}: QuestionAnswerEditorProps) {
  const api = getWithMateApi();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const operationRef = useRef<object | null>(null);
  const current = useRef({ disabled, onChange, onBusyChange });
  current.current = { disabled, onChange, onBusyChange };
  const composing = useRef(false);
  const pickerDirectory = useRef<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setMenuOpen(false); }, [attachmentTarget]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (operationRef.current) current.current.onBusyChange(false);
      operationRef.current = null;
    };
  }, []);

  const attach = async (load: (isCurrent: () => boolean) => Promise<ComposerReferenceInput[]>) => {
    if (current.current.disabled || operationRef.current || !sessionId || !api) return;
    const operation = {};
    operationRef.current = operation;
    const isCurrent = () => mounted.current && operationRef.current === operation && !current.current.disabled;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    setError("");
    setBusy(true);
    current.current.onBusyChange(true);
    try {
      const references = await load(isCurrent);
      if (!isCurrent()) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const insertion = buildComposerReferenceInsertionState(textarea.value, caret, references);
      if (insertion) current.current.onChange(insertion.draft);
      window.requestAnimationFrame(() => {
        if (!mounted.current || current.current.disabled || textareaRef.current !== textarea) return;
        textarea.focus();
        const nextCaret = insertion?.caret ?? caret;
        textarea.setSelectionRange(nextCaret, nextCaret);
      });
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : "Could not attach the file.");
    } finally {
      if (mounted.current && operationRef.current === operation) {
        operationRef.current = null;
        setBusy(false);
        current.current.onBusyChange(false);
      }
    }
  };

  const pathReferences = (paths: readonly string[]): ComposerReferenceInput[] => paths.map((path) => ({ path, presentation: "path" }));
  const pickOriginal = (kind: ComposerPathPickerKind) => void attach(async (isCurrent) => {
    const path = await pickComposerReferencePath(kind, pickerDirectory.current ?? workspacePath ?? null, api!);
    if (!path || !isCurrent()) return [];
    pickerDirectory.current = resolvePickedPathBaseDirectory(kind, path);
    return pathReferences([path]);
  });

  return (
    <div className="question-answer-editor" aria-busy={busy || undefined}>
      <textarea
        ref={textareaRef}
        rows={3}
        aria-label={label}
        aria-describedby={describedBy}
        data-shortcut-scope="question-answer"
        value={value}
        disabled={disabled || busy}
        onChange={(event) => { setError(""); onChange(event.target.value); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.keyCode === 229) return;
          if (!getShortcutDispatcher()?.matchesCommandShortcut(SHORTCUT_COMMAND_IDS.composerSubmit, event.nativeEvent)) return;
          event.preventDefault();
          event.stopPropagation();
          if (!current.current.disabled && !operationRef.current) onSubmit();
        }}
        onPaste={(event) => {
          if (!collectPastedClipboardFiles(event.clipboardData).length) return;
          event.preventDefault();
          if (!api || !sessionId) {
            setError("File attachments are unavailable for this session.");
            return;
          }
          const clipboardData = event.clipboardData;
          void attach((isCurrent) => collectPastedSessionAttachments({
            clipboardData,
            preventDefault() {},
            sessionId,
            currentTimestampLabel: () => new Date().toISOString(),
            savePastedSessionFile: (request) => {
              if (!isCurrent()) throw new Error("The input request is no longer available.");
              return api.savePastedSessionFile(request);
            },
          }));
        }}
      />
      {sessionId && api && attachmentTarget ? createPortal(<>
        <ComposerAttachmentMenu
          targetLabel={attachmentLabel}
          disabled={disabled || busy}
          busy={busy}
          isOpen={menuOpen}
          onOpenChange={setMenuOpen}
          onPickFile={() => pickOriginal("file")}
          onPickFolder={() => pickOriginal("folder")}
          onPickImage={() => pickOriginal("image")}
          onAddToSessionFiles={() => void attach(async (isCurrent) => {
            const paths = await api.pickFiles(pickerDirectory.current ?? workspacePath ?? null);
            if (!paths.length || !isCurrent()) return [];
            pickerDirectory.current = resolvePickedPathBaseDirectory("file", paths[0]!);
            return pathReferences(await api.copyFilesToSessionFiles(sessionId, paths));
          })}
          onPickSessionFiles={() => void attach(async () => pathReferences(await api.pickSessionFiles(sessionId)))}
          onPickSessionFolder={() => void attach(async () => {
            const path = await api.pickSessionFolder(sessionId);
            return pathReferences(path ? [path] : []);
          })}
          onPickSessionImage={() => void attach(async () => {
            const path = await api.pickSessionImageFile(sessionId);
            return pathReferences(path ? [path] : []);
          })}
        />
        {attachmentLabel ? <span className="question-answer-attachment-label" title={attachmentLabel}>{attachmentLabel}</span> : null}
      </>, attachmentTarget) : null}
      {busy ? <span className="visually-hidden" role="status">Attaching files</span> : null}
      {error ? <p className="live-approval-warning" role="alert">{error}</p> : null}
    </div>
  );
}
