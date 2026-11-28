import type {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  MessageBoxOptions,
} from "electron";
import {
  getSessionIncarnationId,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import type { HomeCrewContextMenuRequest } from "../../src-shared/window/home-crew-types.js";
import type { SessionMonitorContextMenuResult } from "../../src-shared/window/withmate-window-types.js";
import type {
  SessionWindowBridge,
  SessionWindowLike,
} from "../windows/session-window-bridge.js";

/** メニューで Session の現在の表示名と保存済みの Crew・親・世代を照合するための最小要約。 */
type CrewSession = Pick<
  SessionSummary,
  "id" | "incarnationId" | "rootSessionId" | "parentSessionId" | "taskTitle"
>;
/** Window を閉じる時点の実行と端末の識別情報。確認の要否を端末ごとに保持する。 */
type CloseEffects = {
  runs: readonly object[];
  terminals: readonly { identity: object; requiresConfirmation: boolean }[];
};
/** 対象の保存済み Session と、閉じる操作ができる特定 Window の組。 */
type Target<TWindow> = {
  window: TWindow;
  sessionId: string;
  title: string;
  incarnationId: string;
};

/** 保存関係と Window の照合、閉じる影響の確認、ネイティブ UI を提供する境界。 */
type HomeCrewMenuDeps<
  TWindow extends SessionWindowLike,
  TOwner extends object,
> = {
  /** 非同期読取後も同じストアであるか確認するため、現在の所有者を取得する。 */
  getStoreOwner(): TOwner | null;
  /** 現在の Crew の関係を検証するため、Session 一覧のスナップショットを取得する。 */
  listSessions(): readonly CrewSession[];
  /** 指定ストアから最新の保存済み Session を読む。見つからなければ null。 */
  readSavedSession(
    owner: TOwner,
    sessionId: string,
  ): Promise<CrewSession | null>;
  bridge: Pick<
    SessionWindowBridge<TWindow>,
    | "getWindow"
    | "getWindowIncarnation"
    | "listOpenSessionWindowIds"
    | "requestCloseSessionWindow"
    | "closeHomeCrewDescendantWindow"
  >;
  /** 指定 Window の現在の実行と端末の実体・確認条件を取り出す。 */
  getCloseEffects(sessionId: string, window: TWindow): CloseEffects;
  /** 一括操作の影響を通知し、利用者が実際に閉じることを選んだ場合だけ true を返す。 */
  confirm(home: BrowserWindow, options: MessageBoxOptions): Promise<boolean>;
  /** 表示項目から Home 用のネイティブメニューを作る。 */
  buildMenu(template: MenuItemConstructorOptions[]): Pick<Menu, "popup">;
  /** 選ばれた ID やタイトルをクリップボードに書く。 */
  writeText(value: string): void;
};

const menuFailed = "Home Crew menu action could not be completed.";
const memberChanged = "The Session changed. Reload the Crew and try again.";
const windowsChanged =
  "Descendant Windows changed. Review the Crew and try again.";
const effectsChanged =
  "Session or terminal activity changed. Review the Crew and try again.";

/** Home Crew の選択を保存済み世代と照合し、単体・子孫 Window を閉じる操作とコピーを扱う。 */
export class HomeCrewContextMenuService<
  TWindow extends SessionWindowLike,
  TOwner extends object,
> {
  /** ストア・Window 操作と、入力確認やメニューを表示するネイティブ境界を受け取る。 */
  constructor(private readonly deps: HomeCrewMenuDeps<TWindow, TOwner>) {}

  /** 保存先と選択項目が現在も一致するときにだけ、指定 Home Window の座標でメニューを開く。 */
  async show(
    home: BrowserWindow,
    request: HomeCrewContextMenuRequest,
  ): Promise<SessionMonitorContextMenuResult> {
    const owner = this.deps.getStoreOwner();
    if (!owner) return { status: "failed", message: menuFailed };
    /** 確認中にストアが切り替わったり Home Window が破棄されたりしていないことを確かめる。 */
    const isCurrent = () =>
      this.deps.getStoreOwner() === owner && !home.isDestroyed();
    /** 選択された世代の Session を保存先から読み、現在の表示一覧にも同じ世代がある場合だけ返す。 */
    const readSelection = async () => {
      const saved = await this.deps.readSavedSession(owner, request.sessionId);
      if (
        !isCurrent() ||
        !saved ||
        getSessionIncarnationId(saved) !== request.incarnationId
      )
        return null;
      const current = this.deps
        .listSessions()
        .find(({ id }) => id === request.sessionId);
      return current &&
        getSessionIncarnationId(current) === request.incarnationId
        ? saved
        : null;
    };
    /** 同じ ID でも世代が異なる Window は、閉じる対象にしない。 */
    const selectedWindow = () => {
      const window = this.deps.bridge.getWindow(request.sessionId);
      return window &&
        this.deps.bridge.getWindowIncarnation(window) === request.incarnationId
        ? window
        : null;
    };

    try {
      const selection = await readSelection();
      if (!selection) return { status: "failed", message: memberChanged };
      return await new Promise<SessionMonitorContextMenuResult>((resolve) => {
        let settled = false;
        let selected = false;
        /** 閉じる通知と操作の終了が競合しても、最初の結果だけをメニュー呼び出し元へ返す。 */
        const finish = (result: SessionMonitorContextMenuResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        /** 最初に選択された操作だけを開始し、例外はメニューの失敗結果にする。 */
        const choose =
          (action: () => Promise<SessionMonitorContextMenuResult>) => () => {
            if (selected || settled) return;
            selected = true;
            void action().then(finish, () =>
              finish({ status: "failed", message: menuFailed }),
            );
          };
        /** クリック時に保存内容を再確認してから、指定された値をコピーする項目を作る。 */
        const copy = (value: (session: CrewSession) => string) =>
          choose(async () => {
            const current = await readSelection();
            if (!current) return { status: "failed", message: memberChanged };
            this.deps.writeText(value(current));
            return { status: "copied" };
          });

        const menu = this.deps.buildMenu([
          {
            label: "Close",
            enabled: selectedWindow() !== null,
            click: choose(async () => {
              const window = selectedWindow();
              if (!(await readSelection()))
                return { status: "failed", message: memberChanged };
              const closed =
                window &&
                window === selectedWindow() &&
                (await this.deps.bridge.requestCloseSessionWindow(
                  request.sessionId,
                ));
              return { status: closed ? "closed" : "dismissed" };
            }),
          },
          {
            label: "Close Descendant Windows",
            enabled: this.listDescendantWindows(selection).length > 0,
            click: choose(() =>
              this.closeDescendants(home, selection, readSelection, isCurrent),
            ),
          },
          { type: "separator" },
          { label: "Copy Session ID", click: copy(({ id }) => id) },
          {
            label: "Copy Session Title",
            click: copy(({ taskTitle }) => taskTitle),
          },
        ]);
        menu.popup({
          window: home,
          x: request.point.x,
          y: request.point.y,
          /** 利用者が操作を選ばずにメニューを閉じた場合だけ、操作なしとして返す。 */
          callback: () => {
            if (!selected) finish({ status: "dismissed" });
          },
        });
      });
    } catch {
      return { status: "failed", message: menuFailed };
    }
  }

  /** 親の連鎖と Crew 所属をたどって開いている子孫だけを集め、関係や Window の世代を確認できなければ拒否する。 */
  private listDescendantWindows(selection: CrewSession): Target<TWindow>[] {
    const sessions = new Map(
      this.deps.listSessions().map((entry) => [entry.id, entry]),
    );
    const targets: Target<TWindow>[] = [];
    for (const id of this.deps.bridge.listOpenSessionWindowIds()) {
      if (id === selection.id) continue;
      const window = this.deps.bridge.getWindow(id);
      if (!window) continue;
      const windowIncarnation = this.deps.bridge.getWindowIncarnation(window);
      const session = sessions.get(id);
      // 保存済みの関係がない場合、開いている Window を安全に分類できない。
      if (!session) {
        if (windowIncarnation) throw new Error(windowsChanged);
        continue;
      }
      if (session.rootSessionId !== selection.rootSessionId) continue;
      const visited = new Set([id]);
      let parentId = session.parentSessionId;
      while (parentId && parentId !== selection.id) {
        if (visited.has(parentId)) throw new Error(windowsChanged);
        visited.add(parentId);
        const parent = sessions.get(parentId);
        if (!parent || parent.rootSessionId !== selection.rootSessionId)
          throw new Error(windowsChanged);
        parentId = parent.parentSessionId;
      }
      if (parentId !== selection.id) continue;
      const incarnationId = getSessionIncarnationId(session);
      if (windowIncarnation !== incarnationId) throw new Error(windowsChanged);
      targets.push({
        sessionId: id,
        title: session.taskTitle,
        incarnationId,
        window,
      });
    }
    return targets;
  }

  /** 選んだ時点の子孫 Window と影響範囲のスナップショットで確認を取り、各 Window を閉じる直前にも変化を照合する。 */
  private async closeDescendants(
    home: BrowserWindow,
    selection: CrewSession,
    readSelection: () => Promise<CrewSession | null>,
    isCurrent: () => boolean,
  ): Promise<SessionMonitorContextMenuResult> {
    // ストレージの読み取りやモーダルの待機に入る前に、ネイティブメニューのクリックコールバックで対象を取得する。
    const targets = this.listDescendantWindows(selection);
    if (!targets.length)
      return { status: "failed", message: "No descendant Windows are open." };
    const batch = new Map(
      targets.map((target) => [
        target.sessionId,
        {
          ...target,
          effects: this.deps.getCloseEffects(target.sessionId, target.window),
        },
      ]),
    );
    const approvedEffects = [...batch.values()].map(({ effects }) => effects);
    const runningWindows = approvedEffects.filter(
      ({ runs }) => runs.length > 0,
    ).length;
    const terminals = approvedEffects.reduce(
      (count, effects) => count + effects.terminals.length,
      0,
    );
    const needsConfirmation =
      runningWindows > 0 ||
      approvedEffects.some((effects) =>
        effects.terminals.some((terminal) => terminal.requiresConfirmation),
      );
    const attempted = new Set<TWindow>();
    const closed = new Set<TWindow>();
    /** 実際に閉じた・既に閉じていた・残っている・未試行を分け、途中で止まった理由を添える。 */
    const failure = (reason: string): SessionMonitorContextMenuResult => {
      const remaining = targets.filter(({ window }) => !window.isDestroyed());
      const alreadyClosed = targets.length - closed.size - remaining.length;
      const unattempted = remaining.filter(
        ({ window }) => !attempted.has(window),
      ).length;
      return {
        status: "failed",
        message: `${closed.size} closed · ${remaining.length} remaining (${unattempted} not attempted) · ${alreadyClosed} already closed. ${reason}`,
      };
    };
    /** 対象の差し替え、新しい Window、確認した範囲を超える実行や端末の変化を検出したら続行しない。 */
    const checkBatch = (candidate?: Target<TWindow>): string | null => {
      const currentSelection = this.deps
        .listSessions()
        .find(({ id }) => id === selection.id);
      if (
        !isCurrent() ||
        !currentSelection ||
        getSessionIncarnationId(currentSelection) !==
          getSessionIncarnationId(selection)
      )
        return memberChanged;
      try {
        const current = this.listDescendantWindows(currentSelection);
        if (
          candidate &&
          !current.some(({ window }) => window === candidate.window)
        )
          return windowsChanged;
        for (const target of current) {
          const planned = batch.get(target.sessionId);
          if (
            !planned ||
            planned.window !== target.window ||
            planned.incarnationId !== target.incarnationId
          )
            return windowsChanged;
          const live = this.deps.getCloseEffects(
            target.sessionId,
            target.window,
          );
          if (
            live.runs.some((run) => !planned.effects.runs.includes(run)) ||
            live.terminals.some(
              (terminal) =>
                !planned.effects.terminals.some(
                  (approved) =>
                    approved.identity === terminal.identity &&
                    (approved.requiresConfirmation ||
                      !terminal.requiresConfirmation),
                ),
            )
          ) {
            return effectsChanged;
          }
        }
        return null;
      } catch {
        return windowsChanged;
      }
    };

    try {
      if (!(await readSelection())) return failure(memberChanged);
      let conflict = checkBatch();
      if (conflict) return failure(conflict);
      if (needsConfirmation) {
        const detail = [
          targets
            .map(({ title }) => title.replace(/[\r\n\u2028\u2029]+/g, " "))
            .join("\n"),
        ];
        if (runningWindows)
          detail.push(
            `Runs Will Continue: ${runningWindows} ${runningWindows === 1 ? "Window" : "Windows"}`,
          );
        if (terminals) detail.push(`Terminals Will Stop: ${terminals}`);
        if (
          !(await this.deps.confirm(home, {
            message: "Close Descendant Windows?",
            detail: detail.join("\n\n"),
            type: "warning",
            buttons: [
              "Cancel",
              `Close ${targets.length} ${targets.length === 1 ? "Window" : "Windows"}`,
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          }))
        )
          return { status: "dismissed" };
        conflict = checkBatch();
        if (conflict) return failure(conflict);
      }
      for (const target of targets) {
        if (target.window.isDestroyed()) continue;
        conflict = checkBatch(target);
        if (conflict) return failure(conflict);
        attempted.add(target.window);
        const outcome = await this.deps.bridge.closeHomeCrewDescendantWindow(
          target.sessionId,
          target.window,
          () => {
            // ブリッジは最終的な close/destroy と同じ同期処理内で、このチェックをもう一度実行する。
            conflict = checkBatch(target);
            return !conflict;
          },
        );
        if (outcome === "blocked")
          return failure(conflict ?? "A Window could not be closed.");
        if (outcome === "closed") closed.add(target.window);
      }
      return closed.size === targets.length
        ? { status: "closed" }
        : failure("Some Windows were already closed.");
    } catch {
      return failure(
        "A Window or its activity could not be verified or closed.",
      );
    }
  }
}
