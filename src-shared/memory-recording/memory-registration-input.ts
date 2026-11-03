import type { BackgroundExecutionScope } from "../agent-runtime/background-execution-scope.js";
import type { MemoryRecordingPurpose } from "./memory-recording-frequency.js";

export type MemoryRegistrationScope = Omit<BackgroundExecutionScope, "purpose"> & Readonly<{ purpose: MemoryRecordingPurpose }>;

export const MEMORY_REGISTRATION_PRESETS: Readonly<Record<MemoryRecordingPurpose, string>> = {
  "character-memory": [
    "処理対象の保存済み会話から、Characterとして共有した出来事や日常の小さな経験を、後の理解につながる短いepisodeとして必要に応じて記録してください。",
    "観察できた事実とCharacter自身の受け取りを区別し、本文でも誰の受け取りか分かるようにしてください。事実にはobservedFact、受け取りにはcharacterObservationを使えます。",
    "登録にはcharacter_memory.append_episodeを使い、Affect eventやlinked episodeは作りません。強い感情や大きな成果、明示的な記憶依頼は記録の必須条件ではありません。",
    "欠けている情報、共有していない経験、不明な実行結果を補完せず、秘密情報や生のログを登録しないでください。必要な記録がなければ登録せずに終了してください。",
  ].join("\n"),
  "target-memory": [
    "処理対象の保存済み会話から、事実、合意した判断、制約、好み、実行結果などを、許可された対象で後から利用できる短いMemoryとして必要に応じて記録してください。",
    "登録にはmemory.appendを使ってください。事実と推測、合意済み判断と未合意の提案、本人の報告と実行記録を区別してください。",
    "実行結果を使う場合は保存済みの操作記録も確認し、欠落情報や不明な成否を成功へ補完しないでください。Characterの主観を対象の確定知識へ変えないでください。",
    "秘密情報や生のログは登録せず、対象を推測で広げないでください。必要な記録がなければ登録せずに終了してください。",
  ].join("\n"),
};

/** The editable policy body is selected, not combined with a hidden preset or instruction layer. */
export function buildMemoryRegistrationInput(input: Readonly<{
  scope: MemoryRegistrationScope;
  materials: string;
  instructionText?: string;
}>): string {
  const tool = input.scope.purpose === "character-memory" ? "character_memory.append_episode" : "memory.append";
  const command = input.scope.purpose === "character-memory" ? "character-memory-append-episode" : "append";
  return [
    "# 登録指示本文",
    input.instructionText ?? MEMORY_REGISTRATION_PRESETS[input.scope.purpose],
    "# 実行情報（アプリが確定した読取・登録範囲）",
    JSON.stringify({ purpose: input.scope.purpose, processing: input.scope.processing,
      history: { fromMessageSeq: input.scope.history.fromMessageSeq, throughMessageSeq: input.scope.history.throughMessageSeq },
      memoryTargets: input.scope.memoryTargets }),
    "# 参照材料",
    input.materials,
    "# 接続済み操作の利用情報",
    `MCP: ${tool}。入力項目は公開tool schemaを参照。identityと登録先上限はruntime bindingから解決される。`,
    `CLI: withmate-memory ${command} --json '<toolと同じ公開入力JSON>'。接続方法は実行環境の既存CLI設定を使う。`,
  ].join("\n\n");
}
