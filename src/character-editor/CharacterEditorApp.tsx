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
import { ProviderLaunchField, type ProviderLaunchLoadStatus } from "../launch/provider-launch-picker.js";
import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "../app/renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import { CharacterAvatar } from "../ui/ui-utils.js";
import { LoadingIndicator, type ReadStatus } from "../ui/loading-indicator.js";
import { CharacterEditorReadError } from "./character-editor-read-error.js";
import { ButtonContent } from "../ui/button-content.js";

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
  const [authoringProviderLoadStatus, setAuthoringProviderLoadStatus] = useState<ProviderLaunchLoadStatus>("loading");
  const [authoringProviderLoadError, setAuthoringProviderLoadError] = useState("");
  const [authoringProviderReadRevision, setAuthoringProviderReadRevision] = useState(0);
  const [authoringProviderId, setAuthoringProviderId] = useState(DEFAULT_PROVIDER_ID);
  const [authoringLaunchOpen, setAuthoringLaunchOpen] = useState(false);
  const [closeConfirmationOpen, setCloseConfirmationOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState<CharacterEditorTab>("profile");
  const [loadStatus, setLoadStatus] = useState<ReadStatus>(initialCharacterId ? "loading" : "ready");
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loading = loadStatus === "loading";
  const editorReady = loadStatus === "ready";
  const [savingAction, setSavingAction] = useState<"save" | "archive" | null>(null);
  const saving = savingAction !== null;
  const [authoringStarting, setAuthoringStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [{ message: feedback, details: feedbackDetails }, setFeedbackState] = useState({ message: "", details: "" });
  const setFeedback = (message: string, details = "") => setFeedbackState({ message, details });
  const draftRef = useRef(draft);
  const definitionImportInputRef = useRef<HTMLInputElement | null>(null);
  const notesImportInputRef = useRef<HTMLInputElement | null>(null);
  const authoringStartButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeConfirmationCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const authoringRefreshPendingRef = useRef(false);
  const retryCharacterReadRef = useRef<(() => void) | null>(null);
  const confirmedCloseRef = useRef(false);

  draftRef.current = draft;

  const validation = useMemo(() => buildCharacterEditorValidationSummary(draft), [draft]);
  const iconValidationMessage = useMemo(
    () => getCharacterIconDraftValidationMessage(draft.iconFilePath, persistedDetail?.iconFilePath),
    [draft.iconFilePath, persistedDetail?.iconFilePath],
  );
  const dirty = editorReady && isCharacterEditorDraftDirty(draft, persistedDetail);
  const archived = draft.state === "archived";
  const enabledAuthoringProviders = useMemo(
    () => listEnabledAuthoringProviders(modelCatalog, appSettings),
    [appSettings, modelCatalog],
  );
  const selectedAuthoringProvider = useMemo(
    () => resolveAuthoringProvider(enabledAuthoringProviders, authoringProviderId),
    [authoringProviderId, enabledAuthoringProviders],
  );
  const authoringProviderSelectionReady = !desktopRuntime || authoringProviderLoadStatus === "loaded";
  const authoringProviderBlocked = desktopRuntime && authoringProviderSelectionReady && enabledAuthoringProviders.length === 0;
  const authoringLaunchFeedback = authoringProviderLoadStatus === "error"
    ? ""
    : !authoringProviderSelectionReady
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
    if (!initialCharacterId) {
      return () => {
        active = false;
      };
    }
    if (!api) {
      setLoadStatus("error");
      setLoadError("Open Character Editor in Electron.");
      return;
    }

    setLoadStatus("loading");
    setLoadError("");
    void api.getCharacter(initialCharacterId).then((detail) => {
      if (!active) {
        return;
      }
      if (detail) {
        setPersistedDetail(detail);
        setDraft(createCharacterEditorDraftFromDetail(detail));
        setLoadStatus("ready");
      } else {
        setLoadError("Character not found.");
        setLoadStatus("error");
      }
    }).catch((error) => {
      if (active) {
        setLoadError(formatCharacterEditorError(error, "Could not load character."));
        setLoadStatus("error");
      }
    });

    return () => {
      active = false;
    };
  }, [initialCharacterId, loadAttempt]);

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    if (!api) {
      if (desktopRuntime) {
        const message = "Open Character Editor in Electron.";
        setAuthoringProviderLoadStatus("error");
        setAuthoringProviderLoadError(message);
      }
      return () => {
        active = false;
      };
    }

    setAuthoringProviderLoadStatus("loading");
    setAuthoringProviderLoadError("");
    void Promise.all([
      api.getModelCatalog(),
      api.getAppSettings(),
    ]).then(([catalog, settings]) => {
      if (!active) {
        return;
      }

      setModelCatalog(catalog);
      setAppSettings(settings);
      setAuthoringProviderLoadStatus("loaded");
      setAuthoringProviderLoadError("");
    }).catch((error) => {
      if (active) {
        const message = formatCharacterEditorError(error, "Could not load authoring provider settings.");
        setAuthoringProviderLoadStatus("error");
        setAuthoringProviderLoadError(message);
      }
    });

    return () => {
      active = false;
    };
  }, [desktopRuntime, authoringProviderReadRevision]);

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
    let active = true;
    let refreshInFlight = false;
    setRefreshing(false);
    const handleFocus = () => {
      if (!authoringRefreshPendingRef.current || refreshInFlight || !persistedDetail || saving || authoringStarting) {
        return;
      }

      const api = getWithMateApi();
      if (!api) {
        return;
      }

      refreshInFlight = true;
      setRefreshing(true);
      const baselineDraft = createCharacterEditorDraftFromDetail(persistedDetail);
      void api.getCharacter(persistedDetail.id).then((detail) => {
        if (!active) {
          return;
        }
        if (!detail) {
          setFeedback("Character files could not be reloaded.", "The character could not be found while reloading its files.");
          return;
        }

        authoringRefreshPendingRef.current = false;
        const latestDraft = draftRef.current;
        const hasNewEdits = !areCharacterEditorDraftsEqual(baselineDraft, latestDraft);
        setPersistedDetail(detail);
        setDraft(reconcileCharacterEditorDraftAfterSave(
          createCharacterEditorDraftFromDetail(detail), baselineDraft, latestDraft,
        ));
        setFeedback(hasNewEdits ? "Unsaved edits kept after reloading character files." : "Character Files Reloaded");
      }).catch((error) => {
        if (!active) {
          return;
        }
        setFeedback("Character files could not be reloaded.", formatCharacterEditorError(error, "Could not reload character files."));
      }).finally(() => {
        refreshInFlight = false;
        if (active) setRefreshing(false);
      });
    };

    retryCharacterReadRef.current = handleFocus;
    window.addEventListener("focus", handleFocus);
    return () => {
      active = false;
      retryCharacterReadRef.current = null;
      window.removeEventListener("focus", handleFocus);
    };
  }, [persistedDetail, saving, authoringStarting]);

  const updateDraft = (patch: Partial<CharacterEditorDraft>) => {
    setDraft((current) => updateCharacterEditorDraft(current, patch));
    setFeedback("");
  };

  const saveCharacter = async () => {
    if (!editorReady || saving) {
      return;
    }
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
    setSavingAction("save");
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
          setFeedback("Character Created");
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
      authoringRefreshPendingRef.current = false;
      setPersistedDetail(refreshed);
      setDraft(reconcileCharacterEditorDraftAfterSave(savedDraft, draftAtSave, latestDraft));
      if (!hasNewEdits) {
        setFeedback("Saved");
      }
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Could not save character."));
    } finally {
      setSavingAction(null);
    }
  };

  const archiveCharacter = async () => {
    const api = getWithMateApi();
    if (!editorReady || !api || !draft.characterId || archived || saving) {
      return;
    }
    if (!window.confirm("Archive this character?\n\nIt will be removed from the Home list and New Session selector.")) {
      return;
    }

    setSavingAction("archive");
    setFeedback("");
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
      setSavingAction(null);
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
            {editorReady ? <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" /> : null}
            <div>
              <h1>{editorReady ? draft.name || "New Character" : "Character Editor"}</h1>
              {editorReady && draft.description ? <p>{draft.description}</p> : null}
            </div>
          </div>
          <div className="character-editor-header-actions">
            {archived || dirty ? (
              <span className="settings-character-badge">
                {archived ? "Archived" : "Unsaved"}
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
              disabled={!editorReady}
              aria-pressed={selectedTab === tab}
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

        <main
          className={`character-editor-window-body ${denseEditorBody ? "character-editor-window-body-dense" : ""}`.trim()}
          aria-busy={loading || undefined}
        >
          {loading ? (
            <div className="character-editor-loading-state">
              <LoadingIndicator label="Loading character" />
            </div>
          ) : null}
          {loadStatus === "error" ? (
            <CharacterEditorReadError
              key={loadError}
              subject="Character Load"
              summary="Character could not be loaded."
              details={loadError}
              notice={loadError === "Character not found." ? "Character Not Found" : undefined}
              onRetry={() => {
                setLoadStatus("loading");
                setLoadAttempt((current) => current + 1);
              }}
            />
          ) : null}
          {editorReady && selectedTab === "profile" ? (
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
                      Import Image
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

          {editorReady && selectedTab === "definition" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => definitionImportInputRef.current?.click()}
                  disabled={archived}
                >
                  Import Replace
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

          {editorReady && selectedTab === "notes" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => notesImportInputRef.current?.click()}
                  disabled={archived}
                >
                  Import Replace
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

          {editorReady && selectedTab === "preview" ? (
            <section className="character-editor-preview-grid">
              <div className="character-editor-preview-profile">
                <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
                <strong>{draft.name || "New Character"}</strong>
                {draft.description ? <p>{draft.description}</p> : null}
              </div>
              <label className="settings-provider-input character-editor-runtime-preview">
                <span>Runtime Prompt Preview</span>
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
                  Discard And Close
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
            ariaLabel="Character authoring provider"
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
              loadStatus={authoringProviderLoadStatus}
              loadError={authoringProviderLoadError}
              onRetryLoad={() => setAuthoringProviderReadRevision((revision) => revision + 1)}
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
            disabled={!editorReady || saving || authoringStarting || archived || draft.mode !== "edit"}
            aria-busy={savingAction === "archive" || undefined}
            aria-label={savingAction === "archive" ? "Archiving character" : "Archive"}
          >
            <ButtonContent busy={savingAction === "archive"}>Archive</ButtonContent>
          </button>
          {feedbackDetails ? (
            <CharacterEditorReadError
              key={feedbackDetails}
              subject="Character Reload"
              summary={feedback}
              details={feedbackDetails}
              retryBusy={refreshing}
              onRetry={() => retryCharacterReadRef.current?.()}
            />
          ) : <span role="status">{feedback}</span>}
          <button
            className="launch-toggle"
            type="button"
            onClick={openAuthoringLauncher}
            disabled={!editorReady || saving || authoringStarting || archived || !draft.characterId}
            aria-busy={authoringStarting || undefined}
            aria-label={authoringStarting ? "Starting authoring session" : undefined}
          >
            <ButtonContent busy={authoringStarting}>
              {initialCharacterId || draft.mode === "edit" ? "Improve With Agent" : "Author With Agent"}
            </ButtonContent>
          </button>
          <button
            className="launch-toggle start-session-button"
            type="button"
            onClick={saveCharacter}
            disabled={!editorReady || saving || authoringStarting || archived || !dirty}
            aria-busy={savingAction === "save" || undefined}
            aria-label={savingAction === "save" ? "Saving character" : "Save"}
          >
            <ButtonContent busy={savingAction === "save"}>Save</ButtonContent>
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
