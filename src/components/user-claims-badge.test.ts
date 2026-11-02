import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractClaimRows, UserClaimsPopover } from "./user-claims-badge.tsx";

test("extractClaimRows prioritizes core identity claims and formats booleans and arrays", () => {
  const rows = extractClaimRows({
    "https://grokeado.com/roles": ["admin", "beta"],
    email_verified: true,
    roles: ["admin", "beta", "reviewer"],
    email: "daniel@cazzulino.com",
    sub: "google-oauth2|123",
    ignored: undefined,
  });

  assert.deepEqual(rows, [
    { key: "sub", value: "google-oauth2|123" },
    { key: "email", value: "daniel@cazzulino.com" },
    { key: "email_verified", value: "true" },
    { key: "roles", value: '["admin","beta","reviewer"]' },
    { key: "https://grokeado.com/roles", value: '["admin","beta"]' },
  ]);
});

test("UserClaimsPopover renders a shield button when closed and a claims table when open", () => {
  const claims = {
    sub: "google-oauth2|123",
    email: "daniel@cazzulino.com",
    email_verified: true,
    roles: ["admin", "beta"],
  };

  const closedHtml = renderToStaticMarkup(createElement(UserClaimsPopover, { claims, open: false, onToggle: () => {} }));
  assert.match(closedHtml, /aria-expanded="false"/);
  assert.match(closedHtml, /<svg/);
  assert.doesNotMatch(closedHtml, /<table/);

  const openHtml = renderToStaticMarkup(createElement(UserClaimsPopover, { claims, open: true, onToggle: () => {} }));
  assert.match(openHtml, /aria-expanded="true"/);
  assert.match(openHtml, /<table/);
  assert.match(openHtml, /google-oauth2\|123/);
  assert.match(openHtml, /daniel@cazzulino\.com/);
  assert.match(openHtml, /email_verified/);
  assert.match(openHtml, /\[&quot;admin&quot;,&quot;beta&quot;\]/);
  assert.ok(openHtml.includes('href="/auth/logout"'));
});
