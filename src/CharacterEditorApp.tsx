import { useEffect, useMemo, useState } from "react";

import type { CharacterDetail, CharacterRuntimeSnapshot } from "./character/character-catalog.js";
import { buildCharacterRuntimePromptSection } from "./character/character-runtime-snapshot.js";
import {
  buildCharacterEditorValidationSummary,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  formatCharacterEditorError,
  isCharacterEditorDraftDirty,
  type CharacterEditorDraft,
  type CharacterEditorTab,
  updateCharacterEditorDraft,
} from "./character-editor/character-editor-state.js";
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

export default function CharacterEditorApp() {
  const desktopRuntime = isDesktopRuntime();
  const initialCharacterId = useMemo(() => getCharacterEditorCharacterIdFromLocation(), []);
  const [persistedDetail, setPersistedDetail] = useState<CharacterDetail | null>(null);
  const [draft, setDraft] = useState<CharacterEditorDraft>(() => createNewCharacterEditorDraft());
  const [selectedTab, setSelectedTab] = useState<CharacterEditorTab>("profile");
  const [loading, setLoading] = useState(Boolean(initialCharacterId));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");

  const validation = useMemo(() => buildCharacterEditorValidationSummary(draft), [draft]);
  const dirty = isCharacterEditorDraftDirty(draft, persistedDetail);
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
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty || saving) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving]);

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
    if (validation.blockingIssues.length > 0) {
      setFeedback("validation issue を解消してから保存してください。");
      setSelectedTab(validation.definitionIssues.length > 0 ? "definition" : "notes");
      return;
    }

    setSaving(true);
    setFeedback("保存しています...");
    try {
      if (draft.mode === "create") {
        const created = await api.createCharacter({
          name: draft.name,
          description: draft.description,
          iconFilePath: draft.iconFilePath,
          theme: draft.theme,
          definitionMarkdown: draft.definitionMarkdown,
          notesMarkdown: draft.notesMarkdown,
          setDefault: draft.isDefault,
        });
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
      const updated = await api.updateCharacterMetadata({
        characterId: draft.characterId,
        name: draft.name,
        description: draft.description,
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
    if (!api || !draft.characterId || draft.isDefault) {
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
    if (!api || !draft.characterId) {
      return;
    }
    if (!window.confirm("この Character を archive しますか？\n\nHome list と New Session selector には出なくなります。")) {
      return;
    }

    setSaving(true);
    try {
      await api.archiveCharacter(draft.characterId);
      setFeedback("Character を archive しました。この window は閉じても大丈夫です。");
    } catch (error) {
      setFeedback(formatCharacterEditorError(error, "Character の archive に失敗しました。"));
    } finally {
      setSaving(false);
    }
  };

  const closeWindow = () => {
    if (dirty && !window.confirm("未保存の編集があります。\n\n保存せずに閉じますか？")) {
      return;
    }
    window.close();
  };

  const pickIcon = async () => {
    const api = getWithMateApi();
    const selected = await api?.pickImageFile(draft.iconFilePath || null);
    if (selected) {
      updateDraft({ iconFilePath: selected });
    }
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
      <section className="panel character-editor-window rise-2">
        <header className="character-editor-window-header">
          <div className="character-editor-heading">
            <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
            <div>
              <p className="settings-note">{draft.mode === "create" ? "Create Character" : "Edit Character"}</p>
              <h1>{draft.name || "New Character"}</h1>
              <p>{draft.description || "No description"}</p>
            </div>
          </div>
          <div className="character-editor-header-actions">
            <span className="settings-character-badge">{saving ? "Saving" : dirty ? "Unsaved" : "Saved"}</span>
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

        <main className="character-editor-window-body">
          {loading ? <p className="settings-note">Character を読み込んでいます...</p> : null}
          {!loading && selectedTab === "profile" ? (
            <section className="settings-section-card character-editor-card">
              <div className="settings-character-form-grid">
                <label className="settings-provider-input">
                  <span>Name</span>
                  <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
                </label>
                <label className="settings-provider-input">
                  <span>Description</span>
                  <input
                    value={draft.description}
                    onChange={(event) => updateDraft({ description: event.target.value })}
                  />
                </label>
                <label className="settings-provider-input">
                  <span>Icon</span>
                  <div className="settings-inline-input-row">
                    <input
                      value={draft.iconFilePath}
                      onChange={(event) => updateDraft({ iconFilePath: event.target.value })}
                    />
                    <button className="launch-toggle compact" type="button" onClick={pickIcon}>
                      Browse
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
                    />
                  </label>
                  <label className="settings-provider-input">
                    <span>Sub</span>
                    <input
                      type="color"
                      value={draft.theme.sub}
                      onChange={(event) => updateDraft({ theme: { ...draft.theme, sub: event.target.value } })}
                    />
                  </label>
                </div>
              </div>
              <div className="settings-actions">
                <button
                  className="launch-toggle"
                  type="button"
                  onClick={setDefaultCharacter}
                  disabled={saving || draft.mode !== "edit" || draft.isDefault}
                >
                  Set Default
                </button>
                {draft.isDefault ? <span className="settings-character-badge">Default</span> : null}
              </div>
            </section>
          ) : null}

          {!loading && selectedTab === "definition" ? (
            <section className="settings-section-card character-editor-card character-editor-markdown-card">
              <strong>character.md</strong>
              <p className="settings-help">Runtime definition の正本です。session / companion 開始時に snapshot 化されます。</p>
              <ValidationList issues={validation.definitionIssues} emptyLabel="character.md validation OK" />
              <textarea
                className="settings-character-markdown-textarea character-editor-textarea"
                value={draft.definitionMarkdown}
                onChange={(event) => updateDraft({ definitionMarkdown: event.target.value })}
                spellCheck={false}
              />
            </section>
          ) : null}

          {!loading && selectedTab === "notes" ? (
            <section className="settings-section-card character-editor-card character-editor-markdown-card">
              <strong>character-notes.md</strong>
              <p className="settings-help">調査メモ、採用理由、改稿履歴用です。V5 Core では runtime prompt に常設注入しません。</p>
              <ValidationList issues={validation.notesIssues} emptyLabel="character-notes.md validation OK" />
              <textarea
                className="settings-character-notes-textarea character-editor-textarea"
                value={draft.notesMarkdown}
                onChange={(event) => updateDraft({ notesMarkdown: event.target.value })}
                spellCheck={false}
              />
            </section>
          ) : null}

          {!loading && selectedTab === "preview" ? (
            <section className="settings-section-card character-editor-card character-editor-preview-grid">
              <div className="home-character-card-preview">
                <CharacterAvatar character={{ name: draft.name, iconPath: draft.iconFilePath }} size="large" />
                <strong>{draft.name || "New Character"}</strong>
                <p>{draft.description || "No description"}</p>
                {draft.isDefault ? <span className="settings-character-badge">Default</span> : null}
              </div>
              <label className="settings-provider-input">
                <span>Runtime prompt preview</span>
                <textarea value={runtimePromptPreview} readOnly rows={14} spellCheck={false} />
              </label>
            </section>
          ) : null}
        </main>

        <footer className="character-editor-window-footer">
          <button
            className="launch-toggle danger-button"
            type="button"
            onClick={archiveCharacter}
            disabled={saving || draft.mode !== "edit"}
          >
            Archive
          </button>
          <span>{feedback}</span>
          <button className="launch-toggle start-session-button" type="button" onClick={saveCharacter} disabled={saving || !dirty}>
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
