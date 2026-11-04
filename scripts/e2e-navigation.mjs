// Requires a running app with at least one resolved case in the recent cases list.
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "es-AR" });
const assert = (ok, message) => {
  if (!ok) throw new Error("FAILED: " + message);
  console.log("ok: " + message);
};

async function checkAnchor(href) {
  await page.waitForURL((url) => url.pathname + url.hash === href);
  const id = href.split("#")[1];
  await page.waitForFunction((targetId) => {
    const target = document.getElementById(targetId);
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
  }, id);
  return page.locator(`[id="${id}"]`);
}

try {
  await page.goto(base, { waitUntil: "networkidle" });
  const claim = page.locator('a[href^="/c/"][href*="#"]:not([href*="#voto-"])').first();
  const claimHref = await claim.getAttribute("href");
  assert(claimHref, "hay una afirmación para probar");

  // Delay the navigation response to check feedback before the server responds.
  await page.route(/\?_rsc=/, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await claim.click();
  const hint = page.getByRole("status").filter({ hasText: "Abriendo caso" });
  await hint.waitFor({ state: "visible" });
  const hintBox = await hint.boundingBox();
  assert(hintBox && hintBox.x + hintBox.width > 1200 && hintBox.y + hintBox.height > 850, "la espera aparece en el borde de la ventana");
  await checkAnchor(claimHref);
  assert(true, "la navegación llega a la afirmación");
  await page.unrouteAll({ behavior: "wait" });

  await page.goto(base, { waitUntil: "networkidle" });
  const vote = page.locator('a[href*="#voto-"]').first();
  const voteHref = await vote.getAttribute("href");
  assert(voteHref, "hay un voto para probar");
  await vote.click();
  const target = await checkAnchor(voteHref);
  assert(await target.evaluate((el) => el.closest("details")?.open), "el fundamento del voto está abierto y visible");

  await page.emulateMedia({ reducedMotion: "reduce" });
  assert(await page.locator(".case-enter").evaluate((el) => getComputedStyle(el).animationName) === "none", "la transición respeta movimiento reducido");
  await page.goto(base, { waitUntil: "networkidle" });
  assert(await page.locator(".reveal").first().evaluate((el) => getComputedStyle(el).animationName) === "none", "las entradas respetan movimiento reducido");

  const response = await page.request.get(base + "/c/nonexistent-navigation-check");
  assert(response.status() === 404, "un caso inexistente conserva el estado HTTP 404");
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
}
