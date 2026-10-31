import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Every server trace that loads Playwright must carry its runtime browser registry.
const serverDir = path.resolve(".next/server");
const browserRegistry = path.resolve("node_modules/playwright-core/browsers.json");
let playwrightTraces = 0;

async function checkDirectory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await checkDirectory(file);
    } else if (entry.name.endsWith(".nft.json")) {
      const { files } = JSON.parse(await readFile(file, "utf8"));
      const resolved = files.map((name) => path.resolve(dir, name));
      if (!resolved.some((name) => name !== browserRegistry && name.includes(`${path.sep}node_modules${path.sep}playwright-core${path.sep}`))) continue;
      playwrightTraces++;
      if (!resolved.includes(browserRegistry)) throw new Error(`Missing Playwright browser registry in ${path.relative(process.cwd(), file)}`);
    }
  }
}

await checkDirectory(serverDir);
if (!playwrightTraces) throw new Error("No server traces containing Playwright were found");
console.log(`Verified Playwright browser registry in ${playwrightTraces} server traces.`);
