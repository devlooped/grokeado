import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const [mode, arg] = process.argv.slice(2);
const out = "data/shots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "es-AR" });
const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok: " + msg);
};

if (mode === "submit") {
  await page.goto(base);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out + "/home.png", fullPage: true });
  await page.getByRole("button", { name: "Pedir el chequeo" }).waitFor();
  await page.locator("textarea[name=text]").fill(arg);
  await page.getByRole("button", { name: "Pedir el chequeo" }).click();
  await page.waitForURL(/\/caso\//);
  const heading = await page.getByRole("heading", { level: 1 }).textContent();
  assert(heading === "La corte está en sesión", "after submitting, the case page shows only 'La corte está en sesión'");
  assert((await page.locator("article").count()) === 0, "no claims or votes are shown while in session");
  await page.screenshot({ path: out + "/in-session.png", fullPage: true });
  console.log("case " + page.url().split("/").at(-1));
}

if (mode === "case") {
  await page.goto(base + "/caso/" + arg);
  await page.waitForTimeout(1500);
  const heading = await page.getByRole("heading", { level: 1 }).textContent();
  console.log("heading: " + heading);
  const claims = await page.locator("article").count();
  const chips = await page.locator("[aria-label='Votos de los letrados'] > span").count();
  const seals = await page.locator("span[aria-label^='Fallo del juez']").count();
  console.log("claims=" + claims + " voteChips=" + chips + " judgeSeals=" + seals + " actaEntries=" + (await page.locator("section ol > li").count()));
  for (const label of await page.locator("[aria-label='Votos de los letrados'] > span").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) console.log("  " + label);
  assert(claims > 0 && chips === claims * 3, "every claim shows exactly three AI vote icons");
  await page.screenshot({ path: out + "/case-" + arg + ".png", fullPage: true });
  await page.screenshot({ path: out + "/case-" + arg + "-top.png" });
  await page.getByRole("heading", { name: "Acta de la sesión" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/case-" + arg + "-acta.png" });
  await page.locator("[id^=S]").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/case-" + arg + "-debate.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + "/case-" + arg + "-mobile.png", fullPage: false });
}

await browser.close();
