import { useRef, useState } from "react";

import { useDialogA11y } from "../a11y.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import {
  detectShortcutPlatform,
  getShortcutHelpProjection,
  type ShortcutPlatform,
} from "../shortcut-registry.js";

export type KeyboardShortcutsDialogProps = {
  open: boolean;
  onClose: () => void;
  platform?: ShortcutPlatform;
};

export function KeyboardShortcutsHelpSection() {
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
      <KeyboardShortcutsDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

export function KeyboardShortcutsDialog({
  open,
  onClose,
  platform = detectShortcutPlatform(),
}: KeyboardShortcutsDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open,
    onClose,
    initialFocusRef: closeButtonRef,
  });

  if (!open) {
    return null;
  }

  const groups = getShortcutHelpProjection(platform);
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
          <p>Shortcuts are active while this WithMate window is focused.</p>
        </div>
        <div className="settings-keyboard-shortcuts-groups">
          {groups.map((group) => (
            <section key={group.scope} className="settings-keyboard-shortcuts-group" aria-labelledby={`shortcut-group-${group.scope}`}>
              <h3 id={`shortcut-group-${group.scope}`}>{group.scopeLabel}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={item.id} className="settings-keyboard-shortcut-row">
                    <dt>{item.label}</dt>
                    <dd>{item.acceleratorLabel}</dd>
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
