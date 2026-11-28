import type { AuxiliarySession } from "./auxiliary-session-state.js";

/** renderer と Main プロセスの間で受け渡す永続化済みの下書き状態。 */
export type AuxiliaryDraftRecord = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  durableRevision: number;
  text: string;
  updatedAt: string;
};

/** 保存する下書き本文と、編集開始時に読み取った個体・永続版を照合するための入力。 */
export type AuxiliaryDraftSaveInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  expectedDurableRevision: number;
  text: string;
  updatedAt: string;
};

/** 操作後の永続版を本文なしで通知するための確認情報。 */
export type AuxiliaryDraftAck = Pick<
  AuxiliaryDraftRecord,
  "auxiliarySessionId" | "incarnation" | "durableRevision" | "updatedAt"
>;

/** 下書きの保存、版の競合、対象の不在、または拒否を区別する。 */
export type AuxiliaryDraftSaveResult = {
  outcome: "saved" | "stale" | "not-found" | "rejected";
  ack?: AuxiliaryDraftAck;
};

/** 送信などで使い終えた版を指定し、後から変更された下書きの消費を避ける。 */
export type AuxiliaryDraftConsumeInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  incarnation: string;
  expectedDurableRevision: number;
};

/** 対象版を消費したか、版の競合・不在・拒否で消費しなかったかを返す。 */
export type AuxiliaryDraftConsumeResult = {
  outcome: "consumed" | "stale" | "not-found" | "rejected";
  ack?: AuxiliaryDraftAck;
};

/** 下書きの処理前に比較するAuxiliaryの個体と、現在の実行状態。 */
export type AuxiliarySessionStatus = {
  id: string;
  parentSessionId: string;
  createdAt: string;
  incarnation: string;
  runState: AuxiliarySession["runState"];
};
