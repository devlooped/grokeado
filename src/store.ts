import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { CaseRecord, CaseStatus, CourtEvent, RecordedEvent, Submission } from "./domain/court.ts";

export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.GROKEADO_DATA ?? "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(UPLOADS_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, "grokeado.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      submission TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      case_id TEXT NOT NULL REFERENCES cases(id),
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (case_id, seq)
    );
  `);
  return db;
}

type CaseRow = { id: string; created_at: string; status: CaseStatus; submission: string; error: string | null };

function toRecord(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    submission: JSON.parse(row.submission),
    error: row.error ?? undefined,
  };
}

export function newCaseId(): string {
  return randomBytes(6).toString("base64url");
}

export function createCase(id: string, submission: Submission): void {
  open()
    .prepare("INSERT INTO cases (id, created_at, status, submission) VALUES (?, ?, 'queued', ?)")
    .run(id, new Date().toISOString(), JSON.stringify(submission));
}

export function getCase(id: string): CaseRecord | undefined {
  const row = open().prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
  return row && toRecord(row);
}

export function listCases(limit = 20): CaseRecord[] {
  const rows = open().prepare("SELECT * FROM cases ORDER BY created_at DESC LIMIT ?").all(limit) as CaseRow[];
  return rows.map(toRecord);
}

export function getEvents(caseId: string): RecordedEvent[] {
  const rows = open().prepare("SELECT seq, at, body FROM events WHERE case_id = ? ORDER BY seq").all(caseId) as {
    seq: number;
    at: string;
    body: string;
  }[];
  return rows.map((r) => ({ ...JSON.parse(r.body), seq: r.seq, at: r.at }));
}

export function appendEvent(caseId: string, event: CourtEvent): RecordedEvent {
  const d = open();
  const { next } = d.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE case_id = ?").get(caseId) as { next: number };
  const at = new Date().toISOString();
  d.prepare("INSERT INTO events (case_id, seq, at, body) VALUES (?, ?, ?, ?)").run(caseId, next, at, JSON.stringify(event));
  return { ...event, seq: next, at };
}

export function claimNextCase(): CaseRecord | undefined {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d
      .prepare(
        "UPDATE cases SET status = 'in_session', error = NULL WHERE id = (SELECT id FROM cases WHERE status = 'queued' ORDER BY created_at LIMIT 1) RETURNING *"
      )
      .get() as CaseRow | undefined;
    if (row) d.prepare("DELETE FROM events WHERE case_id = ?").run(row.id);
    d.exec("COMMIT");
    return row && toRecord(row);
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function requeueInterruptedCases(): number {
  return Number(open().prepare("UPDATE cases SET status = 'queued' WHERE status = 'in_session'").run().changes);
}

export function requeueCase(id: string): void {
  open().prepare("UPDATE cases SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'").run(id);
}

export function finishCase(id: string, status: "resolved" | "failed", error?: string): void {
  open().prepare("UPDATE cases SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
}
