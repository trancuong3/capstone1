/**
 * Feature #8: Clean bridge between `reading-screen.tsx`, `reading-pack-store.ts`,
 * and `offline-session-outbox.ts` for True Offline / Airplane Mode reading.
 */

import {
  enqueueOfflineSessionEvent,
  generateUuidV4,
} from "@/lib/offline/offline-session-outbox";
import {
  getOfflineBookPack,
  getOfflinePageMediaBlob,
  getOfflineSessionDescriptor,
  listOfflineBookPacks,
  type LoadedOfflineBookPack,
} from "@/lib/offline/reading-pack-store";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ReadingCompletionSummaryUI,
  ReadingPageDTO,
  ReadingSessionPageProgressDTO,
  ReadingSessionPageProgressItemDTO,
} from "@/types/reading";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidString(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export interface OfflineReadingSessionContext {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly clientSessionId: string;
  readonly loadedPack: LoadedOfflineBookPack;
}

export interface OfflineReadingBootstrapResult {
  readonly context: OfflineReadingSessionContext;
  readonly book: BookDetailDTO;
  readonly child: ChildProfileDTO;
  readonly currentPage: ReadingPageDTO;
  readonly pageProgress: ReadingSessionPageProgressDTO;
  readonly completion: ReadingCompletionSummaryUI;
}

export async function resolveOfflineReadingSessionFallback(options: {
  readonly sessionId: string;
  readonly initialPageId?: string;
  readonly queryBookId?: string | null;
  readonly parentAccountId: string | null | undefined;
  readonly childProfileId: string | null | undefined;
  readonly knownChild?: ChildProfileDTO | null;
}): Promise<OfflineReadingBootstrapResult | null> {
  const parentId = options.parentAccountId?.trim() || "";
  const childId =
    options.childProfileId?.trim() || options.knownChild?.id?.trim() || "";
  if (!parentId || !childId) {
    return null;
  }

  const descriptor = await getOfflineSessionDescriptor(
    parentId,
    childId,
    options.sessionId,
  );
  let targetBookId = descriptor?.bookId ?? options.queryBookId?.trim() ?? "";

  if (!targetBookId) {
    const availablePacks = await listOfflineBookPacks(parentId, childId);
    if (availablePacks.length === 1) {
      targetBookId = availablePacks[0].bookId;
    } else if (options.initialPageId) {
      for (const candidate of availablePacks) {
        const loaded = await getOfflineBookPack(
          parentId,
          childId,
          candidate.bookId,
        );
        if (
          loaded?.pages.some((p) => p.page_id === options.initialPageId)
        ) {
          targetBookId = candidate.bookId;
          break;
        }
      }
    }
  }

  if (!targetBookId) {
    return null;
  }

  const loadedPack = await getOfflineBookPack(parentId, childId, targetBookId);
  if (!loadedPack || loadedPack.pages.length === 0) {
    return null;
  }

  const clientSessionId =
    descriptor?.clientSessionId && isUuidString(descriptor.clientSessionId)
      ? descriptor.clientSessionId
      : isUuidString(options.sessionId)
        ? options.sessionId
        : generateUuidV4();

  const preferredPageId =
    options.initialPageId ||
    descriptor?.currentPageId ||
    descriptor?.startPageId ||
    loadedPack.pages[0].page_id;

  const currentIdx = Math.max(
    0,
    loadedPack.pages.findIndex((p) => p.page_id === preferredPageId),
  );
  const currentPage = loadedPack.pages[currentIdx] ?? loadedPack.pages[0];
  const nowIso = new Date().toISOString();

  const progressItems: ReadingSessionPageProgressItemDTO[] =
    loadedPack.pages.map((p, idx) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: idx,
      status: idx === currentIdx ? "IN_PROGRESS" : "PENDING",
      started_at: idx === currentIdx ? nowIso : null,
      completed_at: null,
    }));

  const pageProgress: ReadingSessionPageProgressDTO = {
    session_id: clientSessionId,
    persisted: true,
    start_page_id: loadedPack.pages[0].page_id,
    end_page_id: loadedPack.pages[loadedPack.pages.length - 1].page_id,
    current_page_id: currentPage.page_id,
    start_page_number: loadedPack.pages[0].page_number,
    end_page_number: loadedPack.pages[loadedPack.pages.length - 1].page_number,
    current_page_number: currentPage.page_number,
    current_index: currentIdx,
    total_pages: loadedPack.pages.length,
    completed_pages: 0,
    pages: progressItems,
  };

  const child: ChildProfileDTO = descriptor?.child ??
    options.knownChild ?? {
      id: childId,
      parent_id: parentId,
      alias: "Bé",
      grade: loadedPack.manifest.grade,
      settings: {},
      created_at: nowIso,
    };

  const completion: ReadingCompletionSummaryUI = {
    duration_minutes: 0,
    pages_explored: 0,
    selected_range_pages: loadedPack.pages.length,
    practiced_words: 0,
    spoken_words: [],
    transcripts: [],
    correct_words: [],
    mispronounced_words: [],
    skipped_words: [],
    score: null,
  };

  await enqueueOfflineSessionEvent({
    parentAccountId: parentId,
    childProfileId: childId,
    clientSessionId,
    bookId: loadedPack.book.id,
    pageId: currentPage.page_id,
    pageRevisionId: currentPage.page_revision_id,
    eventKind: "SESSION_START",
  }).catch(() => undefined);

  return {
    context: {
      parentAccountId: parentId,
      childProfileId: childId,
      clientSessionId,
      loadedPack,
    },
    book: loadedPack.book,
    child,
    currentPage,
    pageProgress,
    completion,
  };
}

export function buildOfflineNavigatedProgress(
  currentProgress: ReadingSessionPageProgressDTO,
  loadedPack: LoadedOfflineBookPack,
  targetPageId: string,
): {
  readonly nextPage: ReadingPageDTO;
  readonly nextProgress: ReadingSessionPageProgressDTO;
} | null {
  const targetIdx = loadedPack.pages.findIndex(
    (p) => p.page_id === targetPageId,
  );
  if (targetIdx < 0) return null;
  const nextPage = loadedPack.pages[targetIdx];
  const nowIso = new Date().toISOString();
  const prevIdx = currentProgress.current_index;

  const updatedPages: ReadingSessionPageProgressItemDTO[] =
    currentProgress.pages.map((item, idx) => {
      if (idx === prevIdx && targetIdx === prevIdx + 1) {
        return {
          ...item,
          status: "COMPLETED",
          completed_at: item.completed_at ?? nowIso,
        };
      }
      if (idx === targetIdx && item.status === "PENDING") {
        return {
          ...item,
          status: "IN_PROGRESS",
          started_at: item.started_at ?? nowIso,
        };
      }
      return item;
    });

  const completedPages = updatedPages.filter(
    (item) => item.status === "COMPLETED",
  ).length;

  return {
    nextPage,
    nextProgress: {
      ...currentProgress,
      current_page_id: nextPage.page_id,
      current_page_number: nextPage.page_number,
      current_index: targetIdx,
      completed_pages: completedPages,
      pages: updatedPages,
    },
  };
}

export function buildOfflineCompletedCurrentPageProgress(
  currentProgress: ReadingSessionPageProgressDTO,
  pageId: string,
): ReadingSessionPageProgressDTO {
  const nowIso = new Date().toISOString();
  const updatedPages: ReadingSessionPageProgressItemDTO[] =
    currentProgress.pages.map((item) =>
      item.page_id === pageId
        ? {
            ...item,
            status: "COMPLETED",
            completed_at: item.completed_at ?? nowIso,
          }
        : item,
    );
  return {
    ...currentProgress,
    completed_pages: updatedPages.filter((p) => p.status === "COMPLETED")
      .length,
    pages: updatedPages,
  };
}

export async function playOfflineCachedPageAudio(options: {
  readonly parentAccountId: string;
  readonly childProfileId: string;
  readonly bookId: string;
  readonly page: ReadingPageDTO;
  readonly onPlay?: () => void;
  readonly onWordChange?: (index: number) => void;
  readonly onEnded?: () => void;
}): Promise<boolean> {
  const blob = await getOfflinePageMediaBlob(
    options.parentAccountId,
    options.childProfileId,
    options.bookId,
    options.page.page_id,
    "tts",
  );
  if (
    !blob ||
    typeof Audio !== "function" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return false;
  }

  const objectUrl = URL.createObjectURL(blob);
  const timings = options.page.tts_word_timings ?? null;
  const wordCount = options.page.words.length;

  return new Promise<boolean>((resolve) => {
    const audio = new Audio(objectUrl);
    let lastWordIdx = -1;
    let settled = false;

    const cleanup = () => {
      audio.ontimeupdate = null;
      audio.onended = null;
      audio.onerror = null;
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore revoke errors
      }
    };

    audio.ontimeupdate = () => {
      if (!options.onWordChange || wordCount === 0) return;
      const t = audio.currentTime;
      let idx = -1;
      if (timings && timings.length === wordCount) {
        for (let i = 0; i < timings.length; i += 1) {
          if (t >= timings[i].start && t <= timings[i].end + 0.08) {
            idx = i;
            break;
          }
        }
      } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const ratio = Math.max(0, Math.min(0.9999, t / audio.duration));
        idx = Math.min(wordCount - 1, Math.floor(ratio * wordCount));
      }
      if (idx >= 0 && idx !== lastWordIdx) {
        lastWordIdx = idx;
        options.onWordChange(idx);
      }
    };

    audio.onended = () => {
      if (settled) return;
      settled = true;
      cleanup();
      options.onEnded?.();
      resolve(true);
    };

    audio.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };

    options.onPlay?.();
    void audio.play().catch(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    });
  });
}
