import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import {
  buildNewSession,
  cloneCharacterProfiles,
  cloneSessions,
  initialSessions,
  type CharacterProfile,
  type CreateCharacterInput,
  type CreateSessionInput,
  type DiffPreviewPayload,
  type Session,
} from "../src/mock-data.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  resolveModelSelection,
  type ModelCatalogDocument,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import {
  createStoredCharacter,
  deleteStoredCharacter,
  getStoredCharacter,
  listStoredCharacters,
  updateStoredCharacter,
} from "./character-storage.js";
import { CodexAdapter } from "./codex-adapter.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { SessionStorage } from "./session-storage.js";
import {
  WITHMATE_CHARACTERS_CHANGED_EVENT,
  WITHMATE_CREATE_CHARACTER_CHANNEL,
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_DELETE_SESSION_CHANNEL,
  WITHMATE_DELETE_CHARACTER_CHANNEL,
  WITHMATE_GET_CHARACTER_CHANNEL,
  WITHMATE_GET_DIFF_PREVIEW_CHANNEL,
  WITHMATE_GET_MODEL_CATALOG_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_LIST_CHARACTERS_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_MODEL_CATALOG_CHANGED_EVENT,
  WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL,
  WITHMATE_OPEN_DIFF_WINDOW_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_RUN_SESSION_TURN_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL,
  WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL,
  WITHMATE_UPDATE_CHARACTER_CHANNEL,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../src/withmate-window.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const bundledModelCatalogPath = devServerUrl
  ? path.resolve(currentDir, "../../public/model-catalog.json")
  : path.resolve(rendererDistPath, "model-catalog.json");
const codexAdapter = new CodexAdapter();

let homeWindow: BrowserWindow | null = null;
const sessionWindows = new Map<string, BrowserWindow>();
const characterEditorWindows = new Map<string, BrowserWindow>();
const diffWindows = new Map<string, BrowserWindow>();
const diffPreviewStore = new Map<string, DiffPreviewPayload>();
const inFlightSessionRuns = new Set<string>();
const allowCloseSessionWindows = new Set<string>();
let sessions = cloneSessions(initialSessions);
let characters: CharacterProfile[] = [];
let sessionStorage: SessionStorage | null = null;
let modelCatalogStorage: ModelCatalogStorage | null = null;
let allowQuitWithInFlightRuns = false;

function createBaseWindow(options: ConstructorParameters<typeof BrowserWindow>[0]): BrowserWindow {
  return new BrowserWindow({
    backgroundColor: "#0e131b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...options,
  });
}

function listSessions(): Session[] {
  return cloneSessions(sessions);
}

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

function hasInFlightSessionRuns(): boolean {
  return inFlightSessionRuns.size > 0;
}

function isSessionRunInFlight(sessionId: string): boolean {
  return inFlightSessionRuns.has(sessionId);
}

function requireSessionStorage(): SessionStorage {
  if (!sessionStorage) {
    throw new Error("session storage が初期化されていないよ。");
  }

  return sessionStorage;
}

function requireModelCatalogStorage(): ModelCatalogStorage {
  if (!modelCatalogStorage) {
    throw new Error("model catalog storage が初期化されていないよ。");
  }

  return modelCatalogStorage;
}

function getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null {
  return requireModelCatalogStorage().getCatalog(revision ?? null);
}

function resolveProviderCatalog(
  providerId: string | null | undefined,
  revision?: number | null,
): { snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider } {
  const snapshot = getModelCatalog(revision) ?? requireModelCatalogStorage().ensureSeeded();
  const provider = getProviderCatalog(snapshot.providers, providerId ?? DEFAULT_PROVIDER_ID);
  if (!provider) {
    throw new Error("利用できる model catalog provider が見つからないよ。");
  }

  return { snapshot, provider };
}

function listCharacters(): CharacterProfile[] {
  return cloneCharacterProfiles(characters);
}

function getSession(sessionId: string): Session | null {
  return cloneSessions(sessions).find((session) => session.id === sessionId) ?? null;
}

async function refreshCharactersFromStorage(): Promise<CharacterProfile[]> {
  characters = await listStoredCharacters();
  return listCharacters();
}

async function getCharacter(characterId: string): Promise<CharacterProfile | null> {
  const character = await getStoredCharacter(characterId);
  if (!character) {
    return null;
  }

  const nextCharacters = await refreshCharactersFromStorage();
  return cloneCharacterProfiles(nextCharacters).find((entry) => entry.id === character.id) ?? character;
}

function broadcastSessions(): void {
  const payload = listSessions();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_SESSIONS_CHANGED_EVENT, payload);
    }
  }
}

function broadcastCharacters(): void {
  const payload = listCharacters();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_CHARACTERS_CHANGED_EVENT, payload);
    }
  }
}

function broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void {
  const payload = snapshot ?? getModelCatalog();
  if (!payload) {
    return;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_MODEL_CATALOG_CHANGED_EVENT, payload);
    }
  }
}

async function importModelCatalogFromFile(targetWindow?: BrowserWindow | null): Promise<ModelCatalogSnapshot | null> {
  const result = targetWindow
    ? await dialog.showOpenDialog(targetWindow, {
        title: "model catalog を読み込む",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showOpenDialog({
        title: "model catalog を読み込む",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const raw = await readFile(result.filePaths[0], "utf8");
  const document = JSON.parse(raw) as ModelCatalogDocument;
  const snapshot = requireModelCatalogStorage().importCatalogDocument(document, "imported");
  broadcastModelCatalog(snapshot);
  return snapshot;
}

async function exportModelCatalogToFile(revision: number | null | undefined, targetWindow?: BrowserWindow | null): Promise<string | null> {
  const document = requireModelCatalogStorage().exportCatalogDocument(revision);
  if (!document) {
    return null;
  }

  const result = targetWindow
    ? await dialog.showSaveDialog(targetWindow, {
        title: "model catalog を保存",
        defaultPath: "model-catalog.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    : await dialog.showSaveDialog({
        title: "model catalog を保存",
        defaultPath: "model-catalog.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

  if (result.canceled || !result.filePath) {
    return null;
  }

  await writeFile(result.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return result.filePath;
}

function createSession(input: CreateSessionInput): Session {
  const { snapshot, provider } = resolveProviderCatalog(input.provider ?? DEFAULT_PROVIDER_ID);
  const selection = resolveModelSelection(
    provider,
    input.model ?? provider.defaultModelId,
    input.reasoningEffort ?? provider.defaultReasoningEffort,
  );
  const created = buildNewSession({
    ...input,
    provider: provider.id,
    catalogRevision: snapshot.revision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
  });
  return upsertSession(created);
}

function updateSession(nextSession: Session): Session {
  return upsertSession(nextSession);
}

function deleteSession(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }

  if (isSessionRunInFlight(sessionId) || isRunningSession(session)) {
    throw new Error("実行中のセッションは削除できないよ。");
  }

  requireSessionStorage().deleteSession(sessionId);
  sessions = requireSessionStorage().listSessions();

  const window = sessionWindows.get(sessionId);
  if (window && !window.isDestroyed()) {
    allowCloseSessionWindows.add(sessionId);
    window.close();
  }

  sessionWindows.delete(sessionId);
  broadcastSessions();
}

function upsertSession(nextSession: Session): Session {
  const storage = requireSessionStorage();
  const stored = storage.upsertSession(nextSession);
  sessions = storage.listSessions();
  broadcastSessions();
  return cloneSessions([stored])[0];
}

function buildInterruptedSession(session: Session): Session {
  const interruptedMessage = "前回の実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
  const lastMessage = session.messages.at(-1);
  const nextMessages =
    lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage
      ? session.messages
      : [
          ...session.messages,
          {
            role: "assistant" as const,
            text: interruptedMessage,
            accent: true,
          },
        ];

  return {
    ...session,
    status: "idle",
    runState: "interrupted",
    updatedAt: "just now",
    messages: nextMessages,
  };
}

function recoverInterruptedSessions(): void {
  const runningSessions = sessions.filter(isRunningSession);
  if (runningSessions.length === 0) {
    return;
  }

  for (const session of runningSessions) {
    upsertSession(buildInterruptedSession(session));
  }

  sessions = requireSessionStorage().listSessions();
}

async function createCharacter(input: CreateCharacterInput): Promise<CharacterProfile> {
  const created = await createStoredCharacter(input);
  await refreshCharactersFromStorage();
  broadcastCharacters();
  return cloneCharacterProfiles([created])[0];
}

async function updateCharacter(nextCharacter: CharacterProfile): Promise<CharacterProfile> {
  const updated = await updateStoredCharacter(nextCharacter);
  await refreshCharactersFromStorage();
  broadcastCharacters();
  return cloneCharacterProfiles([updated])[0];
}

async function deleteCharacter(characterId: string): Promise<void> {
  await deleteStoredCharacter(characterId);
  await refreshCharactersFromStorage();
  broadcastCharacters();

  const window = characterEditorWindows.get(characterId);
  if (window && !window.isDestroyed()) {
    window.close();
  }

  characterEditorWindows.delete(characterId);
}

async function resolveSessionCharacter(session: Session): Promise<CharacterProfile | null> {
  if (session.characterId) {
    const matched = await getCharacter(session.characterId);
    if (matched) {
      return matched;
    }
  }

  const nextCharacters = await refreshCharactersFromStorage();
  return nextCharacters.find((character) => character.name === session.character) ?? null;
}

async function runSessionTurn(sessionId: string, userMessage: string): Promise<Session> {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("対象セッションが見つからないよ。");
  }

  if (session.runState === "running") {
    throw new Error("このセッションはまだ実行中だよ。");
  }

  const nextMessage = userMessage.trim();
  if (!nextMessage) {
    throw new Error("送信するメッセージが空だよ。");
  }

  const character = await resolveSessionCharacter(session);
  if (!character) {
    throw new Error("キャラクター定義が見つからないよ。");
  }

  const { provider } = resolveProviderCatalog(session.provider, session.catalogRevision);

  const runningSession: Session = {
    ...session,
    updatedAt: "just now",
    status: "running",
    runState: "running",
    messages: [...session.messages, { role: "user", text: nextMessage }],
  };

  upsertSession(runningSession);
  inFlightSessionRuns.add(sessionId);

  try {
    const result = await codexAdapter.runSessionTurn({
      session: runningSession,
      character,
      providerCatalog: provider,
      userMessage: nextMessage,
    });

    const completedSession: Session = {
      ...runningSession,
      updatedAt: "just now",
      status: "idle",
      runState: "idle",
      threadId: result.threadId ?? runningSession.threadId,
      messages: [
        ...runningSession.messages,
        {
          role: "assistant",
          text: result.assistantText,
          artifact: result.artifact,
        },
      ],
    };

    return upsertSession(completedSession);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const failedSession: Session = {
      ...runningSession,
      updatedAt: "just now",
      status: "idle",
      runState: "error",
      messages: [
        ...runningSession.messages,
        {
          role: "assistant",
          text: `実行に失敗したよ。\n${message}`,
          accent: true,
        },
      ],
    };

    return upsertSession(failedSession);
  } finally {
    inFlightSessionRuns.delete(sessionId);
  }
}

async function loadHomeEntry(window: BrowserWindow): Promise<void> {
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "index.html"));
}

async function loadSessionEntry(window: BrowserWindow, sessionId: string): Promise<void> {
  const search = `sessionId=${encodeURIComponent(sessionId)}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/session.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "session.html"), { search });
}

async function loadCharacterEntry(window: BrowserWindow, characterId?: string | null): Promise<void> {
  const search = characterId
    ? `characterId=${encodeURIComponent(characterId)}`
    : "mode=create";

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/character.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "character.html"), { search });
}

async function loadDiffEntry(window: BrowserWindow, token: string): Promise<void> {
  const search = `token=${encodeURIComponent(token)}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/diff.html?${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "diff.html"), { search });
}

async function createHomeWindow(): Promise<BrowserWindow> {
  if (homeWindow && !homeWindow.isDestroyed()) {
    if (homeWindow.isMinimized()) {
      homeWindow.restore();
    }

    homeWindow.focus();
    return homeWindow;
  }

  const window = createBaseWindow({
    width: 1320,
    height: 900,
    minWidth: 1040,
    minHeight: 760,
    title: "WithMate Home",
  });

  homeWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    homeWindow = null;
  });

  await loadHomeEntry(window);
  return window;
}

async function openSessionWindow(sessionId: string): Promise<BrowserWindow> {
  const existingWindow = sessionWindows.get(sessionId);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }

    existingWindow.focus();
    return existingWindow;
  }

  const window = createBaseWindow({
    width: 1520,
    height: 940,
    minWidth: 1120,
    minHeight: 760,
    title: `WithMate Session - ${sessionId}`,
  });

  sessionWindows.set(sessionId, window);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (allowQuitWithInFlightRuns) {
      return;
    }

    if (allowCloseSessionWindows.has(sessionId)) {
      allowCloseSessionWindows.delete(sessionId);
      return;
    }

    if (!isSessionRunInFlight(sessionId)) {
      return;
    }

    event.preventDefault();

    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: ["閉じない", "閉じて続行"],
      defaultId: 0,
      cancelId: 0,
      title: "実行中のセッション",
      message: "このセッションはまだ実行中だよ。",
      detail: "閉じても処理は Main Process 側で続くよ。進捗はあとで開き直して確認してね。",
      noLink: true,
    });

    if (choice !== 1) {
      return;
    }

    allowCloseSessionWindows.add(sessionId);
    window.close();
  });
  window.on("closed", () => {
    allowCloseSessionWindows.delete(sessionId);
    sessionWindows.delete(sessionId);
  });

  await loadSessionEntry(window, sessionId);
  return window;
}

async function openCharacterEditorWindow(characterId?: string | null): Promise<BrowserWindow> {
  const key = characterId ?? "__new__";
  const existingWindow = characterEditorWindows.get(key);
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }

    existingWindow.focus();
    return existingWindow;
  }

  const window = createBaseWindow({
    width: 980,
    height: 840,
    minWidth: 760,
    minHeight: 680,
    title: characterId ? `Character Editor - ${characterId}` : "Character Editor - New",
  });

  characterEditorWindows.set(key, window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    characterEditorWindows.delete(key);
  });

  await loadCharacterEntry(window, characterId ?? null);
  return window;
}

async function openDiffWindow(diffPreview: DiffPreviewPayload): Promise<BrowserWindow> {
  const token = crypto.randomUUID();
  const window = createBaseWindow({
    width: 1680,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: `Diff - ${diffPreview.file.path}`,
  });

  diffPreviewStore.set(token, diffPreview);
  diffWindows.set(token, window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    diffWindows.delete(token);
    diffPreviewStore.delete(token);
  });

  await loadDiffEntry(window, token);
  return window;
}

app.whenReady().then(async () => {
  const dbPath = path.join(app.getPath("userData"), "withmate.db");
  modelCatalogStorage = new ModelCatalogStorage(dbPath, bundledModelCatalogPath);
  const activeModelCatalog = modelCatalogStorage.ensureSeeded();
  sessionStorage = new SessionStorage(dbPath);
  sessions = sessionStorage.listSessions();
  recoverInterruptedSessions();
  await refreshCharactersFromStorage();

  ipcMain.handle(WITHMATE_OPEN_SESSION_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return;
    }

    await openSessionWindow(sessionId);
  });

  ipcMain.handle(WITHMATE_OPEN_CHARACTER_EDITOR_CHANNEL, async (_event, characterId: string | null) => {
    await openCharacterEditorWindow(characterId);
  });
  ipcMain.handle(WITHMATE_OPEN_DIFF_WINDOW_CHANNEL, async (_event, diffPreview: DiffPreviewPayload) => {
    await openDiffWindow(diffPreview);
  });

  ipcMain.handle(WITHMATE_LIST_SESSIONS_CHANNEL, () => listSessions());
  ipcMain.handle(WITHMATE_LIST_CHARACTERS_CHANNEL, async () => refreshCharactersFromStorage());
  ipcMain.handle(WITHMATE_GET_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) => getModelCatalog(revision));
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_CHANNEL, (_event, document: ModelCatalogDocument) => {
    const snapshot = requireModelCatalogStorage().importCatalogDocument(document, "imported");
    broadcastModelCatalog(snapshot);
    return snapshot;
  });
  ipcMain.handle(WITHMATE_IMPORT_MODEL_CATALOG_FILE_CHANNEL, async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    return importModelCatalogFromFile(targetWindow);
  });
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_CHANNEL, (_event, revision: number | null) =>
    requireModelCatalogStorage().exportCatalogDocument(revision),
  );
  ipcMain.handle(WITHMATE_EXPORT_MODEL_CATALOG_FILE_CHANNEL, async (event, revision: number | null) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    return exportModelCatalogToFile(revision, targetWindow);
  });

  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }

    return getSession(sessionId);
  });
  ipcMain.handle(WITHMATE_GET_DIFF_PREVIEW_CHANNEL, (_event, token: string) => {
    if (!token) {
      return null;
    }

    return diffPreviewStore.get(token) ?? null;
  });

  ipcMain.handle(WITHMATE_GET_CHARACTER_CHANNEL, async (_event, characterId: string) => {
    if (!characterId) {
      return null;
    }

    return getCharacter(characterId);
  });

  ipcMain.handle(WITHMATE_CREATE_SESSION_CHANNEL, (_event, input: CreateSessionInput) => createSession(input));
  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) => updateSession(session));
  ipcMain.handle(WITHMATE_DELETE_SESSION_CHANNEL, (_event, sessionId: string) => deleteSession(sessionId));
  ipcMain.handle(WITHMATE_RUN_SESSION_TURN_CHANNEL, async (_event, sessionId: string, userMessage: string) =>
    runSessionTurn(sessionId, userMessage),
  );
  ipcMain.handle(WITHMATE_CREATE_CHARACTER_CHANNEL, async (_event, input: CreateCharacterInput) => createCharacter(input));
  ipcMain.handle(WITHMATE_UPDATE_CHARACTER_CHANNEL, async (_event, character: CharacterProfile) => updateCharacter(character));
  ipcMain.handle(WITHMATE_DELETE_CHARACTER_CHANNEL, async (_event, characterId: string) => deleteCharacter(characterId));

  ipcMain.handle(WITHMATE_PICK_DIRECTORY_CHANNEL, async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? homeWindow ?? undefined;
    const result = targetWindow
      ? await dialog.showOpenDialog(targetWindow, {
          properties: ["openDirectory"],
          title: "作業ディレクトリを選択",
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
          title: "作業ディレクトリを選択",
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  await createHomeWindow();
  broadcastModelCatalog(activeModelCatalog);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createHomeWindow();
      return;
    }

    await createHomeWindow();
  });
});

app.on("window-all-closed", () => {
  if (hasInFlightSessionRuns()) {
    void createHomeWindow();
    return;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (hasInFlightSessionRuns() && !allowQuitWithInFlightRuns) {
    event.preventDefault();

    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["戻る", "終了する"],
      defaultId: 0,
      cancelId: 0,
      title: "実行中のセッション",
      message: "実行中のセッションがあるよ。",
      detail: "ここでアプリを終了すると、進行中の処理は中断されるよ。",
      noLink: true,
    });

    if (choice !== 1) {
      return;
    }

    allowQuitWithInFlightRuns = true;
    app.quit();
    return;
  }

  sessionStorage?.close();
  sessionStorage = null;
  modelCatalogStorage?.close();
  modelCatalogStorage = null;
});
