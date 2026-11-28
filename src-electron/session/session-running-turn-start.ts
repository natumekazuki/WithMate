import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import type {
  Message,
  SessionSummary,
} from "../../src-shared/session/session-state.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";

/** 読み取り時のメッセージ件数を条件に、Turn 開始入力と任意のキュー受付・キャラクター定義を保存するための入力。 */
export type SessionRunningTurnStartInput = {
  sessionId: string;
  incarnationId?: string;
  expectedMessageCount: number;
  userMessage: Message;
  updatedAt: string;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
  queuedTurn?: { queueId: string; turn: SessionTurnInput };
};

/** 開始保存後の正本の要約と定義。キュー経由の場合は同時に保存された Turn も返す。 */
export type SessionRunningTurnStartResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  queuedTurn?: SessionTurnRecord;
};

/** 保存済みのキャラクターを別人に置き換えず、表示に使う公開情報も変えない定義更新かを確認する。 */
export function assertCharacterDefinitionSnapshotUpdate(
  current: CharacterRuntimeSnapshot | null | undefined,
  next: CharacterRuntimeSnapshot | null | undefined,
  characterId: string,
): void {
  if (!current && !next) return;
  if (!current && next?.characterId === characterId) return;
  if (
    !current ||
    !next ||
    current.characterId !== characterId ||
    next.characterId !== characterId ||
    current.name !== next.name ||
    current.description !== next.description ||
    current.iconFilePath !== next.iconFilePath ||
    current.theme.main !== next.theme.main ||
    current.theme.sub !== next.theme.sub
  ) {
    throw new Error(
      "The Character definition update does not match the saved Session identity.",
    );
  }
}

/** キャラクター作成用のランタイム情報を消去する対象 Session。世代を指定して別の実体への適用を防げる。 */
export type SessionCharacterAuthoringRuntimeClearInput = {
  sessionId: string;
  incarnationId?: string;
};

/** ランタイム情報の消去後の Session 要約を返し、キャラクター定義がないことを null で示す。 */
export type SessionCharacterAuthoringRuntimeClearResult = {
  summary: SessionSummary;
  characterRuntimeSnapshot: null;
};
