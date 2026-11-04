import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import type { ModelSetting } from "./court/models.ts";
import type { CaseRecord, CaseStatus, RecordedEvent, Submission } from "./domain/court.ts";
import { newCaseId } from "./lib/case-id.ts";

export { newCaseId };

export interface StoredImage {
  mimeType: string;
  bytes: Buffer;
}

let pool: Pool | undefined;
let schema: Promise<void> | undefined;

function connect(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({ connectionString, max: 5 });
  attachDatabasePool(pool);
  return pool;
}

function migrateLegacySeat(value: unknown, field?: string): unknown {
  if (typeof value === "string") return value === "openai" && (field === "by" || field === "to") ? "chatgpt" : value;
  if (Array.isArray(value)) return value.map((child) => migrateLegacySeat(child));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key === "openai" ? "chatgpt" : key, migrateLegacySeat(child, key)]));
}

async function db(): Promise<Pool> {
  const p = connect();
  schema ??= p
    .query(
      `CREATE TABLE IF NOT EXISTS cases (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         status TEXT NOT NULL,
         submission JSONB NOT NULL,
         owner_id TEXT,
         error TEXT
       );
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS owner_id TEXT;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
       CREATE TABLE IF NOT EXISTS events (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         at TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, seq)
       );
       CREATE TABLE IF NOT EXISTS images (
         case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
         mime_type TEXT NOT NULL,
         bytes BYTEA NOT NULL
       );
       CREATE TABLE IF NOT EXISTS covers (
         case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
         mime_type TEXT NOT NULL,
         bytes BYTEA NOT NULL,
         source_url TEXT,
         generated BOOLEAN NOT NULL,
         saved_at TEXT
       );
       ALTER TABLE covers ADD COLUMN IF NOT EXISTS saved_at TEXT;
       CREATE TABLE IF NOT EXISTS case_aliases (
         old_id TEXT PRIMARY KEY,
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE
       );
       CREATE TABLE IF NOT EXISTS model_settings (
         role TEXT PRIMARY KEY,
         model_id TEXT NOT NULL,
         effort TEXT,
         updated_at TEXT NOT NULL,
         updated_by TEXT NOT NULL
       );`
    )
    .then(async () => {
      const { rows } = await p.query<{ case_id: string; seq: number; body: unknown }>(
        `SELECT case_id, seq, body FROM events WHERE body::text LIKE '%"openai"%'`
      );
      for (const row of rows) {
        await p.query("UPDATE events SET body = $1 WHERE case_id = $2 AND seq = $3", [JSON.stringify(migrateLegacySeat(row.body)), row.case_id, row.seq]);
      }
    })
    .catch((err: unknown) => {
      schema = undefined;
      throw err;
    });
  await schema;
  return p;
}

type CaseRow = { id: string; created_at: string; status: CaseStatus; submission: Submission; owner_id: string | null; error: string | null; revision: number };

export type StoredCaseRecord = CaseRecord & { revision: number };

function toRecord(row: CaseRow): StoredCaseRecord {
  return { id: row.id, createdAt: row.created_at, status: row.status, submission: row.submission, ownerId: row.owner_id ?? undefined, error: row.error ?? undefined, revision: row.revision };
}

export async function createCase(id: string, submission: Submission, image?: Buffer, ownerId?: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO cases (id, created_at, status, submission, owner_id) VALUES ($1, $2, 'queued', $3, $4)", [id, new Date().toISOString(), JSON.stringify(submission), ownerId ?? null]);
    if (image && submission.kind === "image") await client.query("INSERT INTO images (case_id, mime_type, bytes) VALUES ($1, $2, $3)", [id, submission.mimeType, image]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Random ids can collide; a taken id (or a retired alias) is retried with a new one.
export async function createNewCase(submission: Submission, image?: Buffer, ownerId?: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const id = newCaseId();
    const { rowCount } = await (await db()).query("SELECT 1 FROM case_aliases WHERE old_id = $1", [id]);
    if (rowCount) continue;
    try {
      await createCase(id, submission, image, ownerId);
      return id;
    } catch (err) {
      if (attempt >= 4 || (err as { code?: string }).code !== "23505") throw err;
    }
  }
}

// Persist the detection so retries reuse the same language as the first attempt.
export async function saveCaseLanguage(id: string, language: string): Promise<void> {
  await (await db()).query("UPDATE cases SET submission = jsonb_set(submission, '{resolvedLanguage}', to_jsonb($2::text)) WHERE id = $1", [id, language]);
}

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

// Admin overrides of the default model for each role; a missing row means the default.
export async function getModelSettings(): Promise<ModelSetting[]> {
  const { rows } = await (await db()).query<{ role: string; model_id: string; effort: string | null }>("SELECT role, model_id, effort FROM model_settings ORDER BY role");
  return rows.map((row) => ({ role: row.role, modelId: row.model_id, effort: row.effort }));
}

// A null setting restores the default by removing the override.
export async function saveModelSettings(changes: ReadonlyArray<{ role: string; setting: { modelId: string; effort: string | null } | null }>, updatedBy: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const now = new Date().toISOString();
    for (const { role, setting } of changes) {
      if (!setting) await client.query("DELETE FROM model_settings WHERE role = $1", [role]);
      else await client.query(
        `INSERT INTO model_settings (role, model_id, effort, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (role) DO UPDATE SET model_id = EXCLUDED.model_id, effort = EXCLUDED.effort, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [role, setting.modelId, setting.effort, now, updatedBy]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Blob writes hold a shared row lock so deletion waits for in-flight uploads;
// uploads starting after deletion cannot recreate orphaned artifacts.
export async function withCaseWriteLock<T>(id: string, write: () => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT id FROM cases WHERE id = $1 FOR KEY SHARE", [id]);
    if (!result.rows.length) throw new Error("El caso ya no existe.");
    const value = await write();
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Keep the row locked through Blob cleanup. A failed cleanup leaves the case
// available for a retry; cascading foreign keys remove events, images, covers
// and aliases only after cleanup succeeds.
export async function deleteCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>): Promise<"deleted" | "missing" | "active"> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus }>("SELECT status FROM cases WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return "missing";
    }
    if (rows[0]!.status !== "resolved" && rows[0]!.status !== "failed") {
      await client.query("ROLLBACK");
      return "active";
    }
    const aliases = await client.query<{ old_id: string }>("SELECT old_id FROM case_aliases WHERE case_id = $1", [id]);
    await deleteBlobs([id, ...aliases.rows.map((row) => row.old_id)]);
    await client.query("DELETE FROM cases WHERE id = $1", [id]);
    await client.query("COMMIT");
    return "deleted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Old ids keep resolving after a case is renamed, so shared links still work.
export async function findCaseAlias(oldId: string): Promise<string | undefined> {
  const { rows } = await (await db()).query<{ case_id: string }>("SELECT case_id FROM case_aliases WHERE old_id = $1", [oldId]);
  return rows[0]?.case_id;
}

export async function caseIdTaken(id: string): Promise<boolean> {
  const { rowCount } = await (await db()).query("SELECT 1 FROM cases WHERE id = $1 UNION ALL SELECT 1 FROM case_aliases WHERE old_id = $1", [id]);
  return Boolean(rowCount);
}

// Moves a case and its rows to a new id in one transaction and records the old id as an alias.
export async function renameCase(oldId: string, newId: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      "INSERT INTO cases (id, created_at, status, submission, owner_id, error, revision) SELECT $2, created_at, status, submission, owner_id, error, revision FROM cases WHERE id = $1",
      [oldId, newId]
    );
    if (rowCount !== 1) throw new Error("case " + oldId + " does not exist");
    await client.query("UPDATE events SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE images SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE covers SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE case_aliases SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("DELETE FROM cases WHERE id = $1", [oldId]);
    await client.query("INSERT INTO case_aliases (old_id, case_id) VALUES ($1, $2)", [oldId, newId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCase(id: string): Promise<StoredCaseRecord | undefined> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
  return rows[0] && toRecord(rows[0]);
}

export async function listCases(limit = 20): Promise<StoredCaseRecord[]> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(toRecord);
}

export async function getImage(caseId: string): Promise<StoredImage | undefined> {
  const { rows } = await (await db()).query<{ mime_type: string; bytes: Buffer }>("SELECT mime_type, bytes FROM images WHERE case_id = $1", [caseId]);
  return rows[0] && { mimeType: rows[0].mime_type, bytes: rows[0].bytes };
}

export interface StoredCover extends StoredImage {
  sourceUrl?: string;
  generated: boolean;
}

// Idempotent: a retried step or a regenerated cover replaces the previous one.
export async function saveCover(caseId: string, cover: Omit<StoredCover, "bytes"> & { bytes: Uint8Array }): Promise<void> {
  await (await db()).query(
    `INSERT INTO covers (case_id, mime_type, bytes, source_url, generated, saved_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (case_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, bytes = EXCLUDED.bytes, source_url = EXCLUDED.source_url, generated = EXCLUDED.generated, saved_at = EXCLUDED.saved_at`,
    [caseId, cover.mimeType, Buffer.from(cover.bytes), cover.sourceUrl ?? null, cover.generated, new Date().toISOString()]
  );
}

export async function getCover(caseId: string): Promise<StoredCover | undefined> {
  const { rows } = await (await db()).query<{ mime_type: string; bytes: Buffer; source_url: string | null; generated: boolean }>(
    "SELECT mime_type, bytes, source_url, generated FROM covers WHERE case_id = $1",
    [caseId]
  );
  return rows[0] && { mimeType: rows[0].mime_type, bytes: rows[0].bytes, sourceUrl: rows[0].source_url ?? undefined, generated: rows[0].generated };
}

// Case id -> cover version, so a regenerated cover gets a new URL and the old one can be cached forever.
export async function coverVersions(caseIds: readonly string[]): Promise<Map<string, string>> {
  if (!caseIds.length) return new Map();
  const { rows } = await (await db()).query<{ case_id: string; saved_at: string | null }>("SELECT case_id, saved_at FROM covers WHERE case_id = ANY($1)", [caseIds]);
  return new Map(rows.map((r) => [r.case_id, r.saved_at ? String(Date.parse(r.saved_at)) : "0"]));
}

export async function getEvents(caseId: string): Promise<RecordedEvent[]> {
  const { rows } = await (await db()).query<{ seq: number; at: string; body: object }>("SELECT seq, at, body FROM events WHERE case_id = $1 ORDER BY seq", [caseId]);
  return rows.map((r) => ({ ...r.body, seq: r.seq, at: r.at }) as RecordedEvent);
}

// Idempotent: a retried step re-inserts the same (case_id, seq) rows and they are ignored.
export async function recordEvents(caseId: string, events: readonly RecordedEvent[]): Promise<void> {
  if (!events.length) return;
  const values: unknown[] = [caseId];
  const rows = events.map(({ seq, at, ...body }) => {
    values.push(seq, at, JSON.stringify(body));
    return "($1, $" + (values.length - 2) + ", $" + (values.length - 1) + ", $" + values.length + ")";
  });
  // If a closed case receives new events, invalidate its old revision atomically.
  await (await db()).query(
    "WITH inserted AS (INSERT INTO events (case_id, seq, at, body) VALUES " + rows.join(", ") +
    " ON CONFLICT (case_id, seq) DO NOTHING RETURNING case_id) " +
    "UPDATE cases SET revision = revision + 1 WHERE id = $1 AND status = 'resolved' AND EXISTS (SELECT 1 FROM inserted)",
    values
  );
}

// Idempotent: a restarted session always begins from an empty record.
export async function openSession(id: string): Promise<CaseRecord> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CaseRow>("UPDATE cases SET status = 'in_session', error = NULL WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new Error("case " + id + " does not exist");
    await client.query("DELETE FROM events WHERE case_id = $1", [id]);
    await client.query("COMMIT");
    return toRecord(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Only one caller wins the failed -> queued transition, so a retry starts exactly one session.
export async function requeueCase(id: string): Promise<boolean> {
  const { rowCount } = await (await db()).query("UPDATE cases SET status = 'queued', error = NULL WHERE id = $1 AND status = 'failed'", [id]);
  return rowCount === 1;
}

export async function finishCase(id: string, status: "resolved" | "failed", error?: string): Promise<void> {
  await (await db()).query("UPDATE cases SET status = $1, error = $2, revision = revision + CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN 1 ELSE 0 END WHERE id = $3", [status, error ?? null, id]);
}
