import type { DatabaseSync } from "node:sqlite";
import {
  assertFullConversation,
  conversationMessageColumns,
  readConversationPage,
  readConversationQuerySnapshot,
  readConversationQueryBatch,
  type ConversationMutationSink,
  type ConversationQueryRow,
} from "../storage/conversation-query.js";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import type { ConversationPageRequest } from "../../src-shared/session/conversation-page.js";
import type {
  SessionHistoryReadInput,
  SessionHistoryResult,
} from "../../src-shared/session-history/session-history-contract.js";
import { readSessionHistory } from "../storage/session-history-read.js";
import { randomUUID } from "node:crypto";
import { validateSessionMetadataPatch } from "../../src-shared/session/session-metadata.js";
import { acquireCoordinationAnswer } from "../coordination/coordination-dispatch.js";

import {
  normalizeAuxiliarySession,
  projectAuxiliarySessionSummary,
  buildAuxiliaryPreview,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  isReadOnlySession,
} from "../../src-shared/session/session-state.js";
import {
  normalizeMessage,
  summarizeMessageArtifact,
  type Message,
  type MessageArtifact,
  type TurnInputMetadata,
  type TurnInputDeliveryState,
} from "../../src-shared/session/session-state.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import {
  writeSessionTurnTerminalCommit,
  type SessionTurnTerminalCommit,
} from "../session/session-turn-terminal-commit.js";
import type { ProviderRuntimeMetadataPatch } from "../providers/provider-runtime-metadata-patch.js";
import { insertSessionTurn } from "../session/session-turn-storage-v6.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import type { SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import { assertCharacterDefinitionSnapshotUpdate } from "../session/session-running-turn-start.js";
import type {
  AuxiliaryDraftConsumeInput,
  AuxiliaryDraftConsumeResult,
  AuxiliaryDraftAck,
  AuxiliaryDraftRecord,
  AuxiliaryDraftSaveInput,
  AuxiliaryDraftSaveResult,
  AuxiliarySessionStatus,
} from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

/** 保存対象の親・下書き世代・期待リビジョンを指定する、Auxiliary の下書き保存入力。 */
export type AuxiliaryDraftStorageSaveInput = AuxiliaryDraftSaveInput;
/** 下書き消費に使う入力。実行中の入力として許可された場合だけ、稼働中の対象も扱える。 */
export type AuxiliaryDraftStorageConsumeInput = AuxiliaryDraftConsumeInput & {
  allowRunningInput?: boolean;
};

/** Auxiliary の識別、実行設定、表示用メタデータを取得する SQLite 行。 */
type AuxiliarySessionRow = {
  id: string;
  parent_session_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  run_state: "idle" | "running" | "error";
  preview: string;
  provider_id: string;
  catalog_revision: number;
  model_id: string;
  reasoning_effort: string;
  approval_mode: string;
  codex_sandbox_mode: string;
  codex_speed: string;
  codex_reviewer: string;
  withmate_reviewer_explicit: number;
  custom_agent_name: string;
  thread_id: string;
  display_after_message_index: number | null;
  character_id: string | null;
  character_snapshot_json: string | null;
  character_snapshot_invalid: number;
  character_icon_path: string | null;
  client_request_id: string | null;
  creation_context_json: string | null;
  creation_request_json: string | null;
};

/** 会話本文を持たない概要行に、下書き込みの更新順と公開用 Character 項目を加えた投影。 */
export type AuxiliarySessionSummaryRow = AuxiliarySessionRow & {
  effective_updated_at?: string;
  character_description?: string;
  character_name?: string;
};

/** 親と下書きの世代、リビジョン、本文を独立して保持する保存行。 */
type AuxiliaryDraftRow = {
  id: string;
  parent_session_id: string;
  incarnation: string;
  durable_revision: number;
  draft_text: string;
  updated_at: string;
};

/** 親 Session を照合に使う Auxiliary のメタデータ行。 */
type ScopedAuxiliarySessionRow = AuxiliarySessionRow & {
  parent_session_id: string;
};

/** 親・作成時刻・プロバイダーと期待するスレッドを照合して、スレッドだけを更新する入力。 */
export type AuxiliarySessionThreadPatchInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  provider: string;
  expectedThreadId: string;
  nextThreadId: string;
  updatedAt: string;
  createdAt: string;
};

/** 期待する実行設定とスレッドから、新しいランタイムメタデータへ置き換えるための所有者付き入力。 */
export type AuxiliarySessionRuntimeMetadataPatchInput =
  ProviderRuntimeMetadataPatch & {
    auxiliarySessionId: string;
    parentSessionId: string;
    createdAt: string;
  };

/** 現在の保存値と照合する完全な Session と、保存したい完全な Session の組。 */
export type AuxiliarySessionUpdateIfMatchesInput = {
  session: AuxiliarySession;
  expectedSession: AuxiliarySession;
};

/** 親・作成時刻・会話件数を前提に、Auxiliary の実行をインクリメンタルに保存する共通入力。 */
export type AuxiliaryRuntimeWriteInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
  expectedMessageCount: number;
  updatedAt: string;
};
/** 開始時の利用者メッセージと、指定時に同時確定するキュー済み Turn・Character 定義。 */
export type AuxiliaryRunningTurnStartInput = AuxiliaryRuntimeWriteInput & {
  userMessage: Message;
  characterRuntimeSnapshot?: AuxiliarySession["characterRuntimeSnapshot"];
  queuedTurn?: { queueId: string; turn: SessionTurnInput };
};
/** 現在の Turn にユーザー入力を追記する入力。キューからの入力ならその受領記録も照合する。 */
export type AuxiliarySteerAppendInput = AuxiliaryRuntimeWriteInput & {
  turnId: number;
  userMessage: Message;
  queuedInput?: { queueId: string; inputTurnId: string };
};
/** 直接の Steer を保留状態で保存するための、プロバイダー側識別子と添付を含む入力。 */
export type AuxiliarySteerBeginInput = AuxiliarySteerAppendInput &
  Pick<TurnInputMetadata, "nativeTurnId" | "attachments">;
/** 直接の Steer のメッセージ位置と、確定した配送状態を指定する入力。 */
export type AuxiliarySteerSettleInput = AuxiliaryRuntimeWriteInput & {
  turnId: number;
  messageSeq: number;
  state: Exclude<TurnInputDeliveryState, "pending">;
};
/** アシスタント応答、Session 継続用の状態とスレッド、Turn 終端を一緒に保存する入力。 */
export type AuxiliaryTerminalAppendInput = AuxiliaryRuntimeWriteInput & {
  assistantMessage: Message;
  runState: AuxiliarySession["runState"];
  threadId: string;
  preview: string;
  terminalCommit: SessionTurnTerminalCommit;
};

/** 会話を置き換えずに更新するため、対象と親の ID・対象の作成時刻を照合する入力。 */
export type AuxiliaryIdentityPatchInput = {
  auxiliarySessionId: string;
  parentSessionId: string;
  createdAt: string;
  updatedAt: string;
};

/** Auxiliary に固有のプロバイダー、モデル、承認・実行環境の保存項目。 */
export type AuxiliaryExecutionOptions = Pick<
  AuxiliarySession,
  | "provider"
  | "model"
  | "reasoningEffort"
  | "approvalMode"
  | "codexSandboxMode"
  | "codexSpeed"
  | "codexReviewer"
  | "withMateReviewerExplicit"
  | "customAgentName"
>;

/** 認証変更の対象となる Auxiliary とスレッドを、会話なしで特定できる項目。 */
export type AuxiliaryCredentialThreadInfo = Pick<
  AuxiliarySession,
  "id" | "parentSessionId" | "createdAt" | "provider" | "threadId" | "runState"
>;
/** スレッド変更後に親の表示を更新するための、対象・親と確定スレッド。 */
export type AuxiliaryThreadPatchResult = Pick<
  AuxiliarySession,
  "id" | "parentSessionId" | "threadId"
>;
/** ランタイムメタデータ更新後の、対象と確定した実行設定・スレッドの投影。 */
export type AuxiliaryRuntimeMetadataPatchResult = Pick<
  AuxiliarySession,
  | "id"
  | "parentSessionId"
  | "createdAt"
  | "provider"
  | "catalogRevision"
  | "model"
  | "reasoningEffort"
  | "threadId"
  | "updatedAt"
>;

/** スキーマ初期化で列の有無を調べるために SQLite から取得する列名。 */
type TableInfoRow = {
  name: string;
};

const CREATE_AUXILIARY_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'running', 'error')),
    preview TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT 'codex',
    catalog_revision INTEGER NOT NULL DEFAULT 1,
    model_id TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT 'medium',
    approval_mode TEXT NOT NULL DEFAULT '',
    codex_sandbox_mode TEXT NOT NULL DEFAULT '',
    codex_speed TEXT NOT NULL DEFAULT '',
    codex_reviewer TEXT NOT NULL DEFAULT '',
    withmate_reviewer_explicit INTEGER NOT NULL DEFAULT 0 CHECK (withmate_reviewer_explicit IN (0, 1)),
    custom_agent_name TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    display_after_message_index INTEGER,
    character_id TEXT,
    character_snapshot_json TEXT,
    character_snapshot_invalid INTEGER NOT NULL DEFAULT 0,
    character_icon_path TEXT,
    client_request_id TEXT,
    creation_context_json TEXT,
    creation_request_json TEXT
  )
`;

const CREATE_AUXILIARY_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_session_messages (
    auxiliary_session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    body TEXT NOT NULL CHECK (json_valid(body)),
    artifact_body TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (auxiliary_session_id, seq),
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE CASCADE
  )
`;

/** 対象所有者と一致する有効な Character スナップショットからだけ、公開用の説明を取り出す SQL 式。 */
export const AUXILIARY_PUBLIC_CHARACTER_DESCRIPTION = `CASE WHEN json_valid(a.character_snapshot_json) THEN CASE WHEN a.character_snapshot_invalid = 0 AND json_extract(a.character_snapshot_json, '$.characterId') = a.character_id
  THEN json_extract(a.character_snapshot_json, '$.description') ELSE '' END ELSE '' END`;
/** 対象所有者と一致する有効な Character スナップショットからだけ、公開用の名前を取り出す SQL 式。 */
export const AUXILIARY_PUBLIC_CHARACTER_NAME = `CASE WHEN json_valid(a.character_snapshot_json) THEN CASE WHEN a.character_snapshot_invalid = 0 AND json_extract(a.character_snapshot_json, '$.characterId') = a.character_id
  THEN json_extract(a.character_snapshot_json, '$.name') ELSE '' END ELSE '' END`;
/** 一覧に必要な Auxiliary メタデータだけを選び、定義本文や作成要求の JSON を含めない列一覧。 */
export const AUXILIARY_SUMMARY_COLUMNS = `a.id, a.parent_session_id, a.created_at, a.updated_at,
  a.title, a.description, a.run_state, a.preview, a.provider_id, a.catalog_revision, a.model_id,
  a.reasoning_effort, a.approval_mode, a.codex_sandbox_mode, a.codex_speed,
  a.codex_reviewer, a.withmate_reviewer_explicit, a.custom_agent_name,
  a.thread_id, a.display_after_message_index, a.character_id,
  NULL AS character_snapshot_json, 0 AS character_snapshot_invalid, a.character_icon_path,
  ${AUXILIARY_PUBLIC_CHARACTER_DESCRIPTION} AS character_description,
  ${AUXILIARY_PUBLIC_CHARACTER_NAME} AS character_name,
  a.client_request_id, NULL AS creation_context_json, NULL AS creation_request_json`;

const CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
    ON auxiliary_sessions(parent_session_id, updated_at DESC)
`;

const CREATE_AUXILIARY_SESSION_DRAFTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_session_drafts (
    auxiliary_session_id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    durable_revision INTEGER NOT NULL DEFAULT 0,
    draft_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )
`;

/** Auxiliary の会話・メタデータ・下書きを別々に保持し、所有者と現在の状態に応じた永続操作を提供する。 */
export class AuxiliarySessionStorage {
  private db: DatabaseSync | null;

  /** ストレージの接続を開いてスキーマを準備する。初期化が失敗した場合は接続を残さない。 */
  constructor(
    dbPath: string,
    private readonly onConversationChanged: ConversationMutationSink = () => {},
  ) {
    this.db = openAppDatabase(dbPath);
    try {
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }
  }

  /** Auxiliary 保存用の接続を閉じ、以降はこのインスタンスで読み書きできない状態にする。 */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** 全 Auxiliary の履歴と最近保存した下書きを合成し、更新時刻の新しい順に返す。 */
  listAllAuxiliarySessions(): AuxiliarySession[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
        SELECT a.*
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `,
        )
        .all() as AuxiliarySessionRow[];
      return rows
        .map((row) => readAuxiliarySession(db, row))
        .map((session) => (session ? this.composeDraft(db, session) : null))
        .filter((session): session is AuxiliarySession => session !== null);
    });
  }

  /** 指定した親だけの軽量な概要を、下書きも考慮した更新時刻順で返す。 */
  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ?
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `,
        )
        .all(parentSessionId) as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter(
          (summary): summary is AuxiliarySessionSummary => summary !== null,
        );
    });
  }

  /** 指定された複数の親について、会話本文を読まず、親別・更新の古い順で概要を返す。 */
  listAuxiliarySessionSummaries(
    parentSessionIds: readonly string[],
  ): AuxiliarySessionSummary[] {
    const normalizedParentSessionIds = Array.from(
      new Set(
        parentSessionIds
          .map((parentSessionId) => parentSessionId.trim())
          .filter(Boolean),
      ),
    );
    if (normalizedParentSessionIds.length === 0) {
      return [];
    }

    return this.withDb((db) => {
      const placeholders = normalizedParentSessionIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id IN (${placeholders})
        ORDER BY a.parent_session_id ASC, MAX(d.updated_at, a.updated_at) ASC, a.id ASC
      `,
        )
        .all(...normalizedParentSessionIds) as AuxiliarySessionSummaryRow[];
      return rows.flatMap((row) => {
        const summary = parseAuxiliarySessionSummaryRow(row);
        if (!summary || summary.parentSessionId !== row.parent_session_id) {
          return [];
        }
        return [summary];
      });
    });
  }

  /** 保存済みの稼働状態が実行中の Auxiliary に絞って概要を返す。 */
  listRunningAuxiliarySessions(): AuxiliarySessionSummary[] {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
        SELECT ${AUXILIARY_SUMMARY_COLUMNS}, MAX(d.updated_at, a.updated_at) AS effective_updated_at
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
      `,
        )
        .all() as AuxiliarySessionSummaryRow[];
      return rows
        .map(parseAuxiliarySessionSummaryRow)
        .filter(
          (session): session is AuxiliarySessionSummary =>
            session?.runState === "running",
        );
    });
  }

  /** 指定した親のうち、下書きも含め最近更新された Auxiliary を一つ、全履歴付きで返す。 */
  getLatestAuxiliarySession(parentSessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
        SELECT a.*
        FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ?
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC
        LIMIT 1
      `,
        )
        .get(parentSessionId) as AuxiliarySessionRow | undefined;
      const session = row ? readAuxiliarySession(db, row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
  }

  /** 指定 Auxiliary の全履歴と現在の下書きを合成する。見つからなければ null。 */
  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
        SELECT *
        FROM auxiliary_sessions
        WHERE id = ?
      `,
        )
        .get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      const session = row ? readAuxiliarySession(db, row) : null;
      return session ? this.composeDraft(db, session) : null;
    });
  }

  /** 履歴の本文は取得せず、Auxiliary のメタデータと会話件数を返す。 */
  getAuxiliarySessionMetadata(
    auxiliarySessionId: string,
  ): AuxiliarySession | null {
    return this.withDb((db) => readAuxiliaryMetadata(db, auxiliarySessionId));
  }

  /** ユーザー入力と実行開始を保存する。キュー由来の場合は受領記録と Turn 行も同じトランザクションで確定する。 */
  appendAuxiliaryRunningTurnStart(
    input: AuxiliaryRunningTurnStartInput,
  ): (AuxiliarySession & { queuedTurn?: SessionTurnRecord }) | null {
    let queuedTurn: SessionTurnRecord | undefined;
    const result = this.writeRuntime(
      input,
      (db, current) => {
        if (
          current.runState === "running" ||
          input.userMessage.role !== "user" ||
          !input.userMessage.text.trim()
        )
          return false;
        assertCharacterDefinitionSnapshotUpdate(
          current.characterRuntimeSnapshot,
          input.characterRuntimeSnapshot,
          current.characterId ??
            input.characterRuntimeSnapshot?.characterId ??
            "",
        );
        if (input.queuedTurn) {
          const row = db
            .prepare(
              `SELECT dispatched_json AS captured_json FROM session_turn_queue_v6 WHERE id = ?
          AND session_id = ? AND auxiliary_session_id = ? AND incarnation_id = ? AND state = 'starting' AND input_turn_id IS NULL AND dispatched_json IS NOT NULL`,
            )
            .get(
              input.queuedTurn.queueId,
              current.parentSessionId,
              current.id,
              current.createdAt,
            ) as { captured_json: string } | undefined;
          if (!row)
            throw new Error("The Auxiliary queued turn is not starting.");
          const captured = JSON.parse(
            row.captured_json,
          ) as SessionTurnQueueCapturedInput;
          const turn = input.queuedTurn.turn;
          if (
            captured.request.userMessage !== input.userMessage.text ||
            turn.sessionId !== current.id ||
            turn.phase !== "running" ||
            turn.userMessageSeq !== input.expectedMessageCount ||
            turn.assistantMessageSeq !== undefined ||
            turn.completedAt !== undefined ||
            turn.provider !== captured.provider ||
            turn.model !== captured.request.executionOptions.model ||
            turn.reasoningEffort !==
              captured.request.executionOptions.reasoningEffort ||
            turn.approvalMode !==
              captured.request.executionOptions.approvalMode ||
            turn.sandboxMode !==
              captured.request.executionOptions.codexSandboxMode
          ) {
            throw new Error(
              "The Auxiliary queued turn does not match its captured request.",
            );
          }
          acquireCoordinationAnswer(db, captured, {
            kind: "auxiliary",
            sessionId: current.id,
            incarnationId: current.createdAt,
          });
          queuedTurn = insertSessionTurn(
            db,
            { sessionId: null, auxiliarySessionId: current.id },
            turn,
          );
          const result = db
            .prepare(
              `UPDATE session_turn_queue_v6 SET state = 'running', turn_id = ?, user_message_seq = ?, updated_at = ?
          WHERE id = ? AND state = 'starting' AND input_turn_id IS NULL`,
            )
            .run(
              String(queuedTurn.id),
              input.expectedMessageCount,
              input.updatedAt,
              input.queuedTurn.queueId,
            );
          if (Number(result.changes) !== 1)
            throw new Error(
              "The Auxiliary queued turn could not be committed.",
            );
        }
        insertAuxiliaryMessage(
          db,
          current.id,
          input.expectedMessageCount,
          input.userMessage,
          input.updatedAt,
        );
        db.prepare(
          `UPDATE auxiliary_sessions SET run_state = 'running',
        character_id = COALESCE(character_id, ?), character_snapshot_json = ?, preview = ?, updated_at = ? WHERE id = ?`,
        ).run(
          input.characterRuntimeSnapshot?.characterId ?? null,
          input.characterRuntimeSnapshot === undefined
            ? current.characterRuntimeSnapshot
              ? JSON.stringify(current.characterRuntimeSnapshot)
              : null
            : input.characterRuntimeSnapshot === null
              ? null
              : JSON.stringify(input.characterRuntimeSnapshot),
          current.preview || buildAuxiliaryPreview([input.userMessage]),
          input.updatedAt,
          current.id,
        );
        return true;
      },
      true,
    );
    return result ? { ...result, ...(queuedTurn ? { queuedTurn } : {}) } : null;
  }

  /** 現在の実行中 Turn に追加入力を保存し、キュー由来の入力なら対応する受領記録の完了も同時に確定する。 */
  appendAuxiliarySteer(
    input: AuxiliarySteerAppendInput,
  ): AuxiliarySession | null {
    return this.writeRuntime(
      input,
      (db, current) => {
        if (
          current.runState !== "running" ||
          input.userMessage.role !== "user" ||
          !input.userMessage.text.trim() ||
          !db
            .prepare(
              `SELECT id FROM session_turns_v6 WHERE id = ? AND session_id IS NULL
          AND auxiliary_session_id = ? AND phase = 'running' AND id = (SELECT MAX(id) FROM session_turns_v6 WHERE auxiliary_session_id = ?)`,
            )
            .get(input.turnId, current.id, current.id)
        )
          return false;
        let message = input.userMessage;
        if (input.queuedInput) {
          const receipt = db
            .prepare(
              `SELECT dispatched_json AS captured_json FROM session_turn_queue_v6 WHERE id = ?
          AND session_id = ? AND auxiliary_session_id = ? AND incarnation_id = ?
          AND state = 'starting' AND input_turn_id = ? AND user_message_seq IS NULL AND turn_id = ? AND dispatched_json IS NOT NULL`,
            )
            .get(
              input.queuedInput.queueId,
              current.parentSessionId,
              current.id,
              current.createdAt,
              input.queuedInput.inputTurnId,
              String(input.turnId),
            ) as { captured_json: string } | undefined;
          const captured = receipt
            ? (JSON.parse(
                receipt.captured_json,
              ) as SessionTurnQueueCapturedInput)
            : null;
          if (
            !captured ||
            captured.request.userMessage !== input.userMessage.text
          ) {
            throw new Error(
              "The Auxiliary queued input does not match its captured message.",
            );
          }
          acquireCoordinationAnswer(db, captured, {
            kind: "auxiliary",
            sessionId: current.id,
            incarnationId: current.createdAt,
          });
          message = {
            ...message,
            turnInput: {
              turnId: String(input.turnId),
              nativeTurnId: input.queuedInput.inputTurnId,
              state: "confirmed",
              queueId: input.queuedInput.queueId,
              attachments: captured.attachments,
            },
          };
        }
        insertAuxiliaryMessage(
          db,
          current.id,
          input.expectedMessageCount,
          message,
          input.updatedAt,
        );
        if (input.queuedInput) {
          const result = db
            .prepare(
              `UPDATE session_turn_queue_v6 SET state = 'completed', turn_id = ?, user_message_seq = ?, updated_at = ?
          WHERE id = ? AND state = 'starting' AND input_turn_id = ?`,
            )
            .run(
              String(input.turnId),
              input.expectedMessageCount,
              input.updatedAt,
              input.queuedInput.queueId,
              input.queuedInput.inputTurnId,
            );
          if (Number(result.changes) !== 1)
            throw new Error(
              "The Auxiliary queued input could not be committed.",
            );
        }
        db.prepare(
          "UPDATE auxiliary_sessions SET updated_at = ? WHERE id = ?",
        ).run(input.updatedAt, current.id);
        return true;
      },
      true,
    );
  }

  /** 直接 Steer の配送が確定する前に、ターン識別情報と添付を持つ保留中の入力を保存する。 */
  beginAuxiliarySteer(
    input: AuxiliarySteerBeginInput,
  ): AuxiliarySession | null {
    if (!input.nativeTurnId?.trim() || input.queuedInput)
      throw new Error("A direct Auxiliary Steer target is required.");
    return this.appendAuxiliarySteer({
      ...input,
      userMessage: {
        ...input.userMessage,
        turnInput: {
          turnId: String(input.turnId),
          nativeTurnId: input.nativeTurnId,
          state: "pending",
          attachments: input.attachments,
          ...(input.userMessage.turnInput?.questionRequestId
            ? {
                questionRequestId:
                  input.userMessage.turnInput.questionRequestId,
              }
            : {}),
        },
      },
    });
  }

  /** 同じ Turn に属する直接 Steer の保存行だけを照合し、配送状態を確定する。 */
  settleAuxiliarySteer(
    input: AuxiliarySteerSettleInput,
  ): AuxiliarySession | null {
    if (
      !["confirmed", "unknown", "not-sent"].includes(input.state) ||
      !Number.isSafeInteger(input.messageSeq) ||
      input.messageSeq < 0
    )
      throw new Error("The Auxiliary Steer settlement is invalid.");
    return this.writeRuntime(
      input,
      (db, current) => {
        const row = db
          .prepare(
            "SELECT body FROM auxiliary_session_messages WHERE auxiliary_session_id = ? AND seq = ? AND role = 'user'",
          )
          .get(current.id, input.messageSeq) as { body: string } | undefined;
        const message = row ? normalizeMessage(JSON.parse(row.body)) : null;
        if (
          !message?.turnInput ||
          message.turnInput.turnId !== String(input.turnId) ||
          message.turnInput.queueId ||
          (message.turnInput.state !== "pending" &&
            message.turnInput.state !== input.state)
        )
          throw new Error(
            "The pending Auxiliary Steer input no longer matches.",
          );
        db.prepare(
          "UPDATE auxiliary_session_messages SET body = ? WHERE auxiliary_session_id = ? AND seq = ?",
        ).run(
          JSON.stringify({
            ...message,
            turnInput: { ...message.turnInput, state: input.state },
          }),
          current.id,
          input.messageSeq,
        );
        return true;
      },
      true,
    );
  }

  /** 応答本文・継続用スレッド・Turn の終端をまとめて保存し、対応する開始受領記録も完了させる。 */
  appendAuxiliaryTerminal(
    input: AuxiliaryTerminalAppendInput,
  ): AuxiliarySession | null {
    return this.writeRuntime(
      input,
      (db, current) => {
        const commit = input.terminalCommit;
        if (
          current.runState !== "running" ||
          input.assistantMessage.role !== "assistant" ||
          input.runState === "running" ||
          commit.sessionId !== current.id ||
          commit.assistantMessageSeq !== input.expectedMessageCount
        )
          return false;
        insertAuxiliaryMessage(
          db,
          current.id,
          input.expectedMessageCount,
          input.assistantMessage,
          input.updatedAt,
        );
        db.prepare(
          `UPDATE auxiliary_sessions SET run_state = ?,
        thread_id = ?, preview = ?, updated_at = ? WHERE id = ?`,
        ).run(
          input.runState,
          input.threadId,
          input.preview,
          input.updatedAt,
          current.id,
        );
        writeSessionTurnTerminalCommit(db, commit, "auxiliary");
        const queueResult = db
          .prepare(
            `UPDATE session_turn_queue_v6 SET state = ?, reason = ?, updated_at = ?
        WHERE auxiliary_session_id = ? AND session_id = ? AND incarnation_id = ? AND turn_id = ?
          AND state = 'running' AND input_turn_id IS NULL
          AND user_message_seq = (SELECT user_message_seq FROM session_turns_v6 WHERE id = ? AND auxiliary_session_id = ?)`,
          )
          .run(
            commit.phase,
            commit.errorMessage || null,
            commit.completedAt,
            current.id,
            current.parentSessionId,
            current.createdAt,
            String(commit.turnId),
            commit.turnId,
            current.id,
          );
        if (
          Number(queueResult.changes) === 0 &&
          db
            .prepare(
              `SELECT 1 FROM session_turn_queue_v6
        WHERE auxiliary_session_id = ? AND incarnation_id = ? AND turn_id = ? AND state = 'running' AND input_turn_id IS NULL`,
            )
            .get(current.id, current.createdAt, String(commit.turnId))
        )
          throw new Error(
            "The Auxiliary queued terminal receipt does not match.",
          );
        return true;
      },
      true,
    );
  }

  /** プロバイダー、スレッドと実行状態の期待値が一致するときだけメタデータを更新する。 */
  checkpointAuxiliaryRuntimeMetadata(
    input: AuxiliaryRuntimeWriteInput & {
      threadId: string;
      provider: string;
      expectedThreadId: string;
      expectedRunState: AuxiliarySession["runState"];
      runState: AuxiliarySession["runState"];
    },
  ): AuxiliarySession | null {
    return this.writeRuntime(
      input,
      (db, current) => {
        if (
          current.provider !== input.provider ||
          current.threadId !== input.expectedThreadId ||
          current.runState !== input.expectedRunState
        )
          return false;
        db.prepare(
          "UPDATE auxiliary_sessions SET thread_id = ?, run_state = ?, updated_at = ? WHERE id = ?",
        ).run(input.threadId, input.runState, input.updatedAt, current.id);
        return true;
      },
      false,
    );
  }

  /** 書き込み可能な親と対象の作成時刻・会話件数をトランザクション内で照合し、確定後に会話変更を知らせる。 */
  private writeRuntime(
    input: AuxiliaryRuntimeWriteInput,
    write: (db: DatabaseSync, current: AuxiliarySession) => boolean,
    changesConversation: boolean,
  ): AuxiliarySession | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const current = readAuxiliaryMetadata(db, input.auxiliarySessionId);
        if (
          !Number.isSafeInteger(input.expectedMessageCount) ||
          input.expectedMessageCount < 0 ||
          !current ||
          current.parentSessionId !== input.parentSessionId ||
          current.createdAt !== input.createdAt ||
          current.characterRuntimeSnapshotInvalid ||
          current.messageCount !== input.expectedMessageCount ||
          !hasWritableAuxiliaryParent(db, current.parentSessionId) ||
          !write(db, current)
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const saved = readAuxiliaryMetadata(db, current.id);
        if (!saved)
          throw new Error(
            "The Auxiliary Session could not be read after saving.",
          );
        db.exec("COMMIT");
        if (changesConversation)
          this.onConversationChanged("auxiliary_session_messages", current.id);
        return saved;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** Auxiliary の保存済み世代を使い、会話の指定ページを返す。 */
  getConversationPage(
    auxiliarySessionId: string,
    request?: ConversationPageRequest,
  ) {
    return this.withDb((db) => {
      const row = db
        .prepare("SELECT * FROM auxiliary_sessions WHERE id = ?")
        .get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row
        ? readConversationPage(
            db,
            "auxiliary_session_messages",
            row.id,
            row.created_at,
            request,
          )
        : null;
    });
  }

  /** メタデータに既定の会話ページと最新の下書きを重ね、表示用の Session を返す。 */
  getAuxiliarySessionView(auxiliarySessionId: string): AuxiliarySession | null {
    return this.withDb((db) => {
      const row = db
        .prepare("SELECT * FROM auxiliary_sessions WHERE id = ?")
        .get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      if (!row) return null;
      const session = parseAuxiliarySessionRow(row);
      if (!session) return null;
      const page = readConversationPage(
        db,
        "auxiliary_session_messages",
        row.id,
        row.created_at,
      );
      return this.composeDraft(db, {
        ...session,
        messages: page.messages,
        messageCount: page.totalCount,
      });
    });
  }

  /** 保存済みの概要一覧と同じ順序で最後に該当する Auxiliary を選び、その View だけを読み取る。 */
  getLatestAuxiliarySessionView(
    parentSessionId: string,
  ): AuxiliarySession | null {
    const id = parentSessionId.trim();
    if (!id) return null;
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT a.id FROM auxiliary_sessions a
        LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.parent_session_id = ? AND trim(a.id) <> ''
        ORDER BY MAX(d.updated_at, a.updated_at) DESC, a.id DESC LIMIT 1`,
        )
        .get(id) as { id: string } | undefined;
      return row ? this.getAuxiliarySessionView(row.id.trim()) : null;
    });
  }

  /** Auxiliary の会話照会で使うスナップショットを、共通の読み取り処理から取得する。 */
  getConversationQuerySnapshot(sessionId: string) {
    return this.withDb((db) =>
      readConversationQuerySnapshot(
        db,
        "auxiliary_session_messages",
        sessionId,
      ),
    );
  }

  /** Auxiliary の会話を seq のカーソル単位で読み、必要なら話者情報や対象位置の制限を適用する。 */
  readConversationQueryBatch(
    sessionId: string,
    afterSeq: number,
    includeSpeakers = true,
    messageIndexes?: readonly number[],
  ) {
    return this.withDb((db) =>
      readConversationQueryBatch(
        db,
        "auxiliary_session_messages",
        sessionId,
        afterSeq,
        includeSpeakers,
        messageIndexes,
      ),
    );
  }

  /** 読み取り対象が Auxiliary の場合だけ、保存済み履歴の共通読み取り処理へ渡す。 */
  readSessionHistory(input: SessionHistoryReadInput): SessionHistoryResult {
    if (input.scope.source.kind !== "auxiliary")
      throw new Error("Auxiliary history reads require an auxiliary source.");
    return this.withDb((db) => readSessionHistory(db, input));
  }

  /** 現行の下書きを世代・リビジョンと本文を含めて取得する。対象がなければ null。 */
  getAuxiliaryDraft(auxiliarySessionId: string): AuxiliaryDraftRecord | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
        SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
          durable_revision, draft_text, updated_at
        FROM auxiliary_session_drafts
        WHERE auxiliary_session_id = ?
      `,
        )
        .get(auxiliarySessionId) as AuxiliaryDraftRow | undefined;
      return row ? toDraftRecord(row) : null;
    });
  }

  /** 実行状態と下書きの世代だけを、本文を読まずに取得する。 */
  getAuxiliarySessionStatus(
    auxiliarySessionId: string,
  ): AuxiliarySessionStatus | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `
        SELECT a.id, a.parent_session_id, a.created_at, a.run_state, d.incarnation
        FROM auxiliary_sessions a LEFT JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
        WHERE a.id = ?
      `,
        )
        .get(auxiliarySessionId) as
        | {
            id: string;
            parent_session_id: string;
            created_at: string;
            run_state: AuxiliarySession["runState"];
            incarnation?: string;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        parentSessionId: row.parent_session_id,
        createdAt: row.created_at,
        incarnation: row.incarnation ?? "",
        runState: row.run_state,
      };
    });
  }

  /** 書き込み可能な親と現在の下書き世代・リビジョンが一致する場合だけ本文を保存し、確定した版を返す。 */
  saveAuxiliaryDraft(
    input: AuxiliaryDraftStorageSaveInput,
  ): AuxiliaryDraftSaveResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const session = db
          .prepare(
            `
          SELECT id, parent_session_id, created_at
          FROM auxiliary_sessions WHERE id = ?
        `,
          )
          .get(input.auxiliarySessionId) as
          | { id: string; parent_session_id: string; created_at: string }
          | undefined;
        const row = db
          .prepare(
            `
          SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
            durable_revision, draft_text, updated_at
          FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?
        `,
          )
          .get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
        if (!session) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        if (
          !session ||
          !hasWritableAuxiliaryParent(db, session.parent_session_id)
        ) {
          db.exec("ROLLBACK");
          return { outcome: "rejected" };
        }
        if (session.parent_session_id !== input.parentSessionId) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        if (!row || row.parent_session_id !== input.parentSessionId) {
          db.exec("ROLLBACK");
          return { outcome: "not-found" };
        }
        const current = row;
        if (
          current.incarnation !== input.incarnation ||
          current.durable_revision !== input.expectedDurableRevision
        ) {
          db.exec("ROLLBACK");
          return { outcome: "stale", ...(row ? { ack: toDraftAck(row) } : {}) };
        }
        const next: AuxiliaryDraftRecord = {
          auxiliarySessionId: input.auxiliarySessionId,
          parentSessionId: input.parentSessionId,
          incarnation: input.incarnation,
          durableRevision: current.durable_revision + 1,
          text: input.text,
          updatedAt: input.updatedAt,
        };
        const result = db
          .prepare(
            `
          UPDATE auxiliary_session_drafts
          SET durable_revision = ?, draft_text = ?, updated_at = ?
          WHERE auxiliary_session_id = ? AND parent_session_id = ?
            AND incarnation = ? AND durable_revision = ?
        `,
          )
          .run(
            next.durableRevision,
            next.text,
            next.updatedAt,
            next.auxiliarySessionId,
            next.parentSessionId,
            next.incarnation,
            input.expectedDurableRevision,
          );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return { outcome: "stale", ack: toDraftAck(current) };
        }
        db.exec("COMMIT");
        return { outcome: "saved", ack: toDraftAck(next) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 送信する下書きの消費を単独トランザクションで確定し、不一致の場合は変更しない。 */
  consumeAuxiliaryDraft(
    input: AuxiliaryDraftStorageConsumeInput,
  ): AuxiliaryDraftConsumeResult {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const result = consumeAuxiliaryDraftInTransaction(db, input);
        if (result.outcome !== "consumed") {
          db.exec("ROLLBACK");
          return result;
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 親、作成時刻、プロバイダーと現在のスレッドを照合し、該当する Auxiliary のスレッド参照だけを変更する。 */
  updateAuxiliarySessionThreadIfMatches(
    input: AuxiliarySessionThreadPatchInput,
  ): AuxiliaryThreadPatchResult | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db
          .prepare(
            `
          SELECT id, parent_session_id, created_at, updated_at, provider_id, thread_id
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `,
          )
          .get(input.auxiliarySessionId, input.parentSessionId) as
          | Pick<
              AuxiliarySessionRow,
              | "id"
              | "parent_session_id"
              | "created_at"
              | "updated_at"
              | "provider_id"
              | "thread_id"
            >
          | undefined;
        if (
          !row ||
          row.provider_id !== input.provider ||
          row.thread_id !== input.expectedThreadId ||
          (input.createdAt !== undefined && row.created_at !== input.createdAt)
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db
          .prepare(
            `
          UPDATE auxiliary_sessions SET updated_at = ?, thread_id = ?
          WHERE id = ? AND parent_session_id = ? AND updated_at = ?
        `,
          )
          .run(
            input.updatedAt,
            input.nextThreadId,
            input.auxiliarySessionId,
            input.parentSessionId,
            row.updated_at,
          );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return {
          id: row.id,
          parentSessionId: row.parent_session_id,
          threadId: input.nextThreadId,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 保存済みの実行識別情報が期待値に一致する場合だけ、プロバイダー・モデル・スレッド等を一緒に更新する。 */
  updateAuxiliarySessionRuntimeMetadataIfMatches(
    input: AuxiliarySessionRuntimeMetadataPatchInput,
  ): AuxiliaryRuntimeMetadataPatchResult | null {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db
          .prepare(
            `
          SELECT id, parent_session_id, created_at, updated_at, provider_id, catalog_revision, model_id, reasoning_effort, thread_id
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ?
        `,
          )
          .get(input.auxiliarySessionId, input.parentSessionId) as
          | Pick<
              AuxiliarySessionRow,
              | "id"
              | "parent_session_id"
              | "created_at"
              | "updated_at"
              | "provider_id"
              | "catalog_revision"
              | "model_id"
              | "reasoning_effort"
              | "thread_id"
            >
          | undefined;
        if (
          !row ||
          row.created_at !== input.createdAt ||
          row.provider_id !== input.expected.provider ||
          row.catalog_revision !== input.expected.catalogRevision ||
          row.model_id !== input.expected.model ||
          row.reasoning_effort !== input.expected.reasoningEffort ||
          row.thread_id !== input.expected.threadId
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db
          .prepare(
            `
          UPDATE auxiliary_sessions SET updated_at = ?, provider_id = ?, catalog_revision = ?,
            model_id = ?, reasoning_effort = ?, thread_id = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `,
          )
          .run(
            input.next.updatedAt,
            input.next.provider,
            input.next.catalogRevision,
            input.next.model,
            input.next.reasoningEffort,
            input.next.threadId,
            input.auxiliarySessionId,
            input.parentSessionId,
            input.createdAt,
            row.updated_at,
          );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return {
          id: row.id,
          parentSessionId: row.parent_session_id,
          createdAt: row.created_at,
          provider: input.next.provider,
          catalogRevision: input.next.catalogRevision,
          model: input.next.model,
          reasoningEffort: input.next.reasoningEffort,
          threadId: input.next.threadId,
          updatedAt: input.next.updatedAt,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 既読ページではなく完全な Session を、対象と期待値が現在の保存内容に一致する場合だけ保存する。 */
  updateAuxiliarySessionIfMatches(
    input: AuxiliarySessionUpdateIfMatchesInput,
  ): AuxiliarySession | null {
    return this.storeAuxiliarySessionIfMatches(input);
  }

  /** 終端記録の所有者を照合し、Session の条件付き更新と Turn 終端を一緒に保存する。 */
  updateTerminalAuxiliarySessionIfMatches(
    input: AuxiliarySessionUpdateIfMatchesInput,
    terminalCommit: SessionTurnTerminalCommit,
  ): AuxiliarySession | null {
    if (terminalCommit.sessionId !== input.session.id) {
      throw new Error(
        "The terminal Auxiliary Session owner does not match the turn marker.",
      );
    }
    return this.storeAuxiliarySessionIfMatches(input, terminalCommit);
  }

  /** 履歴と実行状態の競合を検出し、同時に編集された下書きや表示用メタデータを上書きせずに保存する。 */
  private storeAuxiliarySessionIfMatches(
    input: AuxiliarySessionUpdateIfMatchesInput,
    terminalCommit?: SessionTurnTerminalCommit,
  ): AuxiliarySession | null {
    assertFullConversation(input.session);
    assertFullConversation(input.expectedSession);
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const row = db
          .prepare(
            `
          SELECT *
          FROM auxiliary_sessions
          WHERE id = ? AND parent_session_id = ? AND created_at = ?
        `,
          )
          .get(
            input.expectedSession.id,
            input.expectedSession.parentSessionId,
            input.expectedSession.createdAt,
          ) as AuxiliarySessionRow | undefined;
        const current = row ? readAuxiliarySession(db, row) : null;
        const parentTables = db
          .prepare(
            `
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('sessions_v6', 'sessions')
        `,
          )
          .all() as Array<{ name: string }>;
        const hasV6ParentTable = parentTables.some(
          ({ name }) => name === "sessions_v6",
        );
        const parent = parentTables
          .filter(
            ({ name }) =>
              name !== (hasV6ParentTable ? "sessions" : "sessions_v6"),
          )
          .some(({ name }) => {
            const row = db
              .prepare(`SELECT 1 AS present FROM ${name} WHERE id = ? LIMIT 1`)
              .get(input.expectedSession.parentSessionId);
            return Boolean(row);
          });
        const expected = normalizeAuxiliarySession(input.expectedSession);
        const draftRow = db
          .prepare(
            "SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?",
          )
          .get(input.expectedSession.id) as { draft_text: string } | undefined;
        const currentWithDraft =
          current && draftRow
            ? { ...current, composerDraft: draftRow.draft_text }
            : current;
        const currentRuntime = currentWithDraft && {
          ...currentWithDraft,
          title: "",
          description: "",
          updatedAt: input.expectedSession.updatedAt,
          composerDraft: "",
          preview: currentWithDraft.preview ?? "",
          messages: currentWithDraft.messages.map((message) => ({
            ...message,
            isBookmarked: undefined,
          })),
        };
        const expectedRuntime = expected && {
          ...expected,
          title: "",
          description: "",
          composerDraft: "",
          preview: expected.preview ?? current?.preview ?? "",
          messages: expected.messages.map((message) => ({
            ...message,
            artifact: message.artifact
              ? summarizeMessageArtifact(message.artifact)
              : undefined,
            isBookmarked: undefined,
          })),
        };
        if (
          !row ||
          !current ||
          !expected ||
          input.session.id !== expected.id ||
          input.session.parentSessionId !== expected.parentSessionId ||
          input.session.createdAt !== expected.createdAt ||
          JSON.stringify(currentRuntime) !== JSON.stringify(expectedRuntime) ||
          !parent ||
          (input.session.title !== expected.title &&
            current.title !== expected.title) ||
          ((input.session.description ?? "") !== (expected.description ?? "") &&
            (current.description ?? "") !== (expected.description ?? ""))
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        const result = db
          .prepare(
            `
          UPDATE auxiliary_sessions
          SET updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? AND updated_at = ?
        `,
          )
          .run(
            input.session.updatedAt,
            input.session.id,
            input.expectedSession.parentSessionId,
            input.expectedSession.createdAt,
            row.updated_at,
          );
        if (Number(result.changes) !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        writeAuxiliaryMetadata(
          db,
          input.session,
          current.title === expected.title &&
            (current.description ?? "") === (expected.description ?? ""),
        );
        const conversationChanged = writeAuxiliaryMessages(db, input.session);
        const storedRow = db
          .prepare(`SELECT * FROM auxiliary_sessions WHERE id = ?`)
          .get(input.session.id) as AuxiliarySessionRow | undefined;
        const stored = storedRow ? readAuxiliarySession(db, storedRow) : null;
        if (!stored)
          throw new Error(
            "The Auxiliary Session could not be read after saving.",
          );
        if (terminalCommit)
          writeSessionTurnTerminalCommit(db, terminalCommit, "auxiliary");
        db.exec("COMMIT");
        if (conversationChanged)
          this.onConversationChanged(
            "auxiliary_session_messages",
            input.session.id,
          );
        return {
          ...stored,
          composerDraft: currentWithDraft?.composerDraft ?? "",
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** Auxiliary と全履歴を保存し、既に独立保存された下書きは置き換えない。 */
  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession {
    assertFullConversation(session);
    return this.withDb((db) => {
      const existing = db
        .prepare(
          "SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?",
        )
        .get(session.id) as { draft_text: string } | undefined;
      const persisted = existing
        ? { ...session, composerDraft: existing.draft_text }
        : session;
      const previousOwner = db
        .prepare(
          "SELECT parent_session_id, created_at FROM auxiliary_sessions WHERE id = ?",
        )
        .get(session.id) as
        { parent_session_id: string; created_at: string } | undefined;
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare(
          `INSERT OR IGNORE INTO auxiliary_sessions
          (id, parent_session_id, created_at, updated_at)
          VALUES (?, ?, ?, ?)`,
        ).run(
          session.id,
          session.parentSessionId,
          session.createdAt,
          session.updatedAt,
        );
        writeAuxiliaryMetadata(db, persisted, !previousOwner);
        const conversationChanged = writeAuxiliaryMessages(db, persisted);
        db.prepare(
          `
          INSERT OR IGNORE INTO auxiliary_session_drafts
            (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `,
        ).run(
          session.id,
          session.parentSessionId,
          randomUUID(),
          session.composerDraft,
          session.updatedAt,
        );
        db.exec("COMMIT");
        if (
          conversationChanged ||
          !existing ||
          previousOwner?.parent_session_id !== session.parentSessionId ||
          previousOwner?.created_at !== session.createdAt
        )
          this.onConversationChanged("auxiliary_session_messages", session.id);
        const stored = this.getAuxiliarySession(persisted.id);
        if (!stored)
          throw new Error(
            "The Auxiliary Session could not be read after saving.",
          );
        return stored;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 指定親の Auxiliary と下書きを一緒に削除し、会話が消えたことを確定後に通知する。 */
  deleteAuxiliarySessionsForParent(parentSessionId: string): void {
    this.withDb((db) => {
      const ids = db
        .prepare(
          "SELECT id FROM auxiliary_sessions WHERE parent_session_id = ?",
        )
        .all(parentSessionId) as Array<{ id: string }>;
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        db.prepare(
          "DELETE FROM auxiliary_sessions WHERE parent_session_id = ?",
        ).run(parentSessionId);
        db.prepare(
          "DELETE FROM auxiliary_session_drafts WHERE parent_session_id = ?",
        ).run(parentSessionId);
        db.exec("COMMIT");
        ids.forEach(({ id }) =>
          this.onConversationChanged("auxiliary_session_messages", id),
        );
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 指定された親の集合に含まれない Auxiliary と下書きを削除し、削除した会話を通知する。 */
  deleteAuxiliarySessionsExceptParents(
    parentSessionIds: Iterable<string>,
  ): void {
    const retainedParentSessionIds = Array.from(new Set(parentSessionIds));
    this.withDb((db) => {
      const removed = (
        db
          .prepare("SELECT id, parent_session_id FROM auxiliary_sessions")
          .all() as Array<{ id: string; parent_session_id: string }>
      ).filter(
        (row) => !retainedParentSessionIds.includes(row.parent_session_id),
      );
      if (retainedParentSessionIds.length === 0) {
        db.prepare("DELETE FROM auxiliary_sessions").run();
        db.prepare("DELETE FROM auxiliary_session_drafts").run();
        removed.forEach(({ id }) =>
          this.onConversationChanged("auxiliary_session_messages", id),
        );
        return;
      }

      const placeholders = retainedParentSessionIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM auxiliary_sessions WHERE parent_session_id NOT IN (${placeholders})`,
      ).run(...retainedParentSessionIds);
      db.prepare(
        `DELETE FROM auxiliary_session_drafts WHERE parent_session_id NOT IN (${placeholders})`,
      ).run(...retainedParentSessionIds);
      removed.forEach(({ id }) =>
        this.onConversationChanged("auxiliary_session_messages", id),
      );
    });
  }

  /** Auxiliary の保存テーブルと索引を準備し、旧形式を現在の行構成へ移す。 */
  private initializeSchema(): void {
    this.withDb((db) => {
      db.exec(CREATE_AUXILIARY_SESSIONS_TABLE_SQL);
      ensureAuxiliarySessionCreatedAtColumn(db);
      db.exec(CREATE_AUXILIARY_SESSION_PARENT_UPDATED_INDEX_SQL);
      db.exec(CREATE_AUXILIARY_SESSION_DRAFTS_TABLE_SQL);
      migrateAuxiliaryStorage(db);
      db.exec("DROP INDEX IF EXISTS idx_auxiliary_sessions_parent_created");
    });
  }

  /** 指定 Auxiliary の概要だけを取得し、本文や内部の作成記録は読み出さない。 */
  getAuxiliarySessionSummary(
    auxiliarySessionId: string,
  ): AuxiliarySessionSummary | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT ${AUXILIARY_SUMMARY_COLUMNS} FROM auxiliary_sessions a WHERE a.id = ?`,
        )
        .get(auxiliarySessionId) as AuxiliarySessionRow | undefined;
      return row ? parseAuxiliarySessionSummaryRow(row) : null;
    });
  }

  /** 認証情報の変更時に必要な Auxiliary の所有者・プロバイダー・スレッドと実行状態だけを読む。 */
  listAuxiliaryCredentialThreads(): AuxiliaryCredentialThreadInfo[] {
    return this.withDb((db) =>
      (
        db
          .prepare(
            `SELECT id, parent_session_id, created_at,
      provider_id, thread_id, run_state FROM auxiliary_sessions`,
          )
          .all() as Array<
          Pick<
            AuxiliarySessionRow,
            | "id"
            | "parent_session_id"
            | "created_at"
            | "provider_id"
            | "thread_id"
            | "run_state"
          >
        >
      ).map((row) => {
        return {
          id: row.id,
          parentSessionId: row.parent_session_id,
          createdAt: row.created_at,
          provider: row.provider_id,
          threadId: row.thread_id,
          runState: row.run_state,
        };
      }),
    );
  }

  /** メッセージ位置に対応する成果物の詳細だけを読んで検証する。未保存なら null。 */
  getAuxiliaryMessageArtifactDetail(
    auxiliarySessionId: string,
    messageIndex: number,
  ): MessageArtifact | null {
    return this.withDb((db) => {
      const row = db
        .prepare(
          `SELECT artifact_body FROM auxiliary_session_messages
        WHERE auxiliary_session_id = ? AND seq = ?`,
        )
        .get(auxiliarySessionId, messageIndex) as
        { artifact_body: string | null } | undefined;
      if (!row || row.artifact_body === null) return null;
      const artifact: unknown = JSON.parse(row.artifact_body);
      if (
        !artifact ||
        typeof artifact !== "object" ||
        Array.isArray(artifact)
      ) {
        throw new Error(
          "Stored Auxiliary message artifact must be a JSON object.",
        );
      }
      const normalized = normalizeMessage({
        role: "assistant",
        text: "",
        artifact,
      })?.artifact;
      if (!normalized)
        throw new Error(
          "Stored Auxiliary message artifact could not be normalized.",
        );
      return normalized;
    });
  }

  /** 同じ親・世代の Auxiliary が実行中でないときに、件名を変更する。 */
  updateAuxiliaryTitleIfMatches(
    input: AuxiliaryIdentityPatchInput & { title: string },
  ): boolean {
    return this.updateScalarIfMatches(input, "title = ?", [input.title], true);
  }

  /** 検証した件名・説明の変更だけを適用し、対象が失効した場合は成功として返さない。 */
  patchAuxiliarySessionMetadata(
    input: AuxiliaryIdentityPatchInput & {
      patch: import("../../src-shared/session/session-metadata.js").SessionMetadataPatch;
    },
  ): AuxiliarySessionSummary {
    const value = validateSessionMetadataPatch(input.patch);
    if (
      !this.updateScalarIfMatches(
        input,
        "title = COALESCE(?, title), description = COALESCE(?, description)",
        [value.title ?? null, value.description ?? null],
      )
    ) {
      throw new Error(
        "The Auxiliary Session identity no longer matches its saved owner.",
      );
    }
    const stored = this.getAuxiliarySessionSummary(input.auxiliarySessionId);
    if (!stored)
      throw new Error(
        "The Auxiliary Session could not be found after saving metadata.",
      );
    return stored;
  }

  /** 親と対象の作成時刻を照合し、実行オプションの列だけをまとめて更新する。 */
  updateAuxiliaryExecutionOptionsIfMatches(
    input: AuxiliaryIdentityPatchInput & { options: AuxiliaryExecutionOptions },
  ): boolean {
    const options = input.options;
    return this.updateScalarIfMatches(
      input,
      `provider_id = ?, model_id = ?, reasoning_effort = ?, approval_mode = ?,
        codex_sandbox_mode = ?, codex_speed = ?, codex_reviewer = ?, withmate_reviewer_explicit = ?, custom_agent_name = ?`,
      [
        options.provider,
        options.model,
        options.reasoningEffort,
        options.approvalMode,
        options.codexSandboxMode,
        options.codexSpeed,
        options.codexReviewer,
        options.withMateReviewerExplicit ? 1 : 0,
        options.customAgentName,
      ],
    );
  }

  /** 表示の起点となるメッセージ位置を、同じ親・世代の対象に対して更新する。 */
  updateAuxiliaryDisplayAnchorIfMatches(
    input: AuxiliaryIdentityPatchInput & {
      displayAfterMessageIndex: number | null;
    },
  ): boolean {
    return this.updateScalarIfMatches(
      input,
      "display_after_message_index = ?",
      [input.displayAfterMessageIndex],
    );
  }

  /** 対象メッセージを所有者付きで照合し、ブックマークの変更だけを保存して通知する。 */
  updateAuxiliaryMessageBookmarkIfMatches(
    input: AuxiliaryIdentityPatchInput & {
      messageIndex: number;
      isBookmarked: boolean;
    },
  ): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        const owner = hasWritableAuxiliaryParent(db, input.parentSessionId)
          ? db
              .prepare(
                `SELECT id FROM auxiliary_sessions WHERE id = ? AND parent_session_id = ? AND created_at = ?`,
              )
              .get(
                input.auxiliarySessionId,
                input.parentSessionId,
                input.createdAt,
              )
          : undefined;
        const row = owner
          ? (db
              .prepare(
                `SELECT body FROM auxiliary_session_messages WHERE auxiliary_session_id = ? AND seq = ?`,
              )
              .get(input.auxiliarySessionId, input.messageIndex) as
              { body: string } | undefined)
          : undefined;
        if (!row) {
          db.exec("ROLLBACK");
          return false;
        }
        const message = normalizeMessage(JSON.parse(row.body));
        if (!message) throw new Error("Invalid Auxiliary message.");
        db.prepare(
          `UPDATE auxiliary_session_messages SET body = ? WHERE auxiliary_session_id = ? AND seq = ?`,
        ).run(
          JSON.stringify({
            ...message,
            isBookmarked: input.isBookmarked ? true : undefined,
          }),
          input.auxiliarySessionId,
          input.messageIndex,
        );
        db.prepare(
          `UPDATE auxiliary_sessions SET updated_at = ? WHERE id = ?`,
        ).run(input.updatedAt, input.auxiliarySessionId);
        db.exec("COMMIT");
        if ((message.isBookmarked === true) !== input.isBookmarked)
          this.onConversationChanged(
            "auxiliary_session_messages",
            input.auxiliarySessionId,
          );
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 親が書き込み可能で対象の識別が一致する場合だけ、指定されたメタデータ列を更新する。 */
  private updateScalarIfMatches(
    input: AuxiliaryIdentityPatchInput,
    assignments: string,
    values: Array<string | number | null>,
    requireIdle = false,
  ): boolean {
    return this.withDb((db) => {
      db.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        if (!hasWritableAuxiliaryParent(db, input.parentSessionId)) {
          db.exec("ROLLBACK");
          return false;
        }
        const result = db
          .prepare(
            `UPDATE auxiliary_sessions SET ${assignments}, updated_at = ?
          WHERE id = ? AND parent_session_id = ? AND created_at = ? ${requireIdle ? "AND run_state <> 'running'" : ""}`,
          )
          .run(
            ...values,
            input.updatedAt,
            input.auxiliarySessionId,
            input.parentSessionId,
            input.createdAt,
          );
        db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 最新の下書き行があれば、保存済み Session に本文を重ねて返す。 */
  private composeDraft(
    db: DatabaseSync,
    session: AuxiliarySession,
  ): AuxiliarySession {
    const row = db
      .prepare(
        `SELECT draft_text FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?`,
      )
      .get(session.id) as { draft_text: string } | undefined;
    return row ? { ...session, composerDraft: row.draft_text } : session;
  }

  /** 閉じられていない SQLite 接続で同期の保存処理を実行する。 */
  private withDb<T>(runner: (db: DatabaseSync) => T): T {
    if (!this.db) {
      throw new Error("AuxiliarySessionStorage は close 済みだよ。");
    }

    return runner(this.db);
  }
}

/** 旧形式の一括 JSON を現在の Auxiliary の形に正規化し、読めない入力は null にする。 */
function parseAuxiliarySessionPayload(
  payloadJson: string,
): AuxiliarySession | null {
  try {
    return normalizeAuxiliarySession(JSON.parse(payloadJson));
  } catch {
    return null;
  }
}

/** SQLite 行からメタデータを正規化する。履歴はここでは読み込まず、不正な行は null。 */
function parseAuxiliarySessionRow(
  row: AuxiliarySessionRow,
): AuxiliarySession | null {
  try {
    return normalizeAuxiliarySession({
      id: row.id,
      parentSessionId: row.parent_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      description: row.description,
      runState: row.run_state,
      preview: row.preview,
      provider: row.provider_id,
      catalogRevision: row.catalog_revision,
      model: row.model_id,
      reasoningEffort: row.reasoning_effort,
      approvalMode: row.approval_mode,
      codexSandboxMode: row.codex_sandbox_mode,
      codexSpeed: row.codex_speed,
      codexReviewer: row.codex_reviewer,
      withMateReviewerExplicit:
        row.withmate_reviewer_explicit === 1 ? true : undefined,
      customAgentName: row.custom_agent_name,
      threadId: row.thread_id,
      displayAfterMessageIndex: row.display_after_message_index,
      characterId: row.character_id ?? undefined,
      characterRuntimeSnapshot: row.character_snapshot_json
        ? JSON.parse(row.character_snapshot_json)
        : undefined,
      characterRuntimeSnapshotInvalid: row.character_snapshot_invalid === 1,
      characterIconPath: row.character_icon_path ?? undefined,
      clientRequestId: row.client_request_id ?? undefined,
      creationContext: row.creation_context_json
        ? JSON.parse(row.creation_context_json)
        : undefined,
      creationRequest: row.creation_request_json
        ? JSON.parse(row.creation_request_json)
        : undefined,
      messages: [],
    });
  } catch {
    return null;
  }
}

/** メタデータと seq 順の全会話を合成し、別に保存された実行失敗も対象メッセージへ反映する。 */
function readAuxiliarySession(
  db: DatabaseSync,
  row: AuxiliarySessionRow,
): AuxiliarySession | null {
  const session = parseAuxiliarySessionRow(row);
  if (!session) return null;
  const messages = db
    .prepare(
      `SELECT ${conversationMessageColumns("auxiliary_session_messages", db)} FROM auxiliary_session_messages
    WHERE auxiliary_session_id = ? ORDER BY seq ASC`,
    )
    .all(row.id) as ConversationQueryRow[];
  return {
    ...session,
    messages: messages.map(({ body, runFailure }) => {
      const message = normalizeMessage(JSON.parse(body));
      if (!message) throw new Error(`Invalid Auxiliary message: ${row.id}`);
      return withMessageRunFailure(message, runFailure);
    }),
  };
}

/** メタデータと保存済み履歴の件数を、会話本文を読み出さずに取得する。 */
function readAuxiliaryMetadata(
  db: DatabaseSync,
  id: string,
): AuxiliarySession | null {
  const row = db
    .prepare("SELECT * FROM auxiliary_sessions WHERE id = ?")
    .get(id) as AuxiliarySessionRow | undefined;
  const session = row ? parseAuxiliarySessionRow(row) : null;
  if (!session) return null;
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM auxiliary_session_messages WHERE auxiliary_session_id = ?",
    )
    .get(id) as { count: number };
  return { ...session, messageCount: count.count };
}

/** 一件の正規化したメッセージを追記し、成果物の概要と全文を別の列に保存する。 */
function insertAuxiliaryMessage(
  db: DatabaseSync,
  id: string,
  seq: number,
  message: Message,
  updatedAt: string,
): void {
  const normalized = normalizeMessage(message);
  if (!normalized) throw new Error("Invalid Auxiliary message.");
  const artifact = normalized.artifact;
  if (artifact?.detailAvailable)
    throw new Error(
      "Auxiliary appended artifact must contain its full detail.",
    );
  const body = JSON.stringify({
    ...normalized,
    historyIndex: undefined,
    artifact: artifact ? summarizeMessageArtifact(artifact) : undefined,
  });
  db.prepare(
    `INSERT INTO auxiliary_session_messages (auxiliary_session_id, seq, role, body, artifact_body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seq,
    normalized.role,
    body,
    artifact ? JSON.stringify(artifact) : null,
    updatedAt,
  );
}

/** Auxiliary の実行・表示用メタデータを更新し、呼び出し側が指定した場合だけ件名・説明も置き換える。 */
function writeAuxiliaryMetadata(
  db: DatabaseSync,
  session: AuxiliarySession,
  initializeMetadata = false,
): void {
  db.prepare(
    `UPDATE auxiliary_sessions SET parent_session_id = ?, created_at = ?, updated_at = ?,
    title = CASE WHEN ? THEN ? ELSE title END, description = CASE WHEN ? THEN ? ELSE description END,
    run_state = ?, preview = ?, provider_id = ?, catalog_revision = ?, model_id = ?, reasoning_effort = ?,
    approval_mode = ?, codex_sandbox_mode = ?, codex_speed = ?, codex_reviewer = ?, withmate_reviewer_explicit = ?, custom_agent_name = ?,
    thread_id = ?, display_after_message_index = ?,
    character_id = ?, character_snapshot_json = ?, character_snapshot_invalid = ?, character_icon_path = ?,
    client_request_id = ?, creation_context_json = ?, creation_request_json = ? WHERE id = ?`,
  ).run(
    session.parentSessionId,
    session.createdAt,
    session.updatedAt,
    initializeMetadata ? 1 : 0,
    session.title,
    initializeMetadata ? 1 : 0,
    session.description ?? "",
    session.runState,
    session.preview ?? buildAuxiliaryPreview(session.messages),
    session.provider,
    session.catalogRevision,
    session.model,
    session.reasoningEffort,
    session.approvalMode,
    session.codexSandboxMode,
    session.codexSpeed,
    session.codexReviewer,
    session.withMateReviewerExplicit ? 1 : 0,
    session.customAgentName,
    session.threadId,
    session.displayAfterMessageIndex,
    session.characterId ?? null,
    session.characterRuntimeSnapshot === undefined
      ? null
      : JSON.stringify(session.characterRuntimeSnapshot),
    session.characterRuntimeSnapshotInvalid ? 1 : 0,
    session.characterIconPath ?? null,
    session.clientRequestId ?? null,
    session.creationContext ? JSON.stringify(session.creationContext) : null,
    session.creationRequest ? JSON.stringify(session.creationRequest) : null,
    session.id,
  );
}

/** 完全な履歴を保存し、同じ内容の既存ブックマークと対応する成果物詳細を保持する。 */
function writeAuxiliaryMessages(
  db: DatabaseSync,
  session: AuxiliarySession,
): boolean {
  assertFullConversation(session);
  const existing = new Map(
    (
      db
        .prepare(
          `SELECT ${conversationMessageColumns("auxiliary_session_messages", db)}, artifact_body FROM auxiliary_session_messages
    WHERE auxiliary_session_id = ?`,
        )
        .all(session.id) as Array<{
        seq: number;
        role: string;
        body: string;
        artifact_body: string | null;
        runFailure?: string | null;
      }>
    ).map((row) => [row.seq, row] as const),
  );
  const insert = db.prepare(`INSERT INTO auxiliary_session_messages
    (auxiliary_session_id, seq, role, body, artifact_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const update =
    db.prepare(`UPDATE auxiliary_session_messages SET role = ?, body = ?, artifact_body = ?
    WHERE auxiliary_session_id = ? AND seq = ?`);
  let conversationChanged = existing.size !== session.messages.length;
  session.messages.forEach((message, seq) => {
    const summary = message.artifact
      ? summarizeMessageArtifact(message.artifact)
      : undefined;
    let artifactBody = message.artifact
      ? JSON.stringify(message.artifact)
      : null;
    const oldRow = existing.get(seq);
    const parsed = oldRow ? normalizeMessage(JSON.parse(oldRow.body)) : null;
    const oldMessage = parsed
      ? withMessageRunFailure(parsed, oldRow?.runFailure)
      : null;
    if (oldRow && !oldMessage) throw new Error("Invalid Auxiliary message.");
    const preservedBookmark =
      oldMessage?.role === message.role && oldMessage.text === message.text
        ? oldMessage.isBookmarked === true
        : message.isBookmarked === true;
    if (
      !oldMessage ||
      oldMessage.role !== message.role ||
      oldMessage.text !== message.text ||
      (oldMessage.accent === true) !== (message.accent === true) ||
      (oldMessage.isBookmarked === true) !== preservedBookmark
    )
      conversationChanged = true;
    if (message.artifact?.detailAvailable && oldRow?.artifact_body) {
      const old = JSON.parse(oldRow.artifact_body) as MessageArtifact;
      if (
        JSON.stringify(summarizeMessageArtifact(old)) ===
        JSON.stringify(summary)
      )
        artifactBody = oldRow.artifact_body;
    }
    const body = JSON.stringify({
      ...message,
      artifact: summary,
      isBookmarked: preservedBookmark ? true : undefined,
    });
    if (!oldRow) {
      insert.run(
        session.id,
        seq,
        message.role,
        body,
        artifactBody,
        session.updatedAt,
      );
    } else if (
      oldRow.role !== message.role ||
      oldRow.body !== body ||
      oldRow.artifact_body !== artifactBody
    ) {
      update.run(message.role, body, artifactBody, session.id, seq);
    }
  });
  if ([...existing.keys()].some((seq) => seq >= session.messages.length)) {
    db.prepare(
      "DELETE FROM auxiliary_session_messages WHERE auxiliary_session_id = ? AND seq >= ?",
    ).run(session.id, session.messages.length);
  }
  return conversationChanged;
}

/** 保存行の各列を、本文を含む下書きレコードへ変換する。 */
function toDraftRecord(row: AuxiliaryDraftRow): AuxiliaryDraftRecord {
  return {
    auxiliarySessionId: row.id,
    parentSessionId: row.parent_session_id,
    incarnation: row.incarnation,
    durableRevision: row.durable_revision,
    text: row.draft_text,
    updatedAt: row.updated_at,
  };
}

/** 保存行またはレコードから、下書き本文を含まない確認応答だけを組み立てる。 */
function toDraftAck(
  row: AuxiliaryDraftRow | AuxiliaryDraftRecord,
): AuxiliaryDraftAck {
  const legacy = "durable_revision" in row;
  return {
    auxiliarySessionId: legacy ? row.id : row.auxiliarySessionId,
    incarnation: row.incarnation,
    durableRevision: legacy ? row.durable_revision : row.durableRevision,
    updatedAt: legacy ? row.updated_at : row.updatedAt,
  };
}

/** 独立した下書きがまだない旧形式について、元の JSON から本文を取り出して専用テーブルへ移す。 */
function migrateAuxiliaryDrafts(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `
      SELECT id, parent_session_id, updated_at, payload_json
      FROM auxiliary_sessions
      WHERE id NOT IN (SELECT auxiliary_session_id FROM auxiliary_session_drafts)
    `,
    )
    .all() as Array<{
    id: string;
    parent_session_id: string;
    updated_at: string;
    payload_json: string;
  }>;
  const insert = db.prepare(`
      INSERT OR IGNORE INTO auxiliary_session_drafts
        (auxiliary_session_id, parent_session_id, incarnation, durable_revision, draft_text, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `);
  const clearPayload = db.prepare(
    "UPDATE auxiliary_sessions SET payload_json = ? WHERE id = ?",
  );
  for (const row of rows) {
    let draft = "";
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error(
          `Auxiliary draft migration payload is invalid: ${row.id}`,
        );
      }
      if (Object.prototype.hasOwnProperty.call(payload, "composerDraft")) {
        if (typeof payload.composerDraft !== "string")
          throw new Error(
            `Auxiliary draft migration payload is invalid: ${row.id}`,
          );
        draft = payload.composerDraft;
      }
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error(`Auxiliary draft migration payload is invalid: ${row.id}`);
    }
    insert.run(
      row.id,
      row.parent_session_id,
      randomUUID(),
      draft,
      row.updated_at,
    );
    delete payload.composerDraft;
    clearPayload.run(JSON.stringify(payload), row.id);
  }
}

/** 旧 payload の履歴とメタデータを現行のテーブルに分け、外部キーの検査後に移行を確定する。 */
function migrateAuxiliaryStorage(db: DatabaseSync): void {
  const columns = new Set(
    (
      db
        .prepare("PRAGMA table_info(auxiliary_sessions)")
        .all() as TableInfoRow[]
    ).map(({ name }) => name),
  );
  if (!columns.has("description"))
    db.exec(
      "ALTER TABLE auxiliary_sessions ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  if (!columns.has("withmate_reviewer_explicit"))
    db.exec(
      "ALTER TABLE auxiliary_sessions ADD COLUMN withmate_reviewer_explicit INTEGER NOT NULL DEFAULT 0 CHECK (withmate_reviewer_explicit IN (0, 1))",
    );
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.exec(CREATE_AUXILIARY_MESSAGES_TABLE_SQL);
    if (columns.has("payload_json")) {
      migrateAuxiliaryDrafts(db);
      if (!columns.has("title"))
        db.exec(
          "ALTER TABLE auxiliary_sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''",
        );
      if (!columns.has("run_state"))
        db.exec(
          "ALTER TABLE auxiliary_sessions ADD COLUMN run_state TEXT NOT NULL DEFAULT 'idle'",
        );
      if (!columns.has("preview"))
        db.exec(
          "ALTER TABLE auxiliary_sessions ADD COLUMN preview TEXT NOT NULL DEFAULT ''",
        );
      const additions: Array<[string, string]> = [
        ["provider_id", "TEXT NOT NULL DEFAULT 'codex'"],
        ["catalog_revision", "INTEGER NOT NULL DEFAULT 1"],
        ["model_id", "TEXT NOT NULL DEFAULT ''"],
        ["reasoning_effort", "TEXT NOT NULL DEFAULT 'medium'"],
        ["approval_mode", "TEXT NOT NULL DEFAULT ''"],
        ["codex_sandbox_mode", "TEXT NOT NULL DEFAULT ''"],
        ["codex_speed", "TEXT NOT NULL DEFAULT ''"],
        ["codex_reviewer", "TEXT NOT NULL DEFAULT ''"],
        ["custom_agent_name", "TEXT NOT NULL DEFAULT ''"],
        ["thread_id", "TEXT NOT NULL DEFAULT ''"],
        ["display_after_message_index", "INTEGER"],
        ["character_id", "TEXT"],
        ["character_snapshot_json", "TEXT"],
        ["character_snapshot_invalid", "INTEGER NOT NULL DEFAULT 0"],
        ["character_icon_path", "TEXT"],
        ["client_request_id", "TEXT"],
        ["creation_context_json", "TEXT"],
        ["creation_request_json", "TEXT"],
      ];
      for (const [name, definition] of additions) {
        if (!columns.has(name))
          db.exec(
            `ALTER TABLE auxiliary_sessions ADD COLUMN ${name} ${definition}`,
          );
      }
      const summaryExpression = columns.has("summary_json")
        ? "summary_json"
        : "'' AS summary_json";
      const rows = db
        .prepare(
          `SELECT id, parent_session_id, created_at, updated_at, payload_json, ${summaryExpression} FROM auxiliary_sessions`,
        )
        .all() as Array<{
        id: string;
        parent_session_id: string;
        created_at: string;
        updated_at: string;
        payload_json: string;
        summary_json: string;
      }>;
      for (const row of rows) {
        const raw = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          !Array.isArray(raw.messages)
        ) {
          throw new Error(`Invalid Auxiliary migration payload: ${row.id}`);
        }
        const session = parseAuxiliarySessionPayload(row.payload_json);
        if (
          !session ||
          session.id !== row.id ||
          session.parentSessionId !== row.parent_session_id ||
          session.messages.length !== raw.messages.length
        ) {
          throw new Error(`Invalid Auxiliary migration payload: ${row.id}`);
        }
        const existingSummary = row.summary_json
          ? (JSON.parse(row.summary_json) as { preview?: unknown })
          : null;
        const preview =
          typeof existingSummary?.preview === "string"
            ? existingSummary.preview
            : buildAuxiliaryPreview(session.messages);
        const migrated = {
          ...session,
          createdAt: session.createdAt || row.created_at,
          updatedAt: session.updatedAt || row.updated_at,
          preview,
        };
        writeAuxiliaryMetadata(db, migrated, true);
        writeAuxiliaryMessages(db, migrated);
      }
      if (columns.has("summary_json"))
        db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN summary_json");
      db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN payload_json");
    }
    if (columns.has("status"))
      db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN status");
    if (columns.has("closed_at"))
      db.exec("ALTER TABLE auxiliary_sessions DROP COLUMN closed_at");
    if (columns.has("allowed_additional_directories_json")) {
      db.exec(
        "ALTER TABLE auxiliary_sessions DROP COLUMN allowed_additional_directories_json",
      );
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length)
      throw new Error("Auxiliary migration foreign key check failed.");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 呼び出し元のトランザクション内で、所有者・版と指定時の本文を照合して下書きを空にする。 */
export function consumeAuxiliaryDraftInTransaction(
  db: DatabaseSync,
  input: AuxiliaryDraftStorageConsumeInput & { expectedText?: string },
): AuxiliaryDraftConsumeResult {
  const session = db
    .prepare(
      "SELECT parent_session_id, run_state FROM auxiliary_sessions WHERE id = ?",
    )
    .get(input.auxiliarySessionId) as
    { parent_session_id: string; run_state: string } | undefined;
  if (!session) return { outcome: "not-found" };
  if (!hasWritableAuxiliaryParent(db, session.parent_session_id))
    return { outcome: "rejected" };
  const row = db
    .prepare(
      `SELECT auxiliary_session_id AS id, parent_session_id, incarnation,
    durable_revision, draft_text, updated_at FROM auxiliary_session_drafts WHERE auxiliary_session_id = ?`,
    )
    .get(input.auxiliarySessionId) as AuxiliaryDraftRow | undefined;
  if (
    session.parent_session_id !== input.parentSessionId ||
    (session.run_state === "running" && input.allowRunningInput !== true) ||
    !row ||
    row.parent_session_id !== input.parentSessionId
  )
    return { outcome: "not-found" };
  if (
    row.incarnation !== input.incarnation ||
    row.durable_revision !== input.expectedDurableRevision ||
    (input.expectedText !== undefined &&
      row.draft_text.trim() !== input.expectedText.trim())
  ) {
    return { outcome: "stale", ack: toDraftAck(row) };
  }
  const next = {
    ...toDraftRecord(row),
    durableRevision: row.durable_revision + 1,
    text: "",
  };
  const result = db
    .prepare(
      `UPDATE auxiliary_session_drafts SET durable_revision = ?, draft_text = '', updated_at = ?
    WHERE auxiliary_session_id = ? AND parent_session_id = ? AND durable_revision = ? AND incarnation = ?`,
    )
    .run(
      next.durableRevision,
      next.updatedAt,
      input.auxiliarySessionId,
      input.parentSessionId,
      input.expectedDurableRevision,
      input.incarnation,
    );
  if (Number(result.changes) !== 1)
    return { outcome: "stale", ack: toDraftAck(row) };
  return { outcome: "consumed", ack: toDraftAck(next) };
}

/** 現行の親テーブルを優先して保存済みのアクセス方式を調べ、存在しないか読み取り専用の場合は更新を認めない。 */
export function hasWritableAuxiliaryParent(
  db: DatabaseSync,
  parentSessionId: string,
): boolean {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('sessions_v6', 'sessions')`,
    )
    .all() as Array<{ name: string }>;
  if (tables.some(({ name }) => name === "sessions_v6")) {
    const row = db
      .prepare(
        `SELECT runtime_policy_json FROM sessions_v6 WHERE id = ? LIMIT 1`,
      )
      .get(parentSessionId) as { runtime_policy_json: string } | undefined;
    if (!row) return false;
    let policy: { accessMode?: unknown; sourceSchemaVersion?: unknown } = {};
    try {
      policy = JSON.parse(row.runtime_policy_json) as typeof policy;
    } catch {
      return false;
    }
    return !isReadOnlySession({
      accessMode:
        policy.accessMode === "legacy_readonly" ? "legacy_readonly" : "active",
      sourceSchemaVersion:
        typeof policy.sourceSchemaVersion === "number"
          ? policy.sourceSchemaVersion
          : CURRENT_SESSION_SCHEMA_VERSION,
    });
  }
  return tables.some(({ name }) => {
    const row = db
      .prepare(
        `SELECT access_mode, source_schema_version FROM ${name} WHERE id = ? LIMIT 1`,
      )
      .get(parentSessionId) as
      { access_mode: string; source_schema_version: number } | undefined;
    return Boolean(
      row &&
      !isReadOnlySession({
        accessMode:
          row.access_mode === "legacy_readonly" ? "legacy_readonly" : "active",
        sourceSchemaVersion: row.source_schema_version,
      }),
    );
  });
}

/** 定義本文や作成要求を投影から外し、公開用 Character 項目と有効な更新時刻を概要に加える。 */
export function parseAuxiliarySessionSummaryRow(
  row: AuxiliarySessionSummaryRow,
): AuxiliarySessionSummary | null {
  const session = parseAuxiliarySessionRow({
    ...row,
    character_snapshot_json: null,
    creation_context_json: null,
    creation_request_json: null,
  });
  if (!session) return null;
  const summary = {
    ...projectAuxiliarySessionSummary(session),
    character: row.character_name ?? "",
    characterDescription: row.character_description ?? "",
  };
  return row.effective_updated_at
    ? { ...summary, updatedAt: row.effective_updated_at }
    : summary;
}

/** 作成日時列がない旧 Auxiliary テーブルにだけ、その列を追加する。 */
export function ensureAuxiliarySessionCreatedAtColumn(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info(auxiliary_sessions)")
    .all() as TableInfoRow[];
  if (columns.some((column) => column.name === "created_at")) {
    return;
  }

  db.exec(
    "ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
  );
}
