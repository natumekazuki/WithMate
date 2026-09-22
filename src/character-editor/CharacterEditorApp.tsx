import { useEffect, useMemo, useRef, useState } from "react";

import type { CharacterDetail, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { parseCharacterDefinitionMarkdown } from "../../src-shared/character/character-definition.js";
import { buildCharacterRuntimePromptSection } from "../../src-shared/character/character-runtime-snapshot.js";
import {
  buildCharacterEditorValidationSummary,
  buildCreateCharacterInputFromDraft,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  formatCharacterEditorError,
  getCharacterIconDraftValidationMessage,
  areCharacterEditorDraftsEqual,
  isCharacterEditorDraftDirty,
  reconcileCharacterEditorDraftAfterSave,
  replaceCharacterDefinitionDraft,
  resolveCharacterDefinitionMetadata,
  shouldBlockCharacterEditorBeforeUnload,
  type CharacterEditorDraft,
  type CharacterEditorTab,
  updateCharacterEditorDraft,
} from "./character-editor-state.js";
import { useDialogA11y } from "../ui/a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "../launch/provider-launch-picker.js";
import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "../app/renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import { CharacterAvatar } from "../ui/ui-utils.js";

function getCharacterEditorCharacterIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const characterId = new URLSearchParams(window.location.search).get("characterId")?.trim() ?? "";
  return characterId || null;
}

function buildPreviewRuntimeSnapshot(draft: CharacterEditorDraft): CharacterRuntimeSnapshot {
  return {
    characterId: draft.characterId ?? "preview-character",
    name: draft.name,
    description: draft.description,
    iconFilePath: draft.iconFilePath,
    theme: draft.theme,
    definitionMarkdown: draft.definitionMarkdown,
    definitionSha256: "",
    definitionByteSize: new TextEncoder().encode(draft.definitionMarkdown).byteLength,
    snapshotAt: new Date().toISOString(),
  };
}

function listEnabledAuthoringProviders(
  modelCatalog: ModelCatalogSnapshot | null,
  appSettings: AppSettings | null,
): ModelCatalogProvider[] {
  if (!modelCatalog || !appSettings) {
    return [];
  }

  return modelCatalog.providers.filter((provider) => getProviderAppSettings(appSettings, provider.id).enabled);
}

function resolveAuthoringProvider(
  providers: readonly ModelCatalogProvider[],
  providerId: string,
): ModelCatalogProvider | null {
  return providers.find((provider) => provider.id === providerId) ??
    providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ??
    providers[0] ??
    null;
}

export default function CharacterEditorApp() {
  const desktopRuntime = isDesktopRuntime();
  const initialCharacterId = useMemo(() => getCharacterEditorCharacterIdFromLocation(), []);
  const [persistedDetail, setPersistedDetail] = useState<CharacterDetail | null>(null);
  const [draft, setDraft] = useState<CharacterEditorDraft>(() => createNewCharacterEditorDraft());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [authoringProviderId, setAuthoringProviderId] = useState(DEFAULT_PROVIDER_ID);
  const [authoringLaunchOpen, setAuthoringLaunchOpen] = useState(false);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState<CharacterEditorTab>("profile");
  const [loading, setLoading] = useState(Boolean(initialCharacterId));
  const [saving, setSaving] = useState(false);
  const [authoringStarting, setAuthoringStarting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const draftRef = useRef(draft);
  const definitionImportInputRef = useRef<HTMLInputElement | null>(null);
  const notesImportInputRef = useRef<HTMLInputElement | null>(null);
  const authoringStartButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeConfirmationCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const authoringRefreshPendingRef = useRef(false);
  const confirmedCloseRef = useRef(false);

  draftRef.current = draft;

  const validation = useMemo(() => buildCharacterEditorValidationSummary(draft), [draft]);
  const iconValidationMessage = useMemo(
    () => getCharacterIconDraftValidationMessage(draft.iconFilePath, persistedDetail?.iconFilePath),
    [draft.iconFilePath, persistedDetail?.iconFilePath],
  );
  const dirty = isCharacterEditorDraftDirty(draft, persistedDetail);
  const archived = draft.state === "archived";
  const enabledAuthoringProviders = useMemo(
    () => listEnabledAuthoringProviders(modelCatalog, appSettings),
    [appSettings, modelCatalog],
  );
  const selectedAuthoringProvider = useMemo(
    () => resolveAuthoringProvider(enabledAuthoringProviders, authoringProviderId),
    [authoringProviderId, enabledAuthoringProviders],
  );
  const authoringProviderSelectionReady = !desktopRuntime || (!!modelCatalog && !!appSettings);
  const authoringProviderBlocked = desktopRuntime && authoringProviderSelectionReady && enabledAuthoringProviders.length === 0;
  const authoringLaunchFeedback = !authoringProviderSelectionReady
    ? ""
    : authoringProviderBlocked
      ? "Enable a coding agent provider in Settings."
      : feedback;
  const {
    dialogRef: authoringDialogRef,
    handleDialogKeyDown: handleAuthoringDialogKeyDown,
  } = useDialogA11y<HTMLElement>({
    open: authoringLaunchOpen,
    onClose: () => setAuthoringLaunchOpen(false),
    initialFocusRef: authoringStartButtonRef,
  });
  const {
    dialogRef: closeConfirmationDialogRef,
    handleDialogKeyDown: handleCloseConfirmationDialogKeyDown,
  } = useDialogA11y<HTMLElement>({
    open: closeConfirmationOpen,
    onClose: () => setCloseConfirmationOpen(false),
    initialFocusRef: closeConfirmationCancelButtonRef,
  });
  const denseEditorBody = selectedTab === "definition" || selectedTab === "notes" || selectedTab === "preview";
  const themeStyle = useMemo(() => buildCharacterThemeStyle({
    main: draft.theme.main,
    sub: draft.theme.sub,
  }), [draft.theme.main, draft.theme.sub]);
  const runtimePromptPreview = useMemo(
    () => buildCharacterRuntimePromptSection(buildPreviewRuntimeSnapshot(draft)),
    [draft],
  );

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    if (!api || !initialCharacterId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    void api.getCharacter(initialCharacterId).then((detail) => {
      if (!active) {
        return;
      }
      setPersistedDetail(detail);
      if (detail) {
        setDraft(createCharacterEditorDraftFromDetail(detail));
      } else {
        setFeedback("Character not found.");
      }
    }).catch((error) => {
      if (active) {
        setFeedback(formatCharacterEditorError(error, "Could not load character."));
      }
    }).finally(() => {
      if (active) {
        setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [initialCharacterId]);

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    if (!api) {
      return () => {
        active = false;
      };
    }

    void Promise.all([
      api.getModelCatalog(null),
      api.getAppSettings(),
    ]).then(([catalog, settings]) => {
      if (!active) {
        return;
      }

      setModelCatalog(catalog);
      setAppSettings(settings);
    }).catch((error) => {
      if (active) {
        setFeedback(formatCharacterEditorError(error, "Could not load authoring provider settings."));
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const provider = resolveAuthoringProvider(enabledAuthoringProviders, authoringProviderId);
    if (provider && provider.id !== authoringProviderId) {
      setAuthoringProviderId(provider.id);
    }
  }, [authoringProviderId, enabledAuthoringProviders]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldBlockCharacterEditorBeforeUnload({ dirty, saving, confirmedClose: confirmedCloseRef.current })) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
      setCloseConfirmationOpen(true);
    };

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving]);

  useEffect(() => {
    const handleFocus = () => {
      if (!authoringRefreshPendingRef.current || !draft.characterId) {
        return;
      }

      const api = getWithMateApi();
      if (!api) {
        return;
      }

      authoringRefreshPendingRef.current = false;
      void api.getCharacter(draft.characterId).then((detail) => {
        if (!detail) {
          setFeedback("Could not reload character files.");
          return;
        }

        setPersistedDetail(detail);
        setDraft(createCharacterEditorDraftFromDetail(detail));
        setFeedback("CharacterFilesReloaded");
      }).catch((error) => {
        authoringRefreshPendingRef.current = true;
        setFeedback(formatCharacterEditorError(error, "Could not reload character files."));
      });
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [draft.characterId]);

  const updateDraft = (patch: Partial<CharacterEditorDraft>) => {
    setDraft((current) => updateCharacterEditorDraft(current, patch));
    setFeedback("");
  };

  const saveCharacter = async () => {
    const api = getWithMateApi();
    if (!api) {
      setFeedback("Open Character Editor in Electron.");
      return;
    }
    if (archived) {
      setFeedback("Archived characters cannot be saved.");
      return;
    }
    if (iconValidationMessage) {
      setFeedback(iconValidationMessage);
      setSelectedTab("profile");
      return;
    }
    if (validation.blockingIssues.length > 0) {
      setFeedback("Resolve validation issues before saving.");
      setSelectedTab(validation.definitionIssues.length > 0 ? "definition" : "notes");
      return;
    }

    const draftAtSave = draft;
    setSaving(true);
    setFeedback("");
    try {
      if (draftAtSave.mode === "create") {
        const created = await api.createCharacter(buildCreateCharacterInputFromDraft(draftAtSave));
        const savedDraft = createCharacterEditorDraftFromDetail(created);
        const latestDraft = draftRef.current;
        const hasNewEdits = !areCharacterEditorDraftsEqual(latestDraft, draftAtSave);
        setPersistedDetail(created);
        setDraft(reconcileCharacterEditorDraftAfterSave(savedDraft, draftAtSave, latestDraft));
        if (!hasNewEdits) {
          setFeedback("CharacterCreated");
        }
        return;
      }

      if (!draftAtSave.characterId) {
        setFeedback("No character to save.");
        return;
      }

      await api.updateCharacterDefinition({
        characterId: draftAtSave.characterId,
        definitionMarkdown: draftAtSave.definitionMarkdown,
        notesMarkdown: draftAtSave.notesMarkdown,
      });
      const definitionMetadata = resolveCharacterDefinitionMetadata(draftAtSave.definitionMarkdown);
      const updated = await api.updateCharacterMetadata({
        characterId: draftAtSave.characterId,
        name: definitionMetadata?.name || draftAtSave.name,
        description: definitionMetadata?.description ?? draftAtSave.description,
        iconFilePath: draftAtSave.iconFilePath,
        theme: draftAtSave.theme,
      });
      const refreshed = await api.getCharacter(draftAtSave.characterId);
      if (!refreshed) {
        throw new Error("Could not reload character after saving.");
      }
      const savedDraft = createCharacterEditorDraftFromDetail(refreshed);
      const latestDraft = draftRef.current;
      const hasNewEdits = !areCharacterEditorDraftsEqual(latestDraft, draftAtSave);
      setPersistedDetail(refreshed);
      setDraft(reconcileCharacterEditorDraftAfterSave(savedDraft, draftAtSave, latestDraft));
      if (!hasNewEdits) {
        setFeedback("Saved");
      }
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Could not save character."));
    } finally {
      setSaving(false);
    }
  };

  const archiveCharacter = async () => {
    const api = getWithMateApi();
    if (!api || !draft.characterId || archived) {
      return;
    }
    if (!window.confirm("Archive this character?\n\nIt will be removed from the Home list and New Session selector.")) {
      return;
    }

    setSaving(true);
    try {
      const archivedCharacter = await api.archiveCharacter(draft.characterId);
      setDraft((current) => updateCharacterEditorDraft(current, {
        state: archivedCharacter.state,
      }));
      setPersistedDetail((current) => current
        ? {
            ...current,
            state: archivedCharacter.state,
            archivedAt: archivedCharacter.archivedAt,
            updatedAt: archivedCharacter.updatedAt,
          }
        : current);
      setFeedback("Character archived. It is no longer available in Home or the New Session selector.");
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Could not archive character."));
    } finally {
      setSaving(false);
    }
  };

  const startAuthoringSession = async () => {
    const api = getWithMateApi();
    if (!api) {
      setFeedback("Open Character Editor in Electron.");
      return;
    }
    if (archived) {
      setFeedback("Archived characters cannot start authoring sessions.");
      return;
    }
    if (!draft.name.trim()) {
      setFeedback("Enter a name before starting an authoring session.");
      setSelectedTab("profile");
      return;
    }
    if (!draft.characterId) {
      setFeedback("Save the character before starting an authoring session.");
      return;
    }
    if (dirty) {
      setFeedback("Save your changes before starting an authoring session.");
      return;
    }
    if (!selectedAuthoringProvider) {
      setFeedback("Enable a provider in Settings before starting an authoring session.");
      setAuthoringLaunchOpen(true);
      return;
    }

    setAuthoringStarting(true);
    setFeedback("");
    try {
      const result = await api.startCharacterAuthoringSession({
        mode: "improve",
        characterId: draft.characterId,
        provider: selectedAuthoringProvider.id,
      });
      authoringRefreshPendingRef.current = true;
      setFeedback(`Authoring session started: ${result.session.taskTitle}`);
      setAuthoringLaunchOpen(false);
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Could not start authoring session."));
    } finally {
      setAuthoringStarting(false);
    }
  };

  const openAuthoringLauncher = () => {
    if (archived) {
      setFeedback("Archived characters cannot start authoring sessions.");
      return;
    }
    if (!draft.name.trim()) {
      setFeedback("Enter a name before starting an authoring session.");
      setSelectedTab("profile");
      return;
    }
    if (!draft.characterId) {
      setFeedback("Save the character before starting an authoring session.");
      return;
    }
    if (dirty) {
      setFeedback("Save your changes before starting an authoring session.");
      return;
    }

    setFeedback("");
    setAuthoringLaunchOpen(true);
  };

  const discardDraftAndCloseWindow = () => {
    confirmedCloseRef.current = true;
    window.close();
  };

  const changeAuthoringProvider = (providerId: string) => {
    const provider = enabledAuthoringProviders.find((entry) => entry.id === providerId);
    if (!provider) {
      return;
    }

    setAuthoringProviderId(provider.id);
    setFeedback("");
  };

  const importIconImage = async () => {
    if (archived) {
      return;
    }
    const api = getWithMateApi();
    const selected = await api?.pickImageFile(draft.iconFilePath || null, "character-icon");
    if (selected) {
      updateDraft({ iconFilePath: selected });
      setSelectedTab("profile");
      setFeedback("Icon image imported. Save to apply it.");
    }
  };

  const importCharacterDefinitionFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setFeedback("Could not load character.md.");
        return;
      }

      const markdown = reader.result as string;
      const parsed = parseCharacterDefinitionMarkdown(markdown);
      setDraft((current) => replaceCharacterDefinitionDraft(
        current,
        markdown,
        parsed.ok
          ? {
              name: parsed.value.frontmatter.name,
              description: parsed.value.frontmatter.description,
            }
          : undefined,
      ));
      setSelectedTab("definition");
      setFeedback(parsed.ok
        ? `${file.name} imported into the character.md draft; name and description updated. Save to apply.`
        : `${file.name} imported into the character.md draft. Review validation issues.`);
    };
    reader.onerror = () => {
      setFeedback("Could not load character.md.");
    };
    reader.readAsText(file);
  };

  const importCharacterNotesFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setFeedback("Could not load character-notes.md.");
        return;
      }

      updateDraft({ notesMarkdown: reader.result as string });
      setSelectedTab("notes");
      setFeedback(`${file.name} imported into the character-notes.md draft. Save to apply.`);
    };
    reader.onerror = () => {
      setFeedback("Could not load character-notes.md.");
    };
    reader.readAsText(file);
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-editor-page">
        <section className="panel empty-session-card rise-1">
          <p>Open Character Editor in Electron.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell character-editor-page" style={themeStyle}>
      <section className="character-editor-window">
        <header className="character-editor-window-header">
          <div className="character-editor-heading">
            <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
            <div>
              <h1>{draft.name || "NewCharacter"}</h1>
              {draft.description ? <p>{draft.description}</p> : null}
            </div>
          </div>
          <div className="character-editor-header-actions">
            {archived || saving || authoringStarting || dirty ? (
              <span className="settings-character-badge">
                {archived ? "Archived" : saving ? "Saving" : authoringStarting ? "Authoring" : "Unsaved"}
              </span>
            ) : null}
          </div>
        </header>

        <nav className="character-editor-tabs" aria-label="Character editor tabs">
          {(["profile", "definition", "notes", "preview"] as const).map((tab) => (
            <button
              key={tab}
              className={`character-editor-tab ${selectedTab === tab ? "active" : ""}`.trim()}
              type="button"
              onClick={() => setSelectedTab(tab)}
            >
              {tab === "definition"
                ? "character.md"
                : tab === "notes"
                  ? "character-notes.md"
                  : tab === "profile"
                    ? "Profile"
                    : "Preview"}
            </button>
          ))}
        </nav>

        <main className={`character-editor-window-body ${denseEditorBody ? "character-editor-window-body-dense" : ""}`.trim()}>
          {loading ? (
            <div
              className="character-editor-loading-state"
              role="status"
              aria-live="polite"
              aria-label="Loading character"
            >
              <span className="chat-skill-picker-spinner" aria-hidden="true" />
            </div>
          ) : null}
          {!loading && selectedTab === "profile" ? (
            <section className="character-editor-profile-card">
              <div className="settings-character-form-grid">
                <label className="settings-provider-input">
                  <span>Name</span>
                  <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} disabled={archived} />
                </label>
                <label className="settings-provider-input">
                  <span>Description</span>
                  <input
                    value={draft.description}
                    onChange={(event) => updateDraft({ description: event.target.value })}
                    disabled={archived}
                  />
                </label>
                <label className="settings-provider-input">
                  <span>Icon</span>
                  <div className="settings-inline-input-row">
                    <input
                      value={draft.iconFilePath}
                      onChange={(event) => updateDraft({ iconFilePath: event.target.value })}
                      disabled={archived}
                    />
                    <button className="launch-toggle compact" type="button" onClick={importIconImage} disabled={archived}>
                      ImportImage
                    </button>
                  </div>
                </label>
                <div className="settings-character-theme-fields">
                  <label className="settings-provider-input">
                    <span>Main</span>
                    <input
                      type="color"
                      value={draft.theme.main}
                      onChange={(event) => updateDraft({ theme: { ...draft.theme, main: event.target.value } })}
                      disabled={archived}
                    />
                  </label>
                  <label className="settings-provider-input">
                    <span>Sub</span>
                    <input
                      type="color"
                      value={draft.theme.sub}
                      onChange={(event) => updateDraft({ theme: { ...draft.theme, sub: event.target.value } })}
                      disabled={archived}
                    />
                  </label>
                </div>
              </div>
            </section>
          ) : null}

          {!loading && selectedTab === "definition" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => definitionImportInputRef.current?.click()}
                  disabled={archived}
                >
                  ImportReplace
                </button>
              </div>
              <ValidationList issues={validation.definitionIssues} />
              <input
                ref={definitionImportInputRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                className="settings-character-import-input"
                disabled={archived}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    importCharacterDefinitionFile(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <textarea
                className="settings-character-markdown-textarea character-editor-textarea"
                value={draft.definitionMarkdown}
                onChange={(event) => updateDraft({ definitionMarkdown: event.target.value })}
                disabled={archived}
                spellCheck={false}
                aria-label="character.md"
              />
            </section>
          ) : null}

          {!loading && selectedTab === "notes" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => notesImportInputRef.current?.click()}
                  disabled={archived}
                >
                  ImportReplace
                </button>
              </div>
              <ValidationList issues={validation.notesIssues} />
              <input
                ref={notesImportInputRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                className="settings-character-import-input"
                disabled={archived}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    importCharacterNotesFile(file);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <textarea
                className="settings-character-notes-textarea character-editor-textarea"
                value={draft.notesMarkdown}
                onChange={(event) => updateDraft({ notesMarkdown: event.target.value })}
                disabled={archived}
                spellCheck={false}
                aria-label="character-notes.md"
              />
            </section>
          ) : null}

          {!loading && selectedTab === "preview" ? (
            <section className="character-editor-preview-grid">
              <div className="character-editor-preview-profile">
                <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
                <strong>{draft.name || "NewCharacter"}</strong>
                {draft.description ? <p>{draft.description}</p> : null}
              </div>
              <label className="settings-provider-input character-editor-runtime-preview">
                <span>RuntimePromptPreview</span>
                <textarea value={runtimePromptPreview} readOnly rows={14} spellCheck={false} />
              </label>
            </section>
          ) : null}
        </main>

        {closeConfirmationOpen ? (
          <LaunchDialogShell
            onClose={() => setCloseConfirmationOpen(false)}
            dialogRef={closeConfirmationDialogRef}
            onKeyDown={handleCloseConfirmationDialogKeyDown}
            ariaLabel={draft.mode === "create" ? "Confirm discard of new character" : "Confirm discard of unsaved changes"}
            showDismissControl={false}
            dialogClassName="character-editor-close-dialog"
            footer={
              <div className="character-editor-close-dialog-actions">
                <button
                  ref={closeConfirmationCancelButtonRef}
                  className="launch-toggle"
                  type="button"
                  onClick={() => setCloseConfirmationOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="launch-toggle danger-button"
                  type="button"
                  onClick={discardDraftAndCloseWindow}
                >
                  DiscardAndClose
                </button>
              </div>
            }
          >
            <div className="character-editor-close-dialog-copy">
              <h2>{draft.mode === "create" ? "Discard new character?" : "Discard unsaved changes?"}</h2>
            </div>
          </LaunchDialogShell>
        ) : null}

        {authoringLaunchOpen ? (
          <LaunchDialogShell
            onClose={() => setAuthoringLaunchOpen(false)}
            dialogRef={authoringDialogRef}
            onKeyDown={handleAuthoringDialogKeyDown}
            dialogClassName="auxiliary-provider-dialog"
            footer={
              <LaunchDialogFooter
                feedback={authoringLaunchFeedback}
                startButtonLabel="Start"
                startButtonDisabled={
                  authoringStarting ||
                  !selectedAuthoringProvider ||
                  !authoringProviderSelectionReady ||
                  authoringProviderBlocked
                }
                startButtonBusy={authoringStarting}
                startButtonLoadingText="Starting authoring session"
                onStart={startAuthoringSession}
                startButtonRef={authoringStartButtonRef}
              />
            }
          >
            <ProviderLaunchField
              fieldId="character-authoring-provider-picker"
              providers={enabledAuthoringProviders}
              selectedProviderId={selectedAuthoringProvider?.id ?? null}
              onSelectProvider={changeAuthoringProvider}
            />
          </LaunchDialogShell>
        ) : null}

        <footer className="character-editor-window-footer">
          <button
            className="launch-toggle danger-button"
            type="button"
            onClick={archiveCharacter}
            disabled={saving || authoringStarting || archived || draft.mode !== "edit"}
          >
            Archive
          </button>
          <span>{feedback}</span>
          <button
            className="launch-toggle"
            type="button"
            onClick={openAuthoringLauncher}
            disabled={saving || authoringStarting || archived || loading || !draft.characterId}
            aria-busy={authoringStarting || undefined}
            aria-label={authoringStarting ? "Starting authoring session" : undefined}
          >
            {authoringStarting ? (
              <>
                <span className="chat-skill-picker-spinner" aria-hidden="true" />
              </>
            ) : draft.mode === "edit" ? "ImproveWithAgent" : "AuthorWithAgent"}
          </button>
          <button
            className="launch-toggle start-session-button"
            type="button"
            onClick={saveCharacter}
            disabled={saving || authoringStarting || archived || !dirty}
            aria-busy={saving || undefined}
            aria-label={saving ? "Saving character" : "Save"}
          >
            {saving ? (
              <>
                <span className="chat-skill-picker-spinner" aria-hidden="true" />
                <span>Save</span>
              </>
            ) : "Save"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ValidationList({
  issues,
}: {
  issues: readonly { code: string; message: string; path?: string }[];
}) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <ul className="character-editor-validation-list">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${issue.path ?? ""}-${index}`}>
          <strong>{issue.code}</strong>
          <span>{issue.path ? `${issue.message} (${issue.path})` : issue.message}</span>
        </li>
      ))}
    </ul>
  );
}
