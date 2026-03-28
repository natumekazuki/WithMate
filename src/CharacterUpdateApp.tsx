import { useEffect, useMemo, useState } from "react";

import { CharacterAvatar } from "./ui-utils.js";
import { getCharacterIdFromLocation, isCharacterUpdateMode, type CharacterProfile } from "./character-state.js";
import type { CharacterUpdateMemoryExtract, CharacterUpdateWorkspace } from "./character-update-state.js";
import { createDefaultAppSettings, getProviderAppSettings, type AppSettings } from "./provider-settings-state.js";
import type { ModelCatalogSnapshot } from "./model-catalog.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";

function getUpdateCharacterId(): string | null {
  return isCharacterUpdateMode() ? getCharacterIdFromLocation() : null;
}

export default function CharacterUpdateApp() {
  const desktopRuntime = isDesktopRuntime();
  const characterId = useMemo(() => getUpdateCharacterId(), []);
  const [character, setCharacter] = useState<CharacterProfile | null>(null);
  const [workspace, setWorkspace] = useState<CharacterUpdateWorkspace | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [memoryExtract, setMemoryExtract] = useState<CharacterUpdateMemoryExtract | null>(null);
  const [loadingExtract, setLoadingExtract] = useState(false);
  const [startingSession, setStartingSession] = useState(false);

  useEffect(() => {
    let active = true;
    const api = getWithMateApi();
    if (!api || !characterId) {
      return () => {
        active = false;
      };
    }

    void Promise.all([
      api.getCharacter(characterId),
      api.getCharacterUpdateWorkspace(characterId),
      api.getAppSettings(),
      api.getModelCatalog(null),
    ]).then(([nextCharacter, nextWorkspace, nextSettings, nextCatalog]) => {
      if (!active) {
        return;
      }
      setCharacter(nextCharacter);
      setWorkspace(nextWorkspace);
      setAppSettings(nextSettings);
      setModelCatalog(nextCatalog);
    });

    const unsubscribeCharacters = api.subscribeCharacters(() => {
      void api.getCharacter(characterId).then((nextCharacter) => {
        if (active) {
          setCharacter(nextCharacter);
        }
      });
      void api.getCharacterUpdateWorkspace(characterId).then((nextWorkspace) => {
        if (active) {
          setWorkspace(nextWorkspace);
        }
      });
    });
    const unsubscribeAppSettings = api.subscribeAppSettings((nextSettings) => {
      if (active) {
        setAppSettings(nextSettings);
      }
    });
    const unsubscribeModelCatalog = api.subscribeModelCatalog((nextCatalog) => {
      if (active) {
        setModelCatalog(nextCatalog);
      }
    });

    return () => {
      active = false;
      unsubscribeCharacters();
      unsubscribeAppSettings();
      unsubscribeModelCatalog();
    };
  }, [characterId]);

  const enabledProviders = useMemo(() => {
    return (modelCatalog?.providers ?? []).filter((provider) => getProviderAppSettings(appSettings, provider.id).enabled);
  }, [appSettings, modelCatalog]);

  useEffect(() => {
    if (!enabledProviders.find((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(enabledProviders[0]?.id ?? "");
    }
  }, [enabledProviders, selectedProviderId]);

  const selectedInstructionPath = useMemo(() => {
    if (!workspace) {
      return "";
    }
    return selectedProviderId === "copilot" ? workspace.copilotInstructionPath : workspace.codexInstructionPath;
  }, [selectedProviderId, workspace]);

  const handleExtract = async () => {
    const api = getWithMateApi();
    if (!api || !characterId || loadingExtract) {
      return;
    }
    setLoadingExtract(true);
    try {
      setMemoryExtract(await api.extractCharacterUpdateMemory(characterId));
    } finally {
      setLoadingExtract(false);
    }
  };

  const handleCopy = async () => {
    if (!memoryExtract?.text) {
      return;
    }
    await navigator.clipboard.writeText(memoryExtract.text);
  };

  const handleStartSession = async () => {
    const api = getWithMateApi();
    if (!api || !characterId || !selectedProviderId || startingSession) {
      return;
    }
    setStartingSession(true);
    try {
      const session = await api.createCharacterUpdateSession(characterId, selectedProviderId);
      await api.openSession(session.id);
    } finally {
      setStartingSession(false);
    }
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell character-update-page">
        <main className="character-update-layout">
          <section className="panel empty-list-card rise-1">
            <p>Character Update は Electron から開いてね。</p>
          </section>
        </main>
      </div>
    );
  }

  if (!characterId) {
    return (
      <div className="page-shell character-update-page">
        <main className="character-update-layout">
          <section className="panel empty-list-card rise-1">
            <p>characterId が見つからないよ。</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell character-update-page">
      <header className="panel session-window-bar rise-1">
        <span className="session-window-title">
          {character ? `${character.name} Update Workspace` : "Character Update Workspace"}
        </span>
        <button className="drawer-toggle" type="button" onClick={() => window.close()}>
          Close Window
        </button>
      </header>

      <main className="character-update-layout rise-2">
        <section className="panel character-update-main">
          <div className="character-update-head">
            <CharacterAvatar
              character={{ name: character?.name ?? "Character", iconPath: character?.iconPath ?? "" }}
              size="large"
              className="character-editor-avatar"
            />
            <div className="character-update-head-copy">
              <strong>{character?.name ?? "Character"}</strong>
              <span>{workspace?.workspacePath ?? ""}</span>
            </div>
          </div>

          <section className="character-update-section">
            <strong>Provider</strong>
            <div className="choice-list launch-provider-list" role="listbox" aria-label="Character Update Provider">
              {enabledProviders.map((provider) => (
                <button
                  key={provider.id}
                  className={`choice-chip${provider.id === selectedProviderId ? " active" : ""}`}
                  type="button"
                  aria-selected={provider.id === selectedProviderId}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          </section>

          <section className="character-update-section">
            <strong>Files</strong>
            <div className="character-update-file-list">
              <code>{workspace?.characterMarkdownPath ?? ""}</code>
              <code>{selectedInstructionPath}</code>
            </div>
          </section>

          <section className="character-update-section">
            <div className="character-update-actions">
              <button
                className="start-session-button"
                type="button"
                onClick={() => void handleStartSession()}
                disabled={!selectedProviderId || startingSession}
              >
                {startingSession ? "Starting..." : "Start Update Session"}
              </button>
              <button className="launch-toggle" type="button" onClick={() => void handleExtract()} disabled={loadingExtract}>
                {loadingExtract ? "Extracting..." : "Extract Memory"}
              </button>
              <button className="launch-toggle" type="button" onClick={() => void handleCopy()} disabled={!memoryExtract?.text}>
                Copy
              </button>
            </div>
          </section>

          <section className="character-update-section character-update-extract-section">
            <div className="character-update-extract-head">
              <strong>Memory Extract</strong>
              <span>{memoryExtract?.entryCount ?? 0}</span>
            </div>
            <textarea
              className="character-update-extract"
              value={memoryExtract?.text ?? ""}
              readOnly
              spellCheck={false}
            />
          </section>
        </section>
      </main>
    </div>
  );
}
