import { useEffect, useMemo, useRef, useState } from "react";

import type { CharacterDetail, CharacterRuntimeSnapshot } from "./character/character-catalog.js";
import { parseCharacterDefinitionMarkdown } from "./character/character-definition.js";
import { buildCharacterRuntimePromptSection } from "./character/character-runtime-snapshot.js";
import {
  buildCharacterEditorValidationSummary,
  buildCreateCharacterInputFromDraft,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  formatCharacterEditorError,
  isCharacterEditorDraftDirty,
  replaceCharacterDefinitionDraft,
  resolveCharacterDefinitionMetadata,
  shouldBlockCharacterEditorBeforeUnload,
  type CharacterEditorDraft,
  type CharacterEditorTab,
  updateCharacterEditorDraft,
} from "./character-editor/character-editor-state.js";
import { useDialogA11y } from "./a11y.js";
import { LaunchDialogFooter, LaunchDialogShell } from "./launch/launch-dialog-shell.js";
import { ProviderLaunchField } from "./launch/provider-launch-picker.js";
import {
  DEFAULT_PROVIDER_ID,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import { CharacterAvatar } from "./ui-utils.js";

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
  const [selectedTab, setSelectedTab] = useState<CharacterEditorTab>("profile");
  const [loading, setLoading] = useState(Boolean(initialCharacterId));
  const [saving, setSaving] = useState(false);
  const [authoringStarting, setAuthoringStarting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const definitionImportInputRef = useRef<HTMLInputElement | null>(null);
  const notesImportInputRef = useRef<HTMLInputElement | null>(null);
  const authoringStartButtonRef = useRef<HTMLButtonElement | null>(null);
  const authoringRefreshPendingRef = useRef(false);
  const confirmedCloseRef = useRef(false);

  const validation = useMemo(() => buildCharacterEditorValidationSummary(draft), [draft]);
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
    ? "Provider 設定を読み込んでいます。"
    : authoringProviderBlocked
      ? "Settings で Coding Agent Provider を有効化してください。"
      : feedback;
  const {
    dialogRef: authoringDialogRef,
    handleDialogKeyDown: handleAuthoringDialogKeyDown,
  } = useDialogA11y<HTMLElement>({
    open: authoringLaunchOpen,
    onClose: () => setAuthoringLaunchOpen(false),
    initialFocusRef: authoringStartButtonRef,
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
        setFeedback("Character が見つかりませんでした。");
      }
    }).catch((error) => {
      if (active) {
        setFeedback(formatCharacterEditorError(error, "Character の読み込みに失敗しました。"));
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
        setFeedback(formatCharacterEditorError(error, "Authoring provider 設定の読み込みに失敗しました。"));
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
          setFeedback("Character の再読み込みに失敗しました。");
          return;
        }

        setPersistedDetail(detail);
        setDraft(createCharacterEditorDraftFromDetail(detail));
        setFeedback("Character files を再読み込みしました。");
      }).catch((error) => {
        authoringRefreshPendingRef.current = true;
        setFeedback(formatCharacterEditorError(error, "Character の再読み込みに失敗しました。"));
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
      setFeedback("Character Editor は Electron から開いてください。");
      return;
    }
    if (archived) {
      setFeedback("Archived Character は保存できません。");
      return;
    }
    if (validation.blockingIssues.length > 0) {
      setFeedback("validation issue を解消してから保存してください。");
      setSelectedTab(validation.definitionIssues.length > 0 ? "definition" : "notes");
      return;
    }

    setSaving(true);
    setFeedback("保存しています...");
    try {
      if (draft.mode === "create") {
        const created = await api.createCharacter(buildCreateCharacterInputFromDraft(draft));
        setPersistedDetail(created);
        setDraft(createCharacterEditorDraftFromDetail(created));
        setFeedback("Character を作成しました。");
        return;
      }

      if (!draft.characterId) {
        setFeedback("保存対象の Character がありません。");
        return;
      }

      await api.updateCharacterDefinition({
        characterId: draft.characterId,
        definitionMarkdown: draft.definitionMarkdown,
        notesMarkdown: draft.notesMarkdown,
      });
      const definitionMetadata = resolveCharacterDefinitionMetadata(draft.definitionMarkdown);
      const updated = await api.updateCharacterMetadata({
        characterId: draft.characterId,
        name: definitionMetadata.name || draft.name,
        description: definitionMetadata.description,
        iconFilePath: draft.iconFilePath,
        theme: draft.theme,
      });
      if (draft.isDefault && !updated.isDefault) {
        await api.setDefaultCharacter(draft.characterId);
      }
      const refreshed = await api.getCharacter(draft.characterId);
      if (!refreshed) {
        throw new Error("保存後の Character を再読み込みできませんでした。");
      }
      setPersistedDetail(refreshed);
      setDraft(createCharacterEditorDraftFromDetail(refreshed));
      setFeedback("Character を保存しました。");
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Character の保存に失敗しました。"));
    } finally {
      setSaving(false);
    }
  };

  const setDefaultCharacter = async () => {
    const api = getWithMateApi();
    if (!api || !draft.characterId || draft.isDefault || archived) {
      return;
    }
    setSaving(true);
    try {
      const updated = await api.setDefaultCharacter(draft.characterId);
      const refreshed = await api.getCharacter(updated.id);
      setPersistedDetail(refreshed);
      if (refreshed) {
        setDraft(createCharacterEditorDraftFromDetail(refreshed));
      }
      setFeedback("Default Character を更新しました。");
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Default Character の更新に失敗しました。"));
    } finally {
      setSaving(false);
    }
  };

  const archiveCharacter = async () => {
    const api = getWithMateApi();
    if (!api || !draft.characterId || archived) {
      return;
    }
    if (!window.confirm("この Character を archive しますか？\n\nHome list と New Session selector には出なくなります。")) {
      return;
    }

    setSaving(true);
    try {
      const archivedCharacter = await api.archiveCharacter(draft.characterId);
      setDraft((current) => updateCharacterEditorDraft(current, {
        state: archivedCharacter.state,
        isDefault: archivedCharacter.isDefault,
      }));
      setPersistedDetail((current) => current
        ? {
            ...current,
            state: archivedCharacter.state,
            isDefault: archivedCharacter.isDefault,
            archivedAt: archivedCharacter.archivedAt,
            updatedAt: archivedCharacter.updatedAt,
          }
        : current);
      setFeedback("Character を archive しました。Home list と New Session selector には表示されません。");
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Character の archive に失敗しました。"));
    } finally {
      setSaving(false);
    }
  };

  const startAuthoringSession = async () => {
    const api = getWithMateApi();
    if (!api) {
      setFeedback("Character Editor は Electron から開いてください。");
      return;
    }
    if (archived) {
      setFeedback("Archived Character は authoring session を開始できません。");
      return;
    }
    if (!draft.name.trim()) {
      setFeedback("Name を入力してから authoring session を開始してください。");
      setSelectedTab("profile");
      return;
    }
    if (!draft.characterId) {
      setFeedback("先に Character を保存してから authoring session を開始してください。");
      return;
    }
    if (!selectedAuthoringProvider) {
      setFeedback("Settings で有効な provider を選択してから authoring session を開始してください。");
      setAuthoringLaunchOpen(true);
      return;
    }

    setAuthoringStarting(true);
    setFeedback("Authoring session を準備しています...");
    try {
      const result = await api.startCharacterAuthoringSession({
        mode: "improve",
        characterId: draft.characterId,
        name: draft.name,
        description: draft.description,
        definitionMarkdown: draft.definitionMarkdown,
        notesMarkdown: draft.notesMarkdown,
        iconFilePath: draft.iconFilePath,
        theme: draft.theme,
        userInstruction: "",
        provider: selectedAuthoringProvider.id,
      });
      authoringRefreshPendingRef.current = true;
      setFeedback(`Authoring session を開始しました: ${result.session.taskTitle}`);
      setAuthoringLaunchOpen(false);
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Authoring session の開始に失敗しました。"));
    } finally {
      setAuthoringStarting(false);
    }
  };

  const openAuthoringLauncher = () => {
    if (archived) {
      setFeedback("Archived Character は authoring session を開始できません。");
      return;
    }
    if (!draft.name.trim()) {
      setFeedback("Name を入力してから authoring session を開始してください。");
      setSelectedTab("profile");
      return;
    }
    if (!draft.characterId) {
      setFeedback("先に Character を保存してから authoring session を開始してください。");
      return;
    }

    setFeedback("");
    setAuthoringLaunchOpen(true);
  };

  const closeWindow = () => {
    if (dirty && !window.confirm("未保存の編集があります。\n\n保存せずに閉じますか？")) {
      return;
    }
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
    const selected = await api?.pickImageFile(draft.iconFilePath || null);
    if (selected) {
      updateDraft({ iconFilePath: selected });
      setSelectedTab("profile");
      setFeedback("画像を icon に読み込みました。保存するまで反映されません。");
    }
  };

  const importCharacterDefinitionFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setFeedback("character.md の読み込みに失敗しました。");
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
        ? `${file.name} を character.md draft に読み込み、name / description も反映しました。保存するまで反映されません。`
        : `${file.name} を character.md draft に読み込みました。validation issue を確認してください。`);
    };
    reader.onerror = () => {
      setFeedback("character.md の読み込みに失敗しました。");
    };
    reader.readAsText(file);
  };

  const importCharacterNotesFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setFeedback("character-notes.md の読み込みに失敗しました。");
        return;
      }

      updateDraft({ notesMarkdown: reader.result as string });
      setSelectedTab("notes");
      setFeedback(`${file.name} を character-notes.md draft に読み込みました。保存するまで反映されません。`);
    };
    reader.onerror = () => {
      setFeedback("character-notes.md の読み込みに失敗しました。");
    };
    reader.readAsText(file);
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-editor-page">
        <section className="panel empty-session-card rise-1">
          <p>Character Editor は Electron から開いてね。</p>
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
              <h1>{draft.name || "New Character"}</h1>
              <p>{draft.description || "No description"}</p>
            </div>
          </div>
          <div className="character-editor-header-actions">
            <span className="settings-character-badge">
              {archived ? "Archived" : saving ? "Saving" : authoringStarting ? "Authoring" : dirty ? "Unsaved" : "Saved"}
            </span>
            <button className="launch-toggle" type="button" onClick={closeWindow}>
              Close
            </button>
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
              {tab === "definition" ? "character.md" : tab === "notes" ? "character-notes.md" : tab}
            </button>
          ))}
        </nav>

        <main className={`character-editor-window-body ${denseEditorBody ? "character-editor-window-body-dense" : ""}`.trim()}>
          {loading ? <p className="settings-note">Character を読み込んでいます...</p> : null}
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
              <div className="settings-actions">
                <button
                  className="launch-toggle"
                  type="button"
                  onClick={setDefaultCharacter}
                  disabled={saving || archived || draft.mode !== "edit" || draft.isDefault}
                >
                  Set Default
                </button>
                {draft.isDefault ? <span className="settings-character-badge">Default</span> : null}
              </div>
            </section>
          ) : null}

          {!loading && selectedTab === "definition" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <strong>character.md</strong>
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => definitionImportInputRef.current?.click()}
                  disabled={archived}
                >
                  Import / Replace
                </button>
              </div>
              <p className="settings-help">Runtime definition の正本です。session / companion 開始時に snapshot 化されます。</p>
              <ValidationList issues={validation.definitionIssues} emptyLabel="character.md validation OK" />
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
              />
            </section>
          ) : null}

          {!loading && selectedTab === "notes" ? (
            <section className="character-editor-markdown-card">
              <div className="settings-section-head-row">
                <strong>character-notes.md</strong>
                <button
                  className="launch-toggle compact"
                  type="button"
                  onClick={() => notesImportInputRef.current?.click()}
                  disabled={archived}
                >
                  Import / Replace
                </button>
              </div>
              <p className="settings-help">調査メモ、採用理由、改稿履歴用です。V5 Core では runtime prompt に常設注入しません。</p>
              <ValidationList issues={validation.notesIssues} emptyLabel="character-notes.md validation OK" />
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
              />
            </section>
          ) : null}

          {!loading && selectedTab === "preview" ? (
            <section className="character-editor-preview-grid">
              <div className="character-editor-preview-profile">
                <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
                <strong>{draft.name || "New Character"}</strong>
                <p>{draft.description || "No description"}</p>
                {draft.isDefault ? <span className="settings-character-badge">Default</span> : null}
              </div>
              <label className="settings-provider-input character-editor-runtime-preview">
                <span>Runtime prompt preview</span>
                <textarea value={runtimePromptPreview} readOnly rows={14} spellCheck={false} />
              </label>
            </section>
          ) : null}
        </main>

        {authoringLaunchOpen ? (
          <LaunchDialogShell
            onClose={() => setAuthoringLaunchOpen(false)}
            dialogRef={authoringDialogRef}
            onKeyDown={handleAuthoringDialogKeyDown}
            dialogClassName="auxiliary-provider-dialog"
            footer={
              <LaunchDialogFooter
                feedback={authoringLaunchFeedback}
                startButtonLabel={authoringStarting ? "Starting..." : "Start"}
                startButtonDisabled={
                  authoringStarting ||
                  !selectedAuthoringProvider ||
                  !authoringProviderSelectionReady ||
                  authoringProviderBlocked
                }
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
          >
            {authoringStarting ? "Starting..." : draft.mode === "edit" ? "Improve with Agent" : "Author with Agent"}
          </button>
          <button
            className="launch-toggle start-session-button"
            type="button"
            onClick={saveCharacter}
            disabled={saving || authoringStarting || archived || !dirty}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

function ValidationList({
  issues,
  emptyLabel,
}: {
  issues: readonly { code: string; message: string; path?: string }[];
  emptyLabel: string;
}) {
  if (issues.length === 0) {
    return <p className="settings-feedback">{emptyLabel}</p>;
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
