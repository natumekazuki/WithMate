import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAdditionalDirectoryListToggle,
  applyAgentPickerToggleCommand,
  applyCancelTitleEditCommand,
  applyCentralSurfaceOpenCommand,
  applyComposerSubmitCommand,
  applyComposerReferenceInsertionCommand,
  applyContextPaneTabCycleCommand,
  applyActionDockCollapseCommand,
  applyActionDockExpandCommand,
  applyAgentPickerCloseCommand,
  applyExpandedArtifactToggleCommand,
  applyExclusiveComposerPickerToggle,
  applyHeaderExpandedToggleCommand,
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applyPastedSessionAttachmentPathsCommand,
  applyQuoteMessageTextCommand,
  applySelectedPathReferenceInsertionCommand,
  applySkillPromptInsertionCommand,
  applySessionFilesReferencePathsCommand,
  applySkillPromptInsertionUiState,
  applySkillPickerToggleCommand,
  applyStartTitleEditCommand,
  applyTitleInputKeyCommand,
  applyUnavailableContextPaneTabFallbackCommand,
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createAdditionalDirectoryListToggleHandler,
  createAgentPickerCloseHandler,
  createAgentPickerToggleHandler,
  createCancelTitleEditHandler,
  createContextPaneTabCycleHandler,
  createExpandedArtifactToggleHandler,
  createHeaderExpandedToggleHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
  createSkillPickerToggleHandler,
  createSkillPromptInsertionHandler,
  createStartTitleEditHandler,
  createTitleInputKeyHandler,
  resolveHeaderExpandedToggle,
  runSessionFilesOpenCommand,
  toggleExpandedArtifactState,
} from "../../src/chat/session-shell-handlers.js";
import type { ContextPaneTabKey } from "../../src/chat/runtime/session-ui-projection.js";

/** 展開状態の投影で対象項目だけを変更する契約。 */
describe("toggleExpandedArtifactState", () => {
  /** 展開・折りたたみの反転と未登録キーの扱いを確認する。 */
  it("指定 artifact の展開状態を反転する", () => {
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "a"), {
      a: false,
    });
    assert.deepEqual(toggleExpandedArtifactState({ a: true }, "b"), {
      a: true,
      b: true,
    });
  });
});

/** 展開状態の更新をsetterへ渡すコマンドの契約。 */
describe("applyExpandedArtifactToggleCommand", () => {
  /** 既存の項目と未登録の項目を、状態更新コールバックでそれぞれ反転できることを確認する。 */
  it("指定 artifact の展開状態を setter 経由で反転する", () => {
    let expandedArtifacts: Record<string, boolean> = { a: true };

    applyExpandedArtifactToggleCommand({
      artifactKey: "a",
      /** 既存の展開情報に更新関数を適用する。 */
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });
    assert.deepEqual(expandedArtifacts, { a: false });

    applyExpandedArtifactToggleCommand({
      artifactKey: "b",
      /** 次の未登録キーへの変更にも、最初の操作結果を渡す。 */
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });
    assert.deepEqual(expandedArtifacts, { a: false, b: true });
  });
});

/** UIから項目キーを受け取る展開ハンドラーの契約。 */
describe("createExpandedArtifactToggleHandler", () => {
  /** ハンドラーの連続操作が展開状態の更新へ伝わることを確認する。 */
  it("artifact toggle handler を作る", () => {
    let expandedArtifacts: Record<string, boolean> = { a: true };
    const toggleArtifact = createExpandedArtifactToggleHandler({
      /** ハンドラーが受け取った更新を現在の展開情報へ反映する。 */
      setExpandedArtifacts: (updater) => {
        expandedArtifacts = updater(expandedArtifacts);
      },
    });

    toggleArtifact("a");
    toggleArtifact("b");

    assert.deepEqual(expandedArtifacts, { a: false, b: true });
  });
});

/** タイトル編集中のヘッダー開閉可否を評価する。 */
describe("resolveHeaderExpandedToggle", () => {
  /** タイトル入力中は今の開閉状態を保ち、入力していなければ反転することを確認する。 */
  it("title 編集中は状態を維持し、それ以外は反転する", () => {
    assert.equal(resolveHeaderExpandedToggle(false, true), false);
    assert.equal(resolveHeaderExpandedToggle(true, true), true);
    assert.equal(resolveHeaderExpandedToggle(false, false), true);
    assert.equal(resolveHeaderExpandedToggle(true, false), false);
  });
});

/** ヘッダー開閉の制約を実際の状態更新に適用する。 */
describe("applyHeaderExpandedToggleCommand", () => {
  /** タイトル編集中かどうかに応じてヘッダーの変更を許可することを確認する。 */
  it("title 編集中でなければ header 展開状態を反転し、編集中は維持する", () => {
    let expanded = false;

    applyHeaderExpandedToggleCommand({
      isEditingTitle: false,
      /** 編集していない場合の反転を現在状態に適用する。 */
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);

    applyHeaderExpandedToggleCommand({
      isEditingTitle: true,
      /** 編集中の操作では前回の展開状態がそのまま返るかを観測する。 */
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    assert.equal(expanded, true);
  });
});

/** 入力状態を渡してヘッダー開閉操作へつなぐハンドラーの検証。 */
describe("createHeaderExpandedToggleHandler", () => {
  /** 開閉ハンドラー経由でもタイトル編集中は現在の展開を保持することを確認する。 */
  it("header 展開 toggle handler を作る", () => {
    let expanded = false;

    const toggleHeader = createHeaderExpandedToggleHandler({
      isEditingTitle: false,
      /** 通常操作で変更する展開状態を保持する。 */
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    toggleHeader();
    assert.equal(expanded, true);

    const editingToggle = createHeaderExpandedToggleHandler({
      isEditingTitle: true,
      /** タイトル入力状態を切り替えたハンドラーの結果を同じ状態へ反映する。 */
      setHeaderExpanded: (updater) => {
        expanded = updater(expanded);
      },
    });
    editingToggle();
    assert.equal(expanded, true);
  });
});

/** タイトル欄のキー操作が保存と取消に分かれることを検証する。 */
describe("applyTitleInputKeyCommand", () => {
  /** EnterとEscapeだけを処理し、既定動作の抑止と対応する確定操作を観測する。 */
  it("Enter では保存、Escape ではキャンセルし、それ以外では何もしない", () => {
    const events: string[] = [];

    /** 指定したキーに対するコマンドの効果を同じイベント列へ集める。 */
    const runCommand = (key: string) =>
      applyTitleInputKeyCommand({
        key,
        /** キーごとに既定動作が抑止されたことを記録する。 */
        preventDefault: () => events.push(`prevent:${key}`),
        /** タイトル保存へ進んだことを記録する。 */
        saveTitle: () => events.push("save"),
        /** 入力編集の取消へ進んだことを記録する。 */
        cancelTitleEdit: () => events.push("cancel"),
      });

    runCommand("Enter");
    runCommand("Escape");
    runCommand("Tab");

    assert.deepEqual(events, [
      "prevent:Enter",
      "save",
      "prevent:Escape",
      "cancel",
    ]);
  });
});

/** キーイベントをタイトル操作コマンドへ渡すハンドラーの契約。 */
describe("createTitleInputKeyHandler", () => {
  /** ハンドラーでもキーに応じて保存と取消を呼び分けることを確認する。 */
  it("title input keydown handler を作る", () => {
    const events: string[] = [];
    const handleKeyDown = createTitleInputKeyHandler({
      /** ハンドラーからの保存要求をイベント列へ加える。 */
      saveTitle: () => events.push("save"),
      /** ハンドラーからの編集取消をイベント列へ加える。 */
      cancelTitleEdit: () => events.push("cancel"),
    });

    /** キーイベントを模擬し、そのキーの既定動作が止まったかを記録する。 */
    const runHandler = (key: string) =>
      handleKeyDown({
        key,
        /** 渡したキーが消費された順序を観測する。 */
        preventDefault: () => events.push(`prevent:${key}`),
      });

    runHandler("Enter");
    runHandler("Escape");
    runHandler("ArrowLeft");

    assert.deepEqual(events, [
      "prevent:Enter",
      "save",
      "prevent:Escape",
      "cancel",
    ]);
  });
});

/** Composer送信の可否と、阻止理由を通知する経路を検証する。 */
describe("applyComposerSubmitCommand", () => {
  /** 有効な送信だけを実行し、無効な操作では送信しないことを確認する。 */
  it("送信可能な場合だけ submit し、disabled では何もしない", () => {
    const events: string[] = [];
    /** 指定された送信可否で同じコマンドを評価する。 */
    const runCommand = (input: { isSubmitDisabled?: boolean }) =>
      applyComposerSubmitCommand({
        isSubmitDisabled: input.isSubmitDisabled,
        /** 実際に送信まで進んだことを記録する。 */
        submit: () => events.push("submit"),
      });

    assert.equal(runCommand({ isSubmitDisabled: true }), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand({}), true);
    assert.deepEqual(events, ["submit"]);
  });

  /** ショートカット送信がブロックされた場合に本文を送らず、理由だけを通知することを確認する。 */
  it("送信 shortcut が blocked の場合は feedback だけ呼ぶ", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitCommand({
        isSubmitBlocked: true,
        /** 送信を止めた理由を利用者に通知したことを記録する。 */
        notifySubmitBlocked: () => events.push("blocked"),
        /** ブロック中に誤って送信を実行した場合を検出する。 */
        submit: () => events.push("submit"),
      }),
      true,
    );

    assert.deepEqual(events, ["blocked"]);
  });

  /** 送信制約を関数で渡した場合の評価順と短絡を確認する。 */
  it("disabled と blocked の判定を遅延評価する", () => {
    const events: string[] = [];

    assert.equal(
      applyComposerSubmitCommand({
        /** 送信の無効判定が実際に評価されたことを記録する。 */
        isSubmitDisabled: () => {
          events.push("disabled");
          return true;
        },
        /** ブロック判定を呼んだ時点を記録する。 */
        isSubmitBlocked: () => {
          events.push("blocked");
          return false;
        },
        /** 判定後に送信へ進んだ場合をイベント列で観測する。 */
        submit: () => events.push("submit"),
      }),
      false,
    );

    assert.deepEqual(events, ["disabled"]);
  });
});

/** タイトル編集を開始する際の状態変更を検証する。 */
describe("applyStartTitleEditCommand", () => {
  /** 現在のタイトルを下書きに使い、ヘッダーを開いた状態で編集へ入ることを確認する。 */
  it("title draft を現在値に戻し、header を展開して title 編集中にする", () => {
    const events: string[] = [];

    applyStartTitleEditCommand({
      title: "現在のタイトル",
      /** 編集開始時に入力欄へ渡したタイトルを記録する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** 入力欄を出すためのヘッダー展開を記録する。 */
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      /** 編集状態へ入ったことをイベントに残す。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, [
      "draft:現在のタイトル",
      "expanded:true",
      "editing:true",
    ]);
  });
});

/** タイトル編集開始ハンドラーが許可条件と現在値を反映する契約。 */
describe("createStartTitleEditHandler", () => {
  /** 開始できる場合に現在値の下書きを準備し、展開と編集を開始することを確認する。 */
  it("開始可能な場合だけ title 編集 state を反映する", () => {
    const events: string[] = [];
    const startTitleEdit = createStartTitleEditHandler({
      /** ハンドラー実行時に使う保存済みタイトルを渡す。 */
      getTitle: () => "現在のタイトル",
      /** 開いているタイトルを編集できる条件を返す。 */
      canStart: () => true,
      /** 下書きに写された現在値を記録する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** 編集開始に伴う展開指定を記録する。 */
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      /** 編集モードへの移行指定を記録する。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.equal(startTitleEdit(), true);
    assert.deepEqual(events, [
      "draft:現在のタイトル",
      "expanded:true",
      "editing:true",
    ]);
  });

  /** 開始不可か現在タイトルを得られない場合、編集状態に触れないことを確認する。 */
  it("開始不可または title がない場合は何もしない", () => {
    const events: string[] = [];
    const blockedStart = createStartTitleEditHandler({
      /** 開始を拒否してもタイトル自体は存在する条件にする。 */
      getTitle: () => "現在のタイトル",
      /** タイトルがあっても今は編集を開始できない条件を返す。 */
      canStart: () => false,
      /** 開始不可のとき下書きへの到達を検出する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** 開始不可のときヘッダー展開への到達を検出する。 */
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      /** 開始不可のとき編集モードへの変更を検出する。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });
    const missingTitleStart = createStartTitleEditHandler({
      /** 編集元となるタイトルが取得できなかった状態を作る。 */
      getTitle: () => null,
      /** タイトル不在のとき下書きが更新された場合を記録する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** タイトル不在のときヘッダーを開こうとした場合を記録する。 */
      setHeaderExpanded: (expanded) => events.push(`expanded:${expanded}`),
      /** タイトル不在のまま編集開始に進んだ場合を記録する。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.equal(blockedStart(), false);
    assert.equal(missingTitleStart(), false);
    assert.deepEqual(events, []);
  });
});

/** タイトル編集の取消で入力と編集状態を戻す処理を検証する。 */
describe("applyCancelTitleEditCommand", () => {
  /** 入力中の値を現在のタイトルに戻し、編集状態を解除することを確認する。 */
  it("title draft を現在値に戻し、title 編集中を解除する", () => {
    const events: string[] = [];

    applyCancelTitleEditCommand({
      title: "現在のタイトル",
      /** 取り消した後に復元されたタイトルを記録する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** 取消でセットされた編集フラグを記録する。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    assert.deepEqual(events, ["draft:現在のタイトル", "editing:false"]);
  });
});

/** ハンドラー経由でタイトル編集を取り消す場合の初期値を検証する。 */
describe("createCancelTitleEditHandler", () => {
  /** 復元元のタイトルがない場合、取消で空文字へ戻して編集を終えることを確認する。 */
  it("title 編集キャンセル handler を作り、title がない場合は空文字へ戻す", () => {
    const events: string[] = [];
    const cancelTitleEdit = createCancelTitleEditHandler({
      /** 現在タイトルを取得できない場合を再現する。 */
      getTitle: () => null,
      /** タイトルがないまま取消したときの下書き値を記録する。 */
      setTitleDraft: (title) => events.push(`draft:${title}`),
      /** 空文字への復元後に編集が終わったことを記録する。 */
      setEditingTitle: (editing) => events.push(`editing:${editing}`),
    });

    cancelTitleEdit();

    assert.deepEqual(events, ["draft:", "editing:false"]);
  });
});

/** Action Dockの展開とComposerへのフォーカスを分けて検証する。 */
describe("applyActionDockExpandCommand", () => {
  /** Dockの展開後、明示的に求められた場合だけComposerへフォーカスすることを確認する。 */
  it("dock を展開し、focusComposer が true の場合だけ composer focus を呼ぶ", () => {
    const events: string[] = [];

    applyActionDockExpandCommand({
      options: { focusComposer: false },
      /** フォーカスを要求しない展開の変更値を記録する。 */
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      /** 展開だけの操作で予期せぬComposerフォーカスがあれば記録する。 */
      focusComposer: () => {
        events.push("focus");
      },
    });
    applyActionDockExpandCommand({
      options: { focusComposer: true },
      /** フォーカスも要求する場合にまず展開が反映されたことを記録する。 */
      setPinnedExpanded: (expanded) => {
        events.push(`expanded:${expanded}`);
      },
      /** 展開を反映した後のComposerフォーカスを記録する。 */
      focusComposer: () => {
        events.push("focus");
      },
    });

    assert.deepEqual(events, ["expanded:true", "expanded:true", "focus"]);
  });
});

/** 折りたたみ可能な場合だけAction Dockの固定展開を解除する契約。 */
describe("applyActionDockCollapseCommand", () => {
  /** 禁止中の操作では更新せず、許可時だけ折りたたみを指定することを確認する。 */
  it("collapse 可能な場合だけ pinned expanded を false にする", () => {
    const events: boolean[] = [];

    applyActionDockCollapseCommand({
      canCollapse: false,
      /** 折りたたみ禁止時に状態更新へ到達した場合を検出する。 */
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });
    applyActionDockCollapseCommand({
      canCollapse: true,
      /** 折りたたみが許可された場合に指定された状態を記録する。 */
      setPinnedExpanded: (expanded) => {
        events.push(expanded);
      },
    });

    assert.deepEqual(events, [false]);
  });
});

/** 展開ハンドラーの既定設定と呼出時の上書きを検証する。 */
describe("createActionDockExpandHandler", () => {
  /** 既定ではComposerへフォーカスせず、呼出時に指定した場合は展開とフォーカスを行うことを確認する。 */
  it("default options を使いつつ、呼び出し時 options で composer focus を上書きできる", () => {
    const events: string[] = [];
    const expand = createActionDockExpandHandler({
      defaultOptions: { focusComposer: false },
      /** どちらの呼出もDockの展開を指定したことを記録する。 */
      setPinnedExpanded: (expanded) => events.push(`expanded:${expanded}`),
      /** 呼出時の指定によるComposerフォーカスを観測する。 */
      focusComposer: () => events.push("focus"),
    });

    expand();
    expand({ focusComposer: true });

    assert.deepEqual(events, ["expanded:true", "expanded:true", "focus"]);
  });
});

/** 作成時の折りたたみ可否を使うDockハンドラーを検証する。 */
describe("createActionDockCollapseHandler", () => {
  /** ハンドラーに固定した可否で、閉じる操作を実行するか無視するかが決まることを確認する。 */
  it("collapse 可能性を固定した collapse handler を作る", () => {
    const events: boolean[] = [];
    const blockedCollapse = createActionDockCollapseHandler({
      canCollapse: false,
      /** 折りたたみ不可のハンドラーによる状態変更を検出する。 */
      setPinnedExpanded: (expanded) => events.push(expanded),
    });
    const collapse = createActionDockCollapseHandler({
      canCollapse: true,
      /** 折りたたみ可能なハンドラーの指定値を記録する。 */
      setPinnedExpanded: (expanded) => events.push(expanded),
    });

    blockedCollapse();
    collapse();

    assert.deepEqual(events, [false]);
  });
});

/** 中央表示を切り替える際に、現在の画面を閉じられるかを評価する。 */
describe("applyCentralSurfaceOpenCommand", () => {
  /** テンプレートの未保存変更を破棄しない選択では、現在の中央画面を閉じないことを確認する。 */
  it("Template編集の未保存変更が破棄拒否された場合は中央surfaceを切り替えない", () => {
    let closeCount = 0;

    const opened = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen: true,
      /** 利用者が未保存変更の破棄を拒否した状態を作る。 */
      canClosePromptTemplate: () => false,
      /** 拒否されたにもかかわらず中央画面を閉じた場合を数える。 */
      closeCentralSurface: () => {
        closeCount += 1;
      },
    });

    assert.equal(opened, false);
    assert.equal(closeCount, 0);
  });

  /** 未保存編集の制約がなければ、既存画面を先に閉じて新しい画面へ移れることを確認する。 */
  it("現在の中央surfaceを閉じてから次のsurfaceへ進める", () => {
    let centralSurface: "file-preview" | "skill" | null = "file-preview";

    const opened = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen: false,
      /** テンプレートを閉じる制約がない条件を渡す。 */
      canClosePromptTemplate: () => true,
      /** 現在のプレビューを閉じたことを中央画面の状態へ反映する。 */
      closeCentralSurface: () => {
        centralSurface = null;
      },
    });
    if (opened) {
      centralSurface = "skill";
    }

    assert.equal(opened, true);
    assert.equal(centralSurface, "skill");
  });
});

/** ComposerのAgent・Skillピッカーを相互排他にするコマンドの検証。 */
describe("applyExclusiveComposerPickerToggle", () => {
  /** Agentピッカーを切り替えると、開いていたSkillピッカーが閉じることを確認する。 */
  it("agent picker を toggle すると skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;

    applyExclusiveComposerPickerToggle({
      target: "agent",
      /** Agent側に渡された反転を開閉状態へ適用する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** Agent操作がSkill側を閉じるよう更新したかを観測する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });

  /** Skillピッカーを切り替えると、開いていたAgentピッカーが閉じることを確認する。 */
  it("skill picker を toggle すると agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;

    applyExclusiveComposerPickerToggle({
      target: "skill",
      /** Skill操作によるAgent側の閉鎖を状態へ反映する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** Skill側への開閉更新を適用する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

/** Agent専用の開閉コマンドでComposerの排他性が保たれることを検証する。 */
describe("applyAgentPickerToggleCommand", () => {
  /** Agentの開閉指定が、同時に表示されているSkillの閉鎖を伴うことを確認する。 */
  it("agent picker を toggle し、skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;

    applyAgentPickerToggleCommand({
      /** Agent側の状態をコマンドが渡す関数で更新する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** スキル側を閉じる更新結果を保存する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });
});

/** AgentピッカーのUI操作を排他な開閉へつなぐハンドラーを検証する。 */
describe("createAgentPickerToggleHandler", () => {
  /** 実際のAgent操作ハンドラーで、自身の開閉とSkillの閉鎖が両立することを確認する。 */
  it("agent picker toggle handler を作り、skill picker を閉じる", () => {
    let agentOpen = false;
    let skillOpen = true;
    const toggleAgentPicker = createAgentPickerToggleHandler({
      /** 連続操作で使われるAgent側の現在値を更新する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** ハンドラーがSkill側へ適用する開閉更新を記録する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    toggleAgentPicker();

    assert.equal(agentOpen, true);
    assert.equal(skillOpen, false);
  });
});

/** Agentピッカーを閉じるときの状態指定を検証する。 */
describe("applyAgentPickerCloseCommand", () => {
  /** 閉じるコマンドがAgentの表示状態を明示的にfalseへ設定することを確認する。 */
  it("agent picker を閉じる", () => {
    const values: boolean[] = [];

    applyAgentPickerCloseCommand({
      /** コマンドに指定された表示フラグを記録する。 */
      setAgentPickerOpen: (open) => {
        values.push(open);
      },
    });

    assert.deepEqual(values, [false]);
  });
});

/** Agentピッカーを閉じるUIハンドラーの契約。 */
describe("createAgentPickerCloseHandler", () => {
  /** 引数のない閉じるハンドラーがAgentの表示解除に接続されることを確認する。 */
  it("agent picker close handler を作る", () => {
    const values: boolean[] = [];
    const closeAgentPicker = createAgentPickerCloseHandler({
      /** ハンドラーを通して受け取ったAgentの表示フラグを控える。 */
      setAgentPickerOpen: (open) => {
        values.push(open);
      },
    });

    closeAgentPicker();

    assert.deepEqual(values, [false]);
  });
});

/** Skillの開閉コマンドがAgentとの相互排他を守ることを検証する。 */
describe("applySkillPickerToggleCommand", () => {
  /** Skillの開閉を他方のピッカーの閉鎖とともに適用することを確認する。 */
  it("skill picker を toggle し、agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;

    applySkillPickerToggleCommand({
      /** Skill操作で渡されたAgentの状態変更を適用する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** Skillの開閉変更を同じ入力状態に保持する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

/** SkillピッカーのUI操作を排他開閉に結び付けるハンドラーを検証する。 */
describe("createSkillPickerToggleHandler", () => {
  /** 構築したハンドラーでもSkillの切替でAgentが閉じることを確認する。 */
  it("skill picker toggle handler を作り、agent picker を閉じる", () => {
    let agentOpen = true;
    let skillOpen = false;
    const toggleSkillPicker = createSkillPickerToggleHandler({
      /** 操作後のAgentピッカーの状態を次の呼出まで保持する。 */
      setAgentPickerOpen: (updater) => {
        agentOpen = updater(agentOpen);
      },
      /** 操作のたびにSkill側の現在の開閉状態を更新する。 */
      setSkillPickerOpen: (updater) => {
        skillOpen = updater(skillOpen);
      },
    });

    toggleSkillPicker();

    assert.equal(agentOpen, false);
    assert.equal(skillOpen, true);
  });
});

/** Skill本文挿入後の下書き周りの表示状態を検証する。 */
describe("applySkillPromptInsertionUiState", () => {
  /** 挿入後はDockを展開し、キャレットの記録を更新してSkillピッカーを閉じることを確認する。 */
  it("skill prompt 挿入後の UI state を setter に反映する", () => {
    const events: string[] = [];

    applySkillPromptInsertionUiState({
      state: {
        caret: 12,
        isActionDockPinnedExpanded: true,
        isSkillPickerOpen: false,
      },
      /** 下書きを見せるためのDock展開指定を記録する。 */
      setActionDockPinnedExpanded: (expanded) =>
        events.push(`dock:${expanded}`),
      /** 挿入結果のキャレット位置を記録する。 */
      setCaret: (caret) => events.push(`caret:${caret}`),
      /** 挿入後に指定されたSkillピッカーの表示状態を記録する。 */
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
    });

    assert.deepEqual(events, ["dock:true", "caret:12", "skill:false"]);
  });
});

/** Skill本文挿入をComposerの下書きとフォーカスへ反映するコマンドの検証。 */
describe("applySkillPromptInsertionCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "skill prompt挿入後はdraft/UI stateを反映してfocusとcaret復元を行う"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "draftだけ更新してfocus/caret復元を失う、またはstate反映順を壊す"
  // observable = "handler eventsのdraft/UI state/focus/caret sequence"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.skill-prompt"
  // lifecycle = "permanent"
  // distinction = "handler callbackへ渡る順序と引数をevent logで確認する"
  // @end-test-value
  /** 挿入した本文を反映した後にエディターへのフォーカスとキャレットを復元することを確認する。 */
  it("skill prompt 挿入後の UI state と draft 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      /** 下書き反映後にエディターへフォーカスが戻った順序を記録する。 */
      focus: () => {
        events.push("focus");
      },
      /** 復元時に指定された選択範囲の両端を記録する。 */
      setSelectionRange: (start: number, end: number) => {
        events.push(`selection:${start}:${end}`);
      },
    } as HTMLTextAreaElement;

    applySkillPromptInsertionCommand({
      state: {
        draft: "/review ",
        caret: 8,
        isActionDockPinnedExpanded: true,
        isSkillPickerOpen: false,
      },
      textarea,
      /** 挿入した本文を表示するためDockに渡された開閉指定を記録する。 */
      setActionDockPinnedExpanded: (expanded) =>
        events.push(`dock:${expanded}`),
      /** 挿入時に算出されたキャレット位置を記録する。 */
      setCaret: (caret) => events.push(`caret:${caret}`),
      /** Skill選択を終えた後のピッカーの開閉指定を記録する。 */
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      /** 挿入本文とキャレット位置がフォーカス復元より先に反映されたことを記録する。 */
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      /** フォーカスを先に戻し、指定位置に選択のないキャレットを置く。 */
      restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
        textarea?.focus();
        textarea?.setSelectionRange(caret, caret);
      },
    });

    assert.deepEqual(events, [
      "dock:true",
      "caret:8",
      "skill:false",
      "draft:8:/review ",
      "focus",
      "selection:8:8",
    ]);
  });
});

/** 選択したSkillとProviderからComposerへの挿入を組み立てるハンドラーを検証する。 */
describe("createSkillPromptInsertionHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Main composerのClaude Skill選択は検出済みsourcePathを生成draftへ渡す"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts: createSkillPromptInsertionHandler" }
  // fault = "選択したSkillのsourcePathを捨て、Claudeへ名前だけの指示を挿入する"
  // observable = "Main handlerがapplyDraftへ渡す文字列"
  // observation_boundary = "component-behavior"
  // scope = "main-composer-skill-selection"
  // lifecycle = "permanent"
  // impact = "MainのClaude turnで選択済みSkillの本文を特定できない"
  // distinction = "snippet単体testではMain handlerからsourcePathが伝搬することを確認できない"
  // @end-test-value
  /** ClaudeでSkillを選ぶと、その選択元パスをMainの下書きへ挿入することを確認する。 */
  it("ClaudeのSkill選択ではMain draftに選択元pathを挿入する", () => {
    const drafts: string[] = [];
    const selectSkill = createSkillPromptInsertionHandler({
      /** パスによる参照を使うClaudeを指定する。 */
      getProvider: () => "claude",
      /** 既存の依頼文へSkill参照を加える状況を作る。 */
      getDraft: () => "fix it",
      /** textareaを使わず、下書きへの挿入結果だけを観測する。 */
      getTextarea: () => null,
      /** 挿入されたパスの検証ではDockの展開を扱わない。 */
      setActionDockPinnedExpanded() {},
      /** パスの比較にキャレットの保存状態は使わない。 */
      setCaret() {},
      /** 本文検証だけのためピッカーの表示は変更しない。 */
      setSkillPickerOpen() {},
      /** Skillの選択元が挿入された下書きを集める。 */
      applyDraft: (draft) => drafts.push(draft),
      /** textareaがないためキーボードフォーカスは復元しない。 */
      restoreComposerTextareaFocusAndCaret() {},
    });
    selectSkill({ name: "review", sourcePath: ".agents/skills/review" });
    assert.deepEqual(drafts, [
      'Use the skill "review" from ".agents/skills/review/SKILL.md" for this task.\n\nfix it',
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "providerがある場合はskill prompt handlerがdraftとUI stateを反映する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "providerなしでもdraft/stateを更新する、またはproviderありの反映を欠落させる"
  // observable = "providerありのhandler return valueとdraft/UI state events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.skill-prompt"
  // lifecycle = "permanent"
  // distinction = "provider存在時の反映契約を確認する（providerなしのno-opは別testで扱う）"
  // @end-test-value
  /** Providerを取得できる場合だけ下書き・表示・選択位置へ挿入結果を適用することを確認する。 */
  it("skill prompt 挿入 handler を作り、provider がある場合だけ draft と UI state を反映する", () => {
    const events: string[] = [];
    const textarea = {
      /** Providerありの経路で挿入後のtextareaフォーカスを記録する。 */
      focus: () => {
        events.push("focus");
      },
      /** 復元した選択範囲の両端を記録し、キャレット位置を観測する。 */
      setSelectionRange: (start: number, end: number) => {
        events.push(`selection:${start}:${end}`);
      },
    } as HTMLTextAreaElement;
    const selectSkill = createSkillPromptInsertionHandler({
      /** Codexで有効なSkillの挿入経路を選ぶ。 */
      getProvider: () => "codex",
      /** 挿入前に選択や既存本文がない下書きとする。 */
      getDraft: () => "",
      /** フォーカス復元の対象となるtextareaを渡す。 */
      getTextarea: () => textarea,
      /** 挿入結果を表示するためのDock展開を記録する。 */
      setActionDockPinnedExpanded: (expanded) =>
        events.push(`dock:${expanded}`),
      /** Skill本文の直後に移動するキャレット位置を記録する。 */
      setCaret: (caret) => events.push(`caret:${caret}`),
      /** 選択後にSkillピッカーを閉じる指定を記録する。 */
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      /** エディターに適用する挿入済みの下書きとキャレットを控える。 */
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      /** 適用した本文へフォーカスを戻し、計算済みの位置に選択を揃える。 */
      restoreComposerTextareaFocusAndCaret: (targetTextarea, caret) => {
        targetTextarea?.focus();
        targetTextarea?.setSelectionRange(caret, caret);
      },
    });

    selectSkill({ name: "review" });

    assert.deepEqual(events, [
      "dock:true",
      "caret:8",
      "skill:false",
      "draft:8:$review\n",
      "focus",
      "selection:8:8",
    ]);
  });

  /** Provider未選択時はSkillを選んでも下書きやUIを変更しないことを確認する。 */
  it("provider がない場合は何もしない", () => {
    const events: string[] = [];
    const selectSkill = createSkillPromptInsertionHandler({
      /** Skill挿入を開始できないProvider不在を再現する。 */
      getProvider: () => null,
      /** Provider不在でも参照できる既定の空下書きを返す。 */
      getDraft: () => "",
      /** 使えるtextareaがない状態を返す。 */
      getTextarea: () => null,
      /** 挿入を開始できない条件でDockが展開された場合を検出する。 */
      setActionDockPinnedExpanded: (expanded) =>
        events.push(`dock:${expanded}`),
      /** 挿入なしでキャレットが変更された場合を検出する。 */
      setCaret: (caret) => events.push(`caret:${caret}`),
      /** 挿入なしでSkillピッカーが変更された場合を検出する。 */
      setSkillPickerOpen: (open) => events.push(`skill:${open}`),
      /** Provider未選択なのに下書きが適用された場合を検出する。 */
      applyDraft: (draft, caret) => events.push(`draft:${caret}:${draft}`),
      /** Provider未選択時にフォーカス復元まで到達した場合を検出する。 */
      restoreComposerTextareaFocusAndCaret: (_textarea, caret) =>
        events.push(`focus:${caret}`),
    });

    selectSkill({ name: "review" });

    assert.deepEqual(events, []);
  });
});

/** 追加ディレクトリー一覧の開閉を状態更新関数で反転する処理を検証する。 */
describe("applyAdditionalDirectoryListToggle", () => {
  /** 閉じた一覧を開き、次の操作で閉じることを確認する。 */
  it("additional directory list の開閉状態を反転する", () => {
    let open = false;

    applyAdditionalDirectoryListToggle({
      /** 閉じた状態から開くための更新関数を適用する。 */
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, true);

    applyAdditionalDirectoryListToggle({
      /** 開いた結果に次の反転を適用する。 */
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });
    assert.equal(open, false);
  });
});

/** 一覧のUI操作から追加ディレクトリー一覧の状態反転へつなぐ処理を検証する。 */
describe("createAdditionalDirectoryListToggleHandler", () => {
  /** 同じハンドラーで開閉を繰り返せることを確認する。 */
  it("additional directory list toggle handler を作る", () => {
    let open = false;
    const toggleList = createAdditionalDirectoryListToggleHandler({
      /** 同じsetterに届く複数の更新を順番に現在値へ適用する。 */
      setAdditionalDirectoryListOpen: (updater) => {
        open = updater(open);
      },
    });

    toggleList();
    assert.equal(open, true);

    toggleList();
    assert.equal(open, false);
  });
});

/** 追加ディレクトリーの選択結果を、次回の選択起点と一覧表示へ反映する処理を検証する。 */
describe("applyPickedAdditionalDirectoryUiStateCommand", () => {
  /** 選択を取り消した場合は変更せず、パスを選んだ場合だけ基準パス・選択結果・一覧表示を更新することを確認する。 */
  it("選択 directory がある場合だけ base directory と optional UI state を反映する", () => {
    const events: string[] = [];
    /** 有効なパスと未選択を同じコマンドへ渡せるようにする。 */
    const runCommand = (selectedPath: string | null | undefined) =>
      applyPickedAdditionalDirectoryUiStateCommand({
        selectedPath,
        /** 次のファイル選択を始める位置として指定された基準ディレクトリーを記録する。 */
        setPickerBaseDirectory: (baseDirectory) =>
          events.push(`base:${baseDirectory}`),
        /** 追加するディレクトリーのパスを記録する。 */
        applyPickedDirectory: (directoryPath) =>
          events.push(`apply:${directoryPath}`),
        /** 選択結果の追加後に一覧を開く指定を記録する。 */
        setAdditionalDirectoryListOpen: (open) => events.push(`open:${open}`),
      });

    assert.equal(runCommand(null), false);
    assert.equal(runCommand(undefined), false);
    assert.equal(runCommand(""), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand("C:\\workspace\\fixtures"), true);
    assert.deepEqual(events, [
      "base:C:\\workspace\\fixtures",
      "apply:C:\\workspace\\fixtures",
      "open:true",
    ]);
  });
});

/** 利用可能なタブの集合に従うコンテキストペインの移動を検証する。 */
describe("applyContextPaneTabCycleCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "context paneのactive tabは利用可能なtabだけを循環する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "削除済みtabを循環対象にして存在しないpaneを選択する"
  // observable = "tab cycle後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  /** 前方向・後方向への移動は現在利用可能なタブの間だけで循環することを確認する。 */
  it("利用可能な context pane tab の中で active tab を循環する", () => {
    let activeTab: ContextPaneTabKey = "latest-command";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 先頭から次のタブに進む更新を現在値へ反映する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 末尾から先頭へ折り返す更新を反映する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "latest-command");

    applyContextPaneTabCycleCommand({
      direction: -1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 先頭から逆方向で末尾へ折り返す更新を反映する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });
    assert.equal(activeTab, "tasks");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "利用不可のactive tabは利用可能なcontext pane tabへ退避する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "利用不可tabを保持してpaneが空になる"
  // observable = "fallback後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  /** 現在のタブを選べなくなった場合、利用可能な先頭タブから移動を始めることを確認する。 */
  it("active tab が利用可能タブにない場合は先頭から循環する", () => {
    let activeTab: ContextPaneTabKey = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 利用不可の現在値を有効候補へ変更する更新を適用する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "tasks");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "利用可能tabが空でもactive tabはlatest-commandへ戻る"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "空のtab一覧で無効なtabを保持する"
  // observable = "空一覧処理後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle"
  // lifecycle = "permanent"
  // @end-test-value
  /** 候補が空の場合の既定タブが最新コマンドであることを確認する。 */
  it("利用可能タブが空の場合は latest-command を維持する", () => {
    let activeTab: ContextPaneTabKey = "reasoning";

    applyContextPaneTabCycleCommand({
      direction: 1,
      availableTabs: [] as ContextPaneTabKey[],
      /** 空の候補に対して選ばれたフォールバックを記録する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    assert.equal(activeTab, "latest-command");
  });
});

/** キーボードなどのUI操作から、利用可能タブの循環へつなぐハンドラーの検証。 */
describe("createContextPaneTabCycleHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "context pane tab cycle handlerはsetterへ循環結果を渡す"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "handlerがactive tabを更新しない"
  // observable = "handler実行後のactive tab"
  // observation_boundary = "public-boundary"
  // scope = "context-pane-tab-cycle-handler"
  // lifecycle = "permanent"
  // @end-test-value
  /** 作成したハンドラーから既存のタブ循環を実行できることを確認する。 */
  it("context pane tab cycle handler を作る", () => {
    let activeTab: ContextPaneTabKey = "tasks";
    const cycleTab = createContextPaneTabCycleHandler({
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** タブ移動ハンドラーの更新値を現在のタブへ適用する。 */
      setActiveTab: (updater) => {
        activeTab =
          typeof updater === "function" ? updater(activeTab) : updater;
      },
    });

    cycleTab(-1);

    assert.equal(activeTab, "latest-command");
  });
});

/** 現在選択を保持できない場合だけ別のコンテキストタブを選ぶ処理を検証する。 */
describe("applyUnavailableContextPaneTabFallbackCommand", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "active context pane tabは利用可能なら維持し、利用不可なら利用可能tabへ退避する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "利用不可tabを保持して存在しないpaneを選択する"
  // observable = "available tab集合ごとのsetActiveTab呼出値"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.context-pane"
  // lifecycle = "permanent"
  // distinction = "handlerのfallback projectionをavailable tabの変化で確認する"
  // @end-test-value
  /** 利用可能な現在タブは更新せず、利用不可になった場合だけ有効なタブに移すことを確認する。 */
  it("active tab が利用可能なら維持し、利用不可なら利用可能な tab へ退避する", () => {
    let activeTabs: string[] = [];

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "tasks",
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 今のタブを選べる場合に不要なsetter呼出があれば記録する。 */
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, []);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: ["latest-command", "tasks"] as ContextPaneTabKey[],
      /** 現在のタブを使えない場合に指定された移動先を記録する。 */
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, ["latest-command"]);

    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: "reasoning",
      availableTabs: [] as ContextPaneTabKey[],
      /** 候補が空になった場合に選ばれる退避タブを記録する。 */
      setActiveTab: (tab) => {
        activeTabs = [...activeTabs, tab];
      },
    });
    assert.deepEqual(activeTabs, ["latest-command", "latest-command"]);
  });
});

/** 選択したファイル・フォルダーをComposerへ参照として挿入する前の処理を検証する。 */
describe("applyPickedComposerReferencePathCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "選択pathがある場合だけbase directory更新後にcommandを挿入し、空入力はno-opにする"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "空pathでstateを変更する、またはbase directory更新と挿入の順序を逆にする"
  // observable = "runCommand return valueとbase directory/insert events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.path-command"
  // lifecycle = "permanent"
  // distinction = "入力境界と副作用順序をevent logで直接確認する"
  // @end-test-value
  /** 未選択なら処理をせず、選択時には次の選択起点を先に記録してから参照を挿入することを確認する。 */
  it("選択 path がない場合は何もせず、ある場合は base directory 更新後に挿入する", () => {
    let events: string[] = [];
    /** 同じコマンドに選択パスの有無と参照種別を渡し、実行結果を比較する。 */
    const runCommand = (
      selectedPath: string | null | undefined,
      kind: "file" | "folder" | "image" = "file",
    ) =>
      applyPickedComposerReferencePathCommand({
        kind,
        selectedPath,
        /** 挿入に先立って設定された次回の選択起点を記録する。 */
        setPickerBaseDirectory: (baseDirectory) =>
          events.push(`base:${baseDirectory}`),
        /** 元のパスと選択種別に応じた参照の挿入を記録する。 */
        insertReferencePath: (path, kind) =>
          events.push(`insert:${kind}:${path}`),
      });

    assert.equal(runCommand(null), false);
    assert.equal(runCommand(undefined), false);
    assert.equal(runCommand(""), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand("C:\\workspace\\project\\src\\App.tsx"), true);
    assert.deepEqual(events, [
      "base:C:\\workspace\\project\\src",
      "insert:file:C:\\workspace\\project\\src\\App.tsx",
    ]);

    assert.equal(runCommand("C:\\workspace\\project\\docs", "folder"), true);
    assert.deepEqual(events, [
      "base:C:\\workspace\\project\\src",
      "insert:file:C:\\workspace\\project\\src\\App.tsx",
      "base:C:\\workspace\\project\\docs",
      "insert:folder:C:\\workspace\\project\\docs",
    ]);
  });
});

/** 応答から引用を作れる場合だけ、Composerの内容と選択位置を変更する処理を検証する。 */
describe("applyQuoteMessageTextCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "quoteを挿入できる場合だけstate反映後にfocusとcaretを復元する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "quote不可でも副作用を実行する、または挿入後のfocus/caret復元を失う"
  // observable = "insert resultとeventsのstate/focus/caret sequence"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.quote"
  // lifecycle = "permanent"
  // distinction = "可否分岐とDOM復元callbackの実行順をevent logで確認する"
  // @end-test-value
  /** 引用不能時に何も変更せず、引用を作れる場合は本文を反映してから入力位置へ戻ることを確認する。 */
  it("quote 挿入できない場合は何もせず、できる場合は反映後に focus と caret を復元する", () => {
    let events: string[] = [];
    const textarea = {
      selectionStart: "hello".length,
      /** 引用挿入時にtextareaへフォーカスした時点を記録する。 */
      focus: () => {
        events.push("focus");
      },
      /** 引用の後ろに指定された選択範囲の両端を記録する。 */
      setSelectionRange: (start: number, end: number) => {
        events.push(`selection:${start}:${end}`);
      },
    } as HTMLTextAreaElement;

    assert.equal(
      applyQuoteMessageTextCommand({
        messageText: "   ",
        draft: "hello world",
        fallbackCaret: "hello world".length,
        textarea,
        /** 引用できない内容で下書き更新が起きた場合を検出する。 */
        applyInsertion: ({ draft, caret }) => {
          events = [...events, `apply:${caret}:${draft}`];
        },
        /** 引用できない内容でフォーカスや選択範囲が変更された場合を検出する。 */
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      }),
      false,
    );
    assert.deepEqual(events, []);

    assert.equal(
      applyQuoteMessageTextCommand({
        messageText: "quoted\ntext",
        draft: "hello world",
        fallbackCaret: "hello world".length,
        textarea,
        /** 引用本文と挿入後のキャレットが先に下書きへ適用されたことを記録する。 */
        applyInsertion: ({ draft, caret }) => {
          events = [...events, `apply:${caret}:${draft}`];
        },
        /** 下書きの反映後にtextareaへフォーカスし、引用直後にキャレットを置く。 */
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      }),
      true,
    );

    assert.deepEqual(events, [
      "apply:25:hello\n\n> quoted\n> text\n\n\n world",
      "focus",
      "selection:25:25",
    ]);
  });
});

/** 編集制約と現在のComposer状態を使うメッセージ引用ハンドラーを検証する。 */
describe("createQuoteMessageTextHandler", () => {
  // @test-value v2
  // kind = "security"
  // claim = "blocked時は通知だけでquoteを挿入せず、許可時だけcomposer stateから挿入する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "blocked操作を通す、または許可時に現在のcomposer stateでなく古い入力を使う"
  // observable = "blocked/allowed return valueとfeedback/apply/focus events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.quote"
  // lifecycle = "permanent"
  // impact = "禁止中のcomposer mutationを防ぐ"
  // distinction = "blocked guardと許可時のstate sourceを両方確認する"
  // @end-test-value
  /** ブロックなら通知だけを行い、許可されれば現在の下書きと選択を使って引用することを確認する。 */
  it("blocked の場合は通知だけ行い、許可時は composer state を使って quote を挿入する", () => {
    const events: Array<string> = [];
    const textarea = {
      selectionStart: "hello".length,
      /** 引用後に入力欄へ戻ったタイミングを記録する。 */
      focus: () => {
        events.push("focus");
      },
      /** 引用挿入後に復元されたキャレットを選択の両端で確認できるようにする。 */
      setSelectionRange: (start: number, end: number) => {
        events.push(`selection:${start}:${end}`);
      },
    } as HTMLTextAreaElement;
    let composerState = {
      draft: "hello world",
      fallbackCaret: 0,
      textarea,
    };
    /** 編集可否だけ異なる二つの引用ハンドラーを同じ初期状態から作る。 */
    const createHandler = (blocked: boolean) =>
      createQuoteMessageTextHandler({
        /** ハンドラー実行時に適用される現在の編集制約を返す。 */
        isBlocked: () => blocked,
        /** ブロック中に利用者へ理由を通知したことを記録する。 */
        notifyBlocked: () => events.push("blocked"),
        /** 許可時に読み出される下書きと選択位置を供給する。 */
        getComposerState: () => composerState,
        /** 引用挿入で渡された新しい下書きとキャレットを記録する。 */
        applyInsertion: ({ draft, caret }) =>
          events.push(`apply:${caret}:${draft}`),
        /** 引用を反映してから元の入力欄に戻り、指定位置に選択を揃える。 */
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      });

    assert.equal(createHandler(true)("quoted"), false);
    assert.deepEqual(events, ["blocked"]);

    const allowedHandler = createHandler(false);
    composerState = { ...composerState, draft: "updated composer state" };
    textarea.selectionStart = composerState.draft.length;
    assert.equal(allowedHandler("quoted"), true);
    assert.deepEqual(events, [
      "blocked",
      "apply:34:updated composer state\n\n> quoted\n\n",
      "focus",
      "selection:34:34",
    ]);
  });
});

/** 既存のパス選択をComposer参照として反映するコマンドの検証。 */
describe("applySelectedPathReferenceInsertionCommand", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "選択pathがある場合だけinsert stateを反映し、その後focusとcaretを復元する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts" }
  // fault = "空選択で挿入する、またはstate反映前にfocus/caretを復元する"
  // observable = "runCommand return valueとapply/focus/caret events"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers.path-insert"
  // lifecycle = "permanent"
  // distinction = "空配列と有効pathの副作用差をevent logで確認する"
  // @end-test-value
  /** 選択パスがなければ何もせず、参照の挿入後にフォーカスとキャレットを戻すことを確認する。 */
  it("選択 path がない場合は何もせず、ある場合は挿入 state 反映後に focus と caret を復元する", () => {
    const events: string[] = [];
    const textarea = {
      selectionStart: "see ".length,
      /** 参照挿入に伴うtextareaへのフォーカスを記録する。 */
      focus: () => {
        events.push("focus");
      },
      /** 参照の直後に置いた選択範囲を両端の値で観測する。 */
      setSelectionRange: (start: number, end: number) => {
        events.push(`selection:${start}:${end}`);
      },
    } as HTMLTextAreaElement;
    /** パス選択なしと選択ありの両方を同じ初期下書きで試せるようにする。 */
    const runCommand = (selectedPaths: string[]) =>
      applySelectedPathReferenceInsertionCommand({
        draft: "see here",
        fallbackCaret: "see here".length,
        selectedPaths,
        textarea,
        workspacePath: null,
        /** 参照を反映した下書きと挿入直後の位置を記録する。 */
        applyInsertion: (state) => {
          events.push(`apply:${state.caret}:${state.draft}`);
        },
        /** 挿入済みの本文へフォーカスを戻し、キャレットを挿入の後ろへ移す。 */
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        },
      });

    assert.equal(runCommand([]), false);
    assert.deepEqual(events, []);

    assert.equal(runCommand(["src/App.tsx"]), true);
    assert.deepEqual(events, [
      "apply:17:see @src/App.tsx here",
      "focus",
      "selection:17:17",
    ]);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "textareaがないpath reference挿入でもfallback caretでdraftを更新し、focus復元callbackへnullを渡す"
  // oracle = { type = "contract", ref = "src/chat/shell/session-shell-handlers.ts" }
  // fault = "textarea不在時にpath referenceを挿入できない、caretを誤る、またはfocus復元へ存在しないtextareaを渡す"
  // observable = "apply insertionとrestore callbackのevent列"
  // observation_boundary = "component-behavior"
  // scope = "session-shell-handlers path reference insertion without textarea"
  // lifecycle = "permanent"
  // @end-test-value
  /** 実際のtextareaを取得できない場合でも退避位置に挿入でき、要素なしで復元処理を呼べることを確認する。 */
  it("textarea がない場合は fallback caret で挿入し、focus 復元は no-op にできる", () => {
    const events: string[] = [];

    assert.equal(
      applySelectedPathReferenceInsertionCommand({
        draft: "see here",
        fallbackCaret: "see".length,
        selectedPaths: ["src/App.tsx"],
        textarea: null,
        workspacePath: null,
        /** textareaなしの経路で、退避位置から計算された挿入結果を記録する。 */
        applyInsertion: (state) => {
          events.push(`apply:${state.caret}:${state.draft}`);
        },
        /** textareaに触らず、受け取った復元対象の有無と位置を確かめられるようにする。 */
        restoreComposerTextareaFocusAndCaret: (textarea, caret) => {
          events.push(
            `restore:${textarea === null ? "none" : "textarea"}:${caret}`,
          );
        },
      }),
      true,
    );

    assert.deepEqual(events, [
      "apply:16:see @src/App.tsx here",
      "restore:none:16",
    ]);
  });
});

/** 添付などの参照を指定された表示形式でComposerに反映する処理を検証する。 */
describe("applyComposerReferenceInsertionCommand", () => {
  /** 貼り付け添付の形式で参照を作り、挿入後にキャレットを復元することを確認する。 */
  it("paste attachment の表示形式を保って挿入し、caret を復元する", () => {
    const events: string[] = [];
    const textarea = { selectionStart: 0 } as HTMLTextAreaElement;

    assert.equal(
      applyComposerReferenceInsertionCommand({
        draft: "",
        fallbackCaret: 0,
        references: [
          { path: "C:/session-files/image one.png", presentation: "image" },
          { path: "C:/session-files/note.txt", presentation: "path" },
        ],
        textarea,
        /** 添付参照を含んだ、適用対象の下書きを記録する。 */
        applyInsertion: (state) => events.push(`apply:${state.draft}`),
        /** 添付参照の後ろに戻すキャレットを記録する。 */
        restoreComposerTextareaFocusAndCaret: (_textarea, caret) =>
          events.push(`caret:${caret}`),
      }),
      true,
    );
    assert.deepEqual(events, [
      "apply:![image one.png](C:/session-files/image%20one.png) @C:/session-files/note.txt",
      "caret:77",
    ]);
  });
});

/** Session Filesの元選択と保存後の参照を役割別に扱う処理を検証する。 */
describe("applySessionFilesReferencePathsCommand", () => {
  /** 次回の選択起点は元の選択から求め、本文の参照にはSession Files側のパスを使うことを確認する。 */
  it("元の選択 path から base directory を更新し、挿入 path は referencePaths を使う", () => {
    const events: string[] = [];
    /** 元の選択パスと回答へ挿入する参照を別々に渡して実行する。 */
    const runCommand = (selectedPaths: string[], referencePaths: string[]) =>
      applySessionFilesReferencePathsCommand({
        selectedPaths,
        referencePaths,
        /** 元ファイルの選択に基づいて更新された起点を記録する。 */
        setPickerBaseDirectory: (baseDirectory) =>
          events.push(`base:${baseDirectory}`),
        /** 元パスではなく保存後の参照が挿入されることを観測する。 */
        insertReferencePaths: (paths) =>
          events.push(`insert:${paths.join(",")}`),
      });

    assert.equal(runCommand([], ["session-files/a.txt"]), false);
    assert.equal(runCommand(["C:\\workspace\\a.txt"], []), false);
    assert.deepEqual(events, []);

    assert.equal(
      runCommand(["C:\\workspace\\picked\\a.txt"], ["session-files/a.txt"]),
      true,
    );
    assert.deepEqual(events, [
      "base:C:\\workspace\\picked",
      "insert:session-files/a.txt",
    ]);
  });
});

/** 貼り付けてSession Filesに保存された結果を参照挿入へ渡す処理を検証する。 */
describe("applyPastedSessionAttachmentPathsCommand", () => {
  /** 保存済みパスがない場合は何も挿入せず、ある場合だけまとめて挿入することを確認する。 */
  it("保存済み paste attachment path がある場合だけ挿入する", () => {
    const events: string[] = [];
    /** 空または複数の保存済みパスを同じコマンドへ渡す。 */
    const runCommand = (savedPaths: string[]) =>
      applyPastedSessionAttachmentPathsCommand({
        savedPaths,
        /** 保存済み添付から実際に挿入された参照の順序を記録する。 */
        insertReferencePaths: (paths) =>
          events.push(`insert:${paths.join(",")}`),
      });

    assert.equal(runCommand([]), false);
    assert.deepEqual(events, []);

    assert.equal(
      runCommand(["session-files/a.txt", "session-files/b.png"]),
      true,
    );
    assert.deepEqual(events, [
      "insert:session-files/a.txt,session-files/b.png",
    ]);
  });
});

/** Session Filesを開くAPIの呼出条件と失敗表示を検証する。 */
describe("runSessionFilesOpenCommand", () => {
  /** ID未提供時の無操作、文字列IDの呼出、例外に応じたアラートの違いを確認する。 */
  it("session id がある場合だけ session files action を実行し、失敗時は alert する", async () => {
    const events: string[] = [];
    /** IDの有無とAPIの失敗の種類を指定して同じオープン処理を実行する。 */
    const runCommand = (input: {
      sessionId: string | null | undefined;
      shouldThrow?: unknown;
    }) =>
      runSessionFilesOpenCommand({
        sessionId: input.sessionId,
        /** 実際に渡ったIDを記録し、必要なら指定された値を例外として投げる。 */
        openSessionFiles: async (sessionId) => {
          events.push(`open:${sessionId}`);
          if (input.shouldThrow !== undefined) {
            throw input.shouldThrow;
          }
        },
        /** 通常のエラー理由か既定メッセージか比較できるよう表示内容を記録する。 */
        alertError: (message) => events.push(`alert:${message}`),
        fallbackErrorMessage: "fallback",
      });

    assert.equal(await runCommand({ sessionId: null }), false);
    assert.equal(await runCommand({ sessionId: undefined }), false);
    assert.deepEqual(events, []);

    assert.equal(await runCommand({ sessionId: "" }), true);
    assert.deepEqual(events, ["open:"]);

    assert.equal(await runCommand({ sessionId: "session-1" }), true);
    assert.deepEqual(events, ["open:", "open:session-1"]);

    assert.equal(
      await runCommand({
        sessionId: "session-2",
        shouldThrow: new Error("failed"),
      }),
      false,
    );
    assert.deepEqual(events, [
      "open:",
      "open:session-1",
      "open:session-2",
      "alert:failed",
    ]);

    assert.equal(
      await runCommand({ sessionId: "session-3", shouldThrow: "failed" }),
      false,
    );
    assert.deepEqual(events, [
      "open:",
      "open:session-1",
      "open:session-2",
      "alert:failed",
      "open:session-3",
      "alert:fallback",
    ]);
  });
});

/** Session FilesのオープンAPIを実行時に取得するハンドラーの検証。 */
describe("createSessionFilesOpenHandler", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "Files open handlerはAPI未提供時に何も呼ばず、提供時は現在のSessionを開き、非Error失敗をfallback文言で通知する"
  // oracle = { type = "contract", ref = "src/chat/session-shell-handlers.ts createSessionFilesOpenHandler" }
  // fault = "未提供APIを呼び出す、別Sessionを開く、またはAPIの失敗を成功扱いする"
  // observable = "handlerの成否とopen/alert呼び出し列"
  // observation_boundary = "component-behavior"
  // scope = "createSessionFilesOpenHandler"
  // lifecycle = "permanent"
  // @end-test-value
  /** APIが未提供なら何もせず、後から提供されたAPIは利用して失敗時のアラートにも接続することを確認する。 */
  it("session files open handler を作り、API がない場合は何もしない", async () => {
    let events: string[] = [];
    let openSessionFiles: ((sessionId: string) => Promise<void>) | null = null;
    const openHandler = createSessionFilesOpenHandler({
      /** 開く対象を固定し、APIの有無だけを切り替える。 */
      getSessionId: () => "session-1",
      /** ハンドラー作成後に利用可能になったAPIを実行時に返せるようにする。 */
      getOpenSessionFiles: () => openSessionFiles,
      /** APIの失敗で利用者に提示されたメッセージを記録する。 */
      alertError: (message) => events.push(`alert:${message}`),
      fallbackErrorMessage: "fallback",
    });

    assert.equal(await openHandler(), false);
    assert.deepEqual(events, []);

    openSessionFiles = async (sessionId: string) => {
      events = [...events, `open:${sessionId}`];
    };
    assert.equal(await openHandler(), true);
    assert.deepEqual(events, ["open:session-1"]);

    openSessionFiles = async (sessionId: string) => {
      events = [...events, `open:${sessionId}`];
      throw "failed";
    };
    assert.equal(await openHandler(), false);
    assert.deepEqual(events, [
      "open:session-1",
      "open:session-1",
      "alert:fallback",
    ]);
  });
});
