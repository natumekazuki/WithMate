import { useEffect, useRef, useState } from "react";

import { useDialogA11y } from "../ui/a11y.js";
import {
  captureShortcutAccelerator,
  DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  detectShortcutPlatform,
  getShortcutHelpProjection,
  getShortcutEntry,
  normalizeKeyboardShortcutSettings,
  ShortcutRegistryError,
  updateShortcutBinding,
  type KeyboardShortcutSettings,
  type ShortcutPlatform,
} from "./shortcut-registry.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";

/** ショートカット一覧の開閉、対象プラットフォーム、既存設定と任意の編集通知。 */
export type KeyboardShortcutsDialogProps = {
  open: boolean;
  onClose: () => void;
  platform?: ShortcutPlatform;
  settings?: KeyboardShortcutSettings;
  onChange?: (settings: KeyboardShortcutSettings) => void;
};

/** 設定のヘルプからショートカット一覧を開き、編集時は親の設定変更処理につなぐ。 */
export function KeyboardShortcutsHelpSection({
  settings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  onChange,
}: {
  settings?: KeyboardShortcutSettings;
  onChange?: (settings: KeyboardShortcutSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="settings-section-card settings-help-section" open>
      <summary>Help</summary>
      <div className="settings-field">
        <button
          className="launch-toggle"
          type="button"
          onClick={() => setOpen(true)}
        >
          Keyboard Shortcuts
        </button>
      </div>
      <KeyboardShortcutsDialog
        open={open}
        onClose={() => setOpen(false)}
        settings={settings}
        onChange={onChange}
      />
    </details>
  );
}

/** 現在のプラットフォームで有効なショートカットを一覧化する。変更通知がなければ閲覧専用にする。 */
export function KeyboardShortcutsDialog({
  open,
  onClose,
  platform = detectShortcutPlatform(),
  settings = DEFAULT_KEYBOARD_SHORTCUT_SETTINGS,
  onChange,
}: KeyboardShortcutsDialogProps) {
  const firstActionButtonRef = useRef<HTMLButtonElement | null>(null);
  const [capturingCommandId, setCapturingCommandId] = useState<string | null>(
    null,
  );
  const [captureError, setCaptureError] = useState("");
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: firstActionButtonRef,
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

    const effectiveSettings = normalizeKeyboardShortcutSettings(settings);
    /** 捕捉中のキーを既存ショートカットへ伝播させず、登録できる組み合わせだけを設定に反映する。 */
    const handleCaptureKeyDown = (event: KeyboardEvent) => {
      const result = captureShortcutAccelerator(event);
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "rejected") {
        setCaptureError(resolveCaptureErrorMessage(result.reason));
        return;
      }

      try {
        onChange(
          updateShortcutBinding(
            effectiveSettings,
            capturingCommandId,
            platform,
            result.accelerator,
          ),
        );
        setCapturingCommandId(null);
        setCaptureError("");
      } catch (error) {
        setCaptureError(resolveShortcutUpdateError(error));
      }
    };

    window.addEventListener("keydown", handleCaptureKeyDown, true);
    return () =>
      window.removeEventListener("keydown", handleCaptureKeyDown, true);
  }, [capturingCommandId, onChange, open, platform, settings]);

  if (!open) {
    return null;
  }

  const effectiveSettings = normalizeKeyboardShortcutSettings(settings);
  const groups = getShortcutHelpProjection(platform, effectiveSettings);
  const isEditable = onChange !== undefined;
  const firstActionId = isEditable
    ? groups
        .flatMap((group) => group.items)
        .find((item) => getShortcutEntry(item.id).customizable)?.id
    : undefined;
  return (
    <LaunchDialogShell
      onClose={onClose}
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      ariaLabel="Keyboard shortcuts"
      showDismissControl={false}
      dialogClassName="settings-keyboard-shortcuts-dialog"
    >
      <div className="settings-keyboard-shortcuts-content">
        <div className="settings-keyboard-shortcuts-head">
          <h2>Keyboard Shortcuts</h2>
          <p>Shortcuts are active while this WithMate window is focused.</p>
          {captureError ? (
            <p
              className="settings-feedback settings-keyboard-shortcuts-error"
              role="alert"
            >
              {captureError}
            </p>
          ) : null}
        </div>
        <div className="settings-keyboard-shortcuts-groups">
          {groups.map((group) => (
            <section
              key={group.scope}
              className="settings-keyboard-shortcuts-group"
              aria-labelledby={`shortcut-group-${group.scope}`}
            >
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
                            ref={
                              item.id === firstActionId
                                ? firstActionButtonRef
                                : undefined
                            }
                            className="launch-toggle compact"
                            type="button"
                            aria-pressed={capturingCommandId === item.id}
                            onClick={() => {
                              setCapturingCommandId(item.id);
                              setCaptureError("");
                            }}
                          >
                            {capturingCommandId === item.id
                              ? "PressKeys..."
                              : "Change"}
                          </button>
                          {effectiveSettings.overrides[item.id]?.[platform] ? (
                            <button
                              className="launch-toggle compact secondary"
                              type="button"
                              onClick={() => {
                                try {
                                  onChange?.(
                                    updateShortcutBinding(
                                      effectiveSettings,
                                      item.id,
                                      platform,
                                      null,
                                    ),
                                  );
                                  setCapturingCommandId(null);
                                  setCaptureError("");
                                } catch (error) {
                                  setCaptureError(
                                    resolveShortcutUpdateError(error),
                                  );
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

/** レジストリが拒否した組み合わせには競合を案内し、その他の失敗には登録不能と表示する。 */
function resolveShortcutUpdateError(error: unknown): string {
  if (error instanceof ShortcutRegistryError) {
    return "That key combination conflicts with another shortcut.";
  }
  return "That key combination cannot be registered.";
}

/** IME 入力や修飾キーのみなど、捕捉時に拒否された理由を利用者向けに説明する。 */
function resolveCaptureErrorMessage(
  reason: Exclude<
    ReturnType<typeof captureShortcutAccelerator>,
    { kind: "accepted" }
  >["reason"],
): string {
  switch (reason) {
    case "modifier-only":
      return "Modifier keys alone cannot be registered. Press a key after the modifier.";
    case "alt-graph":
      return "AltGraph combinations cannot be registered.";
    case "composing":
      return "Keys pressed while composing text cannot be registered.";
    case "repeat":
      return "Press the key once instead of holding it down.";
    case "dead-key":
      return "Dead keys cannot be registered.";
    case "process-key":
      return "The IME Process key cannot be registered.";
    case "empty-key":
      return "Could not read the key. Try again.";
    default:
      return "This key cannot be registered.";
  }
}
