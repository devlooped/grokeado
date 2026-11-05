import { defineSandboxProxy } from "@vercel/sandbox/proxy";
import { dispatchSandboxRequest } from "@/instruction/proxy.ts";

export const maxDuration = 300;
// This route has its own SDK-verified OIDC authentication and case authorization.
export const POST = defineSandboxProxy(dispatchSandboxRequest);
