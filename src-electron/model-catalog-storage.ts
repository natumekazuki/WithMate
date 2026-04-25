import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  cloneModelCatalogDocument,
  cloneModelCatalogSnapshot,
  getProviderCatalog,
  parseModelCatalogDocument,
  type ModelCatalogDocument,
  type ModelCatalogItem,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import { openAppDatabase } from "./sqlite-connection.js";

type RevisionRow = {
  revision: number;
};

type ProviderRow = {
  revision: number;
  provider_id: string;
  label: string;
  default_model_id: string;
  default_reasoning_effort: string;
  sort_order: number;
};

type ModelRow = {
  revision: number;
  provider_id: string;
  model_id: string;
  label: string;
  reasoning_efforts_json: string;
  sort_order: number;
};

export class ModelCatalogStorage {
  private readonly db: DatabaseSync;
  private readonly bundledCatalogPath: string;

  constructor(dbPath: string, bundledCatalogPath: string) {
    this.db = openAppDatabase(dbPath);
    this.bundledCatalogPath = bundledCatalogPath;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalog_revisions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS model_catalog_providers (
        revision INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        label TEXT NOT NULL,
        default_model_id TEXT NOT NULL,
        default_reasoning_effort TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (revision, provider_id),
        FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS model_catalog_models (
        revision INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        label TEXT NOT NULL,
        reasoning_efforts_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (revision, provider_id, model_id),
        FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
      );
    `);
  }

  private readBundledCatalogDocument(): ModelCatalogDocument {
    const raw = fs.readFileSync(this.bundledCatalogPath, "utf8");
    return parseModelCatalogDocument(JSON.parse(raw));
  }

  private mergeBundledProvidersIntoActiveCatalog(
    activeCatalog: ModelCatalogSnapshot,
    bundledCatalog: ModelCatalogDocument,
  ): ModelCatalogDocument | null {
    const activeProvidersById = new Map(activeCatalog.providers.map((provider) => [provider.id, provider] as const));
    const mergedProviders: ModelCatalogProvider[] = [];
    let changed = false;

    for (const bundledProvider of bundledCatalog.providers) {
      const activeProvider = activeProvidersById.get(bundledProvider.id);
      if (activeProvider) {
        mergedProviders.push(activeProvider);
        activeProvidersById.delete(bundledProvider.id);
        continue;
      }

      mergedProviders.push(bundledProvider);
      changed = true;
    }

    for (const activeProvider of activeProvidersById.values()) {
      mergedProviders.push(activeProvider);
    }

    if (!changed) {
      return null;
    }

    return {
      providers: cloneModelCatalogDocument({ providers: mergedProviders }).providers,
    };
  }

  private getActiveRevision(): number | null {
    const row = this.db
      .prepare(`SELECT revision FROM model_catalog_revisions WHERE is_active = 1 ORDER BY revision DESC LIMIT 1`)
      .get() as RevisionRow | undefined;

    return row?.revision ?? null;
  }

  private toSnapshot(revision: number): ModelCatalogSnapshot | null {
    const providerRows = this.db
      .prepare(`
        SELECT revision, provider_id, label, default_model_id, default_reasoning_effort, sort_order
        FROM model_catalog_providers
        WHERE revision = ?
        ORDER BY sort_order ASC, provider_id ASC
      `)
      .all(revision) as ProviderRow[];

    if (providerRows.length === 0) {
      return null;
    }

    const modelRows = this.db
      .prepare(`
        SELECT revision, provider_id, model_id, label, reasoning_efforts_json, sort_order
        FROM model_catalog_models
        WHERE revision = ?
        ORDER BY provider_id ASC, sort_order ASC, model_id ASC
      `)
      .all(revision) as ModelRow[];

    const modelsByProvider = new Map<string, ModelCatalogItem[]>();
    for (const modelRow of modelRows) {
      const providerModels = modelsByProvider.get(modelRow.provider_id) ?? [];
      providerModels.push({
        id: modelRow.model_id,
        label: modelRow.label,
        reasoningEfforts: JSON.parse(modelRow.reasoning_efforts_json),
      });
      modelsByProvider.set(modelRow.provider_id, providerModels);
    }

    const providers: ModelCatalogProvider[] = providerRows.map((providerRow) => ({
      id: providerRow.provider_id,
      label: providerRow.label,
      defaultModelId: providerRow.default_model_id,
      defaultReasoningEffort: providerRow.default_reasoning_effort as ModelCatalogProvider["defaultReasoningEffort"],
      models: modelsByProvider.get(providerRow.provider_id) ?? [],
    }));

    return cloneModelCatalogSnapshot({ revision, providers });
  }

  private writeCatalogDocument(
    document: ModelCatalogDocument,
    source: "bundled" | "imported" | "rollback",
    options?: { resetHistory?: boolean },
  ): ModelCatalogSnapshot {
    const normalized = parseModelCatalogDocument(document);
    const importedAt = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");

    try {
      if (options?.resetHistory) {
        this.db.exec("DELETE FROM model_catalog_revisions;");
        this.db.exec("DELETE FROM sqlite_sequence WHERE name = 'model_catalog_revisions';");
      } else {
        this.db.prepare(`UPDATE model_catalog_revisions SET is_active = 0 WHERE is_active = 1`).run();
      }

      const insertRevision = this.db.prepare(`
        INSERT INTO model_catalog_revisions (source, imported_at, is_active)
        VALUES (?, ?, 1)
      `);
      const result = insertRevision.run(source, importedAt);
      const revision = Number(result.lastInsertRowid);

      const insertProvider = this.db.prepare(`
        INSERT INTO model_catalog_providers (
          revision,
          provider_id,
          label,
          default_model_id,
          default_reasoning_effort,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertModel = this.db.prepare(`
        INSERT INTO model_catalog_models (
          revision,
          provider_id,
          model_id,
          label,
          reasoning_efforts_json,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      normalized.providers.forEach((provider, providerIndex) => {
        insertProvider.run(
          revision,
          provider.id,
          provider.label,
          provider.defaultModelId,
          provider.defaultReasoningEffort,
          providerIndex,
        );

        provider.models.forEach((model, modelIndex) => {
          insertModel.run(
            revision,
            provider.id,
            model.id,
            model.label,
            JSON.stringify(model.reasoningEfforts),
            modelIndex,
          );
        });
      });

      this.db.exec("COMMIT");
      return this.toSnapshot(revision) ?? { revision, providers: cloneModelCatalogDocument(normalized).providers };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureSeeded(): ModelCatalogSnapshot {
    const activeCatalog = this.getActiveCatalog();
    if (activeCatalog) {
      const mergedCatalog = this.mergeBundledProvidersIntoActiveCatalog(activeCatalog, this.readBundledCatalogDocument());
      if (!mergedCatalog) {
        return activeCatalog;
      }

      return this.writeCatalogDocument(mergedCatalog, "bundled");
    }

    return this.writeCatalogDocument(this.readBundledCatalogDocument(), "bundled");
  }

  getActiveCatalog(): ModelCatalogSnapshot | null {
    const revision = this.getActiveRevision();
    if (!revision) {
      return null;
    }

    return this.toSnapshot(revision);
  }

  getCatalog(revision?: number | null): ModelCatalogSnapshot | null {
    if (revision == null) {
      return this.getActiveCatalog();
    }

    return this.toSnapshot(revision);
  }

  getProviderCatalog(revision: number | null | undefined, providerId: string): ModelCatalogProvider | null {
    const snapshot = this.getCatalog(revision);
    if (!snapshot) {
      return null;
    }

    const provider = getProviderCatalog(snapshot.providers, providerId);
    return provider ? JSON.parse(JSON.stringify(provider)) : null;
  }

  importCatalogDocument(
    document: ModelCatalogDocument,
    source: "bundled" | "imported" | "rollback" = "imported",
  ): ModelCatalogSnapshot {
    return this.writeCatalogDocument(document, source);
  }

  resetToBundled(): ModelCatalogSnapshot {
    return this.writeCatalogDocument(this.readBundledCatalogDocument(), "bundled", { resetHistory: true });
  }

  exportCatalogDocument(revision?: number | null): ModelCatalogDocument | null {
    const snapshot = this.getCatalog(revision);
    if (!snapshot) {
      return null;
    }

    return cloneModelCatalogDocument({ providers: snapshot.providers });
  }

  close(): void {
    this.db.close();
  }
}
