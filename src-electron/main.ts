import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain } from "electron";

import { buildNewSession, cloneSessions, initialSessions, type CreateSessionInput, type Session } from "../src/mock-data.js";
import {
  WITHMATE_CREATE_SESSION_CHANNEL,
  WITHMATE_GET_SESSION_CHANNEL,
  WITHMATE_LIST_SESSIONS_CHANNEL,
  WITHMATE_OPEN_SESSION_CHANNEL,
  WITHMATE_PICK_DIRECTORY_CHANNEL,
  WITHMATE_SESSIONS_CHANGED_EVENT,
  WITHMATE_UPDATE_SESSION_CHANNEL,
} from "../src/withmate-window.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(currentDir, "preload.js");
const rendererDistPath = path.resolve(currentDir, "../../dist");
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let homeWindow: BrowserWindow | null = null;
const sessionWindows = new Map<string, BrowserWindow>();
let sessions = cloneSessions(initialSessions);

function createBaseWindow(options: ConstructorParameters<typeof BrowserWindow>[0]): BrowserWindow {
  return new BrowserWindow({
    backgroundColor: "#0e131b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...options,
  });
}

function listSessions(): Session[] {
  return cloneSessions(sessions);
}

function getSession(sessionId: string): Session | null {
  return cloneSessions(sessions).find((session) => session.id === sessionId) ?? null;
}

function broadcastSessions(): void {
  const payload = listSessions();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(WITHMATE_SESSIONS_CHANGED_EVENT, payload);
    }
  }
}

function createSession(input: CreateSessionInput): Session {
  const created = buildNewSession(input);
  sessions = [created, ...sessions];
  broadcastSessions();
  return cloneSessions([created])[0];
}

function updateSession(nextSession: Session): Session {
  sessions = sessions.map((session) => (session.id === nextSession.id ? cloneSessions([nextSession])[0] : session));
  broadcastSessions();
  return cloneSessions([nextSession])[0];
}

async function loadHomeEntry(window: BrowserWindow): Promise<void> {
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "index.html"));
}

async function loadSessionEntry(window: BrowserWindow, sessionId: string): Promise<void> {
  const search = `?sessionId=${encodeURIComponent(sessionId)}`;

  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}/session.html${search}`);
    return;
  }

  await window.loadFile(path.resolve(rendererDistPath, "session.html"), { search });
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
  window.on("closed", () => {
    sessionWindows.delete(sessionId);
  });

  await loadSessionEntry(window, sessionId);
  return window;
}

app.whenReady().then(async () => {
  ipcMain.handle(WITHMATE_OPEN_SESSION_CHANNEL, async (_event, sessionId: string) => {
    if (!sessionId) {
      return;
    }

    await openSessionWindow(sessionId);
  });

  ipcMain.handle(WITHMATE_LIST_SESSIONS_CHANNEL, () => listSessions());

  ipcMain.handle(WITHMATE_GET_SESSION_CHANNEL, (_event, sessionId: string) => {
    if (!sessionId) {
      return null;
    }

    return getSession(sessionId);
  });

  ipcMain.handle(WITHMATE_CREATE_SESSION_CHANNEL, (_event, input: CreateSessionInput) => {
    return createSession(input);
  });

  ipcMain.handle(WITHMATE_UPDATE_SESSION_CHANNEL, (_event, session: Session) => {
    return updateSession(session);
  });

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

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createHomeWindow();
      return;
    }

    await createHomeWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
