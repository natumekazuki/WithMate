import {
  getSessionIncarnationId,
  setMessageBookmarked,
  type Message,
  type Session,
} from "../../../src-shared/session/session-state.js";
import { getMessageHistoryIndex } from "../../../src-shared/session/conversation-page.js";

/** セッションの送信枠を確保している操作が持つ解放ハンドル。 */
export type SessionSubmitLease = {
  sessionId: string;
  /** 自分が確保した送信枠を解放する。繰り返し呼び出してもよい。 */
  release(): void;
};

/** セッションごとに送信準備を一件に制限し、別セッションの送信は妨げない。 */
export class SessionSubmitCoordinator {
  private readonly claims = new Map<string, symbol>();

  /** 送信枠が空いていれば確保し、別の操作が確保済みなら null を返す。 */
  tryAcquire(sessionId: string): SessionSubmitLease | null {
    if (this.claims.has(sessionId)) {
      return null;
    }

    const claim = Symbol(sessionId);
    this.claims.set(sessionId, claim);
    let released = false;
    return {
      sessionId,
      /** 確保時の識別子がまだ有効な場合だけ送信枠を解放する。 */
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.claims.get(sessionId) === claim) {
          this.claims.delete(sessionId);
        }
      },
    };
  }

  /** 指定セッションの送信枠が現在確保されているかを返す。 */
  isClaimed(sessionId: string): boolean {
    return this.claims.has(sessionId);
  }
}

/** 新しい要求を開始したときに、それ以前の応答を無効にする世代管理。 */
export class LatestRequestRevision {
  private revision = 0;

  /** 要求を新しい世代として開始し、応答判定に使う値を返す。 */
  start(): number {
    this.revision += 1;
    return this.revision;
  }

  /** 応答側が持つ世代が、最後に開始した要求と一致するかを返す。 */
  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

/** 取得処理の途中にローカルの表示が変更されたかを見分ける世代管理。 */
export class StateMutationRevision {
  private revision = 0;

  /** 後で変更有無を判定できるよう、現在の世代を記録用に返す。 */
  capture(): number {
    return this.revision;
  }

  /** ローカルの変更を反映したことを記録し、過去の観測を無効にする。 */
  advance(): void {
    this.revision += 1;
  }

  /** 観測後にローカルの変更が入っていないかを返す。 */
  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

/** ターンの受付を照合する識別子を生成し、利用可能なら標準の UUID 生成を使う。 */
export function createSessionTurnClientRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUuid) {
    return randomUuid();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** 再取得結果を採用しつつ、保護が必要な同一セッション世代のピンとブックマークを保持する。 */
export function mergeRefetchedSessionProjection(
  current: Session | null,
  refreshed: Session,
  preserveCurrentPin: boolean,
): Session {
  return preserveCurrentPin &&
    current?.id === refreshed.id &&
    getSessionIncarnationId(current) === getSessionIncarnationId(refreshed)
    ? {
        ...refreshed,
        isPinned: current.isPinned,
        messages: mergeMessageBookmarkProjection(
          current.messages,
          refreshed.messages,
        ),
      }
    : refreshed;
}

/** 履歴上の位置、話者、本文が一致する受信メッセージに現在のブックマークを反映する。 */
export function mergeMessageBookmarkProjection(
  current: Message[],
  incoming: Message[],
): Message[] {
  const currentByHistoryIndex = new Map(
    current.map((message, index) => [
      getMessageHistoryIndex(message, index),
      message,
    ]),
  );
  return incoming.map((message, index) => {
    const projected = currentByHistoryIndex.get(
      getMessageHistoryIndex(message, index),
    );
    return projected &&
      projected.role === message.role &&
      projected.text === message.text
      ? setMessageBookmarked(message, projected.isBookmarked === true)
      : message;
  });
}
