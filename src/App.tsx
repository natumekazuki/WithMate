import { useMemo, useState } from "react";

type DiffRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
};

type ChangedFile = {
  kind: "add" | "edit" | "delete";
  path: string;
  summary: string;
  diffRows: DiffRow[];
};

type RunCheck = {
  label: string;
  value: string;
};

type MessageArtifact = {
  title: string;
  activitySummary: string[];
  changedFiles: ChangedFile[];
  runChecks: RunCheck[];
};

type Message = {
  role: "user" | "assistant";
  text: string;
  accent?: boolean;
  artifact?: MessageArtifact;
};

type StreamEntry = {
  mood: "spark" | "calm" | "warm";
  time: string;
  text: string;
};

type Session = {
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

type WorkspacePreset = {
  id: string;
  label: string;
  path: string;
  hint: string;
  branch: string;
};

type CharacterCatalogItem = {
  id: string;
  name: string;
  iconPath: string;
  tone: string;
  streamMode: string;
};

type CharacterAvatarProps = {
  character: CharacterCatalogItem;
  size?: "tiny" | "small" | "medium" | "large";
  className?: string;
};

function makeDiffRows(rows: Array<[DiffRow["kind"], number | undefined, string | undefined, number | undefined, string | undefined]>): DiffRow[] {
  return rows.map(([kind, leftNumber, leftText, rightNumber, rightText]) => ({
    kind,
    leftNumber,
    leftText,
    rightNumber,
    rightText,
  }));
}

function toViteFsPath(filePath: string): string {
  return `/@fs/\${encodeURI(filePath.replace(/\\\\/g, "/"))}`;
}

function fallbackLabel(name: string): string {
  return name.slice(0, 1);
}

const workspacePresets: WorkspacePreset[] = [
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

const characterCatalog: CharacterCatalogItem[] = [
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

const initialSessions: Session[] = [
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

function getCharacterCatalogItem(name: string): CharacterCatalogItem {
  return characterCatalog.find((character) => character.name === name) ?? characterCatalog[0];
}

function statusLabel(status: Session["status"]): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "idle":
      return "IDLE";
    case "saved":
      return "SAVED";
    default:
      return status;
  }
}

function fileKindLabel(kind: ChangedFile["kind"]): string {
  switch (kind) {
    case "add":
      return "ADD";
    case "edit":
      return "EDIT";
    case "delete":
      return "DEL";
    default:
      return kind;
  }
}

function CharacterAvatar({ character, size = "medium", className = "" }: CharacterAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = toViteFsPath(character.iconPath);

  return (
    <div className={`character-avatar \${size} \${className}`.trim()} aria-hidden="true">
      <span className="avatar-fallback">{fallbackLabel(character.name)}</span>
      {imageFailed ? null : <img src={src} alt="" onError={() => setImageFailed(true)} />}
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState(initialSessions);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(initialSessions[0].id);
  const [draft, setDraft] = useState("次は実イベントをこの UI に流して、turn summary を自動生成できるか見たい");
  const [sentCount, setSentCount] = useState(0);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; file: ChangedFile } | null>(null);
  const [launchWorkspaceId, setLaunchWorkspaceId] = useState("");
  const [launchCharacter, setLaunchCharacter] = useState(characterCatalog[0].name);
  const [launchApproval, setLaunchApproval] = useState("on-request");

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0],
    [selectedId, sessions],
  );

  const selectedSessionCharacter = useMemo(
    () => getCharacterCatalogItem(selectedSession.character),
    [selectedSession.character],
  );

  const selectedWorkspace = useMemo(
    () => workspacePresets.find((workspace) => workspace.id === launchWorkspaceId) ?? null,
    [launchWorkspaceId],
  );

  const selectedCharacter = useMemo(
    () => getCharacterCatalogItem(launchCharacter),
    [launchCharacter],
  );

  const draftMessage: Message | null =
    sentCount === 0
      ? null
      : {
          role: "user",
          text: draft || "送信後のダミー入力",
        };

  const displayedMessages = draftMessage
    ? [...selectedSession.messages, draftMessage]
    : selectedSession.messages;

  const handleSend = () => {
    setSentCount((count) => count + 1);
  };

  const toggleArtifact = (artifactKey: string) => {
    setExpandedArtifacts((current) => ({
      ...current,
      [artifactKey]: !current[artifactKey],
    }));
  };

  const handleBrowseWorkspace = () => {
    if (workspacePresets.length === 0) {
      return;
    }

    if (!launchWorkspaceId) {
      setLaunchWorkspaceId(workspacePresets[0].id);
      return;
    }

    const currentIndex = workspacePresets.findIndex((workspace) => workspace.id === launchWorkspaceId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % workspacePresets.length;
    setLaunchWorkspaceId(workspacePresets[nextIndex].id);
  };

  const handleStartSession = () => {
    if (!selectedWorkspace) {
      return;
    }

    const sessionId = `launch-\${Date.now()}`;
    const createdSession: Session = {
      id: sessionId,
      taskTitle: `\${selectedWorkspace.label} で新規作業を開始する`,
      taskSummary: `\${selectedWorkspace.label} で新規セッションを開始。\${selectedCharacter.name} のロールを保ったまま、ここから最初の指示を待つ。`,
      status: "running",
      updatedAt: "just now",
      provider: "Codex",
      workspaceLabel: selectedWorkspace.label,
      workspacePath: selectedWorkspace.path,
      branch: selectedWorkspace.branch,
      character: selectedCharacter.name,
      characterTone: selectedCharacter.tone,
      streamMode: selectedCharacter.streamMode,
      runState: "running",
      approvalMode: launchApproval,
      threadLabel: "thread: new-session",
      messages: [],
      stream: [
        {
          mood: "spark",
          time: "just now",
          text: `新しい workspace で始まるの、ちょっとテンション上がる。まずは \${selectedWorkspace.label} の空気つかもう。`,
        },
        {
          mood: "warm",
          time: "just now",
          text: `\${selectedCharacter.name} のロールはこのセッションで固定。作業は chat 側、本音はこっちで流していく。`,
        },
      ],
    };

    setSessions((current) => [createdSession, ...current]);
    setSelectedId(sessionId);
    setDraft("");
    setSentCount(0);
    setLaunchOpen(false);
  };

  return (
    <div className={`app-shell \${drawerOpen ? "drawer-open" : "drawer-closed"}`}>
      <aside className={`sidebar \${drawerOpen ? "open" : "closed"}`}>
        <div className="panel app-badge rise-1">
          <div className="app-icon" aria-hidden="true">
            WM
          </div>
          <div className="app-brand-copy">
            <p className="kicker">WithMate</p>
            <h1>VTuber Coding Agent</h1>
            <p>TUI の作業感を残したまま、キャラの気配を横に流す。</p>
          </div>
          <button
            className="drawer-toggle"
            type="button"
            aria-label={drawerOpen ? "Close sessions" : "Open sessions"}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? "Hide" : "Menu"}
          </button>
        </div>

        {drawerOpen ? (
          <section className="panel sessions-panel rise-2">
            <div className="panel-head compact-head">
              <div>
                <p className="kicker">Resume Picker</p>
                <h2>Recent Sessions</h2>
              </div>
              <div className="tag-row">
                <span className="pill">{sessions.length}</span>
                <button className="launch-toggle" type="button" onClick={() => setLaunchOpen(true)}>
                  New Session
                </button>
              </div>
            </div>

            <div className="session-list">
              {sessions.map((session) => {
                const active = session.id === selectedSession.id;
                const sessionCharacter = getCharacterCatalogItem(session.character);

                return (
                  <button
                    key={session.id}
                    className={`session-card\${active ? " active" : ""}`}
                    type="button"
                    onClick={() => setSelectedId(session.id)}
                  >
                    <CharacterAvatar character={sessionCharacter} size="small" className="session-avatar" />

                    <div className="session-main">
                      <div className="session-card-head">
                        <h3>{session.taskTitle}</h3>
                        <span className={`session-status \${session.status}`}>{statusLabel(session.status)}</span>
                      </div>

                      <div className="session-meta-row">
                        <span>{session.workspaceLabel}</span>
                        <span>{session.provider}</span>
                        <span>{session.updatedAt}</span>
                      </div>

                      <p className="session-card-summary">{session.taskSummary}</p>

                      <div className="session-character-row">
                        <span>{session.character}</span>
                        <span>{session.threadLabel}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="panel drawer-summary rise-2">
            <p className="kicker">Current</p>
            <CharacterAvatar character={selectedSessionCharacter} size="small" className="drawer-avatar" />
            <h2>{selectedSession.workspaceLabel}</h2>
            <p>{selectedSession.character}</p>
            <p>{statusLabel(selectedSession.status)}</p>
            <button
              className="launch-toggle compact"
              type="button"
              onClick={() => {
                setDrawerOpen(true);
                setLaunchOpen(true);
              }}
            >
              New
            </button>
          </section>
        )}
      </aside>

      <main className="workspace">
        <header className="panel workspace-header rise-2">
          <div className="header-copy">
            <p className="kicker">Current Session</p>
            <h2>{selectedSession.taskTitle}</h2>
            <p>{selectedSession.taskSummary}</p>
          </div>

          <div className="header-side">
            <section className="header-character-card">
              <CharacterAvatar character={selectedSessionCharacter} size="medium" className="header-avatar" />
              <div className="header-character-copy">
                <p className="kicker">Character Locked</p>
                <h3>{selectedSession.character}</h3>
                <p>{selectedSession.characterTone}</p>
              </div>
            </section>

            <div className="header-rails">
              <div className="header-rail primary">
                <span className="rail-label">workspace</span>
                <strong>{selectedSession.workspacePath}</strong>
              </div>
              <div className="header-rail-grid">
                <div className="header-rail">
                  <span className="rail-label">provider</span>
                  <strong>{selectedSession.provider}</strong>
                </div>
                <div className="header-rail">
                  <span className="rail-label">branch</span>
                  <strong>{selectedSession.branch}</strong>
                </div>
                <div className="header-rail">
                  <span className="rail-label">run</span>
                  <strong>{selectedSession.runState}</strong>
                </div>
                <div className="header-rail">
                  <span className="rail-label">approval</span>
                  <strong>{selectedSession.approvalMode}</strong>
                </div>
              </div>
            </div>
          </div>
        </header>

        <section className="content-grid">
          <section className="panel chat-panel rise-3">
            <div className="panel-head compact-head">
              <div>
                <p className="kicker">Work Chat</p>
                <h2>Coding Agent Run</h2>
              </div>
              <div className="tag-row">
                <span className="status-chip accent">{selectedSession.runState}</span>
                <span className="status-chip">{selectedSession.threadLabel}</span>
              </div>
            </div>

            <div className="message-list">
              {displayedMessages.length === 0 ? (
                <article className="message-row assistant empty-chat-row">
                  <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                  <div className="message-card assistant empty-chat">
                    <div className="message-head">
                      <div className="message-speaker">
                        <p className="message-role">{selectedSession.character}</p>
                        <span className="message-voice">session ready</span>
                      </div>
                      <span className="message-badge">ready</span>
                    </div>
                    <p className="message-body">workspace とキャラクターは固定された。ここから最初の依頼を送ると、この session で作業が始まる。</p>
                  </div>
                </article>
              ) : (
                displayedMessages.map((message, index) => {
                  const artifactKey = `\${selectedSession.id}-\${index}`;
                  const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
                  const isAssistant = message.role === "assistant";

                  return (
                    <article
                      key={`\${message.role}-\${index}`}
                      className={`message-row \${message.role}\${message.accent ? " accent" : ""}`}
                    >
                      {isAssistant ? <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" /> : null}
                      <div className={`message-card \${message.role}\${message.accent ? " accent" : ""}`}>
                        <div className="message-head">
                          <div className="message-speaker">
                            <p className="message-role">{isAssistant ? selectedSession.character : "You"}</p>
                            <span className="message-voice">{isAssistant ? selectedSession.characterTone : "prompt"}</span>
                          </div>
                          <span className="message-badge">{isAssistant ? "response" : "prompt"}</span>
                        </div>
                        <p className="message-body">{message.text}</p>

                        {message.artifact ? (
                          <section className="artifact-shell">
                            <div className="artifact-toolbar">
                              <div className="artifact-head-copy">
                                <p className="kicker">{message.artifact.title}</p>
                                <p>{message.artifact.changedFiles.length} files changed / {message.artifact.runChecks.length} checks</p>
                              </div>

                              <button
                                className="artifact-toggle"
                                type="button"
                                onClick={() => toggleArtifact(artifactKey)}
                              >
                                {artifactExpanded ? "Hide Summary" : "Show Summary"}
                              </button>
                            </div>

                            {artifactExpanded ? (
                              <div className="artifact-block">
                                <div className="artifact-grid">
                                  <section className="artifact-section">
                                    <h3>What Changed</h3>
                                    <div className="artifact-file-list">
                                      {message.artifact.changedFiles.length > 0 ? (
                                        message.artifact.changedFiles.map((file) => (
                                          <article key={`\${file.kind}-\${file.path}`} className="artifact-file-item">
                                            <div className="artifact-file-meta">
                                              <span className={`file-kind \${file.kind}`}>{fileKindLabel(file.kind)}</span>
                                              <code>{file.path}</code>
                                            </div>
                                            <p>{file.summary}</p>
                                            <button
                                              className="diff-button"
                                              type="button"
                                              onClick={() => setSelectedDiff({ title: message.artifact!.title, file })}
                                            >
                                              Open Diff
                                            </button>
                                          </article>
                                        ))
                                      ) : (
                                        <article className="artifact-file-item empty-state-card">
                                          <p>まだファイル変更はない。まずは workspace を読んで最初の実行に入る段階。</p>
                                        </article>
                                      )}
                                    </div>
                                  </section>

                                  <section className="artifact-section compact">
                                    <h3>Run Summary</h3>
                                    <div className="check-list">
                                      {message.artifact.runChecks.map((check) => (
                                        <div key={check.label} className="check-item">
                                          <span>{check.label}</span>
                                          <strong>{check.value}</strong>
                                        </div>
                                      ))}
                                    </div>
                                  </section>
                                </div>

                                <section className="artifact-section compact">
                                  <h3>Activity Notes</h3>
                                  <ul className="summary-list">
                                    {message.artifact.activitySummary.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </section>
                              </div>
                            ) : (
                              <div className="artifact-preview">
                                <span>{message.artifact.changedFiles.length} files changed</span>
                                <span>{message.artifact.runChecks.map((check) => `\${check.label}: \${check.value}`).join(" / ")}</span>
                              </div>
                            )}
                          </section>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            <div className="composer">
              <label className="composer-box">
                <div className="composer-copy">
                  <p className="kicker">Prompt</p>
                  <p>{selectedSession.character} のロールは保持したまま、coding task を継続する。</p>
                </div>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
                <button type="button" onClick={handleSend}>
                  Send
                </button>
              </label>
            </div>
          </section>

          <aside className="panel stream-panel rise-4">
            <div className="panel-head compact-head">
              <div>
                <p className="kicker">Character Stream</p>
                <h2>On-Air Stream</h2>
              </div>
              <span className="emotion-pill">{selectedSession.characterTone}</span>
            </div>

            <section className="stream-stage">
              <div className="stream-stage-copy">
                <p className="kicker">Pinned Character</p>
                <h3>{selectedSession.character}</h3>
                <p>
                  coding agent の実行面とは別に、同じキャラが横で見ていて、思ったことをぽろっと流し続ける。
                  暇なときに目をやると、作業と並走している感じが出る面。
                </p>
              </div>

              <div className="stream-stage-side">
                <CharacterAvatar character={selectedSessionCharacter} size="large" className="stream-stage-avatar" />
                <div className="stage-pills">
                  <span className="tag active">{selectedSession.streamMode}</span>
                  <span className="tag">{selectedSession.updatedAt}</span>
                  <span className="tag">{selectedSession.workspaceLabel}</span>
                </div>
              </div>
            </section>

            <div className="stream-list">
              {selectedSession.stream.map((entry, index) => (
                <article key={`\${entry.time}-\${index}`} className={`stream-card \${entry.mood}`}>
                  <div className="stream-card-head">
                    <div className="stream-speaker">
                      <CharacterAvatar character={selectedSessionCharacter} size="tiny" className="stream-entry-avatar" />
                      <div>
                        <p className="stream-time">{entry.time}</p>
                        <strong>{selectedSession.character}</strong>
                      </div>
                    </div>
                    <span className="stream-mood">{entry.mood}</span>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))}
            </div>

            <section className="character-lock">
              <CharacterAvatar character={selectedSessionCharacter} size="medium" className="lock-avatar" />
              <div>
                <p className="kicker">Roleplay Injection</p>
                <h3>{selectedSession.character}</h3>
                <p>
                  system prompt にはこのキャラ定義を安定注入する前提。Work Chat は実務を崩さず、
                  こっちはキャラの温度と距離感を持続させる役割に寄せる。
                </p>
              </div>
            </section>
          </aside>
        </section>
      </main>

      {selectedDiff ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setSelectedDiff(null)}>
          <section className="diff-editor panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <div>
                <p className="kicker">Diff Viewer</p>
                <h2>{selectedDiff.file.path}</h2>
              </div>
              <button className="diff-close" type="button" onClick={() => setSelectedDiff(null)}>
                Close
              </button>
            </div>

            <div className="diff-subbar">
              <span className="file-kind edit">{selectedDiff.title}</span>
              <span className={`file-kind \${selectedDiff.file.kind}`}>{fileKindLabel(selectedDiff.file.kind)}</span>
            </div>

            <div className="diff-columns-head">
              <span>Before</span>
              <span>After</span>
            </div>

            <div className="diff-grid">
              {selectedDiff.file.diffRows.map((row, index) => (
                <div key={`\${selectedDiff.file.path}-\${index}`} className={`diff-row \${row.kind}`}>
                  <span className="diff-line-number">{row.leftNumber ?? ""}</span>
                  <code className="diff-cell before">{row.leftText ?? ""}</code>
                  <span className="diff-line-number">{row.rightNumber ?? ""}</span>
                  <code className="diff-cell after">{row.rightText ?? ""}</code>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {launchOpen ? (
        <div className="launch-modal" role="dialog" aria-modal="true" onClick={() => setLaunchOpen(false)}>
          <section className="launch-dialog panel" onClick={(event) => event.stopPropagation()}>
            <div className="launch-dialog-head">
              <div>
                <p className="kicker">New Session</p>
                <h2>Launch Panel</h2>
              </div>
              <button className="diff-close" type="button" onClick={() => setLaunchOpen(false)}>
                Close
              </button>
            </div>

            <div className="launch-panel">
              <section className="launch-section workspace-picker">
                <div className="section-head">
                  <div>
                    <p className="kicker">Workspace Picker</p>
                    <h3>{selectedWorkspace ? selectedWorkspace.label : "workspace を選ぶ"}</h3>
                  </div>
                  <button className="browse-button" type="button" onClick={handleBrowseWorkspace}>
                    Browse
                  </button>
                </div>

                <p className="launch-path">
                  {selectedWorkspace ? selectedWorkspace.path : "作業ディレクトリがまだ選ばれてない。Browse か下の候補から選ぶ。"}
                </p>

                <div className="workspace-chip-list">
                  {workspacePresets.map((workspace) => (
                    <button
                      key={workspace.id}
                      className={`workspace-chip\${workspace.id === launchWorkspaceId ? " active" : ""}`}
                      type="button"
                      onClick={() => setLaunchWorkspaceId(workspace.id)}
                    >
                      <strong>{workspace.label}</strong>
                      <span>{workspace.hint}</span>
                    </button>
                  ))}
                </div>
              </section>

              <div className="launch-grid compact">
                <section className="launch-section profile-panel">
                  <div className="section-head">
                    <div>
                      <p className="kicker">Launch Profile</p>
                      <h3>起動条件</h3>
                    </div>
                    <span className="pill">Codex</span>
                  </div>

                  <div className="profile-row">
                    <span className="profile-label">Character</span>
                    <div className="choice-card-list">
                      {characterCatalog.map((character) => (
                        <button
                          key={character.id}
                          className={`choice-card\${character.name === launchCharacter ? " active" : ""}`}
                          type="button"
                          onClick={() => setLaunchCharacter(character.name)}
                        >
                          <CharacterAvatar character={character} size="small" className="choice-avatar" />
                          <div className="choice-card-copy">
                            <strong>{character.name}</strong>
                            <span>{character.tone}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="profile-row">
                    <span className="profile-label">Approval</span>
                    <div className="choice-list">
                      {[
                        { id: "on-request", label: "on-request" },
                        { id: "never", label: "never" },
                        { id: "untrusted", label: "untrusted" },
                      ].map((approval) => (
                        <button
                          key={approval.id}
                          className={`choice-chip\${approval.id === launchApproval ? " active" : ""}`}
                          type="button"
                          onClick={() => setLaunchApproval(approval.id)}
                        >
                          {approval.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="profile-grid">
                    <article>
                      <span className="profile-label">Tone</span>
                      <strong>{selectedCharacter.tone}</strong>
                    </article>
                    <article>
                      <span className="profile-label">Stream</span>
                      <strong>{selectedCharacter.streamMode}</strong>
                    </article>
                  </div>
                </section>
              </div>

              <section className="launch-section launch-summary">
                <div className="section-head">
                  <div>
                    <p className="kicker">Launch Summary</p>
                    <h3>この条件で開始</h3>
                  </div>
                  <span className={`launch-state\${selectedWorkspace ? " ready" : ""}`}>
                    {selectedWorkspace ? "Ready" : "Workspace Required"}
                  </span>
                </div>

                <div className="summary-grid">
                  <article>
                    <span className="profile-label">Workspace</span>
                    <strong>{selectedWorkspace ? selectedWorkspace.label : "未選択"}</strong>
                  </article>
                  <article>
                    <span className="profile-label">Character</span>
                    <strong>{selectedCharacter.name}</strong>
                  </article>
                  <article>
                    <span className="profile-label">Provider</span>
                    <strong>Codex</strong>
                  </article>
                  <article>
                    <span className="profile-label">Approval</span>
                    <strong>{launchApproval}</strong>
                  </article>
                </div>

                <button className="start-session-button" type="button" disabled={!selectedWorkspace} onClick={handleStartSession}>
                  Start New Session
                </button>
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

