import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pinSslMode } from "./store.ts";

test("pinSslMode names verify-full for the modes pg already treats as verify-full", () => {
  for (const mode of ["prefer", "require", "verify-ca", "REQUIRE"]) {
    assert.equal(pinSslMode(`postgresql://u:p%40ss@host/db?sslmode=${mode}&channel_binding=require`), "postgresql://u:p%40ss@host/db?sslmode=verify-full&channel_binding=require");
  }
  assert.equal(pinSslMode("postgres://h/db?a=1&sslmode=require"), "postgres://h/db?a=1&sslmode=verify-full");
});

test("pinSslMode leaves explicit, disabled, libpq-compatible and missing modes alone", () => {
  for (const url of [
    "postgres://h/db?sslmode=verify-full",
    "postgres://h/db?sslmode=disable",
    "postgres://h/db?sslmode=no-verify",
    "postgres://h/db?uselibpqcompat=true&sslmode=require",
    "postgres://h/db?sslmode=require&uselibpqcompat=true",
    "postgres://h/db",
    "postgres://h/db?xsslmode=require",
  ]) assert.equal(pinSslMode(url), url);
});

test("the pinned URL parses to the same TLS settings without the pg warning", () => {
  const script = `const parse = require("pg-connection-string").parse;
    const before = parse(process.argv[1]); const after = parse(process.argv[2]);
    console.log(JSON.stringify([before.ssl, after.ssl]));`;
  const original = "postgresql://u:p@host/db?sslmode=require&channel_binding=require";
  const run = (args: string[]) => spawnSync(process.execPath, ["-e", script, ...args], { encoding: "utf8" });
  const result = run([original, pinSslMode(original)]);
  assert.equal(result.status, 0, result.stderr);
  const [before, after] = JSON.parse(result.stdout);
  assert.deepEqual(after, before);
  assert.match(result.stderr, /SECURITY WARNING/, "the original URL warns");
  const pinnedOnly = run([pinSslMode(original), pinSslMode(original)]);
  assert.doesNotMatch(pinnedOnly.stderr, /SECURITY WARNING/);
});
