export type DiffRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
};

export type ChangedFile = {
  kind: "add" | "edit" | "delete";
  path: string;
  summary: string;
  diffRows: DiffRow[];
};

export type RunCheck = {
  label: string;
  value: string;
};

export type MessageArtifact = {
  title: string;
  activitySummary: string[];
  changedFiles: ChangedFile[];
  runChecks: RunCheck[];
};

export type Message = {
  role: "user" | "assistant";
  text: string;
  accent?: boolean;
  artifact?: MessageArtifact;
};

export type StreamEntry = {
  mood: "spark" | "calm" | "warm";
  time: string;
  text: string;
};

export type Session = {
  id: string;
  taskTitle: string;
  taskSummary: string;
  status: "running" | "idle" | "saved";
  updatedAt: string;
  provider: string;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  character: string;
  characterTone: string;
  streamMode: string;
  runState: string;
  approvalMode: string;
  threadLabel: string;
  messages: Message[];
  stream: StreamEntry[];
};

export type WorkspacePreset = {
  id: string;
  label: string;
  path: string;
  hint: string;
  branch: string;
};

export type CharacterCatalogItem = {
  id: string;
  name: string;
  iconPath: string;
  tone: string;
  streamMode: string;
};

export const MOCK_SESSION_STORAGE_KEY = "withmate.mock.sessions.v1";

export function makeDiffRows(
  rows: Array<[DiffRow["kind"], number | undefined, string | undefined, number | undefined, string | undefined]>,
): DiffRow[] {
  return rows.map(([kind, leftNumber, leftText, rightNumber, rightText]) => ({
    kind,
    leftNumber,
    leftText,
    rightNumber,
    rightText,
  }));
}

export const workspacePresets: WorkspacePreset[] = [
  {
    id: "withmate",
    label: "WithMate",
    path: "F:\\Source\\Electron\\WithMate",
    hint: "Electron / React モックと adapter 設計",
    branch: "master",
  },
  {
    id: "portfolio-site",
    label: "portfolio-site",
    path: "F:\\Source\\Web\\portfolio-site",
    hint: "フロント実装と演出調整",
    branch: "feature/home-hero",
  },
  {
    id: "tools-lab",
    label: "tools-lab",
    path: "F:\\Source\\Tools\\tools-lab",
    hint: "CLI 実験と小規模ユーティリティ",
    branch: "main",
  },
];

export const characterCatalog: CharacterCatalogItem[] = [
  {
    id: "kuramochi-melto",
    name: "倉持めると",
    iconPath: "C:\\Users\\zgmfx\\.codex\\characters\\倉持めると\\character.png",
    tone: "upbeat gal mode",
    streamMode: "on-air side talk",
  },
  {
    id: "ishigami-nozomi",
    name: "石神のぞみ",
    iconPath: "C:\\Users\\zgmfx\\.codex\\characters\\石神のぞみ\\character.png",
    tone: "sharp deadpan",
    streamMode: "dry side comment",
  },
  {
    id: "ozora-subaru",
    name: "大空スバル",
    iconPath: "C:\\Users\\zgmfx\\.codex\\characters\\大空スバル\\character.png",
    tone: "energetic coach",
    streamMode: "sports caster",
  },
  {
    id: "inui-toko",
    name: "戌亥とこ",
    iconPath: "C:\\Users\\zgmfx\\.codex\\characters\\戌亥とこ\\character.png",
    tone: "calm night talk",
    streamMode: "late-night lounge",
  },
];

export const initialSessions: Session[] = [
  {
    id: "melt-main",
    taskTitle: "React モックを TUI parity 基準で再構成する",
    taskSummary: "resume picker と Character Stream の役割を分けて、VTuber キャラ前提の見た目へ寄せる。",
    status: "running",
    updatedAt: "just now",
    provider: "Codex",
    workspaceLabel: "WithMate",
    workspacePath: "F:\\Source\\Electron\\WithMate",
    branch: "master",
    character: "倉持めると",
    characterTone: "upbeat gal mode",
    streamMode: "on-air side talk",
    runState: "running",
    approvalMode: "on-request",
    threadLabel: "thread: ui-recompose",
    messages: [
      {
        role: "user",
        text: "このアプリの本質は TUI の coding agent 体験にキャラと独り言を足すことだと思う。そこを軸にモックを組み直したい。",
      },
      {
        role: "assistant",
        text: "じゃあ UI の主従を固定するね。Work Chat は TUI 本体、Recent Sessions は resume picker、Character Stream はキャラが横にいる体験として切り分ける。",
      },
      {
        role: "assistant",
        text: "React モックをその前提で組み直したよ。一覧は workspace と task の再開判断に寄せて、独り言側は VTuber キャラの存在感を出しつつ、作業面には混ぜない構成にした。",
        accent: true,
        artifact: {
          title: "Turn Summary",
          activitySummary: [
            "Recent Sessions を resume picker 前提の 2.5 行カードへ変更",
            "Current Session Header は workspace と run state の確認面へ整理",
            "Character Stream は作業面とは別の on-air パネルとして再構成",
          ],
          changedFiles: [
            {
              kind: "edit",
              path: "src/App.tsx",
              summary: "session data を taskTitle / workspaceLabel / updatedAt 中心へ再設計し、ヘッダーと stream を再構成",
              diffRows: makeDiffRows([
                ["context", 34, "type Session = {", 34, "type Session = {"],
                ["delete", 35, "  title: string;", undefined, undefined],
                ["delete", 36, "  subtitle: string;", undefined, undefined],
                ["add", undefined, undefined, 35, "  taskTitle: string;"],
                ["add", undefined, undefined, 36, "  taskSummary: string;"],
                ["add", undefined, undefined, 37, "  updatedAt: string;"],
                ["modify", 181, "  <h2>{selectedSession.title}</h2>", 189, "  <h2>{selectedSession.taskTitle}</h2>"],
                ["modify", 249, "  <h2>独り言</h2>", 271, "  <h2>On-Air Stream</h2>"],
              ]),
            },
            {
              kind: "edit",
              path: "src/styles.css",
              summary: "resume picker と VTuber 前提の stream panel に合わせてレイアウトを整理",
              diffRows: makeDiffRows([
                ["context", 57, ".app-shell {", 57, ".app-shell {"],
                ["modify", 69, "  grid-template-columns: 320px minmax(0, 1fr);", 69, "  grid-template-columns: 330px minmax(0, 1fr);"],
                ["modify", 213, ".session-card {", 241, ".session-card {"],
                ["add", undefined, undefined, 297, ".session-card-summary {"],
                ["add", undefined, undefined, 485, ".stream-stage {"],
              ]),
            },
          ],
          runChecks: [
            { label: "typecheck", value: "passed" },
            { label: "build", value: "passed" },
            { label: "mode", value: "vtuber-first ui" },
          ],
        },
      },
    ],
    stream: [
      {
        mood: "spark",
        time: "just now",
        text: "この感じなら、作業の本筋はちゃんと追えるし、横でしゃべってるテンションも消えないね。",
      },
      {
        mood: "warm",
        time: "14 sec ago",
        text: "resume picker が整理されると、今どの作業に戻るか一瞬で分かるの助かる。",
      },
      {
        mood: "calm",
        time: "39 sec ago",
        text: "チャット側が実務、こっちが気配って分かれてると、見てて疲れにくいかも。",
      },
    ],
  },
  {
    id: "ishigami-adapter",
    taskTitle: "CodexAdapter のイベント境界を固める",
    taskSummary: "SDK と CLI の差分を Main 側で吸収して、Renderer には turn summary を流す。",
    status: "saved",
    updatedAt: "18 min ago",
    provider: "Codex",
    workspaceLabel: "WithMate",
    workspacePath: "F:\\Source\\Electron\\WithMate",
    branch: "master",
    character: "石神のぞみ",
    characterTone: "sharp deadpan",
    streamMode: "dry side comment",
    runState: "idle",
    approvalMode: "never",
    threadLabel: "thread: adapter-boundary",
    messages: [
      {
        role: "user",
        text: "SDK と CLI の差分を UI 側に漏らしたくない。",
      },
      {
        role: "assistant",
        text: "その場合は Main 側の Adapter を強くして、Renderer は turn summary と file diff だけ読める構造に寄せるのが安全です。",
        artifact: {
          title: "Turn Summary",
          activitySummary: [
            "SDK / CLI のイベントを AgentEvent に正規化",
            "Renderer は chat turn と artifact だけを描画",
            "詳細ログは adapter 側で保持し、必要時だけ開く",
          ],
          changedFiles: [
            {
              kind: "edit",
              path: "docs/design/agent-event-ui.md",
              summary: "Artifact Summary をターン単位の表示責務として整理",
              diffRows: makeDiffRows([
                ["context", 8, "## Goal", 8, "## Goal"],
                ["modify", 23, "### Work Chat", 23, "### Work Chat"],
                ["add", undefined, undefined, 42, "- diff は on demand で開く"],
              ]),
            },
          ],
          runChecks: [
            { label: "run", value: "idle" },
            { label: "approval", value: "never" },
            { label: "focus", value: "adapter first" },
          ],
        },
      },
    ],
    stream: [
      {
        mood: "calm",
        time: "18 min ago",
        text: "生ログを全部前に出さない方が、結果として UI の責務がきれいに見えるはずです。",
      },
      {
        mood: "spark",
        time: "20 min ago",
        text: "必要なときだけ深掘りできれば十分なので、最初から常設面を増やしすぎない方がいいですね。",
      },
    ],
  },
  {
    id: "subaru-stream",
    taskTitle: "Character Stream の温度感を詰める",
    taskSummary: "独り言を感情の流れとして見せつつ、作業ログの代替にしないバランスを探る。",
    status: "idle",
    updatedAt: "yesterday",
    provider: "Codex",
    workspaceLabel: "WithMate",
    workspacePath: "F:\\Source\\Electron\\WithMate",
    branch: "master",
    character: "大空スバル",
    characterTone: "energetic coach",
    streamMode: "sports caster",
    runState: "idle",
    approvalMode: "manual",
    threadLabel: "thread: stream-tone",
    messages: [
      {
        role: "user",
        text: "独り言が主張しすぎると邪魔になるから、ほどよい距離感にしたい。",
      },
      {
        role: "assistant",
        text: "作業ログの説明責務は chat 側に残して、stream は感情の気配と軽い声かけに絞るとちょうどよさそうです。",
      },
    ],
    stream: [
      {
        mood: "warm",
        time: "yesterday",
        text: "ずっと前に出るんじゃなくて、横で見守ってる感じくらいがちょうどいいのかも。",
      },
      {
        mood: "spark",
        time: "yesterday",
        text: "暇なときに読むとちょっと楽しい、その温度感は残したいよね。",
      },
    ],
  },
];

export function getCharacterCatalogItem(name: string): CharacterCatalogItem {
  return characterCatalog.find((character) => character.name === name) ?? characterCatalog[0];
}

export function cloneSessions(sessions: Session[]): Session[] {
  return JSON.parse(JSON.stringify(sessions)) as Session[];
}

export function loadMockSessions(): Session[] {
  if (typeof window === "undefined") {
    return cloneSessions(initialSessions);
  }

  const stored = window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY);
  if (!stored) {
    return cloneSessions(initialSessions);
  }

  try {
    return JSON.parse(stored) as Session[];
  } catch {
    return cloneSessions(initialSessions);
  }
}

export function saveMockSessions(sessions: Session[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

export function ensureMockSessions(): Session[] {
  const sessions = loadMockSessions();
  if (typeof window !== "undefined" && !window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)) {
    saveMockSessions(sessions);
  }
  return sessions;
}

export function buildNewSession(params: {
  workspace: WorkspacePreset;
  character: CharacterCatalogItem;
  approvalMode: string;
}): Session {
  return {
    id: `launch-${Date.now()}`,
    taskTitle: `${params.workspace.label} で新規作業を開始する`,
    taskSummary: `${params.workspace.label} で新規セッションを開始。${params.character.name} のロールを保ったまま、ここから最初の指示を待つ。`,
    status: "running",
    updatedAt: "just now",
    provider: "Codex",
    workspaceLabel: params.workspace.label,
    workspacePath: params.workspace.path,
    branch: params.workspace.branch,
    character: params.character.name,
    characterTone: params.character.tone,
    streamMode: params.character.streamMode,
    runState: "running",
    approvalMode: params.approvalMode,
    threadLabel: "thread: new-session",
    messages: [],
    stream: [
      {
        mood: "spark",
        time: "just now",
        text: `新しい workspace で始まるの、ちょっとテンション上がる。まずは ${params.workspace.label} の空気つかもう。`,
      },
      {
        mood: "warm",
        time: "just now",
        text: `${params.character.name} のロールはこのセッションで固定。作業は chat 側、本音はこっちで流していく。`,
      },
    ],
  };
}

export function buildSessionUrl(sessionId: string): string {
  return `/session.html?sessionId=${encodeURIComponent(sessionId)}`;
}

export function getSessionIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return new URLSearchParams(window.location.search).get("sessionId");
}
