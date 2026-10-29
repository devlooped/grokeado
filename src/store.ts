import { attachDatabasePool } from "@vercel/functions";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import type { CaseRecord, CaseStatus, RecordedEvent, Submission } from "./domain/court.ts";

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

async function db(): Promise<Pool> {
  const p = connect();
  schema ??= p
    .query(
      `CREATE TABLE IF NOT EXISTS cases (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         status TEXT NOT NULL,
         submission JSONB NOT NULL,
         error TEXT
       );
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
       );`
    )
    .then(() => undefined)
    .catch((err: unknown) => {
      schema = undefined;
      throw err;
    });
  await schema;
  return p;
}

type CaseRow = { id: string; created_at: string; status: CaseStatus; submission: Submission; error: string | null };

function toRecord(row: CaseRow): CaseRecord {
  return { id: row.id, createdAt: row.created_at, status: row.status, submission: row.submission, error: row.error ?? undefined };
}

export function newCaseId(): string {
  return randomBytes(6).toString("base64url");
}

export async function createCase(id: string, submission: Submission, image?: Buffer): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO cases (id, created_at, status, submission) VALUES ($1, $2, 'queued', $3)", [id, new Date().toISOString(), JSON.stringify(submission)]);
    if (image && submission.kind === "image") await client.query("INSERT INTO images (case_id, mime_type, bytes) VALUES ($1, $2, $3)", [id, submission.mimeType, image]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCase(id: string): Promise<CaseRecord | undefined> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
  return rows[0] && toRecord(rows[0]);
}

export async function listCases(limit = 20): Promise<CaseRecord[]> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(toRecord);
}

export async function getImage(caseId: string): Promise<StoredImage | undefined> {
  const { rows } = await (await db()).query<{ mime_type: string; bytes: Buffer }>("SELECT mime_type, bytes FROM images WHERE case_id = $1", [caseId]);
  return rows[0] && { mimeType: rows[0].mime_type, bytes: rows[0].bytes };
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
  await (await db()).query("INSERT INTO events (case_id, seq, at, body) VALUES " + rows.join(", ") + " ON CONFLICT (case_id, seq) DO NOTHING", values);
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
  await (await db()).query("UPDATE cases SET status = $1, error = $2 WHERE id = $3", [status, error ?? null, id]);
}
