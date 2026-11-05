import assert from "node:assert/strict";
import test from "node:test";
import { requireLocalDatabase } from "./local-database.ts";

const local = "postgresql://grokeado:local-test-only@127.0.0.1:5432/grokeado_local_fixture";

test("local database preflight accepts only the dedicated explicit loopback database", () => {
  assert.equal(requireLocalDatabase({ DATABASE_URL: local }), local);
  for (const host of ["localhost", "[::1]"]) assert.ok(requireLocalDatabase({ DATABASE_URL: local.replace("127.0.0.1", host) }));
  for (const env of [
    {}, { POSTGRES_URL: local }, { DATABASE_URL: "not a URL" },
    { DATABASE_URL: local.replace("127.0.0.1", "production.example.test") },
    { DATABASE_URL: local.replace("grokeado_local_fixture", "production_fixture") },
    { DATABASE_URL: local.replace(":5432/", ":6432/") },
    { DATABASE_URL: local + "?host=production.example.test" },
    { DATABASE_URL: local + "#ignored" },
    { DATABASE_URL: local.replace("postgresql:", "https:") },
    { DATABASE_URL: local.replace("grokeado:local-test-only@", "grokeado@") },
  ]) assert.throws(() => requireLocalDatabase(env), /Local database preflight/);
});

test("local database rejection never exposes connection-string secrets", () => {
  assert.throws(() => requireLocalDatabase({ DATABASE_URL: "postgresql://secret:never-print@remote.test/db" }), (error: Error) => !error.message.includes("secret") && !error.message.includes("never-print"));
});
