import type { SessionTarget } from "./session-target.js";

/** 保存済みの Main または Auxiliary の識別情報。Auxiliary の場合は所有元 Main の incarnation も含む。 */
export type SessionInstructionsTarget = SessionTarget;

/** 空白を含む保存本文全体の UTF-8 バイト数上限。 */
export const SESSION_INSTRUCTIONS_MAX_BYTES = 8192;

const utf8 = new TextEncoder();

/** renderer とストレージで同じエンコーディングを用いて、加工していない本文のバイト数を測る。 */
export function sessionInstructionsByteLength(body: string): number {
  return utf8.encode(body).byteLength;
}

/** 無効な本文は切り詰めや正規化を行わずに拒否する。 */
export function validateSessionInstructions(body: unknown): string {
  // テキスト以外の入力はエンコード前に拒否する。
  if (typeof body !== "string") {
    throw new TypeError("Session instructions must be text.");
  }
  // JSON 表現や前後の空白を除いた値ではなく、元のテキストのバイト数を数える。
  if (sessionInstructionsByteLength(body) > SESSION_INSTRUCTIONS_MAX_BYTES) {
    throw new RangeError("Session instructions exceed the 8,192-byte limit.");
  }
  return body;
}
