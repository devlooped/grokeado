import { Snapshot } from "@vercel/sandbox";
import { auth0 } from "@/lib/auth0.ts";
import { adminNotificationResponse } from "@/lib/admin-notification-response.ts";
import { snapshotHealth } from "@/lib/admin-notifications.ts";
import { hasUnreadAdminNotifications, recordSnapshotHealth } from "@/store.ts";

async function respond(request: Request): Promise<Response> {
  const session = await auth0.getSession();
  return adminNotificationResponse(request, session?.user, {
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
}

export const GET = respond;
export const POST = respond;
