import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildCharacterEditorUrl,
  getCharacterIdFromLocation,
  getCharacterProfile,
  isCharacterCreateMode,
  type CharacterProfile,
  type CreateCharacterInput,
} from "./app-state.js";
import { CharacterAvatar } from "./ui-utils.js";

const emptyDraft: CreateCharacterInput = {
  name: "",
  iconPath: "",
  description: "",
  roleMarkdown: "",
};

function toDraft(character: CharacterProfile | null): CreateCharacterInput {
  if (!character) {
    return emptyDraft;
  }

  return {
    name: character.name,
    iconPath: character.iconPath,
    description: character.description,
    roleMarkdown: character.roleMarkdown,
  };
}

export default function CharacterEditorApp() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [draft, setDraft] = useState<CreateCharacterInput>(emptyDraft);
  const [characterId, setCharacterId] = useState<string | null>(() => getCharacterIdFromLocation());
  const [isCreateMode, setIsCreateMode] = useState<boolean>(() => isCharacterCreateMode() || !getCharacterIdFromLocation());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.listCharacters().then((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      const currentCharacter = characterId ? getCharacterProfile(characterId, nextCharacters) : null;
      setDraft(toDraft(currentCharacter));
    });

    const unsubscribe = window.withmate.subscribeCharacters((nextCharacters) => {
      if (!active) {
        return;
      }

      setCharacters(nextCharacters);
      const currentCharacter = characterId ? getCharacterProfile(characterId, nextCharacters) : null;
      if (currentCharacter) {
        setDraft(toDraft(currentCharacter));
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [characterId]);

  const selectedCharacter = useMemo(
    () => (characterId ? getCharacterProfile(characterId, characters) : null),
    [characterId, characters],
  );

  const previewCharacter = useMemo(
    () => ({
      name: draft.name || selectedCharacter?.name || "新規",
      iconPath: draft.iconPath || selectedCharacter?.iconPath || "",
    }),
    [draft.iconPath, draft.name, selectedCharacter],
  );

  const handleChange = <K extends keyof CreateCharacterInput>(key: K, value: CreateCharacterInput[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value,
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
    if (!window.withmate || !draft.name.trim()) {
      return;
    }

    if (selectedCharacter && !isCreateMode) {
      const saved = await window.withmate.updateCharacter({
        ...selectedCharacter,
        ...draft,
        updatedAt: "just now",
      });
      setCharacterId(saved.id);
      setIsCreateMode(false);
      window.history.replaceState({}, "", buildCharacterEditorUrl(saved.id));
      return;
    }

    const created = await window.withmate.createCharacter(draft);
    setCharacterId(created.id);
    setIsCreateMode(false);
    setDraft(toDraft(created));
    window.history.replaceState({}, "", buildCharacterEditorUrl(created.id));
  };

  const handleDelete = async () => {
    if (!window.withmate || !selectedCharacter) {
      return;
    }

    const confirmed = window.confirm(`${selectedCharacter.name} を削除する？`);
    if (!confirmed) {
      return;
    }

    await window.withmate.deleteCharacter(selectedCharacter.id);
    window.close();
  };

  if (!isDesktopRuntime) {
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
    <div className="page-shell character-editor-page">
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title">{isCreateMode ? "Add Character" : draft.name || selectedCharacter?.name || "Character Editor"}</span>
        <button className="drawer-toggle" type="button" onClick={() => window.close()}>
          Close Window
        </button>
      </header>

      <main className="character-editor-layout rise-2">
        <section className="panel character-editor-main">
          <div className="character-editor-preview">
            <CharacterAvatar character={previewCharacter} size="large" className="character-editor-avatar" />
            <div className="character-editor-preview-copy">
              <strong>{draft.name || "新規キャラクター"}</strong>
              <p>{draft.description || ""}</p>
            </div>
          </div>

          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(event) => void handleImageFileChange(event)}
          />

          <div className="character-editor-grid">
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
            </section>

            <section className="markdown-editor-panel">
              <div className="markdown-editor-head">
                <strong>character.md</strong>
              </div>
              <label className="markdown-editor-shell">
                <textarea
                  className="markdown-editor-textarea"
                  value={draft.roleMarkdown}
                  onChange={(event) => handleChange("roleMarkdown", event.target.value)}
                  spellCheck={false}
                />
              </label>
            </section>
          </div>
        </section>

        <aside className="panel character-editor-side">
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

          <div className="character-editor-meta">
            <div>
              <span>Updated</span>
              <strong>{selectedCharacter?.updatedAt ?? "draft"}</strong>
            </div>
            <div>
              <span>Mode</span>
              <strong>{isCreateMode ? "create" : "edit"}</strong>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
