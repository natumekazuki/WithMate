import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from "react";

import type { ComposerPreview } from "../../src-shared/session/runtime-state.js";
import { createEmptyComposerPreview } from "../composer-preview-config.js";

export type ComposerOwnerKind = "main" | "auxiliary";
export type ComposerOwner = Readonly<{ kind: ComposerOwnerKind; id: string }>;
export type ComposerSelection = Readonly<{ start: number; end: number }>;
export type ComposerSaveState = "idle" | "saving" | "saved" | "error";

export type ComposerControllerState = {
  owner: ComposerOwner;
  draft: string;
  revision: number;
  selection: ComposerSelection;
  isImeComposing: boolean;
  preview: ComposerPreview;
  saveState: ComposerSaveState;
  saveError: string | null;
};

export type ComposerDraftCapture = Pick<ComposerControllerState, "owner" | "draft" | "revision">;

type Listener = () => void;
type Entry = ComposerControllerState & {
  listeners: Set<Listener>;
};

function ownerKey(owner: ComposerOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function clampSelection(selection: ComposerSelection, draft: string): ComposerSelection {
  const max = draft.length;
  const start = Math.max(0, Math.min(max, selection.start));
  const end = Math.max(start, Math.min(max, selection.end));
  return { start, end };
}

export class ComposerControllerRegistry {
  private readonly entries = new Map<string, Entry>();
  private frozen = false;

  get isFrozen(): boolean { return this.frozen; }
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.notifyEntries();
  }
  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.notifyEntries();
  }

  private notifyEntries(): void {
    this.entries.forEach((current, key) => {
      const entry: Entry = { ...current, listeners: current.listeners };
      this.entries.set(key, entry);
      entry.listeners.forEach((listener) => listener());
    });
  }

  get(owner: ComposerOwner, initialDraft = ""): ComposerControllerState {
    const key = ownerKey(owner);
    const existing = this.entries.get(key);
    if (existing) {
      return existing;
    }
    const entry: Entry = {
      owner,
      draft: initialDraft,
      revision: 0,
      selection: { start: initialDraft.length, end: initialDraft.length },
      isImeComposing: false,
      preview: createEmptyComposerPreview(),
      saveState: "idle",
      saveError: null,
      listeners: new Set(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  hydrateIfUnedited(owner: ComposerOwner, draft: string): boolean {
    const current = this.get(owner);
    if (current.revision !== 0 || current.draft === draft) return false;
    const currentEntry = this.entries.get(ownerKey(owner)) as Entry;
    const entry: Entry = { ...currentEntry, listeners: currentEntry.listeners };
    entry.draft = draft;
    entry.selection = { start: draft.length, end: draft.length };
    entry.preview = createEmptyComposerPreview();
    this.entries.set(ownerKey(owner), entry);
    entry.listeners.forEach((listener) => listener());
    return true;
  }

  subscribe(owner: ComposerOwner, listener: Listener, initialDraft = ""): () => void {
    const entry = this.get(owner, initialDraft) as Entry;
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  private update(owner: ComposerOwner, updater: (entry: Entry) => void): void {
    const current = this.get(owner) as Entry;
    const entry: Entry = { ...current, listeners: current.listeners };
    updater(entry);
    this.entries.set(ownerKey(owner), entry);
    entry.listeners.forEach((listener) => listener());
  }

  private setDraftInternal(
    owner: ComposerOwner,
    draft: string,
    selection?: ComposerSelection,
    allowWhileFrozen = false,
  ): number {
    const current = this.get(owner);
    if (this.frozen && !allowWhileFrozen) return current.revision;
    const nextSelection = clampSelection(selection ?? current.selection, draft);
    if (
      current.draft === draft
      && current.selection.start === nextSelection.start
      && current.selection.end === nextSelection.end
    ) {
      return current.revision;
    }
    let revision = 0;
    this.update(owner, (entry) => {
      entry.draft = draft;
      entry.revision += 1;
      entry.selection = nextSelection;
      entry.preview = createEmptyComposerPreview();
      entry.saveState = "idle";
      entry.saveError = null;
      revision = entry.revision;
    });
    return revision;
  }

  setDraft(owner: ComposerOwner, draft: string, selection?: ComposerSelection): number {
    return this.setDraftInternal(owner, draft, selection);
  }

  replaceDraft(owner: ComposerOwner, draft: string, selection?: ComposerSelection): number {
    return this.setDraft(owner, draft, selection);
  }

  clearDraft(owner: ComposerOwner): number {
    return this.setDraft(owner, "", { start: 0, end: 0 });
  }

  clearIfRevision(owner: ComposerOwner, expectedRevision: number): number | null {
    if (this.get(owner).revision !== expectedRevision) return null;
    return this.clearDraft(owner);
  }

  restoreIfRevision(
    owner: ComposerOwner,
    expectedRevision: number,
    update: (currentDraft: string) => string,
  ): number | null {
    const current = this.get(owner);
    if (current.revision !== expectedRevision) return null;
    // Failure recovery is an internal mutation: it must still restore the
    // captured draft when shutdown has frozen user edits.
    return this.setDraftInternal(owner, update(current.draft), current.selection, true);
  }

  setSelection(owner: ComposerOwner, selection: SetStateAction<ComposerSelection>): void {
    if (this.frozen) return;
    const current = this.get(owner);
    const next = typeof selection === "function" ? selection(current.selection) : selection;
    const clamped = clampSelection(next, current.draft);
    if (current.selection.start === clamped.start && current.selection.end === clamped.end) return;
    this.update(owner, (entry) => {
      entry.selection = clamped;
    });
  }

  setImeComposing(owner: ComposerOwner, isImeComposing: boolean): void {
    if (this.frozen) return;
    if (this.get(owner).isImeComposing === isImeComposing) return;
    this.update(owner, (entry) => {
      entry.isImeComposing = isImeComposing;
    });
  }

  setPreview(owner: ComposerOwner, preview: SetStateAction<ComposerPreview>): void {
    if (this.frozen) return;
    const current = this.get(owner);
    const next = typeof preview === "function" ? preview(current.preview) : preview;
    if (Object.is(current.preview, next)) return;
    this.update(owner, (entry) => {
      entry.preview = next;
    });
  }

  setSaveState(owner: ComposerOwner, saveState: ComposerSaveState, saveError: string | null = null): void {
    const current = this.get(owner);
    if (current.saveState === saveState && current.saveError === saveError) return;
    this.update(owner, (entry) => {
      entry.saveState = saveState;
      entry.saveError = saveError;
    });
  }

  capture(owner: ComposerOwner): ComposerDraftCapture {
    const entry = this.get(owner);
    return { owner: entry.owner, draft: entry.draft, revision: entry.revision };
  }

  discardOwner(owner: ComposerOwner): void {
    this.entries.delete(ownerKey(owner));
  }

  resetPreview(owner: ComposerOwner): void {
    this.setPreview(owner, createEmptyComposerPreview());
  }
}

export const composerControllerRegistry = new ComposerControllerRegistry();

export function useComposerController(
  owner: ComposerOwner,
  initialDraft = "",
  registry: ComposerControllerRegistry = composerControllerRegistry,
) {
  const key = ownerKey(owner);
  const subscribe = useCallback(
    (listener: Listener) => registry.subscribe(owner, listener, initialDraft),
    [key, owner, initialDraft, registry],
  );
  const getSnapshot = useCallback(
    () => registry.get(owner, initialDraft),
    [key, owner, initialDraft, registry],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => ({
    ...state,
    setDraft: (draft: string, selection?: ComposerSelection) => registry.setDraft(owner, draft, selection),
    replaceDraft: (draft: string, selection?: ComposerSelection) => registry.replaceDraft(owner, draft, selection),
    clearDraft: () => registry.clearDraft(owner),
    setSelection: (selection: SetStateAction<ComposerSelection>) => registry.setSelection(owner, selection),
    setImeComposing: (value: boolean) => registry.setImeComposing(owner, value),
    setPreview: (preview: SetStateAction<ComposerPreview>) => registry.setPreview(owner, preview),
    setSaveState: (value: ComposerSaveState, error?: string | null) => registry.setSaveState(owner, value, error),
    capture: () => registry.capture(owner),
  }), [owner, registry, state]);
}
