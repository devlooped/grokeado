import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import nextEnv from "@next/env";
import { Pool } from "pg";
import { requireLocalDatabase } from "../src/lib/local-database.ts";

// A fresh schema inside one rolled-back transaction keeps existing local data untouched.
nextEnv.loadEnvConfig(process.cwd(), true);
const pool = new Pool({ connectionString: requireLocalDatabase(), max: 1 });
const client = await pool.connect();
const originalQuery = Pool.prototype.query;
try {
  await client.query("BEGIN");
  const schema = "notification_test_" + randomBytes(8).toString("hex");
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path TO ${schema}`);
  Pool.prototype.query = ((sql: string, values?: unknown[]) => client.query(sql, values)) as typeof Pool.prototype.query;
  const store = await import("../src/store.ts");
  assert.deepEqual(await store.listAdminNotifications(), []);
  await client.query("INSERT INTO cases (id, created_at, status, submission) VALUES ('fixture', '2026-01-01', 'queued', '{}')");
  await store.finishCase("fixture", "failed", "Instruction sandbox bridge requires trusted team/project identities and a harness snapshot");
  await store.finishCase("fixture", "failed", "retry");
  assert.equal((await store.listAdminNotifications()).length, 1, "retried failure is not duplicated");
  assert.equal(await store.hasUnreadAdminNotifications(), true);
  await store.markAdminNotificationsRead((await store.listAdminNotifications())[0]!.id);
  assert.equal(await store.hasUnreadAdminNotifications(), false);
  const warning = { state: "warning:snap", title: "Snapshot", message: "Por vencer" };
  assert.equal(await store.recordSnapshotHealth(warning), true);
  assert.equal(await store.recordSnapshotHealth(warning), false);
  assert.equal(await store.recordSnapshotHealth({ state: "ok:snap" }), false);
  assert.equal(await store.recordSnapshotHealth(warning), true, "a recurring issue creates a new notification");
  const notifications = await store.listAdminNotifications();
  assert.equal(notifications.length, 3);
  assert.equal((await store.listAdminNotifications(notifications[0]!.id)).length, 2);
  assert.equal(await store.requeueCase("fixture"), true);
  await store.finishCase("fixture", "failed", "again");
  assert.equal((await store.listAdminNotifications()).length, 4, "a new attempt can fail again");
  console.log("Local PostgreSQL: notification persistence, deduplication, read state, pagination and transitions verified.");
} finally {
  Pool.prototype.query = originalQuery;
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
