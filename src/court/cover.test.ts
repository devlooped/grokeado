import assert from "node:assert/strict";
import test from "node:test";
import { coverBrief, fallbackPrompt, findCover, type CoverDeps } from "./cover.ts";

const png = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };
const jpeg = { bytes: new Uint8Array([4, 5, 6]), mimeType: "image/jpeg" };

function deps(overrides: Partial<CoverDeps>): CoverDeps & { prompts: string[]; downloads: string[] } {
  const prompts: string[] = [];
  const downloads: string[] = [];
  return {
    prompts,
    downloads,
    choose: async () => ({ prompt: "an editorial illustration" }),
    download: async (url) => {
      downloads.push(url);
      return jpeg;
    },
    approve: async () => true,
    generate: async (prompt) => {
      prompts.push(prompt);
      return png;
    },
    ...overrides,
  };
}

test("uses the real image Grok found when it downloads as an image", async () => {
  const d = deps({ choose: async () => ({ imageUrl: "https://news.example/photo.jpg", prompt: "unused" }) });
  const cover = await findCover("brief", d);
  assert.deepEqual(cover, { ...jpeg, sourceUrl: "https://news.example/photo.jpg", generated: false });
  assert.deepEqual(d.prompts, []);
});

test("generates a square illustration when nothing obvious was found", async () => {
  const d = deps({});
  const cover = await findCover("brief", d);
  assert.deepEqual(cover, { ...png, generated: true });
  assert.deepEqual(d.downloads, []);
  assert.deepEqual(d.prompts, ["an editorial illustration"]);
});

test("generates when the found image cannot be used", async () => {
  for (const download of [async () => undefined, async () => { throw new Error("blocked"); }]) {
    const d = deps({ choose: async () => ({ imageUrl: "https://news.example/page", prompt: "fallback art" }), download });
    const cover = await findCover("brief", d);
    assert.equal(cover.generated, true);
    assert.deepEqual(d.prompts, ["fallback art"]);
  }
});

test("generates when Grok rejects the found image on sight", async () => {
  for (const approve of [async () => false, async () => { throw new Error("vision down"); }]) {
    const d = deps({ choose: async () => ({ imageUrl: "https://news.example/infographic.png", prompt: "fallback art" }), approve });
    const cover = await findCover("brief", d);
    assert.equal(cover.generated, true);
    assert.deepEqual(d.prompts, ["fallback art"]);
  }
});

test("still generates from the brief when the search fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const d = deps({ choose: async () => { throw new Error("gateway down"); } });
  const cover = await findCover("Submitted material: x", d);
  assert.equal(cover.generated, true);
  assert.deepEqual(d.prompts, [fallbackPrompt("Submitted material: x")]);
});

test("the brief carries the material, the claims and the summary", () => {
  const brief = coverBrief({ kind: "link", url: "https://example.com/nota" }, ["La inflación bajó"], "Resumen");
  assert.match(brief, /https:\/\/example\.com\/nota/);
  assert.match(brief, /- La inflación bajó/);
  assert.match(brief, /Case summary:\nResumen/);
});
