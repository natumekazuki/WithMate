import type { BrowserWindow } from "electron";

import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import type {
  SessionFilePreviewWindowPayload,
  SessionFilePreviewResourceRequest,
  SessionFilePreviewWindowSummary,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { AuxWindowService } from "../auxiliary/aux-window-service.js";
import type { SessionWindowBridge } from "../windows/session-window-bridge.js";

/** Session 専用ウィンドウと、その他のアプリウィンドウに接続する取得口。 */
type MainWindowFacadeDeps = {
  /** Home・設定・プレビューなどを管理するサービスを取得する。 */
  getAuxWindowService(): AuxWindowService<BrowserWindow>;
  /** Session ウィンドウの生成・終了と ID 管理を担うブリッジを取得する。 */
  getSessionWindowBridge(): SessionWindowBridge<BrowserWindow>;
};

/** Main のウィンドウ操作を、それぞれの所有サービスに振り分ける。 */
export class MainWindowFacade {
  /** ウィンドウの種別ごとに現在の所有サービスを解決する取得口を保持する。 */
  constructor(private readonly deps: MainWindowFacadeDeps) {}

  /** Home の作成または再表示を、その所有サービスに任せる。 */
  async openHomeWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openHomeWindow();
  }

  /** アプリの Session 監視用ウィンドウを表示する。個別の Session は開かない。 */
  async openSessionMonitorWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openSessionMonitorWindow();
  }

  /** アプリ設定を編集する専用ウィンドウを表示する。 */
  async openSettingsWindow(): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openSettingsWindow();
  }

  /** 指定したウィンドウが、サービスが管理する設定画面か照合する。 */
  isSettingsWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isSettingsWindow(window);
  }

  /** 指定したウィンドウが、アプリの Session 監視画面か照合する。 */
  isSessionMonitorWindow(window: BrowserWindow): boolean {
    return this.deps.getAuxWindowService().isSessionMonitorWindow(window);
  }

  /** Character ID があれば該当エディターを、未指定なら新規作成画面を開く。 */
  async openCharacterEditorWindow(
    characterId?: string | null,
  ): Promise<BrowserWindow> {
    return this.deps
      .getAuxWindowService()
      .openCharacterEditorWindow(characterId);
  }

  /** 指定した Session を開き、Auxiliary の ID があれば表示先として渡す。 */
  async openSessionWindow(
    sessionId: string,
    auxiliarySessionId?: string,
  ): Promise<BrowserWindow> {
    return this.deps
      .getSessionWindowBridge()
      .openSessionWindow(sessionId, { auxiliarySessionId });
  }

  /** Session ウィンドウを閉じるようブリッジに依頼する。処理の完了は返さない。 */
  closeSessionWindow(sessionId: string): void {
    this.deps.getSessionWindowBridge().closeSessionWindow(sessionId);
  }

  /** 通常の閉鎖手順を要求し、実際に閉じられたかを返す。対象がなければ false を返す。 */
  requestCloseSessionWindow(sessionId: string): Promise<boolean> {
    return this.deps
      .getSessionWindowBridge()
      .requestCloseSessionWindow(sessionId);
  }

  /** 渡された比較内容を表示する差分ウィンドウを開く。 */
  async openDiffWindow(
    diffPreview: DiffPreviewPayload,
  ): Promise<BrowserWindow> {
    return this.deps.getAuxWindowService().openDiffWindow(diffPreview);
  }

  /** ファイルプレビューを表示し、新規作成か既存ウィンドウの前面表示かを返す。 */
  async openFilePreviewWindow(
    payload: SessionFilePreviewWindowPayload,
  ): Promise<{ window: BrowserWindow; disposition: "created" | "focused" }> {
    return this.deps.getAuxWindowService().openFilePreviewWindow(payload);
  }

  /** プレビューのトークンに紐付いた表示データを取得する。対応がなければ null を返す。 */
  getFilePreviewPayload(token: string): SessionFilePreviewWindowPayload | null {
    return this.deps.getAuxWindowService().getFilePreviewPayload(token);
  }

  /** プレビューを所有 Session ごとにまとめる。プレビューのない開いた Session も含める。 */
  listFilePreviewWindows() {
    const groups = new Map<
      string,
      { ownerSessionId: string; previews: SessionFilePreviewWindowSummary[] }
    >();
    for (const ownerSessionId of this.listOpenSessionWindowIds()) {
      groups.set(ownerSessionId, { ownerSessionId, previews: [] });
    }
    for (const group of this.deps
      .getAuxWindowService()
      .listFilePreviewWindows()) {
      groups.set(group.ownerSessionId, group);
    }
    return [...groups.values()];
  }

  /** 指定トークンに対応する既存プレビューを前面に出す。 */
  focusFilePreviewWindow(token: string): void {
    this.deps.getAuxWindowService().focusFilePreviewWindow(token);
  }

  /** 指定トークンに対応するプレビューだけに閉鎖を依頼する。 */
  closeFilePreviewWindow(token: string): void {
    this.deps.getAuxWindowService().closeFilePreviewWindow(token);
  }

  /** 指定した所有 Session に紐付くプレビューをまとめて閉じる。 */
  closeFilePreviewWindowsForOwner(ownerSessionId: string): void {
    this.deps
      .getAuxWindowService()
      .closeFilePreviewWindowsForOwner(ownerSessionId);
  }

  /** ウィンドウが指定の Session のファイルプレビューに一致するかを照合する。 */
  isFilePreviewWindow(window: BrowserWindow, sessionId: string): boolean {
    return this.deps
      .getAuxWindowService()
      .isFilePreviewWindow(window, sessionId);
  }

  /** ウィンドウと Session の両方に一致するプレビューから、要求された表現のリソース参照を得る。 */
  getFilePreviewWindowResource(
    window: BrowserWindow,
    sessionId: string,
    representation?: "source" | "absolute",
  ): SessionFilePreviewResourceRequest | null {
    return this.deps
      .getAuxWindowService()
      .getFilePreviewWindowResource(window, sessionId, representation);
  }

  /** プレビューのトークンがこのウィンドウ自身に発行されたものか照合する。 */
  isFilePreviewTokenWindow(window: BrowserWindow, token: string): boolean {
    return this.deps
      .getAuxWindowService()
      .isFilePreviewTokenWindow(window, token);
  }

  /** 指定 Session が参照元または所有者であるプレビューを閉じる。 */
  closeFilePreviewWindowsForSession(sessionId: string): void {
    this.deps
      .getAuxWindowService()
      .closeFilePreviewWindowsForSession(sessionId);
  }

  /** Session ウィンドウとして開いている ID だけを取得する。 */
  listOpenSessionWindowIds(): string[] {
    return this.deps.getSessionWindowBridge().listOpenSessionWindowIds();
  }

  /** ストレージのリセット対象となる Session と関連ウィンドウを、各所有サービスで閉じる。 */
  closeResetTargetWindows(): void {
    this.deps.getSessionWindowBridge().closeAllSessionWindows();
    this.deps.getAuxWindowService().closeResetTargetWindows();
  }
}
