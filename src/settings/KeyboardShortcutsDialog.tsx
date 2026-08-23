import { useEffect, useRef, useState } from "react";

import { useDialogA11y } from "../a11y.js";
import {
  captureShortcutAccelerator,
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  detectShortcutPlatform,
  getShortcutHelpProjection,
  getShortcutEntry,
  ShortcutRegistryError,
  updateShortcutBinding,
  type KeyboardShortcutSettings,
  type ShortcutPlatform,
} from "../shortcut-registry.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";

export type KeyboardShortcutsDialogProps = {
  open: boolean;
  onClose: () => void;
  platform?: ShortcutPlatform;
  settings?: KeyboardShortcutSettings;
  onChange?: (settings: KeyboardShortcutSettings) => void;
};

export function KeyboardShortcutsHelpSection({
  settings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  onChange,
}: {
  settings?: KeyboardShortcutSettings;
  onChange?: (settings: KeyboardShortcutSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="settings-section-card settings-help-section">
      <div className="settings-field">
        <strong>Help</strong>
        <p className="settings-help">ショートカットと発火する画面を確認できます。</p>
        <button className="launch-toggle" type="button" onClick={() => setOpen(true)}>
          Keyboard shortcuts
        </button>
      </div>
      <KeyboardShortcutsDialog
        open={open}
        onClose={() => setOpen(false)}
        settings={settings}
        onChange={onChange}
      />
    </section>
  );
}

export function KeyboardShortcutsDialog({
  open,
  onClose,
  platform = detectShortcutPlatform(),
  settings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  onChange,
}: KeyboardShortcutsDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [capturingCommandId, setCapturingCommandId] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState("");
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: closeButtonRef,
  });

  useEffect(() => {
    if (!open) {
      setCapturingCommandId(null);
      setCaptureError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !capturingCommandId || !onChange) {
      return undefined;
    }

    const handleCaptureKeyDown = (event: KeyboardEvent) => {
      const result = captureShortcutAccelerator(event);
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "rejected") {
        setCaptureError(resolveCaptureErrorMessage(result.reason));
        return;
      }

      try {
        onChange(updateShortcutBinding(settings, capturingCommandId, platform, result.accelerator));
        setCapturingCommandId(null);
        setCaptureError("");
      } catch (error) {
        setCaptureError(resolveShortcutUpdateError(error));
      }
    };

    window.addEventListener("keydown", handleCaptureKeyDown, true);
    return () => window.removeEventListener("keydown", handleCaptureKeyDown, true);
  }, [capturingCommandId, onChange, open, platform, settings]);

  if (!open) {
    return null;
  }

  const groups = getShortcutHelpProjection(platform, settings);
  const isEditable = onChange !== undefined;
  return (
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      ariaLabel="Keyboard shortcuts"
      showDismissControl={false}
      dialogClassName="settings-keyboard-shortcuts-dialog"
      footer={
        <button ref={closeButtonRef} className="launch-toggle" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="settings-keyboard-shortcuts-content">
        <div className="settings-keyboard-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <p>
            Shortcuts are active while this WithMate window is focused.
            {isEditable ? " Change を押して、登録したいキーを入力できます。" : ""}
          </p>
          {captureError ? <p className="settings-feedback settings-keyboard-shortcuts-error" role="alert">{captureError}</p> : null}
        </div>
        <div className="settings-keyboard-shortcuts-groups">
          {groups.map((group) => (
            <section key={group.scope} className="settings-keyboard-shortcuts-group" aria-labelledby={`shortcut-group-${group.scope}`}>
              <h3 id={`shortcut-group-${group.scope}`}>{group.scopeLabel}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.id} className="settings-keyboard-shortcut-row">
                    <dt>{item.label}</dt>
                    <dd>
                      <span>{item.acceleratorLabel}</span>
                      {isEditable && getShortcutEntry(item.id).customizable ? (
                        <span className="settings-keyboard-shortcut-actions">
                          <button
                            className="launch-toggle compact"
                            type="button"
                            aria-pressed={capturingCommandId === item.id}
                            onClick={() => {
                              setCapturingCommandId(item.id);
                              setCaptureError("");
                            }}
                          >
                            {capturingCommandId === item.id ? "Press keys..." : "Change"}
                          </button>
                          {settings.overrides[item.id]?.[platform] ? (
                            <button
                              className="launch-toggle compact secondary"
                              type="button"
                              onClick={() => {
                                try {
                                  onChange?.(updateShortcutBinding(settings, item.id, platform, null));
                                  setCapturingCommandId(null);
                                  setCaptureError("");
                                } catch (error) {
                                  setCaptureError(resolveShortcutUpdateError(error));
                                }
                              }}
                            >
                              Reset
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </LaunchDialogShell>
  );
}

function resolveShortcutUpdateError(error: unknown): string {
  if (error instanceof ShortcutRegistryError) {
    return "そのキーの組み合わせは、別のショートカットと重なるため登録できません。";
  }
  return "このキーの組み合わせは登録できません。";
}

function resolveCaptureErrorMessage(
  reason: Exclude<ReturnType<typeof captureShortcutAccelerator>, { kind: "accepted" }>["reason"],
): string {
  switch (reason) {
    case "modifier-only":
      return "Ctrl、Shift、Alt、Meta などの修飾キーだけでは登録できません。キーを続けて押してね。";
    case "alt-graph":
      return "AltGraph として扱われる組み合わせは登録できません。";
    case "composing":
      return "日本語入力中のキーは登録できません。";
    case "repeat":
      return "キーを長押しせず、一度だけ押してね。";
    case "dead-key":
      return "Dead key は登録できません。";
    case "process-key":
      return "IME の Process key は登録できません。";
    case "empty-key":
      return "キーを取得できませんでした。もう一度試してね。";
    default:
      return "このキーは登録できません。";
  }
}
