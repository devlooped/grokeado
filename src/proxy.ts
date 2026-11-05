import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "@/lib/auth0.ts";

export async function proxy(request: NextRequest) {
  // Only the SDK-authenticated bridge bypasses the interactive Auth0 cookie
  // middleware. Its route verifies OIDC and then a live case/phase/turn binding.
  if (/^\/api\/sandbox\//.test(request.nextUrl.pathname)) return NextResponse.next();
  return auth0.middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|\\.well-known).*)"],
};
