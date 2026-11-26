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
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import { processingStatusLabels } from "@/components/admin/karaoke/karaoke-processing-status";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";
import type { AdminKaraokeList } from "@/types/karaoke";

export const karaokeStatusLabels = {
  DRAFT: "Bản nháp",
  PUBLISHED: "Đang hiển thị",
  HIDDEN: "Đã ẩn",
};
export function KaraokeLibraryScreen() {
  const service = useAdminKaraoke();
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
        eyebrow="NỘI DUNG CHO BÉ"
        title="Bài hát"
        description="Quản lý nhạc nền, lời và thời gian hiển thị từng câu. Bản nháp không xuất hiện trong thư viện của trẻ."
        actions={<ButtonLink href="/admin/karaoke/new">Tạo bài hát</ButtonLink>}
      />
      <Card>
        <form
          onSubmit={filter}
          className="grid items-end gap-4 md:grid-cols-[2fr_1fr_auto]"
        >
          <label className="grid gap-2 font-bold">
            Tìm bài hát
            <input
              className={karaokeInputClass}
              value={search}
              maxLength={120}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="grid gap-2 font-bold">
            Trạng thái
            <select
              className={karaokeInputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="">Tất cả</option>
              {Object.entries(karaokeStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            Áp dụng
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
            Thử tải lại
          </Button>
        </StatusMessage>
      )}
      {loading ? (
        <AdminLoading label="Đang tải bài hát…" />
      ) : (
        !error &&
        data && (
          <>
            {!data.items.length ? (
              <Card>
                <p>
                  Chưa có bài hát phù hợp. Tạo bản nháp để tải nhạc và lời của
                  bạn lên.
                </p>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => (
                  <Card key={item.song_id}>
                    <p className="text-sm font-bold text-primary-hover">
                      {karaokeStatusLabels[item.status]}
                      {item.published_version_id && item.draft_version_id
                        ? " · Có bản đang sửa"
                        : ""}
                    </p>
                    <h2 className="break-words text-xl font-extrabold">
                      {item.title || "Bài hát chưa đặt tên"}
                    </h2>
                    {item.processing_summary && (
                      <p className="rounded-control bg-sky px-3 py-2 text-sm font-bold text-primary-hover">
                        Xử lý:{" "}
                        {processingStatusLabels[item.processing_summary.status]}
                      </p>
                    )}
                    <p className="break-words text-muted">
                      {item.author || "Chưa có tác giả"} · Lớp {item.min_grade}–
                      {item.max_grade}
                    </p>
                    <p>
                      {item.has_audio && item.duration_ms !== null
                        ? `Nhạc ${formatKaraokeTime(item.duration_ms)}`
                        : "Chưa có nhạc"}
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
                          ? "Xem kết quả"
                          : item.processing_summary &&
                              ["QUEUED", "RUNNING"].includes(
                                item.processing_summary.status,
                              )
                            ? "Tiếp tục tạo"
                            : item.processing_summary?.status === "FAILED"
                              ? "Xem lỗi / Thử lại"
                              : "Chi tiết / Chỉnh sửa"}
                      </ButtonLink>
                      {item.published_version_id && (
                        <Button
                          variant="quiet"
                          className="sm:w-auto"
                          disabled={busy}
                          onClick={() => setPendingVisibilityItem(item)}
                        >
                          {item.status === "HIDDEN" ? "Hiện lại" : "Ẩn bài hát"}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <PaginationBar
              ariaLabel="Phân trang bài hát"
              disabled={busy}
              itemLabel="bài"
              nextLabel="Trang sau"
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
              prevLabel="Trang trước"
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
              Hủy
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
                ? "Xác nhận hiện lại"
                : "Xác nhận ẩn bài hát"}
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
            ? "Hiện lại bài hát?"
            : "Ẩn bài hát?"
        }
        tone="paper"
      >
        <p className="text-body text-ink">
          {pendingVisibilityItem
            ? `${pendingVisibilityItem.status === "HIDDEN" ? "Hiện lại" : "Ẩn"} bài hát “${pendingVisibilityItem.title}” cho trẻ?`
            : ""}
        </p>
      </Modal>
    </div>
  );
}
