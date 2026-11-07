import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import type { ModelSetting } from "./court/models.ts";
import { sharedPipeline, type CaseRecord, type CaseStatus, type CourtEvent, type ModelSnapshot, type PipelineVersion, type RecordedEvent, type Submission } from "./domain/court.ts";
import { newCaseId } from "./lib/case-id.ts";
import type { Operation, OperationClaim, OperationRepository } from "./instruction/source-store.ts";
import { randomUUID } from "node:crypto";
import { authorizeSandboxBinding, committedPhase, type SandboxBinding } from "./instruction/authorization.ts";
import { caseFailureMessage, type SnapshotHealth } from "./lib/admin-notifications.ts";
import { publicToolActivities, ToolActivitySchema, type ToolActivity } from "./domain/tool-activity.ts";
import type { PromptTranslationCache } from "./evidence/prompt-translation.ts";

export { newCaseId };

export interface StoredImage {
  mimeType: string;
  bytes: Buffer;
}

let pool: Pool | undefined;
let schema: Promise<void> | undefined;

// pg already treats prefer, require and verify-ca as verify-full, and warns on
// every cold start that the next major will weaken them to libpq semantics.
// Naming the mode it uses keeps today's verification and silences the warning;
// a URL that opts into uselibpqcompat keeps its own semantics.
export function pinSslMode(connectionString: string): string {
  if (/[?&]uselibpqcompat=/i.test(connectionString)) return connectionString;
  return connectionString.replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/i, "$1verify-full");
}

function connect(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({ connectionString: pinSslMode(connectionString), max: 5 });
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
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS models JSONB;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS pipeline_version INTEGER;
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
       );
       CREATE TABLE IF NOT EXISTS admin_notifications (
         id BIGSERIAL PRIMARY KEY,
         created_at TEXT NOT NULL,
         title TEXT NOT NULL,
         message TEXT NOT NULL,
         case_id TEXT,
         read_at TEXT
       );
       CREATE TABLE IF NOT EXISTS admin_notification_conditions (
         condition_key TEXT PRIMARY KEY,
         state TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS case_source_operations (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         operation_key TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, operation_key)
       );
       CREATE TABLE IF NOT EXISTS case_source_aliases (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         url TEXT NOT NULL,
         source_id TEXT NOT NULL,
         PRIMARY KEY (case_id, url)
       );
       CREATE TABLE IF NOT EXISTS case_phase_sessions (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         session_key TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, session_key)
       );
       CREATE TABLE IF NOT EXISTS case_audit_records (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         record_id TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, record_id)
       );
       CREATE TABLE IF NOT EXISTS case_sandbox_bindings (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         sandbox_id TEXT PRIMARY KEY,
         body JSONB NOT NULL
       );
       CREATE TABLE IF NOT EXISTS prompt_translations (
         key TEXT PRIMARY KEY,
         language TEXT NOT NULL,
         source TEXT NOT NULL,
         translation TEXT NOT NULL,
         model_id TEXT NOT NULL,
         created_at TEXT NOT NULL
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

type CaseRow = { id: string; created_at: string; status: CaseStatus; submission: Submission; owner_id: string | null; error: string | null; revision: number; models: ModelSnapshot | null; pipeline_version: PipelineVersion | null };

export type StoredCaseRecord = CaseRecord & { revision: number };

function toRecord(row: CaseRow): StoredCaseRecord {
  return { id: row.id, createdAt: row.created_at, status: row.status, submission: row.submission, ownerId: row.owner_id ?? undefined, error: row.error ?? undefined, revision: row.revision, ...(row.models ? { models: row.models } : {}), pipelineVersion: row.pipeline_version ?? 1 };
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

// The models configured when the session opened; a restarted session records its own.
export async function saveCaseModels(id: string, models: ModelSnapshot): Promise<void> {
  await (await db()).query("UPDATE cases SET models = $2 WHERE id = $1", [id, JSON.stringify(models)]);
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

// Reuse the public case id, but clear all data produced by the previous run.
// The original submission (including an uploaded image) remains the workflow input.
export async function restartCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>, expectedStatus?: "failed"): Promise<"queued" | "missing" | "active" | "missing-image"> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus }>("SELECT status FROM cases WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return "missing";
    }
    if ((expectedStatus && rows[0]!.status !== expectedStatus) || (rows[0]!.status !== "resolved" && rows[0]!.status !== "failed")) {
      await client.query("ROLLBACK");
      return "active";
    }
    const input = await client.query<{ missing_image: boolean }>(
      "SELECT submission->>'kind' = 'image' AND NOT EXISTS (SELECT 1 FROM images WHERE case_id = $1) AS missing_image FROM cases WHERE id = $1", [id]
    );
    if (input.rows[0]!.missing_image) {
      await client.query("ROLLBACK");
      return "missing-image";
    }
    const aliases = await client.query<{ old_id: string }>("SELECT old_id FROM case_aliases WHERE case_id = $1", [id]);
    await deleteBlobs([id, ...aliases.rows.map((row) => row.old_id)]);
    await client.query("DELETE FROM events WHERE case_id = $1", [id]);
    await client.query("DELETE FROM covers WHERE case_id = $1", [id]);
    for (const table of ["case_source_operations", "case_source_aliases", "case_phase_sessions", "case_audit_records", "case_sandbox_bindings"]) {
      await client.query(`DELETE FROM ${table} WHERE case_id = $1`, [id]);
    }
    await client.query(
      "UPDATE cases SET created_at = $2, status = 'queued', submission = submission - 'resolvedLanguage', error = NULL, revision = revision + 1, models = NULL, pipeline_version = NULL WHERE id = $1",
      [id, new Date().toISOString()]
    );
    await client.query("COMMIT");
    return "queued";
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
      "INSERT INTO cases (id, created_at, status, submission, owner_id, error, revision, models, pipeline_version) SELECT $2, created_at, status, submission, owner_id, error, revision, models, pipeline_version FROM cases WHERE id = $1",
      [oldId, newId]
    );
    if (rowCount !== 1) throw new Error("case " + oldId + " does not exist");
    await client.query("UPDATE events SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE images SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE covers SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE case_aliases SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    for (const table of ["case_source_operations", "case_source_aliases", "case_phase_sessions", "case_audit_records", "case_sandbox_bindings"]) {
      await client.query(`UPDATE ${table} SET case_id = $2 WHERE case_id = $1`, [oldId, newId]);
    }
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

export type CaseProgress = { status: CaseStatus; revision: number; seq: number; activity?: number };

// One small snapshot for SSE, without loading submissions, model output or audit logs.
export async function getCaseProgress(caseId: string): Promise<CaseProgress | undefined> {
  const { rows } = await (await db()).query<CaseProgress>(
    "SELECT status, revision, COALESCE((SELECT MAX(seq) FROM events WHERE case_id = cases.id), 0) AS seq, " +
    "(SELECT COUNT(*)::int FROM case_audit_records WHERE case_id = cases.id AND record_id LIKE 'tool:%') AS activity FROM cases WHERE id = $1",
    [caseId]
  );
  return rows[0];
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

// Select a pipeline only on first opening; shared retries retain their record.
export async function openSession(id: string, requestedPipeline: PipelineVersion | ((submission: Submission) => PipelineVersion | Promise<PipelineVersion>) = 1): Promise<CaseRecord> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    let selected: PipelineVersion = 1;
    if (typeof requestedPipeline === "function") {
      const { rows } = await client.query<{ id: string; submission: Submission }>("SELECT id, submission FROM cases WHERE id = $1 AND pipeline_version IS NULL AND models IS NULL AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM events WHERE case_id = $1) FOR UPDATE", [id]);
      if (rows[0]) selected = await requestedPipeline(rows[0].submission);
    } else selected = requestedPipeline;
    if (sharedPipeline(selected)) await client.query("UPDATE cases SET pipeline_version = " + selected + " WHERE id = $1 AND pipeline_version IS NULL AND models IS NULL AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM events WHERE case_id = $1)", [id]);
    const { rows } = await client.query<CaseRow>("UPDATE cases SET status = 'in_session', error = NULL, pipeline_version = COALESCE(pipeline_version, 1) WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new Error("case " + id + " does not exist");
    if (!sharedPipeline(rows[0].pipeline_version)) await client.query("DELETE FROM events WHERE case_id = $1", [id]);
    await client.query("COMMIT");
    return toRecord(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// User retries are fresh reruns too. The same reset/row lock drops old generated
// state, and only one caller wins the failed -> queued transition.
export async function requeueCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>): Promise<boolean> {
  return await restartCase(id, deleteBlobs, "failed") === "queued";
}

export async function finishCase(id: string, status: "resolved" | "failed", error?: string): Promise<void> {
  if (status === "failed") {
    // The state change and alert commit together. Retried steps cannot duplicate it.
    await (await db()).query(
      `WITH updated AS (UPDATE cases SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'failed' RETURNING id)
       INSERT INTO admin_notifications (created_at, title, message, case_id)
       SELECT $3, 'Falló un caso', $4, id FROM updated`,
      [id, error ?? null, new Date().toISOString(), caseFailureMessage(error)]
    );
    return;
  }
  await (await db()).query("UPDATE cases SET status = $1, error = $2, revision = revision + CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN 1 ELSE 0 END WHERE id = $3", [status, error ?? null, id]);
}

// A resolved case whose stored files are gone becomes a failed run that an admin can
// rerun. The revision guard keeps a concurrent rerun from being marked failed.
export async function failResolvedCase(id: string, revision: number, error: string): Promise<boolean> {
  const { rowCount } = await (await db()).query(
    `WITH updated AS (UPDATE cases SET status = 'failed', error = $3 WHERE id = $1 AND status = 'resolved' AND revision = $2 RETURNING id)
     INSERT INTO admin_notifications (created_at, title, message, case_id)
     SELECT $4, 'Falló un caso', $5, id FROM updated`,
    [id, revision, error, new Date().toISOString(), caseFailureMessage(error)]
  );
  return rowCount === 1;
}

export type AdminNotification = { id: string; created_at: string; title: string; message: string; case_id: string | null; read_at: string | null };

const MAX_NOTIFICATION_ID = 9223372036854775807n;
const validNotificationId = (id: string) => /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= MAX_NOTIFICATION_ID;

export async function listAdminNotifications(before?: string): Promise<AdminNotification[]> {
  if (before && !validNotificationId(before)) before = undefined;
  const { rows } = await (await db()).query<AdminNotification>("SELECT id::text, created_at, title, message, case_id, read_at FROM admin_notifications WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT 101", [before ?? null]);
  return rows;
}

export async function hasUnreadAdminNotifications(): Promise<boolean> {
  const { rows } = await (await db()).query<{ unread: boolean }>("SELECT EXISTS (SELECT 1 FROM admin_notifications WHERE read_at IS NULL) AS unread");
  return rows[0]!.unread;
}

export async function markAdminNotificationsRead(throughId: string): Promise<void> {
  if (!validNotificationId(throughId)) throw new Error("Notificación inválida");
  await (await db()).query("UPDATE admin_notifications SET read_at = $1 WHERE read_at IS NULL AND id <= $2::bigint", [new Date().toISOString(), throughId]);
}

export async function deleteAdminNotification(id: string): Promise<boolean> {
  if (!validNotificationId(id)) throw new Error("Notificación inválida");
  const { rowCount } = await (await db()).query("DELETE FROM admin_notifications WHERE id = $1::bigint", [id]);
  return rowCount === 1;
}

export async function recordSnapshotHealth(health: SnapshotHealth): Promise<boolean> {
  // Only a state transition creates a log entry, including after a problem recurs.
  const { rows } = await (await db()).query(
    `WITH changed AS (
       INSERT INTO admin_notification_conditions (condition_key, state) VALUES ('snapshot', $1)
       ON CONFLICT (condition_key) DO UPDATE SET state = EXCLUDED.state
       WHERE admin_notification_conditions.state <> EXCLUDED.state RETURNING state
     )
     INSERT INTO admin_notifications (created_at, title, message)
     SELECT $2, $3, $4 FROM changed WHERE $5::boolean RETURNING id`,
    [health.state, new Date().toISOString(), health.title ?? "", health.message ?? "", !!health.title]
  );
  return rows.length > 0;
}

// Short row-locked ownership claims; no external I/O runs in this transaction.
async function changeOperation<T>(caseId: string, key: string, change: (operation: Operation) => T, initial?: Operation): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    if (initial) await client.query("INSERT INTO case_source_operations (case_id, operation_key, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [caseId, key, JSON.stringify(initial)]);
    const { rows } = await client.query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 AND operation_key = $2 FOR UPDATE", [caseId, key]);
    const operation = rows[0]?.body;
    if (!operation) throw new Error("Source operation not found");
    if (operation.status === "running" && Date.parse(operation.expiresAt!) <= Date.now()) {
      operation.status = "uncertain";
      operation.error = "Owner expired before checkpoint";
    }
    const value = change(operation);
    await client.query("UPDATE case_source_operations SET body = $3 WHERE case_id = $1 AND operation_key = $2", [caseId, key, JSON.stringify(operation)]);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function requireOperationOwner(operation: Operation, owner: string): void {
  if (operation.status !== "running" || operation.owner !== owner) throw new Error("Operation ownership lost");
}

export const sourceOperationRepository: OperationRepository = {
  claim: async (caseId, key, stage, leaseMs): Promise<OperationClaim> => changeOperation(caseId, key, (operation) => {
    if (operation.stage !== stage) throw new Error("Source operation stage mismatch");
    if (operation.status !== "pending") return { owned: false, operation };
    const owner = randomUUID();
    Object.assign(operation, { status: "running", owner, at: new Date().toISOString(), expiresAt: new Date(Date.now() + leaseMs).toISOString() });
    return { owned: true, operation, owner };
  }, { key, stage, status: "pending", at: new Date().toISOString(), recoveries: [] }),
  get: async (caseId, key) => {
    const { rows } = await (await db()).query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 AND operation_key = $2", [caseId, key]);
    const operation = rows[0]?.body;
    if (operation?.status === "running" && Date.parse(operation.expiresAt!) <= Date.now()) return changeOperation(caseId, key, (current) => current);
    return operation;
  },
  publish: async (caseId, key, owner, result) => changeOperation(caseId, key, (operation) => {
    requireOperationOwner(operation, owner);
    Object.assign(operation, { status: "ready", at: new Date().toISOString(), result });
  }),
  fail: async (caseId, key, owner, error, uncertain) => changeOperation(caseId, key, (operation) => {
    requireOperationOwner(operation, owner);
    Object.assign(operation, { status: uncertain ? "uncertain" : "failed", at: new Date().toISOString(), error });
  }),
  defer: async (caseId, key, owner) => changeOperation(caseId, key, (operation) => {
    requireOperationOwner(operation, owner);
    if (operation.stage !== "canonical") throw new Error("External stages cannot be deferred");
    operation.status = "pending";
    delete operation.owner; delete operation.expiresAt;
  }),
  recover: async (caseId, key, reason) => {
    if (!reason.trim()) throw new Error("Recovery requires an explicit reason");
    await changeOperation(caseId, key, (operation) => {
      if (!["failed", "uncertain"].includes(operation.status)) throw new Error("Only failed/uncertain operations can be recovered");
      operation.recoveries.push({ at: new Date().toISOString(), reason });
      operation.status = "pending";
      delete operation.owner; delete operation.error; delete operation.expiresAt;
    });
  },
  alias: async (caseId, url, sourceId) => {
    const { rows } = await (await db()).query<{ source_id: string }>(
      `INSERT INTO case_source_aliases (case_id, url, source_id) VALUES ($1, $2, $3)
       ON CONFLICT (case_id, url) DO UPDATE SET url = EXCLUDED.url RETURNING source_id`, [caseId, url, sourceId]);
    return rows[0]!.source_id;
  },
  resolve: async (caseId, url) => {
    const { rows } = await (await db()).query<{ source_id: string }>("SELECT source_id FROM case_source_aliases WHERE case_id = $1 AND url = $2", [caseId, url]);
    return rows[0]?.source_id;
  },
};

export async function loadPhaseCheckpoint<T>(caseId: string, key: string): Promise<{ revision: number; body: T } | undefined> {
  const { rows } = await (await db()).query<{ revision: number; body: T }>("SELECT revision, body FROM case_phase_sessions WHERE case_id = $1 AND session_key = $2", [caseId, key]);
  return rows[0];
}

// expectedRevision=-1 creates a checkpoint; all further updates use CAS.
export async function savePhaseCheckpoint<T>(caseId: string, key: string, expectedRevision: number, body: T): Promise<number> {
  const result = expectedRevision === -1
    ? await (await db()).query("INSERT INTO case_phase_sessions (case_id, session_key, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [caseId, key, JSON.stringify(body)])
    : await (await db()).query("UPDATE case_phase_sessions SET body = $4, revision = revision + 1 WHERE case_id = $1 AND session_key = $2 AND revision = $3", [caseId, key, expectedRevision, JSON.stringify(body)]);
  if (result.rowCount !== 1) throw new Error("Concurrent phase-session checkpoint; retry from durable state");
  return expectedRevision + 1;
}

export async function saveCaseAuditRecord(caseId: string, id: string, body: unknown): Promise<void> {
  // The WHERE guard reports conflicts without replacing the first published record.
  const { rowCount } = await (await db()).query(
    `INSERT INTO case_audit_records (case_id, record_id, body) VALUES ($1, $2, $3)
     ON CONFLICT (case_id, record_id) DO UPDATE SET record_id = EXCLUDED.record_id
     WHERE case_audit_records.body = EXCLUDED.body`, [caseId, id, JSON.stringify(body)]);
  if (rowCount !== 1) throw new Error("Public audit record changed on retry");
}

export async function getCaseAuditRecords(caseId: string): Promise<unknown[]> {
  const { rows } = await (await db()).query<{ body: unknown }>("SELECT body FROM case_audit_records WHERE case_id = $1 ORDER BY record_id", [caseId]);
  return rows.map((row) => row.body);
}

// A replay keeps the original invocation time rather than publishing another item.
export async function recordCaseToolActivity(caseId: string, activity: ToolActivity): Promise<void> {
  const record = ToolActivitySchema.parse(activity);
  await (await db()).query(
    "INSERT INTO case_audit_records (case_id, record_id, body) VALUES ($1, $2, $3) ON CONFLICT (case_id, record_id) DO NOTHING",
    [caseId, record.id, JSON.stringify(record)]
  );
}

export async function getCaseToolActivities(caseId: string): Promise<ToolActivity[]> {
  const { rows } = await (await db()).query<{ body: unknown }>(
    "SELECT body FROM case_audit_records WHERE case_id = $1 AND record_id LIKE 'tool:%' ORDER BY body->>'at', record_id", [caseId]
  );
  return publicToolActivities(rows.map((row) => row.body));
}

// Translations of the English prompts for case.jsonl, shared by every case.
// The key hashes the source text and the language (see prompt-translation.ts).
export const promptTranslations: PromptTranslationCache = {
  get: async (keys) => {
    if (!keys.length) return new Map();
    const { rows } = await (await db()).query<{ key: string; translation: string }>("SELECT key, translation FROM prompt_translations WHERE key = ANY($1)", [[...keys]]);
    return new Map(rows.map((row) => [row.key, row.translation]));
  },
  save: async ({ key, language, source, translation, modelId }) => {
    await (await db()).query(
      "INSERT INTO prompt_translations (key, language, source, translation, model_id, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING",
      [key, language, source, translation, modelId, new Date().toISOString()]
    );
  },
};

export async function getSourceOperations(caseId: string): Promise<Operation[]> {
  const { rows } = await (await db()).query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 ORDER BY operation_key", [caseId]);
  return rows.map((row) => row.body);
}

export async function saveSandboxBinding(caseId: string, sandboxId: string, body: SandboxBinding): Promise<void> {
  const { rowCount } = await (await db()).query(
    `INSERT INTO case_sandbox_bindings (case_id, sandbox_id, body) VALUES ($1, $2, $3)
     ON CONFLICT (sandbox_id) DO UPDATE SET body = EXCLUDED.body
     WHERE case_sandbox_bindings.case_id = EXCLUDED.case_id
       AND case_sandbox_bindings.body->>'phaseSessionId' = EXCLUDED.body->>'phaseSessionId'
       AND case_sandbox_bindings.body->>'revoked' = 'false'`, [caseId, sandboxId, JSON.stringify(body)]);
  if (rowCount !== 1) throw new Error("Sandbox binding cannot be reassigned or unrevoked");
}

export async function consumeSandboxBinding(sandboxId: string, caseId?: string): Promise<{ caseId: string; binding: SandboxBinding }> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ case_id: string; body: SandboxBinding; status: string; pipeline_version: number }>(
      `SELECT b.case_id, b.body, c.status, c.pipeline_version FROM case_sandbox_bindings b
       JOIN cases c ON c.id = b.case_id WHERE b.sandbox_id = $1 FOR UPDATE OF b`, [sandboxId]);
    const row = result.rows[0];
    if (!row || (caseId && row.case_id !== caseId)) throw new Error("sandbox_forbidden");
    const events = await client.query<{ body: CourtEvent }>("SELECT body FROM events WHERE case_id = $1 ORDER BY seq", [row.case_id]);
    const session = await client.query<{ body: { id?: string; activeTurn?: { id?: string } } }>("SELECT body FROM case_phase_sessions WHERE case_id = $1 AND session_key = $2", [row.case_id, row.body.sessionKey]);
    authorizeSandboxBinding(row.body, { phase: committedPhase(events.rows.map((event) => event.body)), status: row.status, pipelineVersion: row.pipeline_version, phaseSessionId: session.rows[0]?.body.id, activeTurnId: session.rows[0]?.body.activeTurn?.id });
    row.body.activeTurn!.remainingRequests--;
    await client.query("UPDATE case_sandbox_bindings SET body = $2 WHERE sandbox_id = $1", [sandboxId, JSON.stringify(row.body)]);
    await client.query("COMMIT");
    return { caseId: row.case_id, binding: row.body };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function caseSandboxNames(caseId: string): Promise<string[]> {
  const { rows } = await (await db()).query<{ sandbox_id: string }>("SELECT sandbox_id FROM case_sandbox_bindings WHERE case_id = $1", [caseId]);
  return rows.map((row) => row.sandbox_id);
}

export async function revokeSandboxBindings(caseId: string, phase?: string): Promise<void> {
  await (await db()).query("UPDATE case_sandbox_bindings SET body = jsonb_set(body - 'activeTurn', '{revoked}', 'true'::jsonb) WHERE case_id = $1 AND ($2::text IS NULL OR body->>'phase' = $2)", [caseId, phase ?? null]);
}
