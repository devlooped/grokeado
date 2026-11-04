// Run with: CACHE_TEST_DATABASE_URL=<disposable DB URL> node --import tsx scripts/e2e-case-cache.mjs
// The running app at BASE_URL must use the same disposable database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";

const databaseUrl = process.env.CACHE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Set CACHE_TEST_DATABASE_URL to an explicitly disposable database.");
process.env.DATABASE_URL = databaseUrl;
const { createCase, finishCase, getCase, openSession, recordEvents } = await import("../src/store.ts");
const db = new pg.Pool({ connectionString: databaseUrl });
const browser = await chromium.launch({ channel: "msedge" });
const base = process.env.BASE_URL ?? "http://localhost:3000";
const prefix = "CACHE-TEST-" + randomBytes(8).toString("hex");
const created = [];
const at = new Date().toISOString();
const event = (text) => ({ seq: 1, at, type: "claims_entered", claims: [{ id: "A1", text, quote: text }] });

async function readPage(id) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/caso/${id}`, { waitUntil: "networkidle" });
    const heading = await page.locator("h1").first().textContent();
    const claimNode = page.locator("article#A1 h3");
    const summaryNode = page.locator("section").filter({ has: page.getByRole("heading", { name: "Resumen del caso" }) });
    const claim = await claimNode.count() ? await claimNode.textContent() : null;
    const summary = await summaryNode.count() ? await summaryNode.textContent() : null;
    return { heading, claim, summary };
  } finally {
    await page.close();
  }
}

try {
  for (const [id, text] of [[prefix + "a", "Primera revisión"], [prefix + "b", "Otro caso"]]) {
    await createCase(id, { kind: "text", text: "Caso aislado para probar caché" });
    created.push(id);
    assert.equal((await getCase(id)).revision, 0);
    await recordEvents(id, [event(text)]);
    await finishCase(id, "resolved");
    assert.equal((await getCase(id)).revision, 1);
  }
  const [first, other] = created;
  assert.equal((await readPage(first)).claim, "Primera revisión");
  assert.equal((await readPage(other)).claim, "Otro caso");

  // Simulate a changed source without changing the revision to prove a cache hit.
  await db.query("UPDATE events SET body = $2 WHERE case_id = $1 AND seq = 1", [first, JSON.stringify(event("Cambio sin revisión"))]);
  assert.equal((await readPage(first)).claim, "Primera revisión");

  await openSession(first);
  assert.equal((await getCase(first)).revision, 1);
  const pending = await readPage(first);
  assert.equal(pending.heading, "El panel está analizando");
  assert.equal(pending.claim, null);
  await recordEvents(first, [event("Segunda revisión")]);
  await finishCase(first, "resolved");
  assert.equal((await getCase(first)).revision, 2);
  assert.equal((await readPage(first)).claim, "Segunda revisión");
  await finishCase(first, "resolved");
  assert.equal((await getCase(first)).revision, 2, "repeated close must not bump the revision");
  const lateEvent = { seq: 2, at, type: "case_summary", text: "Evidencia incorporada después del cierre." };
  await recordEvents(first, [lateEvent]);
  assert.equal((await getCase(first)).revision, 3, "new events on a closed case bump the revision");
  assert.match((await readPage(first)).summary ?? "", /Evidencia incorporada después del cierre/);
  await recordEvents(first, [lateEvent]);
  assert.equal((await getCase(first)).revision, 3, "duplicate events must not bump the revision");
  await finishCase(first, "failed", "Prueba aislada");
  assert.equal((await getCase(first)).revision, 3);
  const failed = await readPage(first);
  assert.equal(failed.heading, "El análisis se interrumpió");
  assert.equal(failed.claim, null);
  console.log("ok: cache keys isolate case and revision; open and failed cases remain dynamic");
} finally {
  for (const id of created) await db.query("DELETE FROM cases WHERE id = $1", [id]);
  await db.end();
  await browser.close();
}
