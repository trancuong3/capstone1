"use client";

import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Download,
  Printer,
  QrCode,
  Trash2,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { renderQrCodeSvg } from "@/lib/books/qr-code-svg";
import {
  enqueueOfflineReadingSession,
  fetchAndSaveOfflineReadingPack,
  getStoredOfflineReadingPack,
  listPendingOfflineSessions,
  removeStoredOfflineReadingPack,
  subscribeOfflinePackChanges,
  syncPendingOfflineSessions,
  type StoredOfflineReadingPack,
} from "@/lib/offline/offline-reading-pack";
import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";

interface OfflinePackAndQrPanelProps {
  readonly userId: string;
  readonly book: BookDetailDTO;
  readonly child: ChildProfileDTO;
  readonly startPageId: string | null;
}

export function OfflinePackAndQrPanel({
  userId,
  book,
  child,
  startPageId,
}: OfflinePackAndQrPanelProps) {
  const t = useTranslations("books");
  const tCommon = useTranslations("common");
  const { formatNumber } = useI18n();

  const [storedPack, setStoredPack] = useState<StoredOfflineReadingPack | null>(
    null,
  );
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [statusBanner, setStatusBanner] = useState<{
    readonly tone: "info" | "error";
    readonly text: string;
  } | null>(null);

  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [offlineReaderOpen, setOfflineReaderOpen] = useState(false);
  const [readerPageIndex, setReaderPageIndex] = useState(0);
  const [practicedByPage, setPracticedByPage] = useState<
    Record<string, string[]>
  >({});
  const readerStartedAtRef = useRef<string>(new Date().toISOString());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const packStages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 35, label: t("offlinePack.stageDownloadingPages") },
      { atPct: 75, label: t("offlinePack.stageSavingDevice") },
    ],
    [t, tCommon],
  );
  const packProgress = useAiProgress({
    active: downloading,
    realPercent: downloadPct,
    stages: packStages,
    expectedDurationMs: 3_500,
  });

  const refreshLocalState = useCallback(async () => {
    if (!userId.trim()) {
      setStoredPack(null);
      setPendingSyncCount(0);
      return;
    }
    const [pack, outbox] = await Promise.all([
      getStoredOfflineReadingPack(userId, book.id),
      listPendingOfflineSessions(userId),
    ]);
    setStoredPack(pack);
    setPendingSyncCount(outbox.filter((o) => o.book_id === book.id).length);
  }, [book.id, userId]);

  useEffect(() => {
    void Promise.resolve().then(() => refreshLocalState());
    return subscribeOfflinePackChanges(() => {
      void refreshLocalState();
    });
  }, [refreshLocalState]);

  const handleDownloadPack = useCallback(async () => {
    if (!userId.trim() || downloading) return;
    setDownloading(true);
    setDownloadPct(8);
    setStatusBanner(null);
    try {
      const saved = await fetchAndSaveOfflineReadingPack(userId, book.id, {
        onProgress: (pct) => setDownloadPct(pct),
      });
      setStoredPack(saved);
      setStatusBanner({
        tone: "info",
        text: t("offlinePack.savedNotice", {
          count: formatNumber(saved.pack.pages.length),
        }),
      });
    } catch {
      setStatusBanner({
        tone: "error",
        text: t("offlinePack.downloadError"),
      });
    } finally {
      setDownloading(false);
      setDownloadPct(null);
    }
  }, [book.id, downloading, formatNumber, t, userId]);

  const handleRemovePack = useCallback(async () => {
    if (!userId.trim()) return;
    await removeStoredOfflineReadingPack(userId, book.id);
    setStoredPack(null);
    setStatusBanner({
      tone: "info",
      text: t("offlinePack.removedNotice"),
    });
  }, [book.id, t, userId]);

  const handleSyncNow = useCallback(async () => {
    if (!userId.trim() || syncing) return;
    setSyncing(true);
    setStatusBanner(null);
    try {
      const res = await syncPendingOfflineSessions(userId);
      await refreshLocalState();
      if (res.syncedCount > 0) {
        setStatusBanner({
          tone: "info",
          text: t("offlinePack.syncedNotice", {
            count: formatNumber(res.syncedCount),
          }),
        });
      } else if (res.failedCount > 0) {
        setStatusBanner({
          tone: "error",
          text: t("offlinePack.syncDeferredNotice"),
        });
      }
    } finally {
      setSyncing(false);
    }
  }, [formatNumber, refreshLocalState, syncing, t, userId]);

  const openOfflineReader = useCallback(() => {
    if (!storedPack || storedPack.pack.pages.length === 0) return;
    const targetIdx = startPageId
      ? storedPack.pack.pages.findIndex((p) => p.page_id === startPageId)
      : 0;
    setReaderPageIndex(targetIdx >= 0 ? targetIdx : 0);
    setPracticedByPage({});
    readerStartedAtRef.current = new Date().toISOString();
    setOfflineReaderOpen(true);
  }, [startPageId, storedPack]);

  const handleFinishOfflineSession = useCallback(async () => {
    if (!storedPack || !userId.trim()) return;
    audioRef.current?.pause();
    const pagesPayload = storedPack.pack.pages.map((p) => {
      const clickedIds = new Set(practicedByPage[p.page_id] ?? []);
      const spokenTokens =
        clickedIds.size > 0
          ? p.words.filter((w) => clickedIds.has(w.word_id)).map((w) => w.text)
          : p.words.map((w) => w.text);
      return {
        page_id: p.page_id,
        page_revision_id: p.page_revision_id,
        completed: true,
        transcript: spokenTokens.join(" "),
        started_at: readerStartedAtRef.current,
        completed_at: new Date().toISOString(),
      };
    });
    const eventsPayload = storedPack.pack.pages.flatMap((p) =>
      (practicedByPage[p.page_id] ?? []).map((wordId, idx) => ({
        page_id: p.page_id,
        page_revision_id: p.page_revision_id,
        word_id: wordId,
        type: "WORD_RETRY" as const,
        status: "CONFIRMED" as const,
        start_ms: idx * 400,
        end_ms: idx * 400 + 320,
      })),
    );

    await enqueueOfflineReadingSession(userId, {
      childId: child.id,
      bookId: book.id,
      startedAt: readerStartedAtRef.current,
      endedAt: new Date().toISOString(),
      pages: pagesPayload,
      events: eventsPayload,
    });
    setOfflineReaderOpen(false);

    if (typeof navigator === "undefined" || navigator.onLine !== false) {
      const res = await syncPendingOfflineSessions(userId);
      if (res.syncedCount > 0) {
        setStatusBanner({
          tone: "info",
          text: t("offlinePack.syncedNotice", {
            count: formatNumber(res.syncedCount),
          }),
        });
      } else {
        setStatusBanner({
          tone: "info",
          text: t("offlinePack.queuedOfflineNotice"),
        });
      }
    } else {
      setStatusBanner({
        tone: "info",
        text: t("offlinePack.queuedOfflineNotice"),
      });
    }
    await refreshLocalState();
  }, [
    book.id,
    child.id,
    formatNumber,
    practicedByPage,
    refreshLocalState,
    storedPack,
    t,
    userId,
  ]);

  const qrTargetUrl = useMemo(() => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://viread-frontend.vercel.app";
    const params = new URLSearchParams({ qr: "1" });
    if (startPageId) params.set("pageId", startPageId);
    return `${origin}/books/${encodeURIComponent(book.id)}?${params.toString()}`;
  }, [book.id, startPageId]);

  const qrSvgMarkup = useMemo(() => {
    if (!qrModalOpen) return "";
    try {
      return renderQrCodeSvg(qrTargetUrl, {
        size: 204,
        margin: 4,
        title: book.title,
      });
    } catch {
      return "";
    }
  }, [book.title, qrModalOpen, qrTargetUrl]);

  const activeOfflinePage =
    storedPack?.pack.pages[
      Math.min(
        Math.max(0, readerPageIndex),
        Math.max(0, (storedPack?.pack.pages.length ?? 1) - 1),
      )
    ] ?? null;

  return (
    <section
      aria-label={t("offlinePack.heading")}
      className="rounded-card border border-border bg-white p-4"
      data-testid="offline-pack-and-qr-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <WifiOff aria-hidden="true" className="size-4 text-primary" />
            <h2 className="text-sm font-extrabold text-ink sm:text-base">
              {t("offlinePack.heading")}
            </h2>
            {storedPack ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                <CheckCircle2 aria-hidden="true" className="size-3.5" />
                {t("offlinePack.readyBadge", {
                  count: formatNumber(storedPack.pack.pages.length),
                })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted sm:text-sm">
            {t("offlinePack.description")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!storedPack ? (
            <Button
              className="w-auto"
              data-testid="download-offline-pack-btn"
              disabled={downloading || !userId}
              fullWidth={false}
              isLoading={downloading}
              onClick={() => void handleDownloadPack()}
              size="compact"
              type="button"
              variant="secondary"
            >
              <Download aria-hidden="true" className="size-4" />
              {t("offlinePack.downloadButton")}
            </Button>
          ) : (
            <>
              <Button
                className="w-auto"
                data-testid="open-offline-reader-btn"
                fullWidth={false}
                onClick={openOfflineReader}
                size="compact"
                type="button"
              >
                {t("offlinePack.openOfflineReader")}
              </Button>
              <Button
                aria-label={t("offlinePack.removeButton")}
                className="w-auto"
                fullWidth={false}
                onClick={() => void handleRemovePack()}
                size="compact"
                type="button"
                variant="quiet"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                {t("offlinePack.removeButton")}
              </Button>
            </>
          )}

          <Button
            className="w-auto"
            data-testid="open-printable-qr-card-btn"
            fullWidth={false}
            onClick={() => setQrModalOpen(true)}
            size="compact"
            type="button"
            variant="secondary"
          >
            <QrCode aria-hidden="true" className="size-4" />
            {t("qrCard.openButton")}
          </Button>

          {pendingSyncCount > 0 ? (
            <Button
              className="w-auto"
              data-testid="sync-offline-sessions-btn"
              disabled={syncing}
              fullWidth={false}
              isLoading={syncing}
              onClick={() => void handleSyncNow()}
              size="compact"
              type="button"
              variant="secondary"
            >
              <CloudUpload aria-hidden="true" className="size-4" />
              {t("offlinePack.syncPendingButton", {
                count: formatNumber(pendingSyncCount),
              })}
            </Button>
          ) : null}
        </div>
      </div>

      {downloading ? (
        <div className="mt-3">
          <AiProgressBar
            active
            label={
              packProgress.stageLabel ?? t("offlinePack.stageDownloadingPages")
            }
            percent={packProgress.percent}
            size="compact"
            testId="offline-pack-download-progress"
          />
        </div>
      ) : null}

      {statusBanner ? (
        <div className="mt-3">
          <StatusMessage tone={statusBanner.tone}>
            {statusBanner.text}
          </StatusMessage>
        </div>
      ) : null}

      {qrModalOpen ? (
        <div
          aria-label={t("qrCard.modalTitle")}
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-white print:p-0"
          data-testid="printable-qr-card-modal"
          role="dialog"
        >
          <div className="w-full max-w-md rounded-card border-2 border-primary/30 bg-white p-6 shadow-xl print:max-w-none print:border-black print:shadow-none">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                  ViRead · {t("qrCard.eyebrow")}
                </p>
                <h3
                  className="viread-learning-content mt-1 text-xl font-extrabold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {book.title}
                </h3>
              </div>
              <button
                aria-label={tCommon("actions.close")}
                className="rounded-full p-1.5 text-muted hover:bg-surface-subtle print:hidden"
                onClick={() => setQrModalOpen(false)}
                type="button"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>

            <div className="my-4 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-cream/60 p-4">
              {qrSvgMarkup ? (
                <div
                  className="rounded-lg bg-white p-2 shadow-2xs"
                  data-testid="printable-qr-svg-container"
                  dangerouslySetInnerHTML={{ __html: qrSvgMarkup }}
                />
              ) : null}
              <p className="mt-3 text-center text-xs font-semibold text-ink">
                {t("qrCard.scanInstruction")}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
              <Button
                className="w-auto"
                fullWidth={false}
                onClick={() => setQrModalOpen(false)}
                size="compact"
                type="button"
                variant="quiet"
              >
                {tCommon("actions.close")}
              </Button>
              <Button
                className="w-auto"
                data-testid="print-qr-card-btn"
                fullWidth={false}
                onClick={() => {
                  if (typeof window !== "undefined" && window.print) {
                    window.print();
                  }
                }}
                size="compact"
                type="button"
              >
                <Printer aria-hidden="true" className="size-4" />
                {t("qrCard.printButton")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {offlineReaderOpen && storedPack && activeOfflinePage ? (
        <div
          aria-label={storedPack.pack.book.title}
          aria-modal="true"
          className="fixed inset-0 z-50 flex flex-col bg-canvas p-4 sm:p-6"
          data-testid="offline-pack-reader-modal"
          role="dialog"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 overflow-hidden rounded-card border border-border bg-white p-4 shadow-lg sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <div>
                <p className="text-xs font-bold text-primary">
                  {t("offlinePack.readerHeaderBadge", {
                    page: formatNumber(activeOfflinePage.page_number),
                    total: formatNumber(storedPack.pack.pages.length),
                  })}
                </p>
                <h3
                  className="viread-learning-content text-lg font-extrabold text-ink sm:text-xl"
                  dir="ltr"
                  lang="vi"
                >
                  {storedPack.pack.book.title}
                </h3>
              </div>
              <div className="flex items-center gap-2">
                {storedPack.cachedAudioByPageId[activeOfflinePage.page_id] ||
                activeOfflinePage.tts_audio_url ? (
                  <Button
                    className="w-auto"
                    fullWidth={false}
                    onClick={() => {
                      const src =
                        storedPack.cachedAudioByPageId[
                          activeOfflinePage.page_id
                        ] ?? activeOfflinePage.tts_audio_url;
                      if (!src) return;
                      if (!audioRef.current) {
                        audioRef.current = new Audio();
                      }
                      audioRef.current.src = src;
                      void audioRef.current.play().catch(() => undefined);
                    }}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    <Volume2 aria-hidden="true" className="size-4" />
                    {t("offlinePack.listenCachedAudio")}
                  </Button>
                ) : null}
                <Button
                  className="w-auto"
                  fullWidth={false}
                  onClick={() => {
                    audioRef.current?.pause();
                    setOfflineReaderOpen(false);
                  }}
                  size="compact"
                  type="button"
                  variant="quiet"
                >
                  <X aria-hidden="true" className="size-4" />
                  {tCommon("actions.close")}
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto py-3">
              <p className="mb-2 text-xs font-semibold text-muted">
                {t("offlinePack.tapWordsHint")}
              </p>
              <p
                className="viread-learning-content flex flex-wrap gap-2 text-2xl font-bold leading-relaxed text-ink sm:text-3xl"
                dir="ltr"
                lang="vi"
              >
                {activeOfflinePage.words.map((word) => {
                  const practiced = (
                    practicedByPage[activeOfflinePage.page_id] ?? []
                  ).includes(word.word_id);
                  return (
                    <button
                      className={`rounded-control border-b-4 px-2.5 py-1 transition-colors ${
                        practiced
                          ? "border-emerald-600 bg-emerald-100 text-emerald-950"
                          : "border-border bg-cream/60 hover:bg-highlight/40"
                      }`}
                      key={word.word_id}
                      onClick={() => {
                        setPracticedByPage((prev) => {
                          const existing =
                            prev[activeOfflinePage.page_id] ?? [];
                          const next = existing.includes(word.word_id)
                            ? existing
                            : [...existing, word.word_id];
                          return {
                            ...prev,
                            [activeOfflinePage.page_id]: next,
                          };
                        });
                      }}
                      type="button"
                    >
                      {word.text}
                    </button>
                  );
                })}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Button
                  className="w-auto"
                  disabled={readerPageIndex <= 0}
                  fullWidth={false}
                  onClick={() => setReaderPageIndex((i) => Math.max(0, i - 1))}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <ChevronLeft
                    aria-hidden="true"
                    className="viread-rtl-flip size-4"
                  />
                  {t("offlinePack.prevPage")}
                </Button>
                <Button
                  className="w-auto"
                  disabled={readerPageIndex >= storedPack.pack.pages.length - 1}
                  fullWidth={false}
                  onClick={() =>
                    setReaderPageIndex((i) =>
                      Math.min(storedPack.pack.pages.length - 1, i + 1),
                    )
                  }
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {t("offlinePack.nextPage")}
                  <ChevronRight
                    aria-hidden="true"
                    className="viread-rtl-flip size-4"
                  />
                </Button>
              </div>
              <Button
                className="w-auto"
                data-testid="finish-offline-session-btn"
                fullWidth={false}
                onClick={() => void handleFinishOfflineSession()}
                size="compact"
                type="button"
              >
                {t("offlinePack.finishAndQueueSync")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
