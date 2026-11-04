import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createAuth0Client, normalizeLogoutRequest, trimSession } from "./auth0.ts";
import { canRequestCase } from "./case-access.ts";

const DOMAIN = "devlooped.us.auth0.com";
const ISSUER = `https://${DOMAIN}/`;
const CLIENT_ID = "pqq7y4f9IMv7PFLx6gEngGkIXUIeWo7A";
const CLIENT_SECRET = "test-client-secret-for-callback-exchange";
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const APP_BASE_URL = "https://che.bot";
const MICROSOFT_ROLE = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key-1", alg: "RS256", use: "sig" };

function signJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key-1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function cookieByteLength(name: string, value: string): number {
  return Buffer.byteLength(`${name}=${value}`, "utf8");
}

function buildMockFetch(options: { endSessionEndpoint?: string; nonceRef: { current: string } }): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize`,
        token_endpoint: `${ISSUER}oauth/token`,
        jwks_uri: `${ISSUER}.well-known/jwks.json`,
        ...(options.endSessionEndpoint ? { end_session_endpoint: options.endSessionEndpoint } : {}),
      });
    }
    if (url === `${ISSUER}.well-known/jwks.json`) {
      return Response.json({ keys: [publicJwk] });
    }
    if (url === `${ISSUER}oauth/token`) {
      const now = Math.floor(Date.now() / 1000);
      const bloatedClaims = {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: "google-oauth2|109876543210987654321",
        sid: "sid_zdfht_1793486614836_81e81a328d77",
        nonce: options.nonceRef.current,
        iat: now,
        exp: now + 3600,
        email: "Daniel@Cazzulino.com",
        email_verified: true,
        given_name: "Daniel",
        family_name: "Cazzulino",
        nickname: "daniel.cazzulino",
        name: "Daniel Cazzulino",
        picture: "https://lh3.googleusercontent.com/a/ACg8ocLongProfilePictureUrlWithMetadataAndParameters1234567890abcdef=s96-c",
        updated_at: "2026-10-31T22:43:35.178Z",
        "https://grokeado.com/roles": ["admin", "beta"],
        [MICROSOFT_ROLE]: ["admin", "beta", "reviewer"],
        "https://example.com/groups": Array.from({ length: 20 }, (_, i) => `custom-group-claim-padding-${i}`),
      };
      const idToken = signJwt(bloatedClaims);
      const accessToken = signJwt({
        ...bloatedClaims,
        roles: ["admin", "beta", "reviewer"],
        scope: "openid profile email offline_access",
      });
      return Response.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "v1.MRRT-" + "r".repeat(120),
        token_type: "Bearer",
        expires_in: 86400,
        scope: "openid profile email offline_access",
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

test("trimSession retains sub, email, email_verified, received roles, and required session metadata", async () => {
  const accessToken = signJwt({ sub: "auth0|123", "https://api.grokeado.com/roles": ["editor"] });
  const trimmed = await trimSession({
    user: {
      sub: "auth0|123",
      email: "user@example.com",
      email_verified: false,
      "https://grokeado.com/roles": ["admin", "beta"],
      name: "Extra Name",
      picture: "https://example.com/avatar.png",
      custom: "ignored",
    },
    tokenSet: {
      accessToken,
      idToken: "opaque-or-unused-id-token",
      refreshToken: "large-refresh-token",
      scope: "openid profile email offline_access",
      requestedScope: "openid profile email offline_access",
      audience: "https://api.example.com",
      expiresAt: 1900000000,
    },
    accessTokens: [{ accessToken: "secondary", audience: "https://other.example.com", expiresAt: 1900000000 }],
    internal: { sid: "sid-123", createdAt: 1899990000, sessionExpiresAt: 1900000000 },
  });

  assert.deepEqual(trimmed, {
    user: {
      sub: "auth0|123",
      email: "user@example.com",
      email_verified: false,
      "https://api.grokeado.com/roles": ["editor"],
      "https://grokeado.com/roles": ["admin", "beta"],
      roles: ["editor", "admin", "beta"],
    },
    tokenSet: { accessToken: "", expiresAt: 1900000000 },
    internal: { sid: "sid-123", createdAt: 1899990000, sessionExpiresAt: 1900000000 },
  });

  // Re-trimming an already-saved cookie user (when tokens were already stripped) preserves roles as-is.
  const retrimmed = await trimSession(trimmed);
  assert.deepEqual(retrimmed, trimmed);

  const withoutOptionalClaims = await trimSession({
    user: { sub: "auth0|no-email", name: "No Email" },
    tokenSet: { accessToken: "tok", expiresAt: 1900000000 },
    internal: { sid: "sid-456", createdAt: 1899990000 },
  });

  assert.deepEqual(withoutOptionalClaims.user, { sub: "auth0|no-email" });
});

test("trimSession removes only a Microsoft role claim duplicated by an actual roles claim", async () => {
  const session = (user: Record<string, unknown>, accessToken = "") => ({
    user: { sub: "auth0|123", ...user },
    tokenSet: { accessToken, expiresAt: 1900000000 },
    internal: { sid: "sid-123", createdAt: 1899990000 },
  });

  const matching = await trimSession(session({
    [MICROSOFT_ROLE]: ["admin", "beta"],
    roles: ["beta", "admin", "admin"],
    "https://example.com/roles": ["admin", "beta"],
  }));
  assert.deepEqual(matching.user, {
    sub: "auth0|123",
    "https://example.com/roles": ["admin", "beta"],
    roles: ["admin", "beta"],
  });
  assert.deepEqual(await trimSession(matching), matching);

  const acrossSources = await trimSession(session(
    { [MICROSOFT_ROLE]: "admin" },
    signJwt({ roles: ["admin"] }),
  ));
  assert.deepEqual(acrossSources.user, { sub: "auth0|123", roles: ["admin"] });

  const distinct = await trimSession(session({ [MICROSOFT_ROLE]: ["admin", "beta"], roles: ["admin"] }));
  assert.deepEqual(distinct.user, {
    sub: "auth0|123",
    [MICROSOFT_ROLE]: ["admin", "beta"],
    roles: ["admin", "beta"],
  });

  const extraShortRole = await trimSession(session({ [MICROSOFT_ROLE]: "admin", roles: ["admin", "beta"] }));
  assert.deepEqual(extraShortRole.user, {
    sub: "auth0|123",
    [MICROSOFT_ROLE]: ["admin"],
    roles: ["admin", "beta"],
  });

  const withoutShortClaim = await trimSession(session({ [MICROSOFT_ROLE]: "admin" }));
  assert.deepEqual(withoutShortClaim.user, {
    sub: "auth0|123",
    [MICROSOFT_ROLE]: ["admin"],
    roles: ["admin"],
  });

  const invalidShortClaim = await trimSession(session({ [MICROSOFT_ROLE]: "admin", roles: ["admin", 1] }));
  assert.deepEqual(invalidShortClaim.user, withoutShortClaim.user);
});

test("logout normalization uses the configured origin for root and rejects cross-origin returns", () => {
  for (const [returnTo, expected] of [
    ["/", APP_BASE_URL],
    [`${APP_BASE_URL}/`, APP_BASE_URL],
    [APP_BASE_URL, APP_BASE_URL],
    ["/case?view=full", `${APP_BASE_URL}/case?view=full`],
    ["https://other.example/", null],
  ] as const) {
    const req = new NextRequest(`${APP_BASE_URL}/auth/logout?returnTo=${encodeURIComponent(returnTo)}`);
    const normalized = normalizeLogoutRequest(req, APP_BASE_URL);
    assert.equal(normalized.nextUrl.searchParams.get("returnTo"), expected);
  }
});

test("login callbacks and logout normalization use configured origins", async () => {
  for (const origin of ["https://che.bot", "https://www.che.bot", "https://verificado.si", "https://www.verificado.si"]) {
    const client = createAuth0Client({
      domain: DOMAIN,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      secret: SECRET,
      appBaseUrl: origin,
      customFetch: buildMockFetch({ nonceRef: { current: "" } }),
    });
    const login = await client.middleware(new NextRequest(`${origin}/auth/login`));
    const authorizeUrl = new URL(login.headers.get("location") ?? "");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), `${origin}/auth/callback`);

    const logout = normalizeLogoutRequest(new NextRequest(`${origin}/auth/logout?returnTo=/`), origin);
    assert.equal(logout.nextUrl.searchParams.get("returnTo"), origin);
  }
});

test("sign-in, rolling session, and v2 sign-out keep __session well below 4 KB while preserving roles", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  const nonceRef = { current: "" };
  const client = createAuth0Client({
    domain: DOMAIN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    secret: SECRET,
    appBaseUrl: APP_BASE_URL,
    customFetch: buildMockFetch({ nonceRef }),
  });

  const loginRes = await client.middleware(new NextRequest(`${APP_BASE_URL}/auth/login?returnTo=/`));
  const authorizeUrl = new URL(loginRes.headers.get("location") ?? "");
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${ISSUER}authorize`);
  assert.equal(authorizeUrl.searchParams.get("scope"), "openid email");

  const state = authorizeUrl.searchParams.get("state");
  const nonce = authorizeUrl.searchParams.get("nonce");
  assert.ok(state);
  assert.ok(nonce);
  nonceRef.current = nonce;

  const txnCookie = loginRes.cookies.get(`__txn_${state}`);
  assert.ok(txnCookie?.value);

  const callbackRes = await client.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `${txnCookie.name}=${txnCookie.value}` },
    })
  );
  assert.equal(callbackRes.headers.get("location"), `${APP_BASE_URL}/`);

  const nonEmptySessionCookies = callbackRes.cookies
    .getAll()
    .filter((c) => (c.name === "__session" || c.name.startsWith("__session__")) && c.value.length > 0);
  assert.equal(nonEmptySessionCookies.length, 1);
  assert.equal(nonEmptySessionCookies[0].name, "__session");

  const signInCookieBytes = cookieByteLength(nonEmptySessionCookies[0].name, nonEmptySessionCookies[0].value);
  assert.ok(signInCookieBytes < 1024, `expected __session < 1024 bytes, got ${signInCookieBytes}`);
  assert.ok(Buffer.byteLength(callbackRes.headers.getSetCookie().join("\r\n"), "utf8") < 4096);
  assert.deepEqual(
    warnings.filter((w) => w.includes("__session")),
    []
  );

  const cookieHeader = `__session=${nonEmptySessionCookies[0].value}`;
  const authedReq = new NextRequest(`${APP_BASE_URL}/`, { headers: { cookie: cookieHeader } });
  const session = await client.getSession(authedReq);
  assert.deepEqual(session?.user, {
    sub: "google-oauth2|109876543210987654321",
    email: "Daniel@Cazzulino.com",
    email_verified: true,
    roles: ["admin", "beta", "reviewer"],
    "https://grokeado.com/roles": ["admin", "beta"],
  });
  assert.equal(session?.tokenSet.accessToken, "");
  assert.equal(session?.tokenSet.idToken, undefined);
  assert.equal(session?.tokenSet.refreshToken, undefined);
  assert.equal(canRequestCase(session?.user), true);

  const rolledRes = await client.middleware(authedReq);
  const rolledSession = rolledRes.cookies.get("__session");
  assert.ok(rolledSession?.value);
  assert.ok(cookieByteLength("__session", rolledSession.value) < 1024);
  const rolledReq = new NextRequest(`${APP_BASE_URL}/`, { headers: { cookie: `__session=${rolledSession.value}` } });
  assert.deepEqual((await client.getSession(rolledReq))?.user, session?.user);

  const unauthedProfileRes = await client.middleware(new NextRequest(`${APP_BASE_URL}/auth/profile`));
  assert.equal(unauthedProfileRes.status, 204);

  const authedProfileRes = await client.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/profile`, { headers: { cookie: cookieHeader } })
  );
  assert.equal(authedProfileRes.status, 200);
  assert.deepEqual(await authedProfileRes.json(), session?.user);

  const accessTokenRouteRes = await client.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/access-token`, { headers: { cookie: cookieHeader } })
  );
  assert.equal(accessTokenRouteRes.headers.get("x-middleware-next"), "1");

  const logoutRes = await client.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/logout?returnTo=/`, { headers: { cookie: cookieHeader } })
  );
  const logoutUrl = new URL(logoutRes.headers.get("location") ?? "");
  assert.equal(logoutUrl.origin + logoutUrl.pathname, `${ISSUER}v2/logout`);
  assert.equal(logoutUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(logoutUrl.searchParams.get("returnTo"), APP_BASE_URL);
  assert.equal(logoutRes.cookies.get("__session")?.value, "");
  assert.ok(Buffer.byteLength(logoutRes.headers.getSetCookie().join("\r\n"), "utf8") < 4096);
});

test("OIDC RP-initiated sign-out uses sid logout_hint without needing idToken in the session cookie", async () => {
  const nonceRef = { current: "" };
  const client = createAuth0Client({
    domain: DOMAIN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    secret: SECRET,
    appBaseUrl: APP_BASE_URL,
    customFetch: buildMockFetch({ endSessionEndpoint: `${ISSUER}oidc/logout`, nonceRef }),
  });

  const loginRes = await client.middleware(new NextRequest(`${APP_BASE_URL}/auth/login?returnTo=/`));
  const authorizeUrl = new URL(loginRes.headers.get("location") ?? "");
  const state = authorizeUrl.searchParams.get("state")!;
  nonceRef.current = authorizeUrl.searchParams.get("nonce")!;
  const txnCookie = loginRes.cookies.get(`__txn_${state}`)!;

  const callbackRes = await client.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `${txnCookie.name}=${txnCookie.value}` },
    })
  );
  const sessionCookie = callbackRes.cookies.get("__session")!;

  for (const returnTo of ["/", `${APP_BASE_URL}/`, APP_BASE_URL]) {
    const logoutRes = await client.middleware(
      new NextRequest(`${APP_BASE_URL}/auth/logout?returnTo=${encodeURIComponent(returnTo)}`, {
        headers: { cookie: `__session=${sessionCookie.value}` },
      })
    );
    const logoutUrl = new URL(logoutRes.headers.get("location") ?? "");
    assert.equal(logoutUrl.origin + logoutUrl.pathname, `${ISSUER}oidc/logout`);
    assert.equal(logoutUrl.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), APP_BASE_URL);
    assert.equal(logoutUrl.searchParams.get("logout_hint"), "sid_zdfht_1793486614836_81e81a328d77");
    assert.equal(logoutUrl.searchParams.has("id_token_hint"), false);
    assert.equal(logoutRes.cookies.get("__session")?.value, "");
    assert.ok(Buffer.byteLength(logoutRes.headers.getSetCookie().join("\r\n"), "utf8") < 4096);
  }
});

test("default Auth0Client serialization exceeds 4 KB on the same callback payload", async (t) => {
  const { Auth0Client } = await import("@auth0/nextjs-auth0/server");
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  const nonceRef = { current: "" };
  const untrimmed = new Auth0Client({
    domain: DOMAIN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    secret: SECRET,
    appBaseUrl: APP_BASE_URL,
    customFetch: buildMockFetch({ nonceRef }),
  });

  const loginRes = await untrimmed.middleware(new NextRequest(`${APP_BASE_URL}/auth/login?returnTo=/`));
  const authorizeUrl = new URL(loginRes.headers.get("location") ?? "");
  const state = authorizeUrl.searchParams.get("state")!;
  nonceRef.current = authorizeUrl.searchParams.get("nonce")!;
  const txnCookie = loginRes.cookies.get(`__txn_${state}`)!;

  const callbackRes = await untrimmed.middleware(
    new NextRequest(`${APP_BASE_URL}/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `${txnCookie.name}=${txnCookie.value}` },
    })
  );
  const nonEmptyChunks = callbackRes.cookies
    .getAll()
    .filter((c) => (c.name === "__session" || c.name.startsWith("__session__")) && c.value.length > 0);
  const untrimmedBytes = nonEmptyChunks.reduce((sum, c) => sum + cookieByteLength(c.name, c.value), 0);
  assert.ok(untrimmedBytes >= 4096, `expected untrimmed __session >= 4096 bytes, got ${untrimmedBytes}`);
  assert.ok(warnings.some((w) => w.includes("The __session cookie size is")));
});

