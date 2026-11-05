import assert from "node:assert/strict";
import test from "node:test";
import { renderEvidenceMarkdown } from "./markdown.ts";

const render = (body: string) => renderEvidenceMarkdown({ title: '<Title>', body, pages: [1, 2, 3], language: 'en' });

test('renders Markdown and stable page and block anchors', () => {
  const html = render('# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com) [p.1] [p2:b4] [p2:b4]');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /href="https:\/\/example.com"/);
  for (const id of ['p1', 'p2', 'p2:b4', 'p3']) assert.equal(html.split(`id="${id}"`).length - 1, 1);
  assert.match(html, /&lt;Title&gt;/);
});

test('escapes raw HTML, rejects unsafe links and does not load images', () => {
  const html = render('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [bad](data:text/html,evil) [bad](//evil.test) ![remote <img src=x onerror=alert(1)>](https://evil.test/x.png) <img src="https://evil.test/x">');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript:|data:|\/\/evil)/i);
  assert.match(html, /remote/);
});
