import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  normalizePromptTemplateId,
  parseCreatePromptTemplateInput,
  parseUpdatePromptTemplateInput,
  type PromptTemplate,
} from "../../src-shared/prompt-template.js";
import { CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL } from "../storage/database-schema-v6.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";

/** テンプレートの保存行。作成・更新時刻は SQLite 上の列名で保持する。 */
type PromptTemplateRow = {
  id: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
};

/** SQLite の列を公開用テンプレートへ変換し、作成・更新時刻も引き継ぐ。 */
function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite のユニーク制約違反を拡張エラー番号または名前で判定する。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("errcode" in error && error.errcode === 2067) ||
      ("code" in error && error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE"))
  );
}

/** テンプレートの入力を検証し、SQLite で名前の重複を防ぎながら永続化する。 */
export class PromptTemplateStorage {
  private readonly db: DatabaseSync;

  /** テンプレート用の接続を開き、保存に必要なテーブルを用意する。 */
  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL);
  }

  /** テンプレートを名前の大文字小文字を区別しない順、同順では作成時刻順で返す。 */
  listPromptTemplates(): PromptTemplate[] {
    const rows = this.db
      .prepare(
        `
      SELECT id, name, prompt, created_at, updated_at
      FROM prompt_templates
      ORDER BY name COLLATE NOCASE ASC, created_at ASC
    `,
      )
      .all() as PromptTemplateRow[];
    return rows.map(toPromptTemplate);
  }

  /** 検証済みの名前と本文を新しい ID で保存する。同名の行があれば作成しない。 */
  createPromptTemplate(input: unknown): PromptTemplate {
    const normalized = parseCreatePromptTemplateInput(input);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      this.db
        .prepare(
          `
        INSERT INTO prompt_templates (id, name, prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(id, normalized.name, normalized.prompt, createdAt, createdAt);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error("A template with the same name already exists.");
      }
      throw error;
    }
    return this.requirePromptTemplate(id);
  }

  /** 指定 ID の名前と本文を更新する。存在しない ID や同名との衝突は失敗にする。 */
  updatePromptTemplate(input: unknown): PromptTemplate {
    const normalized = parseUpdatePromptTemplateInput(input);
    const updatedAt = new Date().toISOString();
    try {
      const result = this.db
        .prepare(
          `
        UPDATE prompt_templates
        SET name = ?, prompt = ?, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(normalized.name, normalized.prompt, updatedAt, normalized.id);
      if (result.changes !== 1) {
        throw new Error("The template to update was not found.");
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error("A template with the same name already exists.");
      }
      throw error;
    }
    return this.requirePromptTemplate(normalized.id);
  }

  /** 検証済み ID に該当する行だけを削除し、存在しない場合は失敗とする。 */
  deletePromptTemplate(id: unknown): void {
    const normalizedId = normalizePromptTemplateId(id);
    const result = this.db
      .prepare("DELETE FROM prompt_templates WHERE id = ?")
      .run(normalizedId);
    if (result.changes !== 1) {
      throw new Error("The template to delete was not found.");
    }
  }

  /** テンプレート保存用の SQLite 接続を閉じる。 */
  close(): void {
    this.db.close();
  }

  /** 保存直後の確定したテンプレートを読み直す。行を取得できない場合は失敗とする。 */
  private requirePromptTemplate(id: string): PromptTemplate {
    const row = this.db
      .prepare(
        `
      SELECT id, name, prompt, created_at, updated_at
      FROM prompt_templates
      WHERE id = ?
    `,
      )
      .get(id) as PromptTemplateRow | undefined;
    if (!row) {
      throw new Error("Could not load the template.");
    }
    return toPromptTemplate(row);
  }
}
