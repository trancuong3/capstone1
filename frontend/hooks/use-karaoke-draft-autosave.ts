"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import { KaraokeDraftSaveQueue } from "@/lib/karaoke/draft-save-queue";
import type { AdminKaraokeDetail } from "@/types/karaoke";

/** Mount after create/get ACK, once per workspace (not once per revision). */
export function useKaraokeDraftAutosave(
  initial: AdminKaraokeDetail,
  service: Pick<AdminKaraokeService, "save">,
) {
  const [queue] = useState(() => new KaraokeDraftSaveQueue(initial, service));
  const view = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  useEffect(() => {
    queue.activate();
    return queue.suspend;
  }, [queue]);
  return {
    ...view,
    queue,
    latestRevision: view.detail.revision,
    updateSnapshot: queue.updateSnapshot,
    flush: queue.flush,
    enqueueMutation: queue.enqueueMutation,
    reconcile: queue.reconcile,
    dispose: queue.dispose,
  };
}
