import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { UNKNOWN_CHARACTER_OWNER_ID } from "../../src-shared/character/character-owner.js";
import type { SessionCharacterUsage } from "../../src-shared/session/session-state.js";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";

type UsageRow = {
  id: string;
  characterId: string | null;
  at: string;
  policy?: string;
  kind?: string;
};

async function withUsageRows(
  rows: readonly UsageRow[],
  check: (usage: SessionCharacterUsage[]) => void,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "withmate-character-usage-v6-"));
  const dbPath = path.join(directory, "withmate-v6.db");
  let storage: SessionStorageV6 | null = null;
  try {
    storage = new SessionStorageV6(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON; BEGIN;");
      const character = db.prepare(`
        INSERT OR IGNORE INTO characters (id, name, created_at, updated_at)
        VALUES (?, ?, '', '')
      `);
      const insert = db.prepare(`
        INSERT INTO sessions_v6 (
          id, title, state, session_kind, provider_id, catalog_revision, model_id,
          approval_mode, runtime_policy_json, character_id, character_snapshot_json,
          created_at, updated_at, last_active_at
        ) VALUES (?, '', 'completed', ?, 'codex', 1, '', 'default', ?, ?, '{}', '', ?, ?)
      `);
      for (const row of rows) {
        if (row.characterId !== null) {
          character.run(row.characterId, row.characterId);
        }
        insert.run(row.id, row.kind ?? "default", row.policy ?? "{}", row.characterId, row.at, row.at);
      }
      db.exec("COMMIT;");
    } finally {
      db.close();
    }
    check(storage.listSessionCharacterUsage());
  } finally {
    storage?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

// @test-value v2
// kind = "contract"
// claim = "Character usageは通常SessionのSQL effective IDごとの最新行を時刻/id降順で選び、relational優先・JSON fallback・owner回復を維持する"
// oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts#listSessionCharacterUsage" }
// fault = "無効JSONを評価する、空IDやauthoringを採用する、tie-breakを失う、またはJS正規化後に異なるSQL IDをまとめてしまう"
// observable = "listSessionCharacterUsageのcharacterId/sessionKind配列全体と順序"
// observation_boundary = "public-boundary"
// scope = "session-storage-v6-character-usage"
// lifecycle = "permanent"
// impact = "Homeの使用履歴とランダムCharacter選択の重みが変わる、または履歴取得が失敗する"
// distinction = "既存summary page testは通常ID二つだけであり、型/buildは実DBのJSON評価・SQL TRIMとJS trimの差・tie-breakを検出できない。小さいmetadata fixtureで継続費用を抑える"
// @end-test-value
test("Character usage は fallback・空ID・無効JSON・owner回復・同時刻順を保持する", async () => {
  await withUsageRows([
    { id: "tie-a", characterId: "char-a", at: "2026-10-01" },
    { id: "tie-y", characterId: "char-b", at: "2026-10-01" },
    { id: "tie-z", characterId: "char-a", at: "2026-10-01", policy: "invalid JSON" },
    { id: "fallback-space", characterId: "  ", at: "2026-10-02", policy: '{"characterId":"  char-c  "}' },
    { id: "fallback-null", characterId: null, at: "2026-10-03", policy: '{"characterId":"char-d"}' },
    { id: "fallback-empty", characterId: "", at: "2026-10-04", policy: '{"characterId":"char-e"}' },
    { id: "relational", characterId: " char-f ", at: "2026-10-05", policy: '{"characterId":"ignored"}' },
    { id: "owner-whitespace", characterId: "\t\n", at: "2026-10-06", policy: '{"characterId":"ignored"}' },
    { id: "owner-reserved", characterId: null, at: "2026-10-07", policy: JSON.stringify({ characterId: UNKNOWN_CHARACTER_OWNER_ID }) },
    { id: "normalized-alias", characterId: "\tchar-a\n", at: "2026-10-08" },
    { id: "fallback-number", characterId: null, at: "2026-10-09", policy: '{"characterId":23}' },
    { id: "fallback-boolean", characterId: null, at: "2026-10-10", policy: '{"characterId":false}' },
    { id: "fallback-object", characterId: null, at: "2026-10-11", policy: '{"characterId":{"id":"nested"}}' },
    { id: "missing", characterId: null, at: "2026-10-20" },
    { id: "invalid", characterId: null, at: "2026-10-20", policy: "invalid JSON" },
    { id: "empty", characterId: "", at: "2026-10-20", policy: '{"characterId":"  "}' },
    { id: "null", characterId: null, at: "2026-10-20", policy: '{"characterId":null}' },
    { id: "authoring", characterId: "char-a", at: "2026-10-20", kind: "character-authoring" },
    { id: "other-kind", characterId: "char-b", at: "2026-10-20", kind: "other" },
  ], (usage) => {
    assert.deepEqual(usage, [
      '{"id":"nested"}', "0", "23", "char-a", UNKNOWN_CHARACTER_OWNER_ID,
      UNKNOWN_CHARACTER_OWNER_ID, "char-f", "char-e", "char-d", "char-c", "char-a", "char-b",
    ].map((characterId) => ({ characterId, sessionKind: "default" })));
  });
});

// @test-value v2
// kind = "contract"
// claim = "少数/多数Characterの通常Session履歴ではrelationalとfallbackの同じIDを一件にまとめ、使用順と返却内容を保つ"
// oracle = { type = "contract", ref = "src-electron/session/session-storage-v6.ts#listSessionCharacterUsage" }
// fault = "混在するID経路を別Characterと数える、古い行を選ぶ、または多数Characterの履歴を欠落させる"
// observable = "3000 Sessionから取得したusage全件のcharacterId/sessionKindと順序"
// observation_boundary = "public-boundary"
// scope = "session-storage-v6-character-usage-distribution"
// lifecycle = "permanent"
// impact = "Character使用履歴の欠落や重複でHomeのランダム選択の重みが変わる"
// distinction = "小さいedge fixtureと異なり20/3000 Character分布の全返却を固定した入力規則から検証する。時間閾値は置かず、metadataのみのbatch挿入でCI費用を限定する"
// @end-test-value
test("Character usage は少数/多数Character分布の全件を最新使用順で返す", async () => {
  const count = 3000;
  for (const characterCount of [20, count]) {
    const rows = Array.from({ length: count }, (_, index): UsageRow => {
      const characterId = `char-${index % characterCount}`;
      return {
        id: `session-${String(index).padStart(6, "0")}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 3))).toISOString(),
        characterId: index % 5 === 0 ? null : characterId,
        policy: JSON.stringify({ characterId }),
      };
    });
    await withUsageRows(rows, (usage) => {
      assert.deepEqual(usage, Array.from({ length: characterCount }, (_, index) => ({
        characterId: `char-${(count - 1 - index) % characterCount}`,
        sessionKind: "default",
      })));
    });
  }
});
