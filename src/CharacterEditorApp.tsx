import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  buildCharacterEditorUrl,
  currentTimestampLabel,
  DEFAULT_CHARACTER_THEME_COLORS,
  getCharacterIdFromLocation,
  getCharacterProfile,
  isCharacterCreateMode,
  type CharacterThemeColors,
  type CharacterProfile,
  type CreateCharacterInput,
} from "./app-state.js";
import { CharacterAvatar } from "./ui-utils.js";

const emptyDraft: CreateCharacterInput = {
  name: "",
  iconPath: "",
  description: "",
  roleMarkdown: "",
  themeColors: DEFAULT_CHARACTER_THEME_COLORS,
};

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

function toRgba(color: string, alpha: number): string {
  const rgb = hexToRgb(color);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function relativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  const channels = [rgb.r, rgb.g, rgb.b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function buildEditorThemeStyle(theme: CharacterThemeColors): CSSProperties {
  const mainInk = relativeLuminance(theme.main) > 0.36 ? "#0f172a" : "#f8fafc";
  return {
    "--character-main": theme.main,
    "--character-main-soft": toRgba(theme.main, 0.14),
    "--character-sub": theme.sub,
    "--character-sub-soft": toRgba(theme.sub, 0.14),
    "--character-main-ink": mainInk,
  } as CSSProperties;
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
    themeColors: character.themeColors,
  };
}

export default function CharacterEditorApp() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [draft, setDraft] = useState<CreateCharacterInput>(emptyDraft);
  const [characterId, setCharacterId] = useState<string | null>(() => getCharacterIdFromLocation());
  const [isCreateMode, setIsCreateMode] = useState<boolean>(() => isCharacterCreateMode() || !getCharacterIdFromLocation());
  const [editorTab, setEditorTab] = useState<"profile" | "character-md">("profile");
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

  const editorThemeStyle = useMemo(() => buildEditorThemeStyle(draft.themeColors), [draft.themeColors]);

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
        updatedAt: currentTimestampLabel(),
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
    <div className="page-shell character-editor-page" style={editorThemeStyle}>
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title">{isCreateMode ? "Add Character" : draft.name || selectedCharacter?.name || "Character Editor"}</span>
        <button className="drawer-toggle" type="button" onClick={() => window.close()}>
          Close Window
        </button>
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
            システムプロンプト
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
          ) : (
            <div className="character-editor-content character-markdown-content">
              <div className="character-markdown-card">
                <div className="character-markdown-note">
                  <strong>character.md</strong>
                  <p>この内容はキャラクター定義の正本として保存され、セッション実行時のプロンプト合成に使われる。</p>
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
    </div>
  );
}
