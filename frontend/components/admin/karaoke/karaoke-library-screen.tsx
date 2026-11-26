"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { karaokeInputClass } from "@/components/admin/karaoke/song-metadata-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
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
    <div className="grid gap-6">
      <AdminPageHeader
        eyebrow={t("karaoke.library.eyebrow")}
        title={t("karaoke.library.title")}
        description={t("karaoke.library.description")}
        actions={
          <ButtonLink href="/admin/karaoke/new">
            {t("karaoke.library.createSong")}
          </ButtonLink>
        }
      />
      <Card>
        <form
          onSubmit={filter}
          className="grid items-end gap-4 md:grid-cols-[2fr_1fr_auto]"
        >
          <label className="grid gap-2 font-bold">
            {t("karaoke.library.searchLabel")}
            <input
              className={karaokeInputClass}
              value={search}
              maxLength={120}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="grid gap-2 font-bold">
            {t("karaoke.library.statusLabel")}
            <select
              className={karaokeInputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="">{t("common.all")}</option>
              {KARAOKE_STATUS_KEYS.map((value) => (
                <option key={value} value={value}>
                  {t(`karaoke.library.statuses.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            {t("karaoke.library.apply")}
          </Button>
        </form>
      </Card>
      {error && (
        <StatusMessage tone="error">
          {error}
          <Button
            className="mt-3 sm:w-auto"
            variant="quiet"
            onClick={refresh}
            disabled={busy}
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
              <Card>
                <p>{t("karaoke.library.empty")}</p>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => (
                  <Card key={item.song_id}>
                    <p className="text-sm font-bold text-primary-hover">
                      {t(`karaoke.library.statuses.${item.status}`)}
                      {item.published_version_id && item.draft_version_id
                        ? t("karaoke.library.hasDraftEditSuffix")
                        : ""}
                    </p>
                    <h2
                      className="break-words text-xl font-extrabold"
                      dir="auto"
                    >
                      {item.title || t("karaoke.library.untitled")}
                    </h2>
                    {item.processing_summary && (
                      <p className="rounded-control bg-sky px-3 py-2 text-sm font-bold text-primary-hover">
                        {t("karaoke.library.processingPrefix")}{" "}
                        {t(
                          `karaoke.processing.statusLabels.${item.processing_summary.status}`,
                        )}
                      </p>
                    )}
                    <p className="break-words text-muted">
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
                    <div className="mt-auto flex flex-wrap gap-2">
                      <ButtonLink
                        href={`/admin/karaoke/${item.song_id}/edit`}
                        variant="secondary"
                        className="sm:w-auto"
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
                          variant="quiet"
                          className="sm:w-auto"
                          disabled={busy}
                          onClick={() => setPendingVisibilityItem(item)}
                        >
                          {item.status === "HIDDEN"
                            ? t("karaoke.library.showSong")
                            : t("karaoke.library.hideSong")}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <PaginationBar
              ariaLabel={t("karaoke.library.paginationAria")}
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
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={busy}
              fullWidth={false}
              onClick={() => setPendingVisibilityItem(null)}
              type="button"
              variant="secondary"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              fullWidth={false}
              isLoading={busy}
              onClick={() => void confirmVisibility()}
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
        <p className="text-body text-ink">
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
