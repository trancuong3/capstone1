/**
 * Feature #8: Multi-User Offline Hygiene & Automatic Logout Purge (`offline-hygiene.ts`).
 *
 * Ensures signing out, clearing auth state, switching accounts, or detecting an
 * inactive parent profile immediately wipes all cached offline reading packs,
 * private page images/TTS clips, Service Worker caches, and queued outbox entries.
 */

import { purgeOfflineOutboxForAccount } from "@/lib/offline/offline-session-outbox";
import { deleteOfflinePacksForAccount } from "@/lib/offline/reading-pack-store";

export type OfflineWipeReason =
  | "logout"
  | "auth_clear"
  | "inactive_profile"
  | "account_switch";

export interface WipeOfflineAccountOptions {
  readonly parentAccountId?: string | null;
  readonly childProfileId?: string | null;
  readonly reason?: OfflineWipeReason;
}

export interface OfflineHygienePurgeResult {
  readonly removedPacks: number;
  readonly removedOutboxEvents: number;
  readonly reason: OfflineWipeReason;
}

function notifyServiceWorkerPurge(parentAccountId?: string | null): void {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    !navigator.serviceWorker
  ) {
    return;
  }
  try {
    navigator.serviceWorker.controller?.postMessage({
      type: "VIREAD_PURGE_ACCOUNT_CACHE",
      parentAccountId: parentAccountId?.trim() || null,
    });
  } catch {
    // Ignore SW postMessage errors
  }
}

export async function wipeOfflineAccountData(
  options: WipeOfflineAccountOptions = {},
): Promise<OfflineHygienePurgeResult> {
  const reason = options.reason ?? "logout";
  const parentId = options.parentAccountId?.trim() || null;
  const childId = options.childProfileId?.trim() || null;

  notifyServiceWorkerPurge(parentId);

  const [removedPacks, removedOutboxEvents] = await Promise.all([
    deleteOfflinePacksForAccount(parentId, childId),
    purgeOfflineOutboxForAccount(parentId, childId),
  ]);

  return {
    removedPacks,
    removedOutboxEvents,
    reason,
  };
}
