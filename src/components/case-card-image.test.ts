import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageResponse } from "next/og.js";
import sharp from "sharp";
import { CaseCardImage } from "./case-card-image.tsx";
import { project, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { caseCardImageData, caseCardJpeg } from "../lib/case-card-image.ts";

const c: CaseRecord = { id: "TEST", createdAt: "2026-01-01", status: "resolved", submission: { kind: "text", text: "Submission" } };
const events: CourtEvent[] = [
  { type: "claims_entered", claims: [{ id: "A1", quote: "Claim", text: "Claim" }] },
  { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "" },
  { type: "vote", by: "gemini", claimId: "A1", verdict: "verdadero", rationale: "" },
  { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "" },
];

test("the embedded stamp includes only models that voted for the judgment", () => {
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view: project(events) }));
  assert.match(markup, /Falso/);
  assert.match(markup, /title=\"Grok\"/);
  assert.doesNotMatch(markup, /title=\"Gemini\"/);
  assert.match(markup, /rotate\(180deg\)/);
});

test("dismissed cases do not display a verdict or voters", () => {
  const view = project([...events, { type: "dismissed", reason: "No claim" }]);
  const markup = renderToStaticMarkup(createElement(CaseCardImage, { c, view }));
  assert.match(markup, /Descartado/);
  assert.doesNotMatch(markup, /Falso|title=\"Grok\"/);
});

test("PNG, JPEG, WebP and GIF covers render into the same stamped JPEG", async () => {
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const image = await caseCardImageData({ bytes });
    const response = new ImageResponse(createElement(CaseCardImage, { c, view: project(events), image }), { width: 720, height: 720 });
    const output = await caseCardJpeg(await response.arrayBuffer());
    assert.equal((await sharp(output).metadata()).format, "jpeg");
    const pixel = await sharp(output).extract({ left: 300, top: 300, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(pixel[0]! > 240 && pixel[1]! < 15 && pixel[2]! < 15, format + " cover is visible");
  }
});
