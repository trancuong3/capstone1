"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import type { KaraokeDraftSaveQueue } from "@/lib/karaoke/draft-save-queue";
import { KaraokeProcessingSession } from "@/lib/karaoke/processing-session";

export function useKaraokeProcessing(
  service: AdminKaraokeService,
  queue: KaraokeDraftSaveQueue,
) {
  const [session] = useState(
    () => new KaraokeProcessingSession(service, queue),
  );
  const view = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(() => {
    session.activate();
    return session.suspend;
  }, [session]);
  return {
    ...view,
    resume: session.resume,
    refresh: session.refresh,
    start: session.start,
    cancel: session.cancel,
    retry: session.retry,
    apply: session.apply,
    getPreview: session.getPreview,
    confirmReview: session.confirmReview,
  };
}
