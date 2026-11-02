import { Auth0Client } from "@auth0/nextjs-auth0/server";
import type { Auth0ClientOptions, SessionData } from "@auth0/nextjs-auth0/types";

export async function trimSession(session: SessionData): Promise<SessionData> {
  const { sub, email, email_verified } = session.user;
  return {
    user: {
      sub,
      ...(typeof email === "string" ? { email } : {}),
      ...(typeof email_verified === "boolean" ? { email_verified } : {}),
    },
    tokenSet: {
      accessToken: "",
      expiresAt: session.tokenSet.expiresAt,
    },
    internal: session.internal,
  };
}

export function createAuth0Client(options: Auth0ClientOptions = {}): Auth0Client {
  return new Auth0Client({
    ...options,
    authorizationParameters: {
      scope: "openid email",
      ...options.authorizationParameters,
    },
    enableAccessTokenEndpoint: options.enableAccessTokenEndpoint ?? false,
    includeIdTokenHintInOIDCLogoutUrl: options.includeIdTokenHintInOIDCLogoutUrl ?? false,
    beforeSessionSaved: options.beforeSessionSaved ?? trimSession,
  });
}

export const auth0 = createAuth0Client();
