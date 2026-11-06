import { Snapshot } from "@vercel/sandbox";
import { after } from "next/server";
import { auth0 } from "@/lib/auth0.ts";
import { adminNotificationResponse } from "@/lib/admin-notification-response.ts";
import { snapshotHealth } from "@/lib/admin-notifications.ts";
import { hasUnreadAdminNotifications, recordSnapshotHealth } from "@/store.ts";
import { sweepCaseSandboxes } from "@/instruction/preparation.ts";

async function respond(request: Request): Promise<Response> {
  const session = await auth0.getSession();
  const response = await adminNotificationResponse(request, session?.user, {
    hasUnread: hasUnreadAdminNotifications,
    checkSnapshot: async () => {
      const health = await snapshotHealth(process.env, (snapshotId) => {
        // Avoid the SDK's interactive login prompt in a local dev server.
        if (!process.env.VERCEL_URL && !process.env.VERCEL_OIDC_TOKEN) throw new Error("Vercel credentials unavailable");
        return Snapshot.get({ snapshotId, signal: AbortSignal.timeout(5000) });
      });
      return recordSnapshotHealth(health);
    },
  });
  // Piggybacks on the admin's periodic check, as the snapshot check does: no cron.
  // It runs after the response, so it never delays or fails the notifications.
  if (response.ok && request.method === "POST" && (process.env.VERCEL_URL || process.env.VERCEL_OIDC_TOKEN)) {
    after(async () => {
      try {
        const deleted = await sweepCaseSandboxes();
        if (deleted.length) console.info("Deleted the sandboxes of ended cases:", deleted);
      } catch (error) { console.warn("Could not sweep case sandboxes:", error); }
    });
  }
  return response;
}

export const GET = respond;
export const POST = respond;
