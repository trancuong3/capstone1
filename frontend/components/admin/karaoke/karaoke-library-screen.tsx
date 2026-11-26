"use client";

import { Eye, EyeOff, Music2, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AdminBadge,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminStatusBadge,
  AdminToolbar,
} from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { useTranslations } from "@/hooks/use-i18n";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";
import type { AdminKaraokeList } from "@/types/karaoke";

const KARAOKE_STATUS_KEYS = ["DRAFT", "PUBLISHED", "HIDDEN"] as const;

export const karaokeStatusLabels = {
  DRAFT: "Bản nháp",
  PUBLISHED: "Đang hiển thị",
  HIDDEN: "Đã ẩn",
};

function resolveCoverUrl(
  item: AdminKaraokeList["items"][number],
): string | null {
  const candidate = (item as { cover_url?: unknown }).cover_url;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export function KaraokeLibraryScreen() {
  const service = useAdminKaraoke();
  const t = useTranslations("admin");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "DRAFT" | "PUBLISHED" | "HIDDEN">(
    "",
  );
  const [query, setQuery] = useState({ search: "", status, offset: 0 });
  const [data, setData] = useState<AdminKaraokeList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingVisibilityItem, setPendingVisibilityItem] = useState<
    AdminKaraokeList["items"][number] | null
  >(null);
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false,
      pollNeeded = false,
      authStopped = false;
    async function load() {
      if (controller.signal.aborted || inFlight || authStopped) return;
      inFlight = true;
      try {
        const result = await service.list(
          { ...query, status: query.status || undefined },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setData(result);
        setError("");
        setLoading(false);
        pollNeeded = result.items.some(
          (item) =>
            item.processing_summary &&
            ["QUEUED", "RUNNING", "READY", "NEEDS_REVIEW"].includes(
              item.processing_summary.status,
            ),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(karaokeErrorMessage(error));
          setLoading(false);
          if (isServiceError(error) && [401, 403].includes(error.status))
            authStopped = true;
        }
      } finally {
        inFlight = false;
        if (
          !controller.signal.aborted &&
          !authStopped &&
          pollNeeded &&
          !document.hidden
        )
          timer = setTimeout(() => {
            void load();
          }, 5000);
      }
    }
    function visible() {
      clearTimeout(timer);
      if (!document.hidden && pollNeeded) void load();
    }
    document.addEventListener("visibilitychange", visible);
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [service, query, reload]);
  function refresh() {
    setError("");
    setLoading(true);
    setReload((n) => n + 1);
  }
  function filter(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setQuery({ search: search.trim(), status, offset: 0 });
  }
  function clearSearch() {
    setSearch("");
    setLoading(true);
    setError("");
    setQuery({ search: "", status, offset: 0 });
  }
  async function confirmVisibility() {
    const item = pendingVisibilityItem;
    if (!item || mutation.current) return;
    const visible = item.status === "HIDDEN";
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    try {
      await service.visibility(
        item.song_id,
        item.revision,
        visible,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setPendingVisibilityItem(null);
        refresh();
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setPendingVisibilityItem(null);
        setError(karaokeErrorMessage(e));
      }
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="grid gap-5">
      <AdminPageHeader
        eyebrow={t("karaoke.library.eyebrow")}
        title={t("karaoke.library.title")}
        description={t("karaoke.library.description")}
        actions={
          <ButtonLink fullWidth={false} href="/admin/karaoke/new" size="admin">
            <Plus aria-hidden className="size-4" />
            {t("karaoke.library.createSong")}
          </ButtonLink>
        }
      />

      <form onSubmit={filter}>
        <AdminToolbar
          actions={
            <Button
              disabled={busy}
              fullWidth={false}
              size="admin"
              type="submit"
            >
              {t("karaoke.library.apply")}
            </Button>
          }
          ariaLabel={t(
            "karaoke.library.filterAria",
            undefined,
            "Bộ lọc thư viện bài hát",
          )}
        >
          <AdminSearchInput
            label={t("karaoke.library.searchLabel")}
            maxLength={120}
            onChange={setSearch}
            onClear={clearSearch}
            placeholder={t(
              "karaoke.library.searchPlaceholder",
              undefined,
              "Nhập tên bài hát hoặc tác giả…",
            )}
            value={search}
          />
          <AdminSelect
            containerClassName="w-full sm:w-48"
            label={t("karaoke.library.statusLabel")}
            onChange={(value) => setStatus(value as typeof status)}
            options={[
              { value: "", label: t("common.all") },
              ...KARAOKE_STATUS_KEYS.map((value) => ({
                value,
                label: t(`karaoke.library.statuses.${value}`),
              })),
            ]}
            value={status}
          />
        </AdminToolbar>
      </form>

      {error && (
        <StatusMessage tone="error">
          {error}
          <Button
            className="mt-3"
            disabled={busy}
            fullWidth={false}
            onClick={refresh}
            size="admin"
            variant="outline"
          >
            {t("karaoke.library.retryReload")}
          </Button>
        </StatusMessage>
      )}
      {loading ? (
        <AdminLoading label={t("karaoke.library.loading")} />
      ) : (
        !error &&
        data && (
          <>
            {!data.items.length ? (
              <EmptyState
                action={
                  <ButtonLink
                    fullWidth={false}
                    href="/admin/karaoke/new"
                    size="admin"
                  >
                    <Plus aria-hidden className="size-4" />
                    {t("karaoke.library.createSong")}
                  </ButtonLink>
                }
                description={t("karaoke.library.empty")}
                icon={<Music2 aria-hidden className="size-7 text-primary" />}
                title={t(
                  "karaoke.library.emptyTitle",
                  undefined,
                  "Chưa có bài hát nào",
                )}
              />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => {
                  const coverUrl = resolveCoverUrl(item);
                  const displayTitle =
                    item.title || t("karaoke.library.untitled");
                  const statusLabel = `${t(`karaoke.library.statuses.${item.status}`)}${
                    item.published_version_id && item.draft_version_id
                      ? t("karaoke.library.hasDraftEditSuffix")
                      : ""
                  }`;
                  const processingTone =
                    item.processing_summary?.status === "FAILED"
                      ? "danger"
                      : item.processing_summary?.status === "NEEDS_REVIEW"
                        ? "warning"
                        : item.processing_summary?.status === "READY" ||
                            item.processing_summary?.status === "APPLIED"
                          ? "success"
                          : "info";

                  return (
                    <Card className="gap-3.5 bg-white p-4" key={item.song_id}>
                      <div className="flex items-start gap-3">
                        {coverUrl ? (
                          // Signed/dynamic remote media URLs are rendered directly without Next image host proxying.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            alt={displayTitle}
                            className="size-14 shrink-0 rounded-xl border border-border object-cover"
                            src={coverUrl}
                          />
                        ) : (
                          <div
                            aria-hidden="true"
                            className="grid size-14 shrink-0 place-items-center rounded-xl border border-primary/20 bg-sky/70 text-primary-hover"
                          >
                            <Music2 className="size-6" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <AdminStatusBadge
                              label={statusLabel}
                              status={item.status}
                            />
                            {item.has_cover ? (
                              <AdminBadge tone="neutral">
                                {t(
                                  "karaoke.library.hasCoverBadge",
                                  undefined,
                                  "Có bìa",
                                )}
                              </AdminBadge>
                            ) : null}
                          </div>
                          <h2
                            className="line-clamp-2 break-words text-base font-extrabold leading-snug text-ink"
                            dir="auto"
                          >
                            {displayTitle}
                          </h2>
                        </div>
                      </div>

                      {item.processing_summary && (
                        <div>
                          <AdminBadge dot tone={processingTone}>
                            {t("karaoke.library.processingPrefix")}{" "}
                            {t(
                              `karaoke.processing.statusLabels.${item.processing_summary.status}`,
                            )}
                          </AdminBadge>
                        </div>
                      )}

                      <p className="break-words text-sm text-muted tabular-nums">
                        {t("karaoke.library.metaLine", {
                          author:
                            item.author || t("karaoke.library.unknownAuthor"),
                          minGrade: item.min_grade,
                          maxGrade: item.max_grade,
                          duration:
                            item.has_audio && item.duration_ms !== null
                              ? t("karaoke.library.durationValue", {
                                  time: formatKaraokeTime(item.duration_ms),
                                })
                              : t("karaoke.library.noAudio"),
                        })}
                      </p>

                      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                        <ButtonLink
                          fullWidth={false}
                          href={`/admin/karaoke/${item.song_id}/edit`}
                          size="admin"
                          variant="secondary"
                        >
                          {item.processing_summary &&
                          ["READY", "NEEDS_REVIEW"].includes(
                            item.processing_summary.status,
                          )
                            ? t("karaoke.library.viewResults")
                            : item.processing_summary &&
                                ["QUEUED", "RUNNING"].includes(
                                  item.processing_summary.status,
                                )
                              ? t("karaoke.library.continueCreating")
                              : item.processing_summary?.status === "FAILED"
                                ? t("karaoke.library.viewErrorRetry")
                                : t("karaoke.library.detailEdit")}
                        </ButtonLink>
                        {item.published_version_id && (
                          <Button
                            disabled={busy}
                            fullWidth={false}
                            onClick={() => setPendingVisibilityItem(item)}
                            size="admin"
                            variant="outline"
                          >
                            {item.status === "HIDDEN" ? (
                              <Eye aria-hidden className="size-4" />
                            ) : (
                              <EyeOff aria-hidden className="size-4" />
                            )}
                            {item.status === "HIDDEN"
                              ? t("karaoke.library.showSong")
                              : t("karaoke.library.hideSong")}
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
            <PaginationBar
              ariaLabel={t("karaoke.library.paginationAria")}
              compact
              disabled={busy}
              itemLabel={t("karaoke.library.itemLabel")}
              nextLabel={t("karaoke.library.nextLabel")}
              onPageChange={(nextPage) => {
                const limit = Math.max(1, data.limit || 12);
                setLoading(true);
                setQuery({
                  ...query,
                  offset: (nextPage - 1) * limit,
                });
              }}
              page={
                Math.floor(query.offset / Math.max(1, data.limit || 12)) + 1
              }
              pageSize={Math.max(1, data.limit || 12)}
              prevLabel={t("karaoke.library.prevLabel")}
              total={data.total}
            />
          </>
        )
      )}
      <Modal
        closeOnBackdropClick={!busy}
        closeOnEscape={!busy}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={busy}
              fullWidth={false}
              onClick={() => setPendingVisibilityItem(null)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              fullWidth={false}
              isLoading={busy}
              onClick={() => void confirmVisibility()}
              size="admin"
              type="button"
              variant={
                pendingVisibilityItem?.status === "HIDDEN"
                  ? "primary"
                  : "destructive"
              }
            >
              {pendingVisibilityItem?.status === "HIDDEN"
                ? t("karaoke.library.confirmShow")
                : t("karaoke.library.confirmHide")}
            </Button>
          </div>
        }
        isOpen={pendingVisibilityItem !== null}
        onClose={() => {
          if (!busy) setPendingVisibilityItem(null);
        }}
        role="alertdialog"
        showCloseButton={!busy}
        title={
          pendingVisibilityItem?.status === "HIDDEN"
            ? t("karaoke.library.modalShowTitle")
            : t("karaoke.library.modalHideTitle")
        }
        tone="paper"
      >
        <p className="text-sm leading-relaxed text-ink">
          {pendingVisibilityItem
            ? t("karaoke.library.modalVisibilityDesc", {
                action:
                  pendingVisibilityItem.status === "HIDDEN"
                    ? t("karaoke.library.showSong")
                    : t("karaoke.library.hideSong"),
                title: pendingVisibilityItem.title,
              })
            : ""}
        </p>
      </Modal>
    </div>
  );
}
