import type { BackgroundExecutionScope } from "../agent-runtime/background-execution-scope.js";
import type { MemoryRecordingPurpose } from "./memory-recording-frequency.js";

export type MemoryRegistrationScope = Omit<BackgroundExecutionScope, "purpose"> & Readonly<{ purpose: MemoryRecordingPurpose }>;

export const MEMORY_REGISTRATION_PRESETS: Readonly<Record<MemoryRecordingPurpose, string>> = {
  "character-memory": [
    "Character定義を踏まえ、許可された保存済み会話から必要な箇所を自分で選んで取得し、共有した出来事や日常の小さな経験を、そのCharacter本人が後で思い出せるepisodeとして記録してください。",
    "必要な会話・操作結果・既存Memoryを自分で選んで確認し、今回の記録対象と過去分の再検討を判断してください。継続threadの過去の応答は現在の保存状態や権限の正本ではありません。",
    "前回失敗の情報がある場合は、次の会話情報と合わせて必要な過去分も再検討してください。途中まで保存された記録を確認し、失敗したから全件未保存とは決めつけず、直後の自動再試行loopは行わないでください。",
    "本文はCharacter定義の一人称・口調で語り、会話で表れた感情、関心、出来事の受け取りを本人の経験として残してください。強い感情や大きな成果、明示的な記憶依頼は記録の必須条件ではありません。",
    "対話による追加確認や承認を求めず、指定された材料で処理してください。",
    "観察できた出来事と自分の解釈・感情を区別し、誰の受け取りか本文から分かるようにしてください。observedFactには観察できた事実、characterObservationにはCharacter自身の受け取りを入れられます。",
    "実行結果に触れる場合は必要な保存済み操作結果を確認し、未確認の成否を確定しないでください。定義だけから感情や会話に存在しない経験・成果を作らず、秘密情報や生のログは登録しないでください。",
    "character_memory.append_episodeで、実行範囲のCharacterに登録してください。各操作の応答で保存結果を確認してください。",
    "必要な登録と保存結果の確認を終えたら終了してください。後で思い出す必要のある経験がなければ、登録せずに終了してください。",
  ].join("\n"),
  "target-memory": [
    "許可された保存済み会話から必要な箇所を自分で選んで取得し、対象に帰属する事実・合意・判断・制約・好み・成果を、後から利用できるMemoryとして記録してください。",
    "必要な会話・操作結果・既存Memoryを自分で選んで確認し、今回の記録対象と過去分の再検討を判断してください。継続threadの過去の応答は現在の保存状態や権限の正本ではありません。",
    "前回失敗の情報がある場合は、次の会話情報と合わせて必要な過去分も再検討してください。途中まで保存された記録を確認し、失敗したから全件未保存とは決めつけず、直後の自動再試行loopは行わないでください。",
    "対話による追加確認や承認を求めず、指定された材料で処理してください。",
    "内容の帰属先と適用範囲を確認し、アプリが確定した許可Memory targetと照合してください。事実と推測、合意済み判断と未合意の提案、本人の報告と実行記録を区別し、判断に必要な条件と根拠を残してください。",
    "実行結果を使う場合は保存済みの操作記録も確認し、欠落情報や不明な成否を成功へ補完しないでください。解釈や感想を対象の確定事実へ変えないでください。",
    "memory.appendで該当する許可targetへ登録し、各操作の応答で保存結果を確認してください。",
    "秘密情報や生のログは登録せず、対象を推測で広げないでください。必要な登録と保存結果の確認を終えたら終了し、必要な記録がなければ登録せずに終了してください。",
  ].join("\n"),
};

/** The editable policy body is selected, not combined with a hidden preset or instruction layer. */
export function buildMemoryRegistrationInput(input: Readonly<{
  scope: MemoryRegistrationScope;
  materials: string;
  characterDefinition?: string;
  instructionText?: string;
}>): string {
  const tool = input.scope.purpose === "character-memory" ? "character_memory.append_episode" : "memory.append";
  const command = input.scope.purpose === "character-memory" ? "character-memory-append-episode" : "append";
  return [
    "# 登録指示本文",
    input.instructionText ?? MEMORY_REGISTRATION_PRESETS[input.scope.purpose],
    "# 実行情報（アプリが確定した読取・登録範囲）",
    JSON.stringify({ purpose: input.scope.purpose,
      history: { fromMessageSeq: input.scope.history.fromMessageSeq, throughMessageSeq: input.scope.history.throughMessageSeq },
      memoryTargets: input.scope.memoryTargets }),
    "# 参照材料",
    input.materials,
    ...(input.characterDefinition === undefined ? [] : ["# Character定義（参照材料）", input.characterDefinition]),
    "# 接続済み操作の利用情報",
    `MCP: ${tool}。入力項目は公開tool schemaを参照。identityと登録先上限はruntime bindingから解決される。`,
    `CLI: withmate-memory ${command} --json '<toolと同じ公開入力JSON>'。接続方法は実行環境の既存CLI設定を使う。`,
  ].join("\n\n");
}
