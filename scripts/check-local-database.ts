import nextEnv from "@next/env";
import { Pool } from "pg";
import { requireLocalDatabase, LOCAL_DATABASE } from "../src/lib/local-database.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const pool = new Pool({ connectionString: requireLocalDatabase(), connectionTimeoutMillis: 5_000 });
try {
  const { rows } = await pool.query<{ database: string; user: string; server: string }>("SELECT current_database() AS database, current_user AS user, inet_server_addr()::text AS server");
  if (rows[0]?.database !== LOCAL_DATABASE || rows[0]?.user !== "grokeado") throw new Error("Local database identity mismatch.");
  console.log(`Local PostgreSQL verified: database=${LOCAL_DATABASE}, user=grokeado (via guarded loopback connection).`);
} finally {
  await pool.end();
}
