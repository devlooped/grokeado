import { decodeJwt } from "jose";
import { NextRequest } from "next/server";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { Auth0ClientOptions, SessionData } from "@auth0/nextjs-auth0/types";

function isRoleClaimKey(key: string): boolean {
  return /^(?:.*[/:.])?roles?$/i.test(key);
}

function collectRoleClaims(sources: ReadonlyArray<Record<string, unknown> | undefined>): Record<string, string[]> {
  const retained: Record<string, string[]> = {};
  const merged = new Set<string>();
  const shortRoleClaims: string[][] = [];
  let sawRolesClaim = false;

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!isRoleClaimKey(key)) continue;
      const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
      if (!values) continue;
      const roles = values.filter((item): item is string => typeof item === "string");
      if (roles.length !== values.length) continue;
      sawRolesClaim = true;
      if (key !== "roles") retained[key] = roles;
      else shortRoleClaims.push(roles);
      for (const role of roles) merged.add(role);
    }
  }

  if (sawRolesClaim) {
    retained.roles = [...merged];
  }
  const microsoftRoleKey = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
  const microsoftRoles = retained[microsoftRoleKey];
  if (microsoftRoles) {
    const values = new Set(microsoftRoles);
    if (shortRoleClaims.some((roles) => {
      const shortValues = new Set(roles);
      return shortValues.size === values.size && [...values].every((role) => shortValues.has(role));
    })) {
      delete retained[microsoftRoleKey];
    }
  }
  return retained;
}

function tryDecodeJwtPayload(token: string | null | undefined): Record<string, unknown> | undefined {
  if (!token || token.split(".").length !== 3) return undefined;
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
}

export async function trimSession(session: SessionData, idToken?: string | null): Promise<SessionData> {
  const { sub, email, email_verified } = session.user;
  const roleClaims = collectRoleClaims([
    tryDecodeJwtPayload(session.tokenSet.accessToken),
    tryDecodeJwtPayload(idToken ?? session.tokenSet.idToken),
    session.user,
  ]);

  return {
    user: {
      sub,
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof email_verified === "boolean" ? { email_verified } : {}),
      ...roleClaims,
    },
    tokenSet: {
      accessToken: "",
      expiresAt: session.tokenSet.expiresAt,
    },
    internal: session.internal,
  };
}

function resolveRequestOrigin(req: NextRequest, appBaseUrl?: string | string[]): string {
  if (typeof appBaseUrl === "string" && appBaseUrl.trim()) {
    return new URL(appBaseUrl.trim()).origin;
  }
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host")?.split(",")[0]?.trim() || req.nextUrl.host;
  const proto = forwardedProto || req.nextUrl.protocol.replace(":", "");
  if (host && proto) {
    try {
      return new URL(`${proto}://${host}`).origin;
    } catch {
      // Fall back to req.nextUrl.origin below.
    }
  }
  return req.nextUrl.origin;
}

export function normalizeLogoutRequest(req: NextRequest, appBaseUrl?: string | string[]): NextRequest {
  const pathname = req.nextUrl.pathname.replace(/\/+$/, "") || "/";
  if (req.method !== "GET" || pathname !== "/auth/logout") return req;

  const returnTo = req.nextUrl.searchParams.get("returnTo");
  if (!returnTo) return req;

  const origin = resolveRequestOrigin(req, appBaseUrl);
  let resolved: URL;
  try {
    resolved = new URL(returnTo, origin);
  } catch {
    return req;
  }

  const nextUrl = req.nextUrl.clone();
  if (resolved.origin !== origin) {
    nextUrl.searchParams.delete("returnTo");
  } else {
    const normalized =
      resolved.pathname === "/" && !resolved.search && !resolved.hash ? resolved.origin : resolved.toString();
    if (normalized === returnTo) return req;
    nextUrl.searchParams.set("returnTo", normalized);
  }

  return new NextRequest(nextUrl, req);
}

export function createAuth0Client(options: Auth0ClientOptions = {}): Auth0Client {
  const configuredBaseUrl = options.appBaseUrl ?? process.env.APP_BASE_URL;
  const client = new Auth0Client({
    ...options,
    authorizationParameters: {
      scope: "openid email",
      ...options.authorizationParameters,
    },
    enableAccessTokenEndpoint: options.enableAccessTokenEndpoint ?? false,
    includeIdTokenHintInOIDCLogoutUrl: options.includeIdTokenHintInOIDCLogoutUrl ?? false,
    beforeSessionSaved: options.beforeSessionSaved ?? trimSession,
  });

  const baseMiddleware = client.middleware.bind(client);
  client.middleware = ((req: Parameters<Auth0Client["middleware"]>[0]) => {
    if (req instanceof NextRequest) {
      return baseMiddleware(normalizeLogoutRequest(req, configuredBaseUrl));
    }
    return baseMiddleware(req);
  }) as Auth0Client["middleware"];

  return client;
}

export const auth0 = createAuth0Client();
