"use client";

import {
  CheckCircle2,
  CloudOff,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Button } from "@/components/common/button";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n } from "@/hooks/use-i18n";
import {
  drainOfflineSessionOutbox,
  generateUuidV4,
  getOfflineOutboxStatusSnapshot,
  subscribeOfflineSessionOutbox,
  type OfflineOutboxStatusSnapshot,
} from "@/lib/offline/offline-session-outbox";
import {
  MAX_WEEKLY_PLAN_OFFLINE_BOOKS,
  deleteOfflineBookPack,
  downloadAndSaveOfflineBookPack,
  downloadWeeklyReadingPlanPacks,
  estimateOfflineBookPackBytes,
  listOfflineBookPacks,
  saveOfflineSessionDescriptor,
  subscribeOfflinePackStore,
  type DownloadOfflineBookPackOptions,
  type StoredOfflineBookPackSummary,
} from "@/lib/offline/reading-pack-store";
import { registerOfflineServiceWorker } from "@/lib/offline/register-offline-sw";
import {
  SHERPA_WASM_MODEL_BYTES,
  detectBrowserWasmSttSupport,
  getBrowserWasmSttClient,
  getWasmModelCacheStatus,
  type WasmModelCacheStatus,
} from "@/lib/reading/browser-wasm-stt";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";
import type { ReadingPlanDTO } from "@/types/reading-management";

function formatMegabytes(bytes: number): string {
  const mb = Math.max(0.1, bytes / (1024 * 1024));
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

export interface OfflinePackSingleProps {
  readonly mode?: "single";
  readonly bookId: string;
  readonly bookTitle?: string;
  readonly estimatedPageCount?: number;
  readonly compact?: boolean;
  readonly parentAccountId?: string | null;
  readonly childProfileId?: string | null;
  readonly child?: ChildProfileDTO | null;
  readonly fetchManifest?: DownloadOfflineBookPackOptions["fetchManifest"];
  readonly fetchBinary?: DownloadOfflineBookPackOptions["fetchBinary"];
  readonly className?: string;
}

export interface OfflinePackWeeklyPlanProps {
  readonly mode: "weekly-plan";
  readonly plans: readonly ReadingPlanDTO[];
  readonly fallbackBookIds?: readonly string[];
  readonly parentAccountId?: string | null;
  readonly childProfileId?: string | null;
  readonly fetchManifest?: DownloadOfflineBookPackOptions["fetchManifest"];
  readonly fetchBinary?: DownloadOfflineBookPackOptions["fetchBinary"];
  readonly className?: string;
}

export type OfflinePackControlsProps =
  | OfflinePackSingleProps
  | OfflinePackWeeklyPlanProps;

export function OfflineOutboxStatusPill({
  parentAccountId,
  childProfileId,
  className,
}: {
  readonly parentAccountId: string | null | undefined;
  readonly childProfileId: string | null | undefined;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<OfflineOutboxStatusSnapshot>(() =>
    getOfflineOutboxStatusSnapshot(parentAccountId, childProfileId),
  );

  useEffect(() => {
    const sync = () => {
      setSnapshot(
        getOfflineOutboxStatusSnapshot(parentAccountId, childProfileId),
      );
    };
    sync();
    return subscribeOfflineSessionOutbox(sync);
  }, [childProfileId, parentAccountId]);

  if (snapshot.state === "idle") {
    return null;
  }

  const isSyncing = snapshot.state === "syncing";
  const isSynced = snapshot.state === "synced";
  const isError = snapshot.state === "error";

  const label = isSyncing
    ? t("offlinePack.outbox.syncing", { count: snapshot.pendingCount })
    : isSynced
      ? t("offlinePack.outbox.synced")
      : isError
        ? t("offlinePack.outbox.syncError", { count: snapshot.pendingCount })
        : t("offlinePack.outbox.pendingOffline", {
            count: snapshot.pendingCount,
          });

  return (
    <span
      aria-live="polite"
      data-testid="offline-outbox-status-pill"
      data-sync-state={snapshot.state}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold",
        isSynced
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : isSyncing
            ? "border-primary/30 bg-sky text-primary-hover"
            : "border-amber-200 bg-amber-50 text-amber-900",
        className,
      )}
    >
      {isSyncing ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : isSynced ? (
        <CheckCircle2 aria-hidden="true" className="size-3.5" />
      ) : (
        <RefreshCw aria-hidden="true" className="size-3.5" />
      )}
      <span>{label}</span>
      {!isSyncing &&
      !isSynced &&
      snapshot.pendingCount > 0 &&
      parentAccountId &&
      childProfileId &&
      (typeof navigator === "undefined" || navigator.onLine !== false) ? (
        <button
          type="button"
          className="ms-1 underline hover:no-underline"
          onClick={() => {
            void drainOfflineSessionOutbox({
              parentAccountId,
              childProfileId,
            }).catch(() => undefined);
          }}
        >
          {t("offlinePack.outbox.syncNowButton")}
        </button>
      ) : null}
    </span>
  );
}

export function OfflinePackControls(props: OfflinePackControlsProps) {
  const { t } = useI18n();
  const router = useRouter();
  const authRuntime = useAuthRuntime();
  const appStore = useContext(AppStoreContext);

  const effectiveParentId =
    (props.parentAccountId ??
      authRuntime.session?.user?.id ??
      authRuntime.initialUserId ??
      "")
      .trim() || null;

  const explicitChild = props.mode !== "weekly-plan" ? props.child : null;
  const effectiveChildId =
    (props.childProfileId ??
      explicitChild?.id ??
      appStore?.selectedChildId ??
      "")
      .trim() || null;
  const effectiveChildObj =
    explicitChild ?? appStore?.validatedSelectedChild ?? null;

  const [packs, setPacks] = useState<StoredOfflineBookPackSummary[]>([]);
  const [wasmStatus, setWasmStatus] = useState<WasmModelCacheStatus | null>(
    null,
  );
  const [wasmSupported] = useState<boolean>(
    () => detectBrowserWasmSttSupport().supported,
  );
  const [isWarmingWasm, setIsWarmingWasm] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "idle" | "downloading" | "deleting"
  >("idle");
  const [weeklyProgress, setWeeklyProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [isOfflineNow, setIsOfflineNow] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine === false : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncOnline = () => setIsOfflineNow(navigator.onLine === false);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  const refreshPacks = useCallback(async () => {
    if (!effectiveParentId || !effectiveChildId) {
      setPacks([]);
      return;
    }
    const items = await listOfflineBookPacks(
      effectiveParentId,
      effectiveChildId,
    );
    setPacks(items);
  }, [effectiveChildId, effectiveParentId]);

  useEffect(() => {
    let active = true;
    const syncPacksAsync = () => {
      const loadPromise =
        effectiveParentId && effectiveChildId
          ? listOfflineBookPacks(effectiveParentId, effectiveChildId)
          : Promise.resolve<StoredOfflineBookPackSummary[]>([]);
      void loadPromise.then((items) => {
        if (active) setPacks(items);
      });
    };
    syncPacksAsync();
    const unsubscribe = subscribeOfflinePackStore(syncPacksAsync);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [effectiveChildId, effectiveParentId]);

  useEffect(() => {
    if (!wasmSupported) return;
    let active = true;
    void getWasmModelCacheStatus().then((status) => {
      if (active) setWasmStatus(status);
    });
    return () => {
      active = false;
    };
  }, [wasmSupported]);

  const handleWarmWasmModel = useCallback(async () => {
    if (isWarmingWasm) return;
    setIsWarmingWasm(true);
    try {
      await getBrowserWasmSttClient().init();
      const updated = await getWasmModelCacheStatus();
      setWasmStatus(updated);
    } catch {
      // Keep UI calm if model preload fails while offline
    } finally {
      setIsWarmingWasm(false);
    }
  }, [isWarmingWasm]);

  const wasmLabel = useMemo(() => {
    if (!wasmSupported) {
      return t("offlinePack.wasmStt.unsupported");
    }
    if (isWarmingWasm) {
      return t("offlinePack.wasmStt.warming");
    }
    if (wasmStatus?.ready || getBrowserWasmSttClient().isReady()) {
      return t("offlinePack.wasmStt.ready");
    }
    if (wasmStatus && wasmStatus.cachedFiles > 0) {
      return t("offlinePack.wasmStt.cachedPartial", {
        done: wasmStatus.cachedFiles,
        total: wasmStatus.expectedFiles,
      });
    }
    return t("offlinePack.wasmStt.notDownloaded");
  }, [isWarmingWasm, t, wasmStatus, wasmSupported]);

  if (props.mode === "weekly-plan") {
    const weeklyBookIds = Array.from(
      new Set(
        [
          ...props.plans
            .filter((p) => p.status === "ACTIVE" || p.status === "PAUSED")
            .map((p) => p.book_id)
            .filter((id): id is string => Boolean(id && id.trim())),
          ...(props.fallbackBookIds ?? []),
        ]
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ).slice(0, MAX_WEEKLY_PLAN_OFFLINE_BOOKS);

    if (!effectiveParentId || !effectiveChildId) {
      return null;
    }

    const downloadedWeeklyPacks = packs.filter((p) =>
      weeklyBookIds.includes(p.bookId),
    );
    const totalEstBytes =
      downloadedWeeklyPacks.length === weeklyBookIds.length &&
      downloadedWeeklyPacks.length > 0
        ? downloadedWeeklyPacks.reduce((acc, item) => acc + item.storedBytes, 0)
        : Math.max(1, weeklyBookIds.length) * estimateOfflineBookPackBytes(4);

    const handleDownloadWeekly = async () => {
      if (busyAction !== "idle" || weeklyBookIds.length === 0) return;
      setBusyAction("downloading");
      setErrorText(null);
      setWeeklyProgress({ done: 0, total: weeklyBookIds.length });
      try {
        void registerOfflineServiceWorker();
        await downloadWeeklyReadingPlanPacks({
          parentAccountId: effectiveParentId,
          childProfileId: effectiveChildId,
          bookIds: weeklyBookIds,
          fetchManifest: props.fetchManifest,
          fetchBinary: props.fetchBinary,
          onProgress: (done, total) => setWeeklyProgress({ done, total }),
        });
        await refreshPacks();
      } catch {
        setErrorText(t("offlinePack.controls.downloadError"));
      } finally {
        setBusyAction("idle");
        setWeeklyProgress(null);
      }
    };

    const handleDeleteWeekly = async () => {
      if (busyAction !== "idle" || downloadedWeeklyPacks.length === 0) return;
      setBusyAction("deleting");
      setErrorText(null);
      try {
        for (const item of downloadedWeeklyPacks) {
          await deleteOfflineBookPack(
            effectiveParentId,
            effectiveChildId,
            item.bookId,
          );
        }
        await refreshPacks();
      } finally {
        setBusyAction("idle");
      }
    };

    return (
      <div
        data-testid="offline-weekly-plan-controls"
        className={cn(
          "mt-2.5 flex flex-col gap-2 rounded-control border border-border/80 bg-canvas/60 p-3",
          props.className,
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-extrabold text-ink sm:text-sm">
              <CloudOff aria-hidden="true" className="size-4 text-primary" />
              <span>{t("offlinePack.controls.weeklyPlanTitle")}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {weeklyBookIds.length > 0
                ? t("offlinePack.controls.weeklyPlanSubtitle")
                : t("offlinePack.controls.noWeeklyBooksHint")}
            </p>
          </div>
          <OfflineOutboxStatusPill
            parentAccountId={effectiveParentId}
            childProfileId={effectiveChildId}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span data-testid="offline-weekly-size-estimate" className="font-semibold text-ink">
            {t("offlinePack.controls.sizeEstimate", {
              sizeMb: formatMegabytes(totalEstBytes),
            })}
          </span>
          {weeklyBookIds.length > 0 ? (
            <span>
              ·{" "}
              {t("offlinePack.controls.weeklyPackReadyCount", {
                count: downloadedWeeklyPacks.length,
                total: weeklyBookIds.length,
              })}
            </span>
          ) : null}
          <span
            data-testid="offline-wasm-stt-status"
            className="inline-flex items-center gap-1"
          >
            · <Cpu aria-hidden="true" className="size-3.5 text-primary" />{" "}
            {wasmLabel}
          </span>
        </div>

        {errorText ? (
          <p role="alert" className="text-xs font-semibold text-danger">
            {errorText}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="offline-download-weekly-btn"
            variant="secondary"
            size="compact"
            fullWidth={false}
            disabled={
              busyAction !== "idle" || weeklyBookIds.length === 0 || isOfflineNow
            }
            isLoading={busyAction === "downloading"}
            onClick={() => void handleDownloadWeekly()}
            className="min-h-11 w-auto px-3 text-xs font-bold sm:text-sm"
          >
            <Download aria-hidden="true" className="size-4" />
            {busyAction === "downloading" && weeklyProgress
              ? t("offlinePack.controls.downloadingWeeklyPack", {
                  done: weeklyProgress.done,
                  total: weeklyProgress.total,
                })
              : t("offlinePack.controls.downloadWeeklyPack")}
          </Button>
          {downloadedWeeklyPacks.length > 0 ? (
            <Button
              data-testid="offline-weekly-delete-btn"
              variant="quiet"
              size="compact"
              fullWidth={false}
              disabled={busyAction !== "idle"}
              onClick={() => void handleDeleteWeekly()}
              className="min-h-11 w-auto border border-border bg-white px-3 text-xs font-semibold text-muted hover:text-ink"
            >
              <Trash2 aria-hidden="true" className="size-4" />
              {busyAction === "deleting"
                ? t("offlinePack.controls.deletingPack")
                : t("offlinePack.controls.deletePack")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // Single-book mode (`BookCard` compact vs `BookDetailScreen` full)
  if (props.compact && (!effectiveParentId || !effectiveChildId)) {
    return null;
  }

  const currentPack = packs.find((item) => item.bookId === props.bookId) ?? null;
  const estBytes = currentPack
    ? currentPack.storedBytes
    : estimateOfflineBookPackBytes(props.estimatedPageCount ?? 4);

  const handleDownloadSingle = async () => {
    if (!effectiveParentId || !effectiveChildId || busyAction !== "idle") {
      return;
    }
    setBusyAction("downloading");
    setErrorText(null);
    try {
      void registerOfflineServiceWorker();
      await downloadAndSaveOfflineBookPack({
        parentAccountId: effectiveParentId,
        childProfileId: effectiveChildId,
        bookId: props.bookId,
        fetchManifest: props.fetchManifest,
        fetchBinary: props.fetchBinary,
      });
      await refreshPacks();
    } catch {
      setErrorText(t("offlinePack.controls.downloadError"));
    } finally {
      setBusyAction("idle");
    }
  };

  const handleDeleteSingle = async () => {
    if (!effectiveParentId || !effectiveChildId || busyAction !== "idle") {
      return;
    }
    setBusyAction("deleting");
    setErrorText(null);
    try {
      await deleteOfflineBookPack(
        effectiveParentId,
        effectiveChildId,
        props.bookId,
      );
      await refreshPacks();
    } finally {
      setBusyAction("idle");
    }
  };

  const handleOpenOfflineReader = async () => {
    if (!effectiveParentId || !effectiveChildId || !currentPack) return;
    const offlineSessionUuid = generateUuidV4();
    const sessionRouteId = `offline-${offlineSessionUuid}`;
    const fallbackChild: ChildProfileDTO = effectiveChildObj ?? {
      id: effectiveChildId,
      parent_id: effectiveParentId,
      alias: "Bé",
      grade: currentPack.grade,
      settings: {},
      created_at: new Date().toISOString(),
    };
    await saveOfflineSessionDescriptor({
      parentAccountId: effectiveParentId,
      childProfileId: effectiveChildId,
      sessionId: sessionRouteId,
      clientSessionId: offlineSessionUuid,
      bookId: props.bookId,
      child: fallbackChild,
      startPageId: null,
      endPageId: null,
      currentPageId: null,
    });
    router.push(
      `/reading/${encodeURIComponent(sessionRouteId)}?state=reading&bookId=${encodeURIComponent(props.bookId)}`,
    );
  };

  if (props.compact) {
    return (
      <div
        data-testid={`offline-card-controls-${props.bookId}`}
        className={cn("flex w-full flex-wrap items-center gap-1.5", props.className)}
      >
        {currentPack ? (
          <>
            <span className="inline-flex min-h-9 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {t("offlinePack.controls.downloadedBadge")} (
              {formatMegabytes(currentPack.storedBytes)} MB)
            </span>
            <button
              type="button"
              data-testid="offline-pack-delete-btn"
              aria-label={t("offlinePack.controls.deletePack")}
              disabled={busyAction !== "idle"}
              onClick={() => void handleDeleteSingle()}
              className="inline-flex min-h-11 items-center gap-1 rounded-control border border-border bg-white px-2.5 text-xs font-semibold text-muted hover:bg-canvas hover:text-ink"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              {t("offlinePack.controls.deletePack")}
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="offline-pack-download-btn"
            disabled={busyAction !== "idle" || isOfflineNow}
            onClick={() => void handleDownloadSingle()}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control border border-border bg-canvas/80 px-3 text-xs font-bold text-ink transition-colors hover:bg-sky sm:w-auto"
          >
            {busyAction === "downloading" ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <Download aria-hidden="true" className="size-3.5 text-primary" />
            )}
            <span>
              {busyAction === "downloading"
                ? t("offlinePack.controls.downloadingSingle")
                : t("offlinePack.controls.downloadSingle")}
            </span>
            <span className="text-muted">
              (~{formatMegabytes(estBytes)} MB)
            </span>
          </button>
        )}
      </div>
    );
  }

  return (
    <section
      data-testid="offline-pack-detail-controls"
      className={cn(
        "flex flex-col gap-3 rounded-card border border-border bg-white p-4",
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CloudOff aria-hidden="true" className="size-5 text-primary" />
          <span className="text-sm font-extrabold text-ink sm:text-base">
            {currentPack
              ? t("offlinePack.controls.downloadedBadge")
              : t("offlinePack.controls.downloadSingle")}
          </span>
          <span
            data-testid="offline-pack-size-estimate"
            className="rounded-full bg-canvas px-2.5 py-0.5 text-xs font-semibold text-muted"
          >
            {currentPack
              ? t("offlinePack.controls.storedSize", {
                  sizeMb: formatMegabytes(currentPack.storedBytes),
                  pages: currentPack.pageCount,
                })
              : t("offlinePack.controls.sizeEstimate", {
                  sizeMb: formatMegabytes(estBytes),
                })}
          </span>
        </div>
        <OfflineOutboxStatusPill
          parentAccountId={effectiveParentId}
          childProfileId={effectiveChildId}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-canvas/70 px-3 py-2 text-xs text-muted">
        <span
          data-testid="offline-wasm-stt-status"
          className="inline-flex items-center gap-1.5 font-semibold text-ink"
        >
          <Cpu aria-hidden="true" className="size-4 text-primary" />
          <span>{wasmLabel}</span>
          {!wasmStatus?.ready && wasmSupported ? (
            <span className="font-normal text-muted">
              (~{formatMegabytes(SHERPA_WASM_MODEL_BYTES)} MB)
            </span>
          ) : null}
        </span>
        {wasmSupported &&
        !wasmStatus?.ready &&
        !getBrowserWasmSttClient().isReady() &&
        !isOfflineNow ? (
          <button
            type="button"
            data-testid="offline-warm-wasm-btn"
            disabled={isWarmingWasm}
            onClick={() => void handleWarmWasmModel()}
            className="min-h-9 rounded-control border border-border bg-white px-2.5 py-1 text-xs font-bold text-primary hover:bg-sky"
          >
            {isWarmingWasm
              ? t("offlinePack.wasmStt.warming")
              : t("offlinePack.wasmStt.warmButton")}
          </button>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        {!effectiveParentId || !effectiveChildId
          ? t("offlinePack.controls.childRequiredHint")
          : t("offlinePack.controls.privateIsolationNote")}
      </p>

      {errorText ? (
        <p role="alert" className="text-xs font-semibold text-danger">
          {errorText}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="offline-pack-download-btn"
          variant={currentPack ? "secondary" : "primary"}
          disabled={
            !effectiveParentId ||
            !effectiveChildId ||
            busyAction !== "idle" ||
            isOfflineNow
          }
          isLoading={busyAction === "downloading"}
          onClick={() => void handleDownloadSingle()}
          className="min-h-12 w-full sm:w-auto"
        >
          <Download aria-hidden="true" className="size-4" />
          {busyAction === "downloading"
            ? t("offlinePack.controls.downloadingSingle")
            : currentPack
              ? t("offlinePack.controls.redownloadSingle")
              : t("offlinePack.controls.downloadSingle")}
        </Button>

        {currentPack && isOfflineNow ? (
          <Button
            data-testid="offline-pack-open-reader-btn"
            variant="primary"
            onClick={() => void handleOpenOfflineReader()}
            className="min-h-12 w-full sm:w-auto"
          >
            {t("offlinePack.controls.openOfflineNow")}
          </Button>
        ) : null}

        {currentPack ? (
          <Button
            data-testid="offline-pack-delete-btn"
            variant="quiet"
            disabled={busyAction !== "idle"}
            onClick={() => void handleDeleteSingle()}
            className="min-h-12 w-full border border-border bg-white sm:w-auto"
          >
            <Trash2 aria-hidden="true" className="size-4" />
            {busyAction === "deleting"
              ? t("offlinePack.controls.deletingPack")
              : t("offlinePack.controls.deletePack")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
