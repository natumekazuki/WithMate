import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  normalizePromptTemplateId,
  parseCreatePromptTemplateInput,
  parseUpdatePromptTemplateInput,
  type PromptTemplate,
} from "../src/prompt-template.js";
import { CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type PromptTemplateRow = {
  id: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
};

function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (
      ("errcode" in error && error.errcode === 2067)
      || ("code" in error && error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE")
    );
}

export class PromptTemplateStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    this.db.exec(CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL);
  }

  listPromptTemplates(): PromptTemplate[] {
    const rows = this.db.prepare(`
      SELECT id, name, prompt, created_at, updated_at
      FROM prompt_templates
      ORDER BY name COLLATE NOCASE ASC, created_at ASC
    `).all() as PromptTemplateRow[];
    return rows.map(toPromptTemplate);
  }

  createPromptTemplate(input: unknown): PromptTemplate {
    const normalized = parseCreatePromptTemplateInput(input);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO prompt_templates (id, name, prompt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, normalized.name, normalized.prompt, createdAt, createdAt);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error("A template with the same name already exists.");
      }
      throw error;
    }
    return this.requirePromptTemplate(id);
  }

  updatePromptTemplate(input: unknown): PromptTemplate {
    const normalized = parseUpdatePromptTemplateInput(input);
    const updatedAt = new Date().toISOString();
    try {
      const result = this.db.prepare(`
        UPDATE prompt_templates
        SET name = ?, prompt = ?, updated_at = ?
        WHERE id = ?
      `).run(normalized.name, normalized.prompt, updatedAt, normalized.id);
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

  deletePromptTemplate(id: unknown): void {
    const normalizedId = normalizePromptTemplateId(id);
    const result = this.db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(normalizedId);
    if (result.changes !== 1) {
      throw new Error("The template to delete was not found.");
    }
  }

  close(): void {
    this.db.close();
  }

  private requirePromptTemplate(id: string): PromptTemplate {
    const row = this.db.prepare(`
      SELECT id, name, prompt, created_at, updated_at
      FROM prompt_templates
      WHERE id = ?
    `).get(id) as PromptTemplateRow | undefined;
    if (!row) {
      throw new Error("Could not load the template.");
    }
    return toPromptTemplate(row);
  }
}
