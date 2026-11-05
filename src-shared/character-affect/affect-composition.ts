import { z } from "zod";
import { CHARACTER_AFFECT_FAMILIES } from "./affect-contract.js";
import type { BackgroundExecutionScope } from "../agent-runtime/background-execution-scope.js";
import type { EffectiveAffectState } from "./affect-contract.js";

const text = z.string().refine((value) => value.trim().length > 0, "Must not be empty.");
const dimension = z.number().finite().min(-1).max(1);
export const backgroundAffectCandidateSchema = z.object({
  layer: z.enum(["relationship", "session"]),
  targetType: z.enum(["user", "relationship", "task", "bug", "artifact", "self"]),
  targetId: text,
  family: z.enum(CHARACTER_AFFECT_FAMILIES),
  value: z.object({
    label: text,
    valence: dimension,
    arousal: dimension.optional(),
    dimensions: z.record(text, dimension).optional(),
  }).strict(),
  intensity: z.number().finite().min(0).max(1),
  reason: text,
  evidence: text,
  sourceTurnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((candidate) => candidate.layer !== "relationship"
  || candidate.targetType === "user" || candidate.targetType === "relationship", {
  message: "Relationship affect may only target the user or relationship.", path: ["targetType"],
});

export const AFFECT_COMPOSITION_INSTRUCTIONS = [
  "Character定義・既存Affect・処理対象の保存済み会話を読み、そのCharacterにとって今回の出来事がどう受け取られ、感情がどう変化したかを判断する。",
  "Characterの性格・価値観と、会話で確認できる出来事を根拠に、変化の原因・対象・感情の種類・強さ・layerを選ぶ。既存Affectも踏まえ、今回登録する必要のある変化を判断する。",
  "対話による追加確認や承認を求めず、指定された材料で処理する。",
  "主会話Agentの非公開の内面を復元・診断したとは扱わない。",
  "会話を基本材料とし、作業結果の裏付けが必要な場合だけ操作の成否と必要な詳細を参照する。欠落した情報は補完しない。",
  "原因・感情の対象・sourceTurnIdを保ち、作業上の失敗を根拠なくユーザーへの敵意へ変換しない。",
  "character_affect.appraiseのcandidatesへ判断した変化とreason・evidence・保存済みTurnのsourceTurnIdを渡し、各操作の応答で保存結果を確認して終了する。必要な変化がなければ登録せず終了する。",
].join("\n");

export type AffectCompositionInput = {
  /** Unset selects the preset; a supplied body, including an empty one, replaces it. */
  instructionBody?: string;
  characterDefinition: string;
  currentAffect: EffectiveAffectState;
};

export function buildAffectCompositionInput(input: AffectCompositionInput, scope: BackgroundExecutionScope): string {
  return [
    "## 登録指示", input.instructionBody ?? AFFECT_COMPOSITION_INSTRUCTIONS,
    "## 実行範囲（アプリ提供）", JSON.stringify(scope),
    "## Character定義（参照材料）", input.characterDefinition,
    "## 既存Affect（参照材料）", JSON.stringify(input.currentAffect),
    "## tool利用説明",
    "保存済み会話とTurnはsession_historyのtoolで実行範囲内を取得できる。",
    "背景のcharacter_affect.appraiseはcandidatesにdomain値と保存済みTurnのsourceTurnIdを受け取る。時刻・保存identity・keyはアプリが確定する。入力項目と許可操作は公開tool schemaとruntime bindingを参照する。",
    "保存の成否は各tool応答で確認する。自然文の最終応答は保存処理ではない。",
  ].join("\n\n");
}
