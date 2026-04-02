import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  buildCharacterEditorUrl,
  currentTimestampLabel,
  getCharacterIdFromLocation,
  getCharacterProfile,
  isCharacterCreateMode,
} from "./app-state.js";
import {
  cloneCharacterSessionCopy,
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterSessionCopy,
  type CharacterThemeColors,
  type CharacterProfile,
  type CreateCharacterInput,
} from "./character-state.js";
import type { CharacterUpdateWorkspace } from "./character-update-state.js";
import { createDefaultAppSettings, getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import { getWithMateApi, isDesktopRuntime, withWithMateApi } from "./renderer-withmate-api.js";
import { focusRovingItemByKey, useDialogA11y } from "./a11y.js";
import { CharacterAvatar } from "./ui-utils.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";

const emptyDraft: CreateCharacterInput = {
  name: "",
  iconPath: "",
  description: "",
  roleMarkdown: "",
  notesMarkdown: "",
  themeColors: DEFAULT_CHARACTER_THEME_COLORS,
  sessionCopy: cloneCharacterSessionCopy(DEFAULT_CHARACTER_SESSION_COPY),
};

const sessionCopyFieldDefinitions: Array<{
  key: keyof CharacterSessionCopy;
  label: string;
  placeholder: string;
}> = [
  { key: "pendingApproval", label: "Pending Approval", placeholder: "例: {name}が確認を待機中" },
  { key: "pendingWorking", label: "Pending Working", placeholder: "例: {name}が静かに処理中" },
  { key: "pendingResponding", label: "Pending Responding", placeholder: "例: {name}が返答をまとめ中" },
  { key: "pendingPreparing", label: "Pending Preparing", placeholder: "例: {name}が次の返答を準備中" },
  { key: "retryInterruptedTitle", label: "Retry Interrupted", placeholder: "例: さっきの依頼は途中で止まっている" },
  { key: "retryFailedTitle", label: "Retry Failed", placeholder: "例: さっきの依頼は最後まで進められなかった" },
  { key: "retryCanceledTitle", label: "Retry Canceled", placeholder: "例: この依頼は途中で止められた" },
  { key: "latestCommandWaiting", label: "Latest Command Waiting", placeholder: "例: 最初の command を待機中" },
  { key: "latestCommandEmpty", label: "Latest Command Empty", placeholder: "例: 直近 run の command 記録はありません" },
  { key: "changedFilesEmpty", label: "Changed Files Empty", placeholder: "例: ファイル変更はありません" },
  { key: "contextEmpty", label: "Context Empty", placeholder: "例: context usage はまだありません" },
];

function ensureSessionCopyEditorCandidates(candidates: string[]): string[] {
  return candidates.length > 0 ? candidates : [""];
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_CHARACTER_THEME_COLORS.main;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function clampRgb(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => clampRgb(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function normalizeHexInput(value: string): string | null {
  const normalized = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : null;
}

function toDraft(character: CharacterProfile | null): CreateCharacterInput {
  if (!character) {
    return emptyDraft;
  }

  return {
    name: character.name,
    iconPath: character.iconPath,
    description: character.description,
    roleMarkdown: character.roleMarkdown,
    notesMarkdown: character.notesMarkdown,
    themeColors: character.themeColors,
    sessionCopy: cloneCharacterSessionCopy(character.sessionCopy),
  };
}

function areDraftsEqual(left: CreateCharacterInput, right: CreateCharacterInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function CharacterEditorApp() {
  const desktopRuntime = isDesktopRuntime();
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [draft, setDraft] = useState<CreateCharacterInput>(emptyDraft);
  const [characterId, setCharacterId] = useState<string | null>(() => getCharacterIdFromLocation());
  const [isCreateMode, setIsCreateMode] = useState<boolean>(() => isCharacterCreateMode() || !getCharacterIdFromLocation());
  const [editorTab, setEditorTab] = useState<"profile" | "character-md" | "character-notes" | "session-copy">("profile");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [updateLaunchOpen, setUpdateLaunchOpen] = useState(false);
  const [updateWorkspace, setUpdateWorkspace] = useState<CharacterUpdateWorkspace | null>(null);
  const [selectedUpdateProviderId, setSelectedUpdateProviderId] = useState("");
  const [startingUpdateSession, setStartingUpdateSession] = useState(false);
  const [isReloadingCharacter, setIsReloadingCharacter] = useState(false);
  const [isOpeningCharacterFolder, setIsOpeningCharacterFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.listCharacters().then((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      const currentCharacter = characterId ? getCharacterProfile(nextCharacters, characterId) : null;
      setDraft(toDraft(currentCharacter));
    });
    void Promise.all([
      withmateApi.getAppSettings(),
      withmateApi.getModelCatalog(null),
    ]).then(([nextSettings, nextCatalog]) => {
      if (!active) {
        return;
      }
      setAppSettings(nextSettings);
      setModelCatalog(nextCatalog);
    });

    const unsubscribe = withmateApi.subscribeCharacters((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      const currentCharacter = characterId ? getCharacterProfile(nextCharacters, characterId) : null;
      if (currentCharacter) {
        setDraft(toDraft(currentCharacter));
      }
    });
    const unsubscribeAppSettings = withmateApi.subscribeAppSettings((nextSettings) => {
      if (active) {
        setAppSettings(nextSettings);
      }
    });
    const unsubscribeModelCatalog = withmateApi.subscribeModelCatalog((nextCatalog) => {
      if (active) {
        setModelCatalog(nextCatalog);
      }
    });

    return () => {
      active = false;
      unsubscribe();
      unsubscribeAppSettings();
      unsubscribeModelCatalog();
    };
  }, [characterId]);

  const selectedCharacter = useMemo(
    () => (characterId ? getCharacterProfile(characters, characterId) : null),
    [characterId, characters],
  );
  const { dialogRef: updateLaunchDialogRef, handleDialogKeyDown: handleUpdateLaunchDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: updateLaunchOpen && !!selectedCharacter,
    onClose: () => setUpdateLaunchOpen(false),
  });

  const previewCharacter = useMemo(
    () => ({
      name: draft.name || selectedCharacter?.name || "新規",
      iconPath: draft.iconPath || selectedCharacter?.iconPath || "",
    }),
    [draft.iconPath, draft.name, selectedCharacter],
  );

  const editorThemeStyle = useMemo(() => buildCharacterThemeStyle(draft.themeColors), [draft.themeColors]);
  const isDirty = useMemo(
    () => areDraftsEqual(draft, toDraft(selectedCharacter)) === false,
    [draft, selectedCharacter],
  );
  const enabledUpdateProviders = useMemo(() => {
    return (modelCatalog?.providers ?? []).filter((provider) => getProviderAppSettings(appSettings, provider.id).enabled);
  }, [appSettings, modelCatalog]);

  useEffect(() => {
    if (!enabledUpdateProviders.find((provider) => provider.id === selectedUpdateProviderId)) {
      setSelectedUpdateProviderId(enabledUpdateProviders[0]?.id ?? "");
    }
  }, [enabledUpdateProviders, selectedUpdateProviderId]);

  const handleChange = <K extends keyof CreateCharacterInput>(key: K, value: CreateCharacterInput[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
    }));
  };

  const handleThemeColorChange = (key: keyof CharacterThemeColors, value: string) => {
    const normalized = normalizeHexInput(value);
    if (!normalized) {
      return;
    }

    setDraft((current) => ({
      ...current,
      themeColors: {
        ...current.themeColors,
        [key]: normalized,
      },
    }));
  };

  const handleThemeRgbChange = (key: keyof CharacterThemeColors, channel: "r" | "g" | "b", value: string) => {
    const numeric = Number.parseInt(value, 10);
    const currentRgb = hexToRgb(draft.themeColors[key]);
    const nextRgb = {
      ...currentRgb,
      [channel]: Number.isNaN(numeric) ? 0 : clampRgb(numeric),
    };
    handleThemeColorChange(key, rgbToHex(nextRgb));
  };

  const handleSessionCopyCandidateChange = (key: keyof CharacterSessionCopy, index: number, value: string) => {
    setDraft((current) => {
      const nextCandidates = ensureSessionCopyEditorCandidates(current.sessionCopy[key]).map((candidate, candidateIndex) =>
        candidateIndex === index ? value : candidate,
      );
      return {
        ...current,
        sessionCopy: {
          ...current.sessionCopy,
          [key]: nextCandidates,
        },
      };
    });
  };

  const handleAddSessionCopyCandidate = (key: keyof CharacterSessionCopy) => {
    setDraft((current) => ({
      ...current,
      sessionCopy: {
        ...current.sessionCopy,
        [key]: [...ensureSessionCopyEditorCandidates(current.sessionCopy[key]), ""],
      },
    }));
  };

  const handleRemoveSessionCopyCandidate = (key: keyof CharacterSessionCopy, index: number) => {
    setDraft((current) => ({
      ...current,
      sessionCopy: {
        ...current.sessionCopy,
        [key]:
          ensureSessionCopyEditorCandidates(current.sessionCopy[key]).length <= 1
            ? [""]
            : ensureSessionCopyEditorCandidates(current.sessionCopy[key]).filter((_, candidateIndex) => candidateIndex !== index),
      },
    }));
  };

  const handlePickImage = () => {
    fileInputRef.current?.click();
  };

  const handleImageFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }

        reject(new Error("画像の読み込み結果が不正だよ"));
      };
      reader.onerror = () => reject(reader.error ?? new Error("画像の読み込みに失敗したよ"));
      reader.readAsDataURL(file);
    });

    handleChange("iconPath", dataUrl);
    event.target.value = "";
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      return;
    }

    if (selectedCharacter && !isCreateMode) {
      const saved = await withWithMateApi((api) => api.updateCharacter({
        ...selectedCharacter,
        ...draft,
        updatedAt: currentTimestampLabel(),
      }));
      if (!saved) {
        return;
      }
      setCharacterId(saved.id);
      setIsCreateMode(false);
      window.history.replaceState({}, "", buildCharacterEditorUrl(saved.id));
      return;
    }

    const created = await withWithMateApi((api) => api.createCharacter(draft));
    if (!created) {
      return;
    }
    setCharacterId(created.id);
    setIsCreateMode(false);
    setDraft(toDraft(created));
    window.history.replaceState({}, "", buildCharacterEditorUrl(created.id));
  };

  const handleDelete = async () => {
    if (!selectedCharacter) {
      return;
    }

    const confirmed = window.confirm(`${selectedCharacter.name} を削除する？`);
    if (!confirmed) {
      return;
    }

    await withWithMateApi((api) => api.deleteCharacter(selectedCharacter.id));
    window.close();
  };

  const handleReload = async () => {
    if (!selectedCharacter || isReloadingCharacter) {
      return;
    }

    if (isDirty) {
      const confirmed = window.confirm("今の未保存の変更を破棄して、保存済みの character 定義を読み直す？");
      if (!confirmed) {
        return;
      }
    }

    setIsReloadingCharacter(true);
    try {
      await withWithMateApi(async (api) => {
        const refreshed = await api.getCharacter(selectedCharacter.id);
        if (!refreshed) {
          return;
        }

        setCharacters((current) =>
          current.map((character) => (character.id === refreshed.id ? refreshed : character)),
        );
        setDraft(toDraft(refreshed));
      });
    } finally {
      setIsReloadingCharacter(false);
    }
  };

  const handleOpenUpdateWorkspace = async () => {
    if (!selectedCharacter) {
      return;
    }
    await withWithMateApi(async (api) => {
      setUpdateWorkspace(await api.getCharacterUpdateWorkspace(selectedCharacter.id));
    });
    setUpdateLaunchOpen(true);
  };

  const handleOpenCharacterFolder = async () => {
    if (!selectedCharacter || isOpeningCharacterFolder) {
      return;
    }

    setIsOpeningCharacterFolder(true);
    try {
      await withWithMateApi(async (api) => {
        const workspace = await api.getCharacterUpdateWorkspace(selectedCharacter.id);
        if (!workspace?.workspacePath) {
          return;
        }

        await api.openPath(workspace.workspacePath);
      });
    } finally {
      setIsOpeningCharacterFolder(false);
    }
  };

  const handleStartUpdateSession = async () => {
    if (!selectedCharacter || !selectedUpdateProviderId || startingUpdateSession) {
      return;
    }

    setStartingUpdateSession(true);
    try {
      await withWithMateApi(async (api) => {
        const session = await api.createCharacterUpdateSession(selectedCharacter.id, selectedUpdateProviderId);
        await api.openSession(session.id);
      });
      setUpdateLaunchOpen(false);
    } finally {
      setStartingUpdateSession(false);
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-editor-page">
        <main className="character-editor-layout">
          <section className="panel empty-list-card rise-1">
            <p>Character Editor は Electron から開いてね。</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell character-editor-page" style={editorThemeStyle}>
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title character-editor-title-accent">{isCreateMode ? "Add Character" : draft.name || selectedCharacter?.name || "Character Editor"}</span>
        <div className="character-editor-header-actions">
          {!isCreateMode && selectedCharacter ? (
            <button className="drawer-toggle" type="button" onClick={() => void handleReload()} disabled={isReloadingCharacter}>
              {isReloadingCharacter ? "Reloading..." : "Reload"}
            </button>
          ) : null}
          {!isCreateMode && selectedCharacter ? (
            <button
              className="drawer-toggle"
              type="button"
              onClick={() => void handleOpenCharacterFolder()}
              disabled={isOpeningCharacterFolder}
            >
              {isOpeningCharacterFolder ? "Opening..." : "Open Folder"}
            </button>
          ) : null}
          {!isCreateMode && selectedCharacter ? (
            <button className="launch-toggle" type="button" onClick={() => void handleOpenUpdateWorkspace()}>
              Open Update Workspace
            </button>
          ) : null}
          <button className="drawer-toggle" type="button" onClick={() => window.close()}>
            Close Window
          </button>
        </div>
      </header>

      <div className="character-editor-tabs-row">
        <div className="character-editor-tabs" role="tablist" aria-label="キャラクター編集モード">
          <button
            type="button"
            role="tab"
            aria-selected={editorTab === "profile"}
            className={`character-editor-tab${editorTab === "profile" ? " active" : ""}`}
            onClick={() => setEditorTab("profile")}
          >
            Profile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editorTab === "character-md"}
            className={`character-editor-tab${editorTab === "character-md" ? " active" : ""}`}
            onClick={() => setEditorTab("character-md")}
          >
            character.md
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editorTab === "character-notes"}
            className={`character-editor-tab${editorTab === "character-notes" ? " active" : ""}`}
            onClick={() => setEditorTab("character-notes")}
          >
            character-notes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editorTab === "session-copy"}
            className={`character-editor-tab${editorTab === "session-copy" ? " active" : ""}`}
            onClick={() => setEditorTab("session-copy")}
          >
            Session Copy
          </button>
        </div>
      </div>

      <main className="character-editor-layout rise-2">
        <section className={`${editorTab === "profile" ? "panel " : ""}character-editor-main character-editor-main-${editorTab}`}>
          {editorTab === "profile" ? (
            <div className="character-editor-content">
              <div className="character-editor-preview">
                <CharacterAvatar
                  character={previewCharacter}
                  size="large"
                  className="character-editor-avatar"
                />
                <div className="character-editor-preview-copy">
                  <strong>{draft.name || "新規キャラクター"}</strong>
                  <p>{draft.description || ""}</p>
                </div>
                <div className="character-theme-preview" aria-hidden="true">
                  <span style={{ backgroundColor: draft.themeColors.main }} />
                  <span style={{ backgroundColor: draft.themeColors.sub }} />
                </div>
              </div>

              <input
                ref={fileInputRef}
                className="hidden-file-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => void handleImageFileChange(event)}
              />

              <section className="character-form-grid">
                <label className="editor-field">
                  <span>Name</span>
                  <input value={draft.name} onChange={(event) => handleChange("name", event.target.value)} />
                </label>

                <label className="editor-field">
                  <span>Icon</span>
                  <div className="editor-inline-field">
                    <input value={draft.iconPath} onChange={(event) => handleChange("iconPath", event.target.value)} />
                    <button className="browse-button" type="button" onClick={() => void handlePickImage()}>
                      Browse
                    </button>
                  </div>
                </label>

                <label className="editor-field wide">
                  <span>Description</span>
                  <textarea value={draft.description} onChange={(event) => handleChange("description", event.target.value)} />
                </label>

                <section className="editor-field wide theme-fieldset">
                  <span>Theme</span>
                  <div className="theme-color-grid">
                    {(["main", "sub"] as const).map((themeKey) => {
                      const rgb = hexToRgb(draft.themeColors[themeKey]);
                      return (
                        <div key={themeKey} className="theme-color-card">
                          <strong>{themeKey === "main" ? "Main" : "Sub"}</strong>
                          <div className="theme-color-picker-row">
                            <label
                              className="theme-color-swatch"
                              style={{ "--theme-swatch-color": draft.themeColors[themeKey] } as CSSProperties}
                            >
                              <input
                                className="theme-color-input"
                                type="color"
                                value={draft.themeColors[themeKey]}
                                onChange={(event) => handleThemeColorChange(themeKey, event.target.value)}
                              />
                            </label>
                            <label className="theme-hex-field">
                              <span>Hex</span>
                              <input
                                type="text"
                                inputMode="text"
                                value={draft.themeColors[themeKey]}
                                onChange={(event) => handleThemeColorChange(themeKey, event.target.value)}
                              />
                            </label>
                          </div>
                          <div className="theme-rgb-grid">
                            <label>
                              <span>R</span>
                              <input
                                type="number"
                                min={0}
                                max={255}
                                value={rgb.r}
                                onChange={(event) => handleThemeRgbChange(themeKey, "r", event.target.value)}
                              />
                            </label>
                            <label>
                              <span>G</span>
                              <input
                                type="number"
                                min={0}
                                max={255}
                                value={rgb.g}
                                onChange={(event) => handleThemeRgbChange(themeKey, "g", event.target.value)}
                              />
                            </label>
                            <label>
                              <span>B</span>
                              <input
                                type="number"
                                min={0}
                                max={255}
                                value={rgb.b}
                                onChange={(event) => handleThemeRgbChange(themeKey, "b", event.target.value)}
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </section>
            </div>
          ) : editorTab === "character-md" ? (
            <div className="character-editor-content character-markdown-content">
              <div className="character-markdown-card">
                <div className="character-markdown-note">
                  <strong>character.md</strong>
                  <p>この内容はキャラクター定義の正本として保存され、実行時の Character section にそのまま使われる。</p>
                </div>
                <label className="markdown-editor-shell character-markdown-shell">
                  <textarea
                    className="markdown-editor-textarea character-markdown-textarea"
                    value={draft.roleMarkdown}
                    onChange={(event) => handleChange("roleMarkdown", event.target.value)}
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>
          ) : editorTab === "character-notes" ? (
            <div className="character-editor-content character-markdown-content">
              <div className="character-markdown-card">
                <div className="character-markdown-note">
                  <strong>character-notes.md</strong>
                  <p>この内容は調査メモ、採用理由、出典、未確定事項、改稿履歴の保管用で、通常の prompt 合成には直接使われない。</p>
                </div>
                <label className="markdown-editor-shell character-markdown-shell">
                  <textarea
                    className="markdown-editor-textarea character-markdown-textarea"
                    value={draft.notesMarkdown}
                    onChange={(event) => handleChange("notesMarkdown", event.target.value)}
                    spellCheck={false}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="character-editor-content">
              <div className="character-markdown-card">
                <div className="character-markdown-note">
                  <strong>Session Copy</strong>
                  <p>SessionWindow の固定文言を character ごとに差し替える。`{"{name}"}` を入れるとキャラクター名に置換される。</p>
                </div>
                <section className="character-form-grid">
                  {sessionCopyFieldDefinitions.map((field) => (
                    <label key={field.key} className="editor-field wide">
                      <span>{field.label}</span>
                      <div className="session-copy-candidate-list">
                        {ensureSessionCopyEditorCandidates(draft.sessionCopy[field.key]).map((candidate, index) => (
                          <div key={`${field.key}-${index}`} className="session-copy-candidate-row">
                            <input
                              value={candidate}
                              placeholder={field.placeholder}
                              onChange={(event) => handleSessionCopyCandidateChange(field.key, index, event.target.value)}
                            />
                            <button
                              type="button"
                              className="session-copy-candidate-remove"
                              onClick={() => handleRemoveSessionCopyCandidate(field.key, index)}
                              aria-label={`${field.label} の候補 ${index + 1} を削除`}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="drawer-toggle compact session-copy-candidate-add"
                        onClick={() => handleAddSessionCopyCandidate(field.key)}
                      >
                        +
                      </button>
                    </label>
                  ))}
                </section>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="panel character-editor-footer rise-2">
        <div className="character-editor-actions">
          <button className="start-session-button" type="button" onClick={() => void handleSave()}>
            Save
          </button>
          {!isCreateMode && selectedCharacter ? (
            <button className="danger-button" type="button" onClick={() => void handleDelete()}>
              Delete
            </button>
          ) : null}
        </div>
      </footer>

      {updateLaunchOpen && selectedCharacter ? (
        <div className="launch-modal" role="dialog" aria-modal="true" onClick={() => setUpdateLaunchOpen(false)}>
          <section
            ref={updateLaunchDialogRef}
            className="launch-dialog panel"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleUpdateLaunchDialogKeyDown}
          >
            <div className="launch-dialog-head minimal">
              <button className="diff-close" type="button" onClick={() => setUpdateLaunchOpen(false)}>
                Close
              </button>
            </div>

            <div className="launch-panel minimal">
              <section className="launch-section minimal">
                <div className="launch-field">
                  <label className="launch-field-label" htmlFor="character-update-launch-title">
                    セッションタイトル
                  </label>
                  <input
                    id="character-update-launch-title"
                    className="launch-field-input"
                    type="text"
                    value={`${selectedCharacter.name} の更新`}
                    readOnly
                  />
                </div>
              </section>

              <section className="launch-section workspace-picker minimal">
                <div className="section-head compact-actions">
                  <strong>Workspace</strong>
                </div>
                <p className="launch-path selected">{updateWorkspace?.workspacePath ?? "workspace を読み込み中"}</p>
              </section>

              <section className="launch-section minimal">
                <div className="launch-field">
                  <label className="launch-field-label" htmlFor="character-update-provider-picker">
                    Coding Provider
                  </label>
                  {enabledUpdateProviders.length > 0 ? (
                    <div
                      id="character-update-provider-picker"
                      className="choice-list launch-provider-list"
                      role="listbox"
                      aria-label="Character Update Provider"
                      aria-orientation="horizontal"
                      onKeyDown={(event) => {
                        focusRovingItemByKey(event, { orientation: "horizontal", activateOnFocus: true });
                      }}
                    >
                      {enabledUpdateProviders.map((provider) => (
                        <button
                          key={provider.id}
                          className={`choice-chip${provider.id === selectedUpdateProviderId ? " active" : ""}`}
                          type="button"
                          role="option"
                          aria-selected={provider.id === selectedUpdateProviderId}
                          tabIndex={provider.id === selectedUpdateProviderId ? 0 : -1}
                          onClick={() => setSelectedUpdateProviderId(provider.id)}
                        >
                          {provider.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <article className="empty-list-card compact">
                      <p>有効な Coding Provider がないよ。</p>
                    </article>
                  )}
                </div>
              </section>
            </div>

            <div className="launch-dialog-foot minimal">
              <button
                className="start-session-button"
                type="button"
                disabled={!selectedUpdateProviderId || startingUpdateSession}
                onClick={() => void handleStartUpdateSession()}
              >
                {startingUpdateSession ? "Starting..." : "Start Update Session"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
